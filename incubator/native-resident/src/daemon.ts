import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NativeDrivers, NativeToolBridge, ResidentApi } from './contracts.js'
import { ResidentError } from './contracts.js'
import { ResidentEngine } from './core/engine.js'
import { createNativeDrivers } from './drivers/index.js'
import { createRemoteToolBridge, type BridgeDescriptor } from './bridge.js'
import { socketPath } from './client.js'

export interface DaemonOptions {
  readonly root: string
  readonly fingerprint?: string
  readonly codexExecutable?: string
  readonly claudeExecutable?: string
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResidentError('INVALID_REQUEST', 'Expected a JSON request object.')
  return value as Record<string, unknown>
}
function textField(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new ResidentError('INVALID_REQUEST', 'Expected a nonempty string.')
  return value
}

async function clearDeadSocket(path: string): Promise<void> {
  let before
  try { before = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!before.isSocket() || before.uid !== process.getuid?.()) throw new ResidentError('SOCKET_OWNERSHIP', 'Resident socket path is not an owner-local socket.')
  const live = await new Promise<boolean>((resolveLive, reject) => {
    const probe = createConnection(path)
    probe.setTimeout(1000, () => { probe.destroy(); reject(new ResidentError('DAEMON_BUSY', 'An existing Resident socket did not answer.')) })
    probe.once('connect', () => { probe.destroy(); resolveLive(true) })
    probe.once('error', error => {
      if (['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) resolveLive(false)
      else reject(error)
    })
  })
  if (live) throw new ResidentError('DAEMON_ALREADY_RUNNING', 'A Resident daemon already owns this home.')
  try {
    const after = await lstat(path)
    if (after.ino !== before.ino) throw new ResidentError('DAEMON_BUSY', 'Resident ownership changed during startup.')
    await unlink(path)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

/** Public test seam injects keyless drivers; the installed entry always uses native drivers. */
export async function startResidentDaemon(options: DaemonOptions, injectedDrivers?: NativeDrivers): Promise<{ stop(): Promise<void>; engine: ResidentEngine }> {
  const root = resolve(options.root)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const path = socketPath(root)
  if (Buffer.byteLength(path) > 100) throw new ResidentError('SOCKET_PATH_TOO_LONG', 'Resident home is too long for a macOS Unix socket.')
  await clearDeadSocket(path)
  const bridges = new Map<string, NativeToolBridge>()
  const drivers = injectedDrivers ?? createNativeDrivers(options)
  const engine = new ResidentEngine(join(root, 'resident.sqlite'), drivers, { resolveBridge: id => bridges.get(id) })
  await engine.open()
  const sockets = new Set<Socket>()
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => stopping ??= (async () => {
    await engine.close()
    await Promise.all(Object.values(drivers).map(driver => driver?.close?.()))
    for (const socket of sockets) socket.end()
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
    try { await unlink(path) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  })()

  const dispatch = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (stopping && method !== 'ping') throw new ResidentError('DAEMON_STOPPING', 'Resident is stopping.')
    switch (method) {
      case 'ping': return { protocolVersion: 1, pid: process.pid, fingerprint: options.fingerprint ?? 'test' }
      case 'list': return engine.list()
      case 'inspect': return engine.inspect(textField(params.graphId))
      case 'submit': return engine.submit(params as unknown as Parameters<ResidentApi['submit']>[0])
      case 'control': return engine.control(params as unknown as Parameters<ResidentApi['control']>[0])
      case 'resolve': return engine.resolve(params as unknown as Parameters<ResidentApi['resolve']>[0])
      case 'events': return engine.events(textField(params.graphId), params.after as number | undefined, params.limit as number | undefined)
      case 'models': return Promise.all((['codex', 'claude-code'] as const).map(async executor => {
        const driver = drivers[executor]
        if (!driver?.models) return { executor, models: [], unavailableReason: 'Native model discovery is unavailable.' }
        try { return { executor, models: await driver.models(textField(params.cwd)) } }
        catch (error) { return { executor, models: [], unavailableReason: error instanceof Error ? error.message : String(error) } }
      }))
      case 'bindBridge': {
        const descriptor = record(params.descriptor) as unknown as BridgeDescriptor
        const id = textField(descriptor.id)
        await engine.registerBridgeCatalog(id, descriptor.tools)
        bridges.set(id, createRemoteToolBridge(descriptor, (request, action) => engine.executeToolCall(request.commandId, request.callId, request.name, request.arguments, action)))
        return { bound: true }
      }
      case 'shutdown':
        await engine.close()
        await Promise.all(Object.values(drivers).map(driver => driver?.close?.()))
        return { stopped: true }
      default: throw new ResidentError('UNKNOWN_METHOD', `Unknown Resident method: ${method}`)
    }
  }

  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(35_000, () => socket.destroy())
    let buffer = ''
    let handled = false
    socket.on('data', data => {
      if (handled) return
      buffer += data.toString('utf8')
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) { handled = true; socket.destroy(); return }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      handled = true
      void (async () => {
        let id: unknown = null
        let method = ''
        try {
          const request = record(JSON.parse(buffer.slice(0, newline)))
          id = textField(request.id)
          if (request.formatVersion !== 1) throw new ResidentError('PROTOCOL_MISMATCH', 'Unsupported Resident request format.')
          method = textField(request.method)
          const result = await dispatch(method, record(request.params))
          socket.end(JSON.stringify({ formatVersion: 1, id, result }) + '\n')
          if (method === 'shutdown') await stop()
        } catch (error) {
          const failure = error instanceof ResidentError ? error : new ResidentError('RESIDENT_FAILURE', error instanceof Error ? error.message : String(error))
          socket.end(JSON.stringify({ formatVersion: 1, id, error: { code: failure.code, message: failure.message } }) + '\n')
        }
      })()
    })
  })
  try {
    await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(path, () => { server.off('error', reject); resolveListen() }) })
    await chmod(path, 0o600)
  } catch (error) { await engine.close(); throw error }
  return { stop, engine }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootIndex = process.argv.indexOf('--root')
  const configIndex = process.argv.indexOf('--config')
  try {
    const root = textField(process.argv[rootIndex + 1])
    const config = configIndex < 0 ? {} : record(JSON.parse(process.argv[configIndex + 1]!))
    const daemon = await startResidentDaemon({ ...config, root } as DaemonOptions)
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void daemon.stop().catch(error => { console.error(error); process.exitCode = 1 }) })
  } catch (error) { console.error(error); process.exitCode = 1 }
}
