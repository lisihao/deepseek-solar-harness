/** Release-shaped smoke for the headless DSH Product Server. */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopProductServerDaemons } from './product-server-processes.mjs'

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

async function remoteSyncCall(baseUrl, method, payload = {}) {
  const rpcId = `product-server-${method}`
  const response = await fetch(`${baseUrl}/remote-sync/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!response.ok) throw new Error(`remote sync ${method} returned HTTP ${String(response.status)}`)
  const envelope = await response.json()
  if (envelope.rpcId !== rpcId || envelope.result?.ok !== true) {
    throw new Error(`remote sync ${method} returned an invalid RPC response`)
  }
  return envelope.result.value
}

async function waitForRemoteSync(baseUrl, child, output) {
  const deadline = Date.now() + 30_000
  let lastStatus = 'unreachable'
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`product server exited ${String(child.exitCode)} before Remote Sync readiness\n${output()}`)
    }
    try {
      const response = await fetch(`${baseUrl}/remote-sync/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'product-server-describe',
          method: 'describe',
          payload: { protocol: { major: 1, minor: 4 } },
        }),
      })
      lastStatus = String(response.status)
      if (response.ok) {
        const envelope = await response.json()
        if (envelope.rpcId !== 'product-server-describe' || envelope.result?.ok !== true) {
          throw new Error('remote sync describe returned an invalid RPC response')
        }
        return envelope.result.value
      }
      if (![404, 405, 503].includes(response.status)) {
        const body = await response.text()
        if (response.status === 500 && body.includes('orchestration daemon did not become ready')) {
          lastStatus = `${String(response.status)} ${body}`
        } else {
          throw new Error(
            `remote sync describe returned HTTP ${String(response.status)}: ${body}\n${output()}`,
          )
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('invalid RPC response')) throw error
      if (error instanceof Error && error.message.startsWith('remote sync describe returned HTTP')) throw error
      lastStatus = error instanceof Error ? error.message : String(error)
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`product server Remote Sync did not become ready within 30s (last=${lastStatus})\n${output()}`)
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

const homeContainer = mkdtempSync('/tmp/dsh-product-verify-')
const home = join(homeContainer, 'Library', 'Application Support', 'DSH Product Server Canary', 'state', 'dsh-home')
mkdirSync(home, { recursive: true, mode: 0o700 })
for (const daemonRoot of ['resident-operators', 'orchestrations']) {
  const directSocket = join(home, daemonRoot, 'control.sock')
  if (Buffer.byteLength(directSocket) <= 103) {
    throw new Error(`product server smoke root does not exercise long Unix socket paths: ${directSocket}`)
  }
}
const port = await availablePort()
const projectRoot = fileURLToPath(new URL('../../../..', import.meta.url))
const repository = execFileSync('git', ['remote', 'get-url', 'origin'], {
  cwd: projectRoot,
  encoding: 'utf8',
}).trim()
mkdirSync(join(home, 'orchestrations'), { recursive: true, mode: 0o700 })
writeFileSync(join(home, 'orchestrations', 'cluster.json'), `${JSON.stringify({
  version: 1,
  nodeId: 'product-server-smoke',
  leaseMs: 5_000,
  members: [{
    id: 'product-server-smoke',
    label: 'Product Server smoke',
    endpoint: `http://127.0.0.1:${String(port)}/`,
    remoteExecution: {
      enabled: true,
      repositories: [{ repository, source: projectRoot }],
    },
  }],
}, null, 2)}\n`, { mode: 0o600 })
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
  // WebServer becomes reachable before optional resident/orchestration
  // authorities finish their daemon handshakes. Wait for the actual Remote
  // Sync route, otherwise this smoke would race the intended composition seam
  // and observe the SPA fallback's 405.
  const description = await waitForRemoteSync(baseUrl, child, () => `${stdout}\n${stderr}`)
  for (const capability of ['operator.read', 'operator.execute', 'operator.interrupt']) {
    if (!description.capabilities?.includes(capability)) {
      throw new Error(`product server Remote Sync is missing ${capability}: ${JSON.stringify(description)}\n${stdout}\n${stderr}`)
    }
  }
  if (!description.capabilities?.includes('orchestration.cluster')) {
    throw new Error('product server did not advertise its configured standalone cluster')
  }
  const providers = await remoteSyncCall(baseUrl, 'operator.providers')
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('product server Remote Sync returned no resident providers')
  }
  evidence = {
    status: 'ok',
    http: 200,
    clients: entries.length,
    requiredClients: REQUIRED_CLIENT_IDS.length,
    browsePicker: true,
    nativePicker: false,
    remoteResident: true,
    residentProviders: providers.length,
    standaloneCluster: true,
    rev: boot.rev,
  }
} finally {
  try {
    await stop(child)
  } finally {
    try {
      await stopProductServerDaemons(home)
    } finally {
      rmSync(homeContainer, { recursive: true, force: true })
    }
  }
}
process.stdout.write(`${JSON.stringify(evidence)}\n`)
