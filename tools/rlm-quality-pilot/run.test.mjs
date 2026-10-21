import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { executeCondition } from '../rlm-recursion-pilot/run.mjs'
import {
  FIXED_LIMITS,
  NATIVE_PROOF_FILES,
  RUN_START_FILE,
  analyzePanel,
  executeDirectCondition,
  manifestFingerprint,
  preparePanel,
  qualityBudgetView,
  runPanel,
} from './run.mjs'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const BASE = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
let temporaryOrdinal = 0

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha(path) {
  return sha(await readFile(path))
}

function canonicalOutputHash(outputs) {
  return sha(`{${Object.keys(outputs).sort().map(name => `${JSON.stringify(name)}:{"bytes":${outputs[name].bytes},"sha256":${JSON.stringify(outputs[name].sha256)}}`).join(',')}}`)
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

async function createPriorRoot(base) {
  const root = join(base, 'prior')
  const phase = join(root, 'revalidation', 'no-reuse-v2')
  await mkdir(phase, { recursive: true, mode: 0o700 })
  const fingerprint = 'f'.repeat(64)
  await writeJson(join(phase, 'prepared.json'), { formatVersion: 1, kind: 'native-recursion-no-reuse-revalidation-v2', fingerprint })
  await writeJson(join(phase, 'run-receipt.json'), {
    formatVersion: 1,
    kind: 'native-recursion-no-reuse-revalidation-receipt-v2',
    fingerprint,
    closes: { provider: 'closed', relay: 'closed', networkProfile: 'disposed' },
    accounting: { newAdmitted: 25, physicalAdmitted: 25, cumulativeAdmitted: 506, cumulativeConfirmed: 495, cumulativeUnknown: 11, stopped: false },
  })
  await writeJson(join(phase, 'answer-error-analysis.json'), { formatVersion: 1, fixture: true })
  const ledger = await Ledger.open(join(phase, 'provider-ledger.jsonl'), { total: 28, perRun: 14 })
  for (let index = 0; index < 25; index += 1) {
    const run = index < 11 ? 'v2S0' : 'v2S'
    const id = await ledger.admit(run, { fixture: true })
    ledger.admitPhysical({ runId: run, logicalRequest: id, event: { fixture: true } })
    await ledger.settle(id, [{ type: 'finish', reason: { kind: 'stop' } }])
  }
  const closure = {
    formatVersion: 1,
    kind: 'native-recursion-final-closure-v1',
    fingerprint,
    ownedProcessesAbsent: true,
    endpointsClosed: true,
    providerClosed: true,
    relayClosed: true,
    networkProfileDisposed: true,
    accounting: { newAdmitted: 25, physicalAdmitted: 25, cumulativeAdmitted: 506, cumulativeConfirmed: 495, cumulativeUnknown: 11, stopped: false },
    manifest: { sha256: await fileSha(join(phase, 'prepared.json')) },
    receipt: { sha256: await fileSha(join(phase, 'run-receipt.json')) },
    ledger: { sha256: await fileSha(join(phase, 'provider-ledger.jsonl')) },
    errorAnalysis: { sha256: await fileSha(join(phase, 'answer-error-analysis.json')) },
  }
  const closurePath = join(phase, 'final-closure.json')
  await writeJson(closurePath, closure)
  return { root, closurePath, closureSha256: await fileSha(closurePath) }
}

async function withPrepared(name, operation) {
  const base = await mkdtemp(join(BASE, `bq-${name}-`))
  let tmpRoot
  try {
    const prior = await createPriorRoot(base)
    const taskPath = join(base, 'private-task.json')
    const scorerPath = join(base, 'official-score.py')
    await writeFile(taskPath, '{"private":true}\n', { mode: 0o600 })
    await writeFile(scorerPath, '# fixture scorer\n', { mode: 0o600 })
    const context = 'Full public context bytes.'
    const question = 'What is the numeric answer?'
    const task = {
      formatVersion: 1,
      kind: 'paper-oolong-task-v1',
      id: 'fixture-task',
      context,
      question,
      answerType: 'ANSWER_TYPE.NUMERIC',
      source: { repository: 'fixture-repository', revision: 'fixture-revision', rowId: 1 },
      privateGold: { answer: '[7]' },
      scorer: { path: scorerPath, sha256: await fileSha(scorerPath), commit: 'fixture' },
      inputFiles: { 'inputs/context.txt': context },
    }
    const taskLoader = async path => {
      assert.equal(path, taskPath)
      return structuredClone(task)
    }
    const output = join(prior.root, 'bare-quality-v1')
    // The native Prime socket path has a hard length boundary.  Keep this
    // test-only temporary root short just like the production /private/tmp/bq1.
    tmpRoot = join(BASE, `bq${process.pid}-${++temporaryOrdinal}`)
    const compiler = async ({ shared }) => {
      const compiled = join(shared, 'compiled')
      await mkdir(compiled, { recursive: true, mode: 0o700 })
      const wire = join(compiled, 'model-wire.mjs')
      const text = 'export async function* encodeChatStream(chunks, options) { for await (const _ of chunks) {} options.onFinish({ message: { content: "[7]" } }); yield "done" }\n'
      await writeFile(wire, text, { mode: 0o600 })
      const outputs = { 'model-wire.mjs': { bytes: Buffer.byteLength(text), sha256: sha(text) } }
      return { compiled, outputs, hash: canonicalOutputHash(outputs) }
    }
    const runtimePreparer = async ({ shared }) => {
      const runtimes = join(shared, 'runtimes')
      const manifestPath = join(shared, 'fixture-runtime-manifest.json')
      await mkdir(runtimes, { recursive: true, mode: 0o700 })
      await writeJson(manifestPath, { formatVersion: 1, fixture: true })
      return {
        paths: { python: '/usr/bin/python3', binary: '/fixture/prime', packageDir: '/fixture/package', fingerprint: 'fixture-runtime' },
        manifest: { path: manifestPath, sha256: await fileSha(manifestPath), primeCommit: 'fixture', archiveSha256: null },
        runtimes,
      }
    }
    const manifest = await preparePanel({
      output, tmpRoot, taskPath, priorRoot: prior.root, priorClosureSha256: prior.closureSha256,
      sourceRoot: ROOT, taskLoader, compiler, runtimePreparer,
    })
    await operation({ base, prior, output, tmpRoot, taskPath, scorerPath, task, taskLoader, manifest })
  } finally {
    await Promise.all([rm(base, { recursive: true, force: true }), tmpRoot ? rm(tmpRoot, { recursive: true, force: true }) : Promise.resolve()])
  }
}

async function acceptanceFor({ base, manifest }) {
  const sourceHashes = {}
  for (const name of NATIVE_PROOF_FILES) sourceHashes[name] = await fileSha(join(ROOT, name))
  const proofPath = join(base, 'native-proof.json')
  await writeJson(proofPath, {
    formatVersion: 1, accepted: true, realModelRequests: 0, sourceHashes,
    compiledHash: manifest.shared.compiled.hash,
    runtimeManifestSha256: manifest.shared.runtime.manifest.sha256,
  })
  const acceptancePath = join(base, 'acceptance.json')
  await writeJson(acceptancePath, {
    formatVersion: 1,
    kind: 'bare-quality-acceptance-v1',
    manifestFingerprint: manifest.fingerprint,
    runnerSha256: manifest.runner.sha256,
    nativeProofSha256: await fileSha(proofPath),
    accepted: true,
  })
  return { acceptancePath, acceptanceSha256: await fileSha(acceptancePath), proofPath }
}

test('quality budget keeps the accepted 506 = 495 + 11 prefix and preserves an unknown stop', async () => {
  const root = await mkdtemp(join(BASE, 'bq-budget-'))
  try {
    const base = await Ledger.open(join(root, 'ledger.jsonl'), { total: 15, perRun: 14 })
    const view = qualityBudgetView(base, [{ id: 'D1' }, { id: 'S14' }])
    const d = await view.admit('D1', { fixture: true })
    view.admitPhysical({ runId: 'D1', logicalRequest: d, event: { fixture: true } })
    await view.settle(d, [], new Error('fixture transport loss'))
    const receipt = await view.receipt()
    assert.equal(receipt.cumulativeAdmitted, 507)
    assert.equal(receipt.cumulativeConfirmed, 495)
    assert.equal(receipt.cumulativeUnknown, 12)
    assert.equal(receipt.stopped, true)
    await assert.rejects(() => view.admit('S14', { fixture: true }), /EXPERIMENT_STOPPED/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('D1 sends exactly one full public user message, drains EOF, and never supplies tools', async () => {
  const root = await mkdtemp(join(BASE, 'bq-direct-'))
  try {
    const ledgerBase = await Ledger.open(join(root, 'ledger.jsonl'), { total: 15, perRun: 14 })
    const ledger = qualityBudgetView(ledgerBase, [{ id: 'D1' }, { id: 'S14' }])
    let physicalAdmission
    let receivedOptions
    let eof = false
    const provider = {
      setPhysicalAdmission(callback) { physicalAdmission = callback },
      adapter: {
        async prepareCall() {
          return {
            async *stream(options) {
              receivedOptions = options
              physicalAdmission({ fixture: true })
              yield { type: 'text-delta', index: 0, text: 'Answer: ' }
              yield { type: 'finish', reason: { kind: 'stop' } }
              eof = true
            },
          }
        },
      },
    }
    const condition = { id: 'D1', arm: 'D', taskId: 'fixture-task', gameId: 'fixture-task', directory: root, publicPrompt: 'context bytes\nquestion bytes' }
    const outcome = await executeDirectCondition({
      manifest: { shared: { compiled: { path: root } } }, condition, provider,
      relay: { restoreOptions: async value => value }, ledger,
      modelWireLoader: async () => ({
        async *encodeChatStream(chunks, { onFinish }) {
          const observed = []
          for await (const chunk of chunks) observed.push(chunk)
          assert.equal(eof, true, 'the provider iterator must reach EOF before wire assembly')
          assert.equal(observed.at(-1).type, 'finish')
          onFinish({ message: { content: 'Answer: [7]' } })
          yield 'data: [DONE]\n\n'
        },
      }),
    })
    assert.equal(outcome.executionCompleted, true)
    assert.equal(outcome.answerText, 'Answer: [7]')
    assert.equal(receivedOptions.messages.length, 1)
    assert.deepEqual(receivedOptions.messages, [{ role: 'user', content: 'context bytes\nquestion bytes' }])
    assert.equal(Object.hasOwn(receivedOptions, 'tools'), false)
    assert.equal(receivedOptions.messages.some(message => message.role === 'system'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('S14 projects only public context/question into the existing native worker start config', async () => {
  await withPrepared('native-projection', async ({ manifest, task }) => {
    const base = await Ledger.open(manifest.ledger.path, { total: 15, perRun: 14 })
    const ledger = qualityBudgetView(base, manifest.conditions)
    const condition = manifest.conditions.find(value => value.id === 'S14')
    let physicalAdmission
    let capturedStart
    const provider = {
      modelInfo: { name: 'fixture', context: { contextWindow: 128000 }, inputModalities: ['text'] },
      setPhysicalAdmission(callback) { physicalAdmission = callback },
      adapter: { async prepareCall() { return { async *stream() { physicalAdmission({ fixture: true }); yield { type: 'finish', reason: { kind: 'stop' } } } } } },
    }
    const publicTask = { id: task.id, inputFiles: { 'inputs/context.txt': task.context }, instruction: task.question }
    const outcome = await executeCondition({
      manifest, condition, provider, ledger, relay: { restoreOptions: async value => value }, task: publicTask,
      grade: () => ({ schemaValid: true, errors: [] }),
      reservePort: async () => ({ port: 14001, releaseIpv4: async () => {}, close: async () => {} }),
      sandboxBuilder: () => '(version 1)',
      spawnWorker: async ({ config }) => {
        capturedStart = config.start
        await writeFile(join(condition.workspace, 'answer.json'), '{"answer":"[7]"}', { mode: 0o600 })
        return { result: { state: 'completed', nativeDepth: 1, actualDepth: 1, physicalCleanup: true }, exit: { code: 0, signal: null }, stdout: '', stderr: '', error: null }
      },
    })
    assert.equal(outcome.executionCompleted, true)
    const serialized = JSON.stringify(capturedStart)
    assert.equal(serialized.includes('privateGold'), false)
    assert.equal(serialized.includes(task.scorer.path), false)
    assert.equal(serialized.includes('fixture-repository'), false)
    assert.equal(capturedStart.task.includes(task.question), true)
    assert.equal(capturedStart.task.includes(task.context), false)
  })
})

test('source and replay gates reject before any provider loader can run', async () => {
  await withPrepared('preflight', async ({ base, output, manifest, taskLoader }) => {
    const acceptance = await acceptanceFor({ base, manifest })
    let loaded = false
    const common = {
      output, taskLoader, providerModule: '/private/tmp/provider.mjs', providerSha256: 'a'.repeat(64), providerPackage: 'fixture-provider', credentialFile: '/private/tmp/credential.json',
      acceptanceArtifact: acceptance.acceptancePath, acceptanceSha256: acceptance.acceptanceSha256, nativeProof: acceptance.proofPath,
      providerLoader: async () => { loaded = true; throw new Error('must not load') }, runtimeAssert: () => {},
    }
    const preparedPath = join(output, 'prepared.json')
    const altered = JSON.parse(await readFile(preparedPath, 'utf8'))
    altered.sourceHead = '0'.repeat(40)
    altered.fingerprint = manifestFingerprint(altered)
    await writeFile(preparedPath, `${JSON.stringify(altered, null, 2)}\n`, { mode: 0o600 })
    await assert.rejects(() => runPanel(common), /BQ_FINGERPRINT_SOURCE_HEAD/)
    assert.equal(loaded, false)

    altered.sourceHead = manifest.sourceHead
    altered.fingerprint = manifestFingerprint(altered)
    await writeFile(preparedPath, `${JSON.stringify(altered, null, 2)}\n`, { mode: 0o600 })
    await writeJson(join(output, RUN_START_FILE), { formatVersion: 1 })
    await assert.rejects(() => runPanel(common), /BQ_RUN_ALREADY_STARTED/)
    assert.equal(loaded, false)
  })
})

test('run retains a failed S14 output and analysis keeps the missing/failed condition facts', async () => {
  await withPrepared('failed-condition', async ({ base, output, manifest, task, taskLoader }) => {
    const acceptance = await acceptanceFor({ base, manifest })
    const seenAnswers = []
    const receipt = await runPanel({
      output, taskLoader,
      providerModule: '/private/tmp/provider.mjs', providerSha256: 'b'.repeat(64), providerPackage: 'fixture-provider', credentialFile: '/private/tmp/credential.json',
      acceptanceArtifact: acceptance.acceptancePath, acceptanceSha256: acceptance.acceptanceSha256, nativeProof: acceptance.proofPath,
      runtimeAssert: () => {},
      networkProfileInstaller: ({ baseFetch }) => ({ fetch: baseFetch, dispose() {} }),
      relayFactory: async () => ({ store: {}, close: async () => {} }),
      providerLoader: async () => ({ close: async () => {} }),
      taskGrader: async (_task, answer) => {
        seenAnswers.push(answer)
        return { score: 1, primaryScore: 1, exact: true, attemptedParse: answer, parseConfidence: 'high', scorerSha256: task.scorer.sha256 }
      },
      directExecutor: async () => ({
        answer: { present: true, sha256: 'd'.repeat(64), error: null }, answerText: 'Answer: [7]',
        resources: { modelRequests: 1, physicalModelRequests: 1, confirmedModelRequests: 1, unknownModelRequests: 0, knownUsageTotals: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
        observed: { childModelRequestCount: 0, rootModelRequestCount: 1, recursionObserved: false }, executionCompleted: true, cleanupComplete: true,
      }),
      nativeExecutor: async ({ task: projected }) => {
        assert.deepEqual(Object.keys(projected).sort(), ['id', 'inputFiles', 'instruction'])
        assert.equal(Object.hasOwn(projected, 'privateGold'), false)
        return {
          answer: { present: false, sha256: null, error: 'fixture missing answer' },
          resources: { modelRequests: 0, physicalModelRequests: 0, confirmedModelRequests: 0, unknownModelRequests: 0, knownUsageTotals: { inputTokens: null, outputTokens: null, totalTokens: null } },
          observed: { childModelRequestCount: 0, rootModelRequestCount: 0, recursionObserved: false }, executionCompleted: false, cleanupComplete: false,
        }
      },
    })
    assert.deepEqual(seenAnswers, ['Answer: [7]'], 'D1 grade receives raw assistant text, not JSON')
    assert.equal(receipt.results.length, 2)
    assert.equal(receipt.results[1].status, 'incomplete')
    const analysis = await analyzePanel({ output })
    assert.equal(analysis.denominator.plannedConditions, 2)
    assert.equal(analysis.denominator.completedConditions, 1)
    assert.equal(analysis.denominator.failedOrIncompleteConditions, 1)
    assert.equal(analysis.observedComparison.directScore, 1)
    assert.equal(analysis.observedComparison.rlmScore, null)
  })
})

test('D1 plus all fourteen S calls cannot admit a sixteenth phase request', async t => {
  const root = await mkdtemp(join(BASE, 'bq-cap-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = await Ledger.open(join(root, 'ledger.jsonl'), { total: 15, perRun: 14 })
  const view = qualityBudgetView(base, [{ id: 'D1' }, { id: 'S14' }])
  for (const runId of ['D1', ...Array(14).fill('S14')]) {
    const id = await view.admit(runId, { fixture: true })
    view.admitPhysical({ runId, logicalRequest: id, event: { fixture: true } })
    await view.settle(id, [{ type: 'finish', reason: { kind: 'stop' } }])
  }
  await assert.rejects(view.admit('D1', {}), /BQ_ARM_LIMIT/)
  await assert.rejects(view.admit('S14', {}), /BQ_ARM_LIMIT/)
  await assert.rejects(view.admit('other', {}), /BQ_ARM_SCOPE/)
  const receipt = await view.receipt()
  assert.equal(receipt.newAdmitted, 15)
  assert.equal(receipt.physicalAdmitted, 15)
  assert.equal(receipt.cumulativeAdmitted, 521)
  assert.equal(receipt.cumulativeUnknown, 11)
})
