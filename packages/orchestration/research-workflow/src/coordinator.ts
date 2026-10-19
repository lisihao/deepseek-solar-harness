/** Standard fixed-stage research Consumer; the original Host alone admits external actions. */
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { ResearchActionError, type ResearchWorkflowDefinitionInput, type ResearchWorkflowStage,
  type ResearchWorkflowPreviewId, type ResearchWorkflowPreview, type ResearchWorkflowState,
  type ResearchActionId } from '@deepseek-ai/dsh-research-handoff'
import type { ResearchWorkflowHost } from './host.ts'
import './events.ts'

/** One exact workflow projection owned by this successful persistence call. */
export interface ResearchWorkflowReceipt {
  readonly state: ResearchWorkflowState
  readonly eventSeq: number
}

/** Await one caller without transferring cancellation ownership of the underlying operation. */
function waitForCall<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => {
      signal.removeEventListener('abort', aborted)
      reject(signal.reason instanceof Error ? signal.reason : new Error('research workflow call cancelled', { cause: signal.reason }))
    }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', aborted); resolve(value) },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted)
        reject(error instanceof Error ? error : new Error('research workflow operation rejected', { cause: error }))
      },
    )
  })
}

/** Fixed original stages, full Session projections and explicit human-confirmed execution. */
export class ResearchWorkflowCoordinator {
  private readonly pending = new Map<ResearchActionId, { sha256: string; promise: Promise<ResearchWorkflowState> }>()

  /**
   * @param sessions - Actual Session owner.
   * @param session - Same live Session as the Host.
   * @param host - Current scoped Host; saved data cannot reconstruct this capability.
   */
  constructor(private readonly sessions: SessionStore, private readonly session: Session, private readonly host: ResearchWorkflowHost) {}

  /**
   * Persist the full canonical workflow input and its current state before any action.
   * @param input - Full canonical initial definition; a restart reuses the same run, Session and stage identities.
   * @param callSignal - This caller's local cancellation; it does not revoke the Host.
   * @returns Full current state after the original definition and state are durably logged; no action is started.
   */
  async start(input: ResearchWorkflowDefinitionInput, callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    const fixed = structuredClone(input)
    this.assertLive(callSignal)
    if (fixed.sessionId !== this.session.id) throw new ResearchActionError('workflow Session differs from current Host', 'OWNER')
    const definition = this.host.read(control => control.claimWorkflowDefinition(this.host.runId, fixed))
    this.session.append('research/workflow', { version: 1, ownerId: this.owner(), runId: this.host.runId,
      sessionId: this.session.id, definition })
    await this.flush(callSignal)
    return this.sync(callSignal)
  }

  /**
   * Prepare and durably project the complete next-stage preview.
   * @param kind - Explicit next fixed stage.
   * @param id - Explicit immutable preview identity.
   * @param callSignal - This caller's local cancellation.
   * @returns Current full preview after its complete state projection is durable; no implicit human confirmation.
   */
  async preview(kind: ResearchWorkflowStage['kind'], id: ResearchWorkflowPreviewId,
    callSignal?: AbortSignal): Promise<ResearchWorkflowPreview> {
    this.assertLive(callSignal)
    await this.ensureDefinitionLogged(callSignal)
    this.assertLive(callSignal)
    this.host.read(control => control.previewWorkflowStage(this.host.runId, kind, id))
    await this.sync(callSignal)
    this.assertLive(callSignal)
    return this.host.readPreview(id)
  }

  /**
   * Execute one frozen action through Session logging and its current request guard.
   * @param id - Exact confirmed original preview.
   * @param sha256 - Human-reviewed full digest.
   * @param callSignal - This caller's local cancellation, including internal persistence and submission waits.
   * @returns Current full state; repeated execution reads the original action instead of submitting or replacing it.
   */
  execute(id: ResearchWorkflowPreviewId, sha256: string, callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    this.assertLive(callSignal)
    const preview = this.host.readPreview(id)
    if (preview.sha256 !== sha256) throw new ResearchActionError('standard preview digest differs', 'CONFIRMATION')
    const actionId = preview.input.request.actionId, pending = this.pending.get(actionId)
    if (pending !== undefined) {
      if (pending.sha256 !== sha256) throw new ResearchActionError('another preview is already executing this stage', 'CONFLICT')
      return waitForCall(pending.promise, callSignal)
    }
    const result = Promise.withResolvers<ResearchWorkflowState>()
    this.pending.set(actionId, { sha256, promise: result.promise })
    void Promise.resolve().then(async () => {
      await this.ensureDefinitionLogged(callSignal)
      this.assertLive(callSignal)
      const original = this.host.read(control => control.readWorkflowState(this.host.runId))
      if (original.stages.some(s => s.action?.request.actionId === actionId)) return this.sync(callSignal)
      const fixed = this.host.freezePreview(id, sha256)
      await this.sync(callSignal)
      this.assertLive(callSignal)
      const snapshot = await this.host.execute(fixed, this.host.previewGuard(id, sha256), callSignal)
      this.assertLive(callSignal)
      if (snapshot.state === 'completed' && fixed.kind !== 'chatgpt-upload') {
        await this.host.collect(preview.input.workflowId, actionId, callSignal)
        this.assertLive(callSignal)
      }
      return this.sync(callSignal)
    }).then(result.resolve, result.reject)
    void result.promise.then(() => this.pending.delete(actionId), () => this.pending.delete(actionId))
    return waitForCall(result.promise, callSignal)
  }

