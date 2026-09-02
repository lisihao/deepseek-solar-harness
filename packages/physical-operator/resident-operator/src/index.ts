/**
 * Service Definition for durable resident physical-operator sessions.
 * Execution callers use `ctx.physicalOperators`; trusted adapters and
 * management consumers use this control seam.
 * @module @deepseek-ai/dsh-resident-operator
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorModelToolBridgeV1,
  PhysicalOperatorNativeToolPolicy,
  PhysicalOperatorProgressPage,
  PhysicalOperatorReasoningEffort,
  PhysicalOperatorUsage,
} from '@deepseek-ai/dsh-physical-operator'
import { ResidentOperatorError } from './error.ts'

export { ResidentOperatorError } from './error.ts'

/** Current local control protocol version. */
export const RESIDENT_PROTOCOL_VERSION = 13
/** Current forward-only daemon state schema version. */
export const RESIDENT_STATE_SCHEMA_VERSION = 5

/** Opaque identity for one operator/workspace/lane Resident Session. */
export type ResidentOperatorSessionId = Branded<'ResidentOperatorSessionId'>
/**
 * Brand a validated Resident Session identity.
 * @param id - opaque raw identity returned by the daemon.
 * @returns the branded Session identity.
 */
export const ResidentOperatorSessionId = (id: string): ResidentOperatorSessionId => id as ResidentOperatorSessionId
/** Opaque identity for one admitted Resident turn. */
export type ResidentOperatorTurnId = Branded<'ResidentOperatorTurnId'>
/**
 * Brand a validated Resident turn identity.
 * @param id - opaque raw identity returned by the daemon.
 * @returns the branded turn identity.
 */
export const ResidentOperatorTurnId = (id: string): ResidentOperatorTurnId => id as ResidentOperatorTurnId
/** Durable caller-owned identity for one idempotent Resident command. */
export type ResidentOperatorCommandId = Branded<'ResidentOperatorCommandId'>
/**
 * Brand a validated Resident command identity.
 * @param id - caller-generated raw command identity.
 * @returns the branded command identity.
 */
export const ResidentOperatorCommandId = (id: string): ResidentOperatorCommandId => id as ResidentOperatorCommandId

/** Independent lifecycle dimension for a Resident Session. */
export type ResidentLifecycle = 'starting' | 'idle' | 'running' | 'draining' | 'stopped'
/** Independent health dimension for a Resident Session. */
export type ResidentHealth = 'ok' | 'degraded' | 'unavailable'
/** Stable reason attached to a non-ok Resident health snapshot. */
export type ResidentHealthReason =
  | 'auth_required'
  | 'quota_exhausted'
  | 'protocol_mismatch'
  | 'process_crashed'
  | 'workspace_missing'

/** Durable command-receipt state machine. */
export type ResidentReceiptState = 'accepted' | 'running' | 'settled' | 'indeterminate'
/** Provider-neutral terminal outcome for one Resident turn. */
export type ResidentStopReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
/** Bounded product-neutral progress phase persisted without prompt or transcript text. */
export type ResidentProgressPhase =
  | 'connecting'
  | 'session_ready'
  | 'reasoning'
  | 'tool_activity'
  | 'finalizing'

/**
 * A bounded, provider-neutral observation that is safe to project into a
 * conversation trace. It intentionally has no thinking, prompt, stderr,
 * environment, credential, or full-transcript variant.
 */
export type ResidentObservation =
  | ResidentPublicOutputObservation
  | ResidentToolStartedObservation
  | ResidentToolCompletedObservation
  | ResidentApprovalRequiredObservation
  | ResidentUsageUpdatedObservation

/** A public model-visible text fragment, truncated by the daemon before persistence. */
export interface ResidentPublicOutputObservation {
  readonly kind: 'public-output'
  readonly preview: string
}

/** A product tool began; arguments and tool input are deliberately not retained. */
export interface ResidentToolStartedObservation {
  readonly kind: 'tool-started'
  readonly toolName: string
}

