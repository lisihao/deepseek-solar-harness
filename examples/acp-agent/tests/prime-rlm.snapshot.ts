/** Keyless snapshot of the runnable Prime/RLM Loader example. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: prime-rlm preserves strict inheritance and sealed execution inputs', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm keyless example',
    tempDirPrefix: 'dsh-prime-rlm-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
