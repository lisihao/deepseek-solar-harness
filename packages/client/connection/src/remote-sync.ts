/** Browser-safe contract for the durable-Host remote projection stream. */

import type {
  HostFrame, MuxFrame, ResponseValue, RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { hostDescribeValueSchema } from '@deepseek-ai/dsh-host-apiproxy/api/host.schema'
import { hostFrameSchema, muxFrameSchema } from '@deepseek-ai/dsh-host-apiproxy/api/events.schema'
import { sessionListValueSchema } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import { workspaceListValueSchema } from '@deepseek-ai/dsh-host-apiproxy/api/workspace.schema'
import type { RemoteDeviceScope } from './remote-auth-wire.ts'

/** Dedicated unary channel, separate from the shared `/api` interceptor. */
export const REMOTE_SYNC_RPC_CHANNEL = '/remote-sync'

/** Downlink-only WebSocket carrying ordered remote projection frames. */
export const REMOTE_SYNC_EVENTS_PATH = '/remote-sync/events'

/** First independently versioned Server/Frontend projection protocol. */
export const REMOTE_SYNC_PROTOCOL = Object.freeze({ major: 1, minor: 4 })

/** Oldest projection-only minor accepted during a rolling 1.4 deployment. */
export const REMOTE_SYNC_COMPATIBLE_MINOR = 3

/** Negotiated same-major protocol carried by descriptions and snapshots. */
export interface RemoteSyncProtocolVersion {
  readonly major: typeof REMOTE_SYNC_PROTOCOL.major
  readonly minor: typeof REMOTE_SYNC_PROTOCOL.minor | typeof REMOTE_SYNC_COMPATIBLE_MINOR
}

/** Maximum exact JSON artifact transferred by the remote operator wire. */
export const REMOTE_RESIDENT_ARTIFACT_MAX_BYTES = 8 * 1024 * 1024

/** Process-generation identity plus one global event watermark. */
export interface RemoteSyncCursor {
  readonly deploymentId: string
  readonly sequence: number
}

/** Read-only state captured by the Server after the stream watermark is sampled. */
export interface RemoteSyncSnapshot {
  readonly protocol: RemoteSyncProtocolVersion
  readonly deploymentId: string
  readonly cursor: RemoteSyncCursor
  readonly capturedAt: string
  readonly host: ResponseValue<'host.describe'>
  readonly sessions: ResponseValue<'session.list'>['items']
  readonly workspaces: ResponseValue<'workspace.list'>['items']
  readonly archivedSessionIds: ResponseValue<'workspace.list'>['archivedSessionIds']
}

/** Fixed authenticated capability vocabulary advertised by the Server. */
export type RemoteSyncCapability =
  | 'session.read'
  | 'workspace.read'
  | 'event.subscribe'
  | 'session.command'
  | 'approval.respond'
  | 'session.replicate.read'
  | 'session.replicate.write'
  | 'operator.read'
  | 'operator.execute'
  | 'operator.interrupt'
  | 'operator.workspace.materialize'
  | 'operator.artifact.read'
  | 'orchestration.cluster'

/** Durable remote Resident turn identity returned before product execution settles. */
export interface RemoteResidentAcceptedTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly stateRevision: number
}

/** Browser-safe native model catalog entry exposed by a remote Resident Provider. */
export interface RemoteResidentModelOption {
  readonly model: string
  readonly resolvedModel?: string
  readonly displayName: string
  readonly description: string
  readonly supportedEfforts: readonly RemoteResidentReasoningEffort[]
  readonly defaultEffort?: RemoteResidentReasoningEffort
  readonly isDefault: boolean
  readonly supportsAdaptiveThinking: boolean
}

/** Reasoning-effort vocabulary shared by remote native-subscription Providers. */
export type RemoteResidentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** One observed rolling quota window for a remote native subscription. */
export interface RemoteResidentQuotaWindow {
  readonly usedPercent: number
  readonly resetsAt?: number
  readonly windowDurationMinutes?: number
}

/** One independently metered quota pool advertised by a remote Provider. */
export interface RemoteResidentQuotaPool {
  readonly poolId: string
  readonly displayName: string
  readonly models: readonly string[]
  readonly meter: 'native-subscription'
  readonly primary?: RemoteResidentQuotaWindow
  readonly secondary?: RemoteResidentQuotaWindow
  readonly observedAt: string
}

