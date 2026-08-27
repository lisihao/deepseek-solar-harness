/** Prime-compatible host-driven Autonomous Mode policy and gate state machine. */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  RlmAutonomousConfigV1,
  RlmAutonomousMode,
  RlmAutonomousPolicyV1,
} from '@deepseek-ai/dsh-orchestration'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { canonicalSha256 } from './canonical.ts'

/** Prime Agent's default host continuation instruction. */
export const DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT = [
  'No human input is available in autonomous mode. Continue working until the host evaluator, verifier, or configured autonomous limits stop the run.',
  'If you were asking the user a question, make a reasonable assumption and verify it.',
  'If you believe you are blocked, prove it with host-observable evidence, preserve that evidence, and keep looking for safe progress while budget remains.',
  'Do not end the session yourself; the verifier/evaluator decides completion when configured gates pass.',
].join(' ')

/** Prime Agent's published Autonomous Mode limits and quality-gate budgets. */
export const DEFAULT_AUTONOMOUS_LIMITS = {
  maxContinuations: 3,
  maxTurns: 12,
  maxTokens: 80_000,
  timeoutMs: 30 * 60 * 1_000,
  gateMaxRetries: 3,
  gateTimeoutMs: 5 * 60 * 1_000,
} as const

/** Bounded diagnostic retained for the latest failed host quality gate. */
export interface AutonomousGateFailureV1 {
  readonly command: string
  readonly attempt: number
  readonly exitText: string
  readonly output: string
}

/** Durable per-attempt state; the Scheduler remains the only execution authority. */
export interface AutonomousRuntimeStateV1 {
  readonly version: 1
  readonly enabled: boolean
  readonly continuationsUsed: number
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly accountedCommandIds: readonly string[]
  readonly startedAt?: string
  readonly gateAttempts: Readonly<Record<string, number>>
  readonly lastGateFailure?: AutonomousGateFailureV1
  readonly lastGateWorkspaceFingerprint?: string
  readonly terminalReason?: AutonomousTerminalReason
}

/** First exhausted host budget in Prime Agent's published evaluation order. */
export type AutonomousLimitReason = 'maxContinuations' | 'maxTurns' | 'maxTokens' | 'timeoutMs'
/** Durable reason why host-driven Autonomous Mode stopped this attempt. */
export type AutonomousTerminalReason = 'gate_passed' | 'gate_retry_exhausted' | AutonomousLimitReason | 'disabled'

/** Scheduler action produced after host gates and limits are evaluated. */
export type AutonomousDecisionV1 =
  | { readonly action: 'complete'; readonly state: AutonomousRuntimeStateV1; readonly reason: AutonomousTerminalReason }
  | { readonly action: 'continue'; readonly state: AutonomousRuntimeStateV1; readonly reason: 'gate_failed' | 'missing_terminal_evidence'; readonly prompt: string }

/** Provider usage counters used by durable Autonomous budget accounting. */
export interface AutonomousUsageV1 {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
}

const MAX_GATE_OUTPUT_CHARS = 6_000
const MAX_CHILD_OUTPUT_CHARS = 1024 * 1024

function withoutGateFailure(state: AutonomousRuntimeStateV1): AutonomousRuntimeStateV1 {
  const {
    lastGateFailure: _lastGateFailure,
    lastGateWorkspaceFingerprint: _lastGateWorkspaceFingerprint,
    ...rest
  } = state
  return rest
}

/**
 * Resolve graph/admission selection to the immutable policy stored in the ExecutionPlan.
 * @param config Node-owned Autonomous Mode configuration.
 * @param admissionMode Session admission default when the Graph omits a mode.
 * @param rlmEnabled Whether this attempt has an RLM execution strategy.
 * @returns Content-addressable policy sealed into the attempt's ExecutionPlan.
 */
