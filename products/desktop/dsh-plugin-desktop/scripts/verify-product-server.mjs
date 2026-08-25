/** Release-shaped smoke for the headless DSH Product Server. */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REQUIRED_CLIENT_IDS = [
  '@deepseek-ai/dsh-client-ui-remote-modules',
  '@deepseek-ai/dsh-ui-physical-operator',
  '@deepseek-ai/dsh-ui-orchestration',
  '@nanmicoder/dsh-agent-teams',
  '@linxin666/dsh-remote-web-ui',
  'dsh-web-billing',
  '@lisihao/dsh-code-harness-governance',
  '@omdsh-dev/dsh-genui',
  'dsh-mnemon',
  'dsh-better-sidebar',
  '@deepseek-ai/dsh-client-ui-directory-picker-browse',
]

async function availablePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('failed to allocate an IPv4 test port')
  await new Promise((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)) })
  return address.port
}

async function waitForProduct(url, child, output) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`product server exited ${String(child.exitCode)} before readiness\n${output()}`)
    }
    try {
      const response = await fetch(url)
      if (response.ok) return response.text()
    } catch {
      // Startup is not ready yet; the bounded loop reports process output on timeout.
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`product server did not become ready within 30s\n${output()}`)
}

function parseBootManifest(html) {
  const match = html.match(/window\.__DSH_BOOT__ = (\{.*?\})<\/script>/s)
  if (match === null) throw new Error('product server page has no window.__DSH_BOOT__ manifest')
  return JSON.parse(match[1])
}

async function stop(child) {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 7_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  if (exited) return
  child.kill('SIGKILL')
  await new Promise(resolve => child.once('exit', resolve))
  throw new Error('product server did not stop within its bounded shutdown window')
}

const home = mkdtempSync(join(tmpdir(), 'dsh-product-server-verify-'))
const port = await availablePort()
let stdout = ''
let stderr = ''
const child = spawn(process.execPath, ['lib/product-server-bin.js', '--host', '127.0.0.1', '--port', String(port)], {
  cwd: new URL('../', import.meta.url),
  env: { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', chunk => { stdout += chunk })
child.stderr.on('data', chunk => { stderr += chunk })

let evidence
try {
  const baseUrl = `http://127.0.0.1:${String(port)}`
  const html = await waitForProduct(`${baseUrl}/`, child, () => `${stdout}\n${stderr}`)
  const boot = parseBootManifest(html)
  const entries = Array.isArray(boot.entries) ? boot.entries : []
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const missing = REQUIRED_CLIENT_IDS.filter(id => !byId.has(id))
  if (missing.length > 0) throw new Error(`product server is missing required clients: ${missing.join(', ')}`)
  if (byId.has('@deepseek-ai/dsh-client-ui-directory-picker-native')) {
    throw new Error('product server leaked the local native directory picker into the remote browser')
  }
  for (const entry of entries) {
    if (typeof entry.url !== 'string') throw new Error(`client ${String(entry.id)} has no URL`)
    const response = await fetch(new URL(entry.url, baseUrl))
    if (!response.ok) throw new Error(`client ${String(entry.id)} returned HTTP ${String(response.status)}`)
  }
  evidence = {
    status: 'ok',
    http: 200,
    clients: entries.length,
    requiredClients: REQUIRED_CLIENT_IDS.length,
    browsePicker: true,
    nativePicker: false,
    rev: boot.rev,
  }
} finally {
  try {
    await stop(child)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
process.stdout.write(`${JSON.stringify(evidence)}\n`)
