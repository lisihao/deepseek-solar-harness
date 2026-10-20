import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { Ledger } from './ledger.mjs'
import {
  analyzePilot,
  assertFixedModelOptions,
  assertPanelNotStarted,
  assertRunnerOnlyContinuation,
  conditionEvidence,
  createModelDispatcher,
  EXECUTION_FILES,
  loadPlan,
  nextContinuationPaths,
  parseArgs,
  summarizeConditionResources,
  validateClosureBeforeMarker,
  verifyPriorRun,
} from './run.mjs'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const PLAN = join(ROOT, 'docs/testing/prime-rlm-arc-pilot-plan.json')
const TOTAL = 522
const PER_RUN = 32
const PRIOR = 138

function priorCalls() {
  return Array.from({ length: PRIOR }, (_unused, index) => ({
    id: `request-${index + 1}`,
    run: `historical-${Math.floor(index / 12) + 1}`,
    state: index < 135 ? 'settled' : 'unknown',
  }))
}

function conditions() {
  const values = []
  for (const gameId of ['game-a', 'game-b', 'game-c', 'game-d']) {
    for (const arm of ['B', 'R', 'S']) {
      values.push({ id: `${gameId}-${arm}`, arm, gameId, orderKey: `${gameId}-${arm}` })
    }
  }
  return values
}

async function withPrivateOutput(name, callback) {
  const base = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(base, `${name}-`))
  try {
    return await callback(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

function fixedOptions(signal) {
  return {
    provider: 'openai-codex',
    model: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    maxTokens: 16384,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'synthetic only' }] }],
    ...(signal === undefined ? {} : { signal }),
  }
}

function terminalChunk() {
  return { type: 'finish', reason: { kind: 'stop' } }
}

async function withDispatcher(name, streamFactory, callback) {
  await withPrivateOutput(name, async directory => {
    const ledger = await Ledger.open(join(directory, 'ledger.jsonl'), { total: 32, perRun: 32 })
    let physicalAdmission
    const calls = []
    const provider = {
      setPhysicalAdmission(callback) { physicalAdmission = callback },
      adapter: {
        async prepareCall(providerName, model, signal) {
          calls.push({ providerName, model, signal })
          return { stream: async options => streamFactory({ options, signal, physical: event => physicalAdmission(event) }) }
        },
      },
    }
    const relay = { restoreOptions: async options => ({ ...options, restored: true }) }
    const dispatcher = createModelDispatcher({
      condition: { id: 'condition-1', arm: 'S', gameId: 'synthetic-game', directory },
      provider,
      relay,
      ledger,
    })
    await callback({ dispatcher, ledger, calls })
  })
}

test('reads the currently approved fixed four-case B/R/S plan without loading a provider', async () => {
  const loaded = await loadPlan(PLAN)
  assert.equal(loaded.plan.cases.length, 4)
  assert.deepEqual(Object.keys(loaded.plan.arms).sort(), ['B', 'R', 'S'])
  assert.deepEqual(loaded.plan.model, {
    provider: 'openai-codex',
    id: 'gpt-6.1-sol',
    reasoningEffort: 'high',
    maxOutputTokens: 16384,
  })
  assert.equal(loaded.plan.commonLimits.physicalModelRequestsPerTree, 32)
  assert.equal(loaded.plan.budget.previousCharged, 138)
  assert.equal(loaded.plan.budget.proposedNewPanelMaximum, 384)
  assert.equal(loaded.plan.budget.currentlyAuthorizedCumulativeCap, 522)
  assert.match(loaded.hash, /^[a-f0-9]{64}$/)
})

test('does not accept provider or credential flags in prepare, keyless, or analysis modes', () => {
  assert.throws(
    () => parseArgs(['--keyless', '--output', '/private/tmp/rac-test', '--provider-module', '/private/tmp/provider.mjs']),
    /provider and credential options are valid only with --run/,
  )
  assert.throws(
    () => parseArgs(['--run', '--output', '/private/tmp/rac-test']),
    /requires the provider module\/hash\/package, credential file, and acceptance artifact\/hash/,
  )
  const parsed = parseArgs(['--analyze', '--output', '/private/tmp/rac-test'])
  assert.equal(parsed.mode, 'analyze')
  assert.equal(parsed.output, '/private/tmp/rac-test')
  assert.equal(parsed.providerModule, undefined)
  assert.equal(parsed.credentialFile, undefined)
})

