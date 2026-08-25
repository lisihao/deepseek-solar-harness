/** Desktop-owned deployment role and Keychain-encrypted remote credential state. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopShellMode } from './runtime.ts'

export interface DesktopServerDeploymentState {
  readonly version: 2
  readonly role: 'server'
}

interface DesktopFrontendDeploymentBase {
  readonly version: 2
  readonly role: 'frontend'
  readonly endpoint: string
  readonly deviceName: string
  readonly presentation: DesktopShellMode
}

export interface DesktopTrustedTunnelDeploymentState extends DesktopFrontendDeploymentBase {
  readonly authMode: 'trusted-tunnel'
}

export interface DesktopPairedDeploymentState extends DesktopFrontendDeploymentBase {
  readonly authMode: 'paired'
  readonly encryptedCredential: string
}

export type DesktopFrontendDeploymentState =
  | DesktopTrustedTunnelDeploymentState
  | DesktopPairedDeploymentState

export type DesktopDeploymentState = DesktopServerDeploymentState | DesktopFrontendDeploymentState

export interface DesktopAccessSession {
  readonly deviceId: string
  readonly deviceName: string
  readonly scope: 'cockpit' | 'pocket' | 'admin'
  readonly accessToken: string
  readonly expiresAt: string
}

export interface DesktopSecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

export interface DesktopDeploymentRequest {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>
}

export interface ConfigureFrontendRequest {
  readonly endpoint: string
  readonly pairingCode?: string
  readonly deviceName: string
  readonly presentation?: DesktopShellMode
}

const DEFAULT_STATE: DesktopServerDeploymentState = { version: 2, role: 'server' }

/** Persistence owner for choosing a local Server or remote Frontend before Cordis boot. */
export class DesktopDeploymentStateStore {
  private readonly statePath: string

  constructor(
    userDataPath: string,
    private readonly secrets: DesktopSecretStorage,
    private readonly request: DesktopDeploymentRequest,
  ) {
    this.statePath = join(userDataPath, 'deployment', 'state.json')
  }

  async load(): Promise<DesktopDeploymentState> {
    let text: string
    try {
      text = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_STATE
      throw error
    }
    const parsed: unknown = JSON.parse(text)
    return parseDeploymentState(parsed)
  }

  async configureFrontend(input: ConfigureFrontendRequest): Promise<DesktopFrontendDeploymentState> {
    const endpoint = parseEndpoint(input.endpoint)
    const deviceName = input.deviceName.trim()
    if (deviceName.length === 0 || deviceName.length > 100) {
      throw new Error('dsh-plugin-desktop: device name must contain 1 to 100 characters')
    }
    if (isLoopbackEndpoint(endpoint)) {
      const state: DesktopTrustedTunnelDeploymentState = {
        version: 2,
        role: 'frontend',
        authMode: 'trusted-tunnel',
        endpoint: endpoint.href,
        deviceName,
        presentation: input.presentation ?? 'compatibility',
      }
      await this.persist(state)
      return state
    }
    if (!this.secrets.isEncryptionAvailable()) {
      throw new Error('dsh-plugin-desktop: operating-system credential encryption is unavailable')
    }
    const pairingCode = input.pairingCode?.trim() ?? ''
    if (!/^\d{8}$/.test(pairingCode)) {
      throw new Error('dsh-plugin-desktop: pairing code must contain exactly 8 digits for a remote HTTPS Server')
    }
    const credential = await this.remoteCall(endpoint, 'pairing.redeem', {
      code: pairingCode,
      deviceName,
    })
    const parsedCredential = parseCredential(credential)
    const state: DesktopPairedDeploymentState = {
      version: 2,
      role: 'frontend',
      authMode: 'paired',
      endpoint: endpoint.href,
      deviceName,
      presentation: input.presentation ?? 'compatibility',
      encryptedCredential: this.secrets.encryptString(parsedCredential.credential).toString('base64'),
    }
    await this.persist(state)
    return state
  }

  async exchange(state: DesktopFrontendDeploymentState): Promise<DesktopAccessSession> {
    if (state.authMode !== 'paired') {
      throw new Error('dsh-plugin-desktop: trusted tunnel Frontends do not exchange a paired credential')
    }
    if (!this.secrets.isEncryptionAvailable()) {
      throw new Error('dsh-plugin-desktop: operating-system credential encryption is unavailable')
    }
    const credential = this.secrets.decryptString(Buffer.from(state.encryptedCredential, 'base64'))
    const value = await this.remoteCall(new URL(state.endpoint), 'session.exchange', { credential })
    return parseAccessSession(value)
  }

  async useServer(): Promise<DesktopServerDeploymentState> {
    await this.persist(DEFAULT_STATE)
    return DEFAULT_STATE
  }

  async setPresentation(
    state: DesktopFrontendDeploymentState,
    presentation: DesktopShellMode,
  ): Promise<DesktopFrontendDeploymentState> {
    const next = { ...state, presentation }
    await this.persist(next)
    return next
  }

