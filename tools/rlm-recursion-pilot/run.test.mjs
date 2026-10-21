import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createUnixServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { aggregateBudgetView } from './control.mjs'
import {
  FIXED_LIMITS,
  FIXED_ROUTE,
  __test,
  analyzePanel,
  assertPanelNotStarted,
  executeCondition,
  loadPlan,
  preparePanel,
  runPanel,
} from './run.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const PLAN = join(ROOT, 'docs/testing/prime-rlm-recursion-plan.json')
const PACKAGE_ROOT = join(ROOT, 'incubator/rlm')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalOutputHash(outputs) {
  const stable = `{${Object.keys(outputs).sort().map(name => `${JSON.stringify(name)}:{"bytes":${outputs[name].bytes},"sha256":${JSON.stringify(outputs[name].sha256)}}`).join(',')}}`
  return sha256(stable)
}

function makeSourceRow(id, window) {
  const raw = []
  const labelled = []
  for (let index = 0; index < 438; index += 1) {
    const label = index % 3 === 0 ? 'entailment' : index % 3 === 1 ? 'contradiction' : 'neutral'
    const line = `Date: 2026-10-${String(index % 28 + 1).padStart(2, '0')} || User: source-${String(index % 32)} || Instance: premise ${String(index)} -> hypothesis ${String(index)}`
    raw.push(line)
    labelled.push(`${line} || Label: ${label}`)
  }
  return {
    id,
    context_window_id: window,
    context_len: 70016,
    context_window_text: raw.join('\n'),
    context_window_text_with_labels: labelled.join('\n'),
    question: null,
    answer: null,
    answer_type: 'integer',
  }
}

async function withPreparedPanel(name, operation) {
  const tempBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(tempBase, `rlm-recursion-run-${name}-`))
  const shortTmpRoot = join(tempBase, `rr${String(process.pid)}-${randomBytes(3).toString('hex')}`)
  try {
    const output = join(directory, 'output')
    const parentPrivate = join(output, 'parent-private')
    await mkdir(parentPrivate, { recursive: true, mode: 0o700 })
    await writeFile(join(parentPrivate, 'source-rows.json'), JSON.stringify([
      makeSourceRow(715070021, 70016),
      makeSourceRow(715070046, 70017),
    ]), { mode: 0o600 })
    const manifest = await preparePanel({
      output,
      tmpRoot: shortTmpRoot,
      planPath: PLAN,
      sourceRoot: ROOT,
      packageRoot: PACKAGE_ROOT,
      compiler: async ({ shared }) => {
        const compiled = join(shared, 'compiled')
        await mkdir(compiled, { recursive: true, mode: 0o700 })
        const path = join(compiled, 'host.mjs')
        const text = 'export const fixture = true\n'
        await writeFile(path, text, { mode: 0o600 })
        const outputs = { 'host.mjs': { bytes: Buffer.byteLength(text), sha256: sha256(text) } }
        return { compiled, outputs, hash: canonicalOutputHash(outputs) }
      },
      runtimePreparer: async ({ shared }) => {
        const runtimes = join(shared, 'runtimes')
        await mkdir(runtimes, { recursive: true, mode: 0o700 })
        const runtimeManifest = join(shared, 'fixture-runtime-manifest.json')
        const value = { formatVersion: 1, primeCommit: JSON.parse(await readFile(PLAN, 'utf8')).primeCommit, fixture: true }
        await writeFile(runtimeManifest, JSON.stringify(value), { mode: 0o600 })
        return {
          paths: { binary: '/fixture/prime', python: '/usr/bin/python3', packageDir: '/fixture/package', fingerprint: 'fixture-runtime' },
          manifest: { path: runtimeManifest, sha256: await sha256File(runtimeManifest), primeCommit: value.primeCommit, archiveSha256: value.archiveSha256 ?? null },
          runtimes,
        }
      },
    })
    return await operation({ directory, output, manifest })
  } finally {
    await Promise.all([rm(directory, { recursive: true, force: true }), rm(shortTmpRoot, { recursive: true, force: true })])
  }
}

async function sha256File(path) {
  return sha256(await readFile(path))
}

async function privateTasks(manifest) {
  return (JSON.parse(await readFile(manifest.privateTasks.path, 'utf8'))).tasks
}

