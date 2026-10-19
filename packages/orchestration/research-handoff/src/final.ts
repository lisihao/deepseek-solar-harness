/** Exact report mappings and separate Host confirmation; neither certifies factual truth. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchArtifactId } from './artifact.ts'
import type { ResearchClaimId, ResearchJudgmentAttribution } from './claims.ts'
import type { ResearchCitationId } from './citation.ts'
import type { ResearchDispositionId } from './disposition.ts'

/** Immutable owner-scoped final mapping identity. */
export type ResearchFinalMapId = Branded<'ResearchFinalMapId'>
/** Exact nonempty UTF-8 byte range in the retained final report. */
export interface ResearchFinalLocation {
  readonly byteStart: number
  readonly byteEnd: number
  readonly text: string
}
/** Complete immutable report identity, distinct from a URL or capture claim. */
export interface ResearchFinalReportRef {
  readonly artifactId: ResearchArtifactId
  readonly version: number
  readonly sha256: string
}
/** Attributed mapping for one current candidate; the Host reviews the meaning of its classification. */
export interface ResearchFinalItem {
  readonly claimId: ResearchClaimId
  readonly claimTextSha256: string
  readonly kind: 'adopted-fact' | 'inference' | 'recommendation' | 'hypothesis'
  readonly location: ResearchFinalLocation
  readonly citationIds: readonly ResearchCitationId[]
  readonly dependencies: readonly ResearchClaimId[]
  readonly limitations: readonly string[]
  readonly applicability: string
  readonly sourceAssessment: string
  readonly hypothesis: string | null
  /** Listed evidence and questions only; this does not establish an actual exhaustive search. */
  readonly counterCheck: {
    readonly scope: string
    readonly questions: readonly string[]
    readonly citationIds: readonly ResearchCitationId[]
    readonly unfinished: readonly string[]
  }
}
/** Historical critical corrections remain visible even when no replacement candidate exists. */
export interface ResearchRetiredFinalItem {
  readonly inventoryVersion: number
  readonly claimId: ResearchClaimId
  readonly claimTextSha256: string
  readonly changeVersion: number
  readonly kind: 'corrected' | 'removed'
  readonly replacementIds: readonly ResearchClaimId[]
  readonly reason: string
  readonly location: ResearchFinalLocation | null
  readonly dispositionIds: readonly ResearchDispositionId[]
}
/** Imported mapping cannot supply its own Host confirmation, coverage or completion result. */
export interface ResearchFinalMapInput {
  readonly finalMapId: ResearchFinalMapId
  readonly expectedPreviousFinalMapId: ResearchFinalMapId | null
  readonly revision: number
  readonly questionSha256: string
  readonly inventoryVersion: number
  readonly inventorySha256: string
  readonly geminiReport: ResearchFinalReportRef
  readonly chatgptReport: ResearchFinalReportRef
  readonly finalText: string
  readonly items: readonly ResearchFinalItem[]
  readonly retired: readonly ResearchRetiredFinalItem[]
  readonly zeroCriticalFactsReason: string | null
  readonly by: 'model' | 'human'
}
/** Current confirmation is recomputed against the latest map, reports, inventory and run revision. */
export interface ResearchFinalMap {
  readonly seq: number
  readonly input: ResearchFinalMapInput
  readonly sha256: string
  readonly attribution: ResearchJudgmentAttribution
  readonly recordedAt: string
  readonly isCurrent: boolean
  readonly recordedConfirmation: boolean
  readonly confirmed: boolean
}
