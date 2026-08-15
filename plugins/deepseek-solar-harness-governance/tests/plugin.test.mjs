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

test('plugin registers one service, four tools, guard, and lifecycle policies', () => {
  const ctx = fakeContext()
  apply(ctx, {})
  assert.ok(ctx._provided.get('governance') instanceof GovernanceService)
  assert.deepEqual(ctx._tools.map(tool => tool.name), [
    'governance_status', 'governance_plan', 'governance_verify', 'governance_submit_completion',
  ])
  assert.equal(ctx._guards.length, 1)
  assert.ok(ctx._listeners.has('agent/pre-step'))
  assert.ok(ctx._listeners.has('agent/turn-stopping'))
  assert.ok(ctx._listeners.has('tools/result'))
  const submit = ctx._tools.find(tool => tool.name === 'governance_submit_completion')
  assert.deepEqual(submit.parameters.properties, {})
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
