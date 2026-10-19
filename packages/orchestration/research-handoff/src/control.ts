/** Current trusted embedding Host access; imported or durable data cannot recreate these callable controls. */
import type {
  ResearchActionId, ResearchActionRequest, ResearchActionRun, ResearchActionSnapshot, ResearchActionTarget,
  ResearchConfirmationBinding, ResearchDriverId, ResearchDriverSelection, ResearchObservationRecord, ResearchOwnerId, ResearchRunId,
} from './action.ts'
import type { ResearchArtifactId, ResearchArtifactInput, ResearchArtifactSnapshot, ResearchTextHandoff } from './artifact.ts'
import type { ResearchClaimInventory, ResearchClaimJudgment, ResearchJudgmentAttribution } from './claims.ts'
import type { ResearchQualificationRecord } from './driver.ts'
import type { ResearchDeliveryRecord } from './delivery.ts'
import type { ResearchWorkflowDefinition, ResearchWorkflowId, ResearchWorkflowOutput, ResearchWorkflowCollector,
  ResearchWorkflowPreview, ResearchWorkflowPreviewInput, ResearchWorkflowPreviewId, ResearchWorkflowStage, ResearchWorkflowStageEvidence,
  ResearchWorkflowDeliveryDisposition, ResearchWorkflowDeliveryDispositionId, ResearchWorkflowState } from './workflow.ts'
import type { ResearchPreparedPrompt, ResearchPromptInputId, ResearchPromptPreparation } from './prompt.ts'
import type { ResearchSourceReadRequest, ResearchSourceReadId, ResearchSourceReadSnapshot } from './source.ts'
import type { ResearchCitationId, ResearchCitationAssessment } from './citation.ts'
import type { ResearchCounterTarget, ResearchDispositionId, ResearchDisposition } from './disposition.ts'
import type { ResearchFinalMapId, ResearchFinalMap } from './final.ts'
import type { ResearchFinalStatus, ResearchFinalDecision, ResearchFinalDecisionId } from './final-status.ts'

/** Explicit current-Host execution bounds; the Host supplies these independently of model/file policy. */
export interface ResearchHostPolicy {
  readonly version: string
  readonly judgmentChannel: ResearchJudgmentAttribution['channel']
  readonly ownerId: ResearchOwnerId
  readonly workspace: string
  readonly sourceConfigurationSha256s: readonly string[]
  readonly destinations: readonly { readonly bindingSha256: string; readonly target: ResearchActionTarget }[]
  readonly drivers: readonly {
    readonly id: ResearchDriverId
    readonly platform: 'gemini' | 'chatgpt'
    readonly selection: ResearchDriverSelection
  }[]
  readonly inputMaxBytes: number
}

/** Trusted current-process lifecycle check; durable data cannot recreate this callable association. */
export interface ResearchHostScope {
  /** Recheck the exact live embedding owner before any scoped access or external guard. @returns No value. */
  assertCurrent(): void
}

/** Synchronous current-process check of the exact request; never reconstructed from durable or model data.
 * @param request - Detached copy of the actual immutable request; mutations cannot change submission.
 * @returns No value; throwing prevents new submission or advancement, without erasing accepted facts.
 */
export type ResearchSubmissionGuard = (request: ResearchActionRequest) => void

