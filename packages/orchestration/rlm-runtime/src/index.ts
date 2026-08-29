/** Persistent programmable recursive language model runtime seam. @module @deepseek-ai/dsh-rlm-runtime */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { HarnessError, type ContentBlock, type ResolvedRetryPolicy, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorExecutionPreference } from '@deepseek-ai/dsh-physical-operator'

/** Stable identity of one root or child RLM session. */
export type RlmRuntimeSessionId = Branded<'RlmRuntimeSessionId'>
/**
 * Brand a validated RLM session identity.
 * @param value - validated opaque value.
 * @returns branded session identity.
 */
export const RlmRuntimeSessionId = (value: string): RlmRuntimeSessionId => value as RlmRuntimeSessionId
/** Stable identity of one admitted child. */
export type RlmChildId = Branded<'RlmChildId'>
/**
 * Brand a validated child identity.
 * @param value - validated opaque value.
 * @returns branded child identity.
 */
export const RlmChildId = (value: string): RlmChildId => value as RlmChildId
/** Caller-generated idempotency identity for one mutating command. */
export type RlmCommandId = Branded<'RlmCommandId'>
/**
 * Brand a validated RLM command identity.
 * @param value - validated opaque value.
 * @returns branded command identity.
 */
export const RlmCommandId = (value: string): RlmCommandId => value as RlmCommandId
/** Identity of one external controller (for example the Prime Agents View). */
export type RlmControlCallerId = Branded<'RlmControlCallerId'>
/**
 * Brand a validated external controller identity.
 * @param value - validated opaque caller identity.
 * @returns branded caller identity.
 */
export const RlmControlCallerId = (value: string): RlmControlCallerId => value as RlmControlCallerId
/** Durable identity of one exclusive RLM control lease. */
export type RlmControlLeaseId = Branded<'RlmControlLeaseId'>
/**
 * Brand a validated control lease identity.
 * @param value - validated opaque lease identity.
 * @returns branded lease identity.
 */
export const RlmControlLeaseId = (value: string): RlmControlLeaseId => value as RlmControlLeaseId

/** JSON-compatible value exposed by the TypeScript REPL. */
export type RlmJsonValue = null | boolean | number | string | RlmJsonValue[] | { readonly [key: string]: RlmJsonValue }

/** Host-issued stable alias for one callable managed TypeScript Skill. */
export interface RlmManagedSkillDescriptorV1 {
  readonly alias: string
  readonly title: string
  readonly callable: string
  readonly available: boolean
}

/** Model-visible result of one managed Skill catalog or invocation request. */
export type RlmManagedSkillResultV1 =
  | { readonly ok: true; readonly result: RlmJsonValue }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Sealed node-local resource limits inherited by every descendant. */
export interface RlmRuntimeLimitsV1 {
  readonly maxDepth: number
  readonly maxChildren: number
  readonly maxTurns: number
  readonly maxCellMs: number
  readonly maxOutputBytes: number
}

/** Native model selection for a root or child agent. */
export interface RlmModelSelectionV1 {
  readonly operatorId: string
  readonly model: string
  readonly source?: 'native-subscription' | 'metered-api'
  readonly profile?: PhysicalOperatorExecutionPreference
}

/**
 * Versioned execution context inherited by every Prime RLM child.
 *
 * Model/provider/profile remain in {@link RlmModelSelectionV1}; this object
 * carries the other parent-owned execution inputs without exposing a second
 * model-selection authority. The TypeScript runtime never mutates this
 * object, and each child receives the exact sealed value from its parent.
 */
export interface RlmChildExecutionOptionsV1 {
  readonly version: 1
  /** Model-visible tool schemas owned by the parent execution. */
  readonly tools?: readonly ToolSchema[]
  /** Host-issued managed Skill descriptors available to the parent. */
  readonly skills?: readonly RlmManagedSkillDescriptorV1[]
  /** Provider-owned retry authority resolved for the parent model route. */
  readonly retryPolicy?: ResolvedRetryPolicy
  /** Sealed context/capability references; raw prompts and secrets are excluded. */
  readonly capabilityContext?: Readonly<Record<string, RlmJsonValue>>
}

