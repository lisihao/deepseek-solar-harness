/**
 * Gateway to the scheduling evidence collectors in `python/scheduling-evidence`.
 * It runs their read-only commands (`status`, `show`) as bounded child
 * processes through `ctx.subprocess` and returns each command's JSON document.
 * The caller-facing methods never refresh or import: those commands reach the
 * network and write stored generations. Only the optional Radar cycle runs
 * `consent` and `refresh`, and only with the owner's authorization file.
 * @module @deepseek-ai/dsh-scheduling-evidence
 */

import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ModelAllocationEvidence, ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { radarEvidence, type RadarDeclaration } from './radar-evidence.ts'

export type { RadarDeclaration } from './radar-evidence.ts'

/** The collectors this gateway runs. */
export type CollectorId = 'radar' | 'ai-frontier'

const COLLECTORS: Readonly<Record<CollectorId, { readonly module: string; readonly directory: string }>> = {
  radar: { module: 'codex_radar_provider.cli', directory: 'radar' },
  'ai-frontier': { module: 'ai_frontier_provider.cli', directory: 'ai-frontier' },
}

/** `from __future__ import annotations` plus `datetime.UTC` make the collectors require Python 3.11. */
const MINIMUM_PYTHON = { major: 3, minor: 11 } as const
/** Largest delay Node timers accept. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Collector commands exit 0 when `ok`, 1 when not `ok`, and 2 when the command itself failed; all three print a JSON document. */
const DOCUMENT_EXIT_CODES: readonly number[] = [0, 1, 2]

/** Stable failure classes of a collector call. */
export type SchedulingEvidenceErrorCode =
  | 'INTERPRETER_UNAVAILABLE'
  | 'INTERPRETER_UNSUPPORTED'
  | 'COLLECTOR_SPAWN_FAILED'
  | 'COLLECTOR_TIMEOUT'
  | 'COLLECTOR_ABORTED'
  | 'COLLECTOR_OUTPUT_INVALID'
  | 'COLLECTOR_FAILED'
  | 'GATEWAY_DISPOSED'

/** A collector call that produced no usable document. */
export class SchedulingEvidenceError extends HarnessError {
  constructor(message: string, code: SchedulingEvidenceErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'SchedulingEvidenceError'
  }
}

/**
 * Radar evidence for the allocator. Present, even empty, the gateway reads the
 * Radar generation already stored; collection from the network runs only when
 * `authorizationFile` names the owner's receipt.
 */
export interface RadarConfig {
  /** The owner's authorization receipt; no network request is made without a valid one. */
  authorizationFile?: string
  /**
   * The owner's statement of personal-use consent. When true and `authorizationFile` is missing,
   * the gateway records the receipt there once. Never set by a shipped default.
   */
  personalUseConsent?: boolean
  /** Time between collections in milliseconds; 30 minutes to 24 hours, default 4 hours. */
  refreshIntervalMs?: number
  /** Deadline for one collection in milliseconds; default 90000. */
  refreshTimeoutMs?: number
  /** Seconds before a stored generation stops being used; default 604800 (7 days). */
  staleAfterSeconds?: number
  /** Benchmark name the records claim; default `Codex Radar community tasks`. */
  benchmark?: string
  /** The test environment the owner states every Radar row shares; default `codex-radar-community`. */
  harness?: string
  /** The one task type the dataset speaks to; default `coding`. */
  taskType?: string
  /** Radar model names mapped to the names offers use. */
  modelAliases?: Record<string, string>
}

/** Where and how the collectors run. */
export interface Config {
  /** Python 3.11+ interpreter: an absolute path or a bare name looked up on the scrubbed PATH. */
  python: string
  /** Directory holding `codex_radar_provider` and `ai_frontier_provider` (`python/scheduling-evidence/src`). */
  sourceRoot: string
  /** Owner-private directory under which each collector keeps its SQLite generations. */
  stateRoot: string
  /** Deadline for one collector call in milliseconds; default 15000. */
  timeoutMs?: number
  /** Grace between SIGTERM and SIGKILL when a call is stopped; default 2000. */
  graceMs?: number
  /** Largest stdout or stderr kept per call, in bytes, and a larger stdout fails the call; default 1048576. */
  maxOutputBytes?: number
  /** Radar evidence for the allocator; omitted, the gateway offers no evidence. */
  radar?: RadarConfig
}

