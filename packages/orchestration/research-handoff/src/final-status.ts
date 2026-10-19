/** Current process completeness and immutable historical decisions, never factual accuracy scores. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchRunId } from './action.ts'
import type { ResearchClaimId, ResearchJudgmentAttribution } from './claims.ts'

/** Owner-scoped immutable decision identity. */
export type ResearchFinalDecisionId = Branded<'ResearchFinalDecisionId'>
/** Missing core input, incomplete process, or completed attributed verification and synthesis process. */
export type ResearchFinalState = 'needs-input' | 'partial' | 'verified-and-synthesized'
/** Machine-computed unmet conditions; imported completion flags cannot supply these values. */
export type ResearchFinalIssue = 'original-question' | 'gemini-report' | 'chatgpt-report' | 'run-confirmation'
  | 'inventory-confirmation' | 'final-map-confirmation' | 'fact-support' | 'counter-check' | 'counter-disposition'
  | 'zero-critical-facts'
/** Complete normalized record at the decision time; JSON is retained evidence, not executable authority. */
export interface ResearchFinalEvidence {
  readonly kind: 'run' | 'prepared-question' | 'report' | 'inventory' | 'final-map' | 'citation'
    | 'source' | 'judgment' | 'disposition'
  readonly json: string
  readonly sha256: string
}
/** Exact owner-readable input snapshot used by the local status calculation. */
export interface ResearchFinalBasis {
  readonly runId: ResearchRunId
  readonly revision: number
  readonly questionSha256: string
  readonly criticalClosure: readonly ResearchClaimId[]
  readonly requiredFacts: number
  readonly supportedFacts: number
  readonly evidence: readonly ResearchFinalEvidence[]
}
/** Recomputed current state; zero facts never produce an invented percentage or factual truth guarantee. */
export interface ResearchFinalStatus {
  readonly state: ResearchFinalState
  readonly issues: readonly ResearchFinalIssue[]
  readonly limitations: readonly string[]
  readonly basis: ResearchFinalBasis
  /** Digest of the entire state, issues, limitations and basis, excluding observation time. */
  readonly sha256: string
}
/** Immutable historical result plus a separately recomputed applicability flag. */
export interface ResearchFinalDecision {
  readonly decisionId: ResearchFinalDecisionId
  readonly seq: number
  readonly recordedAt: string
  readonly attribution: ResearchJudgmentAttribution
  readonly status: ResearchFinalStatus
  readonly isCurrent: boolean
}
