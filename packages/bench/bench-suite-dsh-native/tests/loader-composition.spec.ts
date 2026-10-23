/**
 * REAL-composition proof: the shipped YAML rows (registry + suite plugin)
 * boot through the vendored Loader and serve the suite's tasks.
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
import type { BenchSuiteId } from '@deepseek-ai/dsh-bench'
import * as Suite from '@deepseek-ai/dsh-bench-suite-dsh-native'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('registers dsh-native with its tasks', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-bench-suite-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: benchmarks',
      "  name: '@deepseek-ai/dsh-bench'",
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
    const suite = context.benchmarks.suite('dsh-native' as BenchSuiteId)
    expect((await suite!.load()).map(task => task.id)).toEqual(['fix-sum-bug', 'count-lines', 'shell-listing', 'rename-function', 'fix-range', 'json-port', 'count-todos', 'is-palindrome', 'missing-await', 'csv-sum', 'validate-input', 'locate-definition', 'fix-import', 'sort-by-age'])
  })
})
