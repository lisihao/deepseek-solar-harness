import assert from 'node:assert/strict'
import test from 'node:test'

import { validateResumeEvidence } from './resume.mjs'

const FINGERPRINT = 'manifest-fingerprint'
const RESULT_HASH = 'a'.repeat(64)
const CONDITION_IDS = ['01S0', '01S', '02S', '02S0']

function manifest() {
  return {
    fingerprint: FINGERPRINT,
    prior: { charged: 463, confirmed: 456, unknown: 7 },
    conditions: [
      { id: '01S0', arm: 'S0' },
      { id: '01S', arm: 'S' },
      { id: '02S', arm: 'S' },
      { id: '02S0', arm: 'S0' },
    ],
  }
}

function started(id = '01S0', { cleanupComplete = false, resultSha256 = RESULT_HASH } = {}) {
  return {
    condition: { id },
    started: true,
    start: { fingerprint: FINGERPRINT },
    result: { condition: { id }, cleanupComplete },
    resultSha256,
  }
}

function unstarted(id) {
  return { condition: { id }, started: false }
}

function evidence() {
  return {
    manifest: manifest(),
    receipt: {
      fingerprint: FINGERPRINT,
      closes: { provider: 'closed', relay: 'closed' },
    },
    conditions: [
      started(),
      unstarted('01S'),
      unstarted('02S'),
      unstarted('02S0'),
    ],
    closure: {
      kind: 'native-recursion-unstarted-closure-v1',
      fingerprint: FINGERPRINT,
      providerClosed: true,
      relayClosed: true,
      ownedProcessesAbsent: true,
      endpointsClosed: true,
      closedRuns: [{
        run: '01S0',
        unknownCalls: ['request-5'],
        cause: 'transport_closed',
        resultSha256: RESULT_HASH,
        shutdownConfirmed: true,
        workerExited: true,
      }],
    },
    ledgerReceipt: {
      admitted: 1,
      newAdmitted: 1,
      priorAdmitted: 0,
      rows: [
        { type: 'request-admitted', id: 'request-5', run: '01S0' },
        { type: 'request-settled', id: 'request-5', run: '01S0', state: 'unknown' },
      ],
    },
  }
}

function cloneEvidence() {
  return structuredClone(evidence())
}

function assertInvalid(value) {
  assert.throws(
    () => validateResumeEvidence(value),
    error => error instanceof Error && /^RLM_RESUME_/.test(error.message),
  )
}

test('returns exactly the three unstarted conditions after a closed first run', () => {
  const value = evidence()
  assert.deepEqual(
    validateResumeEvidence(value),
    ['01S', '02S', '02S0'],
  )
})

test('rejects a started-condition hole and a started condition without a result', () => {
  const hole = cloneEvidence()
  hole.conditions[2].started = true
  assertInvalid(hole)

  const missingResult = cloneEvidence()
  delete missingResult.conditions[0].result
  delete missingResult.conditions[0].resultSha256
  assertInvalid(missingResult)
})

test('rejects an unknown request without complete closed-run evidence', () => {
  const value = cloneEvidence()
  value.closure.closedRuns = []
  assertInvalid(value)
})

test('accepts an already recorded run closure without rewriting its unknown charge', () => {
  const value = cloneEvidence()
  value.closure.closedRuns = []
  value.ledgerReceipt.rows.push({ type: 'run-closed', run: '01S0' })
  assert.deepEqual(validateResumeEvidence(value), ['01S', '02S', '02S0'])
  assert.equal(value.manifest.prior.unknown, 7)
})

test('rejects any admitted request that has no settlement row', () => {
  const value = cloneEvidence()
  value.ledgerReceipt.admitted = 2
  value.ledgerReceipt.newAdmitted = 2
  value.ledgerReceipt.rows.push({ type: 'request-admitted', id: 'request-6', run: '01S0' })
  assertInvalid(value)
})