/** Request that creates or idempotently reopens one RLM root. */
export interface RlmRuntimeCreateRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly executionId: string
  readonly workspace: string
  readonly task: string
  readonly model: RlmModelSelectionV1
  /** Sealed economy-first allocation used when `rlm()` omits an explicit model. */
  readonly defaultChildModel?: RlmModelSelectionV1
  /** Sealed parent execution inputs inherited by Prime children. */
  readonly executionOptions?: RlmChildExecutionOptionsV1
  readonly limits: RlmRuntimeLimitsV1
  readonly context?: Readonly<Record<string, RlmJsonValue>>
}

/** One child request admitted from a model-facing `rlm(...)` call. */
export interface RlmChildSpawnRequest {
  readonly commandId: RlmCommandId
  readonly parentSessionId: RlmRuntimeSessionId
  readonly name: string
  readonly task: string
  readonly model?: RlmModelSelectionV1
}

/** Admission handle returned before the child produces an answer. */
export interface RlmChildHandleV1 {
  readonly rlmChildId: RlmChildId
  readonly sessionId: RlmRuntimeSessionId
  readonly name: string
  readonly sessionDir: string
  readonly model: RlmModelSelectionV1
}

/** Final child execution data supplied asynchronously by the DSH Consumer. */
export interface RlmChildExecutionResult {
  readonly status: 'settled' | 'failed' | 'indeterminate'
  readonly output?: readonly ContentBlock[]
  readonly resultRef?: string
  readonly outputPreview?: string
  readonly error?: string
  readonly messages?: readonly Omit<RlmMessageSendRequest, 'commandId' | 'fromSessionId'>[]
  readonly usage?: {
    readonly provider: string
    readonly model: string
    readonly authMode: 'subscription' | 'api' | 'local'
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly cacheReadInputTokens?: number
    readonly cacheWriteInputTokens?: number
    readonly costUsd?: number
  }
}

/** Accepted native child turn and its eventual result. */
export interface RlmChildExecution {
  readonly nativeSessionId: string
  readonly nativeTurnId: string
  readonly result: Promise<RlmChildExecutionResult>
  interrupt(): Promise<void>
}

/** Consumer-owned adapter that performs native child turns. */
export interface RlmRuntimeHostBindings {
  dispatchChild(request: RlmChildSpawnRequest & {
    readonly childId: RlmChildId
    readonly childSessionId: RlmRuntimeSessionId
    readonly depth: number
    readonly model: RlmModelSelectionV1
    readonly executionOptions: RlmChildExecutionOptionsV1
  }): Promise<RlmChildExecution>
  /** Continue one root session for a persistent goal or scheduled heartbeat. */
  dispatchContinuation?(request: {
    readonly sessionId: RlmRuntimeSessionId
    readonly commandId: RlmCommandId
    readonly instruction: string
    readonly source: 'goal' | 'heartbeat' | 'message' | 'autonomous'
    readonly deliveryMode: 'steer' | 'follow_up'
    readonly model: RlmModelSelectionV1
    /** Optional for legacy host continuations; LocalRlmRuntime supplies the sealed value. */
    readonly executionOptions?: RlmChildExecutionOptionsV1
  }): Promise<RlmChildExecution>
  /** Forward typed kernel capabilities whose authority lives outside the RLM Provider. */
  hostRequest?(request: {
    readonly sessionId: RlmRuntimeSessionId
    readonly method: 'harness.list' | 'harness.get' | 'harness.create' | 'harness.update' | 'harness.delete'
      | 'harness.plan_refinement' | 'harness.apply_refinement' | 'harness.rollback'
      | 'compact.status' | 'compact.run'
      | 'skills.list' | 'skills.call'
    readonly params: Readonly<Record<string, RlmJsonValue>>
  }): Promise<RlmJsonValue>
}

/** Current lifecycle of one RLM child. */
export type RlmChildLifecycle = 'accepted' | 'running' | 'settled' | 'failed' | 'indeterminate' | 'deleted'

