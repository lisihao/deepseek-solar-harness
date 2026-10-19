/** Local research Provider and durable storage; shared types belong to the Service Definition. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalResearchHandoffService } from './provider.ts'

/** Explicit private database location; no implicit account or runtime directory. */
export interface Config {
  /** Explicit private SQLite database path; unsupported stored formats are refused. */
  readonly filename: string
}

/** Validated deployment configuration for the local research Provider. */
export const Config: z<Config> = z.object({ filename: z.string().min(1).required() })

/**
 * Install the single local research execution and persistence owner.
 * @param ctx - Provider lifecycle.
 * @param config - Explicit database path.
 */
export function apply(ctx: Context, config: Config): void {
  new LocalResearchHandoffService(ctx, config.filename)
}

export { LocalResearchHandoffService } from './provider.ts'
export * from '@deepseek-ai/dsh-research-handoff/api'
export { ResearchActionStore, researchActionFingerprint, researchModeFingerprint } from './action-store.ts'
export { ResearchArtifactError, researchArtifactHash, researchArtifactText, restoreResearchHandoff, splitResearchArtifact } from './artifact.ts'
export { ResearchClaimError, parseResearchClaimInventory, parseResearchClaimJudgment, validateResearchClaimChanges } from './claim-inventory.ts'
export { parseResearchPreparedPrompt, readResearchPromptTemplate, readResearchReferenceAsset, renderResearchPrompt } from './prompt.ts'
