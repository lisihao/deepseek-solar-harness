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
import type {
  ContinualHarnessMode,
  ExecutionModelPreference,
  ModelAllocationObjective,
  ModelAllocationPlan,
  ModelExecutionOffer,
  ModelTaskPhase,
  PlannerVerifierPreference,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-model-allocation'
import { HarnessError, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PhysicalOperatorExecutionId,
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorStopReason,
  PhysicalOperatorUsage,
} from '@deepseek-ai/dsh-physical-operator'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'

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

/** User/system selection for Prime-compatible host-driven continuation. */
export type RlmAutonomousMode = 'auto' | 'enabled' | 'disabled'

/** Explicit result of one task-specific Autonomous end-condition check. */
export type AutonomousEndConditionStatusV1 = 'pass' | 'fail' | 'unknown'

/** One versioned check in a task-specific Autonomous end condition. */
export interface AutonomousEndConditionCheckV1 {
  /** Stable check identity used in persisted round results. */
  readonly id: string
  /** The host-owned evidence source used to evaluate this check. */
  readonly kind: 'acceptance' | 'artifact-present' | 'evaluator'
  /** Acceptance id, artifact id, or registered evaluator id. */
  readonly ref: string
}

/**
 * Immutable task-specific Autonomous termination contract.
 *
 * The contract is data only. It never embeds executable code; `evaluator` refs
 * are resolved by a separately registered host evaluator seam.
 */
export interface AutonomousEndConditionV1 {
  readonly version: 1
  readonly operator: 'all' | 'any'
  readonly checks: readonly AutonomousEndConditionCheckV1[]
}

/** Shell quality gates evaluated by the orchestration host after every completed assistant turn. */
export interface RlmAutonomousGateConfigV1 {
  readonly commands: readonly string[]
  readonly maxRetries?: number
  readonly timeoutMs?: number
}

/** Optional graph input for Prime-compatible Autonomous Mode. */
export interface RlmAutonomousConfigV1 {
  readonly mode: RlmAutonomousMode
  readonly maxContinuations?: number
  readonly maxTurns?: number
  readonly maxTokens?: number
  readonly timeoutMs?: number
  readonly continuationPrompt?: string
  readonly gates?: RlmAutonomousGateConfigV1
  /** Optional task-specific terminal condition evaluated after each round. */
  readonly endCondition?: AutonomousEndConditionV1
}

/** Fully resolved immutable Autonomous policy sealed into one physical attempt. */
export interface RlmAutonomousPolicyV1 {
  readonly version: 1
  readonly enabled: boolean
  readonly maxContinuations: number
  readonly maxTurns: number
  readonly maxTokens: number
  readonly timeoutMs: number
  readonly continuationPrompt: string
  readonly gates: {
    readonly commands: readonly string[]
    readonly maxRetries: number
    readonly timeoutMs: number
  }
  /** Immutable task-specific terminal condition, when configured. */
  readonly endCondition?: AutonomousEndConditionV1
  readonly policySha256: string
}

/** Immutable per-attempt Workbench contract retained as the execution task artifact. */
export interface WorkbenchTaskContractV1 {
  readonly version: 1
  readonly taskId: string
  readonly repository: {
    readonly workspace: string
    readonly baseSha?: string
    readonly executionWorkspace: NodeExecutionWorkspaceV1
  }
  readonly objective: string
  readonly task: string
  readonly dependencies: {
    readonly nodeIds: readonly string[]
    readonly evidenceRefs: readonly OrchestrationArtifactRef[]
  }
  readonly authority: {
    readonly readScopes: readonly string[]
    readonly writeScopes: readonly string[]
    readonly forbiddenScopes: readonly string[]
    readonly effects: CapabilityEffectSet
  }
  readonly acceptance: readonly OrchestrationAcceptanceRequirement[]
  readonly requiredArtifacts: readonly string[]
  readonly models: {
    readonly plannerNodeIds: readonly string[]
    readonly executor: {
      readonly operatorId: string
      readonly model: string
      readonly tier: ModelExecutionOffer['tier']
      readonly source: 'native-subscription' | 'metered-api'
    }
    readonly verifierNodeIds: readonly string[]
    readonly verifierTier: 'high' | 'unspecified'
  }
  readonly quota: {
    readonly class: 'native-subscription' | 'metered-api'
    readonly poolId?: string
  }
  readonly timeoutMs?: number
  readonly retryPolicy: OrchestrationRetryPolicy
  readonly permissions: {
    readonly externalNetwork: boolean
    readonly destructive: boolean
    readonly approvedSecretRefs: readonly string[]
  }
  readonly contractSha256: string
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
  /** Scopes explicitly excluded even when a broader read/write budget exists. */
  readonly forbiddenScopes?: readonly string[]
  readonly acceptance: readonly OrchestrationAcceptanceRequirement[]
  /** Named outputs the node contract must retain as Evidence. */
  readonly requiredArtifacts?: readonly string[]
  readonly retryPolicy: OrchestrationRetryPolicy
  /** Optional wall-clock bound for one physical attempt. */
  readonly timeoutMs?: number
  /** Quality-gate position used by the replaceable model allocator. */
  readonly phase?: ModelTaskPhase
  /** Node-local recursive execution; never a fourth global Scheduler or physical operator. */
  readonly rlm?: {
    readonly mode: RlmExecutionMode
    readonly maxDepth: number
    readonly maxChildren: number
    readonly maxTurns: number
  }
  /** Prime-compatible host policy; disabled unless explicitly or automatically admitted. */
  readonly autonomous?: RlmAutonomousConfigV1
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
  /** Optional Git commit the Workbench contract is based on. */
  readonly baseSha?: string
  /** Isolate mutating worker nodes in one Git worktree and branch per attempt. */
  readonly workspaceIsolation?: 'shared' | 'git-worktree'
  readonly maxParallel: number
  readonly risk: 'low' | 'medium' | 'high'
  /** Opt-in strict quality policy for code-changing Workbench graphs. */
  readonly qualityPolicy?: {
    readonly independentVerification: 'required' | 'advisory'
  }
  readonly nodes: readonly OrchestrationNodeSpecV1[]
}

/** Filesystem and Git branch sealed for one physical attempt. */
export interface NodeExecutionWorkspaceV1 {
  readonly mode: 'shared' | 'git-worktree'
  readonly path: string
  /** Commit from which this attempt branch was created. */
  readonly startSha?: string
  readonly branch?: string
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
  /** Durable trace of the DSH collaboration policy that admitted this graph. */
  readonly admission?: OrchestrationAdmissionTraceV1
}

/** User-selected collaboration policy and route captured before TaskGraph compilation. */
export interface OrchestrationAdmissionTraceV1 {
  readonly policy: 'auto' | 'direct' | 'codex' | 'claude-code'
  readonly route: 'taskgraph'
  readonly sourceSessionId: string
  /** Independent user/system choice; RLM is a node strategy, not an operator. */
  readonly rlm?: RlmExecutionMode
  /** Autonomous continuation is independent from Goal and reuses the same RLM/TaskGraph authority. */
  readonly autonomous?: RlmAutonomousMode
  /** Continuous Harness can be disabled, scoped to this Session, or scoped to a workspace. */
  readonly continualHarness?: ContinualHarnessMode
  /** Global quality/cost/throughput preference consumed by the allocation Provider. */
  readonly optimization?: ModelAllocationObjective
  /** Prefer Codex Sol for high-tier planning/verification, or choose the best qualified high-tier offer. */
  readonly plannerVerifierPreference?: PlannerVerifierPreference
  /** Prefer Codex Luna for execution leaves when qualified, or use ordinary balanced scoring. */
  readonly executionPreference?: ExecutionModelPreference
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
  readonly admission?: OrchestrationAdmissionTraceV1
  readonly certificate: PlanCertificateV1
  readonly requiresClarification: boolean
  readonly blockers: readonly OrchestrationBlocker[]
}

/** Start one accepted compilation. */
export interface OrchestrationStartRequest {
  /** Caller-stable identity reused when the same start request is retried. */
  readonly commandId: string
  readonly compilationId: string
  readonly approvalRef?: string
}

/** Immutable terminal Evidence retained for one physical execution attempt. */
export interface OrchestrationExecutionEvidenceV1 {
  readonly version: 1
  readonly executionId: PhysicalOperatorExecutionId
  readonly stopReason: PhysicalOperatorStopReason
  readonly output: readonly ContentBlock[]
  readonly usage?: PhysicalOperatorUsage
  readonly continuity?: {
    readonly sessionId: string
    readonly stateRevision: number
  }
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
  readonly mode: 'resident' | 'model-worker'
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
  readonly executionWorkspace: NodeExecutionWorkspaceV1
  readonly capabilityPlanRef: OrchestrationArtifactRef
  readonly capabilityGeneration: number
  readonly contextPacketRef: OrchestrationArtifactRef
  readonly allocationPlanRef: OrchestrationArtifactRef
  readonly allocationPlan: ModelAllocationPlan
  readonly rlmPlan?: RlmExecutionPlanV1
  /** Host continuation/gate policy sealed before the first physical receipt is accepted. */
  readonly autonomousPolicy?: RlmAutonomousPolicyV1
  /** Cost-aware child allocation used only by Smart Auto; Prime Strict inherits the parent. */
  readonly rlmWorkerPlan?: ModelAllocationPlan
  readonly harnessSnapshotRef?: OrchestrationArtifactRef
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
  readonly model?: string
  /** Allocator tier retained so the completed run remains explainable. */
  readonly modelTier?: ModelExecutionOffer['tier']
  readonly modelSource?: 'native-subscription' | 'metered-api'
  readonly quotaPoolId?: string
  readonly rlm?: RlmExecutionMode
  readonly autonomous?: RlmAutonomousMode
  readonly capabilityPlanRef?: OrchestrationArtifactRef
  readonly contextPacketRef?: OrchestrationArtifactRef
  readonly executionPlanRef?: OrchestrationArtifactRef
  readonly evidenceRefs: readonly OrchestrationArtifactRef[]
  readonly blockers: readonly OrchestrationBlocker[]
  /** Non-terminal scheduler reason while this node is pending or ready. */
  readonly waitReason?: OrchestrationBlocker
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
  /** Certified graph-wide concurrency ceiling. */
  readonly maxParallel?: number
  /** Current quota- and capacity-aware concurrency ceiling, never above maxParallel. */
  readonly effectiveParallelism?: number
  /** Collaboration policy and route that created this run, absent on legacy runs. */
  readonly admission?: OrchestrationAdmissionTraceV1
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
  readonly commandId: string
  readonly runId: OrchestrationRunId
  readonly expectedRevision: number
  readonly action: 'pause' | 'resume' | 'cancel'
  readonly reason: string
}

/** Human decision for a pending run or node approval. */
export interface OrchestrationDecisionRequest {
  readonly commandId: string
  readonly runId: OrchestrationRunId
  readonly expectedRevision: number
  readonly nodeId?: string
  readonly decision: 'approve' | 'reject'
  readonly reason: string
}

/** Explicit indeterminate attempt resolution. */
export interface OrchestrationIndeterminateRequest {
  readonly commandId: string
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly expectedRevision: number
  readonly decision: 'abandon' | 'retry'
  readonly reason: string
}

/** Explicitly abandon one crash-uncertain background auto-refinement round. */
export interface OrchestrationAutoRefineIndeterminateRequest {
  readonly commandId: string
  readonly runId: OrchestrationRunId
  readonly nodeId: string
  readonly expectedRevision: number
  readonly sessionId: string
  readonly roundId: string
  readonly branchVersion: string
  readonly decision: 'abandon'
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

/** Bounded Server-cluster authority projection; TaskGraph state remains owned by one elected Scheduler. */
export interface OrchestrationClusterStatus {
  readonly nodeId: string
  readonly memberIds: readonly string[]
  readonly term: number
  readonly role: 'follower' | 'candidate' | 'leader'
  readonly votedFor?: string
  readonly leaderId?: string
  readonly leaseUntil: number
  readonly commitIndex: number
  readonly quorum: number
  readonly canSchedule: boolean
}

/** One term-fenced vote request from another configured Product Server. */
export interface OrchestrationClusterVoteRequest {
  readonly term: number
  readonly candidateId: string
  readonly commitIndex: number
}

/** Durable vote response from one configured member. */
export interface OrchestrationClusterVoteResponse {
  readonly term: number
  readonly voterId: string
  readonly granted: boolean
  readonly commitIndex: number
}

/** Bounded majority-lease heartbeat from an elected Scheduler. */
export interface OrchestrationClusterHeartbeatRequest {
  readonly term: number
  readonly leaderId: string
  readonly commitIndex: number
  readonly leaseUntil: number
}

/** Follower acknowledgement and its current replication watermark. */
export interface OrchestrationClusterHeartbeatResponse {
  readonly term: number
  readonly followerId: string
  readonly accepted: boolean
  readonly commitIndex: number
}

/** Complete logical single-writer state replicated only across authenticated admin peers. */
export interface OrchestrationClusterReplicaV1 {
  readonly version: 1
  readonly stateSchemaVersion: number
  readonly commitIndex: number
  readonly capturedAt: string
  readonly tables: Readonly<Record<string, readonly Readonly<Record<string, string | number | null>>[]>>
  readonly artifacts: readonly { readonly ref: OrchestrationArtifactRef; readonly json: string }[]
}

/** Term-fenced follower installation request from the current elected leader. */
export interface OrchestrationClusterInstallRequest {
  readonly term: number
  readonly leaderId: string
  readonly replica: OrchestrationClusterReplicaV1
}

/** Applied or idempotently retained follower watermark. */
export interface OrchestrationClusterInstallReceipt {
  readonly nodeId: string
  readonly commitIndex: number
  readonly state: 'applied' | 'unchanged'
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
  | 'AUTONOMOUS_LIMIT_REACHED'
  | 'AUTONOMOUS_GATE_RETRY_EXHAUSTED'
  | 'COMMAND_CONFLICT'
  | 'COMMAND_INDETERMINATE'
  | 'WORKSPACE_INVALID'
  | 'WORKSPACE_DIRTY'
  | 'INTEGRATION_FAILED'
  | 'INTEGRATION_CONFLICT'
  | 'NOT_CLUSTER_LEADER'
  | 'ORCHESTRATION_VERSION_MISMATCH'
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
   * Read one immutable content-addressed artifact.
   * @param ref - digest-verified artifact identity returned by this service.
   * @returns the decoded immutable artifact value.
   */
  abstract readArtifact(ref: OrchestrationArtifactRef): Promise<unknown>
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
   * Resolve a crash-uncertain auto-refinement round without replaying model work.
   * @param request - run identity, expected revision, and explicit resolution.
   * @returns the updated durable run snapshot.
   */
  abstract resolveAutoRefineIndeterminate(request: OrchestrationAutoRefineIndeterminateRequest): Promise<OrchestrationRunSnapshot>
  /**
   * Propose one late-bound capability change.
   * @param request - requested capability change.
   * @returns the durable update receipt.
   */
  abstract proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt>
  /**
   * Read the local Server's bounded cluster authority projection.
   * @returns the current cluster status, or undefined in standalone mode.
   */
  abstract clusterStatus(): Promise<OrchestrationClusterStatus | undefined>
  /**
   * Process one authenticated, configured-member vote request.
   * @param request - candidate term and replication watermark.
   * @returns this member's term-fenced vote response.
   */
  abstract clusterRequestVote(request: OrchestrationClusterVoteRequest): Promise<OrchestrationClusterVoteResponse>
  /**
   * Process one authenticated majority-lease heartbeat.
   * @param request - elected leader term, lease, and replication watermark.
   * @returns this follower's lease acknowledgement.
   */
  abstract clusterHeartbeat(request: OrchestrationClusterHeartbeatRequest): Promise<OrchestrationClusterHeartbeatResponse>
  /**
   * Export one complete logical replica for authenticated cluster peers.
   * @returns the current durable TaskGraph state image.
   */
  abstract clusterExportReplica(): Promise<OrchestrationClusterReplicaV1>
  /**
   * Install one term-fenced leader replica while this node is a follower.
   * @param request - elected leader coordinates and logical state image.
   * @returns the follower's applied or unchanged watermark.
   */
  abstract clusterInstallReplica(request: OrchestrationClusterInstallRequest): Promise<OrchestrationClusterInstallReceipt>
}

export type { CapabilityBindingPlanV1, ContextPacketV1 }
export default OrchestrationService
