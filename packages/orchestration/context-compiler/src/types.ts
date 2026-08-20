/** One immutable input source considered by context compilation. */
export interface ContextSourceRef {
  readonly ref: string
  readonly kind: 'intent' | 'requirement' | 'task' | 'artifact' | 'session' | 'knowledge' | 'capsule'
  readonly required: boolean
}

/** Context policy certified by the TaskGraph. */
export interface ContextPolicy {
  readonly maxTokens: number
  readonly allowedSourceKinds: readonly ContextSourceRef['kind'][]
  readonly unavailableSource: 'degrade' | 'block'
}

/** Provider-independent request for one node context projection. */
export interface ContextCompileRequest {
  readonly runId: string
  readonly nodeId: string
  readonly objective: string
  readonly workspace: string
  readonly task: string
  readonly sourceRefs: readonly ContextSourceRef[]
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly acceptance: readonly string[]
  readonly capsuleInstructions: readonly { readonly ref: string; readonly digest: string; readonly text: string }[]
  readonly policy: ContextPolicy
}

/** Version-one immutable context projection. */
export interface ContextPacketV1 {
  readonly version: 1
  readonly runId: string
  readonly nodeId: string
  readonly objective: string
  readonly workspace: string
  readonly task: string
  readonly included: readonly ContextSourceRef[]
  readonly summarized: readonly ContextSourceRef[]
  readonly dropped: readonly { readonly source: ContextSourceRef; readonly reason: string }[]
  readonly estimatedTokens: number
  readonly tokenBudget: number
  readonly truncationReason?: string
  readonly lineage: readonly string[]
  readonly degradedSources: readonly string[]
  readonly redactions: readonly string[]
  readonly capsuleInstructions: readonly { readonly ref: string; readonly digest: string; readonly text: string }[]
  readonly compilerId: string
  readonly compilerVersion: string
  readonly packetSha256: string
}

/** Context compilation failures. */
export type ContextCompilerErrorCode = 'CONTEXT_INVALID' | 'CONTEXT_SOURCE_UNAVAILABLE' | 'CONTEXT_BUDGET_EXCEEDED'
