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

function context(session) {
  return {
    sessions: {
      get(id) { return id === session?.id ? session : undefined },
    },
  }
}

test('trace HTTP projection returns one live session without mutating it', () => {
  const events = [{
    type: 'governance/work-opened',
    data: { workId: 'work-1', project: '/tmp/project', openedAt: '2026-08-15T00:00:00.000Z' },
  }]
  const session = { id: 'session-1', events }
  const ctx = context(session)
  const governance = new GovernanceService(ctx, {})
  const handler = createGovernanceTraceHandler(ctx, governance)
  const res = response()
  handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-1` }, res)
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(events.length, 1)
  const body = JSON.parse(res.body)
  assert.equal(body.sessionId, 'session-1')
  assert.equal(body.phase, 'open')
  assert.equal(body.events[0].type, 'governance/work-opened')
})

test('trace HTTP projection rejects missing and unknown sessions', () => {
  const ctx = context(undefined)
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, {}))
  const missing = response()
  handler({ method: 'GET', url: GOVERNANCE_TRACE_PATH }, missing)
  assert.equal(missing.status, 400)
  assert.equal(JSON.parse(missing.body).error.code, 'SESSION_REQUIRED')

  const unknown = response()
  handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=missing` }, unknown)
  assert.equal(unknown.status, 404)
  assert.equal(JSON.parse(unknown.body).error.code, 'SESSION_NOT_FOUND')
})

test('trace HTTP projection bounds limits and supports HEAD', () => {
  const session = { id: 'session-1', events: [] }
  const ctx = context(session)
  const handler = createGovernanceTraceHandler(ctx, new GovernanceService(ctx, { maxTraceEvents: 2 }))
  const invalid = response()
  handler({ method: 'GET', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-1&limit=3` }, invalid)
  assert.equal(invalid.status, 400)
  assert.equal(JSON.parse(invalid.body).error.code, 'INVALID_LIMIT')

  const head = response()
  handler({ method: 'HEAD', url: `${GOVERNANCE_TRACE_PATH}?sessionId=session-1` }, head)
  assert.equal(head.status, 200)
  assert.equal(head.body, null)
})
