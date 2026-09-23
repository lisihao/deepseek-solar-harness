/** Keyless Loader snapshot for a UI-equivalent ChatGPT Web model switch. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: a selected ChatGPT Web model outranks the retained Claude collaboration preference', async () => {
  const driver = fileURLToPath(new URL('./fixtures/model-route-switch/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/model-route-switch/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'model-route-switch keyless example',
    tempDirPrefix: 'dsh-model-route-switch-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/model-route-switch/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