// This is an independently versioned browser wire ABI. Importing the Host
// Resident Service Definition here crosses the client build boundary, so the
// deliberately mirrored fields are checked by protocol parsers and tests.
/* jscpd:ignore-start */
/** Browser-safe availability and model catalog for one remote Resident Provider. */
export interface RemoteResidentProviderStatus {
  readonly operatorId: string
  readonly product: string
  readonly displayName: string
  readonly description: string
  readonly tags: readonly string[]
  readonly maxConcurrency: number
  readonly injectionBoundaries: readonly ('pre-dispatch' | 'next-turn' | 'checkpoint')[]
  readonly available: boolean
  readonly unavailableReason?: string
  readonly quotaUnavailableReason?: string
  readonly authentication: 'native-subscription' | 'unqualified'
  readonly productVersion: string
  readonly protocolHash: string
  readonly models: readonly RemoteResidentModelOption[]
  readonly quotaPools?: readonly RemoteResidentQuotaPool[]
}
/* jscpd:ignore-end */

/** Git identity used to reproduce one sender workspace on another Server. */
export interface RemoteWorkspaceIdentityV1 {
  readonly version: 1
  /** Canonical host/path identity, for example `github.com/owner/repository`. */
  readonly repository: string
  /** Exact clean source commit to materialize. */
  readonly commit: string
  /** Optional repository-relative directory used as the execution cwd. */
  readonly subdir?: string
}

/**
 * Normalize HTTPS and SSH Git origins to one credential-free host/path identity.
 * @param value - configured identity or Git remote URL.
 * @returns lowercase host plus case-preserving repository path without `.git`.
 */
export function canonicalRemoteRepositoryIdentity(value: string): string {
  if (value.length === 0 || value.trim() !== value) throw new Error('remote repository identity must be non-blank and trimmed')
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/u.exec(value)
  if (scp !== null && !value.includes('://')) return canonicalRepositoryParts(scp[1] as string, scp[2] as string)
  if (!value.includes('://')) {
    const slash = value.indexOf('/')
    if (slash <= 0) throw new Error('remote repository identity must contain a host and path')
    return canonicalRepositoryParts(value.slice(0, slash), value.slice(slash + 1))
  }
  const url = new URL(value)
  if (url.password.length > 0 || (url.protocol !== 'ssh:' && url.username.length > 0)) {
    throw new Error('remote repository identity must not contain credentials')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
    throw new Error('remote repository identity must use https or ssh')
  }
  return canonicalRepositoryParts(url.host, url.pathname)
}

function canonicalRepositoryParts(host: string, path: string): string {
  const repositoryPath = path.replace(/^\/+|\/+$/gu, '').replace(/\.git$/u, '')
  if (host.length === 0 || repositoryPath.length === 0
    || repositoryPath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('remote repository identity must contain a valid host and repository path')
  }
  return `${host.toLowerCase()}/${repositoryPath}`
}

/** Serializable remote execution request; absolute sender paths and product-local sockets never enter this DTO. */
export interface RemoteResidentExecuteRequest {
  readonly commandId: string
  readonly operatorId: string
  readonly workspaceIdentity: RemoteWorkspaceIdentityV1
  readonly laneId: string
  readonly taskLabel?: string
  readonly prompt: readonly ContentBlock[]
  readonly systemPrompt?: string
  readonly profile?: { readonly model?: string; readonly effort?: RemoteResidentReasoningEffort }
  /** Sealed native product-tool authority. Protocol 1.4 only. */
  readonly nativeToolPolicy?: 'inherit' | 'disabled'
}

/** Durable turn projection returned by the remote control plane. */
export interface RemoteResidentTurnSnapshot {
  readonly commandId: string
  readonly turnId: string
  readonly sessionId: string
  readonly state: 'accepted' | 'running' | 'settled' | 'indeterminate'
  readonly stateRevision: number
  readonly taskLabel?: string
  readonly nativeTurnId?: string
  readonly stopReason?: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  readonly resultRef?: string
  readonly updatedAt: string
  readonly result?: {
    readonly output: readonly ContentBlock[]
    readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
    readonly usage?: {
      readonly inputTokens: number
      readonly outputTokens: number
      readonly cacheReadInputTokens?: number
      readonly cacheWriteInputTokens?: number
      readonly costUsd?: number
    }
    readonly resultRef?: string
  }
  readonly error?: { readonly code: string; readonly message: string }
}

/** Exact immutable Resident result bytes returned for a content-addressed reference. */
export interface RemoteResidentArtifactDocument {
  readonly ref: string
  readonly json: string
}

/** Ordered bounded page of structured Resident progress observations. */
export interface RemoteResidentEventPage {
  readonly events: readonly {
    readonly sequence: number
    readonly sessionId: string
    readonly type: string
    readonly time: string
    readonly data: Readonly<Record<string, unknown>>
  }[]
  readonly nextSequence: number
}

/** Product-neutral Resident commands over any authenticated remote-sync transport. */
export class RemoteResidentProtocolClient {
  constructor(
    private readonly call: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
  ) {}

