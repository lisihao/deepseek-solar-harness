/** Current Agent/Session ownership for the standard research Consumer; no website transport is supplied here. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'
import { ResearchActionError, ResearchControlError, type ResearchHostControl, type ResearchHostPolicy,
  type ResearchSourceAccess, type ResearchHostRegistration, type ResearchRunId, type ResearchActionRun,
  type ResearchActionId, type ResearchActionRequest, type ResearchActionSnapshot, type ResearchWorkflowCollector,
  type ResearchWorkflowId, type ResearchWorkflowOutput, type ResearchSubmissionGuard,
  type ResearchWorkflowPreview, type ResearchWorkflowPreviewInput, type ResearchWorkflowPreviewId,
  type ResearchWorkflowDeliveryDisposition, type ResearchWorkflowState } from '@deepseek-ai/dsh-research-handoff'
import { ResearchSessionActions } from './session-actions.ts'
import { ResearchWorkflowCoordinator } from './coordinator.ts'

/** Explicit embedding configuration; imported records cannot supply these callable capabilities. */
export interface ResearchWorkflowHostSetup {
  readonly runId: ResearchRunId
  readonly policy: ResearchHostPolicy
  readonly collector: ResearchWorkflowCollector
  readonly sourceAccess?: ResearchSourceAccess
}

/** Trusted Consumer operation on the single current run; callbacks recheck guard after their own internal waits. */
export interface ResearchWorkflowOperation {
  readonly control: ResearchHostControl
  readonly actions: ResearchSessionActions
  readonly runId: ResearchRunId
  readonly signal: AbortSignal
  /** Recheck the exact current registration, Agent, Session and Host access. @returns No value. */
  readonly guard: () => void
}

/** Effect-owned registration; disposal aborts local access without declaring remote cancellation. */
export interface ResearchWorkflowHostRegistration {
  readonly host: ResearchWorkflowHost
  /** Revoke this registration and release its original Provider grant. @returns Owned teardown completion. */
  dispose(): Promise<void>
}

/** Actual invocation supplied by a trusted human command handler; imported records cannot select a Host. */
export interface ResearchWorkflowHumanInvocation {
  readonly agent: Agent
  readonly source: { readonly kind: string }
}

/** One registered live Agent/Session and its existing SQLite action owner. */
export class ResearchWorkflowHost {
  private readonly operation: ResearchWorkflowOperation
  /** Standard fixed-stage Consumer on this same live Host and Session. */
  readonly workflow: ResearchWorkflowCoordinator

  /**
   * @param sessions - Actual store that owns the supplied live Session.
   * @param session - Same Session referenced by the registered Agent.
   * @param control - Original Provider control with the live-owner check installed.
   * @param runId - Single explicitly owned run.
   * @param collector - Explicit original-resource reader.
   * @param signal - Registration revocation signal.
   * @param guard - Current registration, relationship and Host-policy check.
   */
  constructor(sessions: SessionStore, session: Session, control: ResearchHostControl,
    readonly runId: ResearchRunId, private readonly collector: ResearchWorkflowCollector,
    signal: AbortSignal, private readonly guard: () => void) {
    guard()
    this.operation = Object.freeze({ control, runId, signal, guard,
      actions: new ResearchSessionActions(sessions, session, control, runId) })
    this.workflow = new ResearchWorkflowCoordinator(sessions, session, this)
  }

  /**
   * Inspect the run through its current live Agent and Session registration.
   * @returns Current owned run after exact live registration and original Host access checks.
   */
  inspect(): ResearchActionRun {
    return this.read(control => control.inspect(this.runId))
  }

  /**
   * Create an immutable preview through the current scoped Host.
   * @param input - Full proposed request and original materials.
   * @returns Immutable preview without preparing or submitting.
   */
  preview(input: ResearchWorkflowPreviewInput): ResearchWorkflowPreview {
    return this.read(control => control.previewWorkflowAction(this.runId, input))
  }

  /**
   * Read the original preview through the current live registration.
   * @param id - Original preview.
   * @returns Full retained bytes and current confirmation projection.
   */
  readPreview(id: ResearchWorkflowPreviewId): ResearchWorkflowPreview {
    return this.read(control => control.readWorkflowPreview(this.runId, id))
  }

  /**
   * Freeze the exact confirmed preview through the current scoped Host.
   * @param id - Confirmed preview.
   * @param sha256 - Exact reviewed digest.
   * @returns Fixed prepared request; stage delivery authorization remains a separate Consumer requirement.
   */
  freezePreview(id: ResearchWorkflowPreviewId, sha256: string): ResearchActionRequest {
    return this.read(control => control.freezeWorkflowPreview(this.runId, id, sha256))
  }

