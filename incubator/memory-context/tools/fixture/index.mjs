import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { defineTool } from '@deepseek-ai/dsh-tools'

const PROVIDER = 'memory-context-fixture'
const MODEL = 'memory-context-fixture-model'
const TOOL = 'memory_context_fixture_tool'
const FIRST_QUERY = 'alpha context evidence'
const SECOND_QUERY = 'beta context evidence'
const HINDSIGHT_GUIDE = JSON.parse(readFileSync(new URL('./hindsight-guide.json', import.meta.url), 'utf8')).text

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`memory-context fixture requires ${name}`)
  return value
}

function mode() {
  const value = requiredEnvironment('MEMORY_CONTEXT_FIXTURE_MODE')
  if (value !== 'baseline' && value !== 'integrated') throw new Error(`invalid fixture mode ${value}`)
  return value
}

function userMessage(text) {
  return createUserMessage({
    id: MessageId(randomUUID()),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  })
}

function snapshot(topic) {
  const text = [
    '<memory_capsules>',
    `  <turn_memory id="fixture-${topic}" outcome="completed" created_at="2026-10-24">${topic} context evidence retained by the fixture.</turn_memory>`,
    '</memory_capsules>',
    '<navigation_graph>',
    `  <triple memory_id="fixture-${topic}">`,
    `    <subject>${topic}</subject>`,
    '    <predicate>has</predicate>',
    '    <object>context-evidence</object>',
    '  </triple>',
    '</navigation_graph>',
    '<episodic_context>',
    `  <trace source="turn-memory:fixture-${topic}">[USER] ${topic} context evidence</trace>`,
    '</episodic_context>',
  ].join('\n')
  return createUserMessage({
    id: MessageId(randomUUID()),
    role: 'user',
    source: {
      kind: 'plugin:graph-memory',
      form: 'snapshot',
      sections: [{ name: 'graph-memory:recall', text }],
    },
    content: [{ type: 'text', text }],
  })
}

function textOf(message) {
  return Array.isArray(message?.content)
    ? message.content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    : []
}

function messageSummary(message) {
  const source = message?.source
  return {
    role: message?.role,
    source: source && typeof source === 'object'
      ? {
          kind: source.kind,
          form: source.form,
          solarMemoryContext: source.solarMemoryContext,
          solarHindsightContext: source.solarHindsightContext,
        }
      : undefined,
    text: textOf(message),
  }
}

class CapturingAdapter extends LlmAdapter {
  requests = []

  async *stream(options) {
    options.signal?.throwIfAborted()
    this.requests.push({
      provider: options.provider,
      model: options.model,
      messages: options.messages.map(messageSummary),
      toolNames: (options.tools ?? []).map(tool => tool.name).sort(),
    })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Fixture response only; no external model was called.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Fixture response only; no external model was called.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function graphMessages(request) {
  return request.messages.filter(message => message.source?.kind === 'plugin:graph-memory')
}

function rawGraphMessages(request) {
  return graphMessages(request).filter(message => message.source?.solarMemoryContext === undefined)
}

function projectedGraphMessages(request) {
  return graphMessages(request).filter(message => message.source?.solarMemoryContext?.kind === 'solar-memory-context')
}

function attachGraphMemoryProducer(agent, state) {
  state.agentScopedAttachments += 1
  agent.ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || payload.agent.id !== state.agentId || payload.step !== 1) return decision
    const question = payload.messages
      .filter(message => message.source?.kind === 'user')
      .flatMap(textOf)
      .join('\n')
    const topic = question.includes('alpha') ? 'alpha' : question.includes('beta') ? 'beta' : undefined
    assert.notEqual(topic, undefined, `unexpected fixture question ${question}`)
    state.agentScopedPreSteps += 1
    return { ...decision, messages: [snapshot(topic), ...decision.messages] }
  }, { prepend: true })
}