/** A product tool ended; result body and tool output are deliberately not retained. */
export interface ResidentToolCompletedObservation {
  readonly kind: 'tool-completed'
  readonly toolName: string
}

/** A product requested an interactive approval that a headless Resident cannot grant. */
export interface ResidentApprovalRequiredObservation {
  readonly kind: 'approval-required'
  readonly approvalKind: string
  readonly preview?: string
}

/** Authoritative product token/cost counters observed while a turn is running. */
export interface ResidentUsageUpdatedObservation {
  readonly kind: 'usage-updated'
  readonly usage: PhysicalOperatorUsage
}

/** One native model advertised by a qualified subscription product. */
export interface ResidentModelOption {
  readonly model: string
  readonly resolvedModel?: string
  readonly displayName: string
  readonly description: string
  readonly supportedEfforts: readonly PhysicalOperatorReasoningEffort[]
  readonly defaultEffort?: PhysicalOperatorReasoningEffort
  readonly isDefault: boolean
  readonly supportsAdaptiveThinking: boolean
}

/** One rolling subscription allowance window reported by a native product. */
export interface ResidentQuotaWindow {
  /** Percentage already consumed in this window, from zero through one hundred. */
  readonly usedPercent: number
  /** Product-reported Unix timestamp at which this allowance resets. */
  readonly resetsAt?: number
  /** Product-reported rolling-window size in minutes. */
  readonly windowDurationMinutes?: number
}

/** One independently metered native-subscription pool. */
export interface ResidentQuotaPool {
  /** Stable product-owned pool identity. */
  readonly poolId: string
  /** Product-owned display label, such as the dedicated Codex Spark pool. */
  readonly displayName: string
  /** Exact model ids charged to this pool when the product exposes the mapping. */
  readonly models: readonly string[]
  /** The pool is part of the native subscription and never an API-key fallback. */
  readonly meter: 'native-subscription'
  readonly primary?: ResidentQuotaWindow
  readonly secondary?: ResidentQuotaWindow
  /** Time at which the product status was sampled. */
  readonly observedAt: string
}

/** Fully resolved model and optional reasoning intensity locked to one Resident Session. */
export interface ResidentExecutionProfile {
  readonly model: string
  readonly effort?: PhysicalOperatorReasoningEffort
}

/** How the daemon obtained a Session's effective profile. */
export type ResidentExecutionProfileSource = 'smart-auto' | 'mixed' | 'manual'

/** Current qualification result for one native product Driver. */
export interface ResidentProviderStatus {
  readonly operatorId: string
  readonly product: string
  readonly displayName: string
  readonly description: string
  readonly tags: readonly string[]
  readonly maxConcurrency: number
  readonly injectionBoundaries: readonly ('pre-dispatch' | 'next-turn' | 'checkpoint')[]
  readonly available: boolean
  readonly unavailableReason?: string
  /** Non-fatal quota telemetry failure; execution remains available with unknown allowance. */
  readonly quotaUnavailableReason?: string
  readonly authentication: 'native-subscription' | 'unqualified'
  /** Whether the configured Driver exposes an explicit owner-local login action. */
  readonly supportsExplicitAuthentication?: boolean
  readonly productVersion: string
  readonly protocolHash: string
  readonly models: readonly ResidentModelOption[]
  /** Independently metered allowance pools, absent when the product does not expose them. */
  readonly quotaPools?: readonly ResidentQuotaPool[]
}

/** One native product invocation after durable daemon admission. */
export interface ResidentDriverExecuteRequest {
  /** Outer durable command identity used to namespace native model-tool receipts. */
  readonly commandId: ResidentOperatorCommandId
  readonly workspace: string
  readonly prompt: readonly ContentBlock[]
  /** DSH-owned system instructions assembled for this exact Agent request. */
  readonly systemPrompt?: string
  readonly profile: ResidentExecutionProfile
  readonly nativeSessionId?: string
  readonly signal: AbortSignal
  /** Genuine host-tool bridge sealed before native thread dispatch. */
  readonly modelToolBridge?: PhysicalOperatorModelToolBridgeV1
  /** Daemon-normalized native product tool policy; direct Driver callers inherit when omitted. */
  readonly nativeToolPolicy?: PhysicalOperatorNativeToolPolicy
  readonly onRunning: (nativeSessionId?: string, nativeTurnId?: string) => void
  /** Persist a bounded product-neutral progress phase for reconnecting observers. */
  readonly onProgress: (phase: ResidentProgressPhase) => void
  /** Persist a bounded trace-safe product observation for reconnecting observers. */
  readonly onObservation: (observation: ResidentObservation) => void
}

