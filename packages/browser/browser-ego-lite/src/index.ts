/**
 * Ego Lite v1.2.5 Service Provider for `ctx.browser`.
 *
 * Every request becomes one complete JavaScript stdin payload for the fixed
 * `ego-browser nodejs` CLI protocol. The shared subprocess service owns process
 * trees, cancellation, environment scrubbing, and bounded collection.
 *
 * @module @deepseek-ai/dsh-browser-ego-lite
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BrowserError,
  BrowserProviderId,
  type BrowserProvider,
  type BrowserRunPlanV1,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
  type BrowserRunResultV1,
} from '@deepseek-ai/dsh-browser'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { resolveEgoLiteExecutable, type ResolvedEgoLiteExecutable } from './executable.ts'
import {
  decodePlanResult,
  decodeProgramResult,
  runEgoLiteProcess,
  type EgoLiteProcessConfig,
} from './process.ts'
import {
  buildEgoLitePlanSource,
  buildEgoLiteProgramSource,
} from './source.ts'

export { DEFAULT_EGO_LITE_APP_EXECUTABLE, resolveEgoLiteExecutable } from './executable.ts'
export type { ResolvedEgoLiteExecutable } from './executable.ts'
export { decodePlanResult, decodeProgramResult, runEgoLiteProcess } from './process.ts'
export type { EgoLiteProcessConfig } from './process.ts'
export {
  assertEgoLitePlanSupported,
  buildEgoLitePlanSource,
  buildEgoLiteProgramSource,
  EGO_LITE_FRAME_PREFIX,
  EGO_LITE_NOTICE_PREFIX,
  EGO_LITE_UPSTREAM,
} from './source.ts'
export type { EgoLiteSourceLimits } from './source.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'browser-ego-lite'

/** Provider registry and managed subprocess service required by this plugin. */
export const inject = ['browser', 'subprocess']

/** Default process-tree termination grace in milliseconds. */
export const DEFAULT_EGO_LITE_GRACE_MS = 2_000

/** Default complete stdout retention bound in bytes. */
export const DEFAULT_EGO_LITE_STDOUT_MAX_BYTES = 8 * 1024 * 1024

/** Default stderr diagnostic-tail retention bound in bytes. */
export const DEFAULT_EGO_LITE_STDERR_MAX_BYTES = 256 * 1024

/** Default timeout for portable operations that omit their own deadline. */
export const DEFAULT_EGO_LITE_OPERATION_TIMEOUT_MS = 30_000

/** Ego Lite process and translation settings owned by deployment composition. */
export interface Config {
  /** Absolute CLI path; omission probes the signed macOS app, then the user install. */
  executable?: string
  /** Absolute working directory for each isolated CLI invocation. */
  cwd?: string
  /** Process-tree termination grace in milliseconds. */
  graceMs?: number
  /** Maximum complete stdout retained for one framed result. */
  stdoutMaxBytes?: number
  /** Maximum stderr diagnostic tail retained for one invocation. */
  stderrMaxBytes?: number
  /** Default operation timeout when a portable operation omits `timeoutMs`. */
  operationTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  executable: z.string(),
  cwd: z.string().default(process.cwd()),
  graceMs: z.number().default(DEFAULT_EGO_LITE_GRACE_MS),
  stdoutMaxBytes: z.number().default(DEFAULT_EGO_LITE_STDOUT_MAX_BYTES),
  stderrMaxBytes: z.number().default(DEFAULT_EGO_LITE_STDERR_MAX_BYTES),
  operationTimeoutMs: z.number().default(DEFAULT_EGO_LITE_OPERATION_TIMEOUT_MS),
})

type ResolvedConfig = Required<Omit<Config, 'executable'>>

interface ResolvedConfigValues extends ResolvedConfig {
  readonly cwd: string
  readonly graceMs: number
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
  readonly operationTimeoutMs: number
}

