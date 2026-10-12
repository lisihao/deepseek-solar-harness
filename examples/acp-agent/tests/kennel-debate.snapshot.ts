/** Keyless snapshot of the kennel Debate: members argue as roster roles through the real daemon through Loader. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: kennel-debate runs a Debate whose roster is a set of kennel members', async () => {
  const driver = fileURLToPath(new URL('./fixtures/kennel-debate/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/kennel-debate/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'kennel-debate keyless example', tempDirPrefix: 'dsh-kennel-debate-snapshot-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/kennel-debate/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
