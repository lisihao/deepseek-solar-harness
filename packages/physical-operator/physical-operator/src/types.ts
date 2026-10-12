/**
 * Public contracts for the physical-operator capability seam.
 *
 * @module @deepseek-ai/dsh-physical-operator/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { OperatorContextEnvelopeReceiptV1, OperatorContextEnvelopeV1 } from '@deepseek-ai/dsh-system-prompt'

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

/** Execution lifetime requested from one stable physical operator. */
export type PhysicalOperatorExecutionMode = 'ephemeral' | 'resident'

/** Provider-neutral reasoning intensity accepted by native Resident products. */
export type PhysicalOperatorReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** Optional caller preference resolved and locked by the Resident authority. */
export interface PhysicalOperatorExecutionPreference {
  /** Native product model id. Omission lets Smart Auto choose from the live product catalog. */
  readonly model?: string
  /** Native product reasoning intensity. Omission lets Smart Auto choose a supported level. */
  readonly effort?: PhysicalOperatorReasoningEffort
}

/** One model-facing function tool served by an owner-local typed bridge. */
export interface PhysicalOperatorModelToolV1 {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** Serializable bridge used by out-of-process Resident products to call owner-local tools. */
export interface PhysicalOperatorModelToolBridgeV1 {
  readonly version: 1
  readonly socketPath: string
  readonly sessionId: string
  readonly tools: readonly PhysicalOperatorModelToolV1[]
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
  /** Supported lifetimes. Absence preserves the original ephemeral-only contract. */
  readonly executionModes?: readonly PhysicalOperatorExecutionMode[]
}

/** Provider-owned live availability, independent of service-owned capacity. */
export type PhysicalOperatorAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string }

/** Current discovery snapshot returned by the registry. */
export interface PhysicalOperatorStatus extends Omit<PhysicalOperatorDescriptor, 'executionModes'> {
  /** Normalized modes; legacy descriptors are reported as ephemeral-only. */
  readonly executionModes: readonly PhysicalOperatorExecutionMode[]
  /** Effective admission state after availability and capacity are combined. */
  readonly state: 'available' | 'busy' | 'unavailable'
  /** Number of accepted executions that have not settled. */
  readonly active: number
  /** Present only when the provider reports the operator unavailable. */
  readonly unavailableReason?: string
}

/** One native model offered by a Resident physical operator. */
export interface PhysicalOperatorResidentModel {
  readonly model: string
  readonly resolvedModel?: string
  readonly displayName: string
  readonly description: string
  readonly supportedEfforts: readonly PhysicalOperatorReasoningEffort[]
  readonly defaultEffort?: PhysicalOperatorReasoningEffort
  readonly isDefault: boolean
  readonly supportsAdaptiveThinking: boolean
}

/** One rolling allowance window reported by a subscription product. */
export interface PhysicalOperatorQuotaWindow {
  readonly usedPercent: number
  readonly resetsAt?: number
  readonly windowDurationMinutes?: number
}

/** Independently metered subscription allowance pool. */
export interface PhysicalOperatorQuotaPool {
  readonly poolId: string
  readonly displayName: string
  readonly models: readonly string[]
  readonly meter: 'native-subscription'
  readonly primary?: PhysicalOperatorQuotaWindow
  readonly secondary?: PhysicalOperatorQuotaWindow
  readonly observedAt: string
}