function budgetView(manifest, ledger) {
  return aggregateBudgetView(ledger, {
    runIds: manifest.conditions.map(condition => condition.id),
    priorCharged: FIXED_LIMITS.priorCharged,
    priorConfirmed: FIXED_LIMITS.priorConfirmed,
    priorUnknown: FIXED_LIMITS.priorUnknown,
    globalCap: FIXED_LIMITS.cumulativeCap,
    maxNew: FIXED_LIMITS.newPanelRequests,
    perTreeLimit: FIXED_LIMITS.perTreeRequests,
  })
}

test('frozen plan retains the verified 463 = 456 + 7 prefix and rejects altered limits', async () => {
  const loaded = await loadPlan(PLAN, ROOT)
  assert.equal(loaded.plan.prior.charged, 463)
  assert.equal(loaded.plan.prior.confirmed, 456)
  assert.equal(loaded.plan.prior.unknown, 7)
  assert.equal(loaded.priorEvidence.sha256, '8137f1224b211622ec941cabf49375b6f9bf5817750728b2e0b1a792a3abcd57')

  const directory = await mkdtemp(join(tmpdir(), 'rlm-recursion-plan-'))
  try {
    const altered = structuredClone(loaded.plan)
    altered.limits.perTreeRequests = 15
    const path = join(directory, 'altered.json')
    await writeFile(path, JSON.stringify(altered))
    await assert.rejects(() => loadPlan(path, ROOT), /RLM_PLAN_LIMITS/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('failed acceptance preflight does not import provider material, read credentials, or write the run marker', async () => {
  await withPreparedPanel('preflight', async ({ directory, output }) => {
    const invalidAcceptance = join(directory, 'invalid-acceptance.json')
    const provider = join(directory, 'provider.mjs')
    const credential = join(directory, 'credential.json')
    await writeFile(invalidAcceptance, JSON.stringify({ formatVersion: 1, status: 'not-passed' }))
    const invalidAcceptanceSha256 = await sha256File(invalidAcceptance)
    await assert.rejects(
      () => runPanel({
        output,
        providerModule: provider,
        providerSha256: 'a'.repeat(64),
        providerPackage: 'fixture-provider',
        credentialFile: credential,
        acceptanceArtifact: invalidAcceptance,
        acceptanceSha256: invalidAcceptanceSha256,
      }),
      /RLM_ACCEPTANCE_GATE/,
    )
    await assert.rejects(() => readFile(provider, 'utf8'), /ENOENT/)
    await assert.rejects(() => readFile(credential, 'utf8'), /ENOENT/)
    await assert.rejects(() => readFile(join(output, 'real-run-started.json'), 'utf8'), /ENOENT/)
  })
})

test('a durable panel marker rejects replay before a second run can start', async () => {
  await withPreparedPanel('replay', async ({ output }) => {
    await assertPanelNotStarted(output)
    await writeFile(join(output, 'real-run-started.json'), JSON.stringify({ formatVersion: 1 }))
    await assert.rejects(() => assertPanelNotStarted(output), /RLM_RUN_ALREADY_STARTED/)
  })
})

test('analysis keeps all four cells, incomplete state, and the historical unknown prefix', async () => {
  await withPreparedPanel('analysis', async ({ output, manifest }) => {
    const base = await Ledger.open(manifest.ledger.path, { total: 56, perRun: 14 })
    const view = budgetView(manifest, base)
    const condition = manifest.conditions[0]
    const request = await view.admit(condition.id, { fixture: true })
    view.admitPhysical({ runId: condition.id, logicalRequest: request, event: { fixture: true } })
    await view.settle(request, [], new Error('synthetic unavailable receipt'))
    await writeFile(join(condition.markerDirectory, 'result.json'), JSON.stringify({
      formatVersion: 1,
      condition: { id: condition.id, arm: condition.arm, taskIndex: condition.taskIndex, taskId: condition.taskId, kind: condition.kind },
      status: 'incomplete',
      grading: { primaryScore: 0, schemaValid: false, errors: ['fixture'] },
      resources: { modelRequests: 1, physicalModelRequests: 1, confirmedModelRequests: 0, unknownModelRequests: 1, knownUsageTotals: { inputTokens: null, outputTokens: null, totalTokens: null }, elapsedMs: 7 },
      observed: { childIntentCount: 0, childModelRequestCount: 0, recursionObserved: false, childRoster: { available: false, observed: false, count: 0, statuses: [] } },
      executionCompleted: false,
      cleanupComplete: true,
    }))
    const analysis = await analyzePanel({ output })
    assert.equal(analysis.cells.length, 4)
    assert.equal(analysis.denominator.notRunConditions, 3)
    assert.equal(analysis.denominator.failedOrIncompleteConditions, 1)
    assert.equal(analysis.accounting.cumulative.unknown, 8)
    assert.equal(analysis.accounting.cumulative.charged, 464)
  })
})

test('child depth evidence counts only physically admitted system/developer depth-1 requests', async () => {
  await withPreparedPanel('child-depth', async ({ manifest }) => {
    const base = await Ledger.open(manifest.ledger.path, { total: 56, perRun: 14 })
    const ledger = budgetView(manifest, base)
    const condition = manifest.conditions.find(value => value.arm === 'S')
    assert.ok(condition)
    const task = (await privateTasks(manifest))[condition.taskIndex]
    const nativeJournal = join(condition.runDirectory, 'native-journal.jsonl')
    await writeFile(nativeJournal, JSON.stringify({ value: { update: { _meta: { 'ai.primeintellect.prime-agent': { subagents: [{ id: 'child-1', status: 'idle' }] } } } } }) + '\n')
    const retainedSocket = join(condition.runDirectory, 'tmp', 'retained.sock')
    const socketServer = createUnixServer()
    socketServer.listen(retainedSocket)
    await once(socketServer, 'listening')
    let physicalAdmission
    const provider = {
      modelInfo: { name: 'fixture', context: { contextWindow: 128000 }, inputModalities: ['text'] },
      setPhysicalAdmission(callback) { physicalAdmission = callback },
      adapter: {
        async prepareCall() {
          return {
            async *stream() {
              physicalAdmission({ fixture: true })
              yield { type: 'finish', reason: { kind: 'stop' } }
            },
          }
        },
      },
    }
    const options = (role, content) => ({ ...FIXED_ROUTE, maxTokens: FIXED_ROUTE.maxOutputTokens, messages: [{ role, content }] })
    try {
      const outcome = await executeCondition({
        manifest,
        condition,
        provider,
        ledger,
        relay: { restoreOptions: async value => value },
        task,
        grade: () => ({ primaryScore: 0, schemaValid: false, errors: [] }),
        reservePort: async () => ({ port: 14001, releaseIpv4: async () => {}, close: async () => {} }),
        sandboxBuilder: () => '(version 1)',
        spawnWorker: async ({ onModel }) => {
          for await (const _chunk of onModel('root', options('user', 'Recursive agent depth: 1'))) {}
          for await (const _chunk of onModel('child', options('system', 'Recursive agent depth: 1'))) {}
          await writeFile(join(condition.workspace, 'answer.json'), '{}')
          return {
            result: { state: 'completed', nativeDepth: 1, actualDepth: 1, physicalCleanup: true, raw: { nativeJournal } },
            exit: { code: 0, signal: null },
            stdout: '',
            stderr: '',
            error: null,
          }
        },
      })
      assert.equal(outcome.observed.admittedModelRequests, 2)
      assert.equal(outcome.observed.childIntentCount, 1)
      assert.equal(outcome.observed.childModelRequestCount, 1)
      assert.equal(outcome.observed.rootModelRequestCount, 1)
      assert.equal(outcome.observed.childRoster.observed, true)
      assert.deepEqual(outcome.nativeEvidenceOmissions, [{ path: 'tmp/retained.sock', type: 'socket' }])
    } finally {
      await new Promise((resolveClose, rejectClose) => socketServer.close(error => error ? rejectClose(error) : resolveClose()))
    }
  })
})

test('parent failure reporting preserves a condition admission already recorded in the ledger', async () => {
  await withPreparedPanel('failure-accounting', async ({ manifest }) => {
    const base = await Ledger.open(manifest.ledger.path, { total: 56, perRun: 14 })
    const ledger = budgetView(manifest, base)
    const condition = manifest.conditions[0]
    const request = await ledger.admit(condition.id, { fixture: true })
    ledger.admitPhysical({ runId: condition.id, logicalRequest: request, event: { fixture: true } })
    await ledger.settle(request, [], new Error('synthetic worker failure'))
    const task = (await privateTasks(manifest))[condition.taskIndex]
    const outcome = await __test.parentFailureResult(condition, task, new Error('post-admission failure'), ledger)
    assert.equal(outcome.resources.modelRequests, 1)
    assert.equal(outcome.resources.physicalModelRequests, 1)
    assert.equal(outcome.resources.unknownModelRequests, 1)
  })
})