  /**
   * Observe and collect the original stage without replaying its submission.
   * @param kind - Original stage to observe; unknown without a resource never opens a replacement task.
   * @param callSignal - This caller's local cancellation.
   * @returns Full current state after original-resource observation and, on completion, original output collection.
   */
  async observe(kind: ResearchWorkflowStage['kind'], callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    this.assertLive(callSignal)
    await this.ensureDefinitionLogged(callSignal)
    this.assertLive(callSignal)
    const state = this.host.read(control => control.readWorkflowState(this.host.runId))
    const stage = state.definition.input.stages.find(s => s.kind === kind)
    if (stage === undefined) throw new ResearchActionError('canonical stage missing', 'FORMAT')
    const original = state.stages.find(s => s.kind === kind)?.action
    if (original === null || original === undefined) throw new ResearchActionError('original stage action not found', 'NOT_FOUND')
    if (original.acceptedResource === null) return this.sync(callSignal)
    const snapshot = await this.host.observe(stage.actionId, callSignal)
    this.assertLive(callSignal)
    if (snapshot.state === 'completed' && kind !== 'chatgpt-upload') {
      await this.host.collect(state.definition.input.workflowId, stage.actionId, callSignal)
      this.assertLive(callSignal)
    }
    return this.sync(callSignal)
  }

  /**
   * Persist the complete current workflow state without invoking an external operation.
   * @param callSignal - This caller's local cancellation.
   * @returns Complete current Host state after a required Session event and successful persistence; no external observation.
   */
  async sync(callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    return (await this.syncReceipt(callSignal)).state
  }

  /**
   * Persist and identify the exact event appended by this call, including under concurrent commands.
   * @param callSignal - This caller's local cancellation.
   * @returns This call's complete state and exact event sequence after persistence and current-Host checks.
   */
  async syncReceipt(callSignal?: AbortSignal): Promise<ResearchWorkflowReceipt> {
    this.assertLive(callSignal)
    const state = structuredClone(this.host.read(control => control.readWorkflowState(this.host.runId)))
    const event = this.session.append('research/workflow-update', { version: 1, ownerId: this.owner(), runId: this.host.runId,
      sessionId: this.session.id, state })
    await this.flush(callSignal)
    return { state: event.data.state, eventSeq: event.seq }
  }

  private owner() {
    return this.host.read(control => control.ownerId)
  }

  private async ensureDefinitionLogged(callSignal?: AbortSignal): Promise<void> {
    this.assertLive(callSignal)
    const definition = this.host.read(control => control.readWorkflowDefinition(this.host.runId))
    if (definition === null) throw new ResearchActionError('canonical workflow not found', 'NOT_FOUND')
    const exists = this.session.events.some(event => event.type === 'research/workflow'
      && event.data.ownerId === this.owner() && event.data.runId === this.host.runId && event.data.sessionId === this.session.id
      && JSON.stringify(event.data.definition) === JSON.stringify(definition))
    if (!exists) this.session.append('research/workflow', { version: 1, ownerId: this.owner(), runId: this.host.runId,
      sessionId: this.session.id, definition })
    await this.flush(callSignal)
  }

  private assertLive(callSignal?: AbortSignal): void {
    callSignal?.throwIfAborted()
    if (this.sessions.get(this.session.id) !== this.session) throw new ResearchActionError('standard workflow Session is not live', 'OWNER')
    this.host.inspect()
  }

  private async flush(callSignal?: AbortSignal): Promise<void> {
    if (!await this.sessions.flush(this.session)) throw new Error('standard workflow has no durability listener')
    this.assertLive(callSignal)
  }
}
