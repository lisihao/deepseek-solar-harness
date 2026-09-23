/** Keyless snapshot of the runnable ChatGPT composer Loader example. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: chatgpt-composer waits for the initialized composer before submitting', async () => {
  const driver = fileURLToPath(new URL('./fixtures/chatgpt-composer/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/chatgpt-composer/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'chatgpt-composer keyless example',
    tempDirPrefix: 'dsh-chatgpt-composer-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/chatgpt-composer/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
