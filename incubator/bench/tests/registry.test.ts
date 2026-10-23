/**
 * Registry behavior: built-in graders, registrations, duplicate refusal, and
 * removal when a suite plugin fiber is disposed. The Loader composition is
 * proven by tools/bench-plugin-test.mjs, which boots the built package.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BenchRegistry } from '../src/index.js'
import type { BenchGrader, BenchSuite, BenchSuiteId } from '../src/index.js'

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
    const registry = context.solarBenchmarks
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
    context.solarBenchmarks.registerSuite(suite('a'))
    expect(() => context!.solarBenchmarks.registerSuite(suite('a'))).toThrow(/benchmark suite "a" is already registered/)
    expect(() => context!.solarBenchmarks.registerGrader({ ...grader, kind: 'command-exit' })).toThrow(/benchmark grader "command-exit" is already registered/)
  })

  it('removes a suite plugin contribution when its fiber is disposed (HMR safety)', async () => {
    context = new Context()
    await context.plugin(BenchRegistry)
    const fiber = context.plugin({
      inject: ['solarBenchmarks'],
      apply(ctx: Context) {
        ctx.solarBenchmarks.registerSuite(suite('hmr'))
        ctx.solarBenchmarks.registerGrader(grader)
      },
    })
    await fiber
    expect(context.solarBenchmarks.suite('hmr' as BenchSuiteId)).toBeDefined()
    await fiber.dispose()
    expect(context.solarBenchmarks.suite('hmr' as BenchSuiteId)).toBeUndefined()
    expect(context.solarBenchmarks.grader('custom')).toBeUndefined()
  })
})
