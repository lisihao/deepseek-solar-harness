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
    header: { cwd: '/tmp/project' },
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
