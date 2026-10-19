/** Shared research action identity and durable request data. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchPromptInputId } from './prompt.ts'

/** Opaque research run identity. */
export type ResearchRunId = Branded<'ResearchRunId'>
/** Opaque action identity retained across uncertain submissions. */
export type ResearchActionId = Branded<'ResearchActionId'>
/** Stable logical step chosen by the research Provider, independently of a UI attempt ID. */
export type ResearchStepId = Branded<'ResearchStepId'>
/** Owner identity supplied by the current trusted Host, never an imported policy. */
export type ResearchOwnerId = Branded<'ResearchOwnerId'>

/** Exact registered website Driver identity. */
export type ResearchDriverId = Branded<'ResearchDriverId'>

/** Requested effort remains distinct from absence of an observable website control. */
export type ResearchRequestedEffort =
  | { readonly kind: 'required'; readonly value: string }
  | { readonly kind: 'not-requested' }
  | { readonly kind: 'not-applicable' }

/** Explicit model, mode, effort and enabled tools; no automatic downgrade. */
export interface ResearchDriverSelection {
  readonly model: string
  readonly mode: string
  readonly effort: ResearchRequestedEffort
  readonly tools: readonly string[]
}

/** Original browser workspace/page/conversation to observe after uncertainty. */
export interface ResearchActionTarget {
  readonly workspace: string
  readonly page: string
  readonly conversation: string | null
}

/** Resource identity correlated with this original action by observed acceptance evidence. */
export interface ResearchAcceptedResource {
  readonly workspace: string
  readonly page: string
  readonly conversation: string | null
  readonly report: string | null
  readonly evidence: string
}

/** Exact observations to which the trusted control confirmation applies. */
export interface ResearchConfirmationBinding {
  readonly questionSha256: string
  readonly sourcesSha256: string
  readonly modeSha256: string
  readonly destinationSha256: string
  readonly plan: { readonly version: number; readonly sha256: string } | null
}

/** Run revision and confirmation data; none of these fields restores execution authority. */
export interface ResearchActionRun {
  readonly runId: ResearchRunId
  readonly revision: number
  readonly binding: ResearchConfirmationBinding
  readonly bindingSha256: string
  readonly confirmed: boolean
}

/** Exact potentially external operation and original target to observe after uncertainty. */
export interface ResearchActionRequest {
  readonly runId: ResearchRunId
  readonly actionId: ResearchActionId
  readonly stepId: ResearchStepId
  readonly revision: number
  readonly bindingSha256: string
  readonly binding: ResearchConfirmationBinding
  readonly driverId: ResearchDriverId
  readonly selection: ResearchDriverSelection
  readonly kind: 'gemini-plan-submit' | 'gemini-research-start' | 'chatgpt-upload' | 'chatgpt-submit'
  readonly target: ResearchActionTarget
  readonly input: string
  readonly preparedPromptId: ResearchPromptInputId | null
}

/** Persisted intent remains unknown until the Driver supplies an actual observation. */
export type ResearchActionState = 'unknown' | 'accepted' | 'completed' | 'not-sent'

/** Durable action retaining the exact submitted input and target. */
export interface ResearchActionSnapshot {
  readonly request: ResearchActionRequest
  readonly inputSha256: string
  readonly state: ResearchActionState
  readonly receipt: string | null
  readonly acceptedResource: ResearchAcceptedResource | null
}

/** Actual Driver observation; local abort is not proof of remote cancellation. */
export interface ResearchActionObservation {
  readonly state: Exclude<ResearchActionState, 'unknown'>
  readonly receipt: string
  readonly acceptedResource: ResearchAcceptedResource | null
}

/** Stable append-only observation identity for rebuilding Session/UI projections. */
export interface ResearchObservationRecord extends ResearchActionObservation {
  readonly seq: number
  readonly runId: ResearchRunId
  readonly actionId: ResearchActionId
}

/** Durable format, ownership, confirmation, and action identity failure. */
export class ResearchActionError extends Error {
  constructor(message: string,
    readonly code: 'FORMAT' | 'NOT_FOUND' | 'OWNER' | 'REVISION' | 'CONFIRMATION' | 'CONFLICT' | 'PENDING') {
    super(message)
    this.name = 'ResearchActionError'
  }
}
