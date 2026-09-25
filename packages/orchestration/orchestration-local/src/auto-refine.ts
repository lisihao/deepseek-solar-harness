/** Prime-compatible durable auto-refinement checkpoint coordinator. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Prime v0.8.0 auto-refinement defaults. */
export interface AutoRefineSettings {
  readonly enabled: boolean
  readonly turnInterval: number
  readonly compact: boolean
  readonly cooldownMs: number
}

/** Prime Agent v0.8.0 defaults, exposed so product configuration can override them explicitly. */
export const PRIME_AUTO_REFINE_DEFAULTS: AutoRefineSettings = Object.freeze({
  enabled: true,
  turnInterval: 25,
  compact: true,
  cooldownMs: 20 * 60_000,
})

/** Result of the inexpensive model review gate. */
export interface AutoRefineReview {
  readonly shouldRefine: boolean
  readonly rationale: string
  readonly instructions?: string
}

/** One root-session checkpoint observed at a real turn boundary. */
export interface AutoRefineBoundary {
  readonly sessionId: string
  /** Immutable trajectory identity captured before review and rechecked before apply. */
  readonly branchVersion: string
  readonly reason: 'turn_interval' | 'compact'
  readonly occurredAt: string
  readonly isRoot: boolean
}

/** External model and Continuous Harness boundary used by the coordinator. */
export interface AutoRefineExecutor<Proposal, Applied> {
  readonly review: (boundary: AutoRefineBoundary & { readonly turnsSinceLastReview: number }) => Promise<AutoRefineReview>
  readonly plan: (
    boundary: AutoRefineBoundary & { readonly turnsSinceLastReview: number; readonly review: AutoRefineReview },
  ) => Promise<Proposal>
  readonly apply: (boundary: AutoRefineBoundary & { readonly proposal: Proposal }) => Promise<Applied>
}

/** Observable outcome of one boundary check. */
export type AutoRefineOutcome<Applied> =
  | { readonly state: 'disabled' | 'child' | 'not-due' | 'cooldown' }
  | {
    readonly state: 'indeterminate'
    readonly roundId: string
    readonly phase: AutoRefinePhase
    readonly startedAt: string
    readonly branchVersion: string
  }
  | { readonly state: 'reviewed'; readonly roundId: string; readonly review: AutoRefineReview }
  | { readonly state: 'applied'; readonly roundId: string; readonly review: AutoRefineReview; readonly applied: Applied }
  | { readonly state: 'failed'; readonly roundId: string; readonly phase: AutoRefinePhase; readonly error: string }

type AutoRefinePhase = 'review' | 'plan' | 'apply'

interface AutoRefineSessionState {
  assistantTurnsSinceReview: number
  lastReviewAt?: string
  pendingCompact: boolean
  pendingCompactExecution?: {
    readonly commandId: string
    readonly requestedAt: string
    readonly state: 'scheduled' | 'running'
    readonly instructions?: string
    readonly residentSessionId?: string
    readonly expectedStateRevision?: number
  }
  lastCompactError?: string
  inFlight?: {
    readonly roundId: string
    readonly phase: AutoRefinePhase
    readonly startedAt: string
    readonly branchVersion: string
  }
  lastOutcome?: 'reviewed' | 'applied' | 'failed'
}

interface AutoRefineDocument {
  version: 1
  sessions: Record<string, AutoRefineSessionState>
}

function isAutoRefineDocument(value: unknown): value is AutoRefineDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as { readonly version?: unknown; readonly sessions?: unknown }
  return candidate.version === 1
    && candidate.sessions !== null
    && typeof candidate.sessions === 'object'
    && !Array.isArray(candidate.sessions)
}

function defaultDocument(): AutoRefineDocument {
  return { version: 1, sessions: {} }
}

function atomicWrite(path: string, value: AutoRefineDocument): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8')
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Persists the root-only turn counter, cooldown, and external-call receipt.
 * An unfinished external phase is never retried automatically after restart.
 */
export class DurableAutoRefineCoordinator {
  private readonly document: AutoRefineDocument

