/** Browser-safe, bounded projection of provider-neutral Debate state. */

export const DEBATE_DASHBOARD_PATH = '/api/debates'

/** Browser projection of the durable Debate lifecycle. */
export type DesktopDebateLifecycle =
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

/** Trusted lifecycle controls exposed by the Desktop projection. */
export type DesktopDebateControlAction = 'approve' | 'reject' | 'pause' | 'resume' | 'stop'

/** Browser-safe token and account-cost projection. */
export interface DesktopDebateCost {
  version: 1
  usageStatus: 'known' | 'partial' | 'unknown'
  costStatus: 'known' | 'partial' | 'unknown'
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  costUsd?: number
  unknownUsageTurns: number
  unknownCostTurns: number
  bySlot: Array<{
    version: 1
    slotId: string
    model: string
    usage: {
      inputTokens: number
      outputTokens: number
      cacheReadInputTokens?: number
      cacheWriteInputTokens?: number
      costUsd?: number
    }
  }>
}

/** Bounded list row for one Debate run. */
export interface DesktopDebateRunSummary {
  version: 1
  runId: string
  state: DesktopDebateLifecycle
  mode: 'auto' | 'enabled' | 'disabled'
  currentRound: number
  revision: number
  unresolvedCount: number
  cost: DesktopDebateCost
  updatedAt: string
}

/** Public bounded usage accounting attached to one Debate turn. */
export interface DesktopDebateTurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  costUsd?: number
}

/** Public roster slot and its latest bounded turn projection. */
export interface DesktopDebateRole {
  role: 'constructive-proposer' | 'skeptical-falsifier' | 'evidence-auditor' | 'decision-judge'
  kind: 'participant' | 'judge'
  title: string
  /** Public role responsibility; private stance/instructions are never projected. */
  mandate: string
  operatorId: string
  model: string
  tier: 'low' | 'medium' | 'high'
  source: 'native-subscription' | 'metered-api' | 'local'
  required: boolean
  latestTurn?: {
    round: number
    state: 'planned' | 'dispatched' | 'settled' | 'failed' | 'indeterminate'
    outputRef?: string
    outputPreview?: string
    claimIds: string[]
    evidenceRefs: string[]
    usage?: DesktopDebateTurnUsage
    startedAt?: string
    settledAt?: string
    errorCode?: string
  }
}

/** Public claim ledger entry rendered by Desktop. */
export interface DesktopDebateClaim {
  claimId: string
  statement: string
  status: 'open' | 'supported' | 'refuted' | 'settled' | 'unresolved'
  severity: 'low' | 'medium' | 'high' | 'critical'
  confidence: number
  supportingSlotIds: string[]
  opposingSlotIds: string[]
  evidenceRefs: string[]
  rationale?: string
}

/** Preserved minority position rendered by Desktop. */
export interface DesktopDebateDissent {
  slotId: string
  claimId: string
  position: string
  reason: string
  confidence: number
  evidenceRefs: string[]
}

/** Unresolved claim gap rendered by Desktop. */
export interface DesktopDebateUnresolved {
  claimId: string
  description: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  blocking: boolean
  reason: string
  requiredEvidenceRefs: string[]
}

/** Bounded round and convergence projection. */
export interface DesktopDebateRound {
  round: number
  state: 'planned' | 'running' | 'reviewing' | 'completed' | 'failed' | 'indeterminate'
  /** Every public turn in this round, with only a bounded output preview. */
  turnStates: Array<{
    round: number
    slotId: string
    role: DesktopDebateRole['role']
    operatorId: string
    model: string
    state: 'planned' | 'dispatched' | 'settled' | 'failed' | 'indeterminate'
    outputRef?: string
    outputPreview?: string
    claimIds: string[]
    evidenceRefs: string[]
    usage?: DesktopDebateTurnUsage
    startedAt?: string
    settledAt?: string
    errorCode?: string
  }>
  convergence?: {
    status: 'converged' | 'continue' | 'budget_limited' | 'max_rounds'
    score: number
    threshold: number
    disagreement: number
    coverage: number
    unresolvedHighSeverity: number
    settledAgents: number
    reason: string
  }
}

/** Full browser-safe inspect projection for one Debate run. */
export interface DesktopDebateRun extends DesktopDebateRunSummary {
  objective?: string
  roles: DesktopDebateRole[]
  rounds: DesktopDebateRound[]
  claims: DesktopDebateClaim[]
  claimCoverage: number
  dissent: DesktopDebateDissent[]
  unresolved: DesktopDebateUnresolved[]
  evidence: { refs: string[]; coverage: number; missingRefs: string[]; lineage: string[] }
  synthesis?: {
    state: 'pending' | 'running' | 'settled' | 'failed'
    artifactRef?: string
    outputPreview?: string
    unresolvedClaimIds: string[]
    dissentCount: number
  }
  sourceSessionId?: string
  createdAt: string
}

/** Append-only event projection safe for browser transport. */
export interface DesktopDebateEvent {
  version: 1
  sequence: number
  runId: string
  revision: number
  generation: number
  round?: number
  slotId?: string
  type: string
  createdAt: string
  data: Record<string, unknown>
}

/** Complete Desktop list/inspect/event response. */
export interface DesktopDebateDashboard {
  version: 1
  generatedAt: string
  runs: DesktopDebateRunSummary[]
  selectedRunId?: string
  selectedRun?: DesktopDebateRun
  events?: DesktopDebateEvent[]
  nextSequence?: number
}

/** Revision-fenced control submitted by the trusted Desktop panel. */
export interface DesktopDebateControlRequest {
  version: 1
  commandId: string
  runId: string
  expectedRevision: number
  action: DesktopDebateControlAction
  reason: string
}
