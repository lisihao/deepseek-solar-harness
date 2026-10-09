/** Keyless snapshot of the kennel review: members review a finished task through the real daemon through Loader. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: kennel-review has other members review a finished task read-only', async () => {
  const driver = fileURLToPath(new URL('./fixtures/kennel-review/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/kennel-review/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'kennel-review keyless example', tempDirPrefix: 'dsh-kennel-review-snapshot-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/kennel-review/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
