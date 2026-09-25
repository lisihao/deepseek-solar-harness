/** Capability Capsule catalog and resolution seam. @module @deepseek-ai/dsh-capability-capsule */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  CapabilityBindingPlanV1,
  CapabilityCapsuleErrorCode,
  CapabilityCapsuleManifestV1,
  CapabilityCapsuleRef as CapabilityCapsuleRefType,
  CapsuleCatalogSnapshot,
  CapsuleResolutionRequest,
  CapsuleSnapshotRequest,
} from './types.ts'

export type {
  CapabilityBindingPlanV1,
  CapabilityCapsuleErrorCode,
  CapabilityCapsuleManifestV1,
  CapabilityEffectSet,
  CapabilityRequirement,
  CapsuleCatalogSnapshot,
  CapsuleResolutionRequest,
  CapsuleSnapshotRequest,
} from './types.ts'

/** Public opaque Capability Capsule identity. */
export type CapabilityCapsuleRef = CapabilityCapsuleRefType
/**
 * Brand one validated capsule reference.
 * @param value - validated content-addressed capsule identity.
 * @returns the opaque capsule reference.
 */
export const CapabilityCapsuleRef = (value: string): CapabilityCapsuleRefType => value as CapabilityCapsuleRefType

/** Stable Capability Capsule failure. */
export class CapabilityCapsuleError extends HarnessError {
  constructor(message: string, code: CapabilityCapsuleErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'CapabilityCapsuleError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    capabilityCapsules: CapabilityCapsuleService
  }
}

/** Provider-neutral Capsule registry and late-binding resolver. */
export abstract class CapabilityCapsuleService extends Service {
  constructor(ctx: Context) {
    if (new.target === CapabilityCapsuleService) {
      throw new Error('@deepseek-ai/dsh-capability-capsule is an abstract seam; load a Provider')
    }
    super(ctx, 'capabilityCapsules')
  }

  /**
   * Snapshot the live immutable catalog.
   * @param request - optional capability-tag catalog filter.
   * @returns one revisioned content-addressed catalog snapshot.
   */
  abstract snapshot(request: CapsuleSnapshotRequest): Promise<CapsuleCatalogSnapshot>
  /**
   * Read and digest-verify one immutable manifest.
   * @param ref - exact content-addressed Capsule reference.
   * @returns the validated version-one manifest.
   */
  abstract get(ref: CapabilityCapsuleRef): Promise<CapabilityCapsuleManifestV1>
  /**
   * Resolve bindings without mutating the source Graph.
   * @param request - attempt identity, requirements, budgets, and operator support.
   * @returns an immutable binding plan or structured blockers.
   */
  abstract resolve(request: CapsuleResolutionRequest): Promise<CapabilityBindingPlanV1>
}

export default CapabilityCapsuleService
