/** Explicit attributed treatment of counterevidence; never an imported completion flag. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchCitationId } from './citation.ts'
import type { ResearchFinalMapId } from './final.ts'
import type { ResearchClaimId, ResearchJudgmentId, ResearchJudgmentAttribution } from './claims.ts'

/** Append-only counterevidence treatment identity. */
export type ResearchDispositionId = Branded<'ResearchDispositionId'>

/** Exact original counterevidence identity and historical claim text. */
export type ResearchCounterTarget = {
  readonly inventoryVersion: number
  readonly claimId: ResearchClaimId
  readonly claimTextSha256: string
  /** SHA-256 of JSON.stringify on the complete normalized retained target record, including attribution. */
  readonly recordSha256: string
} & (
  | { readonly kind: 'citation'; readonly id: ResearchCitationId }
  | { readonly kind: 'claim-judgment'; readonly id: ResearchJudgmentId }
)

/** Imported disposition data; the current Host supplies actual input-channel attribution separately. */
export interface ResearchDispositionInput {
  readonly dispositionId: ResearchDispositionId
  readonly target: ResearchCounterTarget
  readonly expectedPreviousDispositionId: ResearchDispositionId | null
  readonly outcome: 'explained' | 'corrected-in-final' | 'retained-unresolved'
  readonly by: 'model' | 'human'
  readonly rationale: string
  readonly evidenceCitationIds: readonly ResearchCitationId[]
  /** Explicit withdrawal evidence; null uses Citation evidence and never falls back from a stale map. */
  readonly finalCorrection: { readonly finalMapId: ResearchFinalMapId; readonly mapSha256: string } | null
}

/** Immutable historical treatment; the latest exact target record may still be unresolved. */
export interface ResearchDisposition {
  readonly seq: number
  readonly input: ResearchDispositionInput
  readonly attribution: ResearchJudgmentAttribution
  readonly recordedAt: string
  readonly sha256: string
}
