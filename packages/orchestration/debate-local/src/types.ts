/** Types for the owner-local Debate Provider and its injected turn executor. */

import type {
  DebateAgentProgressV1,
  DebateClaimLedgerV1,
  DebateClaimV1,
  DebateDissentV1,
  DebateExecutionRefV1,
  DebateEvidenceRefV1,
  DebateRolePersonaV1,
  DebateRoleId,
  DebateModelSource,
  DebateModelTier,
  DebateSourceRefV1,
  DebateUnresolvedV1,
  DebateUsageV1,
  DebateTurnBlockerV1,
  DebateTurnRoutingV1,
} from '@deepseek-ai/dsh-debate'

/** Round phase supplied to the injected executor. */
export type DebateTurnPhase = 'blind-independent' | 'claim-ledger' | 'high-severity-unresolved'

/** Input sent to one roster slot by the local Provider. */
export interface DebateTurnRequestV1 {
  /** Request schema version. */
  readonly version: 1
  /** Stable Debate run identity. */
  readonly runId: string
  /** Canonical workspace admitted by the existing TaskGraph Scheduler. */
  readonly workspace: string
  /** One-based round number being executed. */
  readonly round: number
  /** Stable roster slot identity. */
  readonly slotId: string
  /** Fixed role assigned to the slot. */
  readonly role: DebateRoleId
  /** Fixed role persona retained in the sealed TaskGraph node task. */
  readonly persona: DebateRolePersonaV1
  /** Deployment-owned physical operator identity. */
  readonly operatorId: string
  /** Explicit alternatives resolved at Scheduler attempt admission. */
  readonly fallbackOperatorIds?: readonly string[]
  /** Model identifier selected for the slot. */
  readonly model: string
  /** Qualified model tier retained from the fixed roster. */
  readonly tier: DebateModelTier
  /** Qualified accounting/authentication source retained from the fixed roster. */
  readonly source: DebateModelSource
  /** Protocol phase for this turn. */
  readonly phase: DebateTurnPhase
  /** Prompt assembled for this role and round. */
  readonly prompt: string
  /** Optional objective carried from the start request. */
  readonly objective?: string
  /** Source identities carried without copying their contents into Debate state. */
  readonly sourceRefs: readonly DebateSourceRefV1[]
  /** Optional parent execution lineage retained through the TaskGraph admission. */
  readonly execution?: DebateExecutionRefV1
  /** Source DSH Session retained for orchestration Trace lineage. */
  readonly sourceSessionId?: string
  /** Claims settled before this turn began. */
  readonly priorLedger: DebateClaimLedgerV1
  /** Dissent retained before this turn began. */
  readonly priorDissent: readonly DebateDissentV1[]
  /** Unresolved gaps retained before this turn began. */
  readonly priorUnresolved: readonly DebateUnresolvedV1[]
  /** Cancellation signal for the current execution attempt. */
  readonly signal?: AbortSignal
}

/** Result returned by one injected executor turn; no model or CLI is assumed. */
export interface DebateTurnResultV1 {
  /** Scheduler attempt that produced this settled result. */
  readonly attempt?: number
  /** Calibrated confidence for this complete turn, required even when no claim is emitted. */
  readonly confidence: number
  /** Optional durable reference to the complete turn output. */
  readonly outputRef?: string
  /** Optional bounded preview of the turn output. */
  readonly outputPreview?: string
  /** Claims contributed by this turn. */
  readonly claims?: readonly DebateClaimV1[]
  /** Optional complete ledger supplied by the executor. */
  readonly claimLedger?: DebateClaimLedgerV1
  /** Minority positions preserved by this turn. */
  readonly dissent?: readonly DebateDissentV1[]
  /** Gaps that remain unresolved after this turn. */
  readonly unresolved?: readonly DebateUnresolvedV1[]
  /** Evidence identities referenced by this turn. */
  readonly evidenceRefs?: readonly DebateEvidenceRefV1[]
  /** Provider-reported token and cost accounting. */
  readonly usage?: DebateUsageV1
  /** Scheduler-owned requested/actual routing for this settled logical role. */
  readonly routing?: DebateTurnRoutingV1
}

/** One authoritative per-slot Scheduler outcome when no settled result exists. */
export interface DebateTurnFailureV1 {
  /** Terminal outcome for the slot when no settled turn result exists. */
  readonly state: 'blocked' | 'failed' | 'indeterminate'
  /** Scheduler attempt number that produced this outcome. */
  readonly attempt: number
  /** Stable error code explaining why the slot did not settle. */
  readonly errorCode: string
  /** Structured blockers that prevent the slot from settling. */
  readonly blockers: readonly DebateTurnBlockerV1[]
  /** Scheduler-owned requested and actual routing for this failed slot. */
  readonly routing?: DebateTurnRoutingV1
}

/** One safe progress fact emitted while a TaskGraph-backed roster slot is running. */
export interface DebateRoundAgentProgressV1 {
  /** Progress schema version. */
  readonly version: 1
  /** Stable Debate run identity. */
  readonly runId: string
  /** One-based Debate round identity. */
  readonly round: number
  /** Fixed roster slot identity. */
  readonly slotId: string
  /** Fixed role retained even when its physical route falls back. */
  readonly role: DebateRoleId
  /** Whitelisted physical-operator projection and its original event position. */
  readonly progress: DebateAgentProgressV1
}

