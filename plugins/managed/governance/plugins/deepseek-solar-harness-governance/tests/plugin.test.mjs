import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function withGitProject(callback, { profile = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-governance-project-'))
  const cleanup = () => { rmSync(root, { recursive: true, force: true }) }
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    if (profile) {
      mkdirSync(join(root, '.agent-governance'))
      writeFileSync(join(root, '.agent-governance', 'profile.json'), '{}\n')
    }
    const result = callback(root)
    if (result !== null && typeof result === 'object' && typeof result.finally === 'function') {
      return result.finally(cleanup)
    }
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

function openedAgent(cwd, events = []) {
  return {
    session: {
      header: { cwd },
      events,
      append(type, data, options) { events.push({ type, data, ...options }) },
    },
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

test('git sessions without a project governance profile stay unmanaged', () => {
  withGitProject(root => {
    const governance = new GovernanceService(fakeContext(), {})
    const agent = openedAgent(root)

    assert.equal(governance.applies(agent), false)
    assert.equal(governance.ensureWork(agent).phase, 'unmanaged')
    assert.deepEqual(agent.session.events, [])
  }, { profile: false })
})

test('governance anchors a nested session to its nearest git root', () => {
  withGitProject(root => {
    const nested = join(root, 'packages', 'example')
    mkdirSync(nested, { recursive: true })
    const governance = new GovernanceService(fakeContext(), {})
    const agent = openedAgent(nested)

    governance.ensureWork(agent)

    assert.equal(agent.session.events[0].data.project, root)
  })
})

test('failed governance audit is durable in the trace', async () => {
  await withGitProject(async root => {
    const governance = new GovernanceService(fakeContext(), {})
    const agent = openedAgent(root)
    governance.audit = async () => ({ ok: false, code: 2, outputSha256: 'audit-output', payload: null })

    await assert.rejects(governance.plan(agent, { level: 'full' }), /audit failed with exit 2/u)

    const rejection = agent.session.events.at(-1)
    assert.equal(rejection.type, 'governance/completion-rejected')
    assert.equal(rejection.data.reasonCode, 'audit-failed')
    assert.match(rejection.data.message, /exit 2/u)
    assert.equal(governance.traceSession(agent.session).events.at(-1).reasonCode, 'audit-failed')
  })
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

test('a mutation-classified command without evidence does not invent invalidation', () => {
  withGitProject(root => {
    const governance = new GovernanceService(fakeContext(), {})
    const events = [
      {
        type: 'governance/work-opened',
        data: { workId: 'w1', project: root, openedAt: '2026-08-15T00:00:00.000Z' },
      },
      {
        type: 'governance/completion-rejected',
        data: {
          workId: 'w1', reasonCode: 'unverified-stop', message: 'not verified', terminal: false,
          rejectedAt: '2026-08-15T00:00:01.000Z',
        },
      },
    ]
    const agent = openedAgent(root, events)

    governance.markMutation(agent, 'bash')

    assert.equal(events.length, 2)
    assert.equal(governance.state(agent).phase, 'rejected')
  })
})

test('a mutation-classified command keeps matching candidate evidence', () => {
  withGitProject(root => {
    const governance = new GovernanceService(fakeContext(), {})
    const events = [
      {
        type: 'governance/work-opened',
        data: { workId: 'w1', project: root, openedAt: '2026-08-15T00:00:00.000Z' },
      },
      {
        type: 'governance/run-started',
        data: {
          workId: 'w1', runId: 'r1', level: 'full', scope: 'auto',
          startedAt: '2026-08-15T00:00:01.000Z',
        },
      },
      {
        type: 'governance/gate-finished',
        data: {
          workId: 'w1', runId: 'r1', gateId: 'test', status: 'ok', returncode: 0,
          durationSeconds: 1, outputSha256: 'output', finishedAt: '2026-08-15T00:00:02.000Z',
        },
      },
      {
        type: 'governance/attestation-issued',
        data: {
          workId: 'w1', runId: 'r1', level: 'full', gitHead: 'abc', profileSha256: 'profile',
          changeFingerprint: 'tree', attestationSha256: 'attestation', reportPath: '/tmp/report',
          issuedAt: '2026-08-15T00:00:03.000Z',
        },
      },
    ]
    const agent = openedAgent(root, events)
    governance.freshness = () => ({ ok: true, timedOut: false })

    governance.markMutation(agent, 'bash')

    assert.equal(events.length, 4)
    assert.equal(governance.state(agent).phase, 'candidate')
  })
})

test('a mutation-classified command invalidates confirmed stale candidate evidence', () => {
  withGitProject(root => {
    const governance = new GovernanceService(fakeContext(), {})
    const events = [
      {
        type: 'governance/work-opened',
        data: { workId: 'w1', project: root, openedAt: '2026-08-15T00:00:00.000Z' },
      },
      {
        type: 'governance/run-started',
        data: {
          workId: 'w1', runId: 'r1', level: 'full', scope: 'auto',
          startedAt: '2026-08-15T00:00:01.000Z',
        },
      },
      {
        type: 'governance/gate-finished',
        data: {
          workId: 'w1', runId: 'r1', gateId: 'test', status: 'ok', returncode: 0,
          durationSeconds: 1, outputSha256: 'output', finishedAt: '2026-08-15T00:00:02.000Z',
        },
      },
      {
        type: 'governance/attestation-issued',
        data: {
          workId: 'w1', runId: 'r1', level: 'full', gitHead: 'abc', profileSha256: 'profile',
          changeFingerprint: 'tree', attestationSha256: 'attestation', reportPath: '/tmp/report',
          issuedAt: '2026-08-15T00:00:03.000Z',
        },
      },
    ]
    const agent = openedAgent(root, events)
    governance.freshness = () => ({ ok: false, timedOut: false })

    governance.markMutation(agent, 'apply_patch')

    assert.equal(events.length, 5)
    assert.equal(events.at(-1).type, 'governance/invalidated')
    assert.equal(events.at(-1).data.reasonCode, 'tool-mutation')
    assert.equal(governance.state(agent).phase, 'invalidated')
  })
})

test('completion without any attestation reports missing evidence, not stale evidence', async () => {
  await withGitProject(async root => {
    const governance = new GovernanceService(fakeContext(), {})
    const events = [
      {
        type: 'governance/work-opened',
        data: { workId: 'w1', project: root, openedAt: '2026-08-15T00:00:00.000Z' },
      },
      {
        type: 'governance/completion-rejected',
        data: {
          workId: 'w1', reasonCode: 'unverified-stop', message: 'not verified', terminal: false,
          rejectedAt: '2026-08-15T00:00:01.000Z',
        },
      },
      {
        type: 'governance/invalidated',
        data: {
          workId: 'w1', reasonCode: 'tool-mutation', message: 'legacy invalidation',
          invalidatedAt: '2026-08-15T00:00:02.000Z',
        },
      },
    ]
    const agent = openedAgent(root, events)

    await governance.requestCompletion(agent)

    assert.equal(events.at(-1).data.reasonCode, 'missing-full-attestation')
  })
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
