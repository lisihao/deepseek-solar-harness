import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from './ledger.mjs'

const TOTAL = 522
const PER_RUN = 32
const PRIOR = 138
const CONTINUATION = 'Direct authorization retains the three historical unknown requests as charged and permits only the new fixed panel.'

function priorCalls() {
  return Array.from({ length: PRIOR }, (_unused, index) => ({
    id: `request-${index + 1}`,
    run: `historical-${Math.floor(index / 12) + 1}`,
    state: index < 135 ? 'settled' : 'unknown',
  }))
}

function finishedChunks() {
  return [{ type: 'finish', reason: { kind: 'stop' } }]
}

async function withLedger(name, callback) {
  const directory = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await callback(join(directory, 'ledger.jsonl'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('preserves 138 historical charges, including 135 settled and 3 unknown, under the 522 cap', async () => {
  await withLedger('arc-ledger-history', async path => {
    const ledger = await Ledger.open(path, {
      total: TOTAL,
      perRun: PER_RUN,
      priorCalls: priorCalls(),
      continuationAuthorization: CONTINUATION,
    })
    const receipt = await ledger.receipt()
    assert.equal(receipt.admitted, 138)
    assert.equal(receipt.priorAdmitted, 138)
    assert.equal(receipt.newAdmitted, 0)
    assert.equal(receipt.settled, 135)
    assert.equal(receipt.unknown, 3)
    assert.equal(receipt.physicalAdmitted, 138)
    assert.equal(receipt.priorPhysical, 138)
    assert.equal(receipt.stopped, false)

    const id = await ledger.admit('new-condition', { keyless: true })
    assert.equal(id, 'request-139')
    assert.equal(ledger.admitPhysical({ runId: 'new-condition', logicalRequest: id, event: { keyless: true } }), 139)
    await ledger.settle(id, finishedChunks())
    assert.equal((await ledger.receipt()).admitted, 139)
  })
})

test('enforces 32 physical requests in one tree before a second physical admission can escape the cap', async () => {
  await withLedger('arc-ledger-physical', async path => {
    const ledger = await Ledger.open(path, {
      total: TOTAL,
      perRun: PER_RUN,
      priorCalls: priorCalls(),
      continuationAuthorization: CONTINUATION,
    })
    const ids = []
    for (let index = 0; index < PER_RUN; index += 1) {
      const id = await ledger.admit('one-tree', { index })
      ids.push(id)
      ledger.admitPhysical({ runId: 'one-tree', logicalRequest: id, event: { index } })
      // Keep the 32nd logical request admitted so the duplicate physical
      // attempt is correlated; a settled request would correctly fail earlier
      // as uncorrelated and would not exercise the physical-cap branch.
      if (index < PER_RUN - 1) await ledger.settle(id, finishedChunks())
    }
    assert.equal(ids.length, 32)
    assert.throws(
      () => ledger.admitPhysical({ runId: 'one-tree', logicalRequest: ids.at(-1), event: { duplicate: true } }),
      /PHYSICAL_REQUEST_LIMIT/,
    )
    await ledger.settle(ids.at(-1), finishedChunks())
    const receipt = await ledger.receipt()
    assert.equal(receipt.physicalAdmitted, PRIOR + PER_RUN)
  })
})

test('enforces all 384 newly authorized logical and physical slots across 12 frozen trees', async () => {
  await withLedger('arc-ledger-total', async path => {
    const ledger = await Ledger.open(path, {
      total: TOTAL,
      perRun: PER_RUN,
      priorCalls: priorCalls(),
      continuationAuthorization: CONTINUATION,
    })
    for (let tree = 0; tree < 12; tree += 1) {
      const run = `frozen-${tree + 1}`
      for (let request = 0; request < PER_RUN; request += 1) {
        const id = await ledger.admit(run, { tree, request })
        ledger.admitPhysical({ runId: run, logicalRequest: id, event: { tree, request } })
        await ledger.settle(id, finishedChunks())
      }
    }
    const receipt = await ledger.receipt()
    assert.equal(receipt.newAdmitted, 384)
    assert.equal(receipt.admitted, TOTAL)
    assert.equal(receipt.physicalAdmitted, TOTAL)
    await assert.rejects(ledger.admit('overflow', { forbidden: true }), /EXPERIMENT_REQUEST_LIMIT/)
  })
})

test('a newly unknown request remains charged and cannot be replayed without an explicit closed-run receipt', async () => {
  await withLedger('arc-ledger-unknown', async path => {
    const ledger = await Ledger.open(path, {
      total: TOTAL,
      perRun: PER_RUN,
      priorCalls: priorCalls(),
      continuationAuthorization: CONTINUATION,
    })
    const id = await ledger.admit('unknown-tree', { synthetic: 'first-and-only' })
    ledger.admitPhysical({ runId: 'unknown-tree', logicalRequest: id, event: { synthetic: true } })
    await ledger.settle(id, [], new Error('synthetic transport interruption'))
    let receipt = await ledger.receipt()
    assert.equal(receipt.unknown, 4)
    assert.equal(receipt.stopped, true)
    await assert.rejects(ledger.admit('unknown-tree', { synthetic: 'replay' }), /EXPERIMENT_STOPPED/)

    ledger.acknowledgeClosedRun({
      run: 'unknown-tree',
      unknownCalls: [id],
      cause: 'http503_closed',
      evidenceHash: { algorithm: 'sha256', digest: 'a'.repeat(64) },
    })
    receipt = await ledger.receipt()
    assert.equal(receipt.closedRuns.includes('unknown-tree'), true)
    assert.equal(receipt.stopped, false)
    const later = await ledger.admit('different-tree', { synthetic: 'later' })
    assert.equal(later, 'request-140')
  })
})
