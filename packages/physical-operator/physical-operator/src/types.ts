/**
 * Public contracts for the physical-operator capability seam.
 *
 * @module @deepseek-ai/dsh-physical-operator/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Stable deployment-owned identity for one physical operator. */
export type PhysicalOperatorId = Branded<'PhysicalOperatorId'>

/**
 * Brand a validated raw operator identity.
 * @param id - validated deployment-owned operator identity.
 * @returns the branded operator identity.
 */
export function PhysicalOperatorId(id: string): PhysicalOperatorId {
  return id as PhysicalOperatorId
}

/** Identity for one accepted execution attempt. */
export type PhysicalOperatorExecutionId = Branded<'PhysicalOperatorExecutionId'>

/**
 * Brand a generated execution identity.
 * @param id - generated unique execution identity.
 * @returns the branded execution identity.
 */
export function PhysicalOperatorExecutionId(id: string): PhysicalOperatorExecutionId {
  return id as PhysicalOperatorExecutionId
}

/** Stable descriptive and admission metadata owned by an operator provider. */
export interface PhysicalOperatorDescriptor {
  /** Stable id selected by callers; it does not expose the backing transport. */
  readonly id: PhysicalOperatorId
  /** Human-readable name for status and model discovery. */
  readonly displayName: string
  /** Concise statement of the work this operator is intended to perform. */
  readonly description: string
  /** Selection hints only; they grant no authority and do not alter execution. */
  readonly tags: readonly string[]
  /** Maximum accepted executions across current and hot-reloaded registrations. */
  readonly maxConcurrency: number
}

/** Provider-owned live availability, independent of service-owned capacity. */
export type PhysicalOperatorAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string }

/** Current discovery snapshot returned by the registry. */
export interface PhysicalOperatorStatus extends PhysicalOperatorDescriptor {
  /** Effective admission state after availability and capacity are combined. */
  readonly state: 'available' | 'busy' | 'unavailable'
  /** Number of accepted executions that have not settled. */
  readonly active: number
  /** Present only when the provider reports the operator unavailable. */
  readonly unavailableReason?: string
}

/** Caller-owned input for one operator execution. */
export interface PhysicalOperatorStartRequest {
  /** Optional short description used as the child run label. */
  readonly label?: string
  /** Complete standalone task content for the selected operator. */
  readonly prompt: ContentBlock[]
  /** Exact live agent whose workspace and authority the provider derives. */
  readonly parent: Agent
  /** Canonical cancellation channel before and after execution publication. */
  readonly signal: AbortSignal
}

/** Known terminal reasons; providers may merge in additional string variants. */
export interface PhysicalOperatorStopReasonMap {
  completed: 'completed'
  aborted: 'aborted'
  error: 'error'
  'max-tokens': 'max-tokens'
  refusal: 'refusal'
}

/** Terminal reason union for a physical-operator execution. */
export type PhysicalOperatorStopReason = PhysicalOperatorStopReasonMap[keyof PhysicalOperatorStopReasonMap]

/** Provider-neutral terminal result. */
export interface PhysicalOperatorResult {
  /** Final or partial canonical content returned by the backing execution. */
  readonly output: ContentBlock[]
  /** Why the execution ended. Only `completed` is a successful result. */
  readonly stopReason: PhysicalOperatorStopReason
}

/** Provider-owned run before the service adds identity and lifecycle observation. */
export interface PhysicalOperatorProviderRun {
  /** Settles once with the execution outcome; infrastructure faults may reject. */
  readonly result: Promise<PhysicalOperatorResult>
  /** Cancel remaining work and await resource quiescence. Idempotent. */
  dispose(): Promise<void>
}

/** Holder-owned accepted run published by {@link PhysicalOperatorRuntime.start}. */
export interface PhysicalOperatorRun extends PhysicalOperatorProviderRun {
  /** Unique identity shared by the paired start/end lifecycle events. */
  readonly id: PhysicalOperatorExecutionId
  /** Stable selected operator identity. */
  readonly operatorId: PhysicalOperatorId
}

/** Trusted same-process implementation for one registered physical operator. */
export interface PhysicalOperator {
  /** Immutable discovery and capacity contract. */
  readonly descriptor: PhysicalOperatorDescriptor
  /** Resolve current transport or deployment availability without starting work. */
  availability(): PhysicalOperatorAvailability
  /** Establish one run; fulfillment transfers ownership to the caller. */
  start(request: PhysicalOperatorStartRequest): Promise<PhysicalOperatorProviderRun>
}

/** Observe-only identity emitted after one provider run is published. */
export interface PhysicalOperatorExecutionInfo {
  readonly executionId: PhysicalOperatorExecutionId
  readonly operatorId: PhysicalOperatorId
}

/** Terminal lifecycle edge paired with {@link PhysicalOperatorExecutionInfo}. */
export interface PhysicalOperatorExecutionEndInfo extends PhysicalOperatorExecutionInfo {
  readonly stopReason: PhysicalOperatorStopReason
}
