/** Browser-safe route and wire vocabulary for Server device authentication. */

export const REMOTE_AUTH_RPC_CHANNEL = '/remote-auth'

/** Fixed product scope granted to a paired remote device. */
export type RemoteDeviceScope = 'cockpit' | 'pocket' | 'admin'

/** One-time pairing code minted by the Server. */
export interface RemotePairingChallenge {
  readonly code: string
  readonly scope: RemoteDeviceScope
  readonly expiresAt: string
}

/** Durable credential returned once after pairing redemption. */
export interface RemoteDeviceCredential {
  readonly deviceId: string
  readonly credential: string
  readonly scope: RemoteDeviceScope
}

/** Short-lived authenticated session exchanged from a device credential. */
export interface RemoteAccessSession {
  readonly deviceId: string
  readonly deviceName: string
  readonly scope: RemoteDeviceScope
  readonly accessToken: string
  readonly expiresAt: string
}

/** Administrative projection of one paired device without secrets. */
export interface RemoteDeviceView {
  readonly deviceId: string
  readonly deviceName: string
  readonly scope: RemoteDeviceScope
  readonly createdAt: string
  readonly revokedAt?: string
}

/**
 * Validate an untrusted pairing challenge.
 * @param value - remote wire value.
 * @returns the validated challenge.
 */
export function parseRemotePairingChallenge(value: unknown): RemotePairingChallenge {
  const record = objectRecord(value, 'pairing challenge')
  return {
    code: nonEmptyString(record.code, 'code'),
    scope: remoteScope(record.scope),
    expiresAt: isoInstant(record.expiresAt, 'expiresAt'),
  }
}

/**
 * Validate an untrusted durable device credential.
 * @param value - remote wire value.
 * @returns the validated credential.
 */
export function parseRemoteDeviceCredential(value: unknown): RemoteDeviceCredential {
  const record = objectRecord(value, 'device credential')
  return {
    deviceId: nonEmptyString(record.deviceId, 'deviceId'),
    credential: nonEmptyString(record.credential, 'credential'),
    scope: remoteScope(record.scope),
  }
}

/**
 * Validate an untrusted short-lived access session.
 * @param value - remote wire value.
 * @returns the validated session.
 */
export function parseRemoteAccessSession(value: unknown): RemoteAccessSession {
  const record = objectRecord(value, 'access session')
  return {
    deviceId: nonEmptyString(record.deviceId, 'deviceId'),
    deviceName: nonEmptyString(record.deviceName, 'deviceName'),
    scope: remoteScope(record.scope),
    accessToken: nonEmptyString(record.accessToken, 'accessToken'),
    expiresAt: isoInstant(record.expiresAt, 'expiresAt'),
  }
}

/**
 * Validate an untrusted paired-device list.
 * @param value - remote wire value.
 * @returns validated device projections.
 */
export function parseRemoteDeviceList(value: unknown): readonly RemoteDeviceView[] {
  const record = objectRecord(value, 'device list')
  if (!Array.isArray(record.devices)) throw new Error('remote auth devices must be an array')
  return record.devices.map((device) => {
    const item = objectRecord(device, 'device')
    const revokedAt = item.revokedAt === undefined ? undefined : isoInstant(item.revokedAt, 'revokedAt')
    return {
      deviceId: nonEmptyString(item.deviceId, 'deviceId'),
      deviceName: nonEmptyString(item.deviceName, 'deviceName'),
      scope: remoteScope(item.scope),
      createdAt: isoInstant(item.createdAt, 'createdAt'),
      ...revokedAt === undefined ? {} : { revokedAt },
    }
  })
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`remote auth ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`remote auth ${label} must be a non-empty string`)
  }
  return value
}

function remoteScope(value: unknown): RemoteDeviceScope {
  if (value === 'cockpit' || value === 'pocket' || value === 'admin') return value
  throw new Error(`remote auth scope is invalid: ${String(value)}`)
}

function isoInstant(value: unknown, label: string): string {
  const parsed = nonEmptyString(value, label)
  if (Number.isNaN(Date.parse(parsed))) throw new Error(`remote auth ${label} is not an ISO instant`)
  return parsed
}
