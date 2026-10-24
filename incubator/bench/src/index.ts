/**
 * @lisihao/dsh-solar-bench — ablation benchmarks for DSH plugins. The host
 * row mounts the suite/grader registry with the bundled `dsh-native` suite,
 * the experiment runtime over `$DSH_HOME/solar/bench/ledgers`, and an
 * owner-only Remote service that the Settings → Benchmarks page reads.
 * The right sidebar's Benchmarks tab starts, observes and stops experiments
 * (`solarBenchRuns`); `lib/cli.js` runs the same experiments from a shell.
 *
 * @module @lisihao/dsh-solar-bench
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { BenchLedgersControl, BenchRunsControl, createLedgersApi } from './control.js'
import { BenchRunManager } from './runs.js'
import { loadDeclarativeSuite } from './declarative.js'
import { BenchRegistry } from './registry.js'
import { AnalysisConfig, BenchRuntime, PROVIDER_FAILURE_CODES, RUN_TEMPLATE_FILES } from './runtime.js'
import { DSH_NATIVE_SUITE_DIR } from './suite.js'
import type { ModelPrice } from './metrics.js'
import type { AnalysisOptions } from './types.js'

export type * from './types.js'
export type * from './contracts.js'
export type { ModelPrice } from './metrics.js'
export { analyzeExperiment } from './analysis.js'
export { loadDeclarativeSuite, SUITE_FILE, TASKS_FILE } from './declarative.js'
export { builtinGraders, commandExitGrader, fileContainsGrader, sessionEventGrader } from './graders.js'
export { readExperiment } from './experiment.js'
export { importLegacyLedger } from './import.js'
export { ExperimentLedger, LEDGER_FORMAT_VERSION } from './ledger.js'
export { BenchRegistry } from './registry.js'
export { AnalysisConfig, BenchRuntime, PROVIDER_FAILURE_CODES, RUN_TEMPLATE_FILES } from './runtime.js'
export type { Config as RuntimeConfig } from './runtime.js'
export { BenchLedgersControl, BenchRunsControl, createLedgersApi } from './control.js'
export { BenchRunManager, listPluginCandidates, RUN_PROFILE, variantIdOf, writeRunTemplate } from './runs.js'
export type * from './runs.js'
export { DSH_NATIVE_SUITE_DIR } from './suite.js'

/** Cordis plugin name. */
export const name = 'solar-bench'

/** Launcher of the official app's bundled CLI (the target of `~/.local/bin/dsh`). */
export const APP_DSH_LAUNCHER = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** The plugin's data directory under the Harness home. */
export const benchDataDir = (home = resolveDshHome()): string => join(home, 'solar', 'bench')

/**
 * USD per million tokens. The deepseek-v4-flash row is the table the DSH 3.x
 * ablation ledger was priced with, recovered from its records: ¥2 / ¥0.04 /
 * ¥8 per million input / cache-hit / output tokens at 7.2 CNY per USD.
 */
export const DEFAULT_PRICES: readonly ModelPrice[] = [
  { model: 'deepseek-v4-flash', input: 0.2778, cacheRead: 0.0056, output: 1.1111 },
  // rc.2's default model id for one-shot runs; which id assistant messages log in rc.2 is not yet observed.
  { model: 'deepseek-flash', input: 0.2778, cacheRead: 0.0056, output: 1.1111 },
]

/** Plugin config. */
export interface Config {
  /** Absolute ledger root; empty means `$DSH_HOME/solar/bench/ledgers`. */
  ledgerRoot: string
  /** Launcher argv prefix of `dsh` for run children. */
  launcher: string[]
  /** Profile under `$DSH_HOME/profiles` whose installed plugins can be compared. */
  sourceProfile: string
  /** Wall-time limit of one run. */
  runTimeoutMs: number
  /** USD per million tokens, by model id. */
  prices: ModelPrice[]
  /** Analysis settings applied to every served experiment. */
  analysis: AnalysisOptions
}

export const Config: z<Config> = z.object({
  ledgerRoot: z.string().default(''),
  launcher: z.array(z.string()).default([APP_DSH_LAUNCHER]),
  sourceProfile: z.string().default('desktop'),
  runTimeoutMs: z.natural().min(10_000).default(600_000),
  prices: z.array(z.object({
    model: z.string().required(),
    input: z.number().min(0).required(),
    output: z.number().min(0).required(),
    cacheRead: z.number().min(0),
  })).default([...DEFAULT_PRICES]),
  analysis: AnalysisConfig,
})

/**
 * Mount the registry, the bundled suite, the runtime, and the read service.
 * @param ctx - plugin context.
 * @param config - plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const home = resolveDshHome()
  const ledgerRoot = config.ledgerRoot === '' ? join(benchDataDir(home), 'ledgers') : config.ledgerRoot
  if (!ledgerRoot.startsWith('/')) throw new Error(`BENCH_CONFIG_INVALID: ledgerRoot must be absolute: ${ledgerRoot}`)
  const registry = new BenchRegistry(ctx)
  registry.registerSuite(await loadDeclarativeSuite(DSH_NATIVE_SUITE_DIR))
  const runtime = new BenchRuntime(ctx, {
    command: config.launcher,
    templateHome: home,
    templateFiles: [...RUN_TEMPLATE_FILES],
    ledgerRoot,
    concurrency: 1,
    runTimeoutMs: config.runTimeoutMs,
    prices: config.prices,
    providerFailureCodes: [...PROVIDER_FAILURE_CODES],
  })
  new BenchLedgersControl(ctx, createLedgersApi(runtime, config.analysis))
  const runs = new BenchRunManager({
    registry,
    runtime,
    sourceProfile: join(home, 'profiles', config.sourceProfile),
    templateHome: join(benchDataDir(home), 'template'),
    self: '@lisihao/dsh-solar-bench',
    minTasks: config.analysis.minTasks,
    credential: async () => {
      const value = (await ctx.get('credentials')?.resolve(credentialRef('DEEPSEEK_API_KEY')))?.value
      return value === undefined || value === '' ? undefined : value
    },
  })
  new BenchRunsControl(ctx, runs)
  // Closing the app or unloading the plugin must not leave dsh children running.
  ctx.effect(() => () => runs.dispose(), 'solar-bench: stop runs on dispose')
}
