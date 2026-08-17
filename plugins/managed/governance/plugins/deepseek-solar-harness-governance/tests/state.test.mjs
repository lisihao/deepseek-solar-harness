import assert from 'node:assert/strict'
import test from 'node:test'
import { applyGovernanceEvent, emptyGovernanceState, foldGovernance } from '../lib/state.js'

const work = {
  type: 'governance/work-opened',
  data: { workId: 'w1', project: '/tmp/project', openedAt: '2026-08-14T00:00:00.000Z' },
}

function event(type, data) {
  return { type, data }
}

test('full evidence sequence is the only path to accepted', () => {
  const events = [
    work,
    event('governance/plan-recorded', {
      workId: 'w1', level: 'full', scope: 'auto', gates: ['test'],
      changedFilesSha256: 'paths', recordedAt: '2026-08-14T00:00:01.000Z',
    }),
    event('governance/run-started', {
      workId: 'w1', runId: 'r1', level: 'full', scope: 'auto', startedAt: '2026-08-14T00:00:02.000Z',
    }),
    event('governance/gate-finished', {
      workId: 'w1', runId: 'r1', gateId: 'test', status: 'ok', returncode: 0,
      durationSeconds: 1, outputSha256: 'output', finishedAt: '2026-08-14T00:00:03.000Z',
    }),
    event('governance/attestation-issued', {
      workId: 'w1', runId: 'r1', level: 'full', gitHead: 'abc', profileSha256: 'profile',
      changeFingerprint: 'tree', attestationSha256: 'attestation', reportPath: '/tmp/report',
      issuedAt: '2026-08-14T00:00:04.000Z',
    }),
    event('governance/completion-requested', {
      workId: 'w1', requestedAt: '2026-08-14T00:00:05.000Z',
    }),
    event('governance/completion-accepted', {
      workId: 'w1', runId: 'r1', gitHead: 'abc', attestationSha256: 'attestation',
      acceptedAt: '2026-08-14T00:00:06.000Z',
    }),
  ]
  const state = foldGovernance(events)
  assert.equal(state.phase, 'accepted')
  assert.equal(state.attestation.gitHead, 'abc')
})

test('agent cannot append accepted without a candidate and request', () => {
  const opened = applyGovernanceEvent(emptyGovernanceState(), work)
  assert.throws(() => applyGovernanceEvent(opened, event('governance/completion-accepted', {
    workId: 'w1', runId: 'forged', gitHead: 'abc', attestationSha256: 'forged',
    acceptedAt: '2026-08-14T00:00:01.000Z',
  })), /requires a requested candidate/)
})

test('failed gate cannot issue an attestation', () => {
  const state = foldGovernance([
    work,
    event('governance/run-started', {
      workId: 'w1', runId: 'r1', level: 'full', scope: 'auto', startedAt: '2026-08-14T00:00:01.000Z',
    }),
    event('governance/gate-finished', {
      workId: 'w1', runId: 'r1', gateId: 'test', status: 'error', returncode: 1,
      durationSeconds: 1, outputSha256: 'output', finishedAt: '2026-08-14T00:00:02.000Z',
    }),
  ])
  assert.throws(() => applyGovernanceEvent(state, event('governance/attestation-issued', {
    workId: 'w1', runId: 'r1', level: 'full', gitHead: 'abc', profileSha256: 'profile',
    changeFingerprint: 'tree', attestationSha256: 'attestation', reportPath: '/tmp/report',
    issuedAt: '2026-08-14T00:00:03.000Z',
  })), /requires at least one successful gate/)
})

test('milestone decision is validated without changing certification phase', () => {
  const opened = applyGovernanceEvent(emptyGovernanceState(), work)
  const evaluated = applyGovernanceEvent(opened, event('governance/milestone-evaluated', {
    workId: 'w1',
    kind: 'delivery',
    decision: 'denied',
    toolName: 'bash',
    commandSha256: 'command',
    phase: 'open',
    reasonCode: 'missing-acceptance',
    message: 'delivery requires accepted evidence',
    evaluatedAt: '2026-08-14T00:00:02.000Z',
  }))
  assert.equal(evaluated.phase, 'open')
  assert.throws(() => applyGovernanceEvent(opened, event('governance/milestone-evaluated', {
    workId: 'w1',
    kind: 'delivery',
    decision: 'forged',
    toolName: 'bash',
    commandSha256: 'command',
    phase: 'open',
    reasonCode: 'missing-acceptance',
    message: 'delivery requires accepted evidence',
    evaluatedAt: '2026-08-14T00:00:02.000Z',
  })), /decision must be allowed or denied/)
})

test('accepted work cannot be downgraded without opening new work', () => {
  const accepted = foldGovernance([
    work,
    event('governance/run-started', {
      workId: 'w1', runId: 'r1', level: 'full', scope: 'auto', startedAt: '2026-08-14T00:00:01.000Z',
    }),
    event('governance/gate-finished', {
      workId: 'w1', runId: 'r1', gateId: 'test', status: 'ok', returncode: 0,
      durationSeconds: 1, outputSha256: 'output', finishedAt: '2026-08-14T00:00:02.000Z',
    }),
    event('governance/attestation-issued', {
      workId: 'w1', runId: 'r1', level: 'full', gitHead: 'abc', profileSha256: 'profile',
      changeFingerprint: 'tree', attestationSha256: 'attestation', reportPath: '/tmp/report',
      issuedAt: '2026-08-14T00:00:03.000Z',
    }),
    event('governance/completion-requested', {
      workId: 'w1', requestedAt: '2026-08-14T00:00:04.000Z',
    }),
    event('governance/completion-accepted', {
      workId: 'w1', runId: 'r1', gitHead: 'abc', attestationSha256: 'attestation',
      acceptedAt: '2026-08-14T00:00:05.000Z',
    }),
  ])
  assert.throws(() => applyGovernanceEvent(accepted, event('governance/completion-rejected', {
    workId: 'w1', reasonCode: 'forged', message: 'downgrade', terminal: false,
    rejectedAt: '2026-08-14T00:00:06.000Z',
  })), /cannot follow phase accepted/)
})
