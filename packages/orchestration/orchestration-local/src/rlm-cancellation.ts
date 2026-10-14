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
 * The attempt's controller is the root: cancelling the attempt reaches every execution once. A child's controller
 * follows the execution of the session that spawned it, so interrupting or deleting that child aborts it and the
 * children it spawned, and never the parent or a sibling. A later execution of a session (a continuation) follows
 * the session's parent, not its own earlier execution, so an interrupted turn does not abort the turn after it.
 */
export class RlmCancellationScope {
  private readonly signals = new Map<string, AbortSignal>()
  private readonly parents = new Map<string, string>()

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
   * @param parentSessionId - the session that spawned it; omit for a later execution of a known session.
   * @returns the execution's signal and its own abort.
   */
  begin(sessionId: string, parentSessionId?: string): RlmExecutionCancellation {
    if (parentSessionId !== undefined) this.parents.set(sessionId, parentSessionId)
    const parent = this.parents.get(sessionId)
    const inherited = (parent === undefined ? undefined : this.signals.get(parent)) ?? this.attempt
    const own = new AbortController()
    const signal = AbortSignal.any([inherited, own.signal])
    this.signals.set(sessionId, signal)
    return { signal, abort: () => { own.abort() } }
  }
}
