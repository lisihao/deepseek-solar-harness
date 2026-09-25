import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque content-addressed Intent artifact identity. */
export type IntentArtifactRef = Branded<'IntentArtifactRef'>

/** Immutable input accepted by an Intent Compiler Provider. */
export interface IntentCompileRequest {
  readonly request: string
  readonly sourceRefs?: readonly string[]
  readonly attachmentRefs?: readonly string[]
  readonly compilerHint?: string
}

/** Version-one compiler provenance retained with every Intent artifact. */
export interface IntentCompilerProvenanceV1 {
  readonly compilerId: string
  readonly compilerVersion: string
  readonly inputSha256: string
  readonly outputSha256: string
}

/** Version-one normalized statement of one user request. */
export interface IntentIRV1 {
  readonly version: 1
  readonly objective: string
  readonly expectedOutcomes: readonly string[]
  readonly constraints: readonly string[]
  readonly nonGoals: readonly string[]
  readonly acceptanceRequirements: readonly string[]
  readonly sourceRefs: readonly string[]
  readonly attachmentRefs: readonly string[]
  readonly riskHints: readonly string[]
  readonly ambiguities: readonly string[]
  readonly requiresClarification: boolean
  readonly provenance: IntentCompilerProvenanceV1
}

/** Compiler failures that callers may route without matching prose. */
export type IntentCompilerErrorCode = 'INTENT_INVALID' | 'INTENT_COMPILER_UNAVAILABLE'
