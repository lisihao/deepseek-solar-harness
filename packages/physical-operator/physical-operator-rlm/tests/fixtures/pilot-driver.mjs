/** Run the four-arm fake pilot through the existing real Loader composition. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { runPilotTrial, sha } from '../../../../orchestration/orchestration-local/tests/fixtures/offline-rlm/pilot-trial.mjs'

const [config, inputDir] = process.argv.slice(2)
assert(config && inputDir && process.env.DSH_HOME, 'isolated Loader config, cases and schedule required')
const home = process.env.DSH_HOME
const artifact = join(home, 'pilot')
await mkdir(artifact, { recursive: true })
const casesRaw = await readFile(join(inputDir, 'cases.json'))
const scheduleRaw = await readFile(join(inputDir, 'schedule.json'))
const cases = JSON.parse(casesRaw)
const schedule = JSON.parse(scheduleRaw)
assert.equal(schedule.cases_sha256, sha(casesRaw))
assert.equal(new Set(cases.map(c => c.case_id)).size, cases.length)
assert.equal(new Set(schedule.trials.map(t => t.trial_id)).size, schedule.trials.length)
await writeFile(join(artifact, 'cases.json'), casesRaw, { flag: 'wx' })
await writeFile(join(artifact, 'schedule.json'), scheduleRaw, { flag: 'wx' })
const prepared = new Map()
const python = process.env.DSH_OFFLINE_PYTHON ?? 'python3'
const preprocess = fileURLToPath(new URL('../../../../../scripts/rlm-eval-offline/pilot_preprocess.py', import.meta.url))
for (const item of cases) {
  const caseDir = join(artifact, 'preparation-' + sha(item.case_id).slice(0, 12))
  await mkdir(caseDir)
  await writeFile(join(caseDir, 'case.json'), JSON.stringify(item), { flag: 'wx' })
  const startedAt = new Date().toISOString()
  const startedMs = performance.now()
  const result = await promisify(execFile)(python, ['-B', preprocess, '--case', join(caseDir, 'case.json'),
    '--out', join(caseDir, 'prepared.json')], { maxBuffer: 1024 * 1024 })
  await writeFile(join(caseDir, 'native.json'), JSON.stringify({ executable: python, source: preprocess,
    startedAt, finishedAt: new Date().toISOString(), elapsedMs: performance.now() - startedMs,
    stdout: result.stdout, stderr: result.stderr, exitCode: 0 }) + '\n')
  prepared.set(item.case_id, JSON.parse(await readFile(join(caseDir, 'prepared.json'), 'utf8')))
}
let ctx
const outputs = [], diagnostics = []
const sourceFiles = [
  new URL('../../../../orchestration/orchestration-local/tests/fixtures/offline-rlm/pilot-trial.mjs', import.meta.url),
  new URL('../../../../orchestration/orchestration-local/tests/fixtures/offline-rlm/trial.mjs', import.meta.url),
  new URL('../../../../orchestration/orchestration-local/tests/fixtures/offline-rlm/adapter.mjs', import.meta.url),
  import.meta.url, new URL('../../../../../scripts/rlm-eval-offline/pilot_preprocess.py', import.meta.url),
]
try {
  ctx = await boot('offline-pilot-fixture', resolveConfigPath(config, undefined), undefined, undefined,
    new URL('../../../../../examples/package.json', import.meta.url).href)
  for (const trial of schedule.trials) {
    const item = cases.find(c => c.case_id === trial.case_id)
    assert(item, 'scheduled case missing')
    const result = await runPilotTrial(ctx, join(artifact, trial.trial_id), item, trial, prepared.get(item.case_id))
    outputs.push({ trial_id: trial.trial_id, path: trial.trial_id + '/evidence.json',
      sha256: sha(await readFile(result.evidencePath)), terminal: result.report.terminal })
  }
  for (const diagnostic of ['tool-failure', 'unknown']) {
    const base = schedule.trials.find(t => t.arm === 'codeact_bm25')
    const trial = { ...base, trial_id: 'diagnostic-' + diagnostic, stage: 'keyless-diagnostic' }
    assert(!schedule.trials.some(t => t.trial_id === trial.trial_id))
    const item = cases.find(c => c.case_id === trial.case_id)
    const result = await runPilotTrial(ctx, join(artifact, trial.trial_id), item, trial, prepared.get(item.case_id), diagnostic)
    diagnostics.push({ trial_id: trial.trial_id, path: trial.trial_id + '/evidence.json',
      sha256: sha(await readFile(result.evidencePath)), terminal: result.report.terminal })
  }
  const identities = []
  for (const url of sourceFiles) {
    const path = fileURLToPath(url)
    identities.push({ path, sha256: sha(await readFile(path)) })
  }
  const manifest = { schemaVersion: 1, source: 'actual-loader-worker-runtime/scripted-inprocess-adapter',
    fakeOnly: true, casesSha256: sha(casesRaw), scheduleSha256: sha(scheduleRaw),
    producerFiles: identities, executions: outputs, diagnostics, paidLaunchAllowed: false, experimentReady: false }
  await writeFile(join(artifact, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  if (process.env.DSH_EXAMPLE_MODE === 'lib') {
    assert.match(import.meta.resolve('@deepseek-ai/dsh-orchestration-local'), /\/lib\/index\.js$/)
    assert(!process.execArgv.some(arg => /tsx/.test(arg)))
  }
  const terminalCounts = Object.fromEntries([...new Set(outputs.map(x => x.terminal))]
    .sort().map(kind => [kind, outputs.filter(x => x.terminal === kind).length]))
  process.stdout.write(JSON.stringify({ fakeOnly: true, scheduled: schedule.trials.length, executions: outputs.length,
    arms: [...new Set(schedule.trials.map(t => t.arm))].sort(), terminalCounts,
    diagnostics: diagnostics.map(x => x.terminal), actualHttpModelRequests: 0,
    paidLaunchAllowed: false, experimentReady: false }) + '\n')
} finally { await ctx?.fiber.dispose() }
