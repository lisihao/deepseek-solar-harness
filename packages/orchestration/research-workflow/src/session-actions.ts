/** Session-backed Consumer of the explicit research Host control. */
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { ResearchActionError, type ResearchActionId, type ResearchActionRequest, type ResearchActionSnapshot,
  type ResearchHostControl, type ResearchRunId, type ResearchPreparedPrompt,
  type ResearchSubmissionGuard } from '@deepseek-ai/dsh-research-handoff'
import './events.ts'

/** One live Session and explicitly owned run; the Host remains the sole action owner. */
export class ResearchSessionActions {
  /**
   * @param sessions - Store that owns the supplied live Session and durability dispatch.
   * @param session - Explicit destination for complete research inputs and original action facts.
   * @param control - Current Host capability; durable records cannot recreate it.
   * @param runId - Single owned research run.
   */
  constructor(private readonly sessions: SessionStore, private readonly session: Session,
    private readonly control: ResearchHostControl, private readonly runId: ResearchRunId) {
    this.assertLive()
    control.inspect(runId)
  }

  /**
   * Log the fixed full input and await persistence before asking the Host to execute.
   * @param request - Original action; copied before the first asynchronous wait.
   * @param signal - Local cancellation, never remote non-submission evidence.
   * @param guard - Trusted request-specific check retained only in this live call.
   * @returns Host snapshot after its Session projection is flushed; failures never trigger replay.
   */
  async execute(request: ResearchActionRequest, signal?: AbortSignal,
    guard?: ResearchSubmissionGuard): Promise<ResearchActionSnapshot> {
    const fixed = structuredClone(request)
    this.assertLive()
    if (fixed.runId !== this.runId) throw new ResearchActionError('research Session run differs', 'OWNER')
    this.control.inspect(this.runId)
    const preparedPrompt = this.prepared(fixed)
    guard?.(structuredClone(fixed))
    this.assertLive()
    const event = this.session.append('research/input', { ownerId: this.control.ownerId,
      runId: this.runId, request: fixed, preparedPrompt })
    await this.flush()
    signal?.throwIfAborted()
    const snapshot = await this.control.execute(event.data.request, signal, guard)
    await this.sync(fixed.actionId)
    return snapshot
  }

  /**
   * Observe the original action without submitting a replacement, then project its retained facts.
   * @param actionId - Original action in this run.
   * @param signal - Local observation cancellation.
   * @returns Host snapshot after a successful Session flush.
   */
  async observe(actionId: ResearchActionId, signal?: AbortSignal): Promise<ResearchActionSnapshot> {
    this.assertLive()
    const snapshot = await this.control.observe(this.runId, actionId, signal)
    await this.sync(actionId)
    return snapshot
  }

  /**
   * Project authoritative retained facts without executing or observing a remote operation.
   * @param actionId - Original action in this run.
   * @returns Retained snapshot after its complete action-specific observation history is flushed.
   */
  async sync(actionId: ResearchActionId): Promise<ResearchActionSnapshot> {
    this.assertLive()
    const snapshot = this.control.readAction(this.runId, actionId)
    const qualification = this.control.readQualification(this.runId, actionId)
    const deliveries = this.control.readDeliveryRecords(this.runId, actionId)
    const observations = this.control.readObservations(this.runId, 0, Number.MAX_SAFE_INTEGER)
      .filter(x => x.actionId === actionId)
    this.session.append('research/action', { ownerId: this.control.ownerId,
      runId: this.runId, snapshot, qualification, observations, deliveries })
    await this.flush()
    return snapshot
  }

  private prepared(request: ResearchActionRequest): ResearchPreparedPrompt | null {
    if (request.preparedPromptId === null) return null
    const prompt = this.control.readPreparedPrompt(this.runId, request.preparedPromptId)
    const expected = request.kind === 'gemini-plan-submit' ? 'gemini-deep-research'
      : request.kind === 'chatgpt-submit' ? 'chatgpt-verify-synthesize' : null
    if (prompt.runId !== this.runId || prompt.revision !== request.revision
      || prompt.questionSha256 !== request.binding.questionSha256 || prompt.renderedText !== request.input
      || prompt.template.id !== expected) {
      throw new ResearchActionError('prepared research input differs from Session request', 'CONFLICT')
    }
    return prompt
  }

  private assertLive(): void {
    if (this.sessions.get(this.session.id) !== this.session) throw new Error('research Session is not live in its store')
  }

  private async flush(): Promise<void> {
    if (!await this.sessions.flush(this.session)) throw new Error('research Session has no durability listener')
    this.assertLive()
  }
}