async function writeReceipt(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function serialiseError(error) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: 'UnknownError', message: String(error) }
}

async function runFixture(ctx, adapter, state) {
  const agents = ctx.get('agents')
  assert(agents !== undefined && typeof agents.create === 'function', 'AgentRegistry is unavailable')
  const handle = await agents.create({
    sessionId: `memory-context-fixture-${randomUUID()}`,
    agentOptions: { provider: PROVIDER, model: MODEL },
  })
  assert.equal(state.agentId, handle.agent.id, 'fixture must queue the first followup from agent/created')
  try {
    await handle.agent.whenIdle()
    handle.agent.followup(userMessage(SECOND_QUERY))
    await handle.agent.whenIdle()

    assert.equal(adapter.requests.length, 2, 'two root followups must reach the fixture adapter')
    const [first, second] = adapter.requests
    assert.equal(first.provider, PROVIDER)
    assert.equal(second.provider, PROVIDER)
    assert(first.toolNames.includes(TOOL), 'fixture tool was not preserved on the first request')
    assert.deepEqual(first.toolNames, second.toolNames, 'tool declarations changed between requests')
    assert.equal(state.agentScopedAttachments, 1, 'Graph Memory fixture did not attach at Agent scope')
    assert.equal(state.agentScopedPreSteps, 2, 'Graph Memory fixture did not contribute at each Agent pre-step')
    assert.equal(state.immediateCreatedFollowup, true, 'fixture did not enqueue its first followup during agent/created')
    for (const request of [first, second]) {
      const hindsight = request.messages.filter(message => message.source?.kind === 'plugin:hindsight')
      assert.equal(hindsight.length, 1, 'one resident Hindsight guide must remain available')
      assert(hindsight[0].text.join('\n').includes('Synthetic factual recall HN-42'), 'Hindsight factual recall was removed')
      if (state.mode === 'baseline') assert(hindsight[0].text.join('\n').includes(HINDSIGHT_GUIDE), 'baseline must expose the full original guide')
      else {
        assert.equal(hindsight[0].source?.solarHindsightContext?.formatVersion, 1)
        assert(!hindsight[0].text.join('\n').includes(HINDSIGHT_GUIDE), 'full resident guide leaked after projection')
        assert(hindsight[0].text.join('\n').includes('hindsight_search_knowledge_pages(query)'), 'on-demand knowledge capability guidance was removed')
      }
    }

    if (state.mode === 'baseline') {
      assert.equal(rawGraphMessages(first).length, 1, 'baseline first request must include its raw automatic snapshot')
      assert.equal(rawGraphMessages(second).length, 2, 'baseline second request must accumulate historical and current raw snapshots')
    } else {
      assert.equal(rawGraphMessages(first).length, 0, 'integrated first request leaked a raw automatic snapshot')
      assert.equal(rawGraphMessages(second).length, 0, 'integrated second request revived a raw historical snapshot')
      assert.equal(projectedGraphMessages(first).length, 1, 'integrated first request needs one projected current snapshot')
      assert.equal(projectedGraphMessages(second).length, 1, 'integrated second request needs only its current projected snapshot')
      assert.equal(projectedGraphMessages(first)[0]?.source?.solarMemoryContext?.turn, 1)
      assert.equal(projectedGraphMessages(second)[0]?.source?.solarMemoryContext?.turn, 2)
      const events = handle.agent.session.snapshotEvents()
      const retired = events.filter(event => event.type === 'developer/message' && event.data.message.source.kind === 'solar-memory-context')
      assert.equal(retired.length, 1, 'the first projected snapshot must be retired before the second request')
      assert.deepEqual(retired[0]?.sourceEventSeqs?.length, 1, 'retirement must cite one original surface event')
    }

    return {
      formatVersion: 1,
      fixtureOnly: true,
      loadedByOfficialCli: true,
      noLiveModels: true,
      actualBuiltPlugin: state.mode === 'integrated',
      mode: state.mode,
      runtime: 'AgentRegistry + Agent-scoped Graph Memory pre-step fixture',
      requests: adapter.requests,
      checks: {
        agentScopedProducer: true,
        prependOrderObserved: true,
        createdCallbackFollowup: true,
        sourcePreserved: state.mode === 'baseline' || projectedGraphMessages(first).every(message => message.source?.kind === 'plugin:graph-memory'),
        toolsUnchanged: true,
        hindsightGuideAndFactsPreserved: true,
        noExternalModel: true,
      },
      pass: true,
    }
  } finally {
    await handle.dispose()
  }
}

