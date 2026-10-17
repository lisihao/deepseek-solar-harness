/** Standalone commands reuse the daemon's durable command and business-run owners. */
import {
  OrchestrationError,
  StandaloneRlmStartRejected,
  type OrchestrationCompilationV1,
  type OrchestrationEvent,
  type OrchestrationRunSnapshot,
  type StandaloneRlmCommandSnapshot,
  type StandaloneRlmStartRequest,
} from '@deepseek-ai/dsh-orchestration'
import { PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import { canonicalSha256 } from './canonical.ts'
import { OrchestrationStore, STANDALONE_RLM_START_METHOD, type RuntimeRunRecord } from './store.ts'

/** Existing daemon operations; this owner adds no Scheduler, retry policy or usage ledger. */
export interface StandaloneRlmCommandBindings {
  /** Compile the exact durable input through the existing compiler. */
  compile(request: StandaloneRlmStartRequest): Promise<OrchestrationCompilationV1>
  /** Construct the same initial record/events used by ordinary start, without committing them. */
  initial(compilationId: string): {
    readonly record: RuntimeRunRecord
    readonly events: readonly Omit<OrchestrationEvent, 'sequence'>[]
  }
  /** Wake the existing Scheduler only after the atomic command/run transaction commits. */
  scheduled(): void
  /** Observe actual attempt-owned physical settlement and output, without dispatching. */
  observation(run: OrchestrationRunSnapshot): Pick<StandaloneRlmCommandSnapshot, 'settlement' | 'result' | 'error'>
  /** Cancel through the existing run owner. */
  cancel(run: OrchestrationRunSnapshot): void
}

/** Serializes asynchronous compilation while SQLite remains the only durable deduplication owner. */
export class StandaloneRlmCommands {
  private readonly inFlight = new Map<PhysicalOperatorExecutionId, Promise<void>>()
  private readonly recovered = new Set<string>()
  private readonly recoveredRuns = new Set<string>()
  private readonly cancelled = new Set<PhysicalOperatorExecutionId>()
  private fenced: boolean

  constructor(private readonly store: OrchestrationStore, private readonly bindings: StandaloneRlmCommandBindings) {
    for (const command of store.unfinishedStandaloneCommands()) {
      this.recovered.add(command.commandId)
      if (command.runId !== undefined) this.recoveredRuns.add(command.runId)
    }
    this.fenced = this.recovered.size > 0
  }

  /**
   * Identify business runs whose physical ownership cannot be reconstructed after restart.
   * @param runId - original durable run identity.
   * @returns whether all execution and recovery consumers must remain read-only for this run.
   */
  isRecoveredRun(runId: string): boolean {
    return this.recoveredRuns.has(runId)
  }

  /**
   * Persist before the first asynchronous operation; identical duplicates observe the original operation.
   * @param request - complete validated JSON input, detached from caller mutation.
   * @returns the original command's current observations.
   */
  async start(request: StandaloneRlmStartRequest): Promise<StandaloneRlmCommandSnapshot> {
    const fixed = structuredClone(request)
    const id = fixed.input.executionId
    const digest = canonicalSha256({ method: STANDALONE_RLM_START_METHOD, request: fixed })
    const previous = this.store.commandReceipt(id)
    if (previous !== undefined) {
      if (previous.method !== STANDALONE_RLM_START_METHOD || previous.requestSha256 !== digest) {
        throw new StandaloneRlmStartRejected('standalone execution identity has another immutable input', 'COMMAND_CONFLICT')
      }
      await this.inFlight.get(id)
      return this.inspect(id)
    }
    if (this.fenced) {
      throw new StandaloneRlmStartRejected('unresolved standalone commands fence new admission after recovery or uncertain persistence', 'COMMAND_INDETERMINATE')
    }
    try {
      this.store.acceptStandaloneCommand(id, fixed as unknown as Readonly<Record<string, unknown>>)
    } catch (error) {
      this.fenced = true
      throw error
    }
    const pending = Promise.withResolvers<void>()
    this.inFlight.set(id, pending.promise)
    // The map entry already exists when the compiler synchronously re-enters start.
    void this.advance(id, fixed).then(pending.resolve, pending.reject)
    try {
      await pending.promise
    } finally {
      this.inFlight.delete(id)
    }
    return this.inspect(id)
  }

  /**
   * Read the original identity; unresolved recovery never compiles or starts it again.
   * @param executionId - exact outer command identity.
   * @returns durable progress plus current physical settlement.
   */
  inspect(executionId: PhysicalOperatorExecutionId): StandaloneRlmCommandSnapshot {
    const command = this.store.commandReceipt(executionId)
    if (command?.method !== STANDALONE_RLM_START_METHOD || command.standalonePhase === undefined) {
      throw new OrchestrationError('standalone command does not exist', 'ORCHESTRATION_UNAVAILABLE')
    }
    const run = command.runId === undefined ? undefined : this.store.getRun(command.runId).snapshot
    const observation = command.state === 'settled'
      ? { settlement: 'settled' as const, result: command.response as NonNullable<StandaloneRlmCommandSnapshot['result']> }
      : this.recovered.has(executionId) || command.state === 'indeterminate'
        ? { settlement: 'unknown' as const }
        : command.state === 'failed'
          ? { settlement: 'settled' as const }
          : run === undefined
            ? { settlement: 'not-started' as const }
            : this.bindings.observation(run)
    if (command.state === 'accepted' && run !== undefined && observation.settlement === 'settled') {
      if (observation.result !== undefined) this.store.settleCommand(executionId, observation.result)
      else if (observation.error !== undefined) this.store.failCommand(executionId, observation.error.code, observation.error.message)
    }
    const current = this.store.commandReceipt(executionId)
    if (current === undefined) throw new OrchestrationError('standalone command disappeared during observation', 'COMMAND_INDETERMINATE')
    return {
      executionId,
      state: this.recovered.has(executionId) ? 'indeterminate' : current.state,
      phase: command.standalonePhase,
      requestSha256: command.requestSha256,
      ...run === undefined ? {} : { run },
      ...observation,
      ...current.errorCode === undefined ? {} : { error: { code: current.errorCode, message: current.errorMessage ?? current.errorCode } },
    }
  }

  /**
   * Request cancellation without treating the cancellation receipt as physical settlement.
   * @param executionId - existing command identity.
   * @param requestSha256 - expected immutable input identity, checked before any cancellation effect.
   * @returns the original command after the cancellation request.
   */
  cancel(executionId: PhysicalOperatorExecutionId, requestSha256: string): StandaloneRlmCommandSnapshot {
    const snapshot = this.inspect(executionId)
    if (snapshot.requestSha256 !== requestSha256) throw new StandaloneRlmStartRejected('standalone cancellation input differs from the original command', 'COMMAND_CONFLICT')
    this.cancelled.add(executionId)
    if (snapshot.run !== undefined && !this.isRecoveredRun(String(snapshot.run.runId))) this.bindings.cancel(snapshot.run)
    return this.inspect(executionId)
  }

  private async advance(id: PhysicalOperatorExecutionId, request: StandaloneRlmStartRequest): Promise<void> {
    try {
      const compilation = await this.bindings.compile(request)
      this.store.linkStandaloneCompilation(id, compilation.compilationId)
      if (this.cancelled.has(id)) {
        this.store.failCommand(id, 'STANDALONE_CANCELLED_BEFORE_RUN', 'standalone compilation was cancelled before business-run creation')
        return
      }
      const initial = this.bindings.initial(compilation.compilationId)
      this.store.createStandaloneRunForCommand(id, compilation.compilationId, {
        ...initial.record, standaloneRlmCommandId: id,
      }, initial.events)
      this.bindings.scheduled()
    } catch (error) {
      // Compilation or persistence can have completed before a response/write failed. No replay or known-failure inference.
      this.fenced = true
      try {
        this.store.markCommandIndeterminate(id)
      } catch (writeError) {
        throw new AggregateError([error, writeError], 'standalone command outcome and its durable update are uncertain')
      }
      throw new OrchestrationError(
        error instanceof Error ? error.message : String(error),
        'COMMAND_INDETERMINATE',
      )
    }
  }
}