test('analysis retains an independent WIN while separately marking incomplete execution and cleanup', async () => {
  await withPrivateOutput('arc-run-analysis', async output => {
    const ledgerPath = join(output, 'provider-ledger.jsonl')
    await Ledger.open(ledgerPath, {
      total: TOTAL,
      perRun: PER_RUN,
      priorCalls: priorCalls(),
      continuationAuthorization: 'Synthetic analysis continuation authorization.',
    })
    const allConditions = conditions()
    const manifest = {
      formatVersion: 1,
      kind: 'prime-rlm-arc-pilot-prepared',
      fingerprint: 'f'.repeat(64),
      ledger: { path: ledgerPath },
      conditions: allConditions,
    }
    await writeFile(join(output, 'arc-pilot-manifest.json'), `${JSON.stringify(manifest)}\n`, { mode: 0o600 })
    const resultDirectory = join(output, 'results')
    await mkdir(resultDirectory, { recursive: true, mode: 0o700 })
    const first = allConditions[0]
    await writeFile(join(resultDirectory, `${first.id}.json`), `${JSON.stringify({
      formatVersion: 1,
      condition: first,
      grade: { win: 1, denominator: 1, terminal: 'WIN', levelsCompleted: 2, actionsTaken: 17, completed: true, budgetFailure: false, unknown: false, errorPresent: false, stopReason: null },
      executionCompleted: false,
      cleanupComplete: false,
    })}\n`, { mode: 0o600 })

    const report = await analyzePilot({ output })
    assert.equal(report.results.length, 12)
    assert.equal(report.metrics.byArm.B.win, 1)
    assert.equal(report.metrics.byArm.B.denominator, 4)
    const recorded = report.results.find(result => result.condition.id === first.id)
    assert.equal(recorded.grade.terminal, 'WIN')
    assert.equal(recorded.executionCompleted, false)
    assert.equal(recorded.cleanupComplete, false)
    assert.equal(report.results.filter(result => result.status === 'not-run').length, 11)
    const markdown = await readFile(join(output, 'analysis.md'), 'utf8')
    assert.match(markdown, /game-a \| B \| WIN \| 1/)
    assert.match(markdown, /general efficacy/)
  })
})

test('model dispatcher accepts exactly one fully observed fixed-route physical call', async () => {
  await withDispatcher('arc-dispatcher-once', async function* ({ physical }) {
    physical({ type: 'synthetic-post' })
    yield terminalChunk()
  }, async ({ dispatcher, ledger, calls }) => {
    assert.doesNotThrow(() => assertFixedModelOptions(fixedOptions()))
    const chunks = []
    for await (const chunk of dispatcher.call('model-1', fixedOptions())) chunks.push(chunk)
    assert.deepEqual(chunks, [terminalChunk()])
    assert.equal(calls.length, 1)
    assert.equal(calls[0].providerName, 'openai-codex')
    assert.equal(calls[0].model, 'gpt-6.1-sol')
    const receipt = await ledger.receipt()
    assert.equal(receipt.admitted, 1)
    assert.equal(receipt.physicalAdmitted, 1)
    assert.equal(receipt.settled, 1)
    assert.equal(receipt.unknown, 0)
  })
})

test('model dispatcher rejects a second provider physical admission for one logical request', async () => {
  await withDispatcher('arc-dispatcher-retry', async function* ({ physical }) {
    physical({ ordinal: 1 })
    physical({ ordinal: 2 })
    yield terminalChunk()
  }, async ({ dispatcher, ledger }) => {
    await assert.rejects((async () => {
      for await (const _chunk of dispatcher.call('model-retry', fixedOptions())) {}
    })(), /ARC_PROVIDER_RETRY/)
    const receipt = await ledger.receipt()
    assert.equal(receipt.admitted, 1)
    assert.equal(receipt.physicalAdmitted, 1)
    assert.equal(receipt.unknown, 1)
    assert.equal(receipt.stopped, true)
  })
})

test('model dispatcher rejects a concurrent second logical call while the first stream is active', async () => {
  let releaseFirst
  const firstMayFinish = new Promise(resolveRelease => { releaseFirst = resolveRelease })
  await withDispatcher('arc-dispatcher-concurrent', async function* ({ physical }) {
    physical({ ordinal: 1 })
    await firstMayFinish
    yield terminalChunk()
  }, async ({ dispatcher, ledger }) => {
    const first = dispatcher.call('model-first', fixedOptions())
    const firstNext = first.next()
    await new Promise(resolveTick => setImmediate(resolveTick))
    await assert.rejects((async () => {
      const second = dispatcher.call('model-second', fixedOptions())
      await second.next()
    })(), /ARC_CONCURRENT_MODEL/)
    releaseFirst()
    assert.deepEqual(await firstNext, { done: false, value: terminalChunk() })
    assert.deepEqual(await first.next(), { done: true, value: undefined })
    const receipt = await ledger.receipt()
    assert.equal(receipt.admitted, 1)
    assert.equal(receipt.settled, 1)
    assert.equal(receipt.unknown, 0)
  })
})

