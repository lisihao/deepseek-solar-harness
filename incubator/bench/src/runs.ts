/**
 * In-app experiment runs: which suites and plugins can be compared, starting
 * one experiment at a time, its live progress and log, and stopping it.
 *
 * A run boots a generated profile, `solar-bench-run`, whose bundles are only
 * `dsh-base` and `dsh-headless`, so the baseline carries no third-party
 * plugin. Each plugin under test is linked from the source profile (the
 * desktop profile by default) into that profile's `node_modules`, and its own
 * bundle patch is the variant's `--patch`. The model key is resolved through
 * the official credentials service and reaches children only in their
 * environment.
 * @module @lisihao/dsh-solar-bench/runs
 */

import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { BenchRegistry } from './registry.js'
import type { BenchRuntime } from './runtime.js'
import type { CellKey, Experiment, RunRecord, Variant } from './types.js'

/** Name of the generated run profile. */
export const RUN_PROFILE = 'solar-bench-run'

/** Format version of the generated profile's marker file. */
const TEMPLATE_FORMAT_VERSION = 1

/** One plugin the source profile has installed and enabled. */
export interface BenchPluginCandidate {
  /** Package name. */
  name: string
  /** Installed version. */
  version: string
  /** Title from the plugin's own locale, per language; absent when it ships none. */
  title: { zh?: string; en?: string }
  /** Absolute bundle patch of the installed package. */
  patch: string
}

/** What the run form offers. */
export interface BenchRunChoices {
  /** Registered suites with their tasks. */
  suites: { id: string; version: string; description: string; tasks: { id: string; tags: string[] }[] }[]
  /** Plugins that can be compared with the baseline. */
  plugins: Omit<BenchPluginCandidate, 'patch'>[]
  /** Paired tasks below which a comparison cannot be judged. */
  minTasks: number
  /** Whether a model key is configured. */
  credential: boolean
}

/** Input of `start`. */
export interface BenchStartInput {
  /** Suite id. */
  suite: string
  /** Task ids, at least one. */
  tasks: string[]
  /** Plugin package names, at least one; each becomes a variant against the baseline. */
  plugins: string[]
  /** Runs per (task, variant). */
  repetitions: number
  /** Stops once priced runs cost more than this many US dollars. */
  maxUsd: number
}

/** One finished run as the progress view lists it. */
export interface BenchJobRun {
  variant: string
  task: string
  rep: number
  outcome: 'pass' | 'fail' | 'timeout' | 'invalid'
  costUsd: number | null
  seconds: number
  reason?: string
}

/** The current or last job. */
export interface BenchJobStatus {
  state: 'idle' | 'running' | 'finished' | 'stopped' | 'failed'
  experimentId?: string
  total: number
  done: number
  spentUsd: number
  maxUsd: number
  running: { variant: string; task: string; rep: number; startedAt: number }[]
  runs: BenchJobRun[]
  /** Recent progress and child output lines, oldest first. */
  log: string[]
  /** Why the job stopped or failed. */
  reason?: string
  startedAt?: number
  endedAt?: number
}

const LOG_LINES = 400

const startInput = z.strictObject({
  suite: z.string().min(1),
  tasks: z.array(z.string().min(1)).min(1),
  plugins: z.array(z.string().min(1)).min(1).max(8),
  repetitions: z.number().int().min(1).max(10),
  maxUsd: z.number().positive().max(100),
})

/**
 * A variant id that is a safe directory name.
 * @param name - package name.
 * @returns e.g. `lisihao-dsh-solar-rlm`.
 */
