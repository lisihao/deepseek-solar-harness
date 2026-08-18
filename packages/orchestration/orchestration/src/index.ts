/** Durable TaskGraph orchestration capability seam. @module @deepseek-ai/dsh-orchestration */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {
  CapabilityBindingPlanV1,
  CapabilityEffectSet,
  CapabilityRequirement,
} from '@deepseek-ai/dsh-capability-capsule'
import type { ContextPacketV1, ContextPolicy } from '@deepseek-ai/dsh-context-compiler'
import type { IntentCompileRequest, IntentIRV1 } from '@deepseek-ai/dsh-intent-compiler'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorExecutionId, PhysicalOperatorExecutionPreference } from '@deepseek-ai/dsh-physical-operator'

/** Opaque orchestration run identity. */
export type OrchestrationRunId = Branded<'OrchestrationRunId'>
/**
 * Brand one validated run identity.
 * @param value - validated durable run identity.
 * @returns the opaque orchestration run identity.
 */
export const OrchestrationRunId = (value: string): OrchestrationRunId => value as OrchestrationRunId
/** Opaque content-addressed orchestration artifact. */
export type OrchestrationArtifactRef = Branded<'OrchestrationArtifactRef'>
/**
 * Brand one validated artifact reference.
 * @param value - validated content-addressed reference.
 * @returns the opaque orchestration artifact reference.
 */
export const OrchestrationArtifactRef = (value: string): OrchestrationArtifactRef => value as OrchestrationArtifactRef

/** Retry bounds certified for one node. */
export interface OrchestrationRetryPolicy {
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly retryableCodes: readonly string[]
}

/** One deterministic acceptance check retained with Evidence. */
export interface OrchestrationAcceptanceRequirement {
  readonly id: string
  readonly description: string
  readonly kind: 'operator-completed' | 'artifact-present' | 'human-review'
}

/** Version-one node specification in one certified logical TaskGraph. */
export interface OrchestrationNodeSpecV1 {
  readonly id: string
  readonly dependsOn: readonly string[]
  readonly requiredForCompletion: boolean
  readonly title: string
  readonly task: string
  readonly role: string
  readonly capabilityRequirements: readonly CapabilityRequirement[]
  readonly capabilityBudget: readonly string[]
  readonly contextPolicy: ContextPolicy
  readonly effectBudget: CapabilityEffectSet
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly approvedSecretRefs: readonly string[]
  readonly acceptance: readonly OrchestrationAcceptanceRequirement[]
  readonly retryPolicy: OrchestrationRetryPolicy
  readonly operator?: {
    readonly preferredIds?: readonly string[]
    readonly profile?: PhysicalOperatorExecutionPreference
  }
}

/** Immutable logical graph accepted by the Scheduler. */
export interface LogicalTaskGraphV1 {
  readonly version: 1
  readonly title: string
  readonly workspace: string
  readonly maxParallel: number
  readonly risk: 'low' | 'medium' | 'high'
  readonly nodes: readonly OrchestrationNodeSpecV1[]
}

/** Hash certificate proving the Graph's execution upper bounds. */
export interface PlanCertificateV1 {
  readonly version: 1
  readonly graphSha256: string
  readonly certificateSha256: string
  readonly nodeIds: readonly string[]
  readonly maximumRisk: LogicalTaskGraphV1['risk']
  readonly requiresApproval: boolean
  readonly generatedAt: string
}

/** Input to the deterministic compile and validation pipeline. */
export interface OrchestrationCompileRequest {
  readonly intent: IntentCompileRequest
  readonly graph: LogicalTaskGraphV1
  readonly requirement?: Readonly<Record<string, unknown>>
}

/** Immutable compilation result that may be started after approval. */
export interface OrchestrationCompilationV1 {
  readonly version: 1
  readonly compilationId: string
  readonly intent: IntentIRV1
  readonly intentRef: OrchestrationArtifactRef
  readonly requirementRef?: OrchestrationArtifactRef
  readonly graphRef: OrchestrationArtifactRef
  readonly graph: LogicalTaskGraphV1
  readonly certificate: PlanCertificateV1
  readonly requiresClarification: boolean
  readonly blockers: readonly OrchestrationBlocker[]
}