/** Loader schema; bounds are checked here and defaults are applied by {@link resolveConfig}. */
export const Config: z<Config> = z.object({
  python: z.string().required(),
  sourceRoot: z.string().required(),
  stateRoot: z.string().required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
  graceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS),
  maxOutputBytes: z.number().step(1).min(1_024).max(16 * 1_024 * 1_024),
  // Without an explicit undefined default, schemastery fills an absent object from its members' defaults and would switch Radar on.
  radar: z.object({
    authorizationFile: z.string(),
    personalUseConsent: z.boolean(),
    refreshIntervalMs: z.number().step(1).min(30 * 60_000).max(24 * 60 * 60_000),
    refreshTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS),
    staleAfterSeconds: z.number().step(1).min(60).max(90 * 24 * 60 * 60),
    benchmark: z.string(),
    harness: z.string(),
    taskType: z.string(),
    modelAliases: z.dict(z.string()),
  }).default(undefined as never),
})

/** A {@link RadarConfig} with every setting explicit. */
export interface ResolvedRadarConfig {
  readonly authorizationFile: string | undefined
  readonly personalUseConsent: boolean
  readonly refreshIntervalMs: number
  readonly refreshTimeoutMs: number
  readonly staleAfterSeconds: number
  readonly declaration: RadarDeclaration
}

/** A {@link Config} with every limit explicit. */
export interface ResolvedConfig {
  readonly python: string
  readonly sourceRoot: string
  readonly stateRoot: string
  readonly timeoutMs: number
  readonly graceMs: number
  readonly maxOutputBytes: number
  readonly radar: ResolvedRadarConfig | undefined
}

/**
 * Apply the documented default to each omitted limit.
 * @param config - validated plugin config.
 * @returns the config with `timeoutMs`, `graceMs`, and `maxOutputBytes` set.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    python: config.python,
    sourceRoot: config.sourceRoot,
    stateRoot: config.stateRoot,
    timeoutMs: config.timeoutMs ?? 15_000,
    graceMs: config.graceMs ?? 2_000,
    maxOutputBytes: config.maxOutputBytes ?? 1_048_576,
    radar: config.radar === undefined ? undefined : {
      authorizationFile: config.radar.authorizationFile,
      personalUseConsent: config.radar.personalUseConsent ?? false,
      refreshIntervalMs: config.radar.refreshIntervalMs ?? 4 * 60 * 60_000,
      refreshTimeoutMs: config.radar.refreshTimeoutMs ?? 90_000,
      staleAfterSeconds: config.radar.staleAfterSeconds ?? 7 * 24 * 60 * 60,
      declaration: {
        benchmark: config.radar.benchmark ?? 'Codex Radar community tasks',
        harness: config.radar.harness ?? 'codex-radar-community',
        taskType: config.radar.taskType ?? 'coding',
        modelAliases: config.radar.modelAliases ?? {},
      },
    },
  }
}

/** One collector command's outcome. */
export interface CollectorResult {
  /** The document's own `ok` fact; false for an unavailable store or a command-level error. */
  readonly ok: boolean
  /** Exit status: 0 ok, 1 not ok, 2 command failed. */
  readonly exitCode: number
  /** The single JSON object the command printed. */
  readonly document: Readonly<Record<string, unknown>>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    schedulingEvidence: SchedulingEvidenceGateway
  }
}

interface Execution {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stdoutTruncated: boolean
  readonly stderr: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Reads collector documents through bounded child processes. */
export class SchedulingEvidenceGateway extends Service {
  static inject = ['subprocess']

  static Config: z<Config> = Config

  private readonly config: ResolvedConfig
  private readonly active = new Set<SubprocessHandle>()
  private interpreter: Promise<string> | undefined
  private disposed = false
  /** The active Radar generation as the collector last printed it. */
  private radarSnapshot: Readonly<Record<string, unknown>> | undefined
  private cycleRunning: Promise<void> | undefined

