/**
 * Registry behavior plus the REAL-composition proof: the shipped YAML rows
 * boot through the vendored Loader and a suite plugin registers into the
 * registry; disposing a suite plugin's fiber removes its contributions.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BenchRegistry from '@deepseek-ai/dsh-bench'
import type { BenchGrader, BenchSuite, BenchSuiteId } from '@deepseek-ai/dsh-bench'

const suite = (id: string): BenchSuite => ({ id: id as BenchSuiteId, version: '1', description: 'd', load: () => Promise.resolve([]) })
const grader: BenchGrader = { kind: 'custom', version: 1, validate: () => {}, grade: () => Promise.resolve({ pass: true, score: 1, details: '' }) }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('BenchRegistry', () => {
  it('serves built-in graders and registered contributions until disposed', async () => {
    context = new Context()
    await context.plugin(BenchRegistry)
    const registry = context.benchmarks
    expect(['command-exit', 'file-contains', 'session-event'].every(kind => registry.grader(kind) !== undefined)).toBe(true)
    const disposeSuite = registry.registerSuite(suite('a'))
    const disposeGrader = registry.registerGrader(grader)
    expect(registry.suite('a' as BenchSuiteId)?.id).toBe('a')
    expect(registry.suites().map(entry => entry.id)).toEqual(['a'])
    expect(registry.grader('custom')).toBe(grader)
    disposeSuite()
    disposeGrader()
    expect(registry.suite('a' as BenchSuiteId)).toBeUndefined()
    expect(registry.grader('custom')).toBeUndefined()
  })

  it('refuses duplicate suite ids and grader kinds, including built-in kinds', async () => {
    context = new Context()
    await context.plugin(BenchRegistry)
    context.benchmarks.registerSuite(suite('a'))
    expect(() => context!.benchmarks.registerSuite(suite('a'))).toThrow(/benchmark suite "a" is already registered/)
    expect(() => context!.benchmarks.registerGrader({ ...grader, kind: 'command-exit' })).toThrow(/benchmark grader "command-exit" is already registered/)
  })

  it('boots through the Loader and drops a suite plugin contribution when its fiber is disposed', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-bench-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: benchmarks',
      "  name: '@deepseek-ai/dsh-bench'",
      '- id: demo-suite',
      "  name: 'demo-suite'",
      '',
    ].join('\n'))
    const demoSuite = {
      name: 'demo-suite',
      inject: ['benchmarks'],
      apply(ctx: Context) {
        ctx.benchmarks.registerSuite(suite('demo'))
        ctx.benchmarks.registerGrader(grader)
      },
    }
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-bench', await import('@deepseek-ai/dsh-bench')],
      ['demo-suite', demoSuite],
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
    expect(context.benchmarks.suite('demo' as BenchSuiteId)).toBeDefined()
    expect(context.benchmarks.grader('custom')).toBe(grader)
  })

  it('removes a suite plugin contribution when its fiber is disposed (HMR safety)', async () => {
    context = new Context()
    await context.plugin(BenchRegistry)
    const fiber = context.plugin({
      inject: ['benchmarks'],
      apply(ctx: Context) {
        ctx.benchmarks.registerSuite(suite('hmr'))
        ctx.benchmarks.registerGrader(grader)
      },
    })
    await fiber
    expect(context.benchmarks.suite('hmr' as BenchSuiteId)).toBeDefined()
    await fiber.dispose()
    expect(context.benchmarks.suite('hmr' as BenchSuiteId)).toBeUndefined()
    expect(context.benchmarks.grader('custom')).toBeUndefined()
  })
})