  /**
   * List qualified remote Resident Providers.
   * @param signal - optional transport cancellation signal.
   * @returns validated Provider status projections.
   */
  providers(signal?: AbortSignal): Promise<RemoteResidentProviderStatus[]> {
    return this.call('operator.providers', {}, signal).then(parseRemoteResidentProviders)
  }

  /**
   * Submit one idempotent turn to a remote Resident Provider.
   * @param request - durable command and workspace identity.
   * @param signal - optional transport cancellation signal.
   * @returns the accepted durable turn identity.
   */
  execute(request: RemoteResidentExecuteRequest, signal?: AbortSignal): Promise<RemoteResidentAcceptedTurn> {
    return this.call('operator.execute', { ...request, protocol: REMOTE_SYNC_PROTOCOL }, signal)
      .then(parseRemoteResidentAcceptedTurn)
  }

  /**
   * Inspect one durable remote Resident turn.
   * @param turnId - durable turn identity returned by execute.
   * @param signal - optional transport cancellation signal.
   * @returns the current validated turn projection.
   */
  inspect(turnId: string, signal?: AbortSignal): Promise<RemoteResidentTurnSnapshot> {
    return this.call('operator.inspect', { turnId }, signal).then(parseRemoteResidentTurn)
  }

  /**
   * Read exact content-addressed Resident result bytes after terminal inspection.
   * @param ref - `sha256:` reference returned by the settled remote turn.
   * @param signal - optional transport cancellation signal.
   * @returns exact UTF-8 JSON bytes and their claimed digest reference.
   */
  artifact(ref: string, signal?: AbortSignal): Promise<RemoteResidentArtifactDocument> {
    return this.call('operator.artifact.read', { ref, protocol: REMOTE_SYNC_PROTOCOL }, signal)
      .then(parseRemoteResidentArtifact)
  }

