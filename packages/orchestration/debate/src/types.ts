/** Serializable, versioned contracts for the provider-neutral Debate seam. */

/** JSON-compatible value accepted in an event payload or other durable record. */
export type DebateJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly DebateJsonValue[]
  | { readonly [key: string]: DebateJsonValue }

/** User-selected debate behavior. `auto` is a policy decision, not a provider. */
export type DebateMode = 'auto' | 'enabled' | 'disabled'

/** Durable lifecycle of a debate run. */
export type DebateLifecycle =
  | 'planned'
  | 'awaiting_approval'
  | 'admitting'
  | 'round_running'
  | 'reviewing'
  | 'converged'
  | 'next_round'
  | 'budget_limited'
  | 'max_rounds'
  | 'synthesizing'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'indeterminate'

/** The only role identifiers admitted by the first Debate contract. */
export type DebateRoleId =
  | 'constructive-proposer'
  | 'skeptical-falsifier'
  | 'evidence-auditor'
  | 'decision-judge'

/** Whether a roster slot contributes arguments or makes the final decision. */
export type DebateRoleKind = 'participant' | 'judge'
/** Capability tier required by a fixed roster slot. */
export type DebateModelTier = 'low' | 'medium' | 'high'
/** Billing/authentication source used by a roster slot. */
export type DebateModelSource = 'native-subscription' | 'metered-api' | 'local'

/** A fixed-roster persona; providers may map it to a supported operator. */
export interface DebateRolePersonaV1 {
  readonly title: string
  readonly mandate: string
  readonly stance: string
  readonly instructions: readonly string[]
}

/** One immutable slot in a debate roster. */
export interface DebateRoleSpecV1 {
  readonly version: 1
  readonly role: DebateRoleId
  readonly kind: DebateRoleKind
  readonly operatorId: string
  readonly model: string
  readonly tier: DebateModelTier
  readonly source: DebateModelSource
  readonly persona: DebateRolePersonaV1
  readonly required?: boolean
}

/** Deterministic round protocol: independent first pass, then ledger-focused review. */
export interface DebateRoundStrategyV1 {
  readonly version: 1
  readonly firstRound: 'blind-independent'
  readonly followUp: 'claim-ledger'
  readonly escalation: 'high-severity-unresolved'
}

/** Hard bounds for one run; providers must stop at the first exhausted bound. */
export interface DebateBudgetV1 {
  readonly version: 1
  readonly maxRounds: number
  readonly maxTurnsPerAgent: number
  readonly maxAgentsPerRound: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxTotalTokens: number
  readonly maxCostUsd?: number
}

/** Explicit convergence policy; dissent remains observable even after convergence. */
export interface DebateConvergencePolicyV1 {
  readonly version: 1
  readonly scoreThreshold: number
  readonly minSettledAgents: number
  readonly maxUnresolvedHighSeverity: number
  readonly requireEvidenceForCritical: boolean
  readonly earlyStop: boolean
}

/** Complete provider-independent policy selected for a run. */
export interface DebatePolicyV1 {
  readonly version: 1
  readonly mode: DebateMode
  readonly roster: readonly DebateRoleSpecV1[]
  readonly budget: DebateBudgetV1
  readonly rounds: DebateRoundStrategyV1
  readonly convergence: DebateConvergencePolicyV1
  readonly preserveDissent: boolean
}

/** Existing DSH execution seam that owns a Debate run. */
export type DebateExecutionKind = 'standalone' | 'taskgraph-node' | 'rlm-session'

/** Optional parent identity proving which existing DSH seam owns the run. */
export interface DebateExecutionRefV1 {
  readonly version: 1
  readonly kind: DebateExecutionKind
  readonly runId?: string
  readonly nodeId?: string
  readonly sessionId?: string
}

/** Lineage-only source identity; source contents remain owned by the source system. */
export interface DebateSourceRefV1 {
  readonly version: 1
  readonly ref: string
  readonly kind: 'artifact' | 'evidence' | 'context' | 'document' | 'url'
  readonly digest?: string
}

/** Provider input. `commandId` is the adapter's idempotency identity. */
export interface DebateStartRequestV1 {
  readonly version: 1
  readonly commandId: string
  /** Canonical workspace in which the existing TaskGraph Scheduler admits every round. */
  readonly workspace: string
  readonly prompt: string
  readonly objective?: string
  readonly policy: DebatePolicyV1
  readonly sourceRefs?: readonly DebateSourceRefV1[]
  readonly execution?: DebateExecutionRefV1
  readonly sourceSessionId?: string
}

/** Current evidence-backed disposition of a normalized claim. */
export type DebateClaimStatus = 'open' | 'supported' | 'refuted' | 'settled' | 'unresolved'
/** Review severity assigned to a normalized claim or unresolved item. */
export type DebateClaimSeverity = 'low' | 'medium' | 'high' | 'critical'