/** Start one accepted compilation. */
export interface OrchestrationStartRequest {
  readonly compilationId: string
  readonly approvalRef?: string
}

/** Run lifecycle retained independently from health and blockers. */
export type OrchestrationRunState =
  | 'awaiting_clarification'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'indeterminate'

/** Node lifecycle in the durable Scheduler. */
export type OrchestrationNodeState =
  | 'pending'
  | 'ready'
  | 'awaiting_recompile'
  | 'awaiting_approval'
  | 'running'
  | 'retry_wait'
  | 'passed'
  | 'failed'
  | 'blocked'
  | 'indeterminate'
  | 'cancelled'

/** Structured scheduler blocker. */
export interface OrchestrationBlocker {
  readonly code: string
  readonly message: string
  readonly nodeId?: string
}

/** One sealed operator selection. */
export interface PhysicalOperatorPlanV1 {
  readonly operatorId: string
  readonly mode: 'resident'
  readonly profile?: PhysicalOperatorExecutionPreference
  readonly injectionBoundaries: readonly ('pre-dispatch' | 'next-turn' | 'checkpoint')[]
}

/** Immutable physical attempt input. */
export interface NodeExecutionPlanV1 {
  readonly version: 1
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly attempt: number
  readonly executionId: PhysicalOperatorExecutionId
  readonly graphCertificateHash: string
  readonly intentRef: OrchestrationArtifactRef
  readonly requirementRef?: OrchestrationArtifactRef
  readonly taskRef: OrchestrationArtifactRef
  readonly capabilityPlanRef: OrchestrationArtifactRef
  readonly capabilityGeneration: number
  readonly contextPacketRef: OrchestrationArtifactRef
  readonly operatorPlan: PhysicalOperatorPlanV1
  readonly effectiveReadScopes: readonly string[]
  readonly effectiveWriteScopes: readonly string[]
  readonly effectiveEffects: CapabilityEffectSet
  readonly verificationPlan: readonly OrchestrationAcceptanceRequirement[]
  readonly approvalRef?: string
  readonly planSha256: string
}

/** Public projection of one graph node. */
export interface OrchestrationNodeSnapshot {
  readonly id: string
  readonly title: string
  readonly role: string
  readonly dependsOn: readonly string[]
  readonly state: OrchestrationNodeState
  readonly attempt: number
  readonly capabilityGeneration: number
  readonly operatorId?: string
  readonly operatorProfile?: PhysicalOperatorExecutionPreference
  readonly capabilityPlanRef?: OrchestrationArtifactRef
  readonly contextPacketRef?: OrchestrationArtifactRef
  readonly executionPlanRef?: OrchestrationArtifactRef
  readonly evidenceRefs: readonly OrchestrationArtifactRef[]
  readonly blockers: readonly OrchestrationBlocker[]
  readonly updatedAt: string
}

/** Public bounded run projection. */
export interface OrchestrationRunSnapshot {
  readonly runId: OrchestrationRunId
  readonly title: string
  readonly workspace: string
  readonly state: OrchestrationRunState
  readonly revision: number
  readonly graphRevision: number
  readonly certificate: PlanCertificateV1
  readonly nodes: readonly OrchestrationNodeSnapshot[]
  readonly blockers: readonly OrchestrationBlocker[]
  readonly createdAt: string
  readonly updatedAt: string
}

/** One append-only orchestration event. */
export interface OrchestrationEvent {
  readonly sequence: number
  readonly runId: OrchestrationRunId
  readonly nodeId?: string
  readonly attempt?: number
  readonly generation?: number
  readonly type: string
  readonly time: string
  readonly data: Readonly<Record<string, unknown>>
}

/** Bounded event read request. */
export interface OrchestrationEventReadRequest {
  readonly runId: OrchestrationRunId
  readonly afterSequence?: number
  readonly limit?: number
}

/** Ordered event page. */
export interface OrchestrationEventPage {
  readonly events: readonly OrchestrationEvent[]
  readonly nextSequence: number
}

/** Optimistic run control request. */
export interface OrchestrationControlRequest {
  readonly runId: OrchestrationRunId
  readonly expectedRevision: number
  readonly action: 'pause' | 'resume' | 'cancel'
  readonly reason: string
}