/** Durable child projection. */
export interface RlmChildSnapshotV1 extends RlmChildHandleV1 {
  readonly version: 1
  readonly parentSessionId: RlmRuntimeSessionId
  readonly depth: number
  readonly task: string
  readonly lifecycle: RlmChildLifecycle
  readonly nativeSessionId?: string
  readonly nativeTurnId?: string
  readonly resultRef?: string
  readonly outputPreview?: string
  readonly error?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Prime-compatible persistent goal status. */
export type RlmGoalStatus = 'active' | 'paused' | 'budget_limited' | 'complete' | 'error'

/** Persistent goal managed independently of model-history compaction. */
export interface RlmGoalV1 {
  readonly goalId: string
  readonly objective: string
  readonly active: boolean
  readonly status: RlmGoalStatus
  readonly tokenBudget?: number
  readonly tokensUsed: number
  readonly timeUsedSeconds: number
  readonly continuationBudget: number
  readonly continuationsUsed: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastReason?: string
  readonly lastError?: string
}

/** Claim returned when an active goal is allowed to consume one more continuation. */
export interface RlmGoalContinuationClaimV1 {
  readonly commandId: RlmCommandId
  readonly sessionId: RlmRuntimeSessionId
  readonly objective: string
  readonly continuation: number
  readonly continuationBudget: number
}

/** Recurring RLM heartbeat managed from the programmable kernel. */
export interface RlmHeartbeatV1 {
  readonly version: 1
  readonly heartbeatId: string
  readonly sessionId: RlmRuntimeSessionId
  readonly status: 'active' | 'paused' | 'cancelled'
  readonly instruction: string
  readonly interval: string
  readonly intervalMs: number
  readonly deliveryMode: 'steer' | 'follow_up'
  readonly label?: string
  readonly nextRunAt?: string
  readonly lastRunAt?: string
  readonly lastError?: string
  readonly runCount: number
  readonly inFlightCommandId?: RlmCommandId
  readonly createdAt: string
  readonly updatedAt: string
}

/** Create one recurring RLM heartbeat. */
export interface RlmHeartbeatCreateRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly instruction: string
  readonly interval?: string
  readonly deliveryMode?: 'steer' | 'follow_up'
  readonly label?: string
}

/** Update, pause, or resume one recurring RLM heartbeat. */
export interface RlmHeartbeatUpdateRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly heartbeatId: string
  readonly instruction?: string
  readonly interval?: string
  readonly deliveryMode?: 'steer' | 'follow_up'
  readonly label?: string | null
  readonly status?: 'pause' | 'resume'
}

/** Atomic due-heartbeat claim consumed by the orchestration host. */
export interface RlmHeartbeatClaimV1 {
  readonly heartbeat: RlmHeartbeatV1
  readonly commandId: RlmCommandId
}

/** Durable root or child session projection. */
export interface RlmRuntimeSessionSnapshotV1 {
  readonly version: 1
  readonly sessionId: RlmRuntimeSessionId
  readonly executionId: string
  readonly parentSessionId?: RlmRuntimeSessionId
  readonly parentChildId?: RlmChildId
  readonly workspace: string
  readonly sessionDir: string
  readonly task: string
  readonly model: RlmModelSelectionV1
  /** Sealed default for recursively admitted children; never inferred inside the runtime. */
  readonly defaultChildModel?: RlmModelSelectionV1
  /** Sealed parent execution inputs inherited by recursively admitted children. */
  readonly executionOptions?: RlmChildExecutionOptionsV1
  readonly limits: RlmRuntimeLimitsV1
  readonly depth: number
  readonly lifecycle: 'idle' | 'running' | 'degraded' | 'stopped'
  readonly stateRevision: number
  readonly eventCursor: number
  readonly children: readonly RlmChildSnapshotV1[]
  readonly restorableVariables: readonly string[]
  readonly degradedVariables: readonly string[]
  readonly goal?: RlmGoalV1
  readonly createdAt: string
  readonly updatedAt: string
}

/** Versioned exclusive control lease returned to an external Agents View. */
export interface RlmControlLeaseV1 {
  readonly version: 1
  readonly leaseId: RlmControlLeaseId
  readonly sessionId: RlmRuntimeSessionId
  readonly callerId: RlmControlCallerId
  readonly acquiredAt: string
  readonly lastSeenAt: string
}

