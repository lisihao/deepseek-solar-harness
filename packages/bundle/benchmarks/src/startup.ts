/**
 * The benchmark app's command-line provider: it parses
 * `dsh --profile <profile> <experiment.yml> [--yes] [--max-usd <n>]`,
 * resolves the launcher that benchmark runs re-execute, and publishes
 * {@link BENCH_STARTUP_SERVICE}.
 * @module @deepseek-ai/dsh-benchmarks/startup
 */

import { resolve } from 'node:path'
import { Command, InvalidArgumentError } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'bench-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the runner and CLI rows. */
export const BENCH_STARTUP_SERVICE = 'benchStartup'

/** What the bundle rows read from {@link BENCH_STARTUP_SERVICE}. */
export interface BenchStartupValues {
  /** Absolute path of the experiment file. */
  experiment: string
  /** Whether the user confirmed that runs may start (`--yes`). */
  confirmed: boolean
  /** Spending ceiling in USD; the experiment stops once priced runs exceed it. */
  maxUsd?: number
  /** Launcher argv prefix that benchmark runs re-execute. */
  launcher: string[]
}

/**
 * The launcher of this process, for child runs to re-execute.
 * @param execPath - the Node executable (`process.execPath`).
 * @param argv - the process argv (`process.argv`).
 * @returns `[execPath, script]`.
 * @throws Error when the script is not a built `.js` entry: a source launch keeps its
 *   TypeScript loader in `execArgv`, so re-executing `argv` would not start, and benchmark
 *   runs must measure built output.
 */
export function resolveLauncher(execPath: string, argv: readonly string[]): string[] {
  const script = argv[1]
  if (script === undefined || !script.endsWith('.js')) {
    throw new Error(`benchmarks must run from the built CLI (got ${JSON.stringify(script ?? '')}); use: node apps/cli/lib/bin.js --profile <profile> <experiment.yml>`)
  }
  return [execPath, script]
}

/**
 * {@link resolveLauncher} with its refusal as a value.
 * @param execPath - the Node executable.
 * @param argv - the process argv.
 * @returns the launcher, or the refusal message.
 */
function launcherOrReason(execPath: string, argv: readonly string[]): string[] | string {
  try {
    return resolveLauncher(execPath, argv)
  } catch (error) {
    return (error as Error).message
  }
}

/**
 * Parse a USD amount.
 * @param value - the option text.
 * @returns the amount.
 */
function usd(value: string): number {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount <= 0) throw new InvalidArgumentError('expected a positive number of US dollars')
  return amount
}

/**
 * This app's command.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function benchCommand(): Command {
  return new Command()
    .name('dsh --profile bench')
    .description('Run one benchmark experiment, print its analysis, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('<experiment>', 'experiment YAML file')
    .option('-y, --yes', 'start the runs; without it the plan is printed and nothing runs')
    .option('--max-usd <amount>', 'stop once priced runs have cost more than this', usd)
    .addHelpText('after', `
Examples:
  dsh --profile bench ./mnemon.yml          print the plan
  dsh --profile bench ./mnemon.yml --yes    run it
`)
}

/**
 * Parse and provide the invocation as an ordinary Cordis service. Help, a
 * usage error, or a source launch leaves the service unprovided.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = benchCommand()
  program.action((experiment: string, options: { yes?: true; maxUsd?: number }) => {
    const launcher = launcherOrReason(process.execPath, process.argv)
    // program.error throws a CommanderError that parseCmdline turns into the exit code.
    if (typeof launcher === 'string') return program.error(`error: ${launcher}`)
    const values: BenchStartupValues = { experiment: resolve(experiment), confirmed: options.yes === true, launcher }
    if (options.maxUsd !== undefined) values.maxUsd = options.maxUsd
    ctx.provide(BENCH_STARTUP_SERVICE, values)
  })
  parseCmdline(ctx, program)
}
