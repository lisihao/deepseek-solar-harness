/** Canonical standard research identity; stored definitions never restore Host access. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ResearchActionId, ResearchActionRequest, ResearchActionTarget, ResearchDriverId,
  ResearchDriverSelection, ResearchStepId, ResearchRunId, ResearchAcceptedResource, ResearchActionSnapshot } from './action.ts'
import type { ResearchArtifactSnapshot, ResearchCaptureSource } from './artifact.ts'
import type { ResearchPromptInputId } from './prompt.ts'

/** Single standard workflow identity within one owned run. */
export type ResearchWorkflowId = Branded<'ResearchWorkflowId'>
/** Immutable original-resource capture observation identity. */
export type ResearchWorkflowObservationId = Branded<'ResearchWorkflowObservationId'>

/** Explicit platform selection retained before any standard action. */
export interface ResearchWorkflowPlatform {
  readonly driverId: ResearchDriverId
  readonly selection: ResearchDriverSelection
  readonly target: ResearchActionTarget
  readonly destinationSha256: string
}

/** Fixed business stage identities; repeated UI starts cannot mint replacement actions. */
export interface ResearchWorkflowStage {
  readonly kind: ResearchActionRequest['kind']
  readonly actionId: ResearchActionId
  readonly stepId: ResearchStepId
  readonly preparedPromptId: ResearchPromptInputId | null
}

/** Complete immutable initial configuration, bound to one canonical Session per run. */
export interface ResearchWorkflowDefinitionInput {
  readonly workflowId: ResearchWorkflowId
  readonly sessionId: string
  readonly question: string
  readonly sourcesSha256: string
  readonly gemini: ResearchWorkflowPlatform
  readonly chatgpt: ResearchWorkflowPlatform
  readonly templateVersions: { readonly gemini: string; readonly chatgpt: string }
  readonly values: { readonly gemini: Readonly<Record<string, readonly string[]>>
    readonly chatgpt: Readonly<Record<string, readonly string[]>> }
  readonly stages: readonly ResearchWorkflowStage[]
}

/** Owner-readable canonical definition, independent of current execution confirmation. */
export interface ResearchWorkflowDefinition {
  readonly runId: ResearchRunId
  readonly input: ResearchWorkflowDefinitionInput
  readonly sha256: string
}

/** One actual collection observation; role and artifact version are assigned by the Provider. */
export interface ResearchWorkflowOutputInput {
  readonly actionId: ResearchActionId
  readonly observationId: ResearchWorkflowObservationId
  readonly requestSha256: string
  readonly resource: ResearchAcceptedResource
  readonly source: ResearchCaptureSource
  readonly bytes: Uint8Array
}

/** Full retained observation and immutable artifact; previous partial captures remain readable. */
export interface ResearchWorkflowOutput {
  readonly workflowId: ResearchWorkflowId
  readonly observationId: ResearchWorkflowObservationId
  readonly resource: ResearchAcceptedResource
  readonly artifact: ResearchArtifactSnapshot
}

/** Original accepted operation supplied to a current Host's read-only collector. */
export interface ResearchWorkflowCollectionRequest {
  readonly runId: ResearchRunId
  readonly workflowId: ResearchWorkflowId
  readonly snapshot: ResearchActionSnapshot
}

/** Trusted same-process adapter; this interface never authorizes a new submission. */
export interface ResearchWorkflowCollector {
  /**
   * Read only the original accepted resource; call guard immediately before I/O and after internal waits.
   * @param request - Exact original operation and correlated resource.
   * @param signal - Local revocation/cancellation; not proof of remote cancellation.
   * @param guard - Current Host and same Driver registration check before each original-resource read.
   * @returns Full actual observation; partial and unavailable completeness cannot establish workflow completion.
   */
  collect(request: ResearchWorkflowCollectionRequest, signal: AbortSignal, guard: () => void): Promise<ResearchWorkflowOutputInput>
}

/** Immutable preview identity, separate from the fixed business action and prepared-input identities. */
export type ResearchWorkflowPreviewId = Branded<'ResearchWorkflowPreviewId'>

/** Explicit complete request and original materials to preview without preparing or executing an action. */
export interface ResearchWorkflowPreviewInput {
  readonly previewId: ResearchWorkflowPreviewId
  readonly workflowId: ResearchWorkflowId
  readonly request: ResearchActionRequest
  readonly prompt: import('./prompt.ts').ResearchPromptPreparation | null
  readonly artifactIds: readonly import('./artifact.ts').ResearchArtifactId[]
}

/** Full owner-readable material retained in an immutable preview. */
export interface ResearchWorkflowPreviewMaterial {
  readonly artifactId: import('./artifact.ts').ResearchArtifactId
  readonly role: ResearchArtifactSnapshot['role']
  readonly version: number
  readonly sha256: string
  readonly text: string
}