/** Ego Lite implementation registered behind the provider-neutral browser service. */
export class EgoLiteBrowserProvider implements BrowserProvider {
  readonly descriptor: BrowserProvider['descriptor'] = Object.freeze({
    id: BrowserProviderId('ego-lite'),
    layers: ['portable-plan-v1', 'browser-js-v1'],
    capabilities: [
      'authenticated-profile-reuse',
      'named-workspace',
      'page-evaluate',
      'screenshot',
      'semantic-snapshot',
      'user-control',
    ],
  } satisfies BrowserProvider['descriptor'])

  /**
   * Bind the Provider to one resolved CLI and process configuration.
   * @param ctx - Cordis context carrying the managed subprocess service.
   * @param config - validated process and operation bounds.
   * @param executable - discovered CLI, or undefined while the Provider is unavailable.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfigValues,
    readonly executable: ResolvedEgoLiteExecutable | undefined,
  ) {}

  /** Whether automatic or configured discovery found the Ego Lite CLI. */
  available(): boolean {
    return this.executable !== undefined
  }

  /** Execute one portable plan in one isolated Ego Lite heredoc. */
  async runPlan(plan: BrowserRunPlanV1, signal?: AbortSignal): Promise<BrowserRunResultV1> {
    const executable = this.requireExecutable()
    const source = buildEgoLitePlanSource(plan, {
      operationTimeoutMs: this.config.operationTimeoutMs,
    })
    const result = await runEgoLiteProcess(this.ctx, this.processConfig(executable), source, signal)
    return decodePlanResult(result, plan)
  }

  /**
   * Execute one trusted-plugin program in one Ego Lite Node heredoc. This is an
   * executable surface, not a model-facing or hostile-code security sandbox.
   */
  async runProgram(
    program: BrowserRunProgramV1,
    signal?: AbortSignal,
  ): Promise<BrowserRunProgramResultV1> {
    const executable = this.requireExecutable()
    const source = buildEgoLiteProgramSource(program, {
      operationTimeoutMs: this.config.operationTimeoutMs,
    })
    const result = await runEgoLiteProcess(this.ctx, this.processConfig(executable), source, signal)
    return decodeProgramResult(result, program)
  }

  private requireExecutable(): ResolvedEgoLiteExecutable {
    if (this.executable === undefined) {
      throw new BrowserError('Ego Lite CLI is not installed or discoverable', 'BROWSER_UNAVAILABLE')
    }
    return this.executable
  }

  private processConfig(executable: ResolvedEgoLiteExecutable): EgoLiteProcessConfig {
    return {
      executable: executable.path,
      cwd: this.config.cwd,
      graceMs: this.config.graceMs,
      stdoutMaxBytes: this.config.stdoutMaxBytes,
      stderrMaxBytes: this.config.stderrMaxBytes,
    }
  }
}

/**
 * Discover the Ego Lite CLI and register its Provider. Failed automatic
 * discovery leaves an unavailable descriptor; an invalid explicit path fails load.
 * @param ctx - context carrying browser and subprocess Services.
 * @param config - deployment-owned executable and resource bounds.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)
  const executable = await resolveEgoLiteExecutable(
    ctx.subprocess,
    config.executable,
    process.env.HOME,
  )
  ctx.browser.registerProvider(new EgoLiteBrowserProvider(ctx, resolved, executable))
}

/** Complete Cordis plugin export used by headless orchestration compositions. */
export default { name, inject, Config, apply }

function resolveConfig(config: Config): ResolvedConfigValues {
  const resolved = config as ResolvedConfigValues
  if (!isAbsolute(resolved.cwd)) throw new Error('browser-ego-lite: cwd must be an absolute path')
  positiveFinite('graceMs', resolved.graceMs)
  positiveInteger('stdoutMaxBytes', resolved.stdoutMaxBytes)
  positiveInteger('stderrMaxBytes', resolved.stderrMaxBytes)
  positiveFinite('operationTimeoutMs', resolved.operationTimeoutMs)
  if (resolved.graceMs > MAX_TIMER_DELAY_MS || resolved.operationTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`browser-ego-lite: timer values must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return resolved
}

function positiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`browser-ego-lite: ${name} must be positive and finite`)
  }
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`browser-ego-lite: ${name} must be a positive safe integer`)
  }
}