test('model dispatcher keeps early-returned and caller-aborted streams as charged unknowns', async () => {
  await withDispatcher('arc-dispatcher-return', async function* ({ physical, signal }) {
    physical({ ordinal: 1 })
    yield { type: 'text-delta', index: 0, text: 'partial' }
    if (signal.aborted) throw signal.reason
    await new Promise((resolveWait, rejectWait) => signal.addEventListener('abort', () => rejectWait(signal.reason), { once: true }))
    yield terminalChunk()
  }, async ({ dispatcher, ledger }) => {
    const iterator = dispatcher.call('model-return', fixedOptions())
    assert.deepEqual(await iterator.next(), { done: false, value: { type: 'text-delta', index: 0, text: 'partial' } })
    await iterator.return()
    let receipt = await ledger.receipt()
    assert.equal(receipt.unknown, 1)
    assert.equal(receipt.stopped, true)
  })

  await withDispatcher('arc-dispatcher-abort', async function* ({ physical, signal }) {
    physical({ ordinal: 1 })
    yield { type: 'text-delta', index: 0, text: 'partial' }
    if (signal.aborted) throw signal.reason
    await new Promise((resolveWait, rejectWait) => signal.addEventListener('abort', () => rejectWait(signal.reason), { once: true }))
    yield terminalChunk()
  }, async ({ dispatcher, ledger }) => {
    const controller = new AbortController()
    const iterator = dispatcher.call('model-abort', fixedOptions(controller.signal))
    await iterator.next()
    controller.abort(new Error('synthetic caller abort'))
    await assert.rejects(iterator.next(), /synthetic caller abort/)
    const receipt = await ledger.receipt()
    assert.equal(receipt.unknown, 1)
    assert.equal(receipt.stopped, true)
  })
})


test('resource summary preserves missing usage and charges an unknown stream', () => {
  const rows = [
    { type: 'request-admitted', id: 'request-139', run: 'S-case' },
    { type: 'physical-request-admitted', runId: 'S-case' },
    { type: 'request-settled', id: 'request-139', state: 'settled', usageKnown: true, usage: { inputTokens: 7 } },
    { type: 'request-admitted', id: 'request-140', run: 'S-case' },
    { type: 'physical-request-admitted', runId: 'S-case' },
    { type: 'request-settled', id: 'request-140', state: 'unknown', usageKnown: false, usage: null },
  ]
  const value = summarizeConditionResources({ rows }, 'S-case', 123)
  assert.equal(value.modelRequests, 2)
  assert.equal(value.physicalModelRequests, 2)
  assert.equal(value.unknownModelRequests, 1)
  assert.equal(value.requestsWithoutKnownUsage, 1)
  assert.deepEqual(value.knownUsageTotals, { inputTokens: 7, outputTokens: null, totalTokens: null })
  assert.equal(value.elapsedMs, 123)
})


test('worker exit aborts the in-flight parent stream and retains an unknown charge', async () => {
  let ready
  const dispatched = new Promise(resolveReady => { ready = resolveReady })
  await withDispatcher('arc-worker-exit', async function* ({ physical, signal }) {
    physical({ method: 'POST', url: 'synthetic' })
    ready()
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  }, async ({ dispatcher, ledger }) => {
    const iterator = dispatcher.call('exit-id', fixedOptions())
    const pending = iterator.next()
    await dispatched
    dispatcher.abortAll('worker exited')
    await assert.rejects(pending, /worker exited/)
    const receipt = await ledger.receipt()
    assert.equal(receipt.admitted, 1)
    assert.equal(receipt.unknown, 1)
    assert.equal(receipt.stopped, true)
  })
})

function fixtureCondition(directory, id = 'condition-1', arm = 'S', gameId = 'game-a') {
  return { id, arm, gameId, directory }
}

