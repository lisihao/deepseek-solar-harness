/** Keyless snapshot of the kennel Host, tool Consumer, and durable room reads through Loader. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: kennel-ai-dispatch routes ordinary user messages through AI into certified member tasks', async () => {
  const driver = fileURLToPath(new URL('./fixtures/kennel-ai-dispatch/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/kennel-ai-dispatch/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'kennel-ai-dispatch keyless example', tempDirPrefix: 'dsh-kennel-ai-dispatch-snapshot-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/kennel-ai-dispatch/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