test('rejects a ledger receipt with missing admission counters', () => {
  for (const field of ['admitted', 'newAdmitted', 'priorAdmitted']) {
    const value = cloneEvidence()
    delete value.ledgerReceipt[field]
    assertInvalid(value)
  }
})

test('rejects an admission belonging to an unstarted condition even when settled', () => {
  const value = cloneEvidence()
  value.ledgerReceipt.admitted = 2
  value.ledgerReceipt.newAdmitted = 2
  value.ledgerReceipt.rows.push(
    { type: 'request-admitted', id: 'request-6', run: '01S' },
    { type: 'request-settled', id: 'request-6', run: '01S', state: 'settled' },
  )
  assertInvalid(value)
})

test('rejects receipts that exceed the new, per-run, or cumulative limits', () => {
  for (const [label, counts] of [
    ['new limit', { admitted: 57, newAdmitted: 57 }],
    ['per-run limit', { admitted: 15, newAdmitted: 15 }],
    ['cumulative limit', { admitted: 60, newAdmitted: 60 }],
  ]) {
    const value = cloneEvidence()
    Object.assign(value.ledgerReceipt, counts)
    assert.throws(
      () => validateResumeEvidence(value),
      error => error instanceof Error && /^RLM_RESUME_/.test(error.message),
      label,
    )
  }
})

test('requires all native processes and endpoints to be closed before resuming', () => {
  for (const field of ['ownedProcessesAbsent', 'endpointsClosed']) {
    const value = cloneEvidence()
    value.closure[field] = false
    assertInvalid(value)
  }
})

test('requires provider and relay closure in the run receipt', () => {
  for (const field of ['provider', 'relay']) {
    const value = cloneEvidence()
    value.receipt.closes[field] = 'open'
    assertInvalid(value)
  }
})

test('rejects mismatched fingerprints, condition ids, and result hashes', () => {
  const fingerprint = cloneEvidence()
  fingerprint.receipt.fingerprint = 'other-fingerprint'
  assertInvalid(fingerprint)

  const conditionId = cloneEvidence()
  conditionId.conditions[0].result.condition.id = '01S'
  assertInvalid(conditionId)

  const resultHash = cloneEvidence()
  resultHash.closure.closedRuns[0].resultSha256 = 'b'.repeat(64)
  assertInvalid(resultHash)
})

test('rejects result or admission material on an unstarted condition', () => {
  const result = cloneEvidence()
  result.conditions[1].result = { condition: { id: '01S' }, cleanupComplete: true }
  assertInvalid(result)

  const admission = cloneEvidence()
  admission.ledgerReceipt.admitted = 2
  admission.ledgerReceipt.newAdmitted = 2
  admission.ledgerReceipt.rows.push(
    { type: 'request-admitted', id: 'request-6', run: '01S' },
    { type: 'request-settled', id: 'request-6', run: '01S', state: 'settled' },
  )
  assertInvalid(admission)
})

test('keeps the manifest order and does not rewrite the historical unknown count', () => {
  const value = cloneEvidence()
  const result = validateResumeEvidence(value)
  assert.deepEqual(value.manifest.conditions.map(condition => condition.id), CONDITION_IDS)
  assert.equal(value.manifest.prior.unknown, 7)
  assert.deepEqual(result, ['01S', '02S', '02S0'])
})

import { assertNetworkEnvironment } from './resume.mjs'
test('process-local network bypass must match its accepted value',()=>{
  assert.doesNotThrow(()=>assertNetworkEnvironment(undefined,{}))
  assert.doesNotThrow(()=>assertNetworkEnvironment({NO_PROXY:'chatgpt.com'},{NO_PROXY:'chatgpt.com'}))
  assert.throws(()=>assertNetworkEnvironment({NO_PROXY:'chatgpt.com'},{}),/RLM_RESUME_NETWORK/)
  assert.throws(()=>assertNetworkEnvironment({NO_PROXY:'*'},{NO_PROXY:'*'}),/RLM_RESUME_NETWORK/)
})
