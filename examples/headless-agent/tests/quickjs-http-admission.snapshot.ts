import { cp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

it('uses the selected source QuickJS guest and binds actual local HTTP sends to root, child, tool-round and unknown ledger entries', async () => {
  const driver = fileURLToPath(new URL('../fixtures/quickjs-http-admission.mjs', import.meta.url))
  const config = fileURLToPath(new URL('../quickjs-http-admission.cordis.yml', import.meta.url))
  const result = await runLoaderSmoke({
    label: 'QuickJS HTTP admission', tempDirPrefix: 'dsh-quickjs-http-admission-', binScript: driver, libBinScript: driver,
    configPath: config, binArgs: [config],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    inspect: async (cwd) => {
      const destination = process.env.DSH_HTTP_TEST_ARTIFACTS
      if (!destination) return
      await mkdir(destination)
      for (const name of ['http-evidence.json', 'root-child-tool', 'strict-refusal', 'unknown-then-success', 'unknown-holds-slot']) {
        await cp(join(cwd, '.dsh', name), join(destination, name), { recursive: true, errorOnExist: true, force: false })
      }
    },
  })
  expect(JSON.parse(result.stdout)).toEqual({
    fakeProvider: true, guestBackend: 'quickjs-wasm', actualExternalModelRequests: 0, actualLocalHttpSends: 6,
    scenarios: ['root-child-tool', 'strict-refusal', 'unknown-then-success', 'unknown-holds-slot'],
  })
})
