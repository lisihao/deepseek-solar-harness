/** Desktop-owned deployment role and Keychain-encrypted remote credential state. */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { DesktopShellMode } from './runtime.ts'

export interface DesktopServerDeploymentState {
  readonly version: 4
  readonly role: 'server'
  readonly activeServerId?: string
  readonly servers: readonly DesktopFrontendServer[]
  readonly presentation: DesktopShellMode
}

interface DesktopFrontendServerBase {
  readonly id: string
  readonly label: string
  readonly endpoint: string
  readonly deviceName: string
}

export interface DesktopTrustedTunnelServer extends DesktopFrontendServerBase {
  readonly authMode: 'trusted-tunnel'
}

export interface DesktopPairedServer extends DesktopFrontendServerBase {
  readonly authMode: 'paired'
  readonly encryptedCredential: string
}

export type DesktopFrontendServer = DesktopTrustedTunnelServer | DesktopPairedServer

export interface DesktopFrontendDeploymentState {
  readonly version: 4
  readonly role: 'frontend'
  readonly activeServerId: string
  readonly servers: readonly DesktopFrontendServer[]
  readonly presentation: DesktopShellMode
}

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
  readonly serverId?: string
  readonly label?: string
  readonly endpoint: string
  readonly pairingCode?: string
  readonly deviceName: string
  readonly presentation?: DesktopShellMode
}

/** One reachable Frontend Server together with its memory-only access session. */
export interface DesktopFrontendConnection {
  readonly state: DesktopFrontendDeploymentState
  readonly server: DesktopFrontendServer
  readonly access?: DesktopRemoteAccessSession
}

