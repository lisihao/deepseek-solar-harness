import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
it('records four real Worker/Runtime fake arms without manufacturing terminal provenance', async () => {
  const driver = fileURLToPath(new URL('../../../packages/physical-operator/physical-operator-rlm/tests/fixtures/pilot-driver.mjs', import.meta.url))
  const config = fileURLToPath(new URL('../offline-rlm.cordis.yml', import.meta.url))
  const destination = process.env.DSH_OFFLINE_PILOT_ARTIFACTS
    ?? fileURLToPath(new URL('../../../.artifacts/pilot-receipts/' + resolveExampleMode(), import.meta.url))
  const result = await runLoaderSmoke({
    label: 'four-arm fake pilot receipts', tempDirPrefix: 'dsh-pilot-receipts-', binScript: driver, libBinScript: driver,
    configPath: config, binArgs: [config, 'input'], processTimeoutMs: 180_000,
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    prepare: async (cwd) => {
      await stat(destination).then(() => { throw new Error('Artifact destination exists; inspect the original result') },
        (error: unknown) => { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error })
      await mkdir(join(cwd, 'input'))
      if (process.env.DSH_OFFLINE_PILOT_BUNDLE) {
        await cp(join(process.env.DSH_OFFLINE_PILOT_BUNDLE, 'cases.json'), join(cwd, 'input/cases.json'))
        await cp(join(process.env.DSH_OFFLINE_PILOT_BUNDLE, 'schedule.json'), join(cwd, 'input/schedule.json'))
        return
      }
      const cases = ['alpha', 'beta'].map((id) => {
        const context = 'HEADER-' + id + '\n' + Array.from({ length: 650 }, (_, i) =>
          'Date: Jan 01, 2024 || User: ' + String(i) + ' || Instance: complete synthetic fact ' + id + ' number ' + String(i) + '\n').join('') + 'UTF8-TAIL-终点\n'
        const question = 'Which synthetic label is most frequent in all instances?'
        return { case_id: 'fixture-' + id, benchmark: 'oolong', partition: 'development', dataset: 'synthetic',
          context_window_id: id, context_len: 32768, context, question, input_sha256: sha(context + '\n' + question),
          metric: 'exact_match', cluster_id: 'fixture-cluster-' + id }
      })
      const raw = JSON.stringify(cases) + '\n'
      const trials = cases.flatMap(c => [0, 1].flatMap(repeat =>
        ['codeact_bm25', 'chunk_map_reduce', 'rlm_nosub', 'rlm_full'].map(arm => ({
          stage: 'keyless-synthetic-' + resolveExampleMode(),
          trial_id: sha(cwd + resolveExampleMode() + c.case_id + arm + String(repeat)).slice(0, 24), case_id: c.case_id,
          repeat, arm, input_sha256: c.input_sha256, benchmark: c.benchmark, partition: c.partition, cluster_id: c.cluster_id,
        }))))
      await writeFile(join(cwd, 'input/cases.json'), raw)
      await writeFile(join(cwd, 'input/schedule.json'), JSON.stringify({ cases_sha256: sha(raw), trials, submissionImplemented: false }) + '\n')
    },
    inspect: async (cwd) => {
      await mkdir(dirname(destination), { recursive: true })
      await cp(join(cwd, '.dsh/pilot'), destination, { recursive: true, force: false, errorOnExist: true })
      const verifier = fileURLToPath(new URL('../../../scripts/rlm-eval-offline/pilot_receipts.py', import.meta.url))
      await promisify(execFile)(process.env.DSH_OFFLINE_PYTHON ?? 'python3', ['-B', verifier,
        '--bundle', destination, '--out', join(destination, 'verified.json')])
      const verified: unknown = JSON.parse(await readFile(join(destination, 'verified.json'), 'utf8'))
      expect(verified).toMatchObject({ scope: 'local_fake_receipts_only', missing: [],
        actual_http_model_requests: 0, experimentReady: false, paidLaunchAllowed: false })
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    fakeOnly: true, scheduled: 16, executions: 16,
    arms: ['chunk_map_reduce', 'codeact_bm25', 'rlm_full', 'rlm_nosub'],
    terminalCounts: { completed: 16 }, diagnostics: ['failed', 'unknown'],
    actualHttpModelRequests: 0, paidLaunchAllowed: false, experimentReady: false,
  })
}, 190_000)
