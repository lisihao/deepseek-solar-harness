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
export const REMOTE_SYNC_PROTOCOL = Object.freeze({ major: 1, minor: 3 })

/** Process-generation identity plus one global event watermark. */
export interface RemoteSyncCursor {
  readonly deploymentId: string
  readonly sequence: number
}

/** Read-only state captured by the Server after the stream watermark is sampled. */
export interface RemoteSyncSnapshot {
  readonly protocol: typeof REMOTE_SYNC_PROTOCOL
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

export type RemoteResidentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface RemoteResidentQuotaWindow {
  readonly usedPercent: number
  readonly resetsAt?: number
  readonly windowDurationMinutes?: number
}

export interface RemoteResidentQuotaPool {
  readonly poolId: string
  readonly displayName: string
  readonly models: readonly string[]
  readonly meter: 'native-subscription'
  readonly primary?: RemoteResidentQuotaWindow
  readonly secondary?: RemoteResidentQuotaWindow
  readonly observedAt: string
}

/** Pure-data remote capacity DTO; it does not import the Host Resident Service identity. */
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

/** Serializable remote execution request; product-local tool sockets never enter this DTO. */
export interface RemoteResidentExecuteRequest {
  readonly commandId: string
  readonly operatorId: string
  readonly workspace: string
  readonly laneId: string
  readonly taskLabel?: string
  readonly prompt: readonly ContentBlock[]
  readonly systemPrompt?: string
  readonly profile?: { readonly model?: string; readonly effort?: RemoteResidentReasoningEffort }
}

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
    readonly resultRef?: string
  }
  readonly error?: { readonly code: string; readonly message: string }
}

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
  readonly protocol: typeof REMOTE_SYNC_PROTOCOL
  readonly deploymentId: string
  readonly cursor: RemoteSyncCursor
  readonly describedAt: string
  readonly scope: RemoteDeviceScope
  readonly capabilities: readonly RemoteSyncCapability[]
  readonly host: ResponseValue<'host.describe'>
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
  return { protocol, deploymentId, cursor, describedAt, scope, capabilities, host }
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

/** Validate the remote materialized Session catalog. */
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

/** Validate one complete remote Session document before local application. */
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

/** Validate the destination result of one replica apply. */
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

/** Validate subscription-backed Resident capacity advertised by a remote Server. */
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

/** Validate one accepted remote Resident command receipt. */
export function parseRemoteResidentAcceptedTurn(value: unknown): RemoteResidentAcceptedTurn {
  const record = objectRecord(value, 'remote Resident accepted turn')
  return {
    sessionId: nonEmptyString(record.sessionId, 'sessionId'),
    turnId: nonEmptyString(record.turnId, 'turnId'),
    stateRevision: nonnegativeInteger(record.stateRevision, 'stateRevision'),
  }
}

/** Validate one remote durable turn projection, including its bounded terminal result. */
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
  const result = record.result === undefined ? undefined : objectRecord(record.result, 'remote Resident turn result')
  if (result !== undefined && !Array.isArray(result.output)) throw new Error('remote Resident turn result.output must be an array')
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
      result: {
        output: result.output as ContentBlock[],
        stopReason: residentStopReason(result.stopReason, 'result.stopReason'),
        ...(typeof result.resultRef === 'string' ? { resultRef: result.resultRef } : {}),
      },
    }),
    ...(error === undefined ? {} : {
      error: {
        code: nonEmptyString(error.code, 'error.code'),
        message: nonEmptyString(error.message, 'error.message'),
      },
    }),
  }
}

/** Validate one ordered page of remote Resident progress observations. */
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

function parseProtocol(value: unknown): typeof REMOTE_SYNC_PROTOCOL {
  const protocol = objectRecord(value, 'remote sync protocol')
  if (protocol.major !== REMOTE_SYNC_PROTOCOL.major || protocol.minor !== REMOTE_SYNC_PROTOCOL.minor) {
    throw new Error(
      `remote sync protocol mismatch: expected ${REMOTE_SYNC_PROTOCOL.major}.${REMOTE_SYNC_PROTOCOL.minor}, `
      + `received ${String(protocol.major)}.${String(protocol.minor)}`,
    )
  }
  return REMOTE_SYNC_PROTOCOL
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
    || value === 'operator.read' || value === 'operator.execute' || value === 'operator.interrupt') return value
  throw new Error(`remote sync capability is invalid: ${String(value)}`)
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
