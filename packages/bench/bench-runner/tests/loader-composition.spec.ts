/**
 * REAL-composition proof: the shipped YAML rows (registry, runtime with its
 * config, suite) boot through the vendored Loader, a row without a launcher
 * mounts a read-only runtime, and a row missing a required field fails to load.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Bench from '@deepseek-ai/dsh-bench'
import * as Runner from '@deepseek-ai/dsh-bench-runner'
import * as Suite from '@deepseek-ai/dsh-bench-suite-dsh-native'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function boot(runnerConfig: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bench-runner-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- id: benchmarks',
    "  name: '@deepseek-ai/dsh-bench'",
    '- id: bench-runner',
    "  name: '@deepseek-ai/dsh-bench-runner'",
    '  config:',
    ...runnerConfig.map(line => `    ${line}`),
    '- id: bench-suite-dsh-native',
    "  name: '@deepseek-ai/dsh-bench-suite-dsh-native'",
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-bench', Bench],
    ['@deepseek-ai/dsh-bench-runner', Runner],
    ['@deepseek-ai/dsh-bench-suite-dsh-native', Suite],
  ])
  context.loader.internal = {
    version: 'v2',
    import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(modules.get(specifier))
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('serves ctx.benchRuntime beside the registry and the dsh-native suite', async () => {
    const ctx = await boot(['command: [node, /abs/bin.js]', 'templateHome: /abs/home', 'templateFiles: []', 'ledgerRoot: /abs/ledger'])
    expect(ctx.get('benchRuntime')).toBeInstanceOf(Runner.BenchRuntime)
    expect(ctx.benchmarks.suites().map(suite => suite.id)).toEqual(['dsh-native'])
  })

  it('mounts a read-only runtime when the config omits the launcher command', async () => {
    const ctx = await boot(['templateHome: /abs/home', 'templateFiles: []', 'ledgerRoot: /abs/ledger'])
    const experiment = { id: 'e', suite: 'dsh-native', profile: 'headless', repetitions: 1, variants: [] } as unknown as Runner.Experiment
    await expect(ctx.benchRuntime.run(experiment)).rejects.toThrow(/only reads ledgers/)
  })

  it('does not start a runtime whose config omits the ledger root', async () => {
    const ctx = await boot(['templateHome: /abs/home', 'templateFiles: []']).catch(() => context!)
    expect(ctx.get('benchRuntime')).toBeUndefined()
  })
})
