import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

const SERVICE_NAMES = ['solarRlm', 'solarRlmControl']
const TOOL_NAMES = ['solar_rlm_run', 'solar_rlm_inspect', 'solar_rlm_control']
const FIXTURE_PROVIDER = 'solar-rlm-fixture'
const FIXTURE_MODEL = 'fixture'

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`RLM probe requires ${name}`)
  return value
}

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function serialiseError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

async function writeMarker(path, marker) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
}

function findService(ctx) {
  for (const name of SERVICE_NAMES) {
    const value = ctx.get(name)
    if (value !== undefined && typeof value.status === 'function') return { name, value }
  }
  return undefined
}

function selfTestPlan(status) {
  if (process.env.SOLAR_RLM_NATIVE_CHECK !== '1') return { status: 'notrun', reason: 'SOLAR_RLM_NATIVE_CHECK 未设置为 1。' }
  if (process.platform !== 'darwin') return { status: 'notrun', reason: '原始 Prime keyless 自检仅在 Darwin 上运行。' }
  if (status.runtime?.available !== true) return { status: 'notrun', reason: 'Prime 运行时资产尚未就绪。' }
  return { status: 'ready' }
}

class FixtureAdapter extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
    this.resolutions = []
  }

  providerInfo(provider) {
    return { id: provider, name: 'Solar RLM local fixture' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: FIXTURE_MODEL, name: 'Solar RLM local fixture', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    if (provider !== FIXTURE_PROVIDER || model !== FIXTURE_MODEL) throw new Error(`fixture route mismatch: ${provider}/${model}`)
    const info = {
      provider,
      id: model,
      name: 'Solar RLM local fixture',
      inputModalities: ['text'],
      context: { contextWindow: 8192 },
      defaultMaxTokens: 512,
    }
    this.resolutions.push(info)
    return Promise.resolve(info)
  }

  async *stream(options) {
    if (options.provider !== FIXTURE_PROVIDER || options.model !== FIXTURE_MODEL) throw new Error('fixture adapter received an unexpected route')
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const ordinal = this.requests.length
    const text = ordinal === 1
      ? 'RLM_BRIDGE_FIRST_MARKER'
      : ordinal === 2
        ? 'RLM_BRIDGE_SECOND_MARKER'
        : 'RLM_BRIDGE_RESUME_MARKER'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function llmService(ctx) {
  const value = ctx.llm ?? ctx.get('llm')
  if (value === undefined || typeof value.registerAdapter !== 'function') throw new Error('llm service with registerAdapter() is unavailable')
  return value
}

function hostOf(service) {
  const host = service?.host ?? service
  if (host === undefined || typeof host.start !== 'function' || typeof host.continue !== 'function' || typeof host.inspect !== 'function' || typeof host.cancel !== 'function') {
    throw new Error('Prime RLM host start/continue/inspect/cancel methods are unavailable')
  }
  return host
}

async function waitForIdle(host, runId, ownerSessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await host.inspect(runId, ownerSessionId)
    if (latest.state === 'idle') return latest
    if (['failed', 'indeterminate'].includes(latest.state)) throw new Error(`fixture RLM run did not become idle: ${latest.state} ${latest.message}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`fixture RLM run did not become idle before timeout: ${JSON.stringify(latest)}`)
}

async function journalFor(host, runId) {
  const path = join(host.store.directory(runId), 'journal.jsonl')
  const raw = await readFile(path, 'utf8')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function runBridgeAcceptance(ctx, service, status) {
  const plan = selfTestPlan(status)
  if (plan.status !== 'ready') return { status: 'notrun', reason: plan.reason }
  const host = hostOf(service)
  const llm = llmService(ctx)
  const adapter = new FixtureAdapter()
  const registration = llm.registerAdapter([FIXTURE_PROVIDER], adapter)
  const owner = {
    sessionId: `rlm-probe-owner-${process.pid}`,
    route: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, maxTokens: 512 },
  }
  const input = {
    task: 'Reply with the fixture marker. Do not call tools.',
    cwd: requiredEnv('SOLAR_RLM_PROBE_WORKSPACE'),
    label: 'RLM local bridge fixture',
    maxModelRequests: 6,
    maxWallTimeMs: 120_000,
  }
  let runId
  try {
    const firstReceipt = await host.start(input, owner)
    runId = firstReceipt.runId
    const first = await waitForIdle(host, runId, owner.sessionId)
    assert(first.modelRequests === 1, `first bridge turn modelRequests=${String(first.modelRequests)}`)
    assert(first.result?.includes('RLM_BRIDGE_FIRST_MARKER'), 'first bridge marker was not persisted')

    const secondReceipt = await host.continue(runId, 'Continue once and return the second fixture marker.', owner)
    assert(secondReceipt.runId === runId, 'continue returned a different run id')
    const second = await waitForIdle(host, runId, owner.sessionId)
    assert(second.modelRequests === 2, `second bridge turn modelRequests=${String(second.modelRequests)}`)
    assert(second.result?.includes('RLM_BRIDGE_SECOND_MARKER'), 'second bridge marker was not persisted')

    const cancelled = await host.cancel(runId, owner.sessionId)
    assert(cancelled.state === 'cancelled', `bridge cancel returned ${String(cancelled.state)}`)

    const resumedReceipt = await host.continue(runId, 'Resume explicitly and return the resume fixture marker.', owner)
    assert(resumedReceipt.runId === runId, 'resume returned a different run id')
    const resumed = await waitForIdle(host, runId, owner.sessionId)
    assert(resumed.modelRequests === 3, `resume bridge turn modelRequests=${String(resumed.modelRequests)}`)
    assert(resumed.result?.includes('RLM_BRIDGE_RESUME_MARKER'), 'resume bridge marker was not persisted')
    const finalCancelled = await host.cancel(runId, owner.sessionId)
    assert(finalCancelled.state === 'cancelled', `final bridge cancel returned ${String(finalCancelled.state)}`)

    const rows = await journalFor(host, runId)
    const dispatches = rows
      .map(row => row.value)
      .filter(value => value?.type === 'model-dispatch')
    const intents = rows
      .map(row => row.value)
      .filter(value => value?.type === 'model-intent')
    assert(dispatches.length === 3, `journal model-dispatch count=${String(dispatches.length)}`)
    assert(intents.length === 3, `journal model-intent count=${String(intents.length)}`)
    assert(dispatches.every(value => value.config?.provider === FIXTURE_PROVIDER && value.config?.model === FIXTURE_MODEL && value.config?.reasoningEffort === undefined && value.config?.maxTokens === 512), 'journal route or call controls do not match the fixture route')
    assert(intents.every(value => value.dshRequest?.provider === FIXTURE_PROVIDER && value.dshRequest?.model === FIXTURE_MODEL), 'journal intent route does not match fixture provider/model')
    assert(adapter.requests.length === 3, `fixture adapter request count=${String(adapter.requests.length)}`)
    assert(adapter.requests.every(request => request.provider === FIXTURE_PROVIDER && request.model === FIXTURE_MODEL && request.reasoningEffort === undefined && request.maxTokens === 512), 'fixture adapter saw an unexpected route or call controls')
    assert(adapter.resolutions.length > 0 && adapter.resolutions.every(model => model.context?.contextWindow === 8192 && model.defaultMaxTokens === 512 && model.reasoning === undefined), 'fixture model metadata did not preserve context/output bounds or reasoning=false')
    return {
      status: 'passed',
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      contextWindow: 8192,
      maxTokens: 512,
      reasoning: false,
      modelRequests: adapter.requests.length,
      paidProviderCalls: 0,
      firstState: first.state,
      secondState: second.state,
      resumedState: resumed.state,
      journalDispatches: dispatches.length,
      journalIntents: intents.length,
      resumedFromCancelled: true,
    }
  } finally {
    let cleanupError
    if (runId !== undefined) {
      try {
        await host.cancel(runId, owner.sessionId)
      } catch (error) {
        cleanupError = error
      }
    }
    registration()
    if (cleanupError !== undefined) throw new Error(`fixture bridge cleanup could not confirm stop: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
  }
}

async function runProbe(ctx) {
  const markerPath = requiredEnv('SOLAR_RLM_PROBE_MARKER')
  const checks = {
    service: false,
    runtime: false,
    tools: [],
    selftest: 'notrun',
    bridge: 'notrun',
  }
  let serviceName
  let status
  let selftest
  let error
  let productStatus = process.platform === 'darwin' ? 'darwin-unavailable' : 'nonproduct'
  try {
    const tools = ctx.get('tools')
    assert(tools !== undefined && typeof tools.schemas === 'function', 'tools service is unavailable')
    const schemas = tools.schemas()
    const names = new Set(schemas.map((schema) => schema.name))
    for (const toolName of TOOL_NAMES) {
      assert(names.has(toolName), `expected tool ${toolName} is not registered`)
      checks.tools.push(toolName)
    }

    const found = findService(ctx)
    assert(found !== undefined, 'Prime RLM service is unavailable')
    serviceName = found.name
    const service = found.value
    for (const method of ['status', 'check', 'inspect', 'cancel']) {
      assert(typeof service[method] === 'function', `Prime RLM service method ${method} is unavailable`)
    }
    checks.service = true

    status = await service.status()
    checks.runtime = object(status).runtime?.available === true
    productStatus = process.platform === 'darwin'
      ? checks.runtime ? 'darwin-ready' : 'darwin-unavailable'
      : 'nonproduct'
    if (process.env.SOLAR_RLM_NATIVE_CHECK === '1' && process.platform === 'darwin' && !checks.runtime) {
      throw new Error(`Prime RLM runtime assets are required for Darwin native acceptance: ${String(object(status).runtime?.message ?? 'no message')}`)
    }

    const plan = selfTestPlan(status)
    if (plan.status === 'ready') {
      const report = await service.check({ commandId: randomUUID() })
      assert(object(report).formatVersion === 1, 'Prime keyless self-test formatVersion must be 1')
      assert(object(report).kind === 'local-keyless', 'Prime keyless self-test kind is unexpected')
      assert(report.modelRequests === 0, `Prime keyless self-test requested ${String(report.modelRequests)} model calls`)
      assert(report.status === 'passed', `Prime keyless self-test returned ${String(report.status)}`)
      selftest = { status: 'passed', modelRequests: report.modelRequests, resultDirectory: report.resultDirectory }
      selftest.bridge = await runBridgeAcceptance(ctx, service, status)
      checks.bridge = selftest.bridge.status
      assert(selftest.bridge.status === 'passed', `RLM bridge acceptance returned ${String(selftest.bridge.status)}`)
      checks.selftest = 'passed'
    } else {
      selftest = { ...plan, bridge: plan }
    }
  } catch (caught) {
    error = serialiseError(caught)
  }

  const marker = {
    formatVersion: 1,
    pid: process.pid,
    ok: error === undefined,
    serviceName,
    productStatus,
    runtimeAvailable: checks.runtime,
    checks,
    runtime: status?.runtime,
    ...(selftest === undefined ? {} : { selftest }),
    ...(error === undefined ? {} : { error }),
    exitRequested: false,
  }
  const exit = ctx.get('appExit')
  assert(typeof exit === 'function', 'appExit service is unavailable after probe checks')
  const exitCode = error === undefined ? 0 : 1
  marker.exitRequested = true
  marker.exitCode = exitCode
  await writeMarker(markerPath, marker)
  exit(exitCode)
}

export const name = 'solar-rlm-probe'
export const inject = ['appReady', 'llm']

export function apply(ctx) {
  const ready = ctx.get('appReady')
  if (ready === undefined || typeof ready.onReady !== 'function') throw new Error('appReady service is unavailable')
  let started = false
  const cancel = ready.onReady(() => {
    if (started) return
    started = true
    void runProbe(ctx).catch(async (error) => {
      try {
        const markerPath = requiredEnv('SOLAR_RLM_PROBE_MARKER')
        await writeMarker(markerPath, {
          formatVersion: 1,
          pid: process.pid,
          ok: false,
          checks: {},
          error: serialiseError(error),
          exitRequested: true,
          exitCode: 1,
        })
      } finally {
        const exit = ctx.get('appExit')
        if (typeof exit === 'function') exit(1)
      }
    })
  })
  return () => cancel()
}