  /**
   * Bind a live submission check to the exact confirmed preview.
   * @param id - Confirmed original preview.
   * @param sha256 - Reviewed complete preview.
   * @returns Live request-specific check; it does not replace the stage delivery prerequisites.
   */
  previewGuard(id: ResearchWorkflowPreviewId, sha256: string): ResearchSubmissionGuard {
    return (request) => {
      this.read((control) => {
        const preview = control.readWorkflowPreview(this.runId, id)
        if (!preview.confirmed || preview.sha256 !== sha256 || JSON.stringify(preview.input.request) !== JSON.stringify(request)) {
          throw new ResearchActionError('workflow preview no longer authorizes this exact input', 'CONFIRMATION')
        }
      })
    }
  }

  /**
   * Read or synchronously edit current owned records through a trusted Consumer.
   * @param operation - Synchronous same-process operation; never a JSON or model callback.
   * @returns Original operation result after another live check.
   */
  read<T>(operation: (control: ResearchHostControl) => T): T {
    this.guard()
    const result = operation(this.operation.control)
    this.guard()
    return result
  }

  /**
   * Hold a scoped Consumer operation while checking live ownership across asynchronous waits.
   * @param operation - Trusted Consumer operation; use its guard after every internal asynchronous wait.
   * @param callSignal - This caller's local cancellation, independent of the long-lived registration.
   * @returns Original result only while the same registration remains current; late durable facts are not erased.
   */
  async run<T>(operation: (current: ResearchWorkflowOperation) => Promise<T>, callSignal?: AbortSignal): Promise<T> {
    const signal = callSignal === undefined ? this.operation.signal : AbortSignal.any([this.operation.signal, callSignal])
    const guard = (): void => { signal.throwIfAborted(); this.guard() }
    guard()
    const result = await operation({ ...this.operation, signal, guard })
    guard()
    return result
  }

  /**
   * Log and submit an original action through the current scoped Host.
   * @param request - Complete original action on this run; Session input flush precedes the original Host submission.
   * @param check - Optional trusted synchronous check of this exact request and its stage prerequisites.
   * @param callSignal - This submission caller's local cancellation.
   * @returns Original action facts only after current live ownership and request validity are rechecked.
   */
  async execute(request: ResearchActionRequest, check?: ResearchSubmissionGuard,
    callSignal?: AbortSignal): Promise<ResearchActionSnapshot> {
    return this.run(({ actions, signal, guard }) => actions.execute(request, signal, (fixed) => {
      guard()
      check?.(fixed)
      guard()
    }), callSignal)
  }

  /**
   * Observe the original resource under current live ownership.
   * @param actionId - Original action; no replacement submission is made.
   * @param callSignal - This observation caller's local cancellation.
   * @returns Original observation after current live ownership is rechecked.
   */
  async observe(actionId: ResearchActionId, callSignal?: AbortSignal): Promise<ResearchActionSnapshot> {
    return this.run(({ actions, signal }) => actions.observe(actionId, signal), callSignal)
  }

  /**
   * Collect the completed original action through the current scoped Host.
   * @param workflowId - Original canonical workflow.
   * @param actionId - Its completed original action.
   * @param callSignal - This original-resource reader's local cancellation.
   * @returns Atomic original output only while current ownership remains; an admitted late output stays in SQLite.
   */
  async collect(workflowId: ResearchWorkflowId, actionId: ResearchActionId, callSignal?: AbortSignal): Promise<ResearchWorkflowOutput> {
    return this.run(({ control, signal, guard }) => control.captureWorkflowOutput(this.runId, workflowId, actionId, {
      collect: async (request, originalSignal, originalGuard) => {
        const check = (): void => { guard(); originalGuard() }
        check()
        // Persist the result of this already admitted read before the enclosing run refuses advancement after revocation.
        return this.collector.collect(request, originalSignal, check)
      },
    }, signal), callSignal)
  }
}

interface Entry {
  readonly agent: Agent
  readonly session: Session
  readonly revoked: AbortController
  host: ResearchWorkflowHost | undefined
}

/** Current-process registry used by the embedding Host and human command Consumer, keyed by actual Agent objects. */
export class ResearchWorkflowHosts {
  private readonly entries = new WeakMap<Agent, Entry>()
  private readonly live = new Set<Entry>()
  private closing = false

