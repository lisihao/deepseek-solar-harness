/** Browser-safe contract for the durable-Host remote projection stream. */

import type {
  HostFrame, MuxFrame, ResponseValue, RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
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
export const REMOTE_SYNC_PROTOCOL = Object.freeze({ major: 1, minor: 1 })

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
    || value === 'session.command' || value === 'approval.respond') return value
  throw new Error(`remote sync capability is invalid: ${String(value)}`)
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