export const name = 'memory-context-fixture'
export const inject = ['appReady', 'agents', 'llm', 'tools']

export async function apply(ctx) {
  const receiptPath = requiredEnvironment('MEMORY_CONTEXT_FIXTURE_RECEIPT')
  const state = { mode: mode(), agentId: undefined, agentScopedAttachments: 0, agentScopedPreSteps: 0, immediateCreatedFollowup: false, blockedRoutes: [] }
  const llm = ctx.get('llm')
  assert(llm !== undefined && typeof llm.registerAdapter === 'function', 'LlmRuntime is unavailable')
  const adapter = new CapturingAdapter()
  const disposeAdapter = llm.registerAdapter([PROVIDER], adapter)
  const fixtureTool = defineTool({
    name: TOOL,
    description: 'Fixture-only tool used to prove request tool declarations remain unchanged.',
    parameters: {},
    output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '{}' }] },
    async execute() { return { fixture: true } },
  })
  const disposeTool = ctx.tools.register(fixtureTool)
  const disposeCreated = ctx.on('agent/created', ({ agent }) => {
    attachGraphMemoryProducer(agent, state)
    return undefined
  })
  const disposeHindsight = ctx.on('agent/pre-step', async ({ turn, step }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || turn !== 1 || step !== 1) return decision
    return { ...decision, messages: [...decision.messages, createUserMessage({
      source: { kind: 'plugin:hindsight', form: 'recall' },
      content: [{ type: 'text', text: HINDSIGHT_GUIDE + '\n<relevant_memories>Synthetic factual recall HN-42</relevant_memories>' }],
    })] }
  }, { prepend: true })
  const disposeImmediateFollowup = ctx.on('agent/created', ({ agent }) => {
    if (state.agentId !== undefined) return undefined
    state.agentId = agent.id
    state.immediateCreatedFollowup = true
    agent.followup(userMessage(FIRST_QUERY))
    return undefined
  })
  const disposeGuard = ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== PROVIDER) {
      state.blockedRoutes.push({ provider: options.provider, model: options.model })
      throw new Error(`fixture blocked non-local model route ${options.provider}/${options.model}`)
    }
    yield* next()
  }, { global: true })
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  assert(ready !== undefined && typeof ready.onReady === 'function', 'appReady service is unavailable')
  assert(typeof exit === 'function', 'appExit service is unavailable')
  let started = false
  const cancelReady = ready.onReady(() => {
    if (started) return
    started = true
    void (async () => {
      try {
        await writeReceipt(receiptPath, await runFixture(ctx, adapter, state))
        exit(0)
      } catch (error) {
        try {
          await writeReceipt(receiptPath, {
            formatVersion: 1,
            fixtureOnly: true,
            loadedByOfficialCli: true,
            noLiveModels: true,
            actualBuiltPlugin: state.mode === 'integrated',
            mode: state.mode,
            blockedRoutes: state.blockedRoutes,
            requests: adapter.requests,
            pass: false,
            error: serialiseError(error),
          })
        } finally {
          exit(1)
        }
      }
    })()
  })
  return () => {
    cancelReady()
    disposeGuard()
    disposeCreated()
    disposeHindsight()
    disposeImmediateFollowup()
    disposeTool()
    disposeAdapter()
  }
}
