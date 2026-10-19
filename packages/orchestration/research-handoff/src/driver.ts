/** Explicit website transport seam; unknown normal-interface capabilities remain unavailable. */
import type { ResearchAcceptedResource, ResearchActionObservation, ResearchActionRequest, ResearchActionTarget,
  ResearchActionId, ResearchRunId, ResearchDriverId, ResearchDriverSelection } from './action.ts'
import type { ResearchDriverDelivery } from './delivery.ts'

/** Exact immutable action presented for readonly qualification or execution. */
export interface ResearchDriverRequest {
  readonly request: ResearchActionRequest
  readonly requestSha256: string
  readonly acceptedResource: ResearchAcceptedResource | null
}

/** Actual effort-control observation, independent of requested effort. */
export type ResearchObservedEffort =
  | { readonly kind: 'observed'; readonly value: string }
  | { readonly kind: 'not_observed' }
  | { readonly kind: 'not-applicable' }

/** Readonly normal-interface observations, never inferred from website or model names alone. */
export type ResearchDriverQualification =
  | { readonly status: 'unsupported' | 'not_observed'; readonly reason: string }
  | {
    readonly status: 'available'
    readonly requestSha256: string
    readonly target: ResearchActionTarget
    readonly selection: ResearchDriverSelection
    readonly effort: ResearchObservedEffort
    readonly inputMaxBytes: number
    readonly evidence: string
  }

/** First actual qualification result retained for one original action, without renewing execution authority. */
export interface ResearchQualificationRecord {
  readonly runId: ResearchRunId
  readonly actionId: ResearchActionId
  readonly requestSha256: string
  readonly recordedAt: string
  readonly observation: ResearchDriverQualification
  readonly sha256: string
}

/** Qualified receipt for the original immutable action and target. */
export interface ResearchDriverReceipt extends ResearchActionObservation {
  /** Optional actual message/text-attachment observation; absence proves neither receipt nor non-receipt. */
  readonly delivery?: ResearchDriverDelivery
  readonly requestSha256: string
  readonly target: ResearchActionTarget
}

/** Absence of new evidence does not undo previously recorded acceptance. */
export type ResearchDriverObservation = ResearchDriverReceipt
  | { readonly state: 'unknown'; readonly requestSha256: string; readonly target: ResearchActionTarget; readonly receipt: string | null }

/** Explicitly registered platform Driver; no automatic fallback or implicit research-mode support. */
export interface ResearchPlatformDriver {
  readonly id: ResearchDriverId
  readonly platform: 'gemini' | 'chatgpt'
  /**
   * Observe the existing interface without submitting, opening a replacement task, or changing settings.
   * @param input - Exact action and digest.
   * @param signal - Local operation cancellation; not remote cancellation proof.
   * @returns Actual selected mode/tools and input capacity, or explicit unavailability.
   */
  qualify(input: ResearchDriverRequest, signal: AbortSignal): Promise<ResearchDriverQualification>
  /**
   * Submit this original action once; ambiguous effects throw and remain durably unknown.
   * @param input - Exact already-recorded action and digest.
   * @param signal - Local cancellation; it must not be interpreted as proof of non-submission.
   * @param beforeSubmit - Recheck current Host and exact Driver registration after internal awaits, immediately before submission.
   * @returns Original-target acceptance or terminal evidence; late acceptance must be retained after local revocation.
   */
  execute(input: ResearchDriverRequest, signal: AbortSignal, beforeSubmit: () => void): Promise<ResearchDriverReceipt>
  /**
   * Observe only the original task, without creating a new page, conversation or submission.
   * @param input - Original immutable action, digest and previously bound accepted resource; never substitute a new conversation.
   * @param signal - Local observation cancellation.
   * @returns Original-target evidence, or unknown without replay.
   */
  observe(input: ResearchDriverRequest, signal: AbortSignal): Promise<ResearchDriverObservation>
}
