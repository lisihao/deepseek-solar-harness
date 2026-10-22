/**
 * Product acceptance for `dsh --profile <bench profile> <experiment.yml>`:
 * the built CLI boots a profile over dsh-base + dsh-benchmarks, prints the
 * plan, refuses to run without `--yes`, and with it runs every cell as a real
 * `dsh --profile headless` child against the scripted mock model, then prints
 * the plain-language analysis. Paths and wall times are normalized.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'

const dshBin = fileURLToPath(new URL('../lib/bin.js', import.meta.url))

function profile(name: string, bundles: readonly string[]): string {
  return JSON.stringify({ name: `dsh-profile-${name}`, private: true, dependencies: {}, dsh: { profile: { bundles } } })
}

describe.skipIf(!existsSync(dshBin))('dsh bench profile (built bin)', () => {
  it('prints the plan, waits for --yes, then runs and analyzes the experiment', async () => {
    // The canonical path, because the experiment file's patches print resolved (macOS /tmp is a symlink).
    const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-bench-profile-')))
    const server = await startMockLlmServer({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true })
    try {
      const home = join(root, 'home')
      await mkdir(join(home, 'profiles', 'headless'), { recursive: true })
      await mkdir(join(home, 'profiles', 'bench'), { recursive: true })
      await writeFile(join(home, 'profiles', 'headless', 'package.json'), profile('headless', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']))
      await writeFile(join(home, 'profiles', 'bench', 'package.json'), profile('bench', ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-benchmarks']))
      await writeFile(join(root, 'retry-off.yml'), '- id: llm-retry\n  disabled: true\n')
      await writeFile(join(root, 'exp.yml'), [
        'id: keyless-demo', 'suite: dsh-native', 'profile: headless', 'repetitions: 1', 'tasks: [count-lines, shell-listing]',
        'variants:', '  - id: baseline', '  - id: retry-off', '    patches: [./retry-off.yml]', '',
      ].join('\n'))
      const run = (args: string[]) => execa(process.execPath, [dshBin, '--profile', 'bench', 'exp.yml', ...args], {
        cwd: root,
        input: '',
        reject: false,
        timeout: 240_000,
        env: { DSH_HOME: home, DEEPSEEK_BASE_URL: server.baseURL, DEEPSEEK_API_KEY: 'mock-key' },
      })
      const normalize = (text: string) => text.replaceAll(root, '{{root}}').replace(/\b\d+\.\ds\b/g, '{{s}}')

      const plan = await run([])
      expect(plan.exitCode).toBe(2)
      expect(normalize(plan.stdout)).toMatchInlineSnapshot(`
        "Experiment keyless-demo: suite dsh-native v1, 2 tasks × 2 variants × 1 repetitions = 4 runs (0 already recorded)
          baseline baseline
          variant  retry-off: {{root}}/retry-off.yml
        No spending limit.
        Nothing ran. Runs call the configured model and can cost money; re-run with --yes to start."
      `)

      const result = await run(['--yes'])
      expect(result.stderr).toBe('')
      expect(result.exitCode).toBe(0)
      expect(normalize(result.stdout)).toMatchInlineSnapshot(`
        "Experiment keyless-demo: suite dsh-native v1, 2 tasks × 2 variants × 1 repetitions = 4 runs (0 already recorded)
          baseline baseline
          variant  retry-off: {{root}}/retry-off.yml
        No spending limit.
        [1/4] baseline count-lines #1: fail
        [2/4] retry-off count-lines #1: fail
        [3/4] baseline shell-listing #1: fail
        [4/4] retry-off shell-listing #1: fail

        Spent $0.0000 on priced runs; 4 runs had no price.

        Results for keyless-demo (suite dsh-native)

        variant    runs  success  any rep  every rep  unmeasurable  cost/run  time/run
        baseline   2     0.0%     0.0%     0.0%       0.0%          —         {{s}}
        retry-off  2     0.0%     0.0%     0.0%       0.0%          —         {{s}}

        Compared with baseline:
          retry-off: too few tasks to judge: 2 paired, at least 10 needed"
      `)
      const ledger = await readFile(join(home, 'bench', 'keyless-demo', 'runs.jsonl'), 'utf8')
      expect(ledger.trim().split('\n')).toHaveLength(4)
    } finally {
      await server.close()
      await rm(root, { recursive: true, force: true })
    }
  }, 300_000)
})
