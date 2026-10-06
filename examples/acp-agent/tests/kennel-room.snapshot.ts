/** Keyless snapshot of the kennel Host, tool Consumer, and durable room reads through Loader. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: kennel-room preserves confirmed recipients and authoritative room evidence', async () => {
  const driver = fileURLToPath(new URL('./fixtures/kennel-room/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/kennel-room/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'kennel-room keyless example', tempDirPrefix: 'dsh-kennel-room-snapshot-',
    binScript: driver, libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/kennel-room/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
