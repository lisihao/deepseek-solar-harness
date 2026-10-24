import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'

const PROVIDER = 'hindsight-chat-recall-fixture'
const MODEL = 'fixture-model'
const WORKSPACE_ID = 'fixture-workspace'
const RECALL_SOURCE = 'plugin:solar-hindsight-chat-recall'
const FIRST_QUERY = 'Synthetic alpha topic: what evidence was recorded?'
const SECOND_QUERY = 'Synthetic beta topic: what changed afterward?'
const SLOW_QUERY = 'Synthetic timeout topic: do not dispatch a model request.'

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`hindsight chat-recall fixture requires ${name}`)
  return value
}

function fixtureMode() {
  const mode = requiredEnvironment('CHAT_RECALL_FIXTURE_MODE')
  if (mode !== 'baseline' && mode !== 'integrated') {
    throw new Error(`CHAT_RECALL_FIXTURE_MODE must be baseline or integrated, got ${mode}`)
  }
  return mode
}

function serialiseError(error) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  return { name: 'UnknownError', message: String(error) }
}

function textBlocks(message) {
  if (!Array.isArray(message?.content)) return []
  return message.content.flatMap(block => (
    block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
      ? [block.text]
      : []
  ))
}

function summary(message) {
  const source = message?.source
  return {
    id: typeof message?.id === 'string' ? message.id : undefined,
    role: typeof message?.role === 'string' ? message.role : undefined,
    source: source !== null && typeof source === 'object'
      ? { kind: source.kind, ...(source.form === undefined ? {} : { form: source.form }) }
      : undefined,
    text: textBlocks(message),
  }
}

function capturedRequest(options) {
  const messages = options.messages.map(summary)
  return {
    provider: options.provider,
    model: options.model,
    messageCount: messages.length,
    messageSources: messages.map(message => message.source?.kind),
    userTexts: messages.filter(message => message.source?.kind === 'user').flatMap(message => message.text),
    recallTexts: messages.filter(message => message.source?.kind === RECALL_SOURCE).flatMap(message => message.text),
  }
}

class CapturingAdapter extends LlmAdapter {
  requests = []