export function resolveAutonomousPolicy(
  config: RlmAutonomousConfigV1 | undefined,
  admissionMode: RlmAutonomousMode | undefined,
  rlmEnabled: boolean,
): RlmAutonomousPolicyV1 {
  const mode = config?.mode ?? admissionMode ?? 'disabled'
  const enabled = mode === 'enabled' || (mode === 'auto' && rlmEnabled)
  const fields = {
    version: 1 as const,
    enabled,
    maxContinuations: config?.maxContinuations ?? DEFAULT_AUTONOMOUS_LIMITS.maxContinuations,
    maxTurns: config?.maxTurns ?? DEFAULT_AUTONOMOUS_LIMITS.maxTurns,
    maxTokens: config?.maxTokens ?? DEFAULT_AUTONOMOUS_LIMITS.maxTokens,
    timeoutMs: config?.timeoutMs ?? DEFAULT_AUTONOMOUS_LIMITS.timeoutMs,
    continuationPrompt: config?.continuationPrompt?.trim() || DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
    gates: {
      commands: [...(config?.gates?.commands ?? [])],
      maxRetries: config?.gates?.maxRetries ?? DEFAULT_AUTONOMOUS_LIMITS.gateMaxRetries,
      timeoutMs: config?.gates?.timeoutMs ?? DEFAULT_AUTONOMOUS_LIMITS.gateTimeoutMs,
    },
  }
  return { ...fields, policySha256: canonicalSha256(fields) }
}

/**
 * Create the first durable Autonomous Mode state for one attempt.
 * @param policy Sealed attempt policy.
 * @param startedAt Clock sample used by the elapsed-time budget.
 * @returns Initial durable state.
 */
export function createAutonomousState(policy: RlmAutonomousPolicyV1, startedAt = new Date()): AutonomousRuntimeStateV1 {
  return {
    version: 1,
    enabled: policy.enabled,
    continuationsUsed: 0,
    turnsUsed: 0,
    tokensUsed: 0,
    accountedCommandIds: [],
    ...policy.enabled ? { startedAt: startedAt.toISOString() } : { terminalReason: 'disabled' as const },
    gateAttempts: {},
  }
}

/**
 * Count Prime usage: non-cached input + output + cache-write; cache-read is Trace-only.
 * @param state Current durable attempt state.
 * @param commandId Receipt identity that makes accounting idempotent.
 * @param usage Provider-reported usage for the settled turn.
 * @returns Updated state, or the same object when the receipt was already counted.
 */
export function accountAutonomousUsage(
  state: AutonomousRuntimeStateV1,
  commandId: string,
  usage: AutonomousUsageV1 | undefined,
): AutonomousRuntimeStateV1 {
  if (!state.enabled || state.accountedCommandIds.includes(commandId)) return state
  return {
    ...state,
    accountedCommandIds: [...state.accountedCommandIds, commandId],
    turnsUsed: state.turnsUsed + 1,
    tokensUsed: state.tokensUsed
      + (usage?.inputTokens ?? 0)
      + (usage?.outputTokens ?? 0)
      + (usage?.cacheWriteInputTokens ?? 0),
  }
}

/**
 * Evaluate Prime Agent's limit order without changing state.
 * @param policy Sealed attempt policy.
 * @param state Current durable attempt state.
 * @param now Clock sample used by the elapsed-time budget.
 * @returns First exhausted limit, or undefined while budget remains.
 */
export function autonomousLimitReason(
  policy: RlmAutonomousPolicyV1,
  state: AutonomousRuntimeStateV1,
  now = new Date(),
): AutonomousLimitReason | undefined {
  if (state.continuationsUsed >= policy.maxContinuations) return 'maxContinuations'
  if (state.turnsUsed >= policy.maxTurns) return 'maxTurns'
  if (state.tokensUsed >= policy.maxTokens) return 'maxTokens'
  if (state.startedAt !== undefined && now.getTime() - Date.parse(state.startedAt) >= policy.timeoutMs) return 'timeoutMs'
  return undefined
}

/**
 * Run host gates before limits and decide whether one more existing-session turn is required.
 * @param policy Sealed attempt policy.
 * @param state Current durable attempt state.
 * @param workspace Canonical workspace whose state gates inspect.
 * @param signal Abort signal owned by the Scheduler attempt.
 * @param now Clock sample used by prompts and elapsed-time limits.
 * @returns Durable terminal or continuation decision.
 */