/** One native history-compaction request after daemon idle/revision admission. */
export interface ResidentDriverCompactRequest {
  readonly workspace: string
  /** Existing authoritative native product Session/thread; compaction must not replace it. */
  readonly nativeSessionId: string
  /** Optional product-native compaction guidance when the product supports it. */
  readonly instructions?: string
  readonly signal: AbortSignal
}

/** Native product qualification and resumable-turn adapter loaded by a daemon Provider. */
export interface ResidentProductDriver {
  /** Stable physical product identity. */
  readonly operatorId: string
  /** @returns current version, protocol, and native-subscription qualification. */
  qualify(): Promise<ResidentProviderStatus>
  /**
   * Start one explicit owner-initiated native-subscription login flow.
   * Drivers must not read, copy, or persist product credentials themselves.
   */
  authenticate?(): Promise<ResidentProviderStatus>
  /**
   * Execute or resume one native product turn.
   * @param request - canonical workspace, prompt, prior native Session, signal, and progress callbacks.
   * @returns bounded final result and authoritative native Session identity.
   */
  execute(request: ResidentDriverExecuteRequest): Promise<ResidentTurnResult & { readonly nativeSessionId: string }>
  /** Compact one idle native Session without changing its continuation identity. */
  compact?(request: ResidentDriverCompactRequest): Promise<{ readonly nativeSessionId: string }>
}

/** Construction inputs supplied to a configured out-of-process Driver module. */
export interface ResidentProductDriverFactoryOptions {
  readonly stateRoot: string
}

/** Factory export implemented by an independently packaged Resident product Driver. */
export type ResidentProductDriverFactory = (
  options: ResidentProductDriverFactoryOptions,
) => ResidentProductDriver | Promise<ResidentProductDriver>

/** Current daemon-owned projection of one Resident Session. */
export interface ResidentSessionSnapshot {
  readonly sessionId: ResidentOperatorSessionId
  readonly operatorId: string
  readonly workspace: string
  /** Caller-owned execution lane; lanes isolate native conversational state within one workspace. */
  readonly laneId: string
  readonly lifecycle: ResidentLifecycle
  readonly health: ResidentHealth
  readonly healthReason?: ResidentHealthReason
  readonly control: 'automation'
  readonly stateRevision: number
  readonly nativeSessionId?: string
  /** Daemon-resolved model and reasoning intensity locked for this Session. */
  readonly executionProfile?: ResidentExecutionProfile
  /** Whether Smart Auto or a caller preference produced the locked profile. */
  readonly executionProfileSource?: ResidentExecutionProfileSource
  readonly activeTurnId?: ResidentOperatorTurnId
  /** Most recently updated durable receipt for reconnecting clients. */
  readonly latestTurn?: ResidentTurnSummary
  /** Most recent bounded daemon event, including product-neutral progress. */
  readonly latestEvent?: ResidentEvent
  readonly updatedAt: string
}

/** Bounded reconnect projection of one durable command receipt. */
export interface ResidentTurnSummary {
  readonly commandId: ResidentOperatorCommandId
  readonly turnId: ResidentOperatorTurnId
  readonly state: ResidentReceiptState
  /** Bounded display-only task summary; raw prompt content is never persisted. */
  readonly taskLabel?: string
  readonly nativeTurnId?: string
  readonly stopReason?: ResidentStopReason
  readonly resultRef?: string
  readonly updatedAt: string
}

