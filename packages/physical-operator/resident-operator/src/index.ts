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
  PhysicalOperatorReasoningEffort,
} from '@deepseek-ai/dsh-physical-operator'
import { ResidentOperatorError } from './error.ts'

export { ResidentOperatorError } from './error.ts'

/** Current local control protocol version. */
export const RESIDENT_PROTOCOL_VERSION = 3
/** Current forward-only daemon state schema version. */
export const RESIDENT_STATE_SCHEMA_VERSION = 3

/** Opaque identity for one operator/workspace Resident Session. */
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
  readonly product: 'claude-code' | 'codex'
  readonly available: boolean
  readonly unavailableReason?: string
  readonly authentication: 'native-subscription' | 'unqualified'
  readonly productVersion: string
  readonly protocolHash: string
  readonly models: readonly ResidentModelOption[]
}

/** Current daemon-owned projection of one Resident Session. */
export interface ResidentSessionSnapshot {
  readonly sessionId: ResidentOperatorSessionId
  readonly operatorId: string
  readonly workspace: string
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
  /** Optional bounded display summary persisted independently of the raw prompt. */
  readonly taskLabel?: string
  readonly prompt: readonly ContentBlock[]
  /** Optional caller preference; omitted fields are resolved from task complexity and the live catalog. */
  readonly profile?: PhysicalOperatorExecutionPreference
  readonly signal: AbortSignal
}

/** Bounded final product result or content-addressed reference. */
export interface ResidentTurnResult {
  readonly output: ContentBlock[]
  readonly stopReason: ResidentStopReason
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
   * Admit or replay one durable command for its operator/workspace Session.
   * @param request - command identity, optional retry lineage, prompt, workspace, and cancellation signal.
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