  private async remoteCall(
    endpoint: URL,
    method: 'pairing.redeem' | 'session.exchange',
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const rpcId = crypto.randomUUID()
    const response = await this.request.fetch(new URL(`/remote-auth/${method}`, endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
    })
    if (!response.ok) throw new Error(`dsh-plugin-desktop: remote auth ${method} failed: HTTP ${response.status}`)
    const envelope: unknown = await response.json()
    const record = objectRecord(envelope, 'remote auth response')
    if (record.rpcId !== rpcId) throw new Error('dsh-plugin-desktop: remote auth rpcId mismatch')
    const result = objectRecord(record.result, 'remote auth result')
    if (result.ok !== true) throw new Error('dsh-plugin-desktop: remote auth request was rejected')
    return result.value
  }

  private persist(state: DesktopDeploymentState): Promise<void> {
    return writeFileAtomic(this.statePath, `${JSON.stringify(state, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

/** Memory-only access token refreshed from the Keychain-encrypted durable credential. */
export class DesktopRemoteAccessSession {
  private current: DesktopAccessSession | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(
    private readonly store: DesktopDeploymentStateStore,
    private readonly state: DesktopFrontendDeploymentState,
    private readonly onRefreshError: (error: unknown) => void = () => {},
  ) {}

  async start(): Promise<void> {
    if (this.stopped) throw new Error('dsh-plugin-desktop: remote access session is stopped')
    await this.refresh()
  }

  accessToken(): string {
    const session = this.current
    if (session === undefined) throw new Error('dsh-plugin-desktop: remote access session is not ready')
    return session.accessToken
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.current = undefined
  }

  private async refresh(): Promise<void> {
    try {
      const next = await this.store.exchange(this.state)
      if (this.stopped) return
      this.current = next
      const refreshAt = Date.parse(next.expiresAt) - 60_000
      this.schedule(Math.max(1_000, refreshAt - Date.now()))
    } catch (error) {
      if (this.stopped) return
      this.onRefreshError(error)
      this.schedule(30_000)
      if (this.current === undefined) throw error
    }
  }

  private schedule(delay: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh().catch(error => { this.onRefreshError(error) })
    }, delay)
  }
}

function parseEndpoint(input: string): URL {
  let endpoint: URL
  try {
    endpoint = new URL(input.trim())
  } catch {
    throw new Error('dsh-plugin-desktop: Server endpoint must be an absolute URL')
  }
  if (endpoint.username !== '' || endpoint.password !== ''
    || endpoint.pathname !== '/' || endpoint.search !== '' || endpoint.hash !== '') {
    throw new Error('dsh-plugin-desktop: Server endpoint must contain only scheme and authority')
  }
  const loopback = isLoopbackEndpoint(endpoint)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('dsh-plugin-desktop: remote Server endpoint must use HTTPS')
  }
  return endpoint
}

function isLoopbackEndpoint(endpoint: URL): boolean {
  return endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]'
}

function parseDeploymentState(value: unknown): DesktopDeploymentState {
  const state = objectRecord(value, 'deployment state')
  if (state.version !== 1 && state.version !== 2) {
    throw new Error('dsh-plugin-desktop: unsupported deployment state version')
  }
  if (state.role === 'server') return DEFAULT_STATE
  if (state.role !== 'frontend') throw new Error('dsh-plugin-desktop: invalid deployment role')
  const presentation = state.presentation
  if (presentation !== 'compatibility' && presentation !== 'advanced') {
    throw new Error('dsh-plugin-desktop: invalid Frontend presentation mode')
  }
  const endpoint = parseEndpoint(nonEmptyString(state.endpoint, 'endpoint'))
  const base: DesktopFrontendDeploymentBase = {
    version: 2,
    role: 'frontend',
    endpoint: endpoint.href,
    deviceName: nonEmptyString(state.deviceName, 'deviceName'),
    presentation,
  }
  if (state.version === 1 || state.authMode === 'paired') {
    return {
      ...base,
      authMode: 'paired',
      encryptedCredential: nonEmptyString(state.encryptedCredential, 'encryptedCredential'),
    }
  }
  if (state.authMode === 'trusted-tunnel') {
    if (!isLoopbackEndpoint(endpoint)) {
      throw new Error('dsh-plugin-desktop: trusted tunnel Frontend endpoint must be loopback')
    }
    return { ...base, authMode: 'trusted-tunnel' }
  }
  throw new Error('dsh-plugin-desktop: invalid Frontend authentication mode')
}

function parseCredential(value: unknown): { credential: string } {
  const record = objectRecord(value, 'device credential')
  return { credential: nonEmptyString(record.credential, 'credential') }
}

function parseAccessSession(value: unknown): DesktopAccessSession {
  const record = objectRecord(value, 'access session')
  const scope = record.scope
  if (scope !== 'cockpit' && scope !== 'pocket' && scope !== 'admin') {
    throw new Error('dsh-plugin-desktop: invalid remote access scope')
  }
  const expiresAt = nonEmptyString(record.expiresAt, 'expiresAt')
  if (Number.isNaN(Date.parse(expiresAt))) throw new Error('dsh-plugin-desktop: invalid access expiration')
  return {
    deviceId: nonEmptyString(record.deviceId, 'deviceId'),
    deviceName: nonEmptyString(record.deviceName, 'deviceName'),
    scope,
    accessToken: nonEmptyString(record.accessToken, 'accessToken'),
    expiresAt,
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`dsh-plugin-desktop: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`dsh-plugin-desktop: ${label} must be a non-empty string`)
  }
  return value
}
