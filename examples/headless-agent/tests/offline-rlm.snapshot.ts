import { cp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, resolveExampleMode, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const binScript = fileURLToPath(new URL('../../../packages/physical-operator/physical-operator-rlm/tests/fixtures/offline-rlm-driver.mjs', import.meta.url))
it('assembles actual paired Worker/Runtime execution with one ledger and fake transport', async () => {
  const result = await runLoaderSmoke({
    label: 'offline RLM common-loop assembly', tempDirPrefix: 'dsh-offline-rlm-loader-',
    binScript, libBinScript: binScript,
    configPath: fileURLToPath(new URL('../offline-rlm.cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const destination = fileURLToPath(new URL('../../../.artifacts/offline-rlm/' + resolveExampleMode(), import.meta.url))
      await mkdir(destination, { recursive: true })
      await cp(join(cwd, '.dsh'), destination, { recursive: true, force: true })
    },
  })
  expect(JSON.parse(result.stdout)).toEqual(JSON.parse(await readFile(
    new URL('./snapshots/offline-rlm.expected.json', import.meta.url), 'utf8')))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
