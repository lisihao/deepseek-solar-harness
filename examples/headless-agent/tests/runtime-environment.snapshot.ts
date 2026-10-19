import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('keeps host environment variables out of root, child and recovered REPL cells', async () => {
  const driver = fileURLToPath(new URL('../fixtures/runtime-environment.mjs', import.meta.url))
  const config = fileURLToPath(new URL('../runtime-environment.cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'RLM cell environment', tempDirPrefix: 'dsh-runtime-environment-',
    binScript: driver, libBinScript: driver, configPath: config, binArgs: [config],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  expect(JSON.parse(result.stdout)).toEqual({
    root: { environmentSize: 0, task: 'explicit root task' },
    child: { environmentSize: 0, task: 'explicit child task' },
    recovered: { environmentSize: 0, task: 'explicit root task' },
    parentEnvironmentUnchanged: true,
    actualHttpModelRequests: 0,
  })
})
