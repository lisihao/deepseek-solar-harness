import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runBaseline } from './baseline.mjs'

const PLAN = {
  arms: {
    B: {
      systemPrompt: 'Frozen B prompt. Keep this exact string.',
    },
  },
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function assistant(content, toolCalls) {
  return {
    role: 'assistant',
    content: content ?? null,
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
  }
}

function finishChunk(message, replayState = { response: { cursor: 'opaque' } }) {
  return { type: 'finish', message, replayState }
}

function toolCall(id, name, args) {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

class FakeReplayRegistry {
  constructor() {
    this.states = []
    this.lookupCount = 0
  }

  record(message, replayState) {
    this.states.push({ message: clone(message), replayState: clone(replayState) })
  }

  forMessage(message) {
    this.lookupCount += 1
    const entry = this.states.find(item => JSON.stringify(item.message) === JSON.stringify(message))
    return entry?.replayState
  }
}

function fakeWire({ decodeCalls }) {
  return {
    ReplayRegistry: FakeReplayRegistry,
    async decodeChatRequest(request, route, options) {
      decodeCalls.push({ request: clone(request), route, options })
      // Exercise the replay hook for every previous assistant message. The
      // production decoder does this when an opaque provider field is present.
      for (const message of request.messages) {
        if (message.role === 'assistant') options.replayFor(message)
      }
      return { request: clone(request), route, signal: options.signal }
    },
    async *encodeChatStream(chunks, options) {
      let finish
      for await (const chunk of chunks) {
        if (chunk.type !== 'finish') throw new Error(`unexpected fake chunk ${String(chunk.type)}`)
        if (finish !== undefined) throw new Error('fake stream finished twice')
        finish = chunk
      }
      if (finish === undefined) throw new Error('fake stream has no finish')
      options.onFinish({
        message: clone(finish.message),
        replayState: clone(finish.replayState),
        finishReason: finish.message.tool_calls ? 'tool_calls' : 'stop',
      })
      yield `data: ${JSON.stringify({ model: options.model })}\n\n`
      yield 'data: [DONE]\n\n'
    },
  }
}

class FakeBroker {
  constructor({ terminalAfterActs = 0, inspectValues = [] } = {}) {
    this.terminalAfterActs = terminalAfterActs
    this.inspectValues = [...inspectValues]
    this.calls = []
    this.inspectCalls = 0
    this.terminal = 'ACTIVE'
  }

  async call(op, args) {
    this.calls.push({ op, args: clone(args) })
    if (op === 'act' && this.calls.filter(item => item.op === 'act').length >= this.terminalAfterActs && this.terminalAfterActs > 0) {
      this.terminal = 'WIN'
    }
    return { ok: true, value: { terminal: this.terminal, op, args } }
  }

  async inspect() {
    this.inspectCalls += 1
    if (this.inspectValues.length > 0) return this.inspectValues.shift()
    return { ok: true, value: { terminal: this.terminal } }
  }
}

async function scenario({ responses, broker, requestLimit = 32 }) {
  const directory = await mkdtemp(join(tmpdir(), 'arc-baseline-test-'))
  const decodeCalls = []
  const calls = []
  try {
    const result = await runBaseline({
      directory,
      plan: PLAN,
      gameId: 'ls20-test',
      broker,
      route: { provider: 'fake', model: 'configured' },
      wire: fakeWire({ decodeCalls }),
      callModel: async options => {
        calls.push(options)
        const response = responses.shift()
        if (!response) throw new Error('fake response queue exhausted')
        return (async function* () {
          yield finishChunk(response.message, response.replayState)
        })()
      },
      wallTimeMs: 10_000,
      requestLimit,
    })
    return { result, directory, decodeCalls, calls }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

test('text claiming WIN while broker remains ACTIVE does not complete', async () => {
  const broker = new FakeBroker({ inspectValues: [{ ok: true, value: { terminal: 'ACTIVE' } }] })
  const run = await scenario({
    broker,
    requestLimit: 1,
    responses: [
      { message: assistant('I won!') },
    ],
  })
  assert.equal(run.result.state, 'budget_exhausted')
  assert.equal(run.result.stopReason, 'REQUEST_LIMIT')
  assert.equal(run.result.requests, 1)
  assert.equal(broker.calls.length, 0)
  await rm(run.directory, { recursive: true, force: true })
})

test('two ordered tools stop immediately on authoritative terminal inspection', async () => {
  const broker = new FakeBroker({ terminalAfterActs: 2 })
  const run = await scenario({
    broker,
    responses: [
      { message: assistant(null, [toolCall('c1', 'observe', {}), toolCall('c2', 'act', { actions: [{ name: 'ACTION1', data: {} }] })]) },
      { message: assistant(null, [toolCall('c3', 'act', { actions: [{ name: 'ACTION2', data: {} }] })]) },
      { message: assistant('must not be requested') },
    ],
  })
  assert.equal(run.result.state, 'completed')
  assert.equal(run.result.stopReason, 'WIN')
  assert.deepEqual(broker.calls.map(item => item.op), ['observe', 'act', 'act'])
  assert.equal(run.result.requests, 2)
  await rm(run.directory, { recursive: true, force: true })
})

test('authoritative tool arguments are passed as parsed JSON, not model text', async () => {
  const broker = new FakeBroker({ terminalAfterActs: 1 })
  const run = await scenario({
    broker,
    responses: [{ message: assistant(null, [toolCall('click', 'act', { actions: [{ name: 'ACTION6', data: { x: 7, y: 42 } }] })]) }],
  })
  assert.equal(run.result.state, 'completed')
  assert.deepEqual(broker.calls[0], { op: 'act', args: { actions: [{ name: 'ACTION6', data: { x: 7, y: 42 } }] } })
  await rm(run.directory, { recursive: true, force: true })
})

test('bad arguments become a tool error and never execute a broker action', async () => {
  const broker = new FakeBroker({ inspectValues: [{ ok: true, value: { terminal: 'ACTIVE' } }] })
  const run = await scenario({
    broker,
    requestLimit: 1,
    responses: [{ message: assistant(null, [toolCall('bad', 'act', { actions: [{ name: 'ACTION6', data: {} }] })]) }],
  })
  assert.equal(run.result.state, 'budget_exhausted')
  assert.equal(broker.calls.length, 0)
  const messages = await readFile(join(run.directory, 'messages.jsonl'), 'utf8')
  assert.match(messages, /ARC_TOOL_ARGS/)
  await rm(run.directory, { recursive: true, force: true })
})

test('null data for a non-click action is rejected without broker execution', async () => {
  const broker = new FakeBroker({ inspectValues: [{ ok: true, value: { terminal: 'ACTIVE' } }] })
  const run = await scenario({
    broker,
    requestLimit: 1,
    responses: [{ message: assistant(null, [toolCall('null-data', 'act', { actions: [{ name: 'ACTION1', data: null }] })]) }],
  })
  assert.equal(run.result.state, 'budget_exhausted')
  assert.equal(broker.calls.length, 0)
  const messages = await readFile(join(run.directory, 'messages.jsonl'), 'utf8')
  assert.match(messages, /must be an empty object for this action/)
  await rm(run.directory, { recursive: true, force: true })
})

test('request budget is a hard model-call limit', async () => {
  const broker = new FakeBroker({ inspectValues: [{ ok: true, value: { terminal: 'ACTIVE' } }] })
  const run = await scenario({
    broker,
    requestLimit: 1,
    responses: [{ message: assistant('not terminal') }, { message: assistant('must not run') }],
  })
  assert.equal(run.result.state, 'budget_exhausted')
  assert.equal(run.result.requests, 1)
  assert.equal(run.calls.length, 1)
  await rm(run.directory, { recursive: true, force: true })
})

test('unknown actions are not retried or sent to the broker', async () => {
  const broker = new FakeBroker({ inspectValues: [{ ok: true, value: { terminal: 'ACTIVE' } }] })
  const run = await scenario({
    broker,
    requestLimit: 1,
    responses: [{ message: assistant(null, [toolCall('unknown', 'act', { actions: [{ name: 'ACTION9', data: {} }] })]) }],
  })
  assert.equal(run.result.state, 'budget_exhausted')
  assert.equal(broker.calls.length, 0)
  await rm(run.directory, { recursive: true, force: true })
})

test('opaque replay state is supplied to the next decoded request', async () => {
  const broker = new FakeBroker({ inspectValues: [{ ok: true, value: { terminal: 'ACTIVE' } }, { ok: true, value: { terminal: 'ACTION_CAP' } }] })
  const first = assistant('first')
  const run = await scenario({
    broker,
    requestLimit: 2,
    responses: [
      { message: first, replayState: { response: { cursor: 'opaque-1' } } },
      { message: assistant('second'), replayState: { response: { cursor: 'opaque-2' } } },
    ],
  })
  assert.equal(run.result.state, 'completed')
  assert.equal(run.decodeCalls.length, 2)
  const registry = run.decodeCalls[1].options
  assert.equal(typeof registry.replayFor, 'function')
  assert.equal(run.decodeCalls[1].request.messages[2].content, 'first')
  await rm(run.directory, { recursive: true, force: true })
})