/** Attach one external controller to a durable RLM session. */
export interface RlmControlAttachRequestV1 {
  readonly version: 1
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly callerId: RlmControlCallerId
}

/** Current session state and cursor returned by a successful attach. */
export interface RlmControlAttachResultV1 {
  readonly version: 1
  readonly lease: RlmControlLeaseV1
  readonly snapshot: RlmRuntimeSessionSnapshotV1
  readonly eventCursor: number
}

/** Input accepted from an attached external controller. */
export interface RlmControlInputRequestV1 {
  readonly version: 1
  readonly sessionId: RlmRuntimeSessionId
  readonly leaseId: RlmControlLeaseId
  readonly commandId: RlmCommandId
  readonly text: string
  readonly mode?: RlmMessageMode
  readonly artifactRefs?: readonly string[]
}

/** Receipt returned for one controller input enqueued into the existing continuation path. */
export interface RlmControlInputResultV1 {
  readonly version: 1
  readonly sessionId: RlmRuntimeSessionId
  readonly leaseId: RlmControlLeaseId
  readonly commandId: RlmCommandId
  readonly messageId: string
  readonly effectiveMode: 'steer' | 'follow_up'
  readonly deliveryStatus: 'queued' | 'delivered'
  readonly stateRevision: number
  readonly eventCursor: number
}

/** Release one external controller lease. */
export interface RlmControlDetachRequestV1 {
  readonly version: 1
  readonly sessionId: RlmRuntimeSessionId
  readonly leaseId: RlmControlLeaseId
  readonly commandId: RlmCommandId
}

/** Idempotent detach result. */
export interface RlmControlDetachResultV1 {
  readonly version: 1
  readonly sessionId: RlmRuntimeSessionId
  readonly leaseId: RlmControlLeaseId
  readonly detached: true
  readonly eventCursor: number
}

/** Execute one cell in the persistent TypeScript namespace. */
export interface RlmCellExecuteRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly code: string
  readonly expectedStateRevision?: number
}

/** Bounded model-visible cell result. */
export interface RlmCellResultV1 {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly stateRevision: number
  readonly logs: readonly string[]
  readonly value?: RlmJsonValue
  readonly display: string
  readonly degradedVariables: readonly string[]
}

/** Receipt-bound request to schedule compaction at a real host turn boundary. */
export interface RlmCompactRunRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly expectedStateRevision?: number
  readonly instructions?: string
}

/** Host decision returned by Prime-compatible `compact.run()`. */
export interface RlmCompactRunOutcomeV1 {
  readonly scheduled: boolean
  readonly reason?: string
  readonly note?: string
}

/** Durable scheduling receipt that also proves the programmable namespace was not reset. */
export interface RlmCompactRunResultV1 extends RlmCompactRunOutcomeV1 {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly stateRevision: number
  readonly restorableVariables: readonly string[]
  readonly degradedVariables: readonly string[]
}

/** Durable state of one idempotent runtime command. */
export interface RlmCommandReceiptSnapshotV1 {
  readonly version: 1
  readonly commandId: RlmCommandId
  readonly sessionId?: RlmRuntimeSessionId
  readonly operation?: string
  readonly requestSha256: string
  readonly state: 'accepted' | 'running' | 'settled' | 'failed' | 'indeterminate'
  readonly resultSha256?: string
  readonly error?: { readonly message: string; readonly code: string }
  readonly resolution?: 'abandon'
  readonly resolutionReason?: string
}

/** Explicitly abandon one command whose native outcome cannot be proven. */
export interface RlmIndeterminateResolutionRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly indeterminateCommandId: RlmCommandId
  readonly resolutionCommandId: RlmCommandId
  readonly expectedStateRevision: number
  readonly decision: 'abandon'
  readonly reason: string
}

/** Owner-local bridge descriptor passed to genuine native model-tool integrations. */
export interface RlmModelToolBridgeV1 {
  readonly version: 1
  readonly socketPath: string
  readonly sessionId: string
  readonly tools: readonly [{
    readonly name: 'typescript_repl'
    readonly description: string
    readonly inputSchema: Readonly<Record<string, unknown>>
  }]
}

