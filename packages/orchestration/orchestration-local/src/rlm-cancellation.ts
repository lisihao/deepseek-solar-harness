/** Cancellation of the API executions of one RLM attempt. */

/** The cancellation state of one execution: the signal it runs under and the way to stop only it. */
export interface RlmExecutionCancellation {
  /** Aborts when this execution is interrupted or when an ancestor execution is cancelled. */
  readonly signal: AbortSignal
  /** Abort this execution and, through the signal it hands to its children, everything it spawned; nothing above or beside it. */
  abort(): void
}

/**
 * Gives every execution of an RLM attempt its own abort controller that also follows its ancestors.
 *
 * The attempt's controller is the root: cancelling the attempt reaches every execution once. A child's first execution
 * follows the current execution of the session that spawned it, so interrupting or deleting that parent's turn aborts
 * the child and, in turn, what the child spawned, and never a sibling. A later execution of a session (a continuation)
 * follows only the attempt, so it is not born aborted because the turn of an ancestor that spawned it was interrupted.
 * A delete or interrupt of an ancestor reaches the active executions of its subtree through the runtime, not through
 * this scope.
 */
export class RlmCancellationScope {
  private readonly signals = new Map<string, AbortSignal>()

  /**
   * @param attempt - cancellation of the whole attempt.
   * @param rootSessionId - the attempt's root RLM runtime session.
   */
  constructor(private readonly attempt: AbortSignal, rootSessionId: string) {
    this.signals.set(rootSessionId, attempt)
  }

  /**
   * Start a new execution of a session.
   * @param sessionId - the runtime session the execution runs for.
   * @param parentSessionId - the session that spawned it, for the first execution of a child; omit for a later execution.
   * @returns the execution's signal and its own abort.
   */
  begin(sessionId: string, parentSessionId?: string): RlmExecutionCancellation {
    const inherited = (parentSessionId === undefined ? undefined : this.signals.get(parentSessionId)) ?? this.attempt
    const own = new AbortController()
    const signal = AbortSignal.any([inherited, own.signal])
    this.signals.set(sessionId, signal)
    return { signal, abort: () => { own.abort() } }
  }
}
