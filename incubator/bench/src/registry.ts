/**
 * Service Definition of the benchmark capability: the `ctx.solarBenchmarks`
 * registry of suites and graders that suite plugins contribute to and the
 * benchmark runner reads. Ships the declarative suite format and the
 * built-in graders, so most benchmarks are added as data in a suite package
 * without new code.
 *
 * @module @lisihao/dsh-solar-bench/registry
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { builtinGraders } from './graders.js'
import type { BenchGrader, BenchSuite, BenchSuiteId } from './types.js'


declare module '@deepseek-ai/cordis' {
  interface Context {
    solarBenchmarks: BenchRegistry
  }
}

/**
 * Registry of benchmark suites and graders. Each registration is an effect on
 * the calling context's fiber, so unloading a suite plugin removes its suites
 * and graders. Duplicate suite ids and grader kinds are refused; built-in
 * graders occupy their kinds for the registry's lifetime.
 */
export class BenchRegistry extends Service {
  private readonly suiteMap = new Map<BenchSuiteId, BenchSuite>()
  private readonly graderMap = new Map<string, BenchGrader>()

  /**
   * Create and install the registry as `ctx.solarBenchmarks`, with the built-in graders registered.
   * @param ctx - Cordis context that owns the service.
   */
  constructor(ctx: Context) {
    super(ctx, 'solarBenchmarks')
    for (const grader of builtinGraders) this.graderMap.set(grader.kind, grader)
  }

  /**
   * Register a suite under its id.
   * @param suite - the suite; its id must not already be registered.
   * @returns the disposer that unregisters it.
   */
  registerSuite(suite: BenchSuite): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.suiteMap.has(suite.id)) throw new Error(`benchmark suite ${JSON.stringify(suite.id)} is already registered`)
      this.suiteMap.set(suite.id, suite)
      return () => {
        this.suiteMap.delete(suite.id)
      }
    }, 'solarBenchmarks.registerSuite()')
    return () => void dispose()
  }

  /**
   * Register a grader under its kind.
   * @param grader - the grader; its kind must not already be registered.
   * @returns the disposer that unregisters it.
   */
  registerGrader(grader: BenchGrader): () => void {
    const dispose = this.ctx.effect(() => {
      if (this.graderMap.has(grader.kind)) throw new Error(`benchmark grader ${JSON.stringify(grader.kind)} is already registered`)
      this.graderMap.set(grader.kind, grader)
      return () => {
        this.graderMap.delete(grader.kind)
      }
    }, 'solarBenchmarks.registerGrader()')
    return () => void dispose()
  }

  /**
   * Look up a suite.
   * @param id - suite id.
   * @returns the suite, or `undefined` when none is registered under `id`.
   */
  suite(id: BenchSuiteId): BenchSuite | undefined {
    return this.suiteMap.get(id)
  }

  /**
   * List registered suites.
   * @returns the suites in registration order.
   */
  suites(): BenchSuite[] {
    return [...this.suiteMap.values()]
  }

  /**
   * Look up a grader.
   * @param kind - grader kind.
   * @returns the grader, or `undefined` when none is registered under `kind`.
   */
  grader(kind: string): BenchGrader | undefined {
    return this.graderMap.get(kind)
  }
}