  /**
   * @param ctx - Lifecycle owning the real agents, sessions and researchHandoff services.
   */
  constructor(private readonly ctx: Context) {
    ctx.on('agent/disposed', ({ agent }) => {
      for (const entry of this.live) if (entry.agent === agent) this.revoke(entry)
    })
    ctx.on('session/disposed', (session) => {
      for (const entry of this.live) if (entry.session === session) this.revoke(entry)
    })
    ctx.effect(() => () => {
      this.closing = true
      for (const entry of this.live) this.revoke(entry)
    }, 'research workflow registry lifecycle')
  }

  /**
   * Mint one live Agent-scoped control of the existing action owner; a new registration revokes the old one.
   * @param owner - Embedding contribution lifecycle.
   * @param agent - Exact published Agent, never selected by imported identity.
   * @param session - Exact live Session referenced by that Agent.
   * @param setup - Explicit current Host bounds, owned existing run and read-only collector.
   * @returns Current registration, or a failure after its partial grant is released.
   */
  async register(owner: Context, agent: Agent, session: Session,
    setup: ResearchWorkflowHostSetup): Promise<ResearchWorkflowHostRegistration> {
    this.relationships(agent, session)
    const entry: Entry = { agent, session, revoked: new AbortController(), host: undefined }
    const previous = this.entries.get(agent)
    if (previous !== undefined) this.revoke(previous)
    this.entries.set(agent, entry)
    this.live.add(entry)
    let registered: ResearchHostRegistration | undefined
    try {
      registered = this.ctx.researchHandoff.bindHost(agent.ctx, setup.policy, setup.sourceAccess, {
        assertCurrent: () => { this.assertEntry(entry) },
      })
      const original = registered, control = original.control
      const guard = (): void => { this.assertEntry(entry); control.inspect(setup.runId) }
      guard()
      const canonical = control.readWorkflowDefinition(setup.runId)
      if (canonical !== null && canonical.input.sessionId !== session.id) {
        throw new ResearchActionError('canonical workflow belongs to another Session', 'CONFLICT')
      }
      const host = new ResearchWorkflowHost(this.ctx.sessions, session, control, setup.runId,
        setup.collector, entry.revoked.signal, guard)
      entry.host = host
      const dispose = owner.effect(() => () => { this.revoke(entry); return original.dispose() }, 'research live Agent workflow Host')
      guard()
      return { host, dispose }
    }
    catch (error) {
      this.revoke(entry)
      await registered?.dispose()
      throw error
    }
  }

  /**
   * Resolve the invoking Agent to its exact current Host registration.
   * @param agent - Exact invoking Agent, supplied by the current command host.
   * @returns Its current registered Host; absence or changed object identity is explicitly unavailable.
   */
  get(agent: Agent): ResearchWorkflowHost {
    const entry = this.entries.get(agent)
    if (entry === undefined || entry.host === undefined) {
      throw new ResearchControlError('research workflow Host is not configured for this Agent', 'DRIVER_UNSUPPORTED')
    }
    this.assertEntry(entry)
    entry.host.inspect()
    return entry.host
  }

  /**
   * Confirm the run through the actual user command and current Agent registration.
   * @param invocation - Actual command invocation from the trusted current handler.
   * @param revision - Reviewed run revision.
   * @param sha256 - Exact binding digest.
   * @returns Confirmed run; no preview is implicitly confirmed.
   */
  confirmRunFromCommand(invocation: ResearchWorkflowHumanInvocation, revision: number, sha256: string): ResearchActionRun {
    const host = this.humanCommandHost(invocation)
    return host.read((control) => {
      if (this.humanCommandHost(invocation) !== host) throw new ResearchControlError('human command Host changed', 'HOST_REVOKED')
      return control.confirm(host.runId, revision, sha256)
    })
  }

  /**
   * Confirm the exact preview through the actual user command and current registration.
   * @param invocation - Actual user-source command invocation; no owner or Session is accepted from command JSON.
   * @param id - Exact preview.
   * @param sha256 - Reviewed full preview digest.
   * @returns Separately confirmed preview.
   */
  confirmPreviewFromCommand(invocation: ResearchWorkflowHumanInvocation, id: ResearchWorkflowPreviewId,
    sha256: string): ResearchWorkflowPreview {
    const host = this.humanCommandHost(invocation)
    return host.read(control => control.confirmWorkflowPreview(host.runId, id, sha256, () => {
      if (this.humanCommandHost(invocation) !== host) throw new ResearchControlError('human command Host changed', 'HOST_REVOKED')
    }))
  }