/** Full trusted inspection result for a known Resident turn. */
export interface ResidentTurnSnapshot extends ResidentTurnSummary {
  readonly sessionId: ResidentOperatorSessionId
  readonly stateRevision: number
  readonly result?: ResidentTurnResult
  readonly error?: { readonly code: string; readonly message: string }
}

/** Caller-owned input for one idempotent Resident turn. */
export interface ResidentExecuteRequest {
  readonly commandId: ResidentOperatorCommandId
  /** Optional indeterminate command this explicitly authorized retry supersedes. */
  readonly supersedesCommandId?: ResidentOperatorCommandId
  readonly operatorId: string
  readonly workspace: string
  /** Stable task lane. Distinct lanes may execute concurrently without sharing native conversation history. */
  readonly laneId: string
  /** Optional bounded display summary persisted independently of the raw prompt. */
  readonly taskLabel?: string
  readonly prompt: readonly ContentBlock[]
  /** DSH-owned system instructions assembled for this exact Agent request. */
  readonly systemPrompt?: string
  /** Optional caller preference; omitted fields are resolved from task complexity and the live catalog. */
  readonly profile?: PhysicalOperatorExecutionPreference
  /** Optional genuine model-tool bridge sealed before dispatch. */
  readonly modelToolBridge?: PhysicalOperatorModelToolBridgeV1
  /** Native product tool policy; absence preserves the existing native tool surface. */
  readonly nativeToolPolicy?: PhysicalOperatorNativeToolPolicy
  readonly signal: AbortSignal
}

/** Bounded final product result or content-addressed reference. */
export interface ResidentTurnResult {
  readonly output: ContentBlock[]
  readonly stopReason: ResidentStopReason
  readonly usage?: PhysicalOperatorUsage
  readonly resultRef?: string
}

/** Holder-owned accepted Resident turn. */
export interface ResidentTurn {
  readonly turnId: ResidentOperatorTurnId
  readonly sessionId: ResidentOperatorSessionId
  readonly stateRevision: number
  readonly result: Promise<ResidentTurnResult>
  dispose(): Promise<void>
}

/** One bounded structured observation from the daemon event index. */
export interface ResidentEvent {
  readonly sequence: number
  readonly sessionId: ResidentOperatorSessionId
  readonly type: string
  readonly time: string
  readonly data: Readonly<Record<string, unknown>>
}

/** Cursor and bounds for one read-only event page. */
export interface ResidentEventReadRequest {
  readonly sessionId: ResidentOperatorSessionId
  readonly afterSequence?: number
  readonly limit?: number
  readonly signal?: AbortSignal
}

/** Ordered Resident events and their next exclusive cursor. */
export interface ResidentEventPage {
  readonly events: ResidentEvent[]
  readonly nextSequence: number
}

/**
 * Project a Resident event page onto the provider-neutral Physical Operator trace contract.
 * @param page - ordered Resident events and their exclusive next cursor.
 * @returns the provider-neutral Physical Operator progress page.
 */
export function residentProgressPage(
  page: {
    readonly events: readonly Pick<ResidentEvent, 'sequence' | 'type' | 'time' | 'data'>[]
    readonly nextSequence: number
  },
): PhysicalOperatorProgressPage {
  return {
    events: page.events.map(({ sequence, type, time, data }) => ({ sequence, type, time, data })),
    nextSequence: page.nextSequence,
  }
}

/** Matching Session and turn identities for a trusted interrupt. */
export interface ResidentInterruptRequest {
  readonly sessionId: ResidentOperatorSessionId
  readonly turnId: ResidentOperatorTurnId
}

/** Optimistic request to replace an idle Session's native association. */
export interface ResidentResetRequest {
  readonly sessionId: ResidentOperatorSessionId
  readonly expectedStateRevision: number
  readonly reason: string
}

/** Optimistic request to compact one idle native product Session in place. */
export interface ResidentCompactRequest {
  readonly commandId: ResidentOperatorCommandId
  readonly sessionId: ResidentOperatorSessionId
  readonly expectedStateRevision: number
  /** Optional native compaction guidance; unsupported products reject it explicitly. */
  readonly instructions?: string
}