export async function nextAutonomousDecision(
  policy: RlmAutonomousPolicyV1,
  state: AutonomousRuntimeStateV1,
  workspace: string,
  signal?: AbortSignal,
  now = new Date(),
): Promise<AutonomousDecisionV1> {
  signal?.throwIfAborted()
  if (!policy.enabled || !state.enabled) {
    return { action: 'complete', state: { ...state, terminalReason: 'disabled' }, reason: 'disabled' }
  }
  if (state.terminalReason !== undefined) {
    return { action: 'complete', state, reason: state.terminalReason }
  }
  const gate = await refreshQualityGates(policy, state, workspace, signal)
  signal?.throwIfAborted()
  if (gate?.result === 'passed') {
    const settled = { ...gate.state, terminalReason: 'gate_passed' as const }
    return { action: 'complete', state: settled, reason: 'gate_passed' }
  }
  const limit = autonomousLimitReason(policy, gate?.state ?? state, now)
  if (gate?.result === 'retry_exhausted') {
    const settled = { ...gate.state, terminalReason: 'gate_retry_exhausted' as const }
    return { action: 'complete', state: settled, reason: 'gate_retry_exhausted' }
  }
  if (limit !== undefined) {
    const settled = { ...(gate?.state ?? state), terminalReason: limit }
    return { action: 'complete', state: settled, reason: limit }
  }
  const next = { ...(gate?.state ?? state), continuationsUsed: (gate?.state ?? state).continuationsUsed + 1 }
  return {
    action: 'continue',
    state: next,
    reason: gate?.result === 'failed' ? 'gate_failed' : 'missing_terminal_evidence',
    prompt: gate?.result === 'failed' && next.lastGateFailure !== undefined
      ? gateFailurePrompt(next.lastGateFailure, policy.gates.maxRetries, now)
      : policy.continuationPrompt,
  }
}

function gateFailurePrompt(failure: AutonomousGateFailureV1, maxRetries: number, now: Date): string {
  return [
    `Autonomous quality gate failed (attempt ${String(failure.attempt)}/${String(maxRetries)}): \`${failure.command}\` ${failure.exitText}.`,
    failure.output.length === 0 ? '' : `Output:\n${failure.output}`,
    `Continue working. Fix the failure, then produce terminal evidence. Timestamp: ${now.toISOString()}.`,
  ].filter(Boolean).join('\n\n')
}

async function refreshQualityGates(
  policy: RlmAutonomousPolicyV1,
  state: AutonomousRuntimeStateV1,
  workspace: string,
  signal?: AbortSignal,
): Promise<{ readonly result: 'passed' | 'failed' | 'retry_exhausted'; readonly state: AutonomousRuntimeStateV1 } | undefined> {
  if (policy.gates.commands.length === 0) return undefined
  let next = state
  for (const command of policy.gates.commands) {
    signal?.throwIfAborted()
    const before = await gitWorkspaceFingerprint(workspace, signal)
    if (next.lastGateFailure?.command === command
      && before !== undefined
      && before === next.lastGateWorkspaceFingerprint) {
      const attempt = (next.gateAttempts[command] ?? next.lastGateFailure.attempt) + 1
      next = {
        ...next,
        gateAttempts: { ...next.gateAttempts, [command]: attempt },
        lastGateFailure: {
          ...next.lastGateFailure,
          attempt,
          exitText: 'not rerun: workspace unchanged since previous failed gate',
          output: 'The autonomous gate was not rerun because the workspace has not changed since this failure. Edit source files, tests, or a blocker artifact before attempting to finish again.',
        },
      }
      return { result: attempt > policy.gates.maxRetries ? 'retry_exhausted' : 'failed', state: next }
    }
    const result = await runShell(command, workspace, policy.gates.timeoutMs, signal)
    signal?.throwIfAborted()
    const after = await gitWorkspaceFingerprint(workspace, signal)
    if (result.status === 0 && !result.timedOut) {
      const cleared = next.lastGateFailure?.command === command ? withoutGateFailure(next) : next
      next = {
        ...cleared,
        gateAttempts: { ...cleared.gateAttempts, [command]: 0 },
      }
      continue
    }
    const attempt = (next.gateAttempts[command] ?? 0) + 1
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    next = {
      ...next,
      gateAttempts: { ...next.gateAttempts, [command]: attempt },
      lastGateFailure: {
        command,
        attempt,
        exitText: result.timedOut
          ? 'timed out'
          : result.signal === null ? `exited ${String(result.status ?? 'unknown')}` : `terminated by ${result.signal}`,
        output: truncateGateOutput(output, result.outputTruncated),
      },
      ...after === undefined ? {} : { lastGateWorkspaceFingerprint: after },
    }
    return { result: attempt > policy.gates.maxRetries ? 'retry_exhausted' : 'failed', state: next }
  }
  return {
    result: 'passed',
    state: withoutGateFailure(next),
  }
}

