/**
 * Service Provider of the benchmark capability: `ctx.solarBenchRuntime` runs an
 * experiment — every (variant, task, repetition) of a registered suite — as
 * isolated `dsh` child processes, grades each run with its task's grader,
 * folds its session logs into metrics, and appends one record per run to the
 * experiment ledger. Recorded runs are skipped, so a crashed or cancelled
 * experiment resumes where it stopped.
 *
 * @module @lisihao/dsh-solar-bench/runtime
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { BenchSuite, BenchTask, BenchTaskId } from './types.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { cellEnv, prepareCell, readRunSessions, scrubTemplateFiles } from './cell.js'
import { cellKey, ExperimentLedger, LEDGER_FORMAT_VERSION, listExperimentIds, readPinnedExperiment } from './ledger.js'
import { foldRunMetrics } from './metrics.js'
import type { ModelPrice } from './metrics.js'
import type { AnalysisOptions, CellKey, Experiment, ExperimentId, LedgerSnapshot, RunProgress, RunRecord, Variant } from './types.js'


declare module '@deepseek-ai/cordis' {
  interface Context {
    solarBenchRuntime: BenchRuntime
  }
}

/**
 * Home-relative files copied into every run home and deleted when its child
 * exits: the `.env` that rc.2 loads from `$DSH_HOME` (for example the proxy
 * the official app needs). The model key reaches a child through
 * {@link RunOptions.env}, never as a copied file.
 */
export const RUN_TEMPLATE_FILES: readonly string[] = ['.env']

/** rc.2 canonical codes (`dsh-llm`) for a rejected credential or an exhausted quota or balance. */
export const PROVIDER_FAILURE_CODES: readonly string[] = ['INVALID_CREDENTIAL', 'QUOTA', 'ACCOUNT_QUOTA']

/** Runtime configuration. */
export interface Config {
  /**
   * Launcher argv prefix for `dsh`, for example `[node, /abs/apps/cli/lib/bin.js]`.
   * Empty (the default), the runtime only reads ledgers and {@link BenchRuntime.run} refuses.
   */
  command: string[]
  /** Absolute home whose `profiles/<profile>` seeds every run home. */
  templateHome: string
  /** Home-relative files copied, when present, into every run home (credentials, settings) and deleted once its child exits. */
  templateFiles: string[]
  /** Absolute directory holding one ledger directory per experiment. */
  ledgerRoot: string
  /** Runs executed at once. */
  concurrency: number
  /** Wall-time limit of one run's child process. */
  runTimeoutMs: number
  /** USD per million tokens, by model id; runs using an unlisted model get no cost. */
  prices: ModelPrice[]
  /**
   * Provider error codes that mean the model was unavailable rather than the
   * task failed (bad key, no balance, exhausted quota). A root turn that ends
   * with one of these makes the run `invalid`, so a broken credential cannot
   * read as every variant failing every task.
   */
  providerFailureCodes: string[]
}

export const Config: z<Config> = z.object({
  command: z.array(z.string()).default([]),
  templateHome: z.string().required(),
  templateFiles: z.array(z.string()).required(),
  ledgerRoot: z.string().required(),
  concurrency: z.natural().min(1).default(1),
  runTimeoutMs: z.natural().min(1).default(600_000),
  prices: z.array(z.object({
    model: z.string().required(),
    input: z.number().min(0).required(),
    output: z.number().min(0).required(),
    cacheRead: z.number().min(0),
  })).default([]),
  providerFailureCodes: z.array(z.string()).default([...PROVIDER_FAILURE_CODES]),
})

/** Schemastery schema of {@link AnalysisOptions}, with defaults, for consumers that take analysis settings as config. */
export const AnalysisConfig: z<AnalysisOptions> = z.object({
  confidence: z.union([z.const(0.9), z.const(0.95), z.const(0.99)]).default(0.95),
  resamples: z.natural().min(100).default(2000),
  seed: z.natural().default(1),
  margin: z.number().min(0).max(0.99).default(0.05),
  minTasks: z.natural().min(3).default(10),
  invalidTolerance: z.number().min(0).max(1).default(0.1),
})

