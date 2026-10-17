import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { describe, expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../standalone-rlm.cordis.yml', import.meta.url))
const binScript = fileURLToPath(new URL('../../../packages/physical-operator/physical-operator-rlm/tests/fixtures/loader-driver.ts', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

describe('standalone RLM runnable example snapshots', () => {
  for (const driver of ['api', 'codex'] as const) {
    it(`runs the real Host, tool, daemon and shared RLM owner with keyless ${driver} transport`, async () => {
      const result = await runLoaderSmoke({
        label: `standalone RLM ${driver} Loader`, tempDirPrefix: 'standalone-rlm-loader-',
        binScript, libBinScript: binScript, configPath, tsconfigPath,
        env: { DSH_RLM_FIXTURE_DRIVER: driver },
      })
      const actual: unknown = JSON.parse(result.stdout)
      expect(actual).toEqual({
        driver, task: 'Analyze the complete two-part fixture input.',
        output: 'Standalone RLM completed: first original part; second original part; result=2.',
        originalBusinessRuns: 1, fullContextRetained: true,
        apiPhysicalRequests: driver === 'api' ? 2 : 0,
        residentPhysicalRequests: driver === 'codex' ? 1 : 0,
        wrapperUsageAbsent: true, innerToolResultObserved: driver === 'api',
      })
      const snapshot = fileURLToPath(new URL(`./snapshots/standalone-rlm-${driver}.expected.json`, import.meta.url))
      const text = JSON.stringify(actual, null, 2) + '\n'
      if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(snapshot, text)
      expect(text).toBe(await readFile(snapshot, 'utf8'))
    }, LOADER_SMOKE_TEST_TIMEOUT_MS)
  }
})