  constructor(private readonly statePath: string, private readonly settings: AutoRefineSettings) {
    if (!Number.isSafeInteger(settings.turnInterval) || settings.turnInterval < 1) throw new Error('auto-refine turnInterval must be a positive integer')
    if (!Number.isFinite(settings.cooldownMs) || settings.cooldownMs < 0) throw new Error('auto-refine cooldownMs must be non-negative')
    try {
      const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!isAutoRefineDocument(parsed)) throw new Error('unsupported auto-refine state')
      this.document = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.document = defaultDocument()
    }
  }

  /**
   * Inspect durable state without exposing mutable storage.
   * @param sessionId - owning DSH Session identity.
   * @returns an immutable copy of the current refinement state.
   */
  inspect(sessionId: string): Readonly<AutoRefineSessionState> {
    return structuredClone(this.document.sessions[sessionId] ?? { assistantTurnsSinceReview: 0, pendingCompact: false })
  }

  /**
   * Persist a compaction checkpoint until the next root turn boundary can review it.
   * @param sessionId - owning DSH Session identity.
   * @param instructions - optional native compaction guidance.
   * @returns the durable compaction execution record.
   */
  markCompact(sessionId: string, instructions?: string): NonNullable<AutoRefineSessionState['pendingCompactExecution']> {
    const state = this.session(sessionId)
    if (state.pendingCompactExecution !== undefined) return structuredClone(state.pendingCompactExecution)
    state.pendingCompact = true
    state.pendingCompactExecution = {
      commandId: `compact-${randomUUID()}`,
      requestedAt: new Date().toISOString(),
      state: 'scheduled',
      ...instructions === undefined ? {} : { instructions },
    }
    delete state.lastCompactError
    this.persist()
    return structuredClone(state.pendingCompactExecution)
  }

  /**
   * Fence the native product call before crossing the daemon boundary.
   * @param sessionId - owning DSH Session identity.
   * @param commandId - durable compaction command identity.
   * @param residentSessionId - native Resident Session being compacted.
   * @param expectedStateRevision - revision inspected before dispatch.
   */
  markCompactRunning(
    sessionId: string,
    commandId: string,
    residentSessionId: string,
    expectedStateRevision: number,
  ): void {
    const state = this.session(sessionId)
    const pending = state.pendingCompactExecution
    if (pending?.commandId !== commandId) throw new Error(`native compaction command changed for ${sessionId}`)
    state.pendingCompactExecution = {
      ...pending,
      state: 'running',
      residentSessionId,
      expectedStateRevision,
    }
    this.persist()
  }

  /**
   * Mark native history compaction complete while retaining the auto-refine trigger.
   * @param sessionId - owning DSH Session identity.
   * @param commandId - optional command identity used to fence stale completion.
   */
  markCompactPerformed(sessionId: string, commandId?: string): void {
    const state = this.session(sessionId)
    if (state.pendingCompactExecution === undefined) throw new Error(`no native compaction is scheduled for ${sessionId}`)
    if (commandId !== undefined && state.pendingCompactExecution.commandId !== commandId) {
      throw new Error(`native compaction command changed for ${sessionId}`)
    }
    delete state.pendingCompactExecution
    delete state.lastCompactError
    this.persist()
  }

  /**
   * Settle one failed native compaction without silently retrying it on every turn.
   * @param sessionId - owning DSH Session identity.
   * @param error - bounded failure explanation.
   * @param commandId - optional command identity used to fence stale failure.
   */
  markCompactFailed(sessionId: string, error: string, commandId?: string): void {
    const state = this.session(sessionId)
    if (commandId !== undefined && state.pendingCompactExecution?.commandId !== commandId) {
      throw new Error(`native compaction command changed for ${sessionId}`)
    }
    delete state.pendingCompactExecution
    state.pendingCompact = false
    state.lastCompactError = error
    this.persist()
  }

  /**
   * Explicitly resolve a crash-uncertain review round without replaying it.
   * @param sessionId - owning DSH Session identity.
   * @param roundId - uncertain refinement round identity.
   * @param expectedBranchVersion - exact harness branch version inspected by the caller.
   */
  resolveIndeterminate(sessionId: string, roundId: string, expectedBranchVersion: string): void {
    const state = this.session(sessionId)
    if (state.inFlight?.roundId !== roundId) throw new Error(`auto-refine round is not indeterminate: ${roundId}`)
    if (state.inFlight.branchVersion !== expectedBranchVersion) {
      throw new Error(`auto-refine branch changed before resolution: ${roundId}`)
    }
    delete state.inFlight
    state.lastOutcome = 'failed'
    state.lastReviewAt = new Date().toISOString()
    state.assistantTurnsSinceReview = 0
    this.persist()
  }

  /**
   * Evaluate one real model-turn boundary and apply an approved proposal there.
   * @param boundary - model-visible root-turn boundary and branch version.
   * @param executor - proposal and application implementation for the configured Provider.
   * @returns the deterministic outcome of this refinement opportunity.
   */
  async boundary<Proposal, Applied>(
    boundary: AutoRefineBoundary,
    executor: AutoRefineExecutor<Proposal, Applied>,
  ): Promise<AutoRefineOutcome<Applied>> {
    if (!this.settings.enabled) return { state: 'disabled' }
    if (!boundary.isRoot) return { state: 'child' }
    const state = this.session(boundary.sessionId)
    if (boundary.reason === 'turn_interval') state.assistantTurnsSinceReview += 1
    else state.pendingCompact = true
    this.persist()
    if (state.inFlight !== undefined) return { state: 'indeterminate', ...state.inFlight }
    const dueByTurns = state.assistantTurnsSinceReview >= this.settings.turnInterval
    const dueByCompact = this.settings.compact && state.pendingCompact
    const due = dueByTurns || dueByCompact
    if (!due) return { state: 'not-due' }
    const occurredAt = Date.parse(boundary.occurredAt)
    const lastReviewAt = parseTimestamp(state.lastReviewAt)
    if (lastReviewAt !== undefined && occurredAt - lastReviewAt < this.settings.cooldownMs) return { state: 'cooldown' }

    const roundId = `auto-refine-${randomUUID()}`
    const turnsSinceLastReview = state.assistantTurnsSinceReview
    const effectiveBoundary: AutoRefineBoundary = {
      ...boundary,
      reason: dueByCompact ? 'compact' : 'turn_interval',
    }
    const externalBoundary = { ...effectiveBoundary, turnsSinceLastReview }
    state.inFlight = { roundId, phase: 'review', startedAt: boundary.occurredAt, branchVersion: boundary.branchVersion }
    this.persist()
    let phase: AutoRefinePhase = 'review'
    try {
      const review = await executor.review(externalBoundary)
      state.lastReviewAt = boundary.occurredAt
      state.assistantTurnsSinceReview = 0
      state.pendingCompact = false
      if (!review.shouldRefine) {
        delete state.inFlight
        state.lastOutcome = 'reviewed'
        this.persist()
        return { state: 'reviewed', roundId, review }
      }
      phase = 'plan'
      state.inFlight = { roundId, phase, startedAt: boundary.occurredAt, branchVersion: boundary.branchVersion }
      this.persist()
      const proposal = await executor.plan({ ...externalBoundary, review })
      phase = 'apply'
      state.inFlight = { roundId, phase, startedAt: boundary.occurredAt, branchVersion: boundary.branchVersion }
      this.persist()
      const applied = await executor.apply({ ...effectiveBoundary, proposal })
      delete state.inFlight
      state.lastOutcome = 'applied'
      this.persist()
      return { state: 'applied', roundId, review, applied }
    } catch (error) {
      delete state.inFlight
      state.lastOutcome = 'failed'
      state.lastReviewAt = boundary.occurredAt
      state.assistantTurnsSinceReview = 0
      state.pendingCompact = false
      this.persist()
      return { state: 'failed', roundId, phase, error: errorText(error) }
    }
  }

  private session(sessionId: string): AutoRefineSessionState {
    return this.document.sessions[sessionId] ??= { assistantTurnsSinceReview: 0, pendingCompact: false }
  }

  private persist(): void {
    atomicWrite(this.statePath, this.document)
  }
}