  async *stream(options) {
    options.signal?.throwIfAborted()
    this.requests.push(capturedRequest(options))
    const text = 'Synthetic fixture response; no external model was contacted.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function userMessage(text) {
  return {
    id: MessageId(randomUUID()),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

function activeHindsightDirectory() {
  return {
    ok: true,
    value: {
      items: [{
        active: true,
        providerEnabled: true,
        provider: { id: 'hindsight' },
      }],
    },
  }
}

function searchEnvelope(query, ordinal) {
  const topic = query === FIRST_QUERY ? 'alpha' : query === SECOND_QUERY ? 'beta' : undefined
  assert.notEqual(topic, undefined, `unexpected synthetic search query: ${query}`)
  return {
    ok: true,
    value: {
      results: [{
        id: `fixture-memory-${topic}-${ordinal}`,
        content: `Synthetic ${topic} Hindsight evidence for the current test topic.`,
        memoryProviderId: 'hindsight',
        source: { kind: 'fixture', topic },
        score: 0.9,
      }],
    },
  }
}

function createRemote(state) {
  return {
    async read(operation, payload, signal) {
      state.reads.push({ operation, payload: { ...payload } })
      assert.equal(payload.workspaceId, WORKSPACE_ID, 'chat recall must use the registered workspace only')
      signal.throwIfAborted()
      if (operation === 'body-directory') return activeHindsightDirectory()
      assert.equal(operation, 'search', `unexpected fixture operation: ${operation}`)
      assert.equal(payload.limit, 10, 'chat recall must use the fixed search limit')
      assert.equal(typeof payload.query, 'string', 'chat recall must send a textual query')
      if (payload.query === SLOW_QUERY) {
        state.timeoutSearchStarted = true
        state.timeoutSignal = signal
        // Deliberately ignore cancellation. The plugin's own deadline must end
        // the request and prevent the AgentLoop from reaching the adapter.
        return new Promise(() => {})
      }
      state.searchQueries.push(payload.query)
      return searchEnvelope(payload.query, state.searchQueries.length)
    },
  }
}

async function writeReceipt(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function lastRecall(request) {
  const value = request.recallTexts.at(-1)
  assert.equal(typeof value, 'string', 'the fake adapter did not receive a recall message')
  return value
}

async function runBaseline(ctx, adapter, state) {
  const agents = ctx.get('agents')
  assert(agents !== undefined && typeof agents.create === 'function', 'AgentRegistry is unavailable')
  const handle = await agents.create({
    sessionId: `fixture-chat-recall-baseline-${randomUUID()}`,
    meta: { cwd: state.workspacePath },
    agentOptions: { provider: PROVIDER, model: MODEL },
  })
  state.agentId = handle.agent.id
  try {
    handle.agent.followup(userMessage(FIRST_QUERY))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests.length, 1, 'the baseline root followup must dispatch one fake-adapter request')
    assert.deepEqual(adapter.requests[0]?.recallTexts, [], 'the baseline request unexpectedly contains chat-recall evidence')
    assert.deepEqual(state.reads, [], 'the baseline must not call the fixture memory service')
    assert.deepEqual(state.blockedModelRequests, [], 'the baseline attempted a non-fixture model route')
    assert.equal(state.preSteps[0]?.startsRequestSeries, true, 'the outer observer did not receive startsRequestSeries')
    return {
      formatVersion: 1,
      fixtureOnly: true,
      actualBuiltPlugin: false,
      loadedByOfficialCli: true,
      noLiveModels: true,
      mode: state.mode,
      runtime: 'AgentRegistry+AgentLoop root followup',
      provider: PROVIDER,
      model: MODEL,
      reads: state.reads,
      requests: adapter.requests,
      preSteps: state.preSteps,
      blockedModelRequests: state.blockedModelRequests,
      checks: {
        rootAgent: true,
        baselineHasNoRecall: true,
        startsRequestSeriesPreserved: true,
        nonFixtureModelsBlocked: true,
      },
      pass: true,
    }
  } finally {
    await handle.dispose()
  }
}

async function runFixture(ctx, adapter, state) {
  if (state.mode === 'baseline') return runBaseline(ctx, adapter, state)
  const agents = ctx.get('agents')
  assert(agents !== undefined && typeof agents.create === 'function', 'AgentRegistry is unavailable')
  const handle = await agents.create({
    sessionId: `fixture-chat-recall-${randomUUID()}`,
    meta: { cwd: state.workspacePath },
    agentOptions: { provider: PROVIDER, model: MODEL },
  })
  state.agentId = handle.agent.id
  try {
    handle.agent.followup(userMessage(FIRST_QUERY))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests.length, 1, 'the first root followup must dispatch exactly one fake-adapter request')
    const first = adapter.requests[0]
    assert.equal(first?.provider, PROVIDER)
    assert.equal(first?.model, MODEL)
    assert(lastRecall(first).includes('fixture-memory-alpha-1'), 'the first request lacks alpha recall evidence')
    assert(lastRecall(first).includes('Synthetic alpha Hindsight evidence'), 'the first request lacks alpha recall content')

    handle.agent.followup(userMessage(SECOND_QUERY))
    await handle.agent.whenIdle()
    assert.equal(adapter.requests.length, 2, 'the changed-topic root followup must dispatch exactly one more fake-adapter request')
    const second = adapter.requests[1]
    assert(lastRecall(second).includes('fixture-memory-beta-2'), 'the changed-topic request lacks fresh beta recall evidence')
    assert(lastRecall(second).includes('Synthetic beta Hindsight evidence'), 'the changed-topic request lacks beta recall content')
    assert.notEqual(lastRecall(first), lastRecall(second), 'a changed topic reused the earlier recall block')
    assert.deepEqual(state.searchQueries, [FIRST_QUERY, SECOND_QUERY], 'each root followup must perform its own topic search')

    const dispatchedBeforeTimeout = adapter.requests.length
    handle.agent.followup(userMessage(SLOW_QUERY))
    await handle.agent.whenIdle()
    assert.equal(state.timeoutSearchStarted, true, 'the timeout scenario never entered synthetic search')
    assert.equal(state.timeoutSignal?.aborted, true, 'the timeout scenario did not abort the read signal')
    assert.equal(adapter.requests.length, dispatchedBeforeTimeout, 'a timed-out recall must not dispatch the fake adapter')
    assert.deepEqual(state.searchQueries, [FIRST_QUERY, SECOND_QUERY], 'the timed-out search must not produce evidence')
    assert.equal(state.preSteps[0]?.startsRequestSeries, true, 'the first pre-step must preserve startsRequestSeries')
    assert.deepEqual(state.blockedModelRequests, [], 'the fixture attempted a non-fixture model route')

    return {
      formatVersion: 1,
      fixtureOnly: true,
      actualBuiltPlugin: true,
      loadedByOfficialCli: true,
      noLiveModels: true,
      mode: state.mode,
      runtime: 'AgentRegistry+AgentLoop root followup',
      provider: PROVIDER,
      model: MODEL,
      reads: state.reads,
      requests: adapter.requests,
      preSteps: state.preSteps,
      blockedModelRequests: state.blockedModelRequests,
      checks: {
        rootAgent: true,
        firstRecallAppeared: true,
        changedTopicProducedFreshRecall: true,
        timeoutAbortedRead: true,
        timeoutPreventedDispatch: true,
        startsRequestSeriesPreserved: true,
        nonFixtureModelsBlocked: true,
      },
      pass: true,
    }
  } finally {
    await handle.dispose()
  }
}

export const name = 'hindsight-chat-recall-fixture'
export const inject = ['appReady', 'agents', 'llm']

export async function apply(ctx) {
  const receiptPath = requiredEnvironment('CHAT_RECALL_FIXTURE_RECEIPT')
  const mode = fixtureMode()
  const workspacePath = await realpath(requiredEnvironment('CHAT_RECALL_FIXTURE_WORKSPACE'))
  const state = {
    mode,
    workspacePath,
    reads: [],
    searchQueries: [],
    preSteps: [],
    agentId: undefined,
    timeoutSearchStarted: false,
    timeoutSignal: undefined,
    blockedModelRequests: [],
  }
  ctx.provide('mnemonRemote', createRemote(state))
  ctx.provide('workspaceRegistry', { list: () => [{ id: WORKSPACE_ID, path: workspacePath }] })

  const llm = ctx.get('llm')
  assert(llm !== undefined && typeof llm.registerAdapter === 'function', 'LlmRuntime is unavailable')
  const adapter = new CapturingAdapter()
  const disposeAdapter = llm.registerAdapter([PROVIDER], adapter)
  const disposeInnerPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (payload.agent.id === state.agentId && decision.kind === 'enter') {
      return { ...decision, startsRequestSeries: true }
    }
    return decision
  })
  const disposeStreamGuard = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER) {
      state.blockedModelRequests.push({ provider: options.provider, model: options.model })
      throw new Error(`fixture blocked non-fake model route ${options.provider}/${options.model}`)
    }
    yield* next()
  }, { global: true })

  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  assert(ready !== undefined && typeof ready.onReady === 'function', 'appReady service is unavailable')
  assert(typeof exit === 'function', 'appExit service is unavailable')
  let started = false
  let disposeOuterPreStep = () => {}
  const cancelReady = ready.onReady(() => {
    if (started) return
    started = true
    disposeOuterPreStep = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (payload.agent.id === state.agentId && decision.kind === 'enter') {
        state.preSteps.push({
          startsRequestSeries: decision.startsRequestSeries === true,
          messageCount: decision.messages.length,
        })
      }
      return decision
    }, { prepend: true })
    void (async () => {
      try {
        const receipt = await runFixture(ctx, adapter, state)
        await writeReceipt(receiptPath, receipt)
        exit(0)
      } catch (error) {
        const receipt = {
          formatVersion: 1,
          fixtureOnly: true,
          actualBuiltPlugin: state.mode === 'integrated',
          loadedByOfficialCli: true,
          noLiveModels: true,
          mode: state.mode,
          reads: state.reads,
          requests: adapter.requests,
          preSteps: state.preSteps,
          blockedModelRequests: state.blockedModelRequests,
          pass: false,
          error: serialiseError(error),
        }
        try { await writeReceipt(receiptPath, receipt) } finally { exit(1) }
      }
    })()
  })
  return () => {
    cancelReady()
    disposeOuterPreStep()
    disposeInnerPreStep()
    disposeStreamGuard()
    disposeAdapter()
  }
}