/** Evidence identity attached to a claim or dissent, never inline source content. */
export interface DebateEvidenceRefV1 {
  readonly version: 1
  readonly ref: string
  readonly kind: 'source' | 'artifact' | 'observation' | 'quote'
  readonly digest?: string
}

/** A normalized claim ledger entry shared by later rounds and synthesis. */
export interface DebateClaimV1 {
  readonly version: 1
  readonly claimId: string
  readonly statement: string
  readonly status: DebateClaimStatus
  readonly severity: DebateClaimSeverity
  readonly confidence: number
  readonly supportingSlotIds: readonly string[]
  readonly opposingSlotIds: readonly string[]
  readonly evidenceRefs: readonly DebateEvidenceRefV1[]
  readonly rationale?: string
}

/** Content-addressed claim projection shared between rounds. */
export interface DebateClaimLedgerV1 {
  readonly version: 1
  readonly claims: readonly DebateClaimV1[]
  readonly coverage: number
  readonly digest: string
}

/** A preserved minority position; convergence never erases dissent. */
export interface DebateDissentV1 {
  readonly version: 1
  readonly slotId: string
  readonly claimId: string
  readonly position: string
  readonly reason: string
  readonly confidence: number
  readonly evidenceRefs: readonly DebateEvidenceRefV1[]
}

/** A gap that remains unresolved and may block a successful synthesis. */
export interface DebateUnresolvedV1 {
  readonly version: 1
  readonly claimId: string
  readonly description: string
  readonly severity: DebateClaimSeverity
  readonly blocking: boolean
  readonly reason: string
  readonly requiredEvidenceRefs: readonly DebateEvidenceRefV1[]
}

/** Model usage reported by one agent turn; cost remains provider/account-sourced. */
export interface DebateUsageV1 {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly costUsd?: number
}

/** Usage and account-sourced cost attributed to one roster slot. */
export interface DebateSlotCostV1 {
  readonly version: 1
  readonly slotId: string
  readonly model: string
  readonly usage: DebateUsageV1
}

/** Aggregated cost and token accounting, retained as a projection rather than authority. */
export interface DebateCostSummaryV1 {
  readonly version: 1
  /** Whether token totals cover every settled turn. */
  readonly usageStatus: 'known' | 'partial' | 'unknown'
  /** Whether account-sourced cost covers every settled turn. */
  readonly costStatus: 'known' | 'partial' | 'unknown'
  /** Reported token subtotal; absent when no settled turn supplied token usage. */
  readonly inputTokens?: number
  /** Reported token subtotal; absent when no settled turn supplied token usage. */
  readonly outputTokens?: number
  /** Reported cache subtotal; absent when no settled turn supplied this counter. */
  readonly cacheReadInputTokens?: number
  /** Reported cache subtotal; absent when no settled turn supplied this counter. */
  readonly cacheWriteInputTokens?: number
  /** Account-sourced cost subtotal; absent when no settled turn supplied cost. */
  readonly costUsd?: number
  /** Settled turns whose Evidence contained no token usage. */
  readonly unknownUsageTurns: number
  /** Settled turns whose Evidence contained no account-sourced cost. */
  readonly unknownCostTurns: number
  readonly bySlot: readonly DebateSlotCostV1[]
}

/** Bounded Evidence coverage projection for one run. */
export interface DebateEvidenceSummaryV1 {
  readonly version: 1
  readonly refs: readonly DebateEvidenceRefV1[]
  readonly coverage: number
  readonly missingRefs: readonly string[]
  readonly lineage: readonly string[]
}

/** Provenance of the provider that produced a run projection. */
export interface DebateProvenanceV1 {
  readonly version: 1
  readonly providerId: string
  readonly providerVersion: string
  readonly requestSha256: string
  readonly policySha256: string
  readonly sourceSessionId?: string
  readonly parentRunId?: string
  readonly parentNodeId?: string
  readonly parentRlmSessionId?: string
  readonly outputSha256?: string
}

/** Durable lifecycle of one roster slot turn. */
export type DebateAgentTurnState = 'planned' | 'dispatched' | 'settled' | 'failed' | 'indeterminate'

/** One provider-reported attempt of one fixed roster slot. */
export interface DebateAgentTurnV1 {
  readonly version: 1
  readonly round: number
  readonly slotId: string
  readonly role: DebateRoleId
  readonly operatorId: string
  readonly model: string
  readonly state: DebateAgentTurnState
  readonly outputRef?: string
  readonly outputPreview?: string
  readonly claimIds: readonly string[]
  readonly evidenceRefs: readonly DebateEvidenceRefV1[]
  readonly usage?: DebateUsageV1
  readonly startedAt?: string
  readonly settledAt?: string
  readonly errorCode?: string
}

/** Result of the deterministic convergence evaluator. */
export type DebateConvergenceStatus = 'converged' | 'continue' | 'budget_limited' | 'max_rounds'

