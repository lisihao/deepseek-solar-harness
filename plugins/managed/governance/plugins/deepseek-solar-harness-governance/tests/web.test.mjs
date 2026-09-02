import assert from 'node:assert/strict'
import test from 'node:test'
import { GovernanceService } from '../lib/service.js'
import { createGovernanceTraceHandler, GOVERNANCE_TRACE_PATH } from '../lib/web.js'

function response() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body ?? null },
  }
}

function context(session, persistence) {
  return {
    sessions: {
      get(id) { return id === session?.id ? session : undefined },
    },
    get(name) { return name === 'sessionPersistence' ? persistence : undefined },
  }
}

test('trace HTTP projection returns one live session without mutating it', async () => {
  const events = [{
    type: 'governance/work-opened',
    data: { workId: 'work-1', project: '/tmp/project', openedAt: '2026-08-15T00:00:00.000Z' },
  }]
  const session = { id: 'session-1', events }
  const ctx = context(session)
  const governance = new GovernanceService(ctx, {})
  const handler = createGovernanceTraceHandler(ctx, governance)
  const res = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-1` }, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(events.length, 1)
  const body = JSON.parse(res.body)
  assert.equal(body.sessionId, 'session-1')
  assert.equal(body.source, 'live')
  assert.equal(body.phase, 'open')
  assert.equal(body.events[0].type, 'governance/work-opened')
})

test('trace HTTP projection includes exact safe main-model and subscription-subagent outputs from the same session', async () => {
  const session = { id: 'session-collaboration', events: [{
    type: 'physical-operator/routing-decision', seq: 3, time: Date.parse('2026-08-21T01:00:00.000Z'),
    data: { policy: 'auto', route: 'resident', reason: 'bounded implementation', operatorId: 'codex' },
  }, {
    type: 'physical-operator/dispatch', seq: 4, time: Date.parse('2026-08-21T01:00:01.000Z'),
    data: { commandId: 'resident-1', operatorId: 'codex' },
  }, {
    type: 'assistant/message', seq: 5, time: Date.parse('2026-08-21T01:00:02.000Z'),
    data: { message: { source: { provider: 'dsh-physical-operator', model: 'codex' }, content: [
      { type: 'reasoning', text: 'private reasoning must stay hidden' },
      { type: 'text', text: 'bounded final result' },
    ] } },
  }, {
    type: 'physical-operator/tool-call', seq: 6, time: Date.parse('2026-08-21T01:00:02.100Z'),
    data: { commandId: 'native-tool-1', tool: 'read', arguments: { path: '/workspace/README.md' } },
  }, {
    type: 'physical-operator/tool-result', seq: 7, time: Date.parse('2026-08-21T01:00:02.200Z'),
    data: { commandId: 'native-tool-1', tool: 'read', result: {
      isError: false, content: [{ type: 'text', text: 'exact DSH tool output' }],
    } },
  }, {
    type: 'tool/call', seq: 8, time: Date.parse('2026-08-21T01:00:02.300Z'),
    data: { callId: 'child-1', name: 'subagent_claude_code', arguments: '{"prompt":"review"}' },
  }, {
    type: 'tool/result', seq: 9, time: Date.parse('2026-08-21T01:00:02.400Z'),
    data: { message: { source: { callId: 'child-1' }, content: [{
      type: 'tool-result', isError: false, content: [{ type: 'text', text: 'exact Claude child output' }],
    }] } },
  }, {
    type: 'orchestration/admission', seq: 10, time: Date.parse('2026-08-21T01:00:03.000Z'),
    data: { policy: 'auto', route: 'taskgraph', runId: 'run-1', maxParallel: 2 },
  }, {
    type: 'physical-operator/progress', seq: 11, time: Date.parse('2026-08-21T01:00:03.100Z'),
    data: { commandId: 'resident-1', operatorId: 'codex', data: {
      commandId: 'resident-1', kind: 'public-output', preview: 'safe native progress', prompt: 'must not project',
    } },
  }, {
    type: 'physical-operator/progress', seq: 12, time: Date.parse('2026-08-21T01:00:03.200Z'),
    data: { commandId: 'resident-1', operatorId: 'codex', data: {
      commandId: 'resident-1', kind: 'tool-started', toolName: 'Bash', arguments: { secret: 'must not project' },
    } },
  }, {
    type: 'physical-operator/trace-degraded', seq: 13, time: Date.parse('2026-08-21T01:00:03.300Z'),
    data: { commandId: 'resident-1', operatorId: 'codex', code: 'PROGRESS_UNAVAILABLE', message: 'stream detached' },
  }] }
  const ctx = context(session)
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, {}))
  const res = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=${session.id}` }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.sessionId, session.id)
  assert.equal(body.collaboration.totalEvents, 11)
  assert.equal(body.collaboration.events[2].type, 'physical-operator/output')
  assert.equal(body.collaboration.events[2].output, 'bounded final result')
  assert.equal(body.collaboration.events[2].outputPreview, 'bounded final result')
  assert.equal(body.collaboration.events[4].output, 'exact DSH tool output')
  assert.equal(body.collaboration.events[6].type, 'subagent/output')
  assert.equal(body.collaboration.events[6].operatorId, 'claude-code')
  assert.equal(body.collaboration.events[6].output, 'exact Claude child output')
  assert.doesNotMatch(JSON.stringify(body.collaboration), /private reasoning/u)
  assert.equal(body.collaboration.events[7].runId, 'run-1')
  assert.deepEqual(body.collaboration.events[8], {
    sequence: 11, type: 'physical-operator/observation', timestamp: '2026-08-21T01:00:03.100Z',
    commandId: 'resident-1', operatorId: 'codex', kind: 'public-output', output: 'safe native progress', outputPreview: 'safe native progress', outputTruncated: false,
  })
  assert.deepEqual(body.collaboration.events[9], {
    sequence: 12, type: 'physical-operator/observation', timestamp: '2026-08-21T01:00:03.200Z',
    commandId: 'resident-1', operatorId: 'codex', kind: 'tool-started', tool: 'Bash',
  })
  assert.equal(body.collaboration.events[10].type, 'physical-operator/trace-degraded')
  assert.doesNotMatch(JSON.stringify(body.collaboration), /must not project/u)
})

