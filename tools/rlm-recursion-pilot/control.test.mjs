import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { aggregateBudgetView, serializeDispatcher } from './control.mjs'

const RUNS = ['root-run', 'child-a', 'child-b', 'child-c']
const OPTIONS = Object.freeze({
  runIds: RUNS,
  priorCharged: 463,
  priorConfirmed: 456,
  priorUnknown: 7,
  globalCap: 522,
  maxNew: 56,
  perTreeLimit: 14,
})

const finished = [{ type: 'finish', reason: { kind: 'stop' } }]

async function withLedger(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'rlm-recursion-control-'))
  try {
    const ledger = await Ledger.open(join(directory, 'ledger.jsonl'), { total: 56, perRun: 14 })
    return await callback(ledger)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('serializeDispatcher drains concurrent root/child streams one at a time in FIFO order', async () => {
  const calls = []
  let active = 0
  let activeMax = 0
  const base = {
    async *call(id) {
      calls.push(id)
      active += 1
      activeMax = Math.max(activeMax, active)
      try {
        yield `${id}:one`
        await Promise.resolve()
        yield `${id}:two`
      } finally {
        active -= 1
      }
    },
    abort() {},
    abortAll() {},
  }
  const dispatcher = serializeDispatcher(base)
  const root = dispatcher.call('root', { branch: 'root' })
  const child = dispatcher.call('child', { branch: 'child' })
  const [rootValues, childValues] = await Promise.all([
    (async () => { const values = []; for await (const value of root) values.push(value); return values })(),
    (async () => { const values = []; for await (const value of child) values.push(value); return values })(),
  ])
  assert.deepEqual(rootValues, ['root:one', 'root:two'])
  assert.deepEqual(childValues, ['child:one', 'child:two'])
  assert.deepEqual(calls, ['root', 'child'])
  assert.equal(activeMax, 1)
})

test('queued abort never admits the base stream and active abortAll rejects queued/future work', async () => {
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const base = {
    async *call(id) {
      calls.push(id)
      yield `${id}:first`
      await gate
      yield `${id}:second`
    },
    abort(id) { calls.push(`abort:${id}`) },
    abortAll() { calls.push('abortAll'); release() },
  }
  const dispatcher = serializeDispatcher(base)
  const active = dispatcher.call('active', {})
  const queued = dispatcher.call('queued', {})
  const future = dispatcher.call('future', {})
  assert.deepEqual(await active.next(), { value: 'active:first', done: false })
  const queuedNext = queued.next()
  assert.equal(dispatcher.abort('queued'), true)
  await assert.rejects(queuedNext, /DISPATCH_ABORTED/)
  const activeNext = active.next()
  await dispatcher.abortAll()
  await assert.rejects(activeNext, /DISPATCH_ABORTED/)
  await assert.rejects(future.next(), /DISPATCH_ABORTED/)
  assert.deepEqual(calls, ['active', 'abortAll'])
  assert.equal(dispatcher.stopped, true)
})

test('a stream error releases the FIFO slot and preserves the primary error over cleanup', async () => {
  const calls = []
  const base = {
    call(id) {
      calls.push(id)
      let index = 0
      return {
        async next() {
          if (index++ === 0) return { value: id, done: false }
          throw new Error('primary-stream-error')
        },
        async return() { throw new Error('cleanup-error') },
        [Symbol.asyncIterator]() { return this },
      }
    },
    abort() {},
    abortAll() {},
  }
  const dispatcher = serializeDispatcher(base)
  const first = dispatcher.call('first', {})
  const second = dispatcher.call('second', {})
  assert.deepEqual(await first.next(), { value: 'first', done: false })
  await assert.rejects(first.next(), error => error?.message === 'primary-stream-error')
  assert.deepEqual(await second.next(), { value: 'second', done: false })
  await assert.rejects(second.next(), /primary-stream-error/)
  assert.deepEqual(calls, ['first', 'second'])
})

test('consumer return releases the active slot without retrying the returned stream', async () => {
  const calls = []
  const base = {
    async *call(id) {
      calls.push(id)
      yield `${id}:first`
      yield `${id}:unread`
    },
    abort() {},
    abortAll() {},
  }
  const dispatcher = serializeDispatcher(base)
  const first = dispatcher.call('first', {})
  const second = dispatcher.call('second', {})
  assert.deepEqual(await first.next(), { value: 'first:first', done: false })
  const secondNext = second.next()
  assert.deepEqual(await first.return(), { value: undefined, done: true })
  assert.deepEqual(await secondNext, { value: 'second:first', done: false })
  await second.return()
  assert.deepEqual(calls, ['first', 'second'])
})

test('aggregateBudgetView uses only fresh Ledger rows and enforces manifest/tree/global limits', async () => {
  await withLedger(async ledger => {
    const view = aggregateBudgetView(ledger, OPTIONS)
    for (const runId of RUNS) {
      for (let index = 0; index < 14; index += 1) {
        const id = await view.admit(runId, { runId, index })
        assert.equal(view.admitPhysical({ runId, logicalRequest: id, event: { runId, index } }) > 0, true)
        await view.settle(id, finished)
      }
    }
    const receipt = await view.receipt()
    assert.equal(receipt.admitted, 56)
    assert.equal(receipt.newAdmitted, 56)
    assert.equal(receipt.priorAdmitted, 0)
    assert.equal(receipt.physicalAdmitted, 56)
    assert.equal(receipt.cumulativeAdmitted, 519)
    assert.equal(receipt.cumulativeConfirmed, 512)
    assert.equal(receipt.cumulativeUnknown, 7)
    await assert.rejects(view.admit('not-in-manifest', {}), /EXPERIMENT_RUN_MANIFEST/)
    await assert.rejects(view.admit(RUNS[0], { overflow: 15 }), /EXPERIMENT_REQUEST_LIMIT/)
    assert.equal((await view.receipt()).physicalAdmitted, 56)
  })
})

test('aggregateBudgetView rejects a non-self-consistent historical summary', async () => {
  await withLedger(async ledger => {
    assert.throws(
      () => aggregateBudgetView(ledger, { ...OPTIONS, priorUnknown: 8 }),
      /priorCharged must equal priorConfirmed \+ priorUnknown/,
    )
    assert.throws(
      () => aggregateBudgetView(ledger, { ...OPTIONS, globalCap: 518 }),
      /priorCharged \+ maxNew exceeds globalCap/,
    )
  })
})
