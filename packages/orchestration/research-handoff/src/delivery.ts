/** Actual external message or single UTF-8 text-attachment observations, separate from local input retention. */
import type { ResearchRunId, ResearchActionId, ResearchAcceptedResource } from './action.ts'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque observed website message or text-attachment identity. */
export type ResearchExternalDeliveryId = Branded<'ResearchExternalDeliveryId'>

/** Full or partial observed text, or explicit absence of readable content. */
export type ResearchDeliveryReadBack =
  | { readonly kind: 'complete-text' | 'partial-text'; readonly text: string; readonly evidence: string }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** Driver-observed external identity; matching is computed by the Provider, never supplied here. */
export interface ResearchDriverDelivery {
  readonly kind: 'message' | 'attachment'
  readonly externalId: ResearchExternalDeliveryId
  readonly observedAt: string
  readonly evidence: string
  readonly readBack: ResearchDeliveryReadBack
}

/** Immutable normalized original-action delivery evidence; no field declares understanding or factual verification. */
export interface ResearchDeliveryRecord {
  readonly seq: number
  readonly runId: ResearchRunId
  readonly actionId: ResearchActionId
  readonly requestSha256: string
  readonly resource: ResearchAcceptedResource
  readonly observation: ResearchDriverDelivery
  readonly contentStatus: 'matched' | 'mismatched' | 'not-read-back'
  readonly sha256: string
  readonly recordedAt: string
}