/** Canonical model-visible TypeScript REPL schema shared by all RLM consumers. */
export const RLM_TYPESCRIPT_REPL_TOOL_SCHEMA = {
  name: 'typescript_repl',
  description: 'Execute one TypeScript cell in the persistent RLM namespace. Use context as programmable state; await rlm(task, { name, model }) to admit asynchronous child agents. rlm returns only a handle. Results arrive through agentMessage or artifacts.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', description: 'TypeScript cell with persistent lexical variables and top-level await.' },
    },
    required: ['code'],
    additionalProperties: false,
  },
} as const satisfies ToolSchema

/** Family-scoped message delivery mode matching Prime Agent v0.8.0. */
export type RlmMessageMode = 'auto' | 'steer' | 'follow_up'

/** Send one explicit parent/sibling/direct-child message. */
export interface RlmMessageSendRequest {
  readonly commandId: RlmCommandId
  readonly fromSessionId: RlmRuntimeSessionId
  readonly toSessionId: RlmRuntimeSessionId
  readonly mode: RlmMessageMode
  readonly text: string
  readonly artifactRefs?: readonly string[]
}

/** Durable explicit Agent-to-Agent message. */
export interface RlmMessageV1 extends RlmMessageSendRequest {
  readonly version: 1
  readonly messageId: string
  /** Origin used by the local control plane; omitted for Agent-to-Agent messages. */
  readonly source?: 'agent' | 'control'
  /** Lease that authorized a control-origin message. */
  readonly controlLeaseId?: RlmControlLeaseId
  readonly effectiveMode: 'steer' | 'follow_up'
  readonly deliveryStatus: 'queued' | 'delivered'
  readonly queuedAt: string
  readonly deliveredAt?: string
  readonly deliveryError?: string
  readonly createdAt: string
}

/** Result of draining recursively admitted work and queued family messages. */
export interface RlmDrainResultV1 {
  readonly sessionId: RlmRuntimeSessionId
  readonly activeExecutions: number
  readonly queuedMessages: number
  readonly lastContinuation?: RlmChildExecutionResult
}

/** Read messages after one stable cursor. */
export interface RlmMessageReadRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly after?: number
  readonly limit?: number
}

/** Relationship and state of one directly reachable member of an RLM family. */
export interface RlmFamilyRosterEntryV1 {
  readonly relationship: 'parent' | 'sibling' | 'child'
  readonly name: string
  readonly sessionId: RlmRuntimeSessionId
  readonly depth: number
  readonly status: 'running' | 'idle' | 'inactive'
}

/** Nuclear-family roster exposed to the programmable runtime. */
export interface RlmFamilyRosterV1 {
  readonly current: {
    readonly name: string
    readonly sessionId: RlmRuntimeSessionId
    readonly depth: number
  }
  readonly entries: readonly RlmFamilyRosterEntryV1[]
}

/** One append-only runtime event. */
export interface RlmRuntimeEventV1 {
  readonly version: 1
  readonly sequence: number
  readonly type: string
  readonly sessionId: RlmRuntimeSessionId
  readonly childId?: RlmChildId
  readonly createdAt: string
  readonly data: Readonly<Record<string, RlmJsonValue>>
}

/** Read append-only runtime events after a stable cursor. */
export interface RlmEventReadRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly after?: number
  readonly limit?: number
}

/** Persistent goal mutation. */
export interface RlmGoalSetRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly expectedStateRevision: number
  readonly objective: string
  /** `blocked` is accepted only as a legacy v1 input and is normalized to `budget_limited`. */
  readonly status?: RlmGoalV1['status'] | 'blocked'
  readonly tokenBudget?: number
  readonly continuationBudget: number
  readonly reason?: string
  readonly error?: string
}

/** Idempotently attribute one completed assistant turn to an active goal. */
export interface RlmGoalUsageAccountRequest {
  readonly sessionId: RlmRuntimeSessionId
  readonly commandId: RlmCommandId
  readonly expectedStateRevision: number
  readonly inputTokens: number
  readonly outputTokens: number
  /** Cache-read tokens are retained for Trace but do not consume the Prime goal budget. */
  readonly cacheReadInputTokens?: number
  /** Cache-write tokens consume the Prime goal budget. */
  readonly cacheWriteInputTokens?: number
}