  /**
   * Register `ctx.schedulingEvidence`.
   * @param ctx - owning context carrying `ctx.subprocess`.
   * @param config - interpreter, source and state directories, and call limits.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'schedulingEvidence')
    this.config = resolveConfig(config)
    const stop = (): Promise<void> => this.stopAll()
    ctx.effect(function* () {
      yield async () => { await stop() }
    }, 'scheduling-evidence: child processes')
    const { radar } = this.config
    if (radar !== undefined) {
      ctx.effect(() => {
        const timer = setInterval(() => { void this.runCycle() }, radar.refreshIntervalMs)
        timer.unref()
        void this.runCycle()
        return () => { clearInterval(timer) }
      }, 'scheduling-evidence: radar cycle')
    }
  }

  /**
   * Evidence for the allocator, from the Radar generation held in memory; it never starts a process.
   * @param offers - the offers the allocator will compare.
   * @param taskType - the request's task type; evidence exists only for the dataset's own.
   * @returns the evidence, or undefined when Radar is not configured, nothing usable is stored, or no offer has a record.
   */
  evidenceFor(offers: readonly ModelExecutionOffer[], taskType: string): ModelAllocationEvidence | undefined {
    const { radar } = this.config
    if (radar === undefined) return undefined
    return radarEvidence(this.radarSnapshot, offers, { taskType, declaration: radar.declaration, nowMs: Date.now() })
  }

  /**
   * Run one collection and reload cycle now, or join the one already running.
   * @returns when the cycle ends; a failed cycle is logged and leaves the last stored generation in use.
   */
  runCycle(): Promise<void> {
    this.cycleRunning ??= this.cycle().finally(() => { this.cycleRunning = undefined })
    return this.cycleRunning
  }

  private async cycle(): Promise<void> {
    const radar = this.config.radar as ResolvedRadarConfig
    try {
      const receipt = radar.authorizationFile
      if (receipt !== undefined) {
        const exists = await access(receipt).then(() => true, () => false)
        if (!exists && radar.personalUseConsent) {
          await this.command('radar', ['consent', '--personal-use', '--authorization-file', receipt], undefined)
        }
        if (exists || radar.personalUseConsent) {
          await this.command('radar', [
            'refresh', '--authorization-file', receipt, '--stale-after-seconds', String(radar.staleAfterSeconds),
          ], undefined, radar.refreshTimeoutMs)
        }
      }
      const stored = await this.command('radar', ['show'], undefined)
      this.radarSnapshot = typeof stored.document.snapshot_id === 'string' ? stored.document : undefined
    } catch (error) {
      this.ctx.logger.warn(`scheduling-evidence: radar cycle failed: ${(error as Error).message}`)
    }
  }

  /**
   * Read a collector's storage status.
   * @param collector - which collector to ask.
   * @param signal - cancels the call and stops its process tree.
   * @returns the status document; `ok` is false when no valid generation is stored.
   * @throws {SchedulingEvidenceError} When the interpreter is unusable or the call times out, is cancelled, or prints no document.
   */
  status(collector: CollectorId, signal?: AbortSignal): Promise<CollectorResult> {
    return this.command(collector, ['status'], signal)
  }

  /**
   * Read a stored generation without contacting the network.
   * @param collector - which collector to ask.
   * @param options - `snapshotId` selects an older generation; omitted reads the active one.
   * @returns the generation document, or `ok: false` when none is stored.
   * @throws {SchedulingEvidenceError} As for {@link status}.
   */
  show(collector: CollectorId, options: { readonly snapshotId?: string; readonly signal?: AbortSignal } = {}): Promise<CollectorResult> {
    const args = options.snapshotId === undefined ? ['show'] : ['show', '--snapshot-id', options.snapshotId]
    return this.command(collector, args, options.signal)
  }

  private async command(
    collector: CollectorId,
    args: readonly string[],
    signal: AbortSignal | undefined,
    timeoutMs?: number,
  ): Promise<CollectorResult> {
    const spec = COLLECTORS[collector]
    const stateDirectory = join(this.config.stateRoot, spec.directory)
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    const python = await this.verifiedInterpreter(signal)
    const run = await this.execute([python, '-m', spec.module, '--state-root', stateDirectory, ...args], signal, timeoutMs)
    return this.parseResult(collector, run)
  }