const DEFAULT_STATE: DesktopServerDeploymentState = {
  version: 4,
  role: 'server',
  servers: [],
  presentation: 'compatibility',
}

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
    const current = await this.load()
    const servers = [...current.servers]
    const requestedId = input.serverId?.trim()
    const requestedIndex = requestedId === undefined || requestedId === ''
      ? servers.findIndex(server => server.endpoint === endpoint.href)
      : servers.findIndex(server => server.id === requestedId)
    if (requestedId !== undefined && requestedId !== '' && requestedIndex < 0) {
      throw new Error('dsh-plugin-desktop: Frontend Server id does not exist')
    }
    const duplicateEndpoint = servers.findIndex((server, index) => (
      server.endpoint === endpoint.href && index !== requestedIndex
    ))
    if (duplicateEndpoint >= 0) {
      throw new Error('dsh-plugin-desktop: Frontend Server endpoint is already configured')
    }
    const id = requestedIndex >= 0 ? servers[requestedIndex]!.id : crypto.randomUUID()
    const label = parseLabel(input.label, endpoint)
    let server: DesktopFrontendServer
    if (isLoopbackEndpoint(endpoint)) {
      server = {
        id,
        label,
        authMode: 'trusted-tunnel',
        endpoint: endpoint.href,
        deviceName,
      }
    } else {
      if (!this.secrets.isEncryptionAvailable()) {
        throw new Error('dsh-plugin-desktop: operating-system credential encryption is unavailable')
      }
      const pairingCode = input.pairingCode?.trim() ?? ''
      const existing = requestedIndex >= 0 ? servers[requestedIndex] : undefined
      if (pairingCode === '' && existing?.authMode === 'paired'
        && existing.endpoint === endpoint.href && existing.deviceName === deviceName) {
        server = { ...existing, label }
      } else {
        if (!/^\d{8}$/.test(pairingCode)) {
          throw new Error('dsh-plugin-desktop: pairing code must contain exactly 8 digits for a remote HTTPS Server')
        }
        const credential = await this.remoteCall(endpoint, 'pairing.redeem', {
          code: pairingCode,
          deviceName,
        })
        const parsedCredential = parseCredential(credential)
        server = {
          id,
          label,
          authMode: 'paired',
          endpoint: endpoint.href,
          deviceName,
          encryptedCredential: this.secrets.encryptString(parsedCredential.credential).toString('base64'),
        }
      }
    }
    if (requestedIndex >= 0) servers[requestedIndex] = server
    else servers.push(server)
    const state: DesktopFrontendDeploymentState = {
      version: 4,
      role: 'frontend',
      activeServerId: id,
      servers,
      presentation: input.presentation ?? current.presentation,
    }
    await this.persist(state)
    return state
  }

  async selectFrontend(serverId: string): Promise<DesktopFrontendDeploymentState> {
    const current = await this.load()
    if (current.servers.length === 0) throw new Error('dsh-plugin-desktop: no Frontend Servers are configured')
    const id = nonEmptyString(serverId.trim(), 'serverId')
    if (!current.servers.some(server => server.id === id)) {
      throw new Error('dsh-plugin-desktop: Frontend Server id does not exist')
    }
    const next: DesktopFrontendDeploymentState = {
      version: 4,
      role: 'frontend',
      activeServerId: id,
      servers: current.servers,
      presentation: current.presentation,
    }
    await this.persist(next)
    return next
  }

  async removeFrontend(serverId: string): Promise<DesktopDeploymentState> {
    const current = await this.load()
    if (current.servers.length === 0) throw new Error('dsh-plugin-desktop: no Frontend Servers are configured')
    const id = nonEmptyString(serverId.trim(), 'serverId')
    const servers = current.servers.filter(server => server.id !== id)
    if (servers.length === current.servers.length) {
      throw new Error('dsh-plugin-desktop: Frontend Server id does not exist')
    }
    if (servers.length === 0) {
      const next: DesktopServerDeploymentState = {
        version: 4,
        role: 'server',
        servers: [],
        presentation: current.presentation,
      }
      await this.persist(next)
      return next
    }
    const activeServerId = current.activeServerId !== undefined
      && servers.some(server => server.id === current.activeServerId)
      ? current.activeServerId
      : servers[0]!.id
    if (current.role === 'server') {
      const next: DesktopServerDeploymentState = {
        version: 4,
        role: 'server',
        activeServerId,
        servers,
        presentation: current.presentation,
      }
      await this.persist(next)
      return next
    }
    const next: DesktopFrontendDeploymentState = {
      ...current,
      servers,
      activeServerId,
    }
    await this.persist(next)
    return next
  }

  async exchange(server: DesktopFrontendServer): Promise<DesktopAccessSession> {
    if (server.authMode !== 'paired') {
      throw new Error('dsh-plugin-desktop: trusted tunnel Frontends do not exchange a paired credential')
    }
    if (!this.secrets.isEncryptionAvailable()) {
      throw new Error('dsh-plugin-desktop: operating-system credential encryption is unavailable')
    }
    const credential = this.secrets.decryptString(Buffer.from(server.encryptedCredential, 'base64'))
    const value = await this.remoteCall(new URL(server.endpoint), 'session.exchange', { credential })
    return parseAccessSession(value)
  }

  /** Prove that one configured Server serves the authenticated projection protocol. */
  async probe(server: DesktopFrontendServer, accessToken?: string): Promise<void> {
    const rpcId = crypto.randomUUID()
    const response = await this.request.fetch(new URL('/remote-sync/describe', server.endpoint), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` },
      },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'describe', payload: {} }),
    })
    if (!response.ok) {
      throw new Error(`dsh-plugin-desktop: Frontend Server probe failed: HTTP ${String(response.status)}`)
    }
    const envelope: unknown = await response.json()
    const record = objectRecord(envelope, 'remote sync response')
    if (record.rpcId !== rpcId) throw new Error('dsh-plugin-desktop: remote sync rpcId mismatch')
    const result = objectRecord(record.result, 'remote sync result')
    if (result.ok !== true) throw new Error('dsh-plugin-desktop: remote sync describe was rejected')
  }

  async useServer(): Promise<DesktopServerDeploymentState> {
    const current = await this.load()
    const next: DesktopServerDeploymentState = {
      version: 4,
      role: 'server',
      ...current.activeServerId === undefined ? {} : { activeServerId: current.activeServerId },
      servers: current.servers,
      presentation: current.presentation,
    }
    await this.persist(next)
    return next
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
    private readonly server: DesktopFrontendServer,
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
      const next = await this.store.exchange(this.server)
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

/**
 * Select the first actually reachable Server, preferring the persisted leader.
 * A failed candidate is never deleted; a later launch can qualify it again.
 */
export async function connectFrontendServer(
  store: DesktopDeploymentStateStore,
  state: DesktopFrontendDeploymentState,
  onCandidateError: (server: DesktopFrontendServer, error: unknown) => void = () => {},
): Promise<DesktopFrontendConnection> {
  const active = activeFrontendServer(state)
  const ordered = [active, ...state.servers.filter(server => server.id !== active.id)]
  const failures: Error[] = []
  for (const server of ordered) {
    const access = server.authMode === 'paired'
      ? new DesktopRemoteAccessSession(store, server, error => onCandidateError(server, error))
      : undefined
    try {
      await access?.start()
      await store.probe(server, access?.accessToken())
      const selected = server.id === state.activeServerId ? state : await store.selectFrontend(server.id)
      return { state: selected, server, ...access === undefined ? {} : { access } }
    } catch (error) {
      access?.stop()
      const failure = error instanceof Error ? error : new Error(String(error))
      failures.push(failure)
      onCandidateError(server, failure)
    }
  }
  throw new AggregateError(failures, 'dsh-plugin-desktop: no configured Frontend Server is reachable')
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

/** Resolve the selected Server from a validated Frontend deployment state. */
export function activeFrontendServer(state: DesktopFrontendDeploymentState): DesktopFrontendServer {
  const server = state.servers.find(candidate => candidate.id === state.activeServerId)
  if (server === undefined) throw new Error('dsh-plugin-desktop: active Frontend Server does not exist')
  return server
}

function parseDeploymentState(value: unknown): DesktopDeploymentState {
  const state = objectRecord(value, 'deployment state')
  if (state.version !== 1 && state.version !== 2 && state.version !== 3 && state.version !== 4) {
    throw new Error('dsh-plugin-desktop: unsupported deployment state version')
  }
  if (state.role === 'server') {
    if (state.version !== 4) return DEFAULT_STATE
    const presentation = parsePresentation(state.presentation)
    const servers = parseFrontendServers(state.servers, true)
    const activeServerId = state.activeServerId === undefined
      ? undefined
      : nonEmptyString(state.activeServerId, 'activeServerId')
    if (activeServerId !== undefined && !servers.some(server => server.id === activeServerId)) {
      throw new Error('dsh-plugin-desktop: active Frontend Server does not exist')
    }
    return {
      version: 4,
      role: 'server',
      ...activeServerId === undefined ? {} : { activeServerId },
      servers,
      presentation,
    }
  }
  if (state.role !== 'frontend') throw new Error('dsh-plugin-desktop: invalid deployment role')
  const presentation = parsePresentation(state.presentation)
  if (state.version === 3 || state.version === 4) {
    const servers = parseFrontendServers(state.servers, false)
    const activeServerId = nonEmptyString(state.activeServerId, 'activeServerId')
    if (!servers.some(server => server.id === activeServerId)) {
      throw new Error('dsh-plugin-desktop: active Frontend Server does not exist')
    }
    return { version: 4, role: 'frontend', activeServerId, servers, presentation }
  }
  const legacy = parseFrontendServer({
    id: 'legacy-default',
    label: new URL(nonEmptyString(state.endpoint, 'endpoint')).host,
    endpoint: state.endpoint,
    deviceName: state.deviceName,
    authMode: state.version === 1 ? 'paired' : state.authMode,
    encryptedCredential: state.encryptedCredential,
  })
  return {
    version: 4,
    role: 'frontend',
    activeServerId: legacy.id,
    servers: [legacy],
    presentation,
  }
}

function parsePresentation(value: unknown): DesktopShellMode {
  if (value !== 'compatibility' && value !== 'advanced') {
    throw new Error('dsh-plugin-desktop: invalid Frontend presentation mode')
  }
  return value
}

function parseFrontendServers(value: unknown, allowEmpty: boolean): DesktopFrontendServer[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error('dsh-plugin-desktop: Frontend Servers must be a non-empty array')
  }
  const servers = value.map(parseFrontendServer)
  if (new Set(servers.map(server => server.id)).size !== servers.length) {
    throw new Error('dsh-plugin-desktop: Frontend Server ids must be unique')
  }
  if (new Set(servers.map(server => server.endpoint)).size !== servers.length) {
    throw new Error('dsh-plugin-desktop: Frontend Server endpoints must be unique')
  }
  return servers
}

function parseFrontendServer(value: unknown): DesktopFrontendServer {
  const server = objectRecord(value, 'Frontend Server')
  const endpoint = parseEndpoint(nonEmptyString(server.endpoint, 'endpoint'))
  const base: DesktopFrontendServerBase = {
    id: nonEmptyString(server.id, 'server id'),
    label: nonEmptyString(server.label, 'server label'),
    endpoint: endpoint.href,
    deviceName: nonEmptyString(server.deviceName, 'deviceName'),
  }
  if (server.authMode === 'paired') {
    return {
      ...base,
      authMode: 'paired',
      encryptedCredential: nonEmptyString(server.encryptedCredential, 'encryptedCredential'),
    }
  }
  if (server.authMode === 'trusted-tunnel') {
    if (!isLoopbackEndpoint(endpoint)) {
      throw new Error('dsh-plugin-desktop: trusted tunnel Frontend endpoint must be loopback')
    }
    return { ...base, authMode: 'trusted-tunnel' }
  }
  throw new Error('dsh-plugin-desktop: invalid Frontend authentication mode')
}

function parseLabel(value: string | undefined, endpoint: URL): string {
  const label = value?.trim() || endpoint.host
  if (label.length > 100) throw new Error('dsh-plugin-desktop: Server label must contain 1 to 100 characters')
  return label
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
