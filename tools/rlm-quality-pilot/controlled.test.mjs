import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { CONTROL_LIMITS, CONTROL_POLICY, controlledBudget, parseArgs, prepareControlled } from './controlled.mjs'

const prefix = { admitted: 600, confirmed: 586, unknown: 14 }
const conditions = ['D1', 'R32', 'S32', 'S0_32'].map(id => ({ id }))
const finish = [{ type: 'finish', reason: { kind: 'stop' } }]
const hash = data => createHash('sha256').update(data).digest('hex')
async function temporary(fn) {
  const path = await mkdtemp(join(tmpdir(), 'quality-control-test-'))
  try { await fn(path) } finally { await rm(path, { recursive: true, force: true }) }
}
async function budgetAt(path) {
  return controlledBudget(await Ledger.open(join(path, 'ledger.jsonl'), { total: 97, perRun: 32 }), conditions, prefix)
}

test('D1 admits its first physical request after logical admission, then refuses a second', async () => temporary(async path => {
  const budget = await budgetAt(path)
  assert.throws(() => budget.admitPhysical({ runId: 'D1', logicalRequest: 'absent' }), /CONTROL_PHYSICAL_CORRELATION/)
  const id = await budget.admit('D1', { synthetic: true })
  assert.equal(budget.admitPhysical({ runId: 'D1', logicalRequest: id, event: { synthetic: true } }), 1)
  await budget.settle(id, finish, null)
  await assert.rejects(() => budget.admit('D1', {}), /CONTROL_ARM_LIMIT/)
  assert.throws(() => budget.admitPhysical({ runId: 'D1', logicalRequest: id }), /CONTROL_PHYSICAL_CORRELATION/)
  const receipt = await budget.receipt()
  assert.equal(receipt.physicalAdmitted, 1)
  assert.equal(receipt.cumulativeAdmitted, 601)
}))

test('all three native trees admit exactly 32 logical and physical requests, including the last', async () => temporary(async path => {
  const budget = await budgetAt(path)
  for (const [runId, maximum] of [['D1', 1], ['R32', 32], ['S32', 32], ['S0_32', 32]]) {
    for (let index = 0; index < maximum; index += 1) {
      const id = await budget.admit(runId, { index, synthetic: true })
      budget.admitPhysical({ runId, logicalRequest: id, event: { synthetic: true } })
      await budget.settle(id, finish, null)
    }
    await assert.rejects(() => budget.admit(runId, {}), /CONTROL_ARM_LIMIT/)
  }
  await assert.rejects(() => budget.admit('unexpected-arm', {}), /CONTROL_ARM/)
  const receipt = await budget.receipt()
  assert.equal(receipt.newAdmitted, 97)
  assert.equal(receipt.physicalAdmitted, 97)
  assert.equal(receipt.cumulativeAdmitted, 697)
  assert.equal(receipt.cumulativeConfirmed, 683)
  assert.equal(receipt.cumulativeUnknown, 14)
}))

test('unknown requests remain charged and stop subsequent conditions', async () => temporary(async path => {
  const budget = await budgetAt(path)
  const id = await budget.admit('D1', {})
  budget.admitPhysical({ runId: 'D1', logicalRequest: id })
  await budget.settle(id, [], 'synthetic transport failure')
  assert.equal(budget.stopped, true)
  await assert.rejects(() => budget.admit('R32', {}), /EXPERIMENT_STOPPED/)
  const receipt = await budget.receipt()
  assert.equal(receipt.cumulativeAdmitted, 601)
  assert.equal(receipt.cumulativeConfirmed, 586)
  assert.equal(receipt.cumulativeUnknown, 15)
}))

test('fixed limits and common policy preserve no-tool fallback and native turn-boundary guidance', () => {
  assert.equal(CONTROL_LIMITS.cumulativeCap, 700)
  assert.equal(CONTROL_LIMITS.newMaximum, 97)
  assert.match(CONTROL_POLICY, /Otherwise return the final Answer text directly/)
  assert.match(CONTROL_POLICY, /end the parent assistant turn/)
  assert.match(CONTROL_POLICY, /at most two children/)
  assert.doesNotMatch(CONTROL_POLICY, /Answer:\s*\d+|private-reference-value/)
})

test('CLI refuses mixed/repeated modes and missing provider arguments', () => {
  assert.deepEqual(parseArgs(['--accept', '--output', '/tmp/example']), { mode: 'accept', output: '/tmp/example' })
  for (const argv of [[], ['--run', '--output', '/tmp/example'], ['--accept', '--prepare', '--output', '/tmp/example'], ['--accept', '--output', '/tmp/example', '--task', '/tmp/task'], ['--accept', '--output', '/tmp/example', '--output', '/tmp/other']]) {
    assert.throws(() => parseArgs(argv), /CONTROL_ARGS/)
  }
})

test('preparation rejects a substituted task before compilation or provider access', async () => temporary(async path => {
  const prior = join(path, 'final-receipt.json')
  const verification = join(path, 'parent-private', 'independent-verification.json')
  const authorization = join(path, 'authorization.json')
  const taskPath = join(path, 'task.json')
  await mkdir(join(path, 'parent-private'))
  await writeFile(prior, JSON.stringify({ formatVersion: 1, kind: 'quality-recovery-final-receipt-v1', accounting: { cumulativeAdmitted: 600, cumulativeConfirmed: 586, cumulativeUnknown: 14, newAdmitted: 11, settled: 11, unknown: 0, physicalAdmitted: 11 }, error: null, outcome: { cleanupComplete: true }, closes: { provider: 'closed', relay: 'closed', networkProfile: 'closed', longReadProfile: 'closed' } }))
  await writeFile(verification, JSON.stringify({ formatVersion: 1, kind: 'quality-recovery-independent-verification-v1', ledger: { admitted: 11, physical: 11, settled: 11, unknown: 0, inflight: 0 }, accounting: { cumulativeAdmitted: 600, cumulativeConfirmed: 586, cumulativeUnknown: 14, cap: 600 }, closure: { ownedProcesses: [], ipcDeleted: false, sockets: [{ connectResult: 61, payloadSent: false }] } }))
  await writeFile(authorization, JSON.stringify({ formatVersion: 1, kind: 'human-request-budget-authorization-v1', userText: '再给增加100次预算', previousCap: 600, additionalMaximum: 100, cumulativeCap: 700, model: 'openai-codex/gpt-6.1-sol', reasoningEffort: 'high', noPaidApiFallback: true, noCreditPurchase: true, closedPrefix: prefix, prefixReceiptSha256: hash(await readFile(prior)), independentVerificationSha256: hash(await readFile(verification)), currentPlan: { D: 1, R: 32, S: 32, S0: 32, newMaximum: 97, cumulativeMaximum: 697 }, allPriorOutcomesRetained: true }))
  await writeFile(taskPath, '{}')
  let compilerCalls = 0
  await assert.rejects(() => prepareControlled({ output: join(path, 'output'), tmpRoot: join(path, 'runtime'), prior, authorization, taskPath, taskLoader: async () => ({ formatVersion: 1, kind: 'paper-oolong-task-v1', id: 'oolong-trec-32k-15000243', answerType: 'ANSWER_TYPE.NUMERIC', context: 'synthetic replacement', question: 'synthetic question' }), compiler: async () => { compilerCalls += 1; throw new Error('compiler must not run') } }), /CONTROL_TASK/)
  assert.equal(compilerCalls, 0)
}))
