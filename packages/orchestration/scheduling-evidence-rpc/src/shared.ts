/** Browser-safe wire types for the scheduling evidence settings page. */
import type { SchedulingEvidenceOverview } from '@deepseek-ai/dsh-scheduling-evidence/overview'

/** Trusted Host RPC channel; each runtime plane owns its matching value constant. */
export const SCHEDULING_EVIDENCE_RPC_CHANNEL = '/scheduling-evidence'

/** Literal channel type used to check independently owned Host and Client constants. */
export type SchedulingEvidenceRpcChannel = typeof SCHEDULING_EVIDENCE_RPC_CHANNEL

/** Evidence mode the allocator is configured with, as the owner sees it. */
export type PublicEvidenceModeView = 'off' | 'shadow' | 'apply'

/** The page payload: the store overview plus the allocator's evidence mode. */
export interface SchedulingEvidencePageV1 extends SchedulingEvidenceOverview {
  /** The `model-allocation.publicEvidence` setting in force, or null when no settings service is mounted. */
  readonly publicEvidence: PublicEvidenceModeView | null
}