/** Scoped callable access minted only by a live embedding Host registration. */
export interface ResearchHostControl {
  /** @param runId - Owned canonical run. @returns Complete current standard flow from one SQLite snapshot. */
  readWorkflowState(runId: ResearchRunId): ResearchWorkflowState
  /** @param runId - Owned run. @param kind - Explicit fixed stage. @param previewId - Explicit immutable preview identity.
   * @returns Original-template/material preview; changed binding revises the run without confirming or executing. */
  previewWorkflowStage(runId: ResearchRunId, kind: ResearchWorkflowStage['kind'], previewId: ResearchWorkflowPreviewId): ResearchWorkflowPreview
  /** @param runId - Owned canonical run. @param kind - Original stage.
   * @returns Complete original action, material and delivery evidence with separate blockers. */
  readWorkflowStage(runId: ResearchRunId, kind: ResearchWorkflowStage['kind']): ResearchWorkflowStageEvidence
  /** @param runId - Owned run. @param input - Exact negatives, later full same-item match and human reason.
   * @param assertHuman - Current trusted user entry check, never imported authority.
   * @returns Immutable treatment of the original evidence. */
  appendWorkflowDeliveryDisposition(runId: ResearchRunId, input: unknown, assertHuman: () => void): ResearchWorkflowDeliveryDisposition
  /** @param runId - Owned run. @param id - Original treatment. @returns Full immutable historical basis. */
  readWorkflowDeliveryDisposition(runId: ResearchRunId, id: ResearchWorkflowDeliveryDispositionId): ResearchWorkflowDeliveryDisposition
  readonly ownerId: ResearchOwnerId
  /**
   * @param runId - Owned run, with one canonical workflow and Session.
   * @param input - Full immutable initial definition; no imported execution authority.
   * @returns Exact existing or new canonical definition; conflicting starts fail.
   */
  claimWorkflowDefinition(runId: ResearchRunId, input: unknown): ResearchWorkflowDefinition
  /**
   * @param runId - Owned run.
   * @returns Original canonical definition or null; no new stage identities are minted.
   */
  readWorkflowDefinition(runId: ResearchRunId): ResearchWorkflowDefinition | null
  /** @param runId - Owned canonical run. @param input - Complete proposed input and original materials.
   * @returns Full immutable preview without allocating the fixed prepared or action identity. */
  previewWorkflowAction(runId: ResearchRunId, input: ResearchWorkflowPreviewInput): ResearchWorkflowPreview
  /** @param runId - Owned run. @param id - Exact original preview. @returns Full data and current confirmation projection. */
  readWorkflowPreview(runId: ResearchRunId, id: ResearchWorkflowPreviewId): ResearchWorkflowPreview
  /** @param runId - Owned run. @param id - Exact preview. @param sha256 - Reviewed full preview digest.
   * @param assertHuman - Current trusted actual-user entry check, never restored from JSON.
   * @returns Separate confirmation after the current run has been confirmed. */
  confirmWorkflowPreview(runId: ResearchRunId, id: ResearchWorkflowPreviewId, sha256: string,
    assertHuman: () => void): ResearchWorkflowPreview
  /** @param runId - Owned run. @param id - Exact confirmed preview. @param sha256 - Reviewed full preview digest.
   * @returns Fixed request after atomic template preparation; this does not admit or authorize external submission. */
  freezeWorkflowPreview(runId: ResearchRunId, id: ResearchWorkflowPreviewId, sha256: string): ResearchActionRequest
  /**
   * Admit a read of an already accepted original resource; retain late material from this held call after revocation.
   * @param runId - Owned canonical run.
   * @param workflowId - Original canonical workflow.
   * @param actionId - Completed original stage.
   * @param collector - Trusted Host's explicit read-only adapter, never supplied by JSON.
   * @param signal - Local cancellation; no new operation or remote cancellation is inferred.
   * @returns Immutable observation and artifact, appended atomically in the existing database.
   */
  captureWorkflowOutput(runId: ResearchRunId, workflowId: ResearchWorkflowId, actionId: ResearchActionId,
    collector: ResearchWorkflowCollector, signal?: AbortSignal): Promise<ResearchWorkflowOutput>
  /**
   * @param runId - Owned run.
   * @param workflowId - Original canonical workflow.
   * @returns Complete observation/artifact history; earlier partial captures are retained.
   */
  readWorkflowOutputs(runId: ResearchRunId, workflowId: ResearchWorkflowId): ResearchWorkflowOutput[]
  /**
   * @param runId - Owned run.
   * @param actionId - Original action.
   * @returns Full delivery history; an empty list proves neither remote receipt nor non-receipt.
   */
  readDeliveryRecords(runId: ResearchRunId, actionId: ResearchActionId): ResearchDeliveryRecord[]
  /**
   * @param runId - Owned run.
   * @returns Current process completeness recomputed from one database snapshot, never a factual accuracy score.
   */
  readFinalStatus(runId: ResearchRunId): ResearchFinalStatus
  /**
   * @param runId - Owned run.
   * @param decisionId - Immutable identity; the Host computes state and evidence rather than accepting supplied flags.
   * @returns Original computed decision and separately recomputed current applicability.
   */
  recordFinalDecision(runId: ResearchRunId, decisionId: ResearchFinalDecisionId): ResearchFinalDecision
  /**
   * @param runId - Owned run.
   * @param decisionId - Original immutable decision.
   * @returns Complete historical basis and separately recomputed current applicability.
   */
  readFinalDecision(runId: ResearchRunId, decisionId: ResearchFinalDecisionId): ResearchFinalDecision
  /**
   * @param runId - Owned run.
   * @param input - Full report mapping; imported confirmation and completion fields are excluded.
   * @returns Immutable mapping stamped with the current Host channel.
   */
  appendFinalMap(runId: ResearchRunId, input: unknown): ResearchFinalMap
  /**
   * @param runId - Owned run.
   * @param mapId - Original mapping identity.
   * @returns Historical mapping with current validity recomputed.
   */
  readFinalMap(runId: ResearchRunId, mapId: ResearchFinalMapId): ResearchFinalMap
  /**
   * @param runId - Owned run.
   * @param mapId - Current exact mapping.
   * @param sha256 - Reviewed mapping digest.
   * @returns Separate Host confirmation, without declaring research completion.
   */
  confirmFinalMap(runId: ResearchRunId, mapId: ResearchFinalMapId, sha256: string): ResearchFinalMap
  /**
   * @param runId - Owned run.
   * @param input - Exact original counterevidence treatment; no imported completion control.
   * @returns Appended treatment stamped with this Host channel.
   */
  appendCounterDisposition(runId: ResearchRunId, input: unknown): ResearchDisposition
  /**
   * @param runId - Owned run.
   * @param dispositionId - Immutable treatment.
   * @returns Exact historical treatment and evidence, without declaring current completion.
   */
  readCounterDisposition(runId: ResearchRunId, dispositionId: ResearchDispositionId): ResearchDisposition
  /**
   * @param runId - Owned run.
   * @param target - Exact original counterevidence.
   * @returns All treatment history including unresolved and reopened records.
   */
  readCounterDispositions(runId: ResearchRunId, target: ResearchCounterTarget): ResearchDisposition[]
  /**
   * @param runId - Owned run.
   * @param input - Imported interpretation with exact retained-source quote; not a completion control.
   * @returns Immutable assessment stamped with this Host input channel.
   */
  appendCitationAssessment(runId: ResearchRunId, input: unknown): ResearchCitationAssessment
  /**
   * @param runId - Owned run.
   * @param citationId - Historical assessment.
   * @returns Original interpretation and evidence association, without current verification claims.
   */
  readCitationAssessment(runId: ResearchRunId, citationId: ResearchCitationId): ResearchCitationAssessment
  /**
   * @param runId - Owned run.
   * @param inventoryVersion - Historical inventory.
   * @returns All original and responding judgments in sequence order; none silently replaces earlier counterevidence.
   */
  readCitationAssessments(runId: ResearchRunId, inventoryVersion: number): ResearchCitationAssessment[]
  /**
   * @param request - Complete immutable source operation.
   * @param signal - Local cancellation; uncertainty never authorizes replay.
   * @returns Recorded original source state.
   */
  readSource(request: ResearchSourceReadRequest, signal?: AbortSignal): Promise<ResearchSourceReadSnapshot>
  /**
   * @param runId - Owned run.
   * @param readId - Original source operation.
   * @returns Retained bytes and observations after owner authorization.
   */
  readSourceRecord(runId: ResearchRunId, readId: ResearchSourceReadId): ResearchSourceReadSnapshot
  /**
   * @param runId - Owned run.
   * @param readId - Original source operation.
   * @param signal - Local cancellation.
   * @returns Original-resource observation; missing resources remain unknown without a new visit.
   */
  observeSourceRead(runId: ResearchRunId, readId: ResearchSourceReadId, signal?: AbortSignal): Promise<ResearchSourceReadSnapshot>
  /**
   * @param driverId - Explicit allowed Driver.
   * @returns Digest of the Host-selected model, mode, effort and tools.
   */
  modeFingerprint(driverId: ResearchDriverId): string
  /**
   * @param runId - New run.
   * @param binding - Exact observed scope.
   * @returns Unconfirmed run data.
   */
  create(runId: ResearchRunId, binding: ResearchConfirmationBinding): ResearchActionRun
  /**
   * @param runId - Owned run.
   * @returns Current run data without granting execution authority.
   */
  inspect(runId: ResearchRunId): ResearchActionRun
  /**
   * @param runId - Owned run.
   * @param revision - Expected revision.
   * @param binding - New observations.
   * @returns Unconfirmed revision.
   */
  revise(runId: ResearchRunId, revision: number, binding: ResearchConfirmationBinding): ResearchActionRun
  /**
   * @param runId - Owned run.
   * @param revision - Reviewed revision.
   * @param sha256 - Reviewed binding.
   * @returns Confirmation data.
   */
  confirm(runId: ResearchRunId, revision: number, sha256: string): ResearchActionRun
  /**
   * @param request - Complete immutable action.
   * @param signal - Local cancellation.
   * @param guard - Optional trusted synchronous request check before admission, qualification and physical I/O, and after fact retention.
   * @returns Recorded action; unknown is never replayed and late acceptance survives a failing guard.
   */
  execute(request: ResearchActionRequest, signal?: AbortSignal, guard?: ResearchSubmissionGuard): Promise<ResearchActionSnapshot>
  /**
   * @param runId - Owned current run.
   * @param input - Every original-template slot and owner-readable immutable artifact.
   * @returns Full retained template, values and rendered bytes; no external operation occurs.
   */
  preparePrompt(runId: ResearchRunId, input: ResearchPromptPreparation): ResearchPreparedPrompt
  /**
   * @param runId - Owned run.
   * @param inputId - Immutable prepared input.
   * @returns Complete retained input, without renewing confirmation or proving delivery.
   */
  readPreparedPrompt(runId: ResearchRunId, inputId: ResearchPromptInputId): ResearchPreparedPrompt
  /**
   * @param runId - Owned run.
   * @param actionId - Original action.
   * @returns Original retained action.
   */
  readAction(runId: ResearchRunId, actionId: ResearchActionId): ResearchActionSnapshot
  /**
   * Read retained actual qualification independently of action state; absence remains null.
   * @param runId - Owned run.
   * @param actionId - Original action.
   * @returns First observed qualification or null; this never authorizes another submission.
   */
  readQualification(runId: ResearchRunId, actionId: ResearchActionId): ResearchQualificationRecord | null
  /**
   * @param runId - Owned run.
   * @param actionId - Original action.
   * @param signal - Local cancellation.
   * @returns Original-target observation.
   */
  observe(runId: ResearchRunId, actionId: ResearchActionId, signal?: AbortSignal): Promise<ResearchActionSnapshot>
  /**
   * @param runId - Owned run.
   * @param input - Exact capture.
   * @returns Immutable retained artifact.
   */
  captureArtifact(runId: ResearchRunId, input: ResearchArtifactInput): ResearchArtifactSnapshot
  /**
   * @param runId - Owned run.
   * @param artifactId - Retained artifact.
   * @returns All bytes after owner authorization.
   */
  readArtifact(runId: ResearchRunId, artifactId: ResearchArtifactId): ResearchArtifactSnapshot
  /**
   * @param runId - Owned run.
   * @param artifactId - Immutable artifact.
   * @param maxChunkBytes - Explicit segment budget.
   * @returns Full local handoff.
   */
  splitArtifact(runId: ResearchRunId, artifactId: ResearchArtifactId, maxChunkBytes: number): ResearchTextHandoff
  /**
   * @param runId - Owned run.
   * @param input - Imported candidate data.
   * @returns New unconfirmed inventory.
   */
  appendClaimInventory(runId: ResearchRunId, input: unknown): ResearchClaimInventory
  /**
   * @param runId - Owned run.
   * @param version - Pinned candidate version.
   * @returns Retained candidates and confirmation data.
   */
  readClaimInventory(runId: ResearchRunId, version: number): ResearchClaimInventory
  /**
   * @param runId - Owned run.
   * @param version - Reviewed current version.
   * @param sha256 - Exact reviewed digest.
   * @returns Confirmed denominator data.
   */
  confirmClaimInventory(runId: ResearchRunId, version: number, sha256: string): ResearchClaimInventory
  /**
   * @param runId - Owned run.
   * @param input - Imported judgment data; its by field is a claim, not trusted channel attribution.
   * @returns Retained interpretation stamped with this Host policy's input channel; not source-read proof.
   */
  appendClaimJudgment(runId: ResearchRunId, input: unknown): ResearchClaimJudgment
  /**
   * @param runId - Owned run.
   * @param version - Pinned inventory.
   * @param afterSeq - Exclusive position.
   * @param limit - Page size.
   * @returns Judgments.
   */
  readClaimJudgments(runId: ResearchRunId, version: number, afterSeq: number, limit: number): ResearchClaimJudgment[]
  /**
   * @param runId - Owned run.
   * @param afterSeq - Exclusive position.
   * @param limit - Page size.
   * @returns Stable action observations.
   */
  readObservations(runId: ResearchRunId, afterSeq: number, limit: number): ResearchObservationRecord[]
}

/** Host lifecycle registration; disposal revokes fresh external operations, not remote work already accepted. */
export interface ResearchHostRegistration {
  readonly control: ResearchHostControl
  /** Revoke the current in-process access without asserting remote cancellation. @returns Owned effect disposal. */
  dispose(): Promise<void>
}

/** Current Host or Driver admission refusal before an external action. */
export class ResearchControlError extends Error {
  constructor(message: string, readonly code: 'HOST_REVOKED' | 'POLICY' | 'DRIVER_UNSUPPORTED' | 'DRIVER_NOT_OBSERVED' | 'INPUT_LIMIT') {
    super(message)
    this.name = 'ResearchControlError'
  }
}
