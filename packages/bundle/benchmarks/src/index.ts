/**
 * @deepseek-ai/dsh-benchmarks — opt-in bundle that turns a profile into a
 * one-shot benchmark command. The `bench-cli` row prints the experiment's
 * plan, starts runs only when the user confirmed with `--yes`, reports
 * progress, stops once priced runs exceed `--max-usd`, prints the analysis
 * in plain language, and requests process exit.
 *
 * @module @deepseek-ai/dsh-benchmarks
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { BenchTask } from '@deepseek-ai/dsh-bench'
import { AnalysisConfig, analyzeExperiment, readExperiment } from '@deepseek-ai/dsh-bench-runner'
import type { AnalysisOptions, Comparison, Experiment, ExperimentAnalysis, RunProgress, VariantSummary } from '@deepseek-ai/dsh-bench-runner'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'bench-cli'

/** The registry and the runtime are the command's whole purpose. */
export const inject = ['benchmarks', 'benchRuntime']

/** Plugin config, resolved from the `benchStartup` provider and the bundle patch. */
export interface Config {
  /** Absolute experiment file path. */
  experiment: string
  /** Whether runs may start. */
  confirmed: boolean
  /** Spending ceiling in USD. */
  maxUsd?: number
  /** Where a model credential may come from; at least one must be present before runs start. */
  credentials: {
    /** Environment variables holding an API key. */
    env: string[]
    /** Absolute credential files copied into run homes. */
    files: string[]
  }
  /** Analysis settings for the printed summary. */
  analysis: AnalysisOptions
}

export const Config: z<Config> = z.object({
  experiment: z.string().required(),
  confirmed: z.boolean().required(),
  maxUsd: z.number().min(0),
  credentials: z.object({
    env: z.array(z.string()).required(),
    files: z.array(z.string()).required(),
  }).required(),
  analysis: AnalysisConfig,
})

/** Exit code when the plan was printed but nothing ran. */
export const EXIT_UNCONFIRMED = 2

/** Process-facing effects. */
interface BenchIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/** The process streams the command writes to; tests substitute captures. */
export const internals: { stdout: BenchIo['stdout']; stderr: BenchIo['stderr']; env: NodeJS.ProcessEnv } = {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}