  /**
   * Read one bounded page of remote Resident progress events.
   * @param sessionId - durable Resident Session identity.
   * @param afterSequence - exclusive event cursor.
   * @param limit - maximum events to return.
   * @param signal - optional transport cancellation signal.
   * @returns ordered progress events and the next cursor.
   */
  events(
    sessionId: string,
    afterSequence: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteResidentEventPage> {
    return this.call('operator.events', { sessionId, afterSequence, limit }, signal)
      .then(parseRemoteResidentEventPage)
  }

  /**
   * Interrupt one active remote Resident turn without deleting its Session.
   * @param sessionId - durable Resident Session identity.
   * @param turnId - active turn identity.
   * @param signal - optional transport cancellation signal.
   * @returns completion after the remote control plane accepts the interrupt.
   */
  async interrupt(sessionId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    await this.call('operator.interrupt', { sessionId, turnId }, signal)
  }
}

/** Bound Resident command surface embedded by browser and headless transports. */
export interface RemoteResidentProtocolBindings {
  readonly operatorProviders: RemoteResidentProtocolClient['providers']
  readonly operatorExecute: RemoteResidentProtocolClient['execute']
  readonly operatorInspect: RemoteResidentProtocolClient['inspect']
  readonly operatorArtifact: RemoteResidentProtocolClient['artifact']
  readonly operatorEvents: RemoteResidentProtocolClient['events']
  readonly operatorInterrupt: RemoteResidentProtocolClient['interrupt']
}

/**
 * Bind the shared Resident command protocol to one transport-specific RPC function.
 * @param call - authenticated transport-specific RPC function.
 * @returns bound Resident commands for embedding in a transport client.
 */
export function bindRemoteResidentProtocol(
  call: (method: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>,
): RemoteResidentProtocolBindings {
  const resident = new RemoteResidentProtocolClient(call)
  return {
    operatorProviders: resident.providers.bind(resident),
    operatorExecute: resident.execute.bind(resident),
    operatorInspect: resident.inspect.bind(resident),
    operatorArtifact: resident.artifact.bind(resident),
    operatorEvents: resident.events.bind(resident),
    operatorInterrupt: resident.interrupt.bind(resident),
  }
}

/** One materialized Session available for an explicit single-writer handoff. */
export interface RemoteSessionReplicaSummary {
  readonly header: SessionHeader
  readonly revision: string
}

/** Complete logical Session log transferred across the authenticated wire. */
export interface RemoteSessionReplicaDocument {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly balanced: boolean
}

/** Prefix-compatible apply result returned by the destination Server. */
export interface RemoteSessionReplicaApplyResult {
  readonly sessionId: string
  readonly state: 'created' | 'advanced' | 'unchanged' | 'destination-ahead'
  readonly sourceEventCount: number
  readonly destinationEventCount: number
  readonly appendedEventCount: number
}

/** Authenticated Server identity and protocol capabilities discovered before snapshot. */
export interface RemoteSyncDescription {
  readonly protocol: RemoteSyncProtocolVersion
  readonly deploymentId: string
  readonly cursor: RemoteSyncCursor
  readonly describedAt: string
  readonly scope: RemoteDeviceScope
  readonly capabilities: readonly RemoteSyncCapability[]
  readonly host: ResponseValue<'host.describe'>
  readonly cluster?: RemoteSyncClusterProjection
}

/** Read-only Scheduler-authority hint used by a Frontend with multiple configured Servers. */
export interface RemoteSyncClusterProjection {
  readonly nodeId: string
  readonly term: number
  readonly role: 'follower' | 'candidate' | 'leader'
  readonly leaderId?: string
  readonly canSchedule: boolean
}

/** One existing Host transport envelope assigned a deployment-global sequence. */
export type RemoteSyncEvent =
  | {
    readonly type: 'remote-sync/event'
    readonly sequence: number
    readonly stream: 'mux'
    readonly envelope: RpcRequest<MuxFrame>
  }
  | {
    readonly type: 'remote-sync/event'
    readonly sequence: number
    readonly stream: 'host'
    readonly envelope: RpcRequest<HostFrame>
  }

/** Explicit repair instruction; a Frontend must discard projections and refetch. */
export interface RemoteSyncResyncRequired {
  readonly type: 'remote-sync/resync-required'
  readonly deploymentId: string
  readonly earliestSequence: number
  readonly latestSequence: number
  readonly reason: 'deployment-mismatch' | 'cursor-expired' | 'cursor-ahead'
}

/** One ordered projection event or an explicit snapshot-repair instruction. */
export type RemoteSyncFrame = RemoteSyncEvent | RemoteSyncResyncRequired

/**
 * Validate the untrusted snapshot result returned by the remote Server.
 * @param value - remote wire value.
 * @returns the validated gap-free projection snapshot.
 */
export function parseRemoteSyncSnapshot(value: unknown): RemoteSyncSnapshot {
  const record = objectRecord(value, 'remote sync snapshot')
  const protocol = parseProtocol(record.protocol)
  const deploymentId = nonEmptyString(record.deploymentId, 'deploymentId')
  const cursor = parseCursor(record.cursor)
  if (cursor.deploymentId !== deploymentId) {
    throw new Error('remote sync snapshot cursor belongs to another deployment')
  }
  const capturedAt = isoInstant(record.capturedAt, 'capturedAt')
  const host = hostDescribeValueSchema.parse(record.host) as ResponseValue<'host.describe'>
  const sessions = sessionListValueSchema.parse({ items: record.sessions }) as unknown as ResponseValue<'session.list'>
  const workspace = workspaceListValueSchema.parse({
    items: record.workspaces,
    archivedSessionIds: record.archivedSessionIds,
  })
  return {
    protocol,
    deploymentId,
    cursor,
    capturedAt,
    host,
    sessions: sessions.items,
    workspaces: workspace.items,
    archivedSessionIds: workspace.archivedSessionIds,
  }
}

/**
 * Validate the authenticated Server description before the Frontend accepts a snapshot.
 * @param value - remote wire value.
 * @returns the validated Server description.
 */
export function parseRemoteSyncDescription(value: unknown): RemoteSyncDescription {
  const record = objectRecord(value, 'remote sync description')
  const protocol = parseProtocol(record.protocol)
  const deploymentId = nonEmptyString(record.deploymentId, 'deploymentId')
  const cursor = parseCursor(record.cursor)
  if (cursor.deploymentId !== deploymentId) {
    throw new Error('remote sync description cursor belongs to another deployment')
  }
  const describedAt = isoInstant(record.describedAt, 'describedAt')
  const scope = remoteScope(record.scope)
  if (!Array.isArray(record.capabilities)) throw new Error('capabilities must be an array')
  const capabilities = record.capabilities.map(remoteCapability)
  const host = hostDescribeValueSchema.parse(record.host) as ResponseValue<'host.describe'>
  const cluster = record.cluster === undefined ? undefined : remoteClusterProjection(record.cluster)
  return { protocol, deploymentId, cursor, describedAt, scope, capabilities, host, ...cluster === undefined ? {} : { cluster } }
}

/**
 * Validate one untrusted WebSocket frame before it reaches projection state.
 * @param value - remote wire value.
 * @returns one validated event or repair instruction.
 */
export function parseRemoteSyncFrame(value: unknown): RemoteSyncFrame {
  const record = objectRecord(value, 'remote sync frame')
  if (record.type === 'remote-sync/resync-required') {
    const reason = record.reason
    if (reason !== 'deployment-mismatch' && reason !== 'cursor-expired' && reason !== 'cursor-ahead') {
      throw new Error(`remote sync resync reason is invalid: ${String(reason)}`)
    }
    return {
      type: 'remote-sync/resync-required',
      deploymentId: nonEmptyString(record.deploymentId, 'deploymentId'),
      earliestSequence: nonnegativeInteger(record.earliestSequence, 'earliestSequence'),
      latestSequence: nonnegativeInteger(record.latestSequence, 'latestSequence'),
      reason,
    }
  }
  if (record.type !== 'remote-sync/event') throw new Error(`remote sync frame type is invalid: ${String(record.type)}`)
  const sequence = positiveInteger(record.sequence, 'sequence')
  const envelope = objectRecord(record.envelope, 'remote sync event envelope')
  const rpcId = nonEmptyString(envelope.rpcId, 'rpcId') as RpcRequest<unknown>['rpcId']
  if (record.stream === 'mux') {
    return {
      type: 'remote-sync/event', sequence, stream: 'mux',
      envelope: { rpcId, payload: muxFrameSchema.parse(envelope.payload) },
    }
  }
  if (record.stream === 'host') {
    return {
      type: 'remote-sync/event', sequence, stream: 'host',
      envelope: { rpcId, payload: hostFrameSchema.parse(envelope.payload) },
    }
  }
  throw new Error(`remote sync stream is invalid: ${String(record.stream)}`)
}

/**
 * Validate a cursor accepted from local caller state.
 * @param value - local or wire cursor candidate.
 * @returns the validated deployment cursor.
 */
export function parseRemoteSyncCursor(value: unknown): RemoteSyncCursor {
  return parseCursor(value)
}

/**
 * Validate the remote materialized Session catalog.
 * @param value - untrusted wire payload.
 * @returns validated Session replica summaries.
 */
export function parseRemoteSessionReplicaList(value: unknown): RemoteSessionReplicaSummary[] {
  if (!Array.isArray(value)) throw new Error('remote Session replica list must be an array')
  return value.map((entry, index) => {
    const record = objectRecord(entry, `remote Session replica list entry ${index}`)
    return {
      header: sessionHeader(record.header, `remote Session replica list entry ${index}.header`),
      revision: nonEmptyString(record.revision, `remote Session replica list entry ${index}.revision`),
    }
  })
}

/**
 * Validate one complete remote Session document before local application.
 * @param value - untrusted wire payload.
 * @returns the validated balanced Session document.
 */
export function parseRemoteSessionReplicaDocument(value: unknown): RemoteSessionReplicaDocument {
  const record = objectRecord(value, 'remote Session replica document')
  if (!Array.isArray(record.events)) throw new Error('remote Session replica events must be an array')
  if (typeof record.balanced !== 'boolean') throw new Error('remote Session replica balanced must be a boolean')
  return {
    meta: sessionHeader(record.meta, 'remote Session replica meta'),
    events: record.events as SessionEvent[],
    balanced: record.balanced,
  }
}

/**
 * Validate the destination result of one replica apply.
 * @param value - untrusted wire payload.
 * @returns the validated authoritative apply result.
 */
export function parseRemoteSessionReplicaApplyResult(value: unknown): RemoteSessionReplicaApplyResult {
  const record = objectRecord(value, 'remote Session replica apply result')
  const state = record.state
  if (state !== 'created' && state !== 'advanced' && state !== 'unchanged' && state !== 'destination-ahead') {
    throw new Error(`remote Session replica state is invalid: ${String(state)}`)
  }
  return {
    sessionId: nonEmptyString(record.sessionId, 'remote Session replica sessionId'),
    state,
    sourceEventCount: nonnegativeInteger(record.sourceEventCount, 'remote Session replica sourceEventCount'),
    destinationEventCount: nonnegativeInteger(record.destinationEventCount, 'remote Session replica destinationEventCount'),
    appendedEventCount: nonnegativeInteger(record.appendedEventCount, 'remote Session replica appendedEventCount'),
  }
}

/**
 * Validate subscription-backed Resident capacity advertised by a remote Server.
 * @param value - untrusted wire payload.
 * @returns validated remote Provider capacity.
 */
export function parseRemoteResidentProviders(value: unknown): RemoteResidentProviderStatus[] {
  if (!Array.isArray(value)) throw new Error('remote Resident provider list must be an array')
  return value.map((entry, index) => {
    const label = `remote Resident provider ${index}`
    const record = objectRecord(entry, label)
    const authentication = record.authentication
    if (authentication !== 'native-subscription' && authentication !== 'unqualified') {
      throw new Error(`${label}.authentication is invalid`)
    }
    const models = arrayValue(record.models, `${label}.models`).map((model, modelIndex) => {
      const modelLabel = `${label}.models[${modelIndex}]`
      const item = objectRecord(model, modelLabel)
      return {
        model: nonEmptyString(item.model, `${modelLabel}.model`),
        ...(typeof item.resolvedModel === 'string' ? { resolvedModel: item.resolvedModel } : {}),
        displayName: nonEmptyString(item.displayName, `${modelLabel}.displayName`),
        description: stringValue(item.description, `${modelLabel}.description`),
        supportedEfforts: arrayValue(item.supportedEfforts, `${modelLabel}.supportedEfforts`)
          .map((effort, effortIndex) => reasoningEffort(effort, `${modelLabel}.supportedEfforts[${effortIndex}]`)),
        ...(item.defaultEffort === undefined ? {} : { defaultEffort: reasoningEffort(item.defaultEffort, `${modelLabel}.defaultEffort`) }),
        isDefault: booleanValue(item.isDefault, `${modelLabel}.isDefault`),
        supportsAdaptiveThinking: booleanValue(item.supportsAdaptiveThinking, `${modelLabel}.supportsAdaptiveThinking`),
      }
    })
    const injectionBoundaries = arrayValue(record.injectionBoundaries, `${label}.injectionBoundaries`).map((value) => {
      if (value === 'pre-dispatch' || value === 'next-turn' || value === 'checkpoint') return value
      throw new Error(`${label}.injectionBoundaries contains an invalid boundary`)
    })
    return {
      operatorId: nonEmptyString(record.operatorId, `${label}.operatorId`),
      product: nonEmptyString(record.product, `${label}.product`),
      displayName: nonEmptyString(record.displayName, `${label}.displayName`),
      description: stringValue(record.description, `${label}.description`),
      tags: arrayValue(record.tags, `${label}.tags`).map((tag, tagIndex) => nonEmptyString(tag, `${label}.tags[${tagIndex}]`)),
      maxConcurrency: positiveInteger(record.maxConcurrency, `${label}.maxConcurrency`),
      injectionBoundaries,
      available: booleanValue(record.available, `${label}.available`),
      ...(typeof record.unavailableReason === 'string' ? { unavailableReason: record.unavailableReason } : {}),
      ...(typeof record.quotaUnavailableReason === 'string' ? { quotaUnavailableReason: record.quotaUnavailableReason } : {}),
      authentication,
      productVersion: nonEmptyString(record.productVersion, `${label}.productVersion`),
      protocolHash: nonEmptyString(record.protocolHash, `${label}.protocolHash`),
      models,
      ...(record.quotaPools === undefined ? {} : {
        quotaPools: arrayValue(record.quotaPools, `${label}.quotaPools`).map((pool, poolIndex) => {
          const poolLabel = `${label}.quotaPools[${poolIndex}]`
          const item = objectRecord(pool, poolLabel)
          if (item.meter !== 'native-subscription') throw new Error(`${poolLabel}.meter is invalid`)
          return {
            poolId: nonEmptyString(item.poolId, `${poolLabel}.poolId`),
            displayName: nonEmptyString(item.displayName, `${poolLabel}.displayName`),
            models: arrayValue(item.models, `${poolLabel}.models`).map((model, modelIndex) => nonEmptyString(model, `${poolLabel}.models[${modelIndex}]`)),
            meter: 'native-subscription' as const,
            ...(item.primary === undefined ? {} : { primary: quotaWindow(item.primary, `${poolLabel}.primary`) }),
            ...(item.secondary === undefined ? {} : { secondary: quotaWindow(item.secondary, `${poolLabel}.secondary`) }),
            observedAt: isoInstant(item.observedAt, `${poolLabel}.observedAt`),
          }
        }),
      }),
    }
  })
}

/**
 * Validate one accepted remote Resident command receipt.
 * @param value - untrusted wire payload.
 * @returns the validated durable receipt.
 */
export function parseRemoteResidentAcceptedTurn(value: unknown): RemoteResidentAcceptedTurn {
  const record = objectRecord(value, 'remote Resident accepted turn')
  return {
    sessionId: nonEmptyString(record.sessionId, 'sessionId'),
    turnId: nonEmptyString(record.turnId, 'turnId'),
    stateRevision: nonnegativeInteger(record.stateRevision, 'stateRevision'),
  }
}

/**
 * Validate one remote durable turn projection, including its bounded terminal result.
 * @param value - untrusted wire payload.
 * @returns the validated turn projection.
 */
export function parseRemoteResidentTurn(value: unknown): RemoteResidentTurnSnapshot {
  const record = objectRecord(value, 'remote Resident turn')
  const state = record.state
  if (state !== 'accepted' && state !== 'running' && state !== 'settled' && state !== 'indeterminate') {
    throw new Error('remote Resident turn state is invalid')
  }
  const stopReason = record.stopReason
  if (stopReason !== undefined && stopReason !== 'completed' && stopReason !== 'aborted'
    && stopReason !== 'error' && stopReason !== 'max-tokens' && stopReason !== 'refusal') {
    throw new Error('remote Resident turn stopReason is invalid')
  }
  const result = record.result === undefined ? undefined : parseRemoteResidentResult(record.result)
  const error = record.error === undefined ? undefined : objectRecord(record.error, 'remote Resident turn error')
  return {
    commandId: nonEmptyString(record.commandId, 'commandId'),
    turnId: nonEmptyString(record.turnId, 'turnId'),
    sessionId: nonEmptyString(record.sessionId, 'sessionId'),
    state,
    stateRevision: nonnegativeInteger(record.stateRevision, 'stateRevision'),
    ...(typeof record.taskLabel === 'string' ? { taskLabel: record.taskLabel } : {}),
    ...(typeof record.nativeTurnId === 'string' ? { nativeTurnId: record.nativeTurnId } : {}),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(typeof record.resultRef === 'string' ? { resultRef: record.resultRef } : {}),
    updatedAt: isoInstant(record.updatedAt, 'updatedAt'),
    ...(result === undefined ? {} : {
      result,
    }),
    ...(error === undefined ? {} : {
      error: {
        code: nonEmptyString(error.code, 'error.code'),
        message: nonEmptyString(error.message, 'error.message'),
      },
    }),
  }
}

/**
 * Validate one complete Resident result, including authoritative usage counters.
 * @param value - untrusted wire or artifact payload.
 * @returns a provider-neutral terminal result.
 */
export function parseRemoteResidentResult(
  value: unknown,
): NonNullable<RemoteResidentTurnSnapshot['result']> {
  const result = objectRecord(value, 'remote Resident turn result')
  if (!Array.isArray(result.output)) throw new Error('remote Resident turn result.output must be an array')
  const usage = result.usage === undefined ? undefined : residentUsage(result.usage, 'result.usage')
  return {
    output: result.output as ContentBlock[],
    stopReason: residentStopReason(result.stopReason, 'result.stopReason'),
    ...usage === undefined ? {} : { usage },
    ...(typeof result.resultRef === 'string' ? { resultRef: result.resultRef } : {}),
  }
}

/**
 * Validate one exact remote Resident artifact document before digest verification.
 * @param value - untrusted wire payload.
 * @returns validated reference and exact UTF-8 JSON bytes.
 */
export function parseRemoteResidentArtifact(value: unknown): RemoteResidentArtifactDocument {
  const record = objectRecord(value, 'remote Resident artifact')
  const ref = nonEmptyString(record.ref, 'remote Resident artifact.ref')
  if (!/^sha256:[a-f0-9]{64}$/u.test(ref)) throw new Error('remote Resident artifact.ref is invalid')
  const json = nonEmptyString(record.json, 'remote Resident artifact.json')
  if (new TextEncoder().encode(json).byteLength > REMOTE_RESIDENT_ARTIFACT_MAX_BYTES) {
    throw new Error(`remote Resident artifact.json exceeds ${String(REMOTE_RESIDENT_ARTIFACT_MAX_BYTES)} bytes`)
  }
  try {
    JSON.parse(json)
  } catch {
    throw new Error('remote Resident artifact.json is invalid JSON')
  }
  return { ref, json }
}

/**
 * Validate one ordered page of remote Resident progress observations.
 * @param value - untrusted wire payload.
 * @returns the validated bounded event page.
 */
export function parseRemoteResidentEventPage(value: unknown): RemoteResidentEventPage {
  const record = objectRecord(value, 'remote Resident event page')
  const events = arrayValue(record.events, 'remote Resident event page.events').map((entry, index) => {
    const label = `remote Resident event ${index}`
    const event = objectRecord(entry, label)
    return {
      sequence: positiveInteger(event.sequence, `${label}.sequence`),
      sessionId: nonEmptyString(event.sessionId, `${label}.sessionId`),
      type: nonEmptyString(event.type, `${label}.type`),
      time: isoInstant(event.time, `${label}.time`),
      data: objectRecord(event.data, `${label}.data`),
    }
  })
  return { events, nextSequence: nonnegativeInteger(record.nextSequence, 'nextSequence') }
}

function parseCursor(value: unknown): RemoteSyncCursor {
  const cursor = objectRecord(value, 'remote sync cursor')
  return {
    deploymentId: nonEmptyString(cursor.deploymentId, 'cursor.deploymentId'),
    sequence: nonnegativeInteger(cursor.sequence, 'cursor.sequence'),
  }
}

function parseProtocol(value: unknown): RemoteSyncProtocolVersion {
  const protocol = objectRecord(value, 'remote sync protocol')
  if (protocol.major !== REMOTE_SYNC_PROTOCOL.major
    || (protocol.minor !== REMOTE_SYNC_PROTOCOL.minor && protocol.minor !== REMOTE_SYNC_COMPATIBLE_MINOR)) {
    throw new Error(
      `remote sync protocol mismatch: expected ${REMOTE_SYNC_PROTOCOL.major}.${REMOTE_SYNC_COMPATIBLE_MINOR}`
      + ` or ${REMOTE_SYNC_PROTOCOL.major}.${REMOTE_SYNC_PROTOCOL.minor}, `
      + `received ${String(protocol.major)}.${String(protocol.minor)}`,
    )
  }
  return { major: REMOTE_SYNC_PROTOCOL.major, minor: protocol.minor }
}

function isoInstant(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label)
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`remote sync ${label} is not an ISO instant`)
  return parsed
}

