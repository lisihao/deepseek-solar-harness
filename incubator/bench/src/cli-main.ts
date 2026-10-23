/**
 * The benchmark command:
 *
 * - `run <experiment.yml> [--yes] [--max-usd <n>] [--launcher <path>]...` prints
 *   the plan, starts runs only with `--yes`, reports progress, stops once priced
 *   runs exceed `--max-usd`, and prints the analysis in plain language.
 * - `import <legacy-ledger-dir>` copies a DSH 3.x ledger into this plugin's root.
 * - `list` prints the recorded experiments.
 *
 * Ledgers live under `$DSH_HOME/solar/bench/ledgers`, where the Settings page reads them.
 * @module @lisihao/dsh-solar-bench/cli-main
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { analyzeExperiment } from './analysis.js'
import { loadDeclarativeSuite } from './declarative.js'
import { readExperiment } from './experiment.js'
import { importLegacyLedger } from './import.js'
import { BenchRegistry } from './registry.js'
import { BenchRuntime, PROVIDER_FAILURE_CODES, RUN_TEMPLATE_FILES } from './runtime.js'
import { DSH_NATIVE_SUITE_DIR } from './suite.js'
import type { ModelPrice } from './metrics.js'
import type { AnalysisOptions, Comparison, Experiment, ExperimentAnalysis, RunProgress, VariantSummary } from './types.js'

/** Exit code when the plan was printed but nothing ran. */
export const EXIT_UNCONFIRMED = 2

/** Launcher of the official app's bundled CLI. */
const APP_DSH_LAUNCHER = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

/** Analysis settings of the printed summary; the Settings page uses the same defaults. */
const ANALYSIS: AnalysisOptions = { confidence: 0.95, resamples: 2000, seed: 1, margin: 0.05, minTasks: 10, invalidTolerance: 0.1 }

/** Process-facing effects; tests substitute captures. */
export const io: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown }; env: NodeJS.ProcessEnv } = {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
}

const USAGE = `Usage:
  node <plugin>/lib/cli.js run <experiment.yml> [--yes] [--max-usd <usd>] [--launcher <path>]... [--concurrency <n>] [--prices <prices.json>]
  node <plugin>/lib/cli.js import <dsh-3.x-ledger-dir>
  node <plugin>/lib/cli.js list
`

