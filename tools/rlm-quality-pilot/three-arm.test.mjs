import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'

import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { executeDirectCondition } from './run.mjs'
import {
  FIXED_GUIDANCE,
  FIXED_LIMITS,
  REQUIRED_SOURCE_FILES,
  RUN_START_FILE,
  PREFIX_ALLOCATION_FILE,
  manifestFingerprint,
  prepareThreeArm,
  runThreeArm,
  threeArmBudgetView,
} from './three-arm.mjs'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)
const BASE = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const REVISION = '616cca899e8b51ea0ad5446ebab39aa72b3192bc'
let ordinal = 0

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha(path) {
  return sha(await readFile(path))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function canonicalHash(value) {
  return sha(stableJson(value))
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function fixtureTask({ context, question, scorerPath, scorerSha256 }) {
  return {
    formatVersion: 1,
    kind: 'paper-oolong-task-v1',
    id: 'trec-fixture-15000243',
    context,
    question,
    answerType: 'ANSWER_TYPE.NUMERIC',
    source: {
      repository: 'oolongbench/oolong-synth',
      revision: REVISION,
      dataset: 'trec_coarse',
      rowId: 15_000_243,
      contextWindowId: 1,
      contextLength: 32_768,
    },
    privateGold: { answer: '[not-in-manifest]' },
    scorer: { path: scorerPath, sha256: scorerSha256, commit: 'fixture-scorer' },
    inputFiles: { 'inputs/context.txt': context },
  }
}

async function sourceHashes() {
  const hashes = {}
  for (const name of REQUIRED_SOURCE_FILES) hashes[name] = await fileSha(join(ROOT, name))
  return hashes
}

function validArm() {
  return {
    accepted: true,
    executionCompleted: true,
    cleanupComplete: true,
    executionPathConfirmed: true,
    isolation: true,
    worker: { nativeDepth: 1, actualDepth: 1 },
    observed: { childModelRequestCount: 1 },
  }
}

async function acceptanceFor({ base, manifest, mutate } = {}) {
  const proofPath = join(base, 'quality-native-acceptance.json')
  const proof = {
    formatVersion: 1,
    kind: 'quality-native-acceptance-v1',
    accepted: true,
    realModelRequests: 0,
    protocol: 'quality-pilot-v1',
    sourceHashes: await sourceHashes(),
    compiledHash: manifest.shared.compiled.hash,
    runtimeManifestSha256: manifest.shared.runtime.manifest.sha256,
    limits: { requestLimit: 32, wallTimeMs: 1_200_000, maxTurns: 32, maxTokens: 4_000_000 },
    arms: { R: validArm(), S: validArm() },
  }
  if (mutate) mutate(proof)
  await writeJson(proofPath, proof)
  return proofPath
}

async function settleKnown(ledger, runId) {
  const request = await ledger.admit(runId, { fixture: true })
  ledger.admitPhysical({ runId, logicalRequest: request, event: { fixture: true } })
  await ledger.settle(request, [{ type: 'finish', reason: { kind: 'stop' } }])
  return request
}

function completedOutcome(answerText) {
  return {
    answerText,
    answer: { present: typeof answerText === 'string', sha256: typeof answerText === 'string' ? sha(answerText) : null, error: null },
    resources: { modelRequests: 1, physicalModelRequests: 1, confirmedModelRequests: 1, unknownModelRequests: 0, knownUsageTotals: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    observed: { childModelRequestCount: 1, rootModelRequestCount: 0, recursionObserved: true },
    executionCompleted: true,
    cleanupComplete: true,
  }
}

async function withPrepared(name, operation) {
  const base = await mkdtemp(join(BASE, `three-arm-${name}-`))
  const tmpRoot = join(BASE, `t3-${process.pid}-${++ordinal}`)
  try {
    const taskPath = join(base, 'private-task.json')
    const scorerPath = join(base, 'official-score.py')
    const priorClosure = join(base, 'connection-timeout-final-closure.json')
    const output = join(base, 'panel')
    await writeFile(taskPath, '{"fixture":true}\n', { mode: 0o600 })
    await writeFile(scorerPath, '# fixture scorer\n', { mode: 0o600 })
    await writeJson(priorClosure, {
      formatVersion: 1,
      kind: 'quality-three-arm-connect-timeout-closure-v1',
      nativeConditionStarted: false, modelResponseHeadersObserved: false,
      connectTimeoutCode: 'UND_ERR_CONNECT_TIMEOUT', unknownChargeRetained: true, answersAvailable: false,
      providerClosed: true,
      relayClosed: true,
      networkProfileDisposed: true,
      longReadProfileClosed: true,
      ownedProcessesAbsent: true,
      accounting: { cumulativeAdmitted: 524, cumulativeConfirmed: 510, cumulativeUnknown: 14 },
    })
    const context = 'The complete public TREC context.\nEvery record is present.'
    const question = 'How many records satisfy the original numeric question?'
    const task = fixtureTask({ context, question, scorerPath, scorerSha256: await fileSha(scorerPath) })
    const taskLoader = async received => {
      assert.equal(received, taskPath)
      return structuredClone(task)
    }
    const compiler = async ({ shared }) => {
      const compiled = join(shared, 'compiled')
      const wirePath = join(compiled, 'model-wire.mjs')
      const wire = 'export const fixtureWire = true\n'
      await mkdir(compiled, { recursive: true, mode: 0o700 })
      await writeFile(wirePath, wire, { mode: 0o600 })
      const outputs = { 'model-wire.mjs': { sha256: sha(wire), bytes: Buffer.byteLength(wire) } }
      return { compiled, outputs, hash: canonicalHash(outputs) }
    }
    const runtimePreparer = async ({ shared }) => {
      const runtimes = join(shared, 'runtimes')
      const manifestPath = join(shared, 'fixture-runtime.json')
      await mkdir(runtimes, { recursive: true, mode: 0o700 })
      await writeJson(manifestPath, { formatVersion: 1, fixture: true })
      return {
        paths: { python: '/usr/bin/python3', binary: '/fixture/prime', packageDir: '/fixture/package', fingerprint: 'fixture-runtime' },
        manifest: { path: manifestPath, sha256: await fileSha(manifestPath), primeCommit: 'fixture', archiveSha256: null },
        runtimes,
      }
    }
    const manifest = await prepareThreeArm({
      output,
      tmpRoot,
      taskPath,
      priorClosure,
      sourceRoot: ROOT,
      taskLoader,
      compiler,
      runtimePreparer,
    })
    await operation({ base, output, tmpRoot, taskPath, scorerPath, priorClosure, task, taskLoader, manifest })
  } finally {
    await Promise.all([
      rm(base, { recursive: true, force: true }),
      rm(tmpRoot, { recursive: true, force: true }),
    ])
  }
}

function runtimeDeps() {
  return {
    runtimeAssert: () => {},
    longReadProfileFactory: ({ baseFetch }) => ({ fetch: baseFetch, close: async () => {} }),
    networkProfileInstaller: ({ baseFetch }) => ({ fetch: baseFetch, dispose: () => {} }),
    relayFactory: async () => ({ store: {}, close: async () => {} }),
  }
}

test('prepare freezes one public bare prompt and identical R32/S32 native prompts without private gold', async () => {
  await withPrepared('shape', async ({ manifest, task }) => {
    const [direct, original, solar] = manifest.conditions
    assert.deepEqual(manifest.conditions.map(condition => condition.id), ['D1', 'R32', 'S32'])
    assert.equal(direct.publicPrompt, `${FIXED_GUIDANCE}\n\n${task.context}\n\n${task.question}`)
    assert.equal(direct.prompt, null)
    assert.equal(original.protocol, 'quality-pilot-v1')
    assert.equal(solar.protocol, 'quality-pilot-v1')
    assert.equal(original.prompt.task, solar.prompt.task)
    assert.equal(original.autonomous.gate, 'test -s answer.json')
    assert.equal(original.autonomous.maxTurns, 32)
    assert.equal(original.autonomous.maxTokens, 4_000_000)
    assert.equal(await fileSha(join(original.workspace, 'inputs/context.txt')), sha(task.context))
    assert.equal(await fileSha(join(solar.workspace, 'inputs/context.txt')), sha(task.context))
    assert.equal(JSON.stringify(manifest).includes('[not-in-manifest]'), false)
    assert.equal(manifest.route.configuredMaxOutputTokens, 16_384)
    assert.equal(manifest.route.maxTokens, 16_384)
  })
})

test('D1 reuses the bare executor with exactly one full user input and no tools', async t => {
  const root = await mkdtemp(join(BASE, 'three-arm-direct-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const base = await Ledger.open(join(root, 'ledger.jsonl'), { total: 65, perRun: 32 })
  const ledger = threeArmBudgetView(base, [{ id: 'D1' }, { id: 'R32' }, { id: 'S32' }], { admitted: 524, confirmed: 510, unknown: 14 })
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
  const prompt = `${FIXED_GUIDANCE}\n\nfull context bytes\n\noriginal question bytes`
  const outcome = await executeDirectCondition({
    manifest: { shared: { compiled: { path: root } } },
    condition: { id: 'D1', arm: 'D', taskId: 'fixture', gameId: 'fixture', directory: root, publicPrompt: prompt },
    provider,
    relay: { restoreOptions: async value => value },
    ledger,
    modelWireLoader: async () => ({
      async decodeChatRequest(request, route) {
        assert.deepEqual(route, { provider: 'openai-codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', maxTokens: 16_384 })
        return { ...route, messages: request.messages.map(message => ({ role: message.role, content: [{ type: 'text', text: message.content }] })) }
      },
      async *encodeChatStream(chunks, { onFinish }) {
        const seen = []
        for await (const chunk of chunks) seen.push(chunk)
        assert.equal(eof, true, 'the provider stream must reach EOF before the final answer is assembled')
        assert.equal(seen.at(-1).type, 'finish')
        onFinish({ message: { content: 'Answer: [7]' } })
        yield 'data: [DONE]\n\n'
      },
    }),
  })
  assert.equal(outcome.executionCompleted, true)
  assert.deepEqual(receivedOptions.messages, [{ role: 'user', content: [{ type: 'text', text: prompt }] }])
  assert.equal(Object.hasOwn(receivedOptions, 'tools'), false)
  assert.equal(receivedOptions.messages.some(message => message.role === 'system'), false)
  assert.equal((await ledger.receipt()).newAdmitted, 1)
})

test('run gives R32 and S32 the same frozen native task and keeps their JSON-string answers private', async () => {
  await withPrepared('all-complete', async ({ base, output, task, taskLoader, manifest }) => {
    const acceptance = await acceptanceFor({ base, manifest })
    const order = []
    const nativeSeen = []
    const graded = []
    const receipt = await runThreeArm({
      output,
      acceptance,
      taskLoader,
      providerModule: '/private/tmp/fixture-provider.mjs',
      providerSha256: 'a'.repeat(64),
      providerPackage: 'fixture-provider',
      credentialFile: '/private/tmp/fixture-credential.json',
      ...runtimeDeps(),
      providerLoader: async options => {
        assert.equal(options.maxModelRequests, 65)
        return { modelInfo: { name: 'fixture' }, close: async () => {} }
      },
      taskGrader: async (_task, answer) => {
        graded.push(answer)
        return { score: 1, primaryScore: 1, exact: true, attemptedParse: answer, parseConfidence: 'fixture', scorerSha256: task.scorer.sha256 }
      },
      directExecutor: async ({ condition, ledger }) => {
        order.push(condition.id)
        await settleKnown(ledger, condition.id)
        return completedOutcome('Answer: [7]')
      },
      nativeExecutor: async ({ condition, task: projected, ledger }) => {
        order.push(condition.id)
        nativeSeen.push({ condition, projected })
        assert.equal(JSON.stringify(projected).includes('[not-in-manifest]'), false)
        await writeFile(join(condition.workspace, 'answer.json'), JSON.stringify('[7]'), { mode: 0o600 })
        await settleKnown(ledger, condition.id)
        return completedOutcome(undefined)
      },
    })
    assert.deepEqual(order, ['D1', 'R32', 'S32'])
    assert.equal(nativeSeen.length, 2)
    assert.equal(nativeSeen[0].condition.protocol, 'quality-pilot-v1')
    assert.equal(nativeSeen[1].condition.protocol, 'quality-pilot-v1')
    assert.equal(nativeSeen[0].condition.prompt.task, nativeSeen[1].condition.prompt.task)
    assert.equal(nativeSeen[0].condition.autonomous.maxTurns, 32)
    assert.equal(nativeSeen[0].condition.autonomous.maxTokens, 4_000_000)
    assert.equal(nativeSeen[0].condition.autonomous.gate, 'test -s answer.json')
    assert.deepEqual(graded, ['Answer: [7]', '[7]', '[7]'])
    assert.deepEqual(receipt.results.map(result => result.status), ['completed', 'completed', 'completed'])
    assert.equal(receipt.accounting.cumulative.admitted, 527)
    assert.equal(await readFile(join(manifest.parentPrivate, 'answers', 'R32.json'), 'utf8'), JSON.stringify('[7]'))
    assert.equal(await readFile(join(manifest.parentPrivate, 'answers', 'S32.json'), 'utf8'), JSON.stringify('[7]'))
    assert.equal(JSON.stringify(receipt).includes('[not-in-manifest]'), false, 'sanitized receipt must not expose private gold')
    assert.equal(JSON.stringify(receipt).includes('Answer: [7]'), false, 'sanitized receipt must not embed the raw D1 answer')
    assert.equal(JSON.stringify(receipt).includes('fixture-credential'), false, 'sanitized receipt must not expose credential paths')
  })
})

test('an unknown R32 request is retained and fences S32 while completed, unknown, and not-run results remain durable', async () => {
  await withPrepared('unknown', async ({ base, output, task, taskLoader, manifest }) => {
    const acceptance = await acceptanceFor({ base, manifest })
    const nativeCalls = []
    const receipt = await runThreeArm({
      output,
      acceptance,
      taskLoader,
      providerModule: '/private/tmp/fixture-provider.mjs',
      providerSha256: 'b'.repeat(64),
      providerPackage: 'fixture-provider',
      credentialFile: '/private/tmp/fixture-credential.json',
      ...runtimeDeps(),
      providerLoader: async () => ({ modelInfo: { name: 'fixture' }, close: async () => {} }),
      taskGrader: async (_task, answer) => ({ score: answer.length ? 1 : 0, primaryScore: 1, exact: false, attemptedParse: answer, parseConfidence: 'fixture', scorerSha256: task.scorer.sha256 }),
      directExecutor: async ({ condition, ledger }) => {
        await settleKnown(ledger, condition.id)
        return completedOutcome('Answer: [7]')
      },
      nativeExecutor: async ({ condition, ledger }) => {
        nativeCalls.push(condition.id)
        await writeFile(join(condition.workspace, 'answer.json'), JSON.stringify('[7]'), { mode: 0o600 })
        const request = await ledger.admit(condition.id, { fixture: 'transport-loss' })
        ledger.admitPhysical({ runId: condition.id, logicalRequest: request, event: { fixture: true } })
        await ledger.settle(request, [], new Error('fixture transport loss'))
        return {
          answer: { present: true, sha256: null, error: 'fixture transport loss' },
          resources: { modelRequests: 1, physicalModelRequests: 1, confirmedModelRequests: 0, unknownModelRequests: 1, knownUsageTotals: { inputTokens: null, outputTokens: null, totalTokens: null } },
          observed: { childModelRequestCount: 1, rootModelRequestCount: 0, recursionObserved: true },
          executionCompleted: false,
          cleanupComplete: true,
        }
      },
    })
    assert.deepEqual(nativeCalls, ['R32'])
    assert.deepEqual(receipt.results.map(result => result.status), ['completed', 'unknown', 'not-run'])
    assert.equal(receipt.accounting.new.unknown, 1)
    assert.equal(receipt.accounting.cumulative.unknown, 15)
    assert.equal(receipt.accounting.stopped, true)
    assert.equal(await readFile(join(manifest.parentPrivate, 'answers', 'R32.json'), 'utf8'), JSON.stringify('[7]'))
    assert.equal(await readFile(join(manifest.conditions[2].markerDirectory, 'result.json'), 'utf8').then(JSON.parse).then(value => value.status), 'not-run')
    await assert.rejects(readFile(join(manifest.conditions[2].markerDirectory, 'real-condition-started.json')), /ENOENT/)
  })
})

test('65 new requests stay below the 600 hard cap, D1 has one slot, and unknown charges cannot be refunded', async t => {
  const root = await mkdtemp(join(BASE, 'three-arm-budget-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const conditions = [{ id: 'D1' }, { id: 'R32' }, { id: 'S32' }]
  const base = await Ledger.open(join(root, 'settled.jsonl'), { total: 65, perRun: 32 })
  const view = threeArmBudgetView(base, conditions, { admitted: 524, confirmed: 510, unknown: 14 })
  for (const runId of ['D1', ...Array(32).fill('R32'), ...Array(32).fill('S32')]) await settleKnown(view, runId)
  const full = await view.receipt()
  assert.equal(full.newAdmitted, 65)
  assert.equal(full.physicalAdmitted, 65)
  assert.equal(full.cumulativeAdmitted, 589)
  assert.equal(full.cumulativeAdmitted <= 600, true)
  assert.equal(full.cumulativeAdmitted, full.cumulativeConfirmed + full.cumulativeUnknown)
  await assert.rejects(view.admit('D1', { forbidden: true }), /T3_ARM_LIMIT/)
  await assert.rejects(view.admit('R32', { forbidden: true }), /T3_ARM_LIMIT/)

  const unknownBase = await Ledger.open(join(root, 'unknown.jsonl'), { total: 65, perRun: 32 })
  const unknownView = threeArmBudgetView(unknownBase, conditions, { admitted: 524, confirmed: 510, unknown: 14 })
  const request = await unknownView.admit('D1', { fixture: 'unknown' })
  unknownView.admitPhysical({ runId: 'D1', logicalRequest: request, event: { fixture: true } })
  await unknownView.settle(request, [], new Error('lost response'))
  const retained = await unknownView.receipt()
  assert.equal(retained.cumulativeAdmitted, 525)
  assert.equal(retained.cumulativeConfirmed, 510)
  assert.equal(retained.cumulativeUnknown, 15)
  assert.equal(retained.stopped, true)
  await assert.rejects(unknownView.admit('R32', { forbiddenReplay: true }), /EXPERIMENT_STOPPED/)
})

test('bad native arm proof or changed prepared source rejects before the provider loader', async () => {
  await withPrepared('preflight', async ({ base, output, taskLoader, manifest }) => {
    let providerLoaded = false
    const common = {
      output,
      taskLoader,
      providerModule: '/private/tmp/fixture-provider.mjs',
      providerSha256: 'c'.repeat(64),
      providerPackage: 'fixture-provider',
      credentialFile: '/private/tmp/fixture-credential.json',
      ...runtimeDeps(),
      providerLoader: async () => { providerLoaded = true; throw new Error('provider must not load') },
    }
    const badArmAcceptance = await acceptanceFor({ base, manifest, mutate: proof => { proof.arms.S.cleanupComplete = false } })
    await assert.rejects(() => runThreeArm({ ...common, acceptance: badArmAcceptance }), /T3_ACCEPTANCE/)
    assert.equal(providerLoaded, false)
    assert.equal(await readFile(join(output, RUN_START_FILE)).then(() => true).catch(error => error.code === 'ENOENT'), true, 'a bad acceptance must not create a real-run marker')

    const goodAcceptance = await acceptanceFor({ base, manifest })
    const preparedPath = join(output, 'prepared.json')
    const altered = JSON.parse(await readFile(preparedPath, 'utf8'))
    altered.execution.sourceFiles['tools/rlm-quality-pilot/task.mjs'] = '0'.repeat(64)
    altered.fingerprint = manifestFingerprint(altered)
    await writeJson(preparedPath, altered)
    await assert.rejects(() => runThreeArm({ ...common, acceptance: goodAcceptance }), /T3_FINGERPRINT_SOURCE/)
    assert.equal(providerLoaded, false)
  })
})


test('a different output namespace cannot reuse an allocated cumulative prefix', async () => {
  await withPrepared('prefix-claim', async ({ base, output, taskLoader, manifest }) => {
    const acceptance = await acceptanceFor({ base, manifest })
    await writeJson(join(dirname(manifest.prior.path), PREFIX_ALLOCATION_FILE), {
      output: join(base, 'another-panel'), fingerprint: 'a'.repeat(64),
    })
    let providerLoaded = false
    await assert.rejects(() => runThreeArm({ output, acceptance, taskLoader,
      providerModule: '/private/tmp/fixture-provider.mjs', providerSha256: 'c'.repeat(64),
      providerPackage: 'fixture-provider', credentialFile: '/private/tmp/fixture-credential.json',
      ...runtimeDeps(), providerLoader: async () => { providerLoaded = true },
    }), /T3_PREFIX_ALREADY_ALLOCATED/)
    assert.equal(providerLoaded, false)
    await assert.rejects(readFile(join(output, RUN_START_FILE)), /ENOENT/)
  })
})