/** Human decision for a pending run or node approval. */
export interface OrchestrationDecisionRequest {
  readonly runId: OrchestrationRunId
  readonly expectedRevision: number
  readonly nodeId?: string
  readonly decision: 'approve' | 'reject'
  readonly reason: string
}

/** Explicit indeterminate attempt resolution. */
export interface OrchestrationIndeterminateRequest {
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly expectedRevision: number
  readonly decision: 'abandon' | 'retry'
  readonly reason: string
}

/** Proposed capability generation change. */
export interface CapabilityUpdateRequest {
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly expectedRevision: number
  readonly requestedCapabilities: readonly string[]
  readonly applyAt: 'next-turn' | 'immediate'
}

/** Durable capability update admission record. */
export interface CapabilityUpdateReceipt {
  readonly updateId: string
  readonly state: 'queued' | 'awaiting_approval' | 'rejected'
  readonly generation: number
  readonly updateSha256: string
  readonly errorCode?: string
}

/** Orchestration error taxonomy. */
export type OrchestrationErrorCode =
  | 'GRAPH_INVALID'
  | 'GRAPH_CYCLE'
  | 'COMPILATION_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'RUN_STATE_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'NODE_INDETERMINATE'
  | 'CAPABILITY_RECOMPILE_REQUIRED'
  | 'CAPABILITY_HOTSWAP_UNSUPPORTED'
  | 'ORCHESTRATION_UNAVAILABLE'

/** Stable orchestration failure. */
export class OrchestrationError extends HarnessError {
  constructor(message: string, code: OrchestrationErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'OrchestrationError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    orchestrations: OrchestrationService
  }
}

/** Provider-neutral durable orchestration control service. */
export abstract class OrchestrationService extends Service {
  constructor(ctx: Context) {
    if (new.target === OrchestrationService) {
      throw new Error('@deepseek-ai/dsh-orchestration is an abstract seam; load a Provider')
    }
    super(ctx, 'orchestrations')
  }

  /**
   * Compile immutable Intent and Graph inputs.
   * @param request - immutable compilation input.
   * @returns the certified compilation.
   */
  abstract compile(request: OrchestrationCompileRequest): Promise<OrchestrationCompilationV1>
  /**
   * Start one accepted certified compilation.
   * @param request - accepted compilation identity and optional approval.
   * @returns the new durable run.
   */
  abstract start(request: OrchestrationStartRequest): Promise<OrchestrationRunSnapshot>
  /**
   * List known durable runs.
   * @returns bounded snapshots for known runs.
   */
  abstract list(): Promise<OrchestrationRunSnapshot[]>
  /**
   * Inspect one durable run.
   * @param runId - durable run identity.
   * @returns the current bounded run snapshot.
   */
  abstract inspect(runId: OrchestrationRunId): Promise<OrchestrationRunSnapshot>
  /**
   * Read append-only orchestration events.
   * @param request - run cursor and page bounds.
   * @returns an ordered event page.
   */
  abstract readEvents(request: OrchestrationEventReadRequest): Promise<OrchestrationEventPage>
  /**
   * Apply a revision-checked run control.
   * @param request - revision-checked run control.
   * @returns the updated run snapshot.
   */
  abstract control(request: OrchestrationControlRequest): Promise<OrchestrationRunSnapshot>
  /**
   * Apply a revision-checked human decision.
   * @param request - revision-checked human decision.
   * @returns the updated run snapshot.
   */
  abstract decide(request: OrchestrationDecisionRequest): Promise<OrchestrationRunSnapshot>
  /**
   * Resolve an indeterminate physical outcome explicitly.
   * @param request - explicit indeterminate resolution.
   * @returns the updated run snapshot.
   */
  abstract resolveIndeterminate(request: OrchestrationIndeterminateRequest): Promise<OrchestrationRunSnapshot>
  /**
   * Propose one late-bound capability change.
   * @param request - requested capability change.
   * @returns the durable update receipt.
   */
  abstract proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt>
}

export type { CapabilityBindingPlanV1, ContextPacketV1 }
export default OrchestrationService
