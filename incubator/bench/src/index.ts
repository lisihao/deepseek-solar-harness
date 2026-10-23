/**
 * @lisihao/dsh-solar-bench — ablation benchmarks for DSH plugins. The host
 * row mounts the suite/grader registry with the bundled `dsh-native` suite,
 * the experiment runtime over `$DSH_HOME/solar/bench/ledgers`, and an
 * owner-only Remote service that the Settings → Benchmarks page reads.
 * Experiments are run from the command line (`lib/cli.js`), never from the app.
 *
 * @module @lisihao/dsh-solar-bench
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { BenchLedgersControl, createLedgersApi } from './control.js'
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
export { BenchLedgersControl, createLedgersApi } from './control.js'
export { DSH_NATIVE_SUITE_DIR } from './suite.js'

/** Cordis plugin name. */
export const name = 'solar-bench'

/** Launcher of the official app's bundled CLI (the target of `~/.local/bin/dsh`). */
export const APP_DSH_LAUNCHER = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** The plugin's data directory under the Harness home. */
export const benchDataDir = (home = resolveDshHome()): string => join(home, 'solar', 'bench')

/** Plugin config. */
export interface Config {
  /** Absolute ledger root; empty means `$DSH_HOME/solar/bench/ledgers`. */
  ledgerRoot: string
  /** Launcher argv prefix of `dsh`, recorded for experiment runs; the app itself never starts runs. */
  launcher: string[]
  /** USD per million tokens, by model id. */
  prices: ModelPrice[]
  /** Analysis settings applied to every served experiment. */
  analysis: AnalysisOptions
}

export const Config: z<Config> = z.object({
  ledgerRoot: z.string().default(''),
  launcher: z.array(z.string()).default([APP_DSH_LAUNCHER]),
  prices: z.array(z.object({
    model: z.string().required(),
    input: z.number().min(0).required(),
    output: z.number().min(0).required(),
    cacheRead: z.number().min(0),
  })).default([]),
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
    runTimeoutMs: 600_000,
    prices: config.prices,
    providerFailureCodes: [...PROVIDER_FAILURE_CODES],
  })
  new BenchLedgersControl(ctx, createLedgersApi(runtime, config.analysis))
}
