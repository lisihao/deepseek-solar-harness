import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    if (cause?.code === 'ESRCH') return false
    throw cause
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!await processExists(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return !await processExists(pid)
}

async function readPid(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if (cause?.code === 'ENOENT') return undefined
    throw cause
  }
  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid daemon pid file ${path}`)
  return pid
}

function requestOwnerShutdown(socketPath, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const socket = net.createConnection(socketPath)
    const timeout = setTimeout(() => socket.destroy(new Error(`owner IPC timeout for ${socketPath}`)), timeoutMs)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'desktop-installer-shutdown', method: 'system.shutdown', params: {} })}\n`))
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const response = JSON.parse(buffer.slice(0, newline))
      if (response.error !== undefined) socket.destroy(new Error(response.error.message ?? 'owner IPC shutdown failed'))
      else { clearTimeout(timeout); socket.end(); resolvePromise() }
    })
    socket.once('error', cause => { clearTimeout(timeout); reject(cause) })
  })
}

async function processCommand(pid) {
  const { stdout } = await execFileAsync('/bin/ps', ['-p', String(pid), '-o', 'command='])
  return stdout.trim()
}

export function assertOwnedDaemonCommand(command, root, executable = process.execPath) {
  const words = command.split(/\s+/u)
  const rootIndex = words.indexOf('--root')
  if (rootIndex < 0 || resolve(words[rootIndex + 1] ?? '') !== resolve(root)) {
    throw new Error(`refusing to signal daemon: command does not own root ${resolve(root)}`)
  }
  if (resolve(words[0] ?? '') !== resolve(executable)) {
    throw new Error(`refusing to signal daemon: executable does not match ${resolve(executable)}`)
  }
}

/** Drain through the owner socket; signal only after proving executable and root identity. */
export async function stopOwnedDaemon(root, timeoutMs = 7_000, dependencies = {}) {
  const pid = await readPid(join(root, 'daemon.pid'))
  if (pid === undefined || !await processExists(pid)) return
  try {
    await (dependencies.requestShutdown ?? requestOwnerShutdown)(join(root, 'control.sock'), Math.min(timeoutMs, 2_000))
    if (await waitForExit(pid, timeoutMs)) return
  } catch {
    // A crashed IPC owner may require the fenced process fallback below.
  }
  const command = await (dependencies.inspectProcess ?? processCommand)(pid)
  assertOwnedDaemonCommand(command, root, dependencies.executable ?? process.execPath)
  const signal = dependencies.signalProcess ?? process.kill
  signal(pid, 'SIGTERM')
  if (await waitForExit(pid, timeoutMs)) return
  signal(pid, 'SIGKILL')
  if (!await waitForExit(pid, timeoutMs)) {
    throw new Error(`daemon ${String(pid)} below ${root} did not stop`)
  }
}

/** Quiesce every durable daemon started by the Product Server smoke home. */
export async function stopProductServerDaemons(dshHome) {
  await stopOwnedDaemon(join(dshHome, 'orchestrations'))
  await stopOwnedDaemon(join(dshHome, 'resident-operators'))
}