function remoteScope(value: unknown): RemoteDeviceScope {
  if (value === 'cockpit' || value === 'pocket' || value === 'admin') return value
  throw new Error(`remote sync scope is invalid: ${String(value)}`)
}

function remoteCapability(value: unknown): RemoteSyncCapability {
  if (value === 'session.read' || value === 'workspace.read' || value === 'event.subscribe'
    || value === 'session.command' || value === 'approval.respond'
    || value === 'session.replicate.read' || value === 'session.replicate.write'
    || value === 'operator.read' || value === 'operator.execute' || value === 'operator.interrupt'
    || value === 'operator.workspace.materialize' || value === 'operator.artifact.read'
    || value === 'orchestration.cluster') return value
  throw new Error(`remote sync capability is invalid: ${String(value)}`)
}

function remoteClusterProjection(value: unknown): RemoteSyncClusterProjection {
  const cluster = objectRecord(value, 'remote sync cluster')
  if (cluster.role !== 'follower' && cluster.role !== 'candidate' && cluster.role !== 'leader') {
    throw new Error(`remote sync cluster role is invalid: ${String(cluster.role)}`)
  }
  const leaderId = cluster.leaderId === undefined ? undefined : nonEmptyString(cluster.leaderId, 'cluster.leaderId')
  return {
    nodeId: nonEmptyString(cluster.nodeId, 'cluster.nodeId'),
    term: nonnegativeInteger(cluster.term, 'cluster.term'),
    role: cluster.role,
    ...leaderId === undefined ? {} : { leaderId },
    canSchedule: booleanValue(cluster.canSchedule, 'cluster.canSchedule'),
  }
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`)
  return value
}

function reasoningEffort(value: unknown, label: string): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra') return value
  throw new Error(`${label} is invalid`)
}

function residentStopReason(value: unknown, label: string): 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal' {
  if (value === 'completed' || value === 'aborted' || value === 'error' || value === 'max-tokens' || value === 'refusal') return value
  throw new Error(`${label} is invalid`)
}

function residentUsage(value: unknown, label: string): {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens?: number
  cacheWriteInputTokens?: number
  costUsd?: number
} {
  const usage = objectRecord(value, label)
  const optionalToken = (field: 'cacheReadInputTokens' | 'cacheWriteInputTokens'): number | undefined => (
    usage[field] === undefined ? undefined : nonnegativeInteger(usage[field], `${label}.${field}`)
  )
  const costUsd = usage.costUsd
  if (costUsd !== undefined && (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0)) {
    throw new Error(`${label}.costUsd must be a non-negative finite number`)
  }
  const cacheReadInputTokens = optionalToken('cacheReadInputTokens')
  const cacheWriteInputTokens = optionalToken('cacheWriteInputTokens')
  return {
    inputTokens: nonnegativeInteger(usage.inputTokens, `${label}.inputTokens`),
    outputTokens: nonnegativeInteger(usage.outputTokens, `${label}.outputTokens`),
    ...cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens },
    ...cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens },
    ...costUsd === undefined ? {} : { costUsd },
  }
}

function quotaWindow(value: unknown, label: string): { usedPercent: number; resetsAt?: number; windowDurationMinutes?: number } {
  const record = objectRecord(value, label)
  const usedPercent = record.usedPercent
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
    throw new Error(`${label}.usedPercent must be between 0 and 100`)
  }
  return {
    usedPercent,
    ...(record.resetsAt === undefined ? {} : { resetsAt: nonnegativeInteger(record.resetsAt, `${label}.resetsAt`) }),
    ...(record.windowDurationMinutes === undefined ? {} : {
      windowDurationMinutes: positiveInteger(record.windowDurationMinutes, `${label}.windowDurationMinutes`),
    }),
  }
}

function sessionHeader(value: unknown, label: string): SessionHeader {
  const record = objectRecord(value, label)
  nonnegativeInteger(record.version, `${label}.version`)
  nonEmptyString(record.id, `${label}.id`)
  nonnegativeInteger(record.createdAt, `${label}.createdAt`)
  return record as unknown as SessionHeader
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`)
  }
  return value
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label)
  if (parsed === 0) throw new Error(`${label} must be positive`)
  return parsed
}
