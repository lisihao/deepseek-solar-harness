/**
 * A Codex turn whose start the run could not take a turn from: hold the Session while the native turn may still be
 * running, then report the outcome as unknown instead of failed.
 *
 * `turn/start` was sent, so the native turn may be running. Marking the command failed would release the Session and
 * let the work be dispatched again while the first turn still runs, so the driver looks at the thread first and ends
 * in `COMMAND_INDETERMINATE`, which the daemon records as a fenced, never-replayed receipt.
 *
 * Two cases differ in what is known:
 *
 * - The `turn/start` response named the turn (`startedTurnId`) but reading the notifications before it failed. The
 *   server confirmed that turn, so it is waited for by id, may be interrupted if the Resident turn is, and when it
 *   ends the native execution is known to have stopped.
 * - No response named a turn. The turn the start may have created can only be inferred from the thread, so nothing
 *   inferred is ever interrupted or taken as settled: the first new turn is pinned, a second different new turn makes
 *   the identity ambiguous, and every outcome keeps the Session closed to new commands until it is resolved.
 */
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'

/** The thread reads and the interrupt the reconciliation needs from a Codex app-server connection. */
export interface CodexTurnProbe {
  /** Newest turn of the thread, or undefined when it has none. */
  latestTurn(signal: AbortSignal): Promise<{ readonly id: string; readonly status: string } | undefined>
  /** Status of one turn among the thread's newest, or undefined when it is not listed. */
  turnStatus(turnId: string, signal: AbortSignal): Promise<string | undefined>
  /** Best-effort interruption of one native turn. */
  interruptTurn(turnId: string): void
}

/** What the failed start left known. */
export interface CodexUnknownStart {
  /** The newest turn the thread had before `turn/start`, when it was captured. */
  readonly baselineTurnId?: string | undefined
  /** The turn the `turn/start` response named, when it did. */
  readonly startedTurnId?: string | undefined
}