const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const points = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)} pts`
const dollars = (value: number | null): string => value === null ? '—' : `$${value.toFixed(4)}`
const seconds = (value: number | null): string => value === null ? '—' : `${(value / 1000).toFixed(1)}s`

/**
 * Pad cells into aligned columns.
 * @param rows - header row first.
 * @returns the table text.
 */
function table(rows: readonly (readonly string[])[]): string {
  const widths = (rows[0] as readonly string[]).map((_, column) => Math.max(...rows.map(row => (row[column] as string).length)))
  return rows.map(row => row.map((cell, column) => cell.padEnd(widths[column] as number)).join('  ').trimEnd()).join('\n')
}

/**
 * One sentence explaining a comparison.
 * @param comparison - the comparison.
 * @param variants - variant summaries, for invalid rates.
 * @param options - the analysis settings.
 * @returns the sentence.
 */
export function describeComparison(comparison: Comparison, variants: readonly VariantSummary[], options: AnalysisOptions): string {
  const { success } = comparison
  const interval = `${String(options.confidence * 100)}% interval ${points(success.low)} to ${points(success.high)}`
  switch (comparison.verdict) {
    case 'improved':
      return `better: success ${points(success.delta)} (${interval}, ${String(success.tasks)} tasks)`
    case 'regressed':
      return `worse: success ${points(success.delta)} (${interval}, ${String(success.tasks)} tasks)`
    case 'equivalent':
      return `no meaningful difference: success ${points(success.delta)}, within ±${(options.margin * 100).toFixed(1)} pts (${interval})`
    case 'underpowered': {
      const mde = success.mde === null ? '' : `; differences under about ${(success.mde * 100).toFixed(1)} pts cannot be detected`
      return `not enough evidence either way: success ${points(success.delta)} (${interval})${mde}. Add tasks or repetitions.`
    }
    case 'insufficient':
      return `too few tasks to judge: ${String(success.tasks)} paired, at least ${String(options.minTasks)} needed`
    case 'unreliable': {
      const rate = (id: string) => percent(variants.find(entry => entry.variant === id)?.invalidRate ?? null)
      return `not comparable: unmeasurable runs differ (${rate(comparison.variant)} here, ${rate(variants[0]?.variant ?? '')} in the baseline); check the run errors`
    }
  }
}

/**
 * The printed summary of an analysis.
 * @param experiment - the experiment.
 * @param analysis - its analysis.
 * @returns the summary text.
 */
export function summarize(experiment: Experiment, analysis: ExperimentAnalysis): string {
  const header = ['variant', 'runs', 'success', 'any rep', 'every rep', 'unmeasurable', 'cost/run', 'time/run']
  const rows = analysis.variants.map(entry => [
    entry.variant, String(entry.runs), percent(entry.successRate), percent(entry.passAnyRate), percent(entry.passAllRate),
    percent(entry.invalidRate), dollars(entry.meanCostUsd), seconds(entry.meanWallMs),
  ])
  const lines = [`Results for ${experiment.id} (suite ${experiment.suite})`, '', table([header, ...rows])]
  if (analysis.comparisons.length > 0) {
    lines.push('', `Compared with ${analysis.baseline}:`)
    for (const comparison of analysis.comparisons) {
      lines.push(`  ${comparison.variant}: ${describeComparison(comparison, analysis.variants, analysis.options)}`)
    }
  }
  const flaky = analysis.variants.filter(entry => entry.flakyTasks.length > 0)
  for (const entry of flaky) lines.push('', `${entry.variant}: results differ between repetitions on ${entry.flakyTasks.join(', ')}`)
  return `${lines.join('\n')}\n`
}

/**
 * Run the command and return its exit code.
 * @param ctx - plugin context carrying the registry and runtime.
 * @param config - resolved config.
 * @param io - process-facing effects.
 * @param signal - aborted when the tree is disposed.
 * @returns the exit code.
 */
async function main(ctx: Context, config: Config, io: BenchIo, signal: AbortSignal): Promise<number> {
  await ctx.get('loader')?.await()
  const registry = ctx.get('benchmarks')
  const runtime = ctx.get('benchRuntime')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (registry === undefined || runtime === undefined) return 1
  const experiment = await readExperiment(config.experiment)
  const suite = registry.suite(experiment.suite)
  if (suite === undefined) throw new Error(`benchmark suite ${JSON.stringify(experiment.suite)} is not registered`)
  const subset = experiment.tasks === undefined ? undefined : new Set<string>(experiment.tasks)
  const tasks = (await suite.load()).filter((task: BenchTask) => subset === undefined || subset.has(task.id))
  const total = tasks.length * experiment.variants.length * experiment.repetitions
  const recorded = (await runtime.ledger(experiment.id))?.records.length ?? 0
  io.stdout.write([
    `Experiment ${experiment.id}: suite ${suite.id} v${suite.version}, ${String(tasks.length)} tasks × ${String(experiment.variants.length)} variants × ${String(experiment.repetitions)} repetitions = ${String(total)} runs (${String(recorded)} already recorded)`,
    ...experiment.variants.map((variant, index) =>
      `  ${index === 0 ? 'baseline' : 'variant '} ${variant.id}${variant.patches.length === 0 ? '' : `: ${variant.patches.join(', ')}`}`),
    config.maxUsd === undefined ? 'No spending limit.' : `Stops once priced runs cost more than $${config.maxUsd.toFixed(2)}.`,
    '',
  ].join('\n'))
  const credential = config.credentials.env.some(variable => (internals.env[variable] ?? '') !== '') || config.credentials.files.some(file => existsSync(file))
  if (!credential) {
    throw new Error(`no model credential: set ${config.credentials.env.join(' or ')}, or create ${config.credentials.files.join(' or ')}`)
  }
  if (!config.confirmed) {
    io.stdout.write('Nothing ran. Runs call the configured model and can cost money; re-run with --yes to start.\n')
    return EXIT_UNCONFIRMED
  }
  const budget = new AbortController()
  const stop = AbortSignal.any([signal, budget.signal])
  let spent = 0
  let unpriced = 0
  const onProgress = ({ record, done, total: all }: RunProgress): void => {
    const outcome = record.status === 'graded' ? record.grade?.pass === true ? 'pass' : 'fail' : record.status === 'timeout' ? 'timeout' : 'unmeasurable'
    const cost = record.metrics?.costUsd
    if (cost === undefined) unpriced += 1
    else spent += cost
    io.stdout.write(`[${String(done)}/${String(all)}] ${record.cell.variant} ${record.cell.task} #${String(record.cell.rep + 1)}: ${outcome}${record.error === undefined ? '' : ` (${record.error.split('\n')[0] as string})`}\n`)
    if (config.maxUsd !== undefined && spent > config.maxUsd) budget.abort(new Error(`spending limit reached: $${spent.toFixed(4)} > $${config.maxUsd.toFixed(2)}`))
  }
  let records
  try {
    records = await runtime.run(experiment, { signal: stop, onProgress })
  } catch (error) {
    if (!stop.aborted) throw error
    // Both abort sources in this module abort with an Error.
    io.stderr.write(`Stopped: ${(stop.reason as Error).message}. Recorded runs are kept; run the same command again to continue.\n`)
    return 1
  }
  io.stdout.write(`\nSpent $${spent.toFixed(4)} on priced runs${unpriced === 0 ? '' : `; ${String(unpriced)} runs had no price`}.\n\n`)
  io.stdout.write(summarize(experiment, analyzeExperiment(experiment, records, config.analysis)))
  return 0
}

/**
 * Mount the benchmark command.
 * @param ctx - plugin context carrying the registry, runtime, and launcher exit request.
 * @param config - resolved config.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('bench-cli: the launcher must provide ctx.appExit before the tree mounts')
  const io: BenchIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  const disposed = new AbortController()
  ctx.effect(() => () => { disposed.abort(new Error('interrupted')) }, 'bench-cli: abort on dispose')
  void main(ctx, config, io, disposed.signal).then(
    (code) => { io.exit(code) },
    (error: unknown) => {
      io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
      io.exit(1)
    },
  )
}
