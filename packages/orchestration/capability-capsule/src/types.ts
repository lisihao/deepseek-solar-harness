import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque immutable capsule reference in `id@version#sha256` form. */
export type CapabilityCapsuleRef = Branded<'CapabilityCapsuleRef'>

/** Effect families constrained by a certified graph. */
export interface CapabilityEffectSet {
  readonly read: readonly string[]
  readonly write: readonly string[]
  readonly execute: readonly string[]
  readonly network: readonly string[]
  readonly cost: readonly string[]
  readonly risk: readonly string[]
}

/** One graph-level capability requirement, resolved late per attempt. */
export interface CapabilityRequirement {
  readonly capability: string
  readonly minimumLevel?: number
  readonly required: boolean
  readonly preferredCapsuleIds?: readonly string[]
}

/** Version-one immutable Capability Capsule manifest. */
export interface CapabilityCapsuleManifestV1 {
  readonly version: 1
  readonly id: string
  readonly capsuleVersion: string
  readonly kind: 'instruction' | 'skill' | 'tool' | 'mcp' | 'resource' | 'data' | 'secret' | 'guard'
  readonly digest: string
  readonly provenance: { readonly publisher: string; readonly sourceRef: string }
  readonly applicability: readonly string[]
  readonly capabilityTags: readonly string[]
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
  readonly preconditions: readonly string[]
  readonly postconditions: readonly string[]
  readonly invariants: readonly string[]
  readonly consumes: readonly string[]
  readonly produces: readonly string[]
  readonly requires: readonly string[]
  readonly compatible: readonly string[]
  readonly incompatible: readonly string[]
  readonly effects: CapabilityEffectSet
  readonly bindings: {
    readonly instructions: readonly string[]
    readonly skills: readonly string[]
    readonly toolsAllow: readonly string[]
    readonly toolsDeny: readonly string[]
    readonly mcpServers: readonly string[]
    readonly resourceRefs: readonly string[]
    readonly dataRefs: readonly string[]
    readonly secretRefs: readonly string[]
    readonly guardRefs: readonly string[]
  }
  readonly verification: readonly string[]
  readonly operatorCompatibility: readonly string[]
}

/** Immutable catalog view used to make one late-binding decision reproducible. */
export interface CapsuleCatalogSnapshot {
  readonly revision: number
  readonly generatedAt: string
  readonly refs: readonly CapabilityCapsuleRef[]
  readonly catalogSha256: string
}

/** Input for catalog snapshot filtering. */
export interface CapsuleSnapshotRequest {
  readonly capabilityTags?: readonly string[]
}

/** Certified upper bounds and live facts for one resolution. */
export interface CapsuleResolutionRequest {
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
  readonly generation: number
  readonly requirements: readonly CapabilityRequirement[]
  readonly capabilityBudget: readonly string[]
  readonly effectBudget: CapabilityEffectSet
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly approvedSecretRefs: readonly string[]
  readonly operatorId?: string
  readonly operatorInjectionKinds?: readonly string[]
}

/** Immutable result of resolving a catalog snapshot for one attempt. */
export interface CapabilityBindingPlanV1 {
  readonly version: 1
  readonly catalogRevision: number
  readonly catalogSha256: string
  readonly capsuleRefs: readonly CapabilityCapsuleRef[]
  readonly instructions: readonly { readonly ref: CapabilityCapsuleRef; readonly digest: string; readonly text: string }[]
  readonly resourceRefs: readonly string[]
  readonly dataRefs: readonly string[]
  readonly toolsAllow: readonly string[]
  readonly toolsDeny: readonly string[]
  readonly mcpServers: readonly string[]
  readonly secretRefs: readonly string[]
  readonly guardRefs: readonly string[]
  readonly resolvedCapabilities: readonly string[]
  readonly effectiveEffects: CapabilityEffectSet
  readonly effectiveReadScopes: readonly string[]
  readonly effectiveWriteScopes: readonly string[]
  readonly verification: readonly string[]
  readonly blockers: readonly { readonly code: string; readonly message: string }[]
  readonly planSha256: string
}

/** Capsule catalog and resolution failures. */
export type CapabilityCapsuleErrorCode =
  | 'CAPSULE_INVALID'
  | 'CAPSULE_NOT_FOUND'
  | 'CAPABILITY_UNSATISFIED'
  | 'CAPABILITY_AUTHORITY_EXCEEDED'
  | 'CAPABILITY_HOTSWAP_UNSUPPORTED'