async function gitWorkspaceFingerprint(workspace: string, signal?: AbortSignal): Promise<string | undefined> {
  const status = await runProcess('git', ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall', '--no-renames'], workspace, 10_000, signal)
  if (status.status !== 0 || status.timedOut || status.outputTruncated) return undefined
  const diff = await runProcess('git', ['--no-optional-locks', 'diff', '--no-ext-diff', '--binary', 'HEAD'], workspace, 10_000, signal)
  if (diff.status !== 0 || diff.timedOut || diff.outputTruncated) return undefined
  const hash = createHash('sha256').update(status.stdout).update('\0').update(diff.stdout)
  for (const entry of status.stdout.split('\0').filter(value => value.startsWith('?? ')).map(value => value.slice(3)).sort()) {
    signal?.throwIfAborted()
    hash.update('\0').update(entry).update('\0').update(await hashUntracked(resolve(workspace, entry)))
  }
  return hash.digest('hex')
}

async function hashUntracked(path: string): Promise<string> {
  try {
    const stat = await lstat(path)
    if (stat.isSymbolicLink()) return `symlink:${await readlink(path)}`
    if (!stat.isFile()) return `other:${String(stat.mode)}:${String(stat.size)}:${String(stat.mtimeMs)}`
    return `file:${createHash('sha256').update(await readFile(path)).digest('hex')}`
  } catch (error) {
    return `error:${error instanceof Error ? error.message : String(error)}`
  }
}

interface ChildResult {
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly outputTruncated: boolean
}

function runShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ChildResult> {
  return process.platform === 'win32'
    ? runProcess('cmd.exe', ['/d', '/s', '/c', command], cwd, timeoutMs, signal)
    : runProcess('/bin/sh', ['-lc', command], cwd, timeoutMs, signal)
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ChildResult> {
  signal?.throwIfAborted()
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      detached: process.platform !== 'win32',
      env: scrubbedParentEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let outputTruncated = false
    let timedOut = false
    let settled = false
    let abortError: Error | undefined
    const append = (current: string, chunk: string): string => {
      const remaining = MAX_CHILD_OUTPUT_CHARS - current.length
      if (remaining <= 0) {
        outputTruncated = true
        return current
      }
      if (chunk.length > remaining) outputTruncated = true
      return current + chunk.slice(0, remaining)
    }
    const kill = (): void => {
      if (child.pid === undefined) return
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      }
      else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const finish = (result: ChildResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aborted)
      resolvePromise(result)
    }
    const aborted = (): void => {
      if (abortError !== undefined || settled) return
      abortError = signal?.reason instanceof Error ? signal.reason : new Error('autonomous gate aborted')
      kill()
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)
    timer.unref()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk) })
    child.once('error', (error) => {
      stderr = append(stderr, error.message)
      finish({ status: child.exitCode, signal: child.signalCode, stdout, stderr, timedOut, outputTruncated })
    })
    child.once('close', (status, childSignal) => {
      if (abortError !== undefined) {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
        reject(abortError)
      } else {
        finish({ status, signal: childSignal, stdout, stderr, timedOut, outputTruncated })
      }
    })
    signal?.addEventListener('abort', aborted, { once: true })
    if (signal?.aborted === true) aborted()
  })
}

function truncateGateOutput(output: string, alreadyTruncated: boolean): string {
  if (output.length <= MAX_GATE_OUTPUT_CHARS && !alreadyTruncated) return output
  return `${output.slice(0, MAX_GATE_OUTPUT_CHARS)}\n... [truncated]`
}