/** Structured runtime failures. */
export type RlmRuntimeErrorCode =
  | 'RLM_INVALID'
  | 'RLM_UNAVAILABLE'
  | 'RLM_SESSION_BUSY'
  | 'RLM_SESSION_NOT_FOUND'
  | 'RLM_COMMAND_NOT_FOUND'
  | 'RLM_REVISION_CONFLICT'
  | 'RLM_COMMAND_CONFLICT'
  | 'RLM_COMMAND_INDETERMINATE'
  | 'RLM_BUDGET_EXCEEDED'
  | 'RLM_FAMILY_VIOLATION'
  | 'RLM_CELL_TIMEOUT'
  | 'RLM_OUTPUT_LIMIT'
  | 'RLM_CONTROL_BUSY'
  | 'RLM_CONTROL_LEASE_INVALID'

/** Provider-neutral RLM runtime error. */
export class RlmRuntimeError extends HarnessError {
  constructor(message: string, code: RlmRuntimeErrorCode) {
    super(message, code)
    this.name = 'RlmRuntimeError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { rlmRuntime: RlmRuntimeService }
}

/** Replaceable persistent programmable RLM runtime. */
export abstract class RlmRuntimeService extends Service {
  constructor(ctx: Context) {
    if (new.target === RlmRuntimeService) throw new Error('@deepseek-ai/dsh-rlm-runtime is an abstract seam; load a Provider')
    super(ctx, 'rlmRuntime')
  }

