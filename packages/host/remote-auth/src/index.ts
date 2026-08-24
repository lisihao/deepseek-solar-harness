/** Persistent device authentication service for the DSH Server role. */

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { join, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  RemoteCommandReceiptStore,
  type RemoteCommandBeginResult,
  type RemoteCommandResponse,
} from './command-receipts.ts'
import { readOwnerOnlyText } from './private-file.ts'

export type { RemoteCommandBeginResult, RemoteCommandResponse } from './command-receipts.ts'

/** Fixed product scopes; this is deliberately not a generic RBAC vocabulary. */
export type RemoteDeviceScope = 'cockpit' | 'pocket' | 'admin'

/** Authenticated device identity carried across Server request boundaries. */
export interface RemotePrincipal {
  readonly deviceId: string
  readonly deviceName: string
  readonly scope: RemoteDeviceScope
}

/** Authority resolved for one local or paired-device HTTP request. */
export interface RemoteRequestAuthority {
  readonly local: boolean
  readonly scope: RemoteDeviceScope
  readonly principal?: RemotePrincipal
}

function firstHeader(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  return typeof value[0] === 'string' ? value[0] : undefined
}

function loopbackAddress(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function loopbackAuthority(value: string | undefined): boolean {
  if (value === undefined) return false
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}

/**
 * Resolve a loopback owner request or one authenticated remote device request.
 * Loopback is accepted only when peer, Host, and optional Origin all remain local.
 */
export function authorizeRemoteRequest(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  auth: Pick<RemoteAuthService, 'authenticate'> | undefined,
): RemoteRequestAuthority | undefined {
  const host = firstHeader(request.headers.host)
  const origin = firstHeader(request.headers.origin)
  if (loopbackAddress(request.socket.remoteAddress)
    && loopbackAuthority(host)
    && (origin === undefined || loopbackAuthority(origin))) {
    return { local: true, scope: 'admin' }
  }
  const authorization = firstHeader(request.headers.authorization)
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  const principal = token === undefined ? undefined : auth?.authenticate(token)
  return principal === undefined ? undefined : { local: false, scope: principal.scope, principal }
}

/** One-time local pairing challenge. */
export interface PairingChallenge {
  readonly code: string
  readonly scope: RemoteDeviceScope
  readonly expiresAt: string
}

/** Durable secret returned only when a pairing code is redeemed. */
export interface DeviceCredential {
  readonly deviceId: string
  readonly credential: string
  readonly scope: RemoteDeviceScope
}

/** Short-lived access bearer and its authenticated device principal. */
export interface AccessSession extends RemotePrincipal {
  readonly accessToken: string
  readonly expiresAt: string
}

/** Administrative device projection with no credential material. */
export interface RemoteDeviceView extends RemotePrincipal {
  readonly createdAt: string
  readonly revokedAt?: string
}

/** Stable failure vocabulary for pairing and credential operations. */
export type RemoteAuthErrorCode =
  | 'PAIRING_INVALID'
  | 'PAIRING_EXPIRED'
  | 'DEVICE_LIMIT_REACHED'
  | 'CREDENTIAL_INVALID'
  | 'DEVICE_NOT_FOUND'

/** Typed remote-auth failure carrying one stable error code. */
export class RemoteAuthError extends Error {
  constructor(readonly code: RemoteAuthErrorCode, message: string) {
    super(message)
    this.name = 'RemoteAuthError'
  }
}

/** Persistent remote-auth service configuration. */
export interface Config {
  /** Harness home; the device registry lives under remote-auth/v1. */
  dshHome?: string
  /** One-time pairing lifetime in milliseconds. */
  pairingTtlMs?: number
  /** Short-lived access-session lifetime in milliseconds. */
  accessTtlMs?: number
  /** Bound on durable non-revoked devices. */
  maxDevices?: number
}

interface PairingRecord {
  readonly scope: RemoteDeviceScope
  readonly expiresAt: number
}

interface DeviceRecord {
  readonly deviceId: string
  readonly deviceName: string
  readonly scope: RemoteDeviceScope
  readonly credentialHash: string
  readonly createdAt: string
  revokedAt?: string
}

interface AccessRecord {
  readonly principal: RemotePrincipal
  readonly expiresAt: number
}

interface DeviceDocument {
  readonly version: 1
  readonly devices: DeviceRecord[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteAuth: RemoteAuthService
  }
}

/** Sole Server writer for pairing, refresh credentials, access sessions, and revocation. */
export class RemoteAuthService extends Service {
  static Config: z<Config> = z.object({
    dshHome: z.string(),
    pairingTtlMs: z.natural().min(1).default(5 * 60_000),
    accessTtlMs: z.natural().min(1).default(15 * 60_000),
    maxDevices: z.natural().min(1).default(32),
  })

  private readonly filename: string
  private readonly commandReceipts: RemoteCommandReceiptStore
  private readonly pairingTtlMs: number
  private readonly accessTtlMs: number
  private readonly maxDevices: number
  private readonly pairings = new Map<string, PairingRecord>()
  private readonly devices = new Map<string, DeviceRecord>()
  private readonly access = new Map<string, AccessRecord>()
  private operations: Promise<void> = Promise.resolve()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'remoteAuth')
    const stateDirectory = resolve(join(resolveDshHome(config.dshHome), 'remote-auth', 'v1'))
    this.filename = join(stateDirectory, 'devices.json')
    this.commandReceipts = new RemoteCommandReceiptStore(join(stateDirectory, 'command-receipts.json'))
    this.pairingTtlMs = config.pairingTtlMs ?? 5 * 60_000
    this.accessTtlMs = config.accessTtlMs ?? 15 * 60_000
    this.maxDevices = config.maxDevices ?? 32
  }

  async [Service.init](): Promise<void> {
    await this.load()
    await this.commandReceipts.init()
  }

  /**
   * Mint one local, one-time pairing code. The code is never persisted.
   * @param scope - fixed capability scope assigned to the paired device.
   * @returns the one-time challenge and its expiry.
   */
  issuePairing(scope: RemoteDeviceScope): PairingChallenge {
    this.sweepExpired()
    let code: string
    do code = String(randomInt(0, 100_000_000)).padStart(8, '0')
    while (this.pairings.has(code))
    const expiresAt = Date.now() + this.pairingTtlMs
    this.pairings.set(code, { scope, expiresAt })
    return { code, scope, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Redeem one code exactly once and return the only copy of the refresh credential.
   * @param code - unexpired pairing code minted by this Server process.
   * @param deviceName - human-readable device label recorded in the registry.
   * @returns the durable device credential and assigned scope.
   */
  redeemPairing(code: string, deviceName: string): Promise<DeviceCredential> {
    const normalizedName = deviceName.trim()
    if (normalizedName.length === 0 || normalizedName.length > 100) {
      return Promise.reject(new RemoteAuthError('PAIRING_INVALID', 'device name must contain 1 to 100 characters'))
    }
    return this.exclusive(async () => {
      const pairing = this.pairings.get(code)
      if (pairing === undefined) throw new RemoteAuthError('PAIRING_INVALID', 'pairing code is invalid')
      this.pairings.delete(code)
      if (pairing.expiresAt <= Date.now()) throw new RemoteAuthError('PAIRING_EXPIRED', 'pairing code expired')
      const active = [...this.devices.values()].filter(device => device.revokedAt === undefined).length
      if (active >= this.maxDevices) {
        throw new RemoteAuthError('DEVICE_LIMIT_REACHED', 'remote device limit reached')
      }
      const credential = randomBytes(32).toString('base64url')
      const deviceId = randomUUID()
      this.devices.set(deviceId, {
        deviceId,
        deviceName: normalizedName,
        scope: pairing.scope,
        credentialHash: digest(credential),
        createdAt: new Date().toISOString(),
      })
      await this.persist()
      return { deviceId, credential, scope: pairing.scope }
    })
  }

  /**
   * Exchange a durable refresh credential for one short-lived access token.
   * @param credential - durable secret returned only when pairing was redeemed.
   * @returns the authenticated device principal and expiring bearer token.
   */
  exchange(credential: string): AccessSession {
    this.sweepExpired()
    const credentialHash = digest(credential)
    const device = [...this.devices.values()].find(candidate => (
      candidate.revokedAt === undefined && equalDigest(candidate.credentialHash, credentialHash)
    ))
    if (device === undefined) throw new RemoteAuthError('CREDENTIAL_INVALID', 'device credential is invalid')
    const accessToken = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + this.accessTtlMs
    const principal: RemotePrincipal = {
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      scope: device.scope,
    }
    this.access.set(accessToken, { principal, expiresAt })
    return { ...principal, accessToken, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Resolve a short-lived bearer token; invalid and expired tokens are indistinguishable.
   * @param accessToken - bearer token issued by {@link exchange}.
   * @returns the authenticated principal, or undefined for every rejected token.
   */
  authenticate(accessToken: string): RemotePrincipal | undefined {
    const session = this.access.get(accessToken)
    if (session === undefined) return undefined
    if (session.expiresAt <= Date.now()) {
      this.access.delete(accessToken)
      return undefined
    }
    const device = this.devices.get(session.principal.deviceId)
    if (device?.revokedAt !== undefined || device === undefined) {
      this.access.delete(accessToken)
      return undefined
    }
    return session.principal
  }

  /**
   * Project the paired-device roster for the trusted administration surface.
   * @returns the durable device registry without credential hashes or access tokens.
   */
  listDevices(): RemoteDeviceView[] {
    return [...this.devices.values()].map(device => ({
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      scope: device.scope,
      createdAt: device.createdAt,
      ...device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt },
    }))
  }

  /**
   * Revoke one device and all of its current access sessions.
   * @param deviceId - durable identifier of the paired device.
   * @returns a promise settled after the registry is persisted.
   */
  revoke(deviceId: string): Promise<void> {
    return this.exclusive(async () => {
      const device = this.devices.get(deviceId)
      if (device === undefined) throw new RemoteAuthError('DEVICE_NOT_FOUND', 'remote device not found')
      device.revokedAt ??= new Date().toISOString()
      for (const [token, session] of this.access) {
        if (session.principal.deviceId === deviceId) this.access.delete(token)
      }
      await this.persist()
    })
  }

  /**
   * Begin or reconcile one authenticated remote command without retaining its body.
   * @param deviceId - authenticated device that owns the command namespace.
   * @param commandId - caller-stable idempotency identity.
   * @param requestHash - canonical request digest used only for conflict detection.
   * @returns whether the caller may execute, must wait, or can reuse a prior result.
   */
  beginCommand(deviceId: string, commandId: string, requestHash: string): Promise<RemoteCommandBeginResult> {
    return this.commandReceipts.begin(deviceId, commandId, requestHash)
  }

  /**
   * Cache the small carrier response for an accepted remote command.
   * @param deviceId - authenticated device that owns the command namespace.
   * @param commandId - caller-stable idempotency identity.
   * @param requestHash - canonical request digest accepted by {@link beginCommand}.
   * @param response - bounded response safe to return on an identical retry.
   * @returns a promise settled after the receipt is durable.
   */
  settleCommand(
    deviceId: string,
    commandId: string,
    requestHash: string,
    response: RemoteCommandResponse,
  ): Promise<void> {
    return this.commandReceipts.settle(deviceId, commandId, requestHash, response)
  }

  /**
   * Fence a command whose business outcome could not be proven after acceptance.
   * @param deviceId - authenticated device that owns the command namespace.
   * @param commandId - caller-stable idempotency identity.
   * @param requestHash - canonical request digest accepted by {@link beginCommand}.
   * @returns a promise settled after the indeterminate state is durable.
   */
  markCommandIndeterminate(deviceId: string, commandId: string, requestHash: string): Promise<void> {
    return this.commandReceipts.markIndeterminate(deviceId, commandId, requestHash)
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operations.then(operation, operation)
    this.operations = current.then(() => undefined, () => undefined)
    return current
  }

  private sweepExpired(): void {
    const now = Date.now()
    for (const [code, pairing] of this.pairings) if (pairing.expiresAt <= now) this.pairings.delete(code)
    for (const [token, session] of this.access) if (session.expiresAt <= now) this.access.delete(token)
  }

  private async load(): Promise<void> {
    const text = await readOwnerOnlyText(this.filename)
    if (text === undefined) return
    const parsed: unknown = JSON.parse(text)
    if (!isDeviceDocument(parsed)) throw new Error(`remote-auth: invalid device registry ${this.filename}`)
    for (const device of parsed.devices) this.devices.set(device.deviceId, device)
  }

  private persist(): Promise<void> {
    const document: DeviceDocument = { version: 1, devices: [...this.devices.values()] }
    return writeFileAtomic(this.filename, `${JSON.stringify(document, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isScope(value: unknown): value is RemoteDeviceScope {
  return value === 'cockpit' || value === 'pocket' || value === 'admin'
}

function isDeviceDocument(value: unknown): value is DeviceDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const document = value as { version?: unknown; devices?: unknown }
  return document.version === 1 && Array.isArray(document.devices) && document.devices.every((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return false
    const device = candidate as Record<string, unknown>
    return typeof device.deviceId === 'string' && device.deviceId.length > 0
      && typeof device.deviceName === 'string' && device.deviceName.length > 0
      && isScope(device.scope)
      && typeof device.credentialHash === 'string' && /^[a-f0-9]{64}$/.test(device.credentialHash)
      && typeof device.createdAt === 'string' && !Number.isNaN(Date.parse(device.createdAt))
      && (device.revokedAt === undefined
        || (typeof device.revokedAt === 'string' && !Number.isNaN(Date.parse(device.revokedAt))))
  })
}

export default RemoteAuthService