/** Explainable result of one round's convergence evaluation. */
export interface DebateConvergenceV1 {
  readonly version: 1
  readonly status: DebateConvergenceStatus
  readonly score: number
  readonly threshold: number
  readonly disagreement: number
  readonly coverage: number
  readonly unresolvedHighSeverity: number
  readonly settledAgents: number
  readonly reason: string
}

/** Durable lifecycle of one Debate round. */
export type DebateRoundState = 'planned' | 'running' | 'reviewing' | 'completed' | 'failed' | 'indeterminate'

/** Complete projection of one round and its claim review. */
export interface DebateRoundSnapshotV1 {
  readonly version: 1
  readonly round: number
  readonly state: DebateRoundState
  readonly turns: readonly DebateAgentTurnV1[]
  readonly claimLedger: DebateClaimLedgerV1
  readonly dissent: readonly DebateDissentV1[]
  readonly unresolved: readonly DebateUnresolvedV1[]
  readonly convergence?: DebateConvergenceV1
}

/** Lifecycle of the final Debate synthesis. */
export type DebateSynthesisState = 'pending' | 'running' | 'settled' | 'failed'

/** Final synthesis reference with preserved dissent and unresolved claims. */
export interface DebateSynthesisV1 {
  readonly version: 1
  readonly state: DebateSynthesisState
  readonly artifactRef?: string
  readonly outputPreview?: string
  readonly unresolvedClaimIds: readonly string[]
  readonly dissentCount: number
}

/** Full inspect projection. It deliberately contains no scheduler or database handle. */
export interface DebateRunSnapshotV1 {
  readonly version: 1
  readonly runId: string
  readonly revision: number
  readonly state: DebateLifecycle
  readonly mode: DebateMode
  readonly promptSha256: string
  readonly objective?: string
  readonly policy: DebatePolicyV1
  readonly roster: readonly DebateRoleSpecV1[]
  readonly currentRound: number
  readonly rounds: readonly DebateRoundSnapshotV1[]
  readonly claimLedger: DebateClaimLedgerV1
  readonly dissent: readonly DebateDissentV1[]
  readonly unresolved: readonly DebateUnresolvedV1[]
  readonly evidence: DebateEvidenceSummaryV1
  readonly cost: DebateCostSummaryV1
  readonly provenance: DebateProvenanceV1
  readonly synthesis?: DebateSynthesisV1
  readonly createdAt: string
  readonly updatedAt: string
}

/** Bounded list projection for one Debate run. */
export interface DebateRunSummaryV1 {
  readonly version: 1
  readonly runId: string
  readonly state: DebateLifecycle
  readonly mode: DebateMode
  readonly currentRound: number
  readonly revision: number
  readonly unresolvedCount: number
  readonly cost: DebateCostSummaryV1
  readonly updatedAt: string
}

/** Append-only Debate event names consumed by durable projections. */
export type DebateEventType =
  | 'debate.planned'
  | 'debate.roster.qualified'
  | 'debate.roster.rejected'
  | 'debate.admitted'
  | 'debate.round.started'
  | 'debate.agent.dispatched'
  | 'debate.agent.settled'
  | 'debate.agent.failed'
  | 'debate.agent.indeterminate'
  | 'debate.claims.compiled'
  | 'debate.convergence.evaluated'
  | 'debate.synthesis.started'
  | 'debate.synthesis.settled'
  | 'debate.cost.accounted'
  | 'debate.stopped'
  | 'debate.failed'
  | 'debate.indeterminate'

/** Append-only event contract used by UI/consumer projections. */
export interface DebateEventV1 {
  readonly version: 1
  readonly sequence: number
  readonly runId: string
  readonly revision: number
  readonly generation: number
  readonly round?: number
  readonly slotId?: string
  readonly type: DebateEventType
  readonly createdAt: string
  readonly data: Readonly<Record<string, DebateJsonValue>>
}

/** Bounded cursor request for one run's append-only events. */
export interface DebateEventReadRequestV1 {
  readonly runId: string
  readonly afterSequence?: number
  readonly limit?: number
}

/** Cursor page returned by the Debate event reader. */
export interface DebateEventPageV1 {
  readonly events: readonly DebateEventV1[]
  readonly nextSequence: number
}

/** Revision-fenced lifecycle actions accepted by the Debate Provider. */
export type DebateControlAction = 'approve' | 'reject' | 'pause' | 'resume' | 'stop'

/** Idempotent, revision-fenced control command. */
export interface DebateControlRequestV1 {
  readonly version: 1
  readonly commandId: string
  readonly runId: string
  readonly expectedRevision: number
  readonly action: DebateControlAction
  readonly reason: string
}

/** Stable role order advertised to Providers and Consumers. */
export const DEBATE_ROLE_ORDER = [
  'constructive-proposer',
  'skeptical-falsifier',
  'evidence-auditor',
  'decision-judge',
] as const satisfies readonly DebateRoleId[]