test('trace HTTP projection rejects missing and unknown sessions', async () => {
  const ctx = context(undefined, { inspect: async () => { throw new Error('session not found') } })
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, {}))
  const missing = response()
  await handler({ method: 'GET', url: GOVERNANCE_TRACE_PATH }, missing)
  assert.equal(missing.status, 400)
  assert.equal(JSON.parse(missing.body).error.code, 'SESSION_REQUIRED')

  const unknown = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=missing` }, unknown)
  assert.equal(unknown.status, 404)
  assert.equal(JSON.parse(unknown.body).error.code, 'SESSION_NOT_FOUND')
})

test('trace HTTP projection reads persisted sessions without publishing them live', async () => {
  const events = [{
    type: 'governance/work-opened',
    data: { workId: 'work-cold', project: '/tmp/project', openedAt: '2026-08-15T00:00:00.000Z' },
  }]
  const ctx = context(undefined, {
    async inspect(id) {
      assert.equal(id, 'session-cold')
      return { meta: { id }, events }
    },
  })
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, {}))
  const res = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-cold` }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.source, 'persistence')
  assert.equal(body.phase, 'open')
  assert.equal(ctx.sessions.get('session-cold'), undefined)
})

test('trace HTTP projection reads legacy unmarked governance events from a raw artifact', async () => {
  const sessionId = 'session-legacy'
  const persistence = {
    supportsRawArtifacts: true,
    async inspect() {
      throw new Error(`session "${sessionId}" contains event type "governance/work-opened" (seq 9) unknown to this harness and not marked ignorable`)
    },
    async readRaw(id) {
      assert.equal(id, sessionId)
      return {
        meta: { id },
        filename: 'session.jsonl',
        content: [
          JSON.stringify({ type: 'session', version: 0, id }),
          JSON.stringify({ type: 'turn/start', seq: 8, time: 1, data: { turn: 1 } }),
          JSON.stringify({
            type: 'governance/work-opened',
            seq: 9,
            time: 2,
            data: { workId: 'work-legacy', project: '/tmp/project', openedAt: '2026-08-15T00:00:00.000Z' },
          }),
        ].join('\n'),
      }
    },
  }
  const ctx = context(undefined, persistence)
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, {}))
  const res = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=${sessionId}` }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.source, 'raw-persistence')
  assert.equal(body.phase, 'open')
  assert.equal(body.events[0].sequence, 9)
})

test('trace HTTP projection does not bypass refusals for other unknown event types', async () => {
  let rawReads = 0
  const persistence = {
    supportsRawArtifacts: true,
    async inspect() {
      throw new Error('event type "other/required" unknown to this harness and not marked ignorable')
    },
    async readRaw() { rawReads += 1 },
  }
  const ctx = context(undefined, persistence)
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, {}))
  const res = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-other` }, res)
  assert.equal(res.status, 500)
  assert.equal(JSON.parse(res.body).error.code, 'SESSION_INSPECTION_FAILED')
  assert.equal(rawReads, 0)
})

test('trace HTTP projection bounds limits and supports HEAD', async () => {
  const session = { id: 'session-1', events: [] }
  const ctx = context(session)
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, { maxTraceEvents: 2 }))
  const invalid = response()
  await handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-1&limit=3` }, invalid)
  assert.equal(invalid.status, 400)
  assert.equal(JSON.parse(invalid.body).error.code, 'INVALID_LIMIT')

  const head = response()
  await handler({ method: 'HEAD', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-1` }, head)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
})