function fixtureManifest(conditions, fingerprint = 'f'.repeat(64)) {
  return { fingerprint, conditions }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha256(path) {
  return sha256(await readFile(path))
}

test('condition evidence rejects a started condition without its result', async () => {
  await withPrivateOutput('arc-evidence-started-only', async output => {
    const condition = fixtureCondition(join(output, 'condition-1'))
    await mkdir(condition.directory, { recursive: true, mode: 0o700 })
    const manifest = fixtureManifest([condition])
    await writeFile(join(condition.directory, 'real-condition-started.json'), JSON.stringify({
      formatVersion: 1,
      fingerprint: manifest.fingerprint,
      id: condition.id,
    }))

    await assert.rejects(
      () => conditionEvidence(output, manifest),
      /ARC_CONTINUATION_STARTED_STATE/,
    )
  })
})

test('prior-run verification rejects an accepted result after its bytes drift', async () => {
  await withPrivateOutput('arc-evidence-result-drift', async output => {
    const condition = fixtureCondition(join(output, 'condition-1'))
    await mkdir(join(output, 'results'), { recursive: true, mode: 0o700 })
    await mkdir(condition.directory, { recursive: true, mode: 0o700 })
    const manifest = fixtureManifest([condition])
    const resultPath = join(output, 'results', `${condition.id}.json`)
    const markerPath = join(condition.directory, 'real-condition-started.json')
    await writeFile(resultPath, JSON.stringify({ condition, cleanupComplete: true, grade: { win: 1 } }))
    await writeFile(markerPath, JSON.stringify({ formatVersion: 1, fingerprint: manifest.fingerprint, id: condition.id }))
    const receiptPath = join(output, 'run-receipt.json')
    const panelMarkerPath = join(output, 'real-run-started.json')
    await writeFile(receiptPath, JSON.stringify({
      kind: 'prime-rlm-arc-pilot-run',
      fingerprint: manifest.fingerprint,
      completedAt: '2026-10-20T00:00:00.000Z',
      results: [{ condition: { id: condition.id }, cleanupComplete: true }],
    }))
    await writeFile(panelMarkerPath, JSON.stringify({ formatVersion: 1, fingerprint: manifest.fingerprint }))

    const evidence = await conditionEvidence(output, manifest)
    const continuation = {
      previous: {
        runReceiptSha256: await fileSha256(receiptPath),
        panelStartMarkerSha256: await fileSha256(panelMarkerPath),
        resultSha256: evidence.resultSha256,
        startedMarkerSha256: evidence.startedMarkerSha256,
      },
    }
    await assert.doesNotReject(() => verifyPriorRun(output, manifest, continuation, evidence))

    await writeFile(resultPath, JSON.stringify({ condition, cleanupComplete: true, grade: { win: 0 }, drift: true }))
    const driftedEvidence = await conditionEvidence(output, manifest)
    await assert.rejects(
      () => verifyPriorRun(output, manifest, continuation, driftedEvidence),
      /ARC_CONTINUATION_IMMUTABLE/,
    )
  })
})

test('runner-only continuation allows run.mjs drift but rejects another execution file drift', () => {
  const runnerFile = EXECUTION_FILES.find(name => name === 'tools/rlm-arc-pilot/run.mjs')
  assert.ok(runnerFile)
  const oldRunnerHash = 'a'.repeat(64)
  const newRunnerHash = 'b'.repeat(64)
  const originalExecution = Object.fromEntries(EXECUTION_FILES.map(name => [name, oldRunnerHash]))
  const currentExecution = { ...originalExecution, [runnerFile]: newRunnerHash }
  const manifest = {
    fingerprint: 'c'.repeat(64),
    runner: { sha256: oldRunnerHash },
    execution: { files: originalExecution },
  }
  const continuation = {
    originalFingerprint: manifest.fingerprint,
    originalRunnerSha256: oldRunnerHash,
    currentRunnerSha256: newRunnerHash,
    currentExecutionHashes: currentExecution,
  }
  assert.doesNotThrow(() => assertRunnerOnlyContinuation(manifest, continuation, currentExecution, newRunnerHash))

  const otherFile = EXECUTION_FILES.find(name => name !== runnerFile)
  assert.ok(otherFile)
  const changedExecution = { ...currentExecution, [otherFile]: 'd'.repeat(64) }
  assert.throws(
    () => assertRunnerOnlyContinuation(
      manifest,
      { ...continuation, currentExecutionHashes: changedExecution },
      changedExecution,
      newRunnerHash,
    ),
    /ARC_CONTINUATION_EXECUTION/,
  )
})

test('closed unknown runs retain billing, reject new admissions, and leave only untouched conditions for continuation', async () => {
  await withPrivateOutput('arc-closure-accounting', async output => {
    const ledger = await Ledger.open(join(output, 'ledger.jsonl'), { total: 8, perRun: 4 })
    const request = await ledger.admit('closed-run', { synthetic: true })
    await ledger.settle(request, [], new Error('synthetic stream ended'))
    const closure = {
      run: 'closed-run',
      unknownCalls: [request],
      cause: 'native_budget_closed',
      evidenceHash: { algorithm: 'sha256', digest: 'e'.repeat(64) },
    }
    assert.equal(validateClosureBeforeMarker(ledger, closure), null)
    ledger.acknowledgeClosedRun(closure)
    const receipt = await ledger.receipt()
    assert.equal(receipt.admitted, 1)
    assert.equal(receipt.unknown, 1)
    assert.equal(receipt.stopped, false)
    assert.equal(validateClosureBeforeMarker(ledger, closure).run, 'closed-run')
    await assert.rejects(() => ledger.admit('closed-run', { synthetic: 'replay' }), /EXPERIMENT_CLOSED_RUN/)
  })

  await withPrivateOutput('arc-evidence-unstarted-selection', async output => {
    const untouched = fixtureCondition(join(output, 'condition-untouched'), 'condition-untouched', 'S', 'game-a')
    const completed = fixtureCondition(join(output, 'condition-completed'), 'condition-completed', 'R', 'game-b')
    const manifest = fixtureManifest([untouched, completed])
    await mkdir(join(output, 'results'), { recursive: true, mode: 0o700 })
    await mkdir(completed.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(output, 'results', `${completed.id}.json`), JSON.stringify({ condition: completed, cleanupComplete: true }))
    await writeFile(join(completed.directory, 'real-condition-started.json'), JSON.stringify({ fingerprint: manifest.fingerprint, id: completed.id }))
    const evidence = await conditionEvidence(output, manifest)
    assert.deepEqual(evidence.unstarted.map(condition => condition.id), [untouched.id])
    assert.deepEqual(evidence.recorded.map(entry => entry.condition.id), [completed.id])
  })
})

test('continuation paths advance from complete 01 to 02 and reject a marker without its receipt', async () => {
  await withPrivateOutput('arc-continuation-paths', async output => {
    const first = await nextContinuationPaths(output)
    assert.equal(first.number, 1)
    assert.match(first.markerPath, /resume-unstarted-started-01\.json$/)
    assert.match(first.receiptPath, /resume-unstarted-receipt-01\.json$/)
    await writeFile(first.markerPath, '{}')
    await writeFile(first.receiptPath, '{}')
    const second = await nextContinuationPaths(output)
    assert.equal(second.number, 2)
    assert.match(second.markerPath, /resume-unstarted-started-02\.json$/)
    assert.match(second.receiptPath, /resume-unstarted-receipt-02\.json$/)
  })

  await withPrivateOutput('arc-continuation-incomplete', async output => {
    const first = await nextContinuationPaths(output)
    await writeFile(first.markerPath, '{}')
    await assert.rejects(() => nextContinuationPaths(output), /ARC_CONTINUATION_IN_PROGRESS/)
  })
})

test('the original run gate allows a fresh panel and rejects a real-run-started replay marker', async () => {
  await withPrivateOutput('arc-run-replay-gate', async output => {
    await assertPanelNotStarted(output)
    await writeFile(join(output, 'real-run-started.json'), JSON.stringify({ formatVersion: 1 }))
    await assert.rejects(() => assertPanelNotStarted(output), /ARC_RUN_ALREADY_STARTED/)
  })
})

test('recorded baseline-drain and ledger repairs require an exact explicit hash supplement', () => {
  const old = 'a'.repeat(64), next = 'b'.repeat(64)
  const files = ['tools/rlm-arc-pilot/run.mjs', 'tools/rlm-arc-pilot/baseline.mjs', 'tools/rlm-arc-pilot/ledger.mjs']
  const original = Object.fromEntries(EXECUTION_FILES.map(name => [name, old]))
  const current = { ...original, ...Object.fromEntries(files.map(name => [name, next])) }
  const manifest = { fingerprint: 'c'.repeat(64), runner: { sha256: old }, execution: { files: original } }
  const continuation = { originalFingerprint: manifest.fingerprint, originalRunnerSha256: old, currentRunnerSha256: next, currentExecutionHashes: current, executionRepairFiles: files }
  assert.doesNotThrow(() => assertRunnerOnlyContinuation(manifest, continuation, current, next))
  assert.throws(() => assertRunnerOnlyContinuation(manifest, { ...continuation, executionRepairFiles: files.slice(0, 1) }, current, next), /ARC_CONTINUATION_EXECUTION/)
  const nativeFile = 'tools/rlm-arc-pilot/native-worker.mjs'
  const changedNative = { ...current, [nativeFile]: 'd'.repeat(64) }
  assert.throws(() => assertRunnerOnlyContinuation(manifest, { ...continuation, executionRepairFiles: [...files, nativeFile], currentExecutionHashes: changedNative }, changedNative, next), /ARC_CONTINUATION_EXECUTION/)
})
