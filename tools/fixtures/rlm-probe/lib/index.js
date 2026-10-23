import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'

const SERVICE_NAMES = ['solarRlm', 'solarRlmControl']
const TOOL_NAMES = ['solar_rlm', 'solar_rlm_run', 'solar_rlm_inspect', 'solar_rlm_control']
const FIXTURE_PROVIDER = 'solar-rlm-fixture'
const FIXTURE_MODEL = 'fixture'
const AUTONOMOUS_FIXTURE_PROVIDER = 'solar-rlm-autonomous-fixture'
const AUTONOMOUS_FIXTURE_MODEL = 'fixture-autonomous'
const AUTONOMOUS_FAILURE_FIXTURE_PROVIDER = 'solar-rlm-autonomous-failure-fixture'
const AUTONOMOUS_FAILURE_FIXTURE_MODEL = 'fixture-autonomous-failure'
const PRIME_META = 'ai.primeintellect.prime-agent'

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
    this.parentRequests = []
    this.auxiliaryRequests = []
    this.parentSessionId = undefined
    this.operatorInput = undefined
    this.operatorResult = undefined
  }

  configureOperator(sessionId, input) {
    this.parentSessionId = sessionId
    this.operatorInput = input
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
    if (options.sessionId === this.parentSessionId && options.purpose !== undefined) {
      this.auxiliaryRequests.push(options)
      const text = 'RLM operator local fixture'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (options.sessionId === this.parentSessionId) {
      this.parentRequests.push(options)
      const ordinal = this.parentRequests.length
      if (ordinal === 1) {
        const schema = options.tools?.find(tool => tool.name === 'solar_rlm')
        assert(schema !== undefined, 'actual parent Agent did not receive the solar_rlm model schema')
        const required = schema.parameters?.required
        const properties = schema.parameters?.properties
        assert(Array.isArray(required) && ['task', 'cwd', 'maxModelRequests', 'maxWallTimeMs'].every(name => required.includes(name)) && properties?.task?.type === 'string' && properties?.cwd?.type === 'string' && properties?.maxModelRequests?.type === 'integer' && properties?.maxWallTimeMs?.type === 'integer', 'actual parent Agent received an invalid solar_rlm model schema')
        assert(this.operatorInput !== undefined, 'operator fixture input was not configured')
        const argumentsText = JSON.stringify(this.operatorInput)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: 'fixture-solar-rlm', name: 'solar_rlm', argumentsDelta: argumentsText }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-solar-rlm', name: 'solar_rlm', arguments: argumentsText } }
        yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (ordinal === 2) {
        try {
        const toolMessage = options.messages.find(message => message.role === 'tool' && JSON.stringify(message.content).includes('RLM_BRIDGE_FIRST_MARKER'))
        assert(toolMessage !== undefined, 'actual parent Agent did not receive the solar_rlm result')
        const resultText = toolMessage.content.find(block => block.type === 'text')?.text
        assert(typeof resultText === 'string', 'solar_rlm result did not include a text payload for the parent Agent')
        const result = object(JSON.parse(resultText))
        assert(result.state === 'idle' && typeof result.runId === 'string' && typeof result.result === 'string' && result.result.includes('RLM_BRIDGE_FIRST_MARKER'), 'solar_rlm did not return the settled native result to the parent Agent')
        this.operatorResult = result
        const text = 'RLM_OPERATOR_PARENT_DONE'
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text }
        yield { type: 'block-end', index: 0, block: { type: 'text', text } }
        yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
        } catch (error) { this.parentFailure = { message: error.message, toolMessages: options.messages.filter(message => message.role === 'tool') }; throw error }
      }
      throw new Error(`operator fixture received unexpected parent Agent request ${String(ordinal)}`)
    }
    this.requests.push(options)
    const ordinal = this.requests.length
    if (ordinal === 1) {
      const code = 'print("RLM_TOOL_42", 6 * 7)'
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'fixture-python', name: 'python_repl', argumentsDelta: `{"code": ${JSON.stringify(code)}}` }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'fixture-python', name: 'python_repl', arguments: JSON.stringify({ code }) } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (ordinal === 2) assert(options.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('RLM_TOOL_42 42')), 'original Prime did not return the Python fixture output')
    const text = ordinal === 2
      ? 'RLM_BRIDGE_FIRST_MARKER'
      : ordinal === 3
        ? 'RLM_BRIDGE_SECOND_MARKER'
        : 'RLM_BRIDGE_RESUME_MARKER'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class AutonomousFixtureAdapter extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
    this.resolutions = []
  }

  providerInfo(provider) {
    return { id: provider, name: 'Solar RLM autonomous local fixture' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: AUTONOMOUS_FIXTURE_MODEL, name: 'Solar RLM autonomous local fixture', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    if (provider !== AUTONOMOUS_FIXTURE_PROVIDER || model !== AUTONOMOUS_FIXTURE_MODEL) throw new Error(`autonomous fixture route mismatch: ${provider}/${model}`)
    const info = {
      provider,
      id: model,
      name: 'Solar RLM autonomous local fixture',
      inputModalities: ['text'],
      context: { contextWindow: 8192 },
      defaultMaxTokens: 512,
    }
    this.resolutions.push(info)
    return Promise.resolve(info)
  }

  async *stream(options) {
    if (options.provider !== AUTONOMOUS_FIXTURE_PROVIDER || options.model !== AUTONOMOUS_FIXTURE_MODEL) throw new Error('autonomous fixture adapter received an unexpected route')
    options.signal?.throwIfAborted()
    this.requests.push(options)
    const ordinal = this.requests.length
    if (ordinal === 1) {
      const text = 'EARLY_STOP'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (ordinal === 2) {
      assert(options.messages.some(message => JSON.stringify(message).includes('EARLY_STOP')), 'autonomous continuation did not receive EARLY_STOP')
      assert(options.messages.some(message => JSON.stringify(message).includes('[autonomous-continuation: gate-failed]')), 'autonomous continuation did not receive the native gate-failed message')
      const code = "from pathlib import Path\nPath('gate.done').write_text('42')\nprint('AUTONOMOUS_TOOL_MARKER')"
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'autonomous-fixture-python', name: 'python_repl', argumentsDelta: `{"code": ${JSON.stringify(code)}}` }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'autonomous-fixture-python', name: 'python_repl', arguments: JSON.stringify({ code }) } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    if (ordinal === 3) {
      assert(options.messages.some(message => JSON.stringify(message).includes('AUTONOMOUS_TOOL_MARKER')), 'autonomous continuation did not receive the Python fixture output')
      const text = 'AUTONOMOUS_DONE'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (ordinal === 4) {
      const messages = options.messages.map(message => JSON.stringify(message)).join('\n')
      assert(messages.includes('AUTONOMOUS_DONE'), 'autonomous resume did not receive the prior completion marker')
      assert(messages.includes('AUTONOMOUS_TOOL_MARKER'), 'autonomous resume did not receive the prior Python tool marker')
      assert(messages.includes('Resume explicitly and return RESUMED.'), 'autonomous resume did not receive the new resume text')
      const text = 'RESUMED'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    throw new Error(`autonomous fixture received unexpected request ordinal ${String(ordinal)}`)
  }
}

class AutonomousFailureFixtureAdapter extends LlmAdapter {
  constructor() {
    super()
    this.requests = []
    this.resolutions = []
  }

  providerInfo(provider) {
    return { id: provider, name: 'Solar RLM autonomous gate-failure fixture' }
  }

  listModels(provider) {
    return Promise.resolve([{ provider, id: AUTONOMOUS_FAILURE_FIXTURE_MODEL, name: 'Solar RLM autonomous gate-failure fixture', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    if (provider !== AUTONOMOUS_FAILURE_FIXTURE_PROVIDER || model !== AUTONOMOUS_FAILURE_FIXTURE_MODEL) throw new Error(`autonomous failure fixture route mismatch: ${provider}/${model}`)
    const info = {
      provider,
      id: model,
      name: 'Solar RLM autonomous gate-failure fixture',
      inputModalities: ['text'],
      context: { contextWindow: 8192 },
      defaultMaxTokens: 512,
    }
    this.resolutions.push(info)
    return Promise.resolve(info)
  }

  async *stream(options) {
    if (options.provider !== AUTONOMOUS_FAILURE_FIXTURE_PROVIDER || options.model !== AUTONOMOUS_FAILURE_FIXTURE_MODEL) throw new Error('autonomous failure fixture adapter received an unexpected route')
    options.signal?.throwIfAborted()
    this.requests.push(options)
    if (this.requests.length > 8) throw new Error('autonomous failure fixture exceeded its eight-request acceptance cap')
    const text = 'EARLY_STOP_GATE_FAILURE'
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

async function waitForGateFailure(host, runId, ownerSessionId, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let latest
  while (Date.now() < deadline) {
    latest = await host.inspect(runId, ownerSessionId)
    if (latest.state === 'failed') return latest
    if (['idle', 'indeterminate'].includes(latest.state)) throw new Error(`fixture gate-failure run reached unexpected state: ${latest.state} ${latest.message}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`fixture gate-failure run did not become failed before timeout: ${JSON.stringify(latest)}`)
}

async function journalFor(host, runId) {
  const path = join(host.store.directory(runId), 'journal.jsonl')
  const raw = await readFile(path, 'utf8')
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function primeMetadata(value) {
  const body = object(value?.value)
  const params = object(body.params)
  const update = object(params.update)
  const metadata = object(update._meta)
  return object(metadata[PRIME_META])
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
  const tools = ctx.get('tools')
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  assert(tools !== undefined && typeof tools.schemas === 'function', 'tools service cannot expose the normal Prime RLM tool schema')
  assert(sessions !== undefined && typeof sessions.get === 'function' && typeof sessions.flush === 'function', 'session store cannot create a durable normal-tool owner')
  assert(agents !== undefined && typeof agents.create === 'function' && typeof agents.get === 'function', 'agent registry cannot create a durable normal-tool owner')
  const input = {
    task: 'Execute the supplied Python tool call, then reply with the fixture marker.',
    cwd: requiredEnv('SOLAR_RLM_PROBE_WORKSPACE'),
    label: 'RLM local bridge fixture',
    maxModelRequests: 6,
    maxWallTimeMs: 120_000,
  }
  let runId
  let agentHandle
  try {
    // AgentRegistry.create owns a published, persistent Session together with
    // the Agent loop. A session-shaped fixture cannot enter the ToolRuntime's
    // durable tool/call and tool/result path.
    const agentCreation = await agents.create({
      sessionId: owner.sessionId,
      meta: { cwd: input.cwd },
      agentOptions: owner.route,
    })
    agentHandle = agentCreation
    const agent = agentCreation.agent
    assert(agent.session?.id === owner.sessionId && sessions.get(owner.sessionId) === agent.session, 'operator fixture Agent is not backed by the live session-store instance')
    assert(agents.get(owner.sessionId) === agent, 'operator fixture Agent is not live in the agent registry')
    adapter.configureOperator(owner.sessionId, input)
    const operatorSchema = tools.schemas(agent).find(schema => schema.name === 'solar_rlm')
    assert(operatorSchema !== undefined, 'solar_rlm is not visible in the fixture Agent model schema')
    const operatorRequired = operatorSchema.parameters?.required
    const operatorProperties = operatorSchema.parameters?.properties
    assert(Array.isArray(operatorRequired) && ['task', 'cwd', 'maxModelRequests', 'maxWallTimeMs'].every(name => operatorRequired.includes(name)) && operatorProperties?.task?.type === 'string' && operatorProperties?.cwd?.type === 'string' && operatorProperties?.maxModelRequests?.type === 'integer' && operatorProperties?.maxWallTimeMs?.type === 'integer', 'solar_rlm model schema does not expose its required bounded input')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Use the declared solar_rlm tool for the fixture task, then report its result.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    const first = object(adapter.operatorResult)
    assert(typeof first.runId === 'string', `solar_rlm normal tool call did not return its run reference: ${JSON.stringify({parentRequests: adapter.parentRequests.length, parentFailure: adapter.parentFailure, events: agent.session.snapshotEvents().slice(-8)})}`)
    runId = first.runId
    assert(first.state === 'idle', `solar_rlm normal tool call returned before native completion: ${String(first.state)}`)
    assert(first.modelRequests === 2, `first bridge turn modelRequests=${String(first.modelRequests)}`)
    assert(typeof first.result === 'string' && first.result.includes('RLM_BRIDGE_FIRST_MARKER'), 'solar_rlm normal tool call did not return the native result to the parent Agent')
    assert(adapter.parentRequests.length === 2, `operator fixture parent Agent request count=${String(adapter.parentRequests.length)}`)
    const flushed = await sessions.flush(agent.session)
    assert(flushed === true, 'operator fixture session has no durable flush listener')
    const parentEvents = agent.session.snapshotEvents()
    const parentCall = parentEvents.find(event => event.type === 'tool/call' && object(event.data).name === 'solar_rlm')
    assert(parentCall !== undefined, 'normal Agent path did not append the solar_rlm tool/call event')
    const parentCallId = object(parentCall.data).callId
    const parentResult = parentEvents.find(event => event.type === 'tool/result' && object(object(event.data).message).toolCallId === parentCallId)
    assert(parentResult !== undefined && object(object(parentResult.data).message).isError !== true && JSON.stringify(object(parentResult.data).message).includes('RLM_BRIDGE_FIRST_MARKER'), 'normal Agent path did not append the settled solar_rlm tool/result event')
    assert(JSON.stringify(parentEvents).includes('RLM_OPERATOR_PARENT_DONE'), 'scripted parent Agent did not complete after the normal tool result')

    const secondReceipt = await host.continue(runId, 'Continue once and return the second fixture marker.', owner)
    assert(secondReceipt.runId === runId, 'continue returned a different run id')
    const second = await waitForIdle(host, runId, owner.sessionId)
    assert(second.modelRequests === 3, `second bridge turn modelRequests=${String(second.modelRequests)}`)
    assert(second.result?.includes('RLM_BRIDGE_SECOND_MARKER'), 'second bridge marker was not persisted')

    const cancelled = await host.cancel(runId, owner.sessionId)
    assert(cancelled.state === 'cancelled', `bridge cancel returned ${String(cancelled.state)}`)

    const resumedReceipt = await host.continue(runId, 'Resume explicitly and return the resume fixture marker.', owner)
    assert(resumedReceipt.runId === runId, 'resume returned a different run id')
    const resumed = await waitForIdle(host, runId, owner.sessionId)
    assert(resumed.modelRequests === 4, `resume bridge turn modelRequests=${String(resumed.modelRequests)}`)
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
    assert(dispatches.length === 4, `journal model-dispatch count=${String(dispatches.length)}`)
    assert(intents.length === 4, `journal model-intent count=${String(intents.length)}`)
    assert(dispatches.every(value => value.config?.provider === FIXTURE_PROVIDER && value.config?.model === FIXTURE_MODEL && value.config?.reasoningEffort === undefined && value.config?.maxTokens === 512), 'journal route or call controls do not match the fixture route')
    assert(intents.every(value => value.dshRequest?.provider === FIXTURE_PROVIDER && value.dshRequest?.model === FIXTURE_MODEL), 'journal intent route does not match fixture provider/model')
    assert(adapter.requests.length === 4, `fixture adapter request count=${String(adapter.requests.length)}`)
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
      authoritativeToolArgumentsExecuted: true,
      normalToolSchemaVisible: true,
      normalToolPath: true,
      normalToolResultReturned: true,
      normalToolParentAgentLive: true,
      normalToolSessionFlushed: true,
      normalToolDurableCallResult: true,
      parentAgentRequests: adapter.parentRequests.length,
      auxiliaryLocalRequests: adapter.auxiliaryRequests.length,
      parentAgentReasoningSelection: {
        status: 'notrun',
        reason: 'fixture 创建了真实 Agent、live Session 和 durable tool/call、tool/result；但该 Agent 的 solar_rlm 选择由本地 scripted provider 固定生成，未运行真实父 Agent 推理，也未证明模型自主选择。',
      },
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
    if (agentHandle !== undefined) {
      try {
        await agentHandle.dispose()
      } catch (error) {
        cleanupError ??= error
      }
    }
    try {
      registration()
    } catch (error) {
      cleanupError ??= error
    }
    if (cleanupError !== undefined) throw new Error(`fixture bridge cleanup could not confirm stop: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
  }
}

async function runAutonomousAcceptance(ctx, service, status) {
  const plan = selfTestPlan(status)
  if (plan.status !== 'ready') return { status: 'notrun', reason: plan.reason }
  const host = hostOf(service)
  const llm = llmService(ctx)
  const adapter = new AutonomousFixtureAdapter()
  const registration = llm.registerAdapter([AUTONOMOUS_FIXTURE_PROVIDER], adapter)
  const autonomous = { maxTurns: 6, maxTokens: 80_000, gate: 'test -f gate.done' }
  const owner = {
    sessionId: `rlm-probe-autonomous-owner-${process.pid}`,
    route: { provider: AUTONOMOUS_FIXTURE_PROVIDER, model: AUTONOMOUS_FIXTURE_MODEL, maxTokens: 512 },
  }
  let autonomousCwd
  let runId
  let cleanupError
  try {
    const workspaceRoot = requiredEnv('SOLAR_RLM_PROBE_WORKSPACE')
    autonomousCwd = await mkdtemp(join(workspaceRoot, 'rlm-autonomous-'))
    const input = {
      task: 'Use the native autonomous gate and Python tool to finish the selected task with the fixture completion marker.',
      cwd: autonomousCwd,
      label: 'RLM native autonomous fixture',
      maxModelRequests: 8,
      maxWallTimeMs: 120_000,
      autonomous,
    }
    const firstReceipt = await host.start(input, owner)
    runId = firstReceipt.runId
    const first = await waitForIdle(host, runId, owner.sessionId)
    assert(first.modelRequests === 3, `autonomous first run modelRequests=${String(first.modelRequests)}`)
    assert(first.result?.includes('AUTONOMOUS_DONE'), 'autonomous completion marker was not persisted')
    assert(adapter.requests.length === 3, `autonomous fixture request count before resume=${String(adapter.requests.length)}`)
    assert((await readFile(join(autonomousCwd, 'gate.done'), 'utf8')) === '42', 'autonomous Python fixture did not create gate.done with 42')

    const cancelled = await host.cancel(runId, owner.sessionId)
    assert(cancelled.state === 'cancelled', `autonomous cancel returned ${String(cancelled.state)}`)

    const resumedReceipt = await host.continue(runId, 'Resume explicitly and return RESUMED.', owner)
    assert(resumedReceipt.runId === runId, 'autonomous resume returned a different run id')
    const resumed = await waitForIdle(host, runId, owner.sessionId)
    assert(resumed.modelRequests === 4, `autonomous resumed modelRequests=${String(resumed.modelRequests)}`)
    assert(resumed.result?.includes('RESUMED'), 'autonomous resume marker was not persisted')
    assert(adapter.requests.length === 4, `autonomous total fixture request count=${String(adapter.requests.length)}`)

    const rows = await journalFor(host, runId)
    const values = rows.map(row => row.value)
    const launches = values.filter(value => value?.type === 'native-launch')
    assert(launches.length === 2, `autonomous native-launch count=${String(launches.length)}`)
    const initialArgs = launches[0]?.args
    const resumedArgs = launches[1]?.args
    assert(Array.isArray(initialArgs) && initialArgs.includes('--autonomous'), 'initial native launch did not enable autonomous mode')
    assert(Array.isArray(resumedArgs) && resumedArgs.includes('--resume'), 'resumed native launch did not include --resume')
    for (const args of [initialArgs, resumedArgs]) {
      assert(Array.isArray(args), 'native launch args are not an argv array')
      const turns = args.indexOf('--autonomous-max-turns')
      const tokens = args.indexOf('--autonomous-max-tokens')
      const timeout = args.indexOf('--autonomous-timeout-ms')
      const gate = args.indexOf('--autonomous-gate')
      assert(turns >= 0 && args[turns + 1] === '6', 'native launch max turns do not match autonomous snapshot')
      assert(tokens >= 0 && args[tokens + 1] === '80000', 'native launch max tokens do not match autonomous snapshot')
      assert(timeout >= 0 && args[timeout + 1] === '120000', 'native launch timeout does not match maxWallTimeMs')
      assert(gate >= 0 && args[gate + 1] === autonomous.gate, 'native launch gate does not match autonomous snapshot')
    }
    const modelErrors = values.filter(value => value?.type === 'model-error')
    assert(modelErrors.length === 0, `autonomous journal contains ${String(modelErrors.length)} model-error events`)
    assert(adapter.resolutions.length > 0 && adapter.resolutions.every(model => model.context?.contextWindow === 8192 && model.defaultMaxTokens === 512 && model.reasoning === undefined), 'autonomous fixture model metadata did not preserve context/output bounds or reasoning=false')

    const snapshotPath = join(host.store.directory(runId), 'execution.json')
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
    assert(snapshot.formatVersion === 1 && JSON.stringify(snapshot.autonomous) === JSON.stringify(autonomous), 'autonomous execution snapshot does not match the input')
    return {
      status: 'passed',
      provider: AUTONOMOUS_FIXTURE_PROVIDER,
      model: AUTONOMOUS_FIXTURE_MODEL,
      contextWindow: 8192,
      maxTokens: 512,
      reasoning: false,
      modelRequests: adapter.requests.length,
      initialModelRequests: first.modelRequests,
      paidProviderCalls: 0,
      modelErrors: modelErrors.length,
      nativeContinuation: true,
      gateFile: '42',
      firstState: first.state,
      resumedState: resumed.state,
      nativeLaunches: launches.length,
      resumedFromCancelled: true,
      snapshot: { formatVersion: snapshot.formatVersion, autonomous: snapshot.autonomous },
    }
  } finally {
    if (runId !== undefined) {
      try {
        await host.cancel(runId, owner.sessionId)
      } catch (error) {
        cleanupError = error
      }
    }
    if (autonomousCwd !== undefined) await rm(autonomousCwd, { recursive: true, force: true }).catch(error => { cleanupError ??= error })
    try {
      registration()
    } catch (error) {
      cleanupError ??= error
    }
    if (cleanupError !== undefined) throw new Error(`fixture autonomous cleanup could not confirm stop: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
  }
}

async function runAutonomousFailureAcceptance(ctx, service, status) {
  const plan = selfTestPlan(status)
  if (plan.status !== 'ready') return { status: 'notrun', reason: plan.reason }
  const host = hostOf(service)
  const llm = llmService(ctx)
  const adapter = new AutonomousFailureFixtureAdapter()
  const registration = llm.registerAdapter([AUTONOMOUS_FAILURE_FIXTURE_PROVIDER], adapter)
  const autonomous = { maxTurns: 12, maxTokens: 80_000, gate: 'false' }
  const owner = {
    sessionId: `rlm-probe-autonomous-failure-owner-${process.pid}`,
    route: { provider: AUTONOMOUS_FAILURE_FIXTURE_PROVIDER, model: AUTONOMOUS_FAILURE_FIXTURE_MODEL, maxTokens: 512 },
  }
  let autonomousCwd
  let runId
  let cleanupError
  try {
    const workspaceRoot = requiredEnv('SOLAR_RLM_PROBE_WORKSPACE')
    autonomousCwd = await mkdtemp(join(workspaceRoot, 'rlm-autonomous-failure-'))
    const input = {
      task: 'Exercise the native gate failure path and preserve its terminal evidence.',
      cwd: autonomousCwd,
      label: 'RLM native autonomous gate-failure fixture',
      maxModelRequests: 8,
      maxWallTimeMs: 120_000,
      autonomous,
    }
    const firstReceipt = await host.start(input, owner)
    runId = firstReceipt.runId
    const failed = await waitForGateFailure(host, runId, owner.sessionId)
    assert(failed.state === 'failed', `autonomous gate-failure state=${String(failed.state)}`)
    assert(failed.message?.includes('RLM_NATIVE_GATE_FAILED'), `autonomous gate-failure message did not identify RLM_NATIVE_GATE_FAILED: ${String(failed.message)}`)
    const localRequests = adapter.requests.length
    assert(localRequests >= 1 && localRequests <= 8, `autonomous gate-failure local request count=${String(localRequests)}`)

    const rows = await journalFor(host, runId)
    const values = rows.map(row => row.value)
    const intents = values.filter(value => value?.type === 'model-intent')
    assert(intents.length === localRequests, `autonomous gate-failure model intent count=${String(intents.length)} local requests=${String(localRequests)}`)
    const launches = values.filter(value => value?.type === 'native-launch')
    assert(launches.length === 1, `autonomous gate-failure native-launch count=${String(launches.length)}`)
    const launchArgs = launches[0]?.args
    assert(Array.isArray(launchArgs) && launchArgs.includes('--autonomous'), 'autonomous gate-failure launch did not enable autonomous mode')
    const turns = launchArgs?.indexOf('--autonomous-max-turns') ?? -1
    const tokens = launchArgs?.indexOf('--autonomous-max-tokens') ?? -1
    const timeout = launchArgs?.indexOf('--autonomous-timeout-ms') ?? -1
    const gate = launchArgs?.indexOf('--autonomous-gate') ?? -1
    assert(turns >= 0 && launchArgs[turns + 1] === '12', 'autonomous gate-failure max turns do not match the input')
    assert(tokens >= 0 && launchArgs[tokens + 1] === '80000', 'autonomous gate-failure max tokens do not match the input')
    assert(timeout >= 0 && launchArgs[timeout + 1] === '120000', 'autonomous gate-failure timeout does not match maxWallTimeMs')
    assert(gate >= 0 && launchArgs[gate + 1] === autonomous.gate, 'autonomous gate-failure gate does not match the input')
    const gateFailedMarker = intents.some(value => JSON.stringify(value.primeRequest?.messages).includes('[autonomous-continuation: gate-failed]'))
    assert(gateFailedMarker, 'autonomous gate-failure journal did not preserve the native gate-failed marker')
    const acpValues = values.filter(value => value?.type === 'acp')
    const terminalMetadata = acpValues.map(primeMetadata).filter(meta => meta.phase === 'terminalQuiescence')
    assert(terminalMetadata.length > 0, 'autonomous gate-failure journal did not preserve terminal metadata')
    const terminal = terminalMetadata.at(-1)
    const terminalAutonomous = object(terminal.autonomous)
    assert(terminal.outcome === 'result', `autonomous gate-failure terminal outcome=${String(terminal.outcome)}`)
    assert(terminalAutonomous.enabled === true, 'autonomous gate-failure terminal metadata is not autonomous')
    assert(typeof terminalAutonomous.gateFailure === 'string' && terminalAutonomous.gateFailure.trim().length > 0, 'autonomous gate-failure terminal metadata has no gateFailure')
    const stopReasons = acpValues.map(value => object(value.value).result?.stopReason).filter(reason => typeof reason === 'string')
    const stopReason = stopReasons.at(-1)
    assert(['end_turn', 'max_turn_requests'].includes(stopReason), `autonomous gate-failure unexpected stop reason: ${JSON.stringify(stopReasons)}`)
    const modelErrors = values.filter(value => value?.type === 'model-error')
    assert(modelErrors.length === 0, `autonomous gate-failure journal contains ${String(modelErrors.length)} model-error events`)
    assert(adapter.resolutions.length > 0 && adapter.resolutions.every(model => model.context?.contextWindow === 8192 && model.defaultMaxTokens === 512 && model.reasoning === undefined), 'autonomous gate-failure fixture model metadata did not preserve context/output bounds or reasoning=false')
    return {
      status: 'passed',
      provider: AUTONOMOUS_FAILURE_FIXTURE_PROVIDER,
      model: AUTONOMOUS_FAILURE_FIXTURE_MODEL,
      contextWindow: 8192,
      maxTokens: 512,
      reasoning: false,
      localRequests,
      paidProviderCalls: 0,
      modelErrors: modelErrors.length,
      gateFailedMarker: true,
      terminalOutcome: terminal.outcome,
      stopReason,
      gateFailure: terminalAutonomous.gateFailure,
      state: failed.state,
      message: failed.message,
    }
  } finally {
    if (runId !== undefined) {
      try {
        await host.cancel(runId, owner.sessionId)
      } catch (error) {
        cleanupError = error
      }
    }
    if (autonomousCwd !== undefined) await rm(autonomousCwd, { recursive: true, force: true }).catch(error => { cleanupError ??= error })
    try {
      registration()
    } catch (error) {
      cleanupError ??= error
    }
    if (cleanupError !== undefined) throw new Error(`fixture autonomous gate-failure cleanup could not confirm stop: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
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
    autonomous: 'notrun',
    autonomousFailure: 'notrun',
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
      selftest.autonomous = await runAutonomousAcceptance(ctx, service, status)
      checks.autonomous = selftest.autonomous.status
      assert(selftest.autonomous.status === 'passed', `RLM autonomous acceptance returned ${String(selftest.autonomous.status)}`)
      selftest.autonomousFailure = await runAutonomousFailureAcceptance(ctx, service, status)
      checks.autonomousFailure = selftest.autonomousFailure.status
      assert(selftest.autonomousFailure.status === 'passed', `RLM autonomous gate-failure acceptance returned ${String(selftest.autonomousFailure.status)}`)
      checks.selftest = 'passed'
    } else {
      selftest = { ...plan, bridge: plan, autonomous: plan, autonomousFailure: plan }
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
