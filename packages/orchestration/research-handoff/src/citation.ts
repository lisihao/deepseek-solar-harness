/** Attributed exact-source quotations, distinct from factual verification and completion controls. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchClaimId, ResearchJudgmentAttribution } from './claims.ts'
import type { ResearchSourceReadId } from './source.ts'

/** Immutable semantic assessment identity. */
export type ResearchCitationId = Branded<'ResearchCitationId'>

/** Imported interpretation; no supplied confirmation, attribution or completion field grants authority. */
export interface ResearchCitationAssessmentInput {
  readonly citationId: ResearchCitationId
  readonly inventoryVersion: number
  readonly inventorySha256: string
  readonly claimId: ResearchClaimId
  readonly claimTextSha256: string
  readonly sourceReadId: ResearchSourceReadId
  /** SHA-256 of JSON.stringify on the normalized retained source observation. */
  readonly observationSha256: string
  readonly quote: { readonly byteStart: number; readonly byteEnd: number; readonly text: string }
  readonly by: 'model' | 'human'
  readonly relation: 'supported' | 'partial' | 'contradicted' | 'unrelated' | 'unverifiable'
  readonly rationale: string
  readonly respondsTo: readonly ResearchCitationId[]
  /** Attributed source-family judgment; different URLs do not establish independence. */
  readonly dependency: {
    readonly status: 'independent' | 'dependent' | 'unknown'
    readonly family: string | null
    readonly basis: string
  }
  /** A primary-record designation is an attributed judgment, not independent authority certification. */
  readonly authority: { readonly kind: 'primary-record' | 'ordinary' | 'unknown'; readonly basis: string }
}

/** Append-only interpretation retaining the actual Host channel independently of its declared by field. */
export interface ResearchCitationAssessment {
  readonly seq: number
  readonly input: ResearchCitationAssessmentInput
  readonly attribution: ResearchJudgmentAttribution
  readonly recordedAt: string
  readonly sha256: string
}