  /**
   * Create or idempotently reopen a root.
   * @param request - sealed root identity and limits.
   * @param bindings - native host adapter.
   * @returns durable root snapshot.
   */
  abstract create(request: RlmRuntimeCreateRequest, bindings: RlmRuntimeHostBindings): Promise<RlmRuntimeSessionSnapshotV1>
  /**
   * Bind a recovered session to a live host.
   * @param sessionId - durable session identity.
   * @param bindings - native host adapter.
   * @returns disposer for this binding.
   */
  abstract bindHost(sessionId: RlmRuntimeSessionId, bindings: RlmRuntimeHostBindings): Promise<() => void>
  /**
   * List durable runtime sessions.
   * @returns snapshots ordered by Provider recency.
   */
  abstract list(): Promise<readonly RlmRuntimeSessionSnapshotV1[]>
  /**
   * Inspect one runtime session.
   * @param sessionId - durable session identity.
   * @returns current snapshot.
   */
  abstract inspect(sessionId: RlmRuntimeSessionId): Promise<RlmRuntimeSessionSnapshotV1>
  /**
   * Establish one exclusive external control lease over a durable session.
   * @param request - versioned caller and command identity.
   * @returns lease, current snapshot, and event cursor.
   */
  abstract attach(request: RlmControlAttachRequestV1): Promise<RlmControlAttachResultV1>
  /**
   * Submit controller input through the existing message/continuation path.
   * @param request - lease-bound, idempotent input command.
   * @returns durable input receipt.
   */
  abstract input(request: RlmControlInputRequestV1): Promise<RlmControlInputResultV1>
  /**
   * Release one external control lease.
   * @param request - lease-bound idempotent detach command.
   * @returns durable detach receipt.
   */
  abstract detach(request: RlmControlDetachRequestV1): Promise<RlmControlDetachResultV1>
  /**
   * Inspect one command receipt.
   * @param commandId - caller-generated command identity.
   * @returns bounded receipt snapshot.
   */
  abstract inspectReceipt(commandId: RlmCommandId): Promise<RlmCommandReceiptSnapshotV1>
  /**
   * Execute one serial TypeScript cell.
   * @param request - cell command and optional revision.
   * @returns bounded result after namespace persistence.
   */
  abstract executeCell(request: RlmCellExecuteRequest): Promise<RlmCellResultV1>
  /**
   * Read the Host's current compaction status without changing it.
   * @param sessionId - target runtime session.
   * @returns Host-owned JSON status projection.
   */
  abstract compactStatus(sessionId: RlmRuntimeSessionId): Promise<RlmJsonValue>
  /**
   * Schedule compaction at a real Host turn boundary without resetting program state.
   * @param request - receipt-bound scheduling command and optional instructions.
   * @returns scheduling decision plus namespace continuity proof.
   */
  abstract compactRun(request: RlmCompactRunRequest): Promise<RlmCompactRunResultV1>
  /**
   * Describe the owner-local model tool bridge.
   * @param sessionId - target runtime session.
   * @returns bridge endpoint and tool schema.
   */
  abstract modelToolBridge(sessionId: RlmRuntimeSessionId): Promise<RlmModelToolBridgeV1>
  /**
   * Register an admitted native execution so family messages queue behind it.
   * @param sessionId - owning session.
   * @param execution - accepted native execution.
   * @returns disposer for the tracking association.
   */
  abstract trackExecution(sessionId: RlmRuntimeSessionId, execution: RlmChildExecution): Promise<() => void>
  /**
   * Admit one asynchronous child.
   * @param request - parent, task, name, and model selection.
   * @returns admission handle, never the child answer.
   */
  abstract spawn(request: RlmChildSpawnRequest): Promise<RlmChildHandleV1>
  /**
   * List children registered under one parent.
   * @param sessionId - parent session identity.
   * @returns durable child snapshots.
   */
  abstract listChildren(sessionId: RlmRuntimeSessionId): Promise<readonly RlmChildSnapshotV1[]>
  /**
   * Inspect one registered child.
   * @param parentSessionId - parent session identity.
   * @param childId - child identity.
   * @returns durable child snapshot.
   */
  abstract inspectChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId): Promise<RlmChildSnapshotV1>
  /**
   * Stop and remove one child from the active registry.
   * @param parentSessionId - parent session identity.
   * @param childId - child identity.
   * @param commandId - idempotent delete command.
   * @returns after persistence.
   */
  abstract deleteChild(parentSessionId: RlmRuntimeSessionId, childId: RlmChildId, commandId: RlmCommandId): Promise<void>
  /**
   * Queue one nuclear-family message.
   * @param request - sender, recipient, mode, and content.
   * @returns durable delivery receipt.
   */
  abstract sendMessage(request: RlmMessageSendRequest): Promise<RlmMessageV1>
  /**
   * Read received messages from a stable offset.
   * @param request - session, cursor, and bound.
   * @returns ordered message page.
   */
  abstract readMessages(request: RlmMessageReadRequest): Promise<readonly RlmMessageV1[]>
  /**
   * Inspect directly reachable family members.
   * @param sessionId - current family member.
   * @returns nuclear-family roster.
   */
  abstract familyRoster(sessionId: RlmRuntimeSessionId): Promise<RlmFamilyRosterV1>
  /**
   * Admit queued continuations for idle targets.
   * @param sessionId - optional target session.
   * @returns admitted continuation count.
   */
  abstract pumpMessages(sessionId?: RlmRuntimeSessionId): Promise<number>
  /**
   * Wait for descendant work and messages to drain.
   * @param sessionId - subtree root.
   * @param maxWaitMs - bounded wait.
   * @returns final activity counts.
   */
  abstract drain(sessionId: RlmRuntimeSessionId, maxWaitMs: number): Promise<RlmDrainResultV1>
  /**
   * Create or revise a persistent goal.
   * @param request - goal content, budget, and revision.
   * @returns revised goal.
   */
  abstract setGoal(request: RlmGoalSetRequest): Promise<RlmGoalV1>
  /**
   * Account one terminal assistant turn against the active goal's token and wall-clock budgets.
   * Existing third-party Providers may inherit the explicit unavailable result until they implement accounting.
   * @param _request - idempotent token usage command.
   * @returns revised goal, including a possible `budget_limited` transition.
   */
  accountGoalUsage(_request: RlmGoalUsageAccountRequest): Promise<RlmGoalV1> {
    return Promise.reject(new RlmRuntimeError('RLM Provider does not implement goal usage accounting', 'RLM_UNAVAILABLE'))
  }
  /**
   * Complete any existing non-idle goal, including paused, budget-limited, or error states.
   * @param sessionId - owning session.
   * @param commandId - idempotent command.
   * @param expectedStateRevision - optimistic revision.
   * @returns completed goal.
   */
  abstract completeGoal(sessionId: RlmRuntimeSessionId, commandId: RlmCommandId, expectedStateRevision: number): Promise<RlmGoalV1>
  /**
   * Claim one bounded goal continuation.
   * @param sessionId - owning session.
   * @param commandId - idempotent claim.
   * @returns claim or undefined when unavailable.
   */
  abstract claimGoalContinuation(sessionId: RlmRuntimeSessionId, commandId: RlmCommandId): Promise<RlmGoalContinuationClaimV1 | undefined>
  /**
   * Create a recurring heartbeat.
   * @param request - schedule and continuation instruction.
   * @returns durable heartbeat.
   */
  abstract createHeartbeat(request: RlmHeartbeatCreateRequest): Promise<RlmHeartbeatV1>
  /**
   * List a session's heartbeats.
   * @param sessionId - owning session.
   * @param includeInactive - include paused and cancelled entries.
   * @returns heartbeat snapshots.
   */
  abstract listHeartbeats(sessionId: RlmRuntimeSessionId, includeInactive?: boolean): Promise<readonly RlmHeartbeatV1[]>
  /**
   * Update a recurring heartbeat.
   * @param request - heartbeat mutation command.
   * @returns revised heartbeat.
   */
  abstract updateHeartbeat(request: RlmHeartbeatUpdateRequest): Promise<RlmHeartbeatV1>
  /**
   * Cancel a recurring heartbeat.
   * @param sessionId - owning session.
   * @param heartbeatId - heartbeat identity.
   * @param commandId - idempotent delete command.
   * @returns cancelled heartbeat.
   */
  abstract deleteHeartbeat(sessionId: RlmRuntimeSessionId, heartbeatId: string, commandId: RlmCommandId): Promise<RlmHeartbeatV1>
  /**
   * Claim due heartbeats atomically.
   * @param now - optional ISO claim time.
   * @returns admitted claims.
   */
  abstract claimDueHeartbeats(now?: string): Promise<readonly RlmHeartbeatClaimV1[]>
  /**
   * Settle one heartbeat claim.
   * @param heartbeatId - heartbeat identity.
   * @param commandId - matching claim command.
   * @param outcome - proven native outcome.
   * @param now - optional ISO settlement time.
   * @returns revised heartbeat.
   */
  abstract settleHeartbeat(heartbeatId: string, commandId: RlmCommandId, outcome: { readonly status: 'settled' | 'failed' | 'indeterminate'; readonly error?: string }, now?: string): Promise<RlmHeartbeatV1>
  /**
   * Dispatch all currently due heartbeats.
   * @param now - optional ISO claim time.
   * @returns admitted native execution count.
   */
  abstract pumpHeartbeats(now?: string): Promise<number>
  /**
   * Read append-only runtime events.
   * @param request - session, cursor, and bound.
   * @returns ordered event page.
   */
  abstract readEvents(request: RlmEventReadRequest): Promise<readonly RlmRuntimeEventV1[]>
  /**
   * Interrupt active executions in one subtree.
   * @param sessionId - subtree root.
   * @returns after interrupt requests settle.
   */
  abstract interrupt(sessionId: RlmRuntimeSessionId): Promise<void>
  /**
   * Reset one idle programmable namespace.
   * @param sessionId - target session.
   * @param commandId - idempotent reset command.
   * @param expectedStateRevision - optimistic revision.
   * @returns reset snapshot.
   */
  abstract reset(
    sessionId: RlmRuntimeSessionId,
    commandId: RlmCommandId,
    expectedStateRevision: number,
  ): Promise<RlmRuntimeSessionSnapshotV1>
  /**
   * Reconcile recovered in-memory lifecycle with durable state.
   * @param sessionId - target session.
   * @returns reconciled snapshot.
   */
  abstract reconcile(sessionId: RlmRuntimeSessionId): Promise<RlmRuntimeSessionSnapshotV1>
  /**
   * Explicitly abandon an uncertain command.
   * @param request - target receipt and resolution command.
   * @returns resolved receipt snapshot.
   */
  abstract resolveIndeterminate(request: RlmIndeterminateResolutionRequest): Promise<RlmCommandReceiptSnapshotV1>
}

export default RlmRuntimeService