/** Options of one {@link BenchRuntime.run} call. */
export interface RunOptions {
  /** Stops launching runs and kills running ones; unfinished runs stay unrecorded. */
  signal?: AbortSignal
  /** Called after each run is recorded. */
  onProgress?: (progress: RunProgress) => void
  /** Called when a run's child starts. */
  onStart?: (cell: CellKey) => void
  /** Called with each chunk a run's child prints, already redacted. */
  onOutput?: (cell: CellKey, text: string) => void
  /**
   * Extra child environment, such as the model key. Every value is treated as
   * secret: it is replaced by `[redacted]` in records and in `onOutput`.
   */
  env?: Readonly<Record<string, string>>
  /** Home whose `profiles/<profile>` seeds run homes, instead of the configured `templateHome`. */
  profileHome?: string
}

/** Child output head kept for activation warnings, which print before the answer. */
const OUTPUT_HEAD_BYTES = 16_000

/**
 * Package names that a patch file's insert rows mount (`name:` values).
 * @param text - the patch YAML.
 * @returns the names.
 */
export function patchPackageNames(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(/^[\s-]*name:\s*['"]?([^'"\s#]+)['"]?\s*(?:#.*)?$/gm)) names.push(match[1] as string)
  return names
}

/**
 * A row of the variant's own patches that did not activate in the child.
 * dsh prints `<n> entries did not activate` followed by one line per row,
 * `id (package): failed to import …` or `id (package): pending (waiting for service: …)`.
 * @param packages - package names the variant's patches mount.
 * @param output - the child's output head.
 * @returns the warning line, or `undefined` when every one activated.
 */
export function inactivePatchRow(packages: readonly string[], output: string): string | undefined {
  const start = output.search(/entries? did not activate/)
  if (start < 0 || packages.length === 0) return undefined
  for (const line of output.slice(start).split('\n').slice(1)) {
    if (!/^\S+ \(/.test(line)) break
    if (packages.some(name => line.includes(`(${name})`) || line.includes(`(${name}/`))) return line.trim()
  }
  return undefined
}

/** Exit of one run's child process. */
interface ChildExit {
  code: number | null
  timedOut: boolean
  /** Output tail. */
  output: string
  /** Output head. */
  head: string
}

/**
 * The provider failure that ended the root session's last turn, when its code is listed.
 * @param events - root session events.
 * @param codes - provider error codes that mean the model was unavailable.
 * @returns `CODE: message`, or `undefined` when the last turn did not end that way.
 */
function providerFailure(events: readonly SessionEvent[], codes: readonly string[]): string | undefined {
  const last = events.findLast(event => event.type === 'turn/end')
  if (last?.type !== 'turn/end' || last.data.reason.kind !== 'error') return undefined
  const { code, message } = last.data.reason.error
  return codes.includes(code) ? `${code}: ${message}` : undefined
}

/** Bytes of child output kept for error messages. */
const OUTPUT_TAIL_BYTES = 4000

/** Runs benchmark experiments as isolated child processes. */
export class BenchRuntime extends Service {
  static inject = ['solarBenchmarks']
  static Config = Config

  /**
   * Create and install the runtime as `ctx.solarBenchRuntime`.
   * @param ctx - Cordis context carrying `ctx.solarBenchmarks`.
   * @param config - runtime configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'solarBenchRuntime')
  }

  /**
   * Run every unrecorded cell of an experiment. Cells are ordered by
   * repetition, then task, then variant, so a partial experiment stays
   * balanced across variants.
   * @param experiment - the experiment to run.
   * @param options - cancellation and progress.
   * @returns every record in the ledger after the run, earlier ones included.
   * @throws Error before any run starts when `command` is empty, when the suite, a task,
   *   or a grader spec is invalid, or when the ledger pins a different definition; the abort reason when cancelled.
   */
  async run(experiment: Experiment, options: RunOptions = {}): Promise<RunRecord[]> {
    const { command } = this.config
    if (command.length === 0) throw new Error('bench-runner: no command is configured, so this runtime only reads ledgers')
    const suite = this.ctx.solarBenchmarks.suite(experiment.suite)
    if (suite === undefined) throw new Error(`benchmark suite ${JSON.stringify(experiment.suite)} is not registered`)
    const tasks = this.selectTasks(experiment, await suite.load(options.signal))
    const ledger = new ExperimentLedger(this.config.ledgerRoot, experiment)
    await ledger.open()
    const records = await ledger.records(true)
    const done = new Set(records.map(record => cellKey(record.cell)))
    const pending: { cell: CellKey; task: BenchTask; variant: Variant }[] = []
    for (let rep = 0; rep < experiment.repetitions; rep += 1) {
      for (const task of tasks) {
        for (const variant of experiment.variants) {
          const cell = { variant: variant.id, task: task.id, rep }
          if (!done.has(cellKey(cell))) pending.push({ cell, task, variant })
        }
      }
    }
    const total = experiment.variants.length * tasks.length * experiment.repetitions
    const worker = async (): Promise<void> => {
      for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
        options.signal?.throwIfAborted()
        const record = await this.runCell(command, experiment, suite, ledger.dir, next, options)
        options.signal?.throwIfAborted()
        await ledger.append(record)
        records.push(record)
        options.onProgress?.({ record, done: records.length, total })
      }
    }
    const workers = Array.from({ length: Math.min(this.config.concurrency, pending.length) }, worker)
    const settled = await Promise.allSettled(workers)
    for (const result of settled) if (result.status === 'rejected') throw result.reason
    return records
  }

  /** Absolute directory holding one ledger directory per experiment. */
  get ledgerRoot(): string {
    return this.config.ledgerRoot
  }

  /**
   * List the experiments that have a ledger.
   * @returns their ids in name order.
   */
  experiments(): Promise<ExperimentId[]> {
    return listExperimentIds(this.config.ledgerRoot)
  }

  /**
   * Read one experiment's pinned definition and records without modifying the ledger.
   * @param id - experiment id.
   * @returns the snapshot, or `undefined` when no ledger exists under `id`.
   */
  async ledger(id: string): Promise<LedgerSnapshot | undefined> {
    const experiment = await readPinnedExperiment(this.config.ledgerRoot, id)
    if (experiment === undefined) return undefined
    return { experiment, records: await new ExperimentLedger(this.config.ledgerRoot, experiment).records(false) }
  }

  /**
   * Apply the experiment's task subset and validate every grader spec.
   * @param experiment - the experiment.
   * @param all - the suite's tasks.
   * @returns the tasks to run, in suite order.
   */
  private selectTasks(experiment: Experiment, all: readonly BenchTask[]): BenchTask[] {
    let tasks = [...all]
    if (experiment.tasks !== undefined) {
      const wanted = new Set<BenchTaskId>(experiment.tasks)
      const known = new Set(all.map(task => task.id))
      for (const id of wanted) if (!known.has(id)) throw new Error(`suite ${JSON.stringify(experiment.suite)} has no task ${JSON.stringify(id)}`)
      tasks = tasks.filter(task => wanted.has(task.id))
    }
    for (const task of tasks) {
      const grader = this.ctx.solarBenchmarks.grader(task.grader.kind)
      if (grader === undefined) throw new Error(`task ${JSON.stringify(task.id)} names unregistered grader ${JSON.stringify(task.grader.kind)}`)
      grader.validate(task.grader)
    }
    return tasks
  }

  /**
   * Execute, measure, and grade one cell.
   * @param command - the launcher argv prefix.
   * @param experiment - the experiment.
   * @param suite - the experiment's suite.
   * @param ledgerDir - the experiment ledger directory.
   * @param job - the cell with its task and variant.
   * @param signal - cancellation.
   * @returns the cell's record.
   */
  private async runCell(
    command: readonly string[],
    experiment: Experiment,
    suite: BenchSuite,
    ledgerDir: string,
    job: { cell: CellKey; task: BenchTask; variant: Variant },
    options: RunOptions,
  ): Promise<RunRecord> {
    const { signal } = options
    const secrets = Object.values(options.env ?? {}).filter(value => value.length >= 4)
    const redact = (text: string): string => secrets.reduce((result, secret) => result.replaceAll(secret, '[redacted]'), text)
    const startedAt = Date.now()
    const dir = join(ledgerDir, 'cells', job.cell.variant, job.cell.task, String(job.cell.rep))
    const template = { home: options.profileHome ?? this.config.templateHome, filesHome: this.config.templateHome, files: this.config.templateFiles }
    const dirs = await prepareCell(dir, job.task.fixture, template, experiment.profile)
    const packages = (await Promise.all(job.variant.patches.map(async patch => patchPackageNames(await readFile(patch, 'utf8').catch(() => ''))))).flat()
    const argv = [
      ...command.slice(1),
      '--profile', experiment.profile,
      ...job.variant.patches.flatMap(patch => ['--patch', patch]),
      job.task.prompt,
    ]
    options.onStart?.(job.cell)
    const env = { ...cellEnv(process.env, dirs, job.variant), ...options.env }
    const onOutput = options.onOutput === undefined ? undefined : (text: string) => { options.onOutput?.(job.cell, redact(text)) }
    const raw = await this.spawnChild(command[0] as string, argv, dirs.workspace, env, signal, onOutput)
    const exit = { ...raw, output: redact(raw.output), head: redact(raw.head) }
    await scrubTemplateFiles(dirs.home, this.config.templateFiles)
    const base = { formatVersion: LEDGER_FORMAT_VERSION as 1, cell: job.cell, exitCode: exit.code, suiteVersion: suite.version, startedAt }
    const inactive = inactivePatchRow(packages, exit.head)
    if (inactive !== undefined) {
      signal?.throwIfAborted()
      return { ...base, status: 'invalid', models: [], error: `plugin under test did not load: ${inactive}`, endedAt: Date.now() }
    }
    let sessions
    try {
      sessions = await readRunSessions(dirs.home)
    } catch (error) {
      if (exit.timedOut) return { ...base, status: 'timeout', models: [], endedAt: Date.now() }
      return { ...base, status: 'invalid', models: [], error: `session log unreadable: ${(error as Error).message}\n${exit.output}`, endedAt: Date.now() }
    }
    const { metrics, models } = foldRunMetrics(sessions.root, sessions.children, this.config.prices)
    const unavailable = providerFailure(sessions.root, this.config.providerFailureCodes)
    if (unavailable !== undefined) return { ...base, status: 'invalid', metrics, models, error: `model unavailable: ${unavailable}`, endedAt: Date.now() }
    if (exit.timedOut) return { ...base, status: 'timeout', metrics, models, endedAt: Date.now() }
    const grader = this.ctx.solarBenchmarks.grader(job.task.grader.kind)
    if (grader === undefined) {
      return { ...base, status: 'invalid', metrics, models, error: `grader ${JSON.stringify(job.task.grader.kind)} was unregistered during the experiment`, endedAt: Date.now() }
    }
    try {
      const input = { workspace: dirs.workspace, events: sessions.root, ...signal === undefined ? {} : { signal } }
      const grade = await grader.grade(job.task.grader, input)
      return { ...base, status: 'graded', grade, grader: { kind: grader.kind, version: grader.version }, metrics, models, endedAt: Date.now() }
    } catch (error) {
      signal?.throwIfAborted()
      return { ...base, status: 'invalid', metrics, models, error: `grader failed: ${(error as Error).message}`, endedAt: Date.now() }
    }
  }

  /**
   * Run the dsh child to exit, killing it at the run timeout.
   * @param launcher - the launcher executable.
   * @param argv - arguments after the launcher executable.
   * @param cwd - the run workspace.
   * @param env - the run environment.
   * @param signal - cancellation; kills the child.
   * @returns the exit outcome.
   */
  private spawnChild(
    launcher: string,
    argv: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    signal: AbortSignal | undefined,
    onOutput?: (text: string) => void,
  ): Promise<ChildExit> {
    return new Promise((resolve, reject) => {
      const child = spawn(launcher, argv, { cwd, env, signal, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      let head = ''
      let timedOut = false
      const collect = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        output = (output + text).slice(-OUTPUT_TAIL_BYTES)
        if (head.length < OUTPUT_HEAD_BYTES) head = (head + text).slice(0, OUTPUT_HEAD_BYTES)
        onOutput?.(text)
      }
      child.stdout.on('data', collect)
      child.stderr.on('data', collect)
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
      }, this.config.runTimeoutMs)
      let aborted: Error | undefined
      child.once('error', (error) => {
        // An abort kills the child; settle only once it has exited, so a stopped run leaves no process behind.
        if (error.name === 'AbortError' && child.pid !== undefined) {
          aborted = error
          return
        }
        clearTimeout(timer)
        reject(error)
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (aborted !== undefined) reject(aborted)
        else resolve({ code, timedOut, output, head })
      })
    })
  }
}

