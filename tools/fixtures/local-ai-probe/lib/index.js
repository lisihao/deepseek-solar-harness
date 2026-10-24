import { mkdir, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname } from 'node:path'

// Drives the installed local-ai bundle through the same Host services the
// Settings page reaches over Remote: settings.describe/mutate, model
// discovery, and one streamed model call through the Tailscale gateway.

export const name = 'local-ai-probe'
export const inject = ['llm', 'settings']

const PROVIDER = 'local-ai'
const ENTRY = 'solar-local-ai'
const TARGET = '100.114.161.62:8000'

function env(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`local-ai probe requires ${name}`)
  return value
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function until(label, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function view(ctx, ns) {
  return ctx.settings.describe().find(entry => entry.ns === ns)
}

async function runProbe(ctx) {
  const portA = Number(env('LOCAL_AI_PROBE_PORT_A'))
  const portB = Number(env('LOCAL_AI_PROBE_PORT_B'))
  const proxy = `socks5://127.0.0.1:${env('LOCAL_AI_PROBE_SOCKS_PORT')}`
  const checks = {}

  await until('settings namespaces', () => view(ctx, ENTRY) !== undefined && view(ctx, 'llm-pi-ai') !== undefined)
  const self = view(ctx, ENTRY)
  checks.selfNamespace = JSON.stringify(self.value?.tailscale) === JSON.stringify({ enabled: false, port: 18765, proxy: 'socks5://127.0.0.1:1055' })
  checks.gatewayIdleByDefault = !(await portOpen(18765)) || 'port 18765 is used by something else'

  await ctx.settings.mutate(ENTRY, [{ op: 'set', path: ['tailscale'], value: { enabled: true, port: portA, proxy } }], self.revision)
  await until(`gateway on ${portA}`, () => portOpen(portA))
  checks.gatewayStarts = true

  const baseURL = `http://127.0.0.1:${portA}/tailnet/${TARGET}/v1`
  const discovered = await ctx.llm.discoverModels('llm-pi-ai', { baseURL, api: 'openai-completions' })
  checks.discovery = discovered.map(model => model.id).join(',') === 'qwen-local'

  const piAi = view(ctx, 'llm-pi-ai')
  await ctx.settings.mutate('llm-pi-ai', [{
    op: 'set',
    path: ['providers', PROVIDER],
    value: { displayName: '本地 AI', api: 'openai-completions', baseURL, apiKeyEnv: 'LOCAL_AI_API_KEY', models: [{ id: 'qwen-local' }] },
  }], piAi.revision)
  await until('local-ai route', () => ctx.llm.listProviders().some(provider => provider.id === PROVIDER))
  let text = ''
  let finish
  for await (const chunk of ctx.llm.stream({
    provider: PROVIDER,
    model: 'qwen-local',
    maxTokens: 32,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.delta ?? chunk.text ?? ''
    if (chunk.type === 'finish') finish = chunk
  }
  checks.stream = text === 'pong' && finish?.reason?.kind === 'stop' ? true : `text=${JSON.stringify(text)} finish=${JSON.stringify(finish)}`

  await ctx.settings.mutate(ENTRY, [{ op: 'set', path: ['tailscale', 'port'], value: portB }], view(ctx, ENTRY).revision)
  await until(`gateway moved to ${portB}`, async () => (await portOpen(portB)) && !(await portOpen(portA)))
  checks.gatewayMoves = true

  await ctx.settings.mutate(ENTRY, [{ op: 'set', path: ['tailscale', 'enabled'], value: false }], view(ctx, ENTRY).revision)
  await until('gateway stopped', async () => !(await portOpen(portB)))
  checks.gatewayStops = true
  return checks
}

export function apply(ctx) {
  const marker = env('SOLAR_PLUGIN_PROBE_MARKER')
  ctx.effect(() => {
    void runProbe(ctx)
      .then(checks => ({ checks }), error => ({ error: { message: error?.message ?? String(error), stack: error?.stack } }))
      .then(async result => {
        await mkdir(dirname(marker), { recursive: true })
        await writeFile(marker, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
      })
      .finally(() => setTimeout(() => process.exit(0), 50))
    return () => undefined
  }, 'local-ai probe')
}
