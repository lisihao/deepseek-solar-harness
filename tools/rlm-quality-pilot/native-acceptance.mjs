#!/opt/homebrew/opt/node@22/bin/node
// Exercise both original Prime and the Solar host with local scripted chunks.
// No provider module or credential file is accepted by this entry point.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileCurrentSources, prepareSharedRuntime } from '../rlm-arc-pilot/run.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { executeCondition } from '../rlm-recursion-pilot/run.mjs'
import { prepareFixture, createSyntheticProvider, gradeFixture } from '../rlm-recursion-pilot/native-acceptance.mjs'
import { REQUIRED_SOURCE_FILES } from './three-arm.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sha = value => createHash('sha256').update(value).digest('hex')
async function hashes() {
  const result = {}
  for (const name of REQUIRED_SOURCE_FILES) result[name] = sha(await readFile(join(ROOT, name)))
  return result
}
async function loadJson(path) { return JSON.parse(await readFile(path, 'utf8')) }

export async function runQualityNativeAcceptance({ output, tempRoot }) {
  assert.equal(process.versions.node.split('.')[0], '22')
  assert.ok(output && resolve(output) === output)
  assert.ok(tempRoot && tempRoot.startsWith('/private/tmp/') && tempRoot.length < 28)
  const startedAt = new Date().toISOString()
  const sourceHashes = await hashes()
  await mkdir(dirname(output), { recursive: true, mode: 0o700 })
  await mkdir(tempRoot, { mode: 0o700 })
  const shared = join(tempRoot, 'shared')
  await mkdir(shared, { mode: 0o700 })
  const packageRoot = join(ROOT, 'incubator/rlm')
  const compiled = await compileCurrentSources({ sourceRoot: ROOT, packageRoot, shared })
  const runtime = await prepareSharedRuntime({ compiled: compiled.compiled, packageRoot, shared })
  const workerPath = join(shared, 'worker.mjs')
  await copyFile(join(ROOT, 'tools/rlm-arc-pilot/native-worker.mjs'), workerPath)
  const baseManifest = {
    shared: { path: shared, compiled: { path: compiled.compiled, outputs: compiled.outputs, hash: compiled.hash }, runtime,
      worker: { path: workerPath, sha256: sha(await readFile(workerPath)) } },
    package: { root: packageRoot }, runner: { sourceRoot: ROOT },
  }
  const arms = {}
  for (const arm of ['R', 'S']) {
    const artifactRoot = join(dirname(output), arm)
    const prepared = await prepareFixture({ sourceRoot: ROOT, shared, tempRoot: join(tempRoot, arm), artifactRoot, arm: 'S' })
    const condition = { ...prepared.condition, id: `keyless-${arm}32`, arm, protocol: 'quality-pilot-v1',
      autonomous: { maxTurns: 32, maxTokens: 4_000_000, gate: 'test -s answer.json' } }
    const ledger = await Ledger.open(join(condition.durableDirectory, 'quality-ledger.jsonl'), { total: 32, perRun: 32 })
    const fixture = createSyntheticProvider({ arm: 'S', fixture: prepared.fixture })
    let outcome
    try {
      outcome = await executeCondition({ manifest: { ...baseManifest, parentPrivate: prepared.parentPrivate },
        condition, provider: fixture.provider, ledger, relay: { async restoreOptions(options) { return options } },
        task: prepared.task, grade: gradeFixture, protectedRoots: [prepared.protectedCanaryRoot] })
    } finally { await fixture.provider.close() }
    await writeFile(join(artifactRoot, 'outcome.json'), JSON.stringify(outcome, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    const [root, child, rootIsolation, childIsolation] = await Promise.all([
      loadJson(prepared.fixture.rootReceiptPath), loadJson(prepared.fixture.childReceiptPath),
      loadJson(prepared.fixture.sandboxReceiptPath), loadJson(prepared.fixture.childSandboxReceiptPath),
    ])
    const retainedWorker = await loadJson(join(outcome.nativeEvidence, 'parent-worker-result.json'))
    const raw = retainedWorker.result?.raw
    const executionPathConfirmed = arm === 'R'
      ? raw?.kind === 'original-prime-acp' && !!raw?.rootSession
      : !!raw?.hostStartRecord && typeof raw?.nativeJournal === 'string' && raw?.kind !== 'original-prime-acp'
    const isolation = [rootIsolation, childIsolation].every(x => x.publicInputRead && x.inputWriteErrno === 1
      && x.protectedCanaryReadErrno === 1 && x.publicSocketErrno === 1)
    const accepted = outcome.executionCompleted && outcome.cleanupComplete && outcome.inputsUnchanged
      && outcome.worker.nativeDepth === 1 && outcome.worker.actualDepth === 1
      && outcome.observed.childModelRequestCount > 0 && outcome.grading.primaryScore === 1
      && root.answer === 42 && root.collectSettled && root.rootPersistentAcrossCells
      && child.persistentAcrossCells && child.sameWorkspaceInput && child.inputSha256 === prepared.fixture.goldSha256
      && root.childInputSha256 === prepared.fixture.goldSha256 && isolation && executionPathConfirmed && fixture.stats().providerClosed
    arms[arm] = { accepted, executionCompleted: outcome.executionCompleted, cleanupComplete: outcome.cleanupComplete,
      worker: outcome.worker, observed: outcome.observed, inputsUnchanged: outcome.inputsUnchanged,
      derivedAnswer: root.answer, rootCollectSettled: root.collectSettled,
      rootPersistentAcrossCells: root.rootPersistentAcrossCells, childPersistentAcrossCells: child.persistentAcrossCells,
      isolation, executionPathConfirmed, provider: fixture.stats(), resources: outcome.resources,
      nativeEvidence: outcome.nativeEvidence, workerError: outcome.workerError }
    if (!accepted) throw new Error(`QUALITY_NATIVE_ACCEPTANCE_FAILED: ${arm}; retained outcome at ${artifactRoot}`)
  }
  assert.deepEqual(await hashes(), sourceHashes, 'mechanism source changed during native acceptance')
  const proof = { formatVersion: 1, kind: 'quality-native-acceptance-v1', startedAt, completedAt: new Date().toISOString(),
    accepted: true, realModelRequests: 0, sourceHashes, compiledHash: compiled.hash,
    runtimeManifestSha256: runtime.manifest.sha256, runtimeFingerprint: runtime.paths.fingerprint,
    protocol: 'quality-pilot-v1', limits: { requestLimit: 32, wallTimeMs: 1_200_000, maxTurns: 32, maxTokens: 4_000_000 },
    arms, temporaryRoot: tempRoot, noCredentialsOrRealProviderLoaded: true,
    limitation: 'Local scripted chunks establish native recursive mechanism, isolation and cleanup, not quality improvement.' }
  await writeFile(output, JSON.stringify(proof, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return proof
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value, all[index + 1]])
    return pairs
  }, []))
  runQualityNativeAcceptance({ output: values['--output'], tempRoot: values['--tmp-root'] })
    .then(proof => console.log(JSON.stringify({ accepted: proof.accepted, realModelRequests: 0,
      arms: Object.fromEntries(Object.entries(proof.arms).map(([k,v]) => [k, { accepted: v.accepted, childRequests: v.observed.childModelRequestCount }])) })))
    .catch(error => { console.error(error.stack); process.exitCode = 1 })
}