/** Ephemeral settled usage and bounds used to admit one sealed TaskGraph round. */
export interface DebateRoundBudgetEnvelopeV1 {
  /** Envelope schema version. */
  readonly version: 1
  /** Input tokens settled before this round is admitted. */
  readonly usedInputTokens: number
  /** Output tokens settled before this round is admitted. */
  readonly usedOutputTokens: number
  /** Run-wide input-token cap. */
  readonly maxInputTokens: number
  /** Run-wide output-token cap. */
  readonly maxOutputTokens: number
  /** Run-wide combined token cap. */
  readonly maxTotalTokens: number
}

/** Conservative token reservation for one sealed round. */
export interface DebateRoundBudgetEstimateV1 {
  /** Estimated input tokens for all roster slots. */
  readonly inputTokens: number
  /** Estimated output tokens for all roster slots. */
  readonly outputTokens: number
  /** Estimated combined input and output tokens for all roster slots. */
  readonly totalTokens: number
}

/** One token bound that prevents an otherwise sealed round from starting. */
export interface DebateRoundBudgetLimitV1 {
  /** Token counter whose bound would be exceeded. */
  readonly kind: 'input-tokens' | 'output-tokens' | 'total-tokens'
  /** Settled counter value before the round. */
  readonly used: number
  /** Conservative reservation for the requested round. */
  readonly reserved: number
  /** Configured run-wide counter bound. */
  readonly limit: number
  /** Human-readable deterministic admission reason. */
  readonly reason: string
}

/** Deterministic result of an optional executor-side budget admission probe. */
export type DebateRoundBudgetPreflightV1 =
  | {
    /** Preflight schema version. */
    readonly version: 1
    /** The round fits the supplied envelope. */
    readonly status: 'admitted'
    /** Conservative reservation calculated by the executor. */
    readonly estimate: DebateRoundBudgetEstimateV1
  }
  | {
    /** Preflight schema version. */
    readonly version: 1
    /** The round would exhaust a supplied token bound. */
    readonly status: 'budget_limited'
    /** Conservative reservation calculated by the executor. */
    readonly estimate: DebateRoundBudgetEstimateV1
    /** Exact bound and values that denied admission. */
    readonly limit: DebateRoundBudgetLimitV1
  }

/** One immutable round admitted as one TaskGraph. */
export interface DebateRoundExecutionRequestV1 {
  /** Request schema version. */
  readonly version: 1
  /** Stable Debate run identity. */
  readonly runId: string
  /** One-based round number. */
  readonly round: number
  /** Participant turns followed by the decision judge. */
  readonly turns: readonly DebateTurnRequestV1[]
  /** Certified maximum parallel participant count for this round. */
  readonly maxParallel: number
  /**
   * Optional in-memory token bounds for deterministic admission before the
   * executor creates a TaskGraph. This metadata is never persisted in a
   * Debate snapshot.
   */
  readonly budgetEnvelope?: DebateRoundBudgetEnvelopeV1
  /**
   * Optional durable-progress sink. The executor awaits it in source event
   * order; an unavailable sink must fail the round rather than lose a claimed
   * public trace.
   */
  readonly onProgress?: (progress: DebateRoundAgentProgressV1) => Promise<void>
  /** Cancellation signal for the complete TaskGraph round. */
  readonly signal?: AbortSignal
}

/** Slot-keyed results returned after the round TaskGraph reaches a terminal state. */
export interface DebateRoundExecutionResultV1 {
  /** Result schema version. */
  readonly version: 1
  /** Completed turn result indexed by its roster slot identity. */
  readonly resultsBySlot: Readonly<Record<string, DebateTurnResultV1>>
  /** Slot-specific failures retained instead of collapsing the whole round. */
  readonly failuresBySlot?: Readonly<Record<string, DebateTurnFailureV1>>
}

/** Existing-Scheduler execution port consumed by the local Debate owner. */
export interface DebateRoundExecutorPort {
  /**
   * Optionally estimate and admit a sealed round without creating a TaskGraph
   * or dispatching an operator.
   * @param request - Sealed roster turns and optional transient budget bounds.
   * @returns Deterministic token admission result.
   */
  preflight?(request: DebateRoundExecutionRequestV1): DebateRoundBudgetPreflightV1
  /** Execute one complete round without creating another Scheduler. */
  executeRound(request: DebateRoundExecutionRequestV1): Promise<DebateRoundExecutionResultV1>
}

/** Production executor: one round maps to one durable TaskGraph. */
export type DebateRoundExecutor = DebateRoundExecutorPort

/** Cordis configuration for the local Provider. */
export interface Config {
  /** Owner-private directory containing the Provider state file. */
  readonly root: string
  /** Injected round executor; omitted only when constructing a Provider for inspection. */
  readonly executor?: DebateRoundExecutor
  /** Stable Provider identity written to run provenance. */
  readonly providerId?: string
  /** Provider implementation version written to run provenance. */
  readonly providerVersion?: string
}

/** Programmatic options, including deterministic test seams. */
export interface LocalDebateProviderOptions extends Config {
  /** Owner-private directory containing the Provider state file. */
  readonly root: string
  /** Injected executor that maps one Debate round to the existing Scheduler. */
  readonly executor: DebateRoundExecutor
  /** Clock used for durable timestamps; production defaults to wall time. */
  readonly clock?: () => string
  /** Run-id source; production defaults to random UUIDs. */
  readonly idFactory?: () => string
}

/** Accepted constructor input for production config, test seams, or a legacy root path. */
export type LocalDebateConfig = Config | LocalDebateProviderOptions | string