/** Timing of the reconciliation; the defaults suit a live app-server and tests shorten them. */
export interface CodexReconcileOptions {
  /** Time between two reads of the thread. */
  readonly pollMs?: number
  /** How long to wait for a late start before concluding that no new turn appeared. */
  readonly settleMs?: number
  /** Longest wait for a running native turn to settle. */
  readonly maxMs?: number
  /** Replaces the timer, for tests. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}

const DEFAULT_POLL_MS = 1_000
const DEFAULT_SETTLE_MS = 3_000
const DEFAULT_MAX_MS = 20 * 60_000

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds) })
}

function unconfirmed(message: string, diagnostic: string): ResidentOperatorError {
  return new ResidentOperatorError(
    `${message}; its output was not captured, so inspect the existing command before retrying. ${diagnostic}`,
    'COMMAND_INDETERMINATE',
    { nativeOutcomeUnconfirmed: true },
  )
}

function unreadable(error: unknown, diagnostic: string): ResidentOperatorError {
  return unconfirmed(
    `Codex turn start outcome is unknown and the thread could not be read (${error instanceof Error ? error.message : String(error)})`,
    diagnostic,
  )
}

/** Wait for the turn the response named, by id; its end is the one proof that the native execution stopped. */
async function waitForKnownTurn(
  probe: CodexTurnProbe,
  turnId: string,
  diagnostic: string,
  signal: AbortSignal,
  options: Required<CodexReconcileOptions>,
): Promise<never> {
  let interrupted = false
  for (let elapsed = 0; ; elapsed += options.pollMs) {
    let status: string | undefined
    try {
      status = await probe.turnStatus(turnId, AbortSignal.timeout(Math.max(options.pollMs * 5, 10_000)))
    } catch (error: unknown) {
      throw unreadable(error, diagnostic)
    }
    if (status !== undefined && status !== 'inProgress') {
      // The server named this turn and it has ended: the execution is known to have stopped, so the Session is released.
      throw new ResidentOperatorError(
        `Codex turn ${turnId} ended with status ${status} before its notifications could be read; its output was not captured, `
        + `so inspect the existing command before retrying. ${diagnostic}`,
        'COMMAND_INDETERMINATE',
      )
    }
    if (status === 'inProgress' && signal.aborted && !interrupted) {
      // The turn is the one the response named, so interrupting it cannot touch another turn.
      interrupted = true
      probe.interruptTurn(turnId)
    }
    if (elapsed >= options.maxMs) {
      throw unconfirmed(
        `Codex turn ${turnId} ${status === undefined ? 'was not listed' : 'was still running'} when the wait ended`,
        diagnostic,
      )
    }
    await options.sleep(options.pollMs, new AbortController().signal)
  }
}

/** Look for the turn the start may have created, without ever acting on one that is only inferred. */
async function observeInferredTurn(
  probe: CodexTurnProbe,
  baselineTurnId: string | undefined,
  diagnostic: string,
  signal: AbortSignal,
  options: Required<CodexReconcileOptions>,
): Promise<never> {
  let pinned: { readonly id: string; status: string } | undefined
  for (let elapsed = 0; ; elapsed += options.pollMs) {
    let latest: Awaited<ReturnType<CodexTurnProbe['latestTurn']>>
    try {
      latest = await probe.latestTurn(AbortSignal.timeout(Math.max(options.pollMs * 5, 10_000)))
    } catch (error: unknown) {
      throw unreadable(error, diagnostic)
    }
    if (latest !== undefined && latest.id !== baselineTurnId && (baselineTurnId !== undefined || latest.status === 'inProgress' || pinned !== undefined)) {
      if (pinned === undefined) pinned = { id: latest.id, status: latest.status }
      else if (latest.id !== pinned.id) {
        throw unconfirmed(
          `Codex turn start outcome is unknown; two different native turns appeared after it (${pinned.id}, then ${latest.id}) and which one `
          + 'the start created cannot be told, so neither was interrupted or taken as this command\'s',
          diagnostic,
        )
      } else pinned.status = latest.status
    }
    if (pinned !== undefined && pinned.status !== 'inProgress') {
      throw unconfirmed(
        `Codex turn start outcome is unknown; native turn ${pinned.id} appeared after it and ended with status ${pinned.status}, `
        + 'but nothing proves it is this command\'s turn',
        diagnostic,
      )
    }
    if (signal.aborted) {
      throw unconfirmed(
        `Codex turn start outcome is unknown and the Resident turn was interrupted while ${pinned === undefined ? 'no new native turn was seen' : `native turn ${pinned.id} was still running`}; `
        + 'no native turn was interrupted',
        diagnostic,
      )
    }
    if (pinned === undefined && elapsed >= options.settleMs) {
      throw unconfirmed('Codex turn start outcome is unknown; no new native turn was observed, though the start may still land', diagnostic)
    }
    if (elapsed >= options.maxMs) {
      throw unconfirmed(`Codex turn start outcome is unknown; native turn ${pinned?.id ?? 'unknown'} was still running when the wait ended`, diagnostic)
    }
    await options.sleep(options.pollMs, new AbortController().signal)
  }
}

/**
 * Wait for the native turn that a start of unknown outcome may have created, then fail as indeterminate.
 * @param probe - a live connection to the Codex app-server for the same thread.
 * @param start - what the failed start left known: the baseline turn and, when the response named it, the turn.
 * @param diagnostic - the start failure's message, which carries the frames and no task text.
 * @param signal - interrupt of the Resident turn.
 * @param options - timing.
 * @returns never: every path ends in `COMMAND_INDETERMINATE`.
 * @throws ResidentOperatorError - `COMMAND_INDETERMINATE`. It carries `nativeOutcomeUnconfirmed` unless the turn the
 *   response named was seen to end, so a turn that is only inferred keeps the Session closed to new commands.
 */
export function reconcileUncertainStart(
  probe: CodexTurnProbe,
  start: CodexUnknownStart,
  diagnostic: string,
  signal: AbortSignal,
  options: CodexReconcileOptions = {},
): Promise<never> {
  const timing: Required<CodexReconcileOptions> = {
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    settleMs: options.settleMs ?? DEFAULT_SETTLE_MS,
    maxMs: options.maxMs ?? DEFAULT_MAX_MS,
    sleep: options.sleep ?? waitFor,
  }
  return start.startedTurnId === undefined
    ? observeInferredTurn(probe, start.baselineTurnId, diagnostic, signal, timing)
    : waitForKnownTurn(probe, start.startedTurnId, diagnostic, signal, timing)
}
