/** Keyless Loader snapshot for the resident ChatGPT Web MCP coordination path. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: a ChatGPT Web resident turn executes two checkpoints and a native task over local MCP', async () => {
  const driver = fileURLToPath(new URL('./fixtures/web-mcp-coordination/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/web-mcp-coordination/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'web-mcp-coordination keyless example',
    tempDirPrefix: 'dsh-web-mcp-coordination-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/web-mcp-coordination/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})