/** Provider-neutral dynamic Resident model and quota catalog. */
export interface PhysicalOperatorResidentCatalog {
  readonly operatorId: PhysicalOperatorId
  readonly product: string
  readonly injectionBoundaries: readonly ('pre-dispatch' | 'next-turn' | 'checkpoint')[]
  /** Whether this transport can reach the owner-local typed model-tool socket. */
  readonly supportsModelToolBridge: boolean
  /** Physical execution location relative to the Scheduler authority. */
  readonly location: 'local' | 'remote'
  /** Whether workspace mutations can be returned to the Scheduler's integration worktree. */
  readonly supportsWorkspaceMutationReturn: boolean
  /** Actual receiving driver can enforce the sealed file policy; absence means unsupported. */
  readonly supportsGovernedWorkspacePolicy?: boolean
  /** Actual receiving driver can enforce direct model generation bounds; absence means unsupported. */
  readonly supportsGenerationLimits?: boolean
  readonly available: boolean
  readonly unavailableReason?: string
  readonly quotaUnavailableReason?: string
  readonly authentication: 'native-subscription' | 'unqualified'
  readonly productVersion: string
  readonly protocolHash: string
  readonly models: readonly PhysicalOperatorResidentModel[]
  readonly quotaPools?: readonly PhysicalOperatorQuotaPool[]
  /** Current Gouzi default project binding, with verified member-local roots; absent on generic operators. */
  readonly gouziWorkspace?: {
    readonly gouziId: string
    readonly generation: number
    readonly projectId: string
    readonly projectScopes: readonly string[]
  }
}

/** Optional read policy for registered Resident model catalogs. */
export interface PhysicalOperatorResidentCatalogOptions {
  /** Re-enumerate native product models before returning catalogs. */
  readonly refreshModels?: boolean
}

/** Native product tool surface allowed for one sealed physical execution. */
export type PhysicalOperatorNativeToolPolicy = 'inherit' | 'dsh-tools-authoritative' | 'disabled'

/** Caller-owned limits for direct model generation; tool loops additionally enforce aggregate limits. */
export interface PhysicalOperatorGenerationLimits {
  readonly maxTokens: number
  readonly maxOutputBytes: number
  readonly maxToolCalls?: number
}

/** Sealed DSH workspace-file authority consumed by the governed direct-model executor. */
export interface PhysicalOperatorGovernedWorkspacePolicy {
  readonly version: 1
  readonly sourceWorkspace: string
  readonly readScopes: readonly string[]
  readonly writeScopes: readonly string[]
  readonly forbiddenScopes: readonly string[]
  readonly limits: {
    readonly maxToolCalls: number
    readonly maxFileBytes: number
    readonly maxOutputBytes: number
    readonly maxSearchFiles: number
  }
}

/** Caller-owned input for one operator execution. */
export interface PhysicalOperatorStartRequest {
  /**
   * Optional caller-owned idempotency identity. Trusted durable routers use
   * this to reconnect to the same Resident command after their process
   * restarts. Ordinary callers omit it and receive a generated identity.
   */
  readonly executionId?: PhysicalOperatorExecutionId
  /** Optional short description used as the child run label. */
  readonly label?: string
  /** Complete standalone task content for the selected operator. */
  readonly prompt: ContentBlock[]
  /** Complete current-task context prepared by the dispatch authority. */
  readonly contextEnvelope?: OperatorContextEnvelopeV1
  /** Exact assembled DSH system instructions for a native product acting as the current Agent. */
  readonly systemPrompt?: string
  /** Exact live agent whose workspace and authority the provider derives. */
  readonly parent: Agent
  /** Canonical cancellation channel before and after execution publication. */
  readonly signal: AbortSignal
  /** Requested lifetime. Absence means `ephemeral` for backward compatibility. */
  readonly mode?: PhysicalOperatorExecutionMode
  /** Optional Resident model/effort preference; the daemon resolves omitted fields and locks the result. */
  readonly residentProfile?: PhysicalOperatorExecutionPreference
  /** Stable caller-owned native-context lane used by multiple Resident turns in one logical session. */
  readonly residentLaneId?: string
  /** Optional genuine model-tool surface resolved before dispatch; never a prompt-encoded pseudo protocol. */
  readonly modelToolBridge?: PhysicalOperatorModelToolBridgeV1
  /** Exact current source inputs, including verified preceding edits, for a remote isolated read or write. */
  readonly workspaceSnapshotInput?: { readonly baseSha: string; readonly baseBundle: string }
  /** Return remote edits into the caller-owned clean execution checkout at this exact base. */
  readonly workspaceMutationReturn?: { readonly baseSha: string; readonly baseBundle?: string }
  /** Native product defaults, a governed DSH writable-effect authority, or a completely disabled tool surface. */
  readonly nativeToolPolicy?: PhysicalOperatorNativeToolPolicy
  /** Explicit output and tool-call limits for direct model requests. */
  readonly generationLimits?: PhysicalOperatorGenerationLimits
  /** Sealed file authority; absence preserves the existing native execution path. */
  readonly governedWorkspacePolicy?: PhysicalOperatorGovernedWorkspacePolicy
}