export function variantIdOf(name: string): string {
  return name.replace(/^@/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '')
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function localeTitle(packageDir: string, language: 'zh' | 'en'): Promise<string | undefined> {
  try {
    const title = (await readJson(join(packageDir, 'locale', `${language}.json`)) as { meta?: { title?: unknown } }).meta?.title
    return typeof title === 'string' && title.trim() !== '' ? title : undefined
  } catch {
    return undefined
  }
}

/**
 * Plugins the source profile has installed and enabled, excluding official
 * `@deepseek-ai/*` bundles and this plugin.
 * @param profileDir - the source profile directory.
 * @param self - this plugin's package name.
 * @returns the candidates in bundle order.
 */
export async function listPluginCandidates(profileDir: string, self: string): Promise<BenchPluginCandidate[]> {
  let manifest: { dsh?: { profile?: { bundles?: unknown } } }
  try {
    manifest = await readJson(join(profileDir, 'package.json')) as typeof manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles.filter((name): name is string => typeof name === 'string') : []
  const candidates: BenchPluginCandidate[] = []
  for (const name of bundles) {
    if (name.startsWith('@deepseek-ai/') || name === self) continue
    const dir = join(profileDir, 'node_modules', name)
    let pkg: { version?: unknown; dsh?: { bundle?: { patch?: unknown } } }
    try {
      pkg = await readJson(join(dir, 'package.json')) as typeof pkg
    } catch {
      continue
    }
    const patch = pkg.dsh?.bundle?.patch
    if (typeof patch !== 'string' || typeof pkg.version !== 'string') continue
    const zh = await localeTitle(dir, 'zh')
    const en = await localeTitle(dir, 'en')
    candidates.push({ name, version: pkg.version, title: { ...zh === undefined ? {} : { zh }, ...en === undefined ? {} : { en } }, patch: join(dir, patch) })
  }
  return candidates
}

/**
 * Display names of an experiment's variants.
 * @param experiment - the pinned definition.
 * @returns names per variant id.
 */
export async function variantTitles(experiment: Experiment): Promise<Record<string, { zh?: string; en?: string; baseline?: true }>> {
  const titles: Record<string, { zh?: string; en?: string; baseline?: true }> = {}
  for (const variant of experiment.variants) {
    const patch = variant.patches[0]
    if (patch === undefined) {
      titles[variant.id] = { baseline: true }
      continue
    }
    const zh = await localeTitle(dirname(patch), 'zh')
    const en = await localeTitle(dirname(patch), 'en')
    titles[variant.id] = { ...zh === undefined ? {} : { zh }, ...en === undefined ? {} : { en } }
  }
  return titles
}

/**
 * Write the generated run profile: only `dsh-base` and `dsh-headless`, plus
 * links to the plugins under test, which their variant patches mount.
 * @param templateHome - the home whose `profiles/` receives the profile.
 * @param sourceProfile - the profile the plugins are linked from.
 * @param plugins - package names to link.
 */
export async function writeRunTemplate(templateHome: string, sourceProfile: string, plugins: readonly string[]): Promise<void> {
  const dir = join(templateHome, 'profiles', RUN_PROFILE)
  await rm(dir, { recursive: true, force: true })
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-solar-bench-run',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, undefined, 2)}\n`)
  const header = '# Generated by @lisihao/dsh-solar-bench for benchmark runs; rewritten on every start.\n[]\n'
  await writeFile(join(dir, 'cordis.yml'), header)
  await writeFile(join(dir, 'cordis.patch.yml'), header)
  await writeFile(join(dir, 'solar-bench-template.json'), `${JSON.stringify({ formatVersion: TEMPLATE_FORMAT_VERSION, sourceProfile, plugins })}\n`)
  for (const name of plugins) {
    const link = join(dir, 'node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(sourceProfile, 'node_modules', name), link, 'dir')
  }
}

/** Dependencies of {@link BenchRunManager}. */
export interface BenchRunDeps {
  registry: BenchRegistry
  runtime: BenchRuntime
  /** Absolute source profile the plugins are compared from. */
  sourceProfile: string
  /** Absolute home holding the generated run profile. */
  templateHome: string
  /** This plugin's package name. */
  self: string
  /** Paired tasks below which a comparison cannot be judged. */
  minTasks: number
  /** Resolves the model key, or `undefined` when none is configured. */
  credential: () => Promise<string | undefined>
  /** Clock, for tests. */
  now?: () => Date
}

/** Starts and observes one experiment at a time. */
export class BenchRunManager {
  private job: BenchJobStatus = { state: 'idle', total: 0, done: 0, spentUsd: 0, maxUsd: 0, running: [], runs: [], log: [] }
  private controller: AbortController | undefined
  private finished: Promise<void> | undefined

  constructor(private readonly deps: BenchRunDeps) {}

  /** What the run form offers. */
  async choices(): Promise<BenchRunChoices> {
    const suites = await Promise.all(this.deps.registry.suites().map(async suite => ({
      id: suite.id,
      version: suite.version,
      description: suite.description,
      tasks: (await suite.load()).map(task => ({ id: task.id, tags: [...task.tags] })),
    })))
    const plugins = (await listPluginCandidates(this.deps.sourceProfile, this.deps.self)).map(({ patch: _patch, ...plugin }) => plugin)
    return { suites, plugins, minTasks: this.deps.minTasks, credential: await this.deps.credential() !== undefined }
  }

  /** The current or last job; a copy. */
  status(): BenchJobStatus {
    return structuredClone(this.job)
  }

  /**
   * Start an experiment and return at once; progress is read through {@link status}.
   * @param input - the form.
   * @returns the experiment id.
   * @throws Error when a job is running, the input is invalid, or no model key is configured.
   */
  async start(input: BenchStartInput): Promise<{ experimentId: string }> {
    if (this.job.state === 'running') throw new Error('BENCH_JOB_RUNNING: an experiment is already running; stop it or wait for it to finish.')
    const form = startInput.parse(input)
    const suite = this.deps.registry.suite(form.suite)
    if (suite === undefined) throw new Error(`BENCH_SUITE_UNKNOWN: ${form.suite}`)
    const known = new Set((await suite.load()).map(task => task.id))
    const unknownTask = form.tasks.find(task => !known.has(task))
    if (unknownTask !== undefined) throw new Error(`BENCH_TASK_UNKNOWN: ${unknownTask}`)
    const candidates = new Map((await listPluginCandidates(this.deps.sourceProfile, this.deps.self)).map(plugin => [plugin.name, plugin]))
    const plugins = form.plugins.map((name) => {
      const plugin = candidates.get(name)
      if (plugin === undefined) throw new Error(`BENCH_PLUGIN_UNKNOWN: ${name} is not an enabled plugin of the source profile`)
      return plugin
    })
    const key = await this.deps.credential()
    if (key === undefined) throw new Error('BENCH_NO_CREDENTIAL: no DeepSeek API key is configured; set it on the Models settings page.')
    const stamp = (this.deps.now?.() ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
    const experiment: Experiment = {
      id: `${stamp}-${form.suite}`,
      suite: form.suite,
      profile: RUN_PROFILE,
      repetitions: form.repetitions,
      tasks: form.tasks,
      variants: [
        { id: 'baseline', patches: [], env: {} },
        ...plugins.map((plugin): Variant => ({ id: variantIdOf(plugin.name), patches: [plugin.patch], env: { SOLAR_BENCH_PLUGIN: `${plugin.name}@${plugin.version}` } })),
      ],
    }
    if (new Set(experiment.variants.map(variant => variant.id)).size !== experiment.variants.length) throw new Error('BENCH_PLUGIN_DUPLICATE: two plugins map to the same variant id')
    await writeRunTemplate(this.deps.templateHome, this.deps.sourceProfile, plugins.map(plugin => plugin.name))
    const controller = new AbortController()
    this.controller = controller
    this.job = {
      state: 'running',
      experimentId: experiment.id,
      total: form.tasks.length * experiment.variants.length * form.repetitions,
      done: 0,
      spentUsd: 0,
      maxUsd: form.maxUsd,
      running: [],
      runs: [],
      log: [],
      startedAt: Date.now(),
    }
    this.append(`experiment ${experiment.id}: ${String(this.job.total)} runs`)
    this.finished = this.execute(experiment, key, controller).finally(() => {
      if (this.controller === controller) this.controller = undefined
    })
    return { experimentId: experiment.id }
  }

  /**
   * Stop the running job; running children are killed and their runs stay unrecorded.
   * @returns the status after stopping.
   */
  async stop(): Promise<BenchJobStatus> {
    if (this.job.state === 'running') this.controller?.abort(new Error('stopped by the user'))
    await this.finished
    return this.status()
  }

  /** Abort and wait, for plugin disposal. */
  async dispose(): Promise<void> {
    this.controller?.abort(new Error('the benchmark plugin was unloaded'))
    await this.finished
  }

  private append(line: string): void {
    const lines = line.split('\n').filter(text => text.trim() !== '')
    this.job.log.push(...lines.map(text => text.slice(0, 500)))
    if (this.job.log.length > LOG_LINES) this.job.log.splice(0, this.job.log.length - LOG_LINES)
  }

  private async execute(experiment: Experiment, key: string, controller: AbortController): Promise<void> {
    const job = this.job
    const label = (cell: CellKey) => `${cell.variant} · ${cell.task} #${String(cell.rep + 1)}`
    const onProgress = ({ record, done, total }: { record: RunRecord; done: number; total: number }): void => {
      job.done = done
      job.total = total
      job.running = job.running.filter(entry => !(entry.variant === record.cell.variant && entry.task === record.cell.task && entry.rep === record.cell.rep))
      const cost = record.metrics?.costUsd
      if (cost !== undefined) job.spentUsd += cost
      const outcome = record.status === 'graded' ? record.grade?.pass === true ? 'pass' : 'fail' : record.status
      const reason = record.error?.split('\n')[0]
      job.runs.push({
        variant: record.cell.variant,
        task: record.cell.task,
        rep: record.cell.rep,
        outcome,
        costUsd: cost ?? null,
        seconds: Math.round((record.endedAt - record.startedAt) / 100) / 10,
        ...reason === undefined ? {} : { reason },
      })
      this.append(`[${String(done)}/${String(total)}] ${label(record.cell)}: ${outcome}${reason === undefined ? '' : ` (${reason})`}`)
      if (record.metrics !== undefined && cost === undefined) {
        controller.abort(new Error(`no price is configured for ${record.models.join(', ') || 'the model used'}, so the spending limit cannot be enforced`))
      } else if (job.spentUsd > job.maxUsd) {
        controller.abort(new Error(`spending limit reached: $${job.spentUsd.toFixed(4)} > $${job.maxUsd.toFixed(2)}`))
      }
    }
    try {
      await this.deps.runtime.run(experiment, {
        signal: controller.signal,
        onProgress,
        onStart: (cell) => {
          job.running.push({ ...cell, startedAt: Date.now() })
          this.append(`start ${label(cell)}`)
        },
        onOutput: (_cell, text) => { this.append(text) },
        env: { DEEPSEEK_API_KEY: key },
        profileHome: this.deps.templateHome,
      })
      job.state = 'finished'
    } catch (error) {
      if (controller.signal.aborted) {
        job.state = 'stopped'
        job.reason = (controller.signal.reason as Error).message
      } else {
        job.state = 'failed'
        job.reason = (error as Error).message.replaceAll(key, '[redacted]')
      }
      this.append(`${job.state}: ${job.reason}`)
    }
    job.running = []
    job.endedAt = Date.now()
  }
}