  /**
   * Record an exact mismatch treatment through the actual user command.
   * @param invocation - Actual user-source command invocation.
   * @param input - Exact original negative history and correction.
   * @returns Immutable human treatment; new negative evidence invalidates its use by a later preview.
   */
  treatDeliveryFromCommand(invocation: ResearchWorkflowHumanInvocation, input: unknown): ResearchWorkflowDeliveryDisposition {
    const host = this.humanCommandHost(invocation)
    return host.read(control => control.appendWorkflowDeliveryDisposition(host.runId, input, () => {
      if (this.humanCommandHost(invocation) !== host) throw new ResearchControlError('human command Host changed', 'HOST_REVOKED')
    }))
  }

  /**
   * Confirm the current run and durably project the resulting workflow state.
   * @param invocation - Actual trusted user invocation.
   * @param revision - Reviewed current run revision.
   * @param sha256 - Exact reviewed binding.
   * @param callSignal - This command's local cancellation; the Host registration remains live.
   * @returns Complete state only after the confirmation projection is durable.
   */
  async confirmRunAndSyncFromCommand(invocation: ResearchWorkflowHumanInvocation, revision: number,
    sha256: string, callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    callSignal?.throwIfAborted()
    const host = this.humanCommandHost(invocation)
    this.confirmRunFromCommand(invocation, revision, sha256)
    const state = await host.workflow.sync(callSignal)
    callSignal?.throwIfAborted()
    if (this.humanCommandHost(invocation) !== host) throw new ResearchControlError('human command Host changed', 'HOST_REVOKED')
    return state
  }

  /**
   * Confirm the exact preview and durably project the resulting workflow state.
   * @param invocation - Actual trusted user invocation.
   * @param id - Exact preview.
   * @param sha256 - Full reviewed digest.
   * @param callSignal - This command's local cancellation.
   * @returns Complete state only after the preview confirmation projection is durable.
   */
  async confirmPreviewAndSyncFromCommand(invocation: ResearchWorkflowHumanInvocation, id: ResearchWorkflowPreviewId,
    sha256: string, callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    callSignal?.throwIfAborted()
    const host = this.humanCommandHost(invocation)
    this.confirmPreviewFromCommand(invocation, id, sha256)
    const state = await host.workflow.sync(callSignal)
    callSignal?.throwIfAborted()
    if (this.humanCommandHost(invocation) !== host) throw new ResearchControlError('human command Host changed', 'HOST_REVOKED')
    return state
  }

  /**
   * Record the exact human treatment and durably project the resulting workflow state.
   * @param invocation - Actual trusted user invocation.
   * @param input - Exact negative history and correction.
   * @param callSignal - This command's local cancellation.
   * @returns Complete state only after the immutable treatment and its projection are durable.
   */
  async treatDeliveryAndSyncFromCommand(invocation: ResearchWorkflowHumanInvocation, input: unknown,
    callSignal?: AbortSignal): Promise<ResearchWorkflowState> {
    callSignal?.throwIfAborted()
    const host = this.humanCommandHost(invocation)
    this.treatDeliveryFromCommand(invocation, input)
    const state = await host.workflow.sync(callSignal)
    callSignal?.throwIfAborted()
    if (this.humanCommandHost(invocation) !== host) throw new ResearchControlError('human command Host changed', 'HOST_REVOKED')
    return state
  }

  private humanCommandHost(invocation: ResearchWorkflowHumanInvocation): ResearchWorkflowHost {
    if (invocation.source.kind !== 'user') throw new ResearchControlError('actual user command source required', 'POLICY')
    return this.get(invocation.agent)
  }

  private relationships(agent: Agent, session: Session): void {
    if (this.closing || agent.session !== session || this.ctx.agents.get(agent.id) !== agent
      || this.ctx.sessions.get(session.id) !== session) {
      throw new ResearchControlError('research workflow Agent or Session is no longer current', 'HOST_REVOKED')
    }
  }

  private assertEntry(entry: Entry): void {
    try {
      entry.revoked.signal.throwIfAborted()
      if (this.entries.get(entry.agent) !== entry) {
        throw new ResearchControlError('research workflow registration was replaced', 'HOST_REVOKED')
      }
      this.relationships(entry.agent, entry.session)
    }
    catch (error) {
      this.revoke(entry)
      throw error
    }
  }

  private revoke(entry: Entry): void {
    if (this.entries.get(entry.agent) === entry) this.entries.delete(entry.agent)
    this.live.delete(entry)
    entry.revoked.abort(new ResearchControlError('research workflow registration revoked', 'HOST_REVOKED'))
  }
}
