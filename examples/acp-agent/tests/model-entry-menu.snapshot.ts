/** Keyless Loader snapshot for the Solar product's model-menu entries. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: the model menu offers DeepSeek, Codex\'s two newest models, and ChatGPT Web across refreshes and a restart', async () => {
  const driver = fileURLToPath(new URL('./fixtures/model-entry-menu/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/model-entry-menu/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'model-entry-menu keyless example',
    tempDirPrefix: 'dsh-model-entry-menu-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/model-entry-menu/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
