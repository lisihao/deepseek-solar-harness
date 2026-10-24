// Scratch-profile plugin test for @lisihao/dsh-solar-local-ai.
//
// The published `dsh` CLI installs the built package and a probe into a
// throwaway DSH_HOME and boots it under plain Node. The probe reaches a fake
// OpenAI-compatible server only through the plugin's Tailscale gateway and a
// SOCKS5 stub standing in for a userspace tailscaled. No real model is called.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer, connect } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')
const PACKAGE = join(ROOT, 'incubator', 'local-ai')
const PROBE = join(ROOT, 'tools', 'fixtures', 'local-ai-probe')
const PROFILE = 'solar-local-ai-plugin-test'
const TEMP_ROOT = process.platform === 'darwin' ? '/private/tmp' : (await import('node:os')).tmpdir()

function run(command, args, env, timeoutMs) {
  return new Promise(resolvePromise => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-64 * 1024) })
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-64 * 1024) })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('close', (status, signal) => { clearTimeout(timer); resolvePromise({ status, signal, output }) })
  })
}

function listen(server) {
  return new Promise(resolvePromise => server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port)))
}

async function freePort() {
  const server = createTcpServer()
  const port = await listen(server)
  await new Promise(resolvePromise => server.close(resolvePromise))
  return port
}

function sse(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

const upstreamSeen = []
const upstream = createHttpServer((incoming, response) => {
  upstreamSeen.push({ method: incoming.method, path: incoming.url, host: incoming.headers.host, authorization: incoming.headers.authorization })
  if (incoming.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen-local', object: 'model' }] }))
    return
  }
  incoming.resume()
  incoming.on('end', () => {
    const base = { id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 0, model: 'qwen-local' }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(response, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'po' }, finish_reason: null }] })
    sse(response, { ...base, choices: [{ index: 0, delta: { content: 'ng' }, finish_reason: null }] })
    sse(response, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })
    response.end('data: [DONE]\n\n')
  })
})

// SOCKS5 stand-in for a userspace tailscaled: records each CONNECT target and
// connects to the fake upstream instead.
const socksRequested = []
let upstreamPort
const socks = createTcpServer(client => {
  let buffer = Buffer.alloc(0)
  let stage = 'greeting'
  const onData = chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (stage === 'greeting') {
      if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return
      buffer = buffer.subarray(2 + buffer[1])
      client.write(Buffer.from([5, 0]))
      stage = 'request'
    }
    if (stage !== 'request' || buffer.length < 5) return
    const atyp = buffer[3]
    const length = atyp === 1 ? 4 : atyp === 4 ? 16 : 1 + buffer[4]
    if (buffer.length < 6 + length) return
    const address = buffer.subarray(4, 4 + length)
    const host = atyp === 1 ? [...address].join('.') : atyp === 3 ? address.subarray(1).toString() : address.toString('hex')
    socksRequested.push(`${host}:${buffer.readUInt16BE(4 + length)}`)
    const rest = buffer.subarray(6 + length)
    stage = 'piping'
    client.off('data', onData)
    const target = connect(upstreamPort, '127.0.0.1', () => {
      client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
      if (rest.length > 0) target.write(rest)
      client.pipe(target).pipe(client)
    })
    target.on('error', () => client.destroy())
    client.on('error', () => target.destroy())
  }
  client.on('data', onData)
})

async function main() {
  for (const file of ['lib/index.js', 'lib/client.cjs']) await stat(join(PACKAGE, file))
  upstreamPort = await listen(upstream)
  const socksPort = await listen(socks)
  const [portA, portB] = [await freePort(), await freePort()]
  const defaultPortFree = await new Promise(resolvePromise => {
    const probe = createTcpServer()
    probe.once('error', () => resolvePromise(false))
    probe.listen(18765, '127.0.0.1', () => probe.close(() => resolvePromise(true)))
  })
  const scratch = await mkdtemp(join(TEMP_ROOT, 'dsh-v4-local-ai-plugin-test-'))
  const marker = join(scratch, 'probe', 'marker.json')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('DSH_') || /PROXY|API_KEY|TOKEN|SECRET/i.test(key)) delete env[key]
  Object.assign(env, {
    HOME: join(scratch, 'home'),
    DSH_HOME: scratch,
    DSH_TELEMETRY_DISABLED: '1',
    SOLAR_PLUGIN_PROBE_MARKER: marker,
    LOCAL_AI_PROBE_PORT_A: String(portA),
    LOCAL_AI_PROBE_PORT_B: String(portB),
    LOCAL_AI_PROBE_SOCKS_PORT: String(socksPort),
    LOCAL_AI_PROBE_DEFAULT_PORT_FREE: defaultPortFree ? '1' : '0',
    // What the page stores when the user leaves the key empty.
    LOCAL_AI_API_KEY: 'local-ai-no-key',
  })
  let failure
  try {
    for (const packageDir of [PACKAGE, PROBE]) {
      const added = await run(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', packageDir], env, 120_000)
      if (added.status !== 0) throw new Error(`dsh plugin add ${packageDir} failed:\n${added.output}`)
    }
    const boot = await run(DSH_BIN, ['--profile', PROFILE], env, 90_000)
    const result = JSON.parse(await readFile(marker, 'utf8').catch(() => `{"error":{"message":"no probe marker; boot status ${boot.status} ${boot.signal}\\n${boot.output.replaceAll('"', "'").replaceAll('\n', '\\n')}"}}`))
    if (result.error !== undefined) throw new Error(`probe failed: ${result.error.message}\n${result.error.stack ?? ''}`)
    const expected = ['selfNamespace', 'gatewayIdleByDefault', 'gatewayStarts', 'discovery', 'stream', 'gatewayMoves', 'gatewayStops']
    for (const check of expected) if (result.checks?.[check] !== true) throw new Error(`probe check ${check} failed: ${JSON.stringify(result.checks)}`)
    if (!socksRequested.every(target => target === '100.114.161.62:8000') || socksRequested.length < 2) throw new Error(`unexpected SOCKS targets ${JSON.stringify(socksRequested)}`)
    const chat = upstreamSeen.find(entry => entry.path === '/v1/chat/completions')
    if (chat?.authorization !== 'Bearer local-ai-no-key' || chat.host !== '100.114.161.62:8000') throw new Error(`unexpected upstream request ${JSON.stringify(upstreamSeen)}`)
    process.stdout.write(`${JSON.stringify({ profile: PROFILE, defaultPortFree, checks: result.checks, socksRequested, upstreamSeen }, null, 2)}\n`)
  } catch (error) {
    failure = error
  } finally {
    upstream.closeAllConnections()
    upstream.close()
    socks.close()
    if (failure === undefined) await rm(scratch, { recursive: true, force: true })
  }
  if (failure !== undefined) throw new Error(`${failure.message}\nscratch preserved at ${scratch}`)
}

main().catch(error => {
  process.stderr.write(`local-ai-plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
  setTimeout(() => process.exit(1), 100)
})
