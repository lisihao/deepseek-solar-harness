/** Shared versioned claim candidates and attributed judgments. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchArtifactId } from './artifact.ts'
import type { ResearchOwnerId } from './action.ts'

/** Stable candidate identity retained in derivation records. */
export type ResearchClaimId = Branded<'ResearchClaimId'>
/** Immutable attributed judgment identity, distinct from a source-read observation. */
export type ResearchJudgmentId = Branded<'ResearchJudgmentId'>

/** Exact original material association; it does not establish that a source supports the claim. */
export interface ResearchClaimOrigin {
  readonly kind: 'question' | 'gemini-report' | 'chatgpt-addition'
  readonly artifactId: ResearchArtifactId | null
  readonly sha256: string
}

/** One candidate proposition, retaining the selected criticality and material provenance. */
export interface ResearchClaim {
  readonly id: ResearchClaimId
  readonly text: string
  readonly critical: boolean
  readonly origins: readonly ResearchClaimOrigin[]
}

/** Explicit lineage for changes that could otherwise hide an unverified critical claim. */
export interface ResearchClaimChange {
  readonly kind: 'add' | 'remove' | 'revise' | 'split' | 'merge' | 'downgrade'
  readonly from: readonly ResearchClaimId[]
  readonly to: readonly ResearchClaimId[]
  readonly reason: string
}

/** Immutable material versions from which the candidate inventory was assembled. */
export interface ResearchInventoryMaterial {
  readonly artifactId: ResearchArtifactId
  readonly sha256: string
}

/** Imported candidate data cannot supply its own completeness confirmation or execution authority. */
export interface ResearchClaimInventoryInput {
  readonly expectedVersion: number
  readonly questionSha256: string
  readonly materials: readonly ResearchInventoryMaterial[]
  readonly claims: readonly ResearchClaim[]
  readonly changes: readonly ResearchClaimChange[]
}

/** Historical candidate inventory and its current, exact-version completeness confirmation data. */
export interface ResearchClaimInventory {
  readonly version: number
  readonly runRevision: number
  readonly input: ResearchClaimInventoryInput
  readonly sha256: string
  readonly isCurrent: boolean
  readonly recordedConfirmation: boolean
  readonly denominatorConfirmed: boolean
}

/** Attributed interpretation of materials; supported is a judgment, never actual browser-read proof. */
export interface ResearchClaimJudgmentInput {
  readonly judgmentId: ResearchJudgmentId
  readonly inventoryVersion: number
  readonly claimId: ResearchClaimId
  readonly by: 'model' | 'human'
  readonly status: 'supported' | 'contradicted' | 'unverifiable'
  readonly rationale: string
  readonly materialArtifactIds: readonly ResearchArtifactId[]
}

/** Actual input channel asserted by the current embedding Host; imported JSON cannot supply it. */
export interface ResearchJudgmentAttribution {
  readonly channel: 'imported' | 'model' | 'human'
  readonly ownerId: ResearchOwnerId
  readonly hostPolicyVersion: string
}

/** Stable append-only judgment identity for later Session/UI projection. */
export interface ResearchClaimJudgment extends ResearchClaimJudgmentInput {
  readonly seq: number
  readonly attribution: ResearchJudgmentAttribution
}