const percent = (value: number | null): string => value === null ? '—' : `${(value * 100).toFixed(1)}%`
const points = (value: number): string => `${value >= 0 ? '+' : '−'}${Math.abs(value * 100).toFixed(1)} pts`
const dollars = (value: number | null): string => value === null ? '—' : `$${value.toFixed(4)}`
const seconds = (value: number | null): string => value === null ? '—' : `${(value / 1000).toFixed(1)}s`

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
  for (const entry of analysis.variants.filter(item => item.flakyTasks.length > 0)) {
    lines.push('', `${entry.variant}: results differ between repetitions on ${entry.flakyTasks.join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

function usd(value: string): number {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`--max-usd expects a positive number of US dollars, got ${JSON.stringify(value)}`)
  return amount
}

const priceTable = z.array(z.object({
  model: z.string().min(1),
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
}).strict())

/**
 * Read a price table: a JSON array of `{ model, input, output, cacheRead? }` in USD per million tokens.
 * @param file - the JSON file.
 * @returns the validated table.
 */
async function readPrices(file: string): Promise<ModelPrice[]> {
  const parsed = priceTable.safeParse(JSON.parse(await readFile(file, 'utf8')))
  if (!parsed.success) throw new Error(`${file}: ${z.prettifyError(parsed.error)}`)
  return parsed.data.map(price => price.cacheRead === undefined ? { model: price.model, input: price.input, output: price.output } : { ...price, cacheRead: price.cacheRead })
}

/** Options of {@link runCommand}. */
interface RunFlags {
  experiment: string
  confirmed: boolean
  maxUsd?: number
  launcher: string[]
  concurrency: number
  home: string
  prices: ModelPrice[]
}

async function runCommand(flags: RunFlags, signal: AbortSignal): Promise<number> {
  const ctx = new Context()
  try {
    let registry: BenchRegistry | undefined
    let runtime: BenchRuntime | undefined
    await ctx.plugin({
      name: 'solar-bench-cli',
      apply: async (inner: Context) => {
        registry = new BenchRegistry(inner)
        registry.registerSuite(await loadDeclarativeSuite(DSH_NATIVE_SUITE_DIR))
        runtime = new BenchRuntime(inner, {
          command: flags.launcher,
          templateHome: flags.home,
          templateFiles: [...RUN_TEMPLATE_FILES],
          ledgerRoot: join(flags.home, 'solar', 'bench', 'ledgers'),
          concurrency: flags.concurrency,
          runTimeoutMs: 600_000,
          prices: flags.prices,
          providerFailureCodes: [...PROVIDER_FAILURE_CODES],
        })
      },
    })
    if (registry === undefined || runtime === undefined) throw new Error('benchmark services did not start')
    const experiment = await readExperiment(flags.experiment)
    const suite = registry.suite(experiment.suite)
    if (suite === undefined) throw new Error(`benchmark suite ${JSON.stringify(experiment.suite)} is not registered`)
    const subset = experiment.tasks === undefined ? undefined : new Set<string>(experiment.tasks)
    const tasks = (await suite.load()).filter(task => subset === undefined || subset.has(task.id))
    const total = tasks.length * experiment.variants.length * experiment.repetitions
    const recorded = (await runtime.ledger(experiment.id))?.records.length ?? 0
    io.stdout.write([
      `Experiment ${experiment.id}: suite ${suite.id} v${suite.version}, ${String(tasks.length)} tasks × ${String(experiment.variants.length)} variants × ${String(experiment.repetitions)} repetitions = ${String(total)} runs (${String(recorded)} already recorded)`,
      ...experiment.variants.map((variant, index) =>
        `  ${index === 0 ? 'baseline' : 'variant '} ${variant.id}${variant.patches.length === 0 ? '' : `: ${variant.patches.join(', ')}`}`),
      `Children run: ${flags.launcher.join(' ')} --profile ${experiment.profile}`,
      `Ledger: ${join(runtime.ledgerRoot, experiment.id)}`,
      flags.maxUsd === undefined ? 'No spending limit.' : `Stops once priced runs cost more than $${flags.maxUsd.toFixed(2)}.`,
      '',
    ].join('\n'))
    const credential = (io.env.DEEPSEEK_API_KEY ?? '') !== '' || existsSync(join(flags.home, '.credentials.yaml'))
    if (!credential) throw new Error(`no model credential: set DEEPSEEK_API_KEY, or create ${join(flags.home, '.credentials.yaml')}`)
    if (!flags.confirmed) {
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
      if (flags.maxUsd !== undefined && spent > flags.maxUsd) budget.abort(new Error(`spending limit reached: $${spent.toFixed(4)} > $${flags.maxUsd.toFixed(2)}`))
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
    io.stdout.write(summarize(experiment, analyzeExperiment(experiment, records, ANALYSIS)))
    return 0
  } finally {
    await ctx.fiber.dispose()
  }
}

/**
 * Run the command line.
 * @param argv - arguments after the script.
 * @param signal - interrupts a running experiment.
 * @returns the process exit code.
 */
export async function main(argv: readonly string[], signal: AbortSignal = new AbortController().signal): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        'yes': { type: 'boolean', short: 'y' },
        'max-usd': { type: 'string' },
        'launcher': { type: 'string', multiple: true },
        'concurrency': { type: 'string' },
        'prices': { type: 'string' },
        'help': { type: 'boolean', short: 'h' },
      },
    })
    const [command, target] = positionals
    const home = resolveDshHome(undefined, io.env)
    const ledgerRoot = join(home, 'solar', 'bench', 'ledgers')
    if (values.help === true || command === undefined) {
      io.stdout.write(USAGE)
      return values.help === true ? 0 : 1
    }
    if (command === 'import' && target !== undefined && positionals.length === 2) {
      const result = await importLegacyLedger(target, ledgerRoot)
      io.stdout.write(`${result.outcome === 'copied' ? 'Imported' : 'Already imported'} ${result.id}: ${String(result.records)} runs (ledger format ${String(result.formatVersion)}) at ${result.target}\n`)
      return 0
    }
    if (command === 'list' && positionals.length === 1) {
      const { listExperimentIds } = await import('./ledger.js')
      const ids = await listExperimentIds(ledgerRoot)
      io.stdout.write(ids.length === 0 ? `No experiments under ${ledgerRoot}\n` : `${ids.join('\n')}\n`)
      return 0
    }
    if (command === 'run' && target !== undefined && positionals.length === 2) {
      const concurrency = values.concurrency === undefined ? 1 : Number(values.concurrency)
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('--concurrency expects a positive integer')
      const flags: RunFlags = {
        experiment: target,
        confirmed: values.yes === true,
        launcher: values.launcher ?? [APP_DSH_LAUNCHER],
        concurrency,
        home,
        prices: values.prices === undefined ? [] : await readPrices(values.prices),
      }
      if (values['max-usd'] !== undefined) flags.maxUsd = usd(values['max-usd'])
      return await runCommand(flags, signal)
    }
    io.stderr.write(USAGE)
    return 1
  } catch (error) {
    io.stderr.write(`dsh-solar-bench: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