/** Provider-facing request after the service owns identity and mode normalization. */
export interface PhysicalOperatorProviderStartRequest extends PhysicalOperatorStartRequest {
  /** Identity allocated before provider startup; resident providers reuse it as their command receipt id. */
  readonly executionId: PhysicalOperatorExecutionId
  /** Normalized requested lifetime. */
  readonly mode: PhysicalOperatorExecutionMode
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

/** Product-reported token and cost usage for one physical execution. */
export interface PhysicalOperatorUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadInputTokens?: number
  readonly cacheWriteInputTokens?: number
  readonly costUsd?: number
}

/** Actual direct-model response metadata; a response id is not a native conversation identity. */
export interface PhysicalOperatorProviderResponse {
  readonly provider: string
  readonly model: string
  readonly responseId?: string
}

/** Provider-neutral terminal result. */
export interface PhysicalOperatorResult {
  /** Actual direct-model response metadata when this execution did not create a native Session. */
  readonly providerResponse?: PhysicalOperatorProviderResponse
  /** Final or partial canonical content returned by the backing execution. */
  readonly output: ContentBlock[]
  /** Why the execution ended. `completed` means a normal provider turn end, not verified task acceptance. */
  readonly stopReason: PhysicalOperatorStopReason
  /** Native product usage when the Provider exposes authoritative counters. */
  readonly usage?: PhysicalOperatorUsage
  /** Opaque durable continuation identity returned only by resident executions. */
  readonly continuity?: {
    readonly sessionId: string
    readonly stateRevision: number
  }
}

/** Provider-neutral accepted identity published before a durable turn settles. */
export interface PhysicalOperatorAcceptedReceipt {
  readonly sessionId: string
  readonly turnId: string
  readonly stateRevision: number
}

/** Bounded provider-neutral progress observation for Trace projection. */
export interface PhysicalOperatorProgressEvent {
  readonly sequence: number
  readonly type: string
  readonly time: string
  readonly data: Readonly<Record<string, unknown>>
}

/** Ordered progress page returned without exposing a native transcript. */
export interface PhysicalOperatorProgressPage {
  readonly events: readonly PhysicalOperatorProgressEvent[]
  readonly nextSequence: number
}

/** Provider-owned run before the service adds identity and lifecycle observation. */
export interface PhysicalOperatorProviderRun {
  /** Receipt proving how a supplied context envelope was materialized. */
  readonly contextReceipt?: OperatorContextEnvelopeReceiptV1
  /** Durable accepted receipt when the backing Provider supports reconnection. */
  readonly receipt?: PhysicalOperatorAcceptedReceipt
  /** Optional structured progress reader implemented by local and remote Resident Providers. */
  readEvents?(afterSequence: number, limit: number, signal?: AbortSignal): Promise<PhysicalOperatorProgressPage>
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
  /** Resolve current transport or deployment availability, optionally for one requested lifetime. */
  availability(mode?: PhysicalOperatorExecutionMode): PhysicalOperatorAvailability
  /** Optionally publish the live model/quota catalog for Resident scheduling. */
  residentCatalog?(options?: PhysicalOperatorResidentCatalogOptions): Promise<PhysicalOperatorResidentCatalog>
  /** Reattach observation to a previously accepted durable turn after caller restart. */
  reattach?(turnId: string): Promise<PhysicalOperatorProviderRun>
  /** Interrupt an accepted durable turn without deleting its Resident Session. */
  interrupt?(receipt: PhysicalOperatorAcceptedReceipt): Promise<void>
  /** Establish one run; fulfillment transfers ownership to the caller. */
  start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun>
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