  private parseResult(collector: CollectorId, run: Execution): CollectorResult {
    const { exitCode } = run
    if (exitCode === null || !DOCUMENT_EXIT_CODES.includes(exitCode)) {
      const how = exitCode === null ? `was killed by ${String(run.signal)}` : `exited with status ${String(exitCode)}`
      throw new SchedulingEvidenceError(
        `The ${collector} collector ${how}: ${run.stderr.trim().slice(-400)}`,
        'COLLECTOR_FAILED',
      )
    }
    if (run.stdoutTruncated) {
      throw new SchedulingEvidenceError(
        `The ${collector} collector printed more than ${String(this.config.maxOutputBytes)} bytes`,
        'COLLECTOR_OUTPUT_INVALID',
      )
    }
    let document: unknown
    try {
      document = JSON.parse(run.stdout)
    } catch (cause) {
      throw new SchedulingEvidenceError(`The ${collector} collector printed no JSON document`, 'COLLECTOR_OUTPUT_INVALID', { cause })
    }
    if (!isRecord(document)) {
      throw new SchedulingEvidenceError(`The ${collector} collector printed a JSON value that is not an object`, 'COLLECTOR_OUTPUT_INVALID')
    }
    return { ok: document.ok === true, exitCode, document }
  }

  /** Resolve the interpreter once and require Python 3.11 or newer. */
  private verifiedInterpreter(signal: AbortSignal | undefined): Promise<string> {
    this.interpreter ??= this.resolveInterpreter(signal).catch((error: unknown) => {
      this.interpreter = undefined
      throw error
    })
    return this.interpreter
  }

  private async resolveInterpreter(signal: AbortSignal | undefined): Promise<string> {
    let path: string
    try {
      path = await this.ctx.subprocess.resolveExecutable(this.config.python, undefined, signal)
    } catch (cause) {
      throw new SchedulingEvidenceError(`Python interpreter "${this.config.python}" was not found`, 'INTERPRETER_UNAVAILABLE', { cause })
    }
    const run = await this.execute([path, '-c', 'import sys; sys.stdout.write("%d.%d" % sys.version_info[:2])'], signal)
    const match = /^(\d+)\.(\d+)$/u.exec(run.stdout)
    if (run.exitCode !== 0 || match === null) {
      throw new SchedulingEvidenceError(`Python interpreter "${path}" did not report its version`, 'INTERPRETER_UNAVAILABLE')
    }
    const [major, minor] = [Number(match[1]), Number(match[2])]
    if (major < MINIMUM_PYTHON.major || (major === MINIMUM_PYTHON.major && minor < MINIMUM_PYTHON.minor)) {
      throw new SchedulingEvidenceError(
        `Python ${String(major)}.${String(minor)} is too old; the collectors need ${String(MINIMUM_PYTHON.major)}.${String(MINIMUM_PYTHON.minor)} or newer`,
        'INTERPRETER_UNSUPPORTED',
      )
    }
    return path
  }

  private async execute(argv: readonly string[], signal: AbortSignal | undefined, timeoutMs?: number): Promise<Execution> {
    if (this.disposed) throw new SchedulingEvidenceError('The scheduling evidence gateway was disposed', 'GATEWAY_DISPOSED')
    const limit = timeoutMs ?? this.config.timeoutMs
    const deadline = AbortSignal.timeout(limit)
    const handle = this.ctx.subprocess.spawn({
      argv,
      cwd: this.config.stateRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      graceMs: this.config.graceMs,
      signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
      env: {
        PYTHONPATH: this.config.sourceRoot,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONUTF8: '1',
      },
    })
    this.active.add(handle)
    try {
      let outcome
      try {
        outcome = await handle.done
      } catch (cause) {
        throw new SchedulingEvidenceError('The collector process could not be started', 'COLLECTOR_SPAWN_FAILED', { cause })
      }
      if (deadline.aborted) {
        throw new SchedulingEvidenceError(`The collector call exceeded ${String(limit)} ms`, 'COLLECTOR_TIMEOUT')
      }
      if (signal?.aborted === true) {
        throw new SchedulingEvidenceError('The collector call was cancelled', 'COLLECTOR_ABORTED')
      }
      const stdout = handle.collected.stdout?.readFrom(0)
      return {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: stdout?.text ?? '',
        stdoutTruncated: stdout?.lossy ?? false,
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
      }
    } finally {
      this.active.delete(handle)
    }
  }

  /** Stop every call still running and wait for its process tree to exit. */
  private async stopAll(): Promise<void> {
    this.disposed = true
    const handles = [...this.active]
    for (const handle of handles) handle.terminate()
    await Promise.all(handles.map(handle => handle.waitForExit()))
  }
}

export default SchedulingEvidenceGateway
