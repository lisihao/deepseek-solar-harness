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

it('snapshot: prime-rlm-delete keeps a permanently deleted subtree closed to new executions', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-delete/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm-delete/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm-delete keyless example',
    tempDirPrefix: 'dsh-prime-rlm-delete-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-delete/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})

it('snapshot: prime-rlm-terminal keeps a non-success RLM result from being overwritten by a later turn', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-terminal/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm-terminal/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm-terminal keyless example',
    tempDirPrefix: 'dsh-prime-rlm-terminal-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-terminal/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    // The driver starts the production orchestration and Resident daemons and runs two scenarios. Its own limits add up to
    // at most 15 s for the daemons, 15 s for each scenario, and about 10 s to stop both daemons, so this limit leaves the
    // driver room to fail by stage and to reach its cleanup before the launcher's SIGKILL, which would skip it.
    processTimeoutMs: 90_000,
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