/** Durable result of one successful in-place native Session compaction. */
export interface ResidentCompactResult {
  readonly session: ResidentSessionSnapshot
  readonly nativeSessionId: string
  readonly compactedAt: string
}

/** Explicit trusted resolution for an indeterminate command. */
export interface ResidentIndeterminateResolutionRequest {
  readonly commandId: ResidentOperatorCommandId
  readonly decision: 'abandon'
  readonly expectedStateRevision: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    residentOperators: ResidentOperatorService
  }
}

/** Abstract provider-neutral resident session/control surface. */
export abstract class ResidentOperatorService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'residentOperators')
  }

  /**
   * Qualify every configured native product provider.
   * @returns current version, protocol, and native-subscription availability snapshots.
   */
  abstract providers(): Promise<ResidentProviderStatus[]>

  /**
   * Start one explicit owner-local native-subscription login flow.
   * @param _operatorId - product identity whose configured Driver owns the flow.
   * @returns the provider status after the product CLI completes authentication.
   */
  authenticate(_operatorId: string): Promise<ResidentProviderStatus> {
    throw new ResidentOperatorError('Resident Provider does not support explicit authentication', 'SESSION_UNAVAILABLE')
  }

  /**
   * Admit or replay one durable command for its operator/workspace/lane Session.
   * @param request - command identity, optional retry lineage, prompt, workspace, lane, and cancellation signal.
   * @returns a holder-owned turn whose result settles independently.
   */
  abstract execute(request: ResidentExecuteRequest): Promise<ResidentTurn>

  /**
   * List all daemon-owned Resident Session snapshots.
   * @returns snapshots ordered by provider-defined recency.
   */
  abstract list(): Promise<ResidentSessionSnapshot[]>

  /**
   * Read one Resident Session snapshot.
   * @param sessionId - opaque Session identity returned by execution or listing.
   * @returns the current lifecycle, health, revision, and native association.
   */
  abstract inspect(sessionId: string): Promise<ResidentSessionSnapshot>

  /**
   * Read the durable receipt and bounded result for one turn after caller reconnect.
   * @param turnId - opaque turn identity from execution, a Session snapshot, or an event.
   * @returns the current receipt state, result reference, and terminal result when available.
   */
  abstract inspectTurn(turnId: string): Promise<ResidentTurnSnapshot>

  /**
   * Read a bounded page of structured observation events.
   * @param request - Session identity, exclusive cursor, bound, and optional signal.
   * @returns ordered events and the next exclusive cursor.
   */
  abstract readEvents(request: ResidentEventReadRequest): Promise<ResidentEventPage>

  /**
   * Interrupt the named active turn without deleting its Session.
   * @param request - matching Session and turn identities.
   * @returns after the Provider accepts the interrupt request.
   */
  abstract interrupt(request: ResidentInterruptRequest): Promise<void>

  /**
   * Replace an idle Session's native-product association under optimistic concurrency.
   * @param request - Session identity, expected state revision, and audit reason.
   * @returns the revised idle Session snapshot.
   */
  abstract reset(request: ResidentResetRequest): Promise<ResidentSessionSnapshot>

  /**
   * Compact an idle native product Session without replacing its continuation identity.
   * @param _request - Session identity, exact inspected revision, and optional native guidance.
   * @returns the revised idle Session snapshot after native compaction succeeds.
   */
  compact(_request: ResidentCompactRequest): Promise<ResidentCompactResult> {
    throw new ResidentOperatorError('Resident Provider does not support native Session compaction', 'SESSION_UNAVAILABLE')
  }

  /**
   * Record an explicit decision for an indeterminate command.
   * @param request - command identity, abandon decision, and expected Session revision.
   * @returns after the resolution is durably committed.
   */
  abstract resolveIndeterminate(request: ResidentIndeterminateResolutionRequest): Promise<void>
}

/**
 * Reject an invalid optimistic state revision.
 * @param value - candidate revision supplied by a trusted management caller.
 */
export function assertStateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ResidentOperatorError('state revision must be a non-negative safe integer', 'REVISION_CONFLICT')
  }
}

export default ResidentOperatorService