/** Immutable preview bytes; current run confirmation is deliberately excluded from this digest. */
export interface ResearchWorkflowPreviewData {
  readonly previewId: ResearchWorkflowPreviewId
  readonly workflowId: ResearchWorkflowId
  readonly definitionSha256: string
  readonly request: ResearchActionRequest
  readonly preparedPrompt: import('./prompt.ts').ResearchPreparedPrompt | null
  readonly materials: readonly ResearchWorkflowPreviewMaterial[]
  readonly prerequisites: ResearchWorkflowPrerequisites
}

/** Exact original delivery record; sequence and digest jointly identify immutable evidence. */
export interface ResearchWorkflowDeliveryRef {
  readonly seq: number
  readonly sha256: string
}

/** Immutable human treatment identity within the original owned run. */
export type ResearchWorkflowDeliveryDispositionId = Branded<'ResearchWorkflowDeliveryDispositionId'>

/** Explicit treatment of every retained mismatch using a later full match of the same external item. */
export interface ResearchWorkflowDeliveryDispositionInput {
  readonly dispositionId: ResearchWorkflowDeliveryDispositionId
  readonly actionId: ResearchActionId
  readonly expectedPreviousId: ResearchWorkflowDeliveryDispositionId | null
  readonly negative: readonly ResearchWorkflowDeliveryRef[]
  readonly correction: ResearchWorkflowDeliveryRef
  readonly reason: string
}

/** Complete collected material, retaining original observation, resource and exact UTF-8 text. */
export interface ResearchWorkflowMaterial {
  readonly observationId: ResearchWorkflowObservationId
  readonly resource: ResearchAcceptedResource
  readonly artifact: Omit<ResearchArtifactSnapshot, 'bytes'> & { readonly text: string }
}

/** Immutable historical treatment; current applicability is recomputed separately. */
export interface ResearchWorkflowDeliveryDisposition {
  readonly input: ResearchWorkflowDeliveryDispositionInput
  readonly workflowId: ResearchWorkflowId
  readonly definitionSha256: string
  readonly action: ResearchActionSnapshot
  readonly material: ResearchWorkflowMaterial | null
  readonly history: readonly import('./delivery.ts').ResearchDeliveryRecord[]
  readonly attribution: import('./claims.ts').ResearchJudgmentAttribution
  readonly recordedAt: string
  readonly sha256: string
}

/** Actual stage evidence; completion, full delivery and original-material linkage remain separate facts. */
export interface ResearchWorkflowStageEvidence {
  readonly kind: ResearchWorkflowStage['kind']
  readonly action: ResearchActionSnapshot | null
  readonly preparedPrompt: import('./prompt.ts').ResearchPreparedPrompt | null
  readonly material: ResearchWorkflowMaterial | null
  readonly output: ResearchWorkflowMaterial | null
  readonly history: readonly import('./delivery.ts').ResearchDeliveryRecord[]
  readonly disposition: ResearchWorkflowDeliveryDisposition | null
  readonly deliveryVerified: boolean
  readonly blockers: readonly string[]
}

/** Frozen previous-stage evidence and its stable currentness key; the proposed stage's own delivery is excluded. */
export interface ResearchWorkflowPrerequisites {
  readonly workflowId: ResearchWorkflowId
  readonly definitionSha256: string
  readonly kind: ResearchWorkflowStage['kind']
  readonly stages: readonly ResearchWorkflowStageEvidence[]
  readonly ready: boolean
  readonly key: string
}

/** Current projection over immutable preview data and separately retained trusted confirmation. */
export interface ResearchWorkflowPreview {
  readonly input: ResearchWorkflowPreviewData
  readonly sha256: string
  readonly isCurrent: boolean
  readonly confirmed: boolean
  readonly confirmation: { readonly attribution: import('./claims.ts').ResearchJudgmentAttribution
    readonly confirmedAt: string
    readonly previewSha256: string } | null
}

/** Full current standard flow, computed with the original owner's single SQLite read snapshot. */
export interface ResearchWorkflowState {
  readonly ownerId: import('./action.ts').ResearchOwnerId
  readonly run: import('./action.ts').ResearchActionRun
  readonly definition: ResearchWorkflowDefinition
  readonly stages: readonly ResearchWorkflowStageEvidence[]
  readonly outputs: readonly ResearchWorkflowMaterial[]
  readonly previews: readonly ResearchWorkflowPreview[]
  readonly finalStatus: import('./final-status.ts').ResearchFinalStatus
  readonly fullInputVerified: boolean
  readonly readyForVerification: boolean
  readonly state: import('./final-status.ts').ResearchFinalState
}
