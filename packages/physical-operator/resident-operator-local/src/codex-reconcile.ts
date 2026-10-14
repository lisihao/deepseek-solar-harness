/**
 * A Codex turn whose start has no authoritative response: hold the Session until the native turn is settled, then
 * report the outcome as unknown instead of failed.
 *
 * `turn/start` was sent, so the native turn may be running even though no response named it. Marking the command
 * failed would release the Session and let the work be dispatched again while the first turn still runs, so the
 * driver keeps the Session occupied while it looks at the thread and only then reports `COMMAND_INDETERMINATE`, which
 * the daemon records as a fenced, never-replayed receipt.
 */
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'

/** The thread reads and the interrupt the reconciliation needs from a Codex app-server connection. */
export interface CodexTurnProbe {
  /** Newest turn of the thread, or undefined when it has none. */
  latestTurn(signal: AbortSignal): Promise<{ readonly id: string; readonly status: string } | undefined>
  /** Best-effort interruption of one native turn. */
  interruptTurn(turnId: string): void
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

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, milliseconds)
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Wait for the native turn that a start of unknown outcome may have created, then fail as indeterminate.
 * @param probe - a live connection to the Codex app-server for the same thread.
 * @param baselineTurnId - the newest turn id the thread had before `turn/start`, when it was captured.
 * @param diagnostic - the start failure's message, which carries the frames and no task text.
 * @param signal - interrupt of the Resident turn; it interrupts the native turn but the wait for it to settle goes on.
 * @param options - timing.
 * @returns never: every path ends in `COMMAND_INDETERMINATE`.
 * @throws ResidentOperatorError - `COMMAND_INDETERMINATE`, naming the native turn and how it ended, or that none appeared.
 */
export async function reconcileUncertainStart(
  probe: CodexTurnProbe,
  baselineTurnId: string | undefined,
  diagnostic: string,
  signal: AbortSignal,
  options: CodexReconcileOptions = {},
): Promise<never> {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS
  const sleep = options.sleep ?? waitFor
  let interrupted = false
  let elapsed = 0
  let nativeTurnId: string | undefined
  let status: string | undefined
  for (;;) {
    let latest: Awaited<ReturnType<CodexTurnProbe['latestTurn']>>
    try {
      // The wait for a native turn is not cut short by the interrupt: the Session stays occupied until it settles.
      latest = await probe.latestTurn(AbortSignal.timeout(Math.max(pollMs * 5, 10_000)))
    } catch (error: unknown) {
      throw new ResidentOperatorError(
        `Codex turn start outcome is unknown and the thread could not be read (${error instanceof Error ? error.message : String(error)}); `
        + `inspect the existing command before retrying. ${diagnostic}`,
        'COMMAND_INDETERMINATE',
      )
    }
    // Once a running turn is identified, it is that turn's status that ends the wait, whatever the baseline says.
    const tracked = nativeTurnId !== undefined && latest?.id === nativeTurnId
    if (latest !== undefined && (tracked || latest.id !== baselineTurnId && (baselineTurnId !== undefined || latest.status === 'inProgress'))) {
      nativeTurnId = latest.id
      status = latest.status
      if (status !== 'inProgress') break
      if (signal.aborted && !interrupted) {
        interrupted = true
        probe.interruptTurn(latest.id)
      }
    } else if (elapsed >= settleMs) {
      break
    }
    if (elapsed >= maxMs) break
    await sleep(pollMs, new AbortController().signal)
    elapsed += pollMs
  }
  const outcome = nativeTurnId === undefined
    ? 'no new native turn was observed'
    : `native turn ${nativeTurnId} ${status === 'inProgress' ? 'was still running when the wait ended' : `ended with status ${String(status)}`}`
  throw new ResidentOperatorError(
    `Codex turn start outcome is unknown; ${outcome}; its output was not captured, so inspect the existing command before retrying. ${diagnostic}`,
    'COMMAND_INDETERMINATE',
  )
}
