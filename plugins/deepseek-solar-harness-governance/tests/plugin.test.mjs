import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../index.js'
import { GovernanceService, resolveConfig } from '../lib/service.js'

function fakeContext() {
  const tools = []
  const listeners = new Map()
  const guards = []
  const provided = new Map()
  return {
    tools: {
      register(definition) { tools.push(definition); return () => {} },
      guard(callback) { guards.push(callback); return () => {} },
    },
    sessions: { flush: async () => true },
    provide(key, value) { provided.set(key, value); return () => {} },
    inject() { return () => {} },
    on(name, callback) { listeners.set(name, callback); return () => {} },
    _tools: tools,
    _guards: guards,
    _provided: provided,
    _listeners: listeners,
  }
}

test('plugin registers one service, five tools, guard, and lifecycle policies', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.ok(ctx._provided.get('governance') instanceof GovernanceService)
  assert.deepEqual(ctx._tools.map(tool => tool.name), [
    'governance_status', 'governance_plan', 'governance_verify', 'governance_submit_completion',
    'governance_trace',
  ])
  assert.equal(ctx._guards.length, 1)
  assert.ok(ctx._listeners.has('agent/pre-step'))
  assert.ok(ctx._listeners.has('agent/turn-stopping'))
  assert.ok(ctx._listeners.has('tools/result'))
  const submit = ctx._tools.find(tool => tool.name === 'governance_submit_completion')
  assert.deepEqual(submit.parameters.properties, {})
})

test('denied delivery is durable and visible through governance trace', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const events = []
  const session = {
    header: { cwd: process.cwd() },
    events,
    append(type, data) {
      events.push({ type, data })
    },
  }
  const agent = { session }
  const governance = ctx._provided.get('governance')
  const denial = governance.guardExecution({
    name: 'bash',
    arguments: { command: 'git push origin main' },
    agent,
  })
  assert.match(denial, /require governance accepted status/)

  const traceTool = ctx._tools.find(tool => tool.name === 'governance_trace')
  const trace = await traceTool.execute({ limit: 10 }, { agent })
  assert.equal(trace.phase, 'open')
  assert.deepEqual(trace.events.map(event => event.type), [
    'governance/work-opened',
    'governance/milestone-evaluated',
  ])
  assert.equal(trace.events[1].decision, 'denied')
  assert.equal(trace.events[1].reasonCode, 'missing-acceptance')
  assert.equal(trace.events[1].kind, 'delivery')
  assert.match(traceTool.output.render({}, trace)[0].text, /decision=denied/)
})

test('governance events are append-marked safe for a core reader without this plugin', () => {
  const calls = []
  const session = {
    header: { cwd: process.cwd() },
    events: [],
    append(...args) {
      calls.push(args)
      const [type, data, options] = args
      session.events.push({ type, data, ...options })
    },
  }

  new GovernanceService(fakeContext(), {}).ensureWork({ session })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][2], { ignorable: true })
  assert.equal(session.events[0].ignorable, true)
})

test('completion continuation is a complete identified user message', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const events = []
  const steered = []
  const session = {
    header: { cwd: process.cwd() },
    events,
    append(type, data, options) {
      events.push({ type, data, ...options })
    },
  }
  const agent = { session, steer(message) { steered.push(message) } }
  const governance = ctx._provided.get('governance')
  governance.ensureWork(agent)

  await ctx._listeners.get('agent/turn-stopping')({ agent })

  assert.equal(steered.length, 1)
  assert.match(steered[0].id, /^[0-9a-f-]{36}$/u)
  assert.equal(steered[0].role, 'user')
  assert.equal(steered[0].source.kind, 'plugin')
  assert.equal(steered[0].source.plugin, 'code-harness-governance')
  assert.match(steered[0].content[0].text, /rejected completion/u)
  assert.equal(Object.isFrozen(steered[0]), true)
  assert.equal(Object.isFrozen(steered[0].content), true)
})

test('non-git sessions stay unmanaged and stop without governance continuation', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const events = []
  const steered = []
  const agent = {
    session: {
      header: { cwd: '/tmp/dsh-governance-non-git-session' },
      events,
      append(type, data, options) { events.push({ type, data, ...options }) },
    },
    steer(message) { steered.push(message) },
  }
  let nextCalls = 0
  const decision = await ctx._listeners.get('agent/pre-step')({
    agent,
    messages: [{ source: { kind: 'user' } }],
    signal: new AbortController().signal,
  }, async () => {
    nextCalls += 1
    return { kind: 'enter', messages: [] }
  })
  await ctx._listeners.get('agent/turn-stopping')({ agent })

  assert.equal(decision.kind, 'enter')
  assert.equal(nextCalls, 1)
  assert.deepEqual(events, [])
  assert.deepEqual(steered, [])
})

test('governance stays lazy until a successful mutation in a git worktree', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const events = []
  const agent = {
    session: {
      header: { cwd: process.cwd() },
      events,
      append(type, data, options) { events.push({ type, data, ...options }) },
    },
  }

  assert.equal(ctx._provided.get('governance').state(agent).phase, 'unmanaged')
  ctx._listeners.get('tools/result')({ name: 'apply_patch', arguments: {}, agent }, { isError: false })

  assert.deepEqual(events.map(event => event.type), ['governance/work-opened'])
  assert.equal(events[0].ignorable, true)
})

test('milestone classification separates commit from delivery', () => {
  const service = new GovernanceService(fakeContext(), {})
  assert.equal(service.classifyExecution({ name: 'bash', arguments: { command: 'git commit -m x' } }), 'commit')
  assert.equal(service.classifyExecution({ name: 'bash', arguments: { command: 'git push origin main' } }), 'delivery')
  assert.equal(service.classifyExecution({ name: 'apply_patch', arguments: {} }), 'mutation')
  assert.equal(service.classifyExecution({ name: 'bash', arguments: { command: 'git status' } }), 'other')
})

test('configuration rejects unknown keys and invalid regexes', () => {
  assert.throws(() => resolveConfig({ unexpected: true }), /unknown governance config/)
  assert.throws(() => resolveConfig({ deliveryCommandPatterns: ['['] }), /Invalid regular expression/)
})
