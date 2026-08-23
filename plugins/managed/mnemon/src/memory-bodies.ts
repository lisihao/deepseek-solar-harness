import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MnemonRunner, MnemonTextCommand } from './runner.ts'
import type { MemoryPlacementCandidate } from './provider-placement.ts'
import {
  MEMORY_PROVIDER_CATALOG,
  isMemoryProviderId,
  memoryProviderDescriptor,
  normalizeProviderConnection,
  normalizeProviderMemoryConnection,
  normalizeProviderServiceConnection,
  publicProviderConnection,
  publicScopedProviderConnection,
  splitProviderConnection,
} from './providers/catalog.ts'
import type {
  CreateMemoryBodyRequest,
  MemoryBody,
  MemoryBodyProvider,
  MemoryPlacementDecision,
  MemoryProviderServiceCatalog,
  MemoryProviderServiceView,
  MemoryProviderConnection,
  MemoryProviderId,
  MemoryBodyMetadataUpdate,
  OpenVikingBodyConnection,
  UpdateMemoryBodyRequest,
} from './shared/contracts.ts'
import type { ProviderMemorySpace } from './providers/provider.ts'

export type { CreateMemoryBodyRequest, MemoryBody, UpdateMemoryBodyRequest } from './shared/contracts.ts'

const NATIVE_REGISTRY_VERSION = 1
const PROVIDER_REGISTRY_VERSION = 4
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

interface StoredOpenVikingConnection {
  endpoint: string
  targetUri: string
  apiKey: string
  account: string
  user: string
  actorPeerId: string
}

interface StoredMemoryBody extends Omit<MemoryBody, 'dbPath' | 'provider'> {
  providerId: MemoryProviderId
  /** Stable provider-side namespace used to refresh this local projection. */
  externalId?: string
  /** Controls whether discovery may refresh presentation metadata. */
  metadataSource?: 'provider' | 'manual' | 'ai'
  connection?: MemoryProviderConnection
  /** Provider-registry v1 compatibility; migrated to connection on load. */
  openViking?: StoredOpenVikingConnection
}

interface StoredNativeMemoryBody extends Omit<StoredMemoryBody, 'providerId' | 'connection' | 'openViking'> {}

interface NativeRegistryFile {
  version: 1
  bodies: StoredNativeMemoryBody[]
}

interface LegacyProviderRegistryFile {
  version: 2
  bodies: StoredMemoryBody[]
}

interface LegacyProviderRegistryFileOnDisk {
  version: 1 | 2
  bodies: StoredMemoryBody[]
}

interface ProviderRegistryFile {
  version: 4
  services: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
  enabled?: Partial<Record<MemoryProviderId, boolean>>
  bodies: StoredMemoryBody[]
}

interface LegacyProviderRegistryFileV3 {
  version: 3
  services: Partial<Record<MemoryProviderId, MemoryProviderConnection>>
  enabled?: Partial<Record<MemoryProviderId, boolean>>
  bodies: StoredMemoryBody[]
}

function requiredText(value: string, label: string, max: number): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`${label} is required`)
  if (normalized.length > max) throw new Error(`${label} is too long (max ${max} characters)`)
  return normalized
}

function optionalText(value: string | undefined, label: string, max: number): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length > max) throw new Error(`${label} is too long (max ${max} characters)`)
  return normalized
}

const PROVIDER_METADATA_KEYS = [
  'name', 'title', 'displayName', 'workspace', 'bankId', 'project', 'containerTag',
  'userId', 'user', 'workingDirectory', 'targetUri',
] as const

function compactProviderMetadataValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (normalized === '' || normalized === '*') return undefined
  const pathTail = normalized.split(/[/:\\]+/u).filter(Boolean).at(-1)
  return (pathTail ?? normalized).trim() || undefined
}

/**
 * Normalize uneven provider discovery metadata at the projection boundary.
 * Adapters map the richest native fields they know; the registry then tries
 * the nearest namespace setting before falling back to a stable provider
 * identity. This keeps every discovered namespace usable without teaching the
 * Web UI each provider's response shape.
 */
function providerProjectionMetadata(providerId: MemoryProviderId, candidate: ProviderMemorySpace): { name: string; description: string } {
  const descriptor = memoryProviderDescriptor(providerId)
  const externalId = requiredText(candidate.externalId, 'provider externalId', 2000)
  const mappedName = String(candidate.name ?? '').trim()
  const nearestName = PROVIDER_METADATA_KEYS
    .map(key => compactProviderMetadataValue(candidate.connection[key]))
    .find((value): value is string => value !== undefined)
  const fallbackId = compactProviderMetadataValue(externalId) ?? externalId
  const name = (mappedName || nearestName || `${descriptor.label} ${fallbackId}`).slice(0, 100)
  const mappedDescription = String(candidate.description ?? '').trim()
  const description = (mappedDescription || `${descriptor.label} memory namespace mapped from ${externalId}.`).slice(0, 1000)
  return {
    name: requiredText(name, 'name', 100),
    description: optionalText(description, 'description', 1000),
  }
}

function legacyOpenVikingConnection(connection: StoredOpenVikingConnection | OpenVikingBodyConnection): MemoryProviderConnection {
  return normalizeProviderConnection('openviking', connection as unknown as MemoryProviderConnection)
}

function normalizePlacementDecision(value: unknown, providerId: MemoryProviderId): MemoryPlacementDecision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const placement = value as Partial<MemoryPlacementDecision>
  if (placement.mode !== 'automatic' || placement.providerId !== providerId) return undefined
  if (placement.decidedBy !== 'rules' && placement.decidedBy !== 'llm') return undefined
  if (placement.confidence !== 'high' && placement.confidence !== 'medium' && placement.confidence !== 'low') return undefined
  if (typeof placement.reason !== 'string' || placement.reason.trim() === '' || placement.reason.length > 1000) return undefined
  if (!Array.isArray(placement.candidateProviderIds) || !placement.candidateProviderIds.every(isMemoryProviderId) || !placement.candidateProviderIds.includes(providerId)) return undefined
  if (!Array.isArray(placement.appliedRules) || !placement.appliedRules.every(rule => typeof rule === 'string' && rule.length <= 500)) return undefined
  if (typeof placement.decidedAt !== 'string' || placement.decidedAt.trim() === '') return undefined
  if (placement.runId !== undefined && typeof placement.runId !== 'string') return undefined
  if (placement.subagentProvider !== undefined && typeof placement.subagentProvider !== 'string') return undefined
  return {
    mode: 'automatic',
    providerId,
    decidedBy: placement.decidedBy,
    reason: placement.reason.trim(),
    confidence: placement.confidence,
    candidateProviderIds: [...new Set(placement.candidateProviderIds)],
    appliedRules: [...placement.appliedRules],
    decidedAt: placement.decidedAt,
    ...(placement.runId === undefined ? {} : { runId: placement.runId }),
    ...(placement.subagentProvider === undefined ? {} : { subagentProvider: placement.subagentProvider }),
  }
}

export function validateMemoryBodyId(value: string): string {
  const normalized = value.trim()
  if (!ID_PATTERN.test(normalized)) throw new Error('memoryBodyId must match [a-zA-Z0-9][a-zA-Z0-9_-]*')
  return normalized
}

/**
 * Persistent metadata layered over Mnemon's native named stores.
 *
 * Native metadata lives beside Store directories so existing Mnemon Packs stay
 * compatible. External connection metadata lives under state and is never
 * included in Memory Space Packs.
 */
export class MemoryBodyRegistry {
  readonly directory: string
  readonly registryPath: string
  readonly providerRegistryPath: string
  private bodies: StoredMemoryBody[] = []
  private services: Partial<Record<MemoryProviderId, MemoryProviderConnection>> = {}
  private serviceEnabled: Partial<Record<MemoryProviderId, boolean>> = {}

  constructor(
    readonly runner: MnemonRunner,
    private readonly persistent = runner.commandFound,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.directory = join(runner.effectiveDataDir(), 'data')
    this.registryPath = join(this.directory, '.dsh-memory-bodies.json')
    this.providerRegistryPath = join(runner.effectiveDataDir(), 'state', 'memory-providers.json')
    this.loadAndReconcile()
  }

  list(): MemoryBody[] {
    this.reconcileDiscoveredStores()
    return this.bodies.map(body => this.view(body))
  }

  active(): MemoryBody[] {
    return this.list().filter(body => body.active && (body.provider.id === 'mnemon-native' || this.providerServiceEnabled(body.provider.id)))
  }

  get(id: string): MemoryBody {
    const normalized = validateMemoryBodyId(id)
    const body = this.list().find(entry => entry.id === normalized)
    if (body === undefined) throw new Error(`unknown memory body: ${normalized}`)
    return body
  }

  openVikingConnection(id: string): OpenVikingBodyConnection {
    const connection = this.providerConnection(id, 'openviking')
    return {
      endpoint: String(connection.endpoint ?? ''),
      targetUri: String(connection.targetUri ?? ''),
      apiKey: String(connection.apiKey ?? ''),
      account: String(connection.account ?? ''),
      user: String(connection.user ?? ''),
      actorPeerId: String(connection.actorPeerId ?? ''),
    }
  }

  providerConnection(id: string, expectedProviderId?: MemoryProviderId): MemoryProviderConnection {
    const normalized = validateMemoryBodyId(id)
    const body = this.bodies.find(entry => entry.id === normalized)
    if (body === undefined || body.providerId === 'mnemon-native') throw new Error(`memory body has no external provider connection: ${normalized}`)
    if (expectedProviderId !== undefined && body.providerId !== expectedProviderId) {
      throw new Error(`memory body ${normalized} uses ${body.providerId}, not ${expectedProviderId}`)
    }
    const legacy = body.providerId === 'openviking' && body.openViking !== undefined
      ? legacyOpenVikingConnection(body.openViking)
      : undefined
    return normalizeProviderConnection(body.providerId, {
      ...(this.services[body.providerId] ?? {}),
      ...(legacy ?? {}),
      ...(body.connection ?? {}),
    })
  }

  providerServiceConfigured(providerId: MemoryProviderId): boolean {
    return providerId === 'mnemon-native' ? this.runner.commandFound : Object.hasOwn(this.services, providerId)
  }

  providerServiceEnabled(providerId: MemoryProviderId): boolean {
    return providerId === 'mnemon-native'
      ? this.runner.commandFound
      : this.providerServiceConfigured(providerId) && this.serviceEnabled[providerId] === true
  }

  providerServices(options: { includeSecrets?: boolean } = {}): MemoryProviderServiceCatalog {
    const providers = MEMORY_PROVIDER_CATALOG.filter(provider => provider.id !== 'mnemon-native')
    const items: MemoryProviderServiceView[] = providers.map(provider => {
      const connection = this.services[provider.id]
      const publicConnection = publicScopedProviderConnection(provider.id, 'service', connection ?? {})
      return {
        providerId: provider.id,
        enabled: this.providerServiceEnabled(provider.id),
        configured: connection !== undefined,
        ...publicConnection,
        ...(options.includeSecrets === true && connection !== undefined
          ? { secretValues: Object.fromEntries(publicConnection.configuredSecrets.map(key => [key, connection[key]!])) }
          : {}),
      }
    })
    return { providers: [...providers], items, generatedAt: this.now().toISOString() }
  }

  updateProviderService(providerId: MemoryProviderId, settings: MemoryProviderConnection, clearSecrets: readonly string[] = [], enabled = true): MemoryProviderServiceView {
    if (providerId === 'mnemon-native') throw new Error('Mnemon Native service settings are managed by the native configuration')
    const previous = this.services[providerId] ?? {}
    this.services[providerId] = normalizeProviderServiceConnection(providerId, settings, previous, clearSecrets)
    this.serviceEnabled[providerId] = enabled
    // Third-party Memory Spaces are local projections of provider-owned
    // namespaces. Once the provider is disconnected those projections are no
    // longer addressable and must not linger as unhealthy, uneditable cards.
    // Keep only the reusable service configuration so reconnecting can
    // discover and rebuild the projections from the source of truth.
    if (!enabled) this.bodies = this.bodies.filter(body => body.providerId !== providerId)
    this.save()
    return this.providerServices().items.find(item => item.providerId === providerId)!
  }

  resolveProviderService(providerId: MemoryProviderId, settings: MemoryProviderConnection, clearSecrets: readonly string[] = []): MemoryProviderConnection {
    if (providerId === 'mnemon-native') throw new Error('Mnemon Native service settings are managed by the native configuration')
    return normalizeProviderServiceConnection(providerId, settings, this.services[providerId] ?? {}, clearSecrets)
  }

  /** Atomically replace one provider's local projections after authoritative discovery. */
  syncProviderService(providerId: MemoryProviderId, service: MemoryProviderConnection, discovered: readonly ProviderMemorySpace[]): MemoryProviderServiceView {
    if (providerId === 'mnemon-native') throw new Error('Mnemon Native Stores are discovered from disk')
    let normalizedService = normalizeProviderServiceConnection(providerId, service)
    const seen = new Set<string>()
    const existing = this.bodies.filter(body => body.providerId === providerId)
    const reservedIds = new Set(this.bodies.filter(body => body.providerId !== providerId).map(body => body.id))
    const timestamp = this.now().toISOString()
    const projections = discovered.map(candidate => {
      const externalId = requiredText(candidate.externalId, 'provider externalId', 2000)
      if (seen.has(externalId)) throw new Error(`${memoryProviderDescriptor(providerId).label} returned a duplicate memory namespace: ${externalId}`)
      seen.add(externalId)
      const connection = normalizeProviderMemoryConnection(providerId, candidate.connection)
      normalizeProviderConnection(providerId, { ...normalizedService, ...connection })
      const previous = existing.find(body => body.externalId === externalId)
      let id = previous?.id ?? validateMemoryBodyId(`${providerId}-${createHash('sha256').update(externalId).digest('hex').slice(0, 24)}`)
      let suffix = 1
      while (reservedIds.has(id)) {
        id = validateMemoryBodyId(`${providerId}-${createHash('sha256').update(`${externalId}:${suffix}`).digest('hex').slice(0, 24)}`)
        suffix += 1
      }
      reservedIds.add(id)
      const metadata = providerProjectionMetadata(providerId, candidate)
      const metadataSource = previous?.metadataSource ?? (previous === undefined ? 'provider' : 'manual')
      const preserveLocalMetadata = previous !== undefined && metadataSource !== 'provider'
      return {
        id,
        externalId,
        // Discovery owns initial presentation metadata. Once a user or AI has
        // curated it, reconnect only refreshes provider identity and settings.
        name: preserveLocalMetadata ? previous.name : metadata.name,
        description: preserveLocalMetadata ? previous.description : metadata.description,
        metadataSource,
        active: previous?.active ?? true,
        providerId,
        connection,
        createdAt: previous?.createdAt ?? timestamp,
        updatedAt: timestamp,
      } satisfies StoredMemoryBody
    })
    // ByteRover cannot enumerate arbitrary working directories. Once its
    // singleton directory has been discovered, promote it to the reusable
    // service location so a later disconnect can rebuild the same mapping.
    if (providerId === 'byterover' && String(normalizedService.defaultDirectory ?? '').trim() === '') {
      const directory = projections[0]?.connection?.workingDirectory
      if (typeof directory === 'string' && directory.trim() !== '') {
        normalizedService = normalizeProviderServiceConnection(providerId, { ...normalizedService, defaultDirectory: directory })
      }
    }
    this.services[providerId] = normalizedService
    this.serviceEnabled[providerId] = true
    this.bodies = [...this.bodies.filter(body => body.providerId !== providerId), ...projections]
    this.save()
    return this.providerServices().items.find(item => item.providerId === providerId)!
  }

  placementCandidates(request: Pick<CreateMemoryBodyRequest, 'connection' | 'providerConnections' | 'openViking'>): MemoryPlacementCandidate[] {
    return MEMORY_PROVIDER_CATALOG.map(descriptor => {
      const requestConnection = request.providerConnections?.[descriptor.id]
        ?? (descriptor.id === 'openviking' && request.connection === undefined && request.openViking !== undefined
        ? request.openViking as unknown as MemoryProviderConnection
        : request.connection)
      let configured = descriptor.id === 'mnemon-native' ? this.runner.commandFound : false
      if (descriptor.id !== 'mnemon-native' && (requestConnection !== undefined || this.providerServiceConfigured(descriptor.id))) {
        try {
          const split = splitProviderConnection(descriptor.id, requestConnection)
          normalizeProviderConnection(descriptor.id, { ...(this.services[descriptor.id] ?? {}), ...split.service, ...split.memory })
          configured = Object.keys(split.service).length > 0 || this.providerServiceEnabled(descriptor.id)
        } catch { configured = false }
      }
      return {
        id: descriptor.id,
        label: descriptor.label,
        kind: descriptor.kind,
        configured,
        summary: descriptor.summary,
        capabilities: descriptor.capabilities,
      }
    })
  }

  async create(request: CreateMemoryBodyRequest, signal?: AbortSignal, placement?: MemoryPlacementDecision): Promise<MemoryBody> {
    const name = requiredText(request.name, 'name', 100)
    const description = requiredText(request.description, 'description', 1000)
    if (request.placement !== undefined && placement === undefined) throw new Error('automatic provider placement must be resolved before creating a Memory Space')
    if (placement !== undefined && request.providerId !== undefined && request.providerId !== placement.providerId) throw new Error('resolved provider placement conflicts with providerId')
    const providerId = placement?.providerId ?? request.providerId ?? 'mnemon-native'
    if (!isMemoryProviderId(providerId)) throw new Error(`unsupported memory provider: ${String(providerId)}`)
    const normalizedPlacement = placement === undefined ? undefined : normalizePlacementDecision(placement, providerId)
    if (placement !== undefined && normalizedPlacement === undefined) throw new Error('resolved provider placement is invalid')
    const reservedIds = new Set(this.list().map(body => body.id))
    const nativeStoreIds = this.nativeStoreIds()
    let id = providerId === 'mnemon-native' && nativeStoreIds.length === 0 && !reservedIds.has('default')
      ? 'default'
      : validateMemoryBodyId(providerId === 'mnemon-native' ? randomUUID() : `${providerId}-${randomUUID()}`)
    while (reservedIds.has(id) || nativeStoreIds.includes(id)) id = validateMemoryBodyId(randomUUID())
    const connectionInput = request.providerConnections?.[providerId]
      ?? (providerId === 'openviking' && request.connection === undefined && request.openViking !== undefined
      ? request.openViking as unknown as MemoryProviderConnection
      : request.connection)
    let connection: MemoryProviderConnection | undefined
    if (providerId !== 'mnemon-native') {
      const split = splitProviderConnection(providerId, connectionInput)
      if (Object.keys(split.service).length > 0) {
        this.services[providerId] = normalizeProviderServiceConnection(providerId, split.service, this.services[providerId] ?? {})
        this.serviceEnabled[providerId] = true
      }
      if (!this.providerServiceEnabled(providerId)) throw new Error(`${memoryProviderDescriptor(providerId).label} service is not enabled; enable it in Settings first`)
      connection = normalizeProviderMemoryConnection(providerId, split.memory)
      normalizeProviderConnection(providerId, { ...this.services[providerId], ...connection })
    }
    if (providerId === 'mnemon-native') await this.runner.runText(['store', 'create', id], { ...(signal === undefined ? {} : { signal }), store: id })
    const timestamp = this.now().toISOString()
    const body: StoredMemoryBody = {
      id,
      name,
      description,
      active: request.active ?? false,
      providerId,
      ...(providerId === 'mnemon-native' ? {} : { metadataSource: 'manual' as const }),
      ...(normalizedPlacement === undefined ? {} : { placement: normalizedPlacement }),
      ...(connection === undefined ? {} : { connection }),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.bodies.push(body)
    this.save()
    return this.view(body)
  }

  update(id: string, request: UpdateMemoryBodyRequest): MemoryBody {
    const normalized = validateMemoryBodyId(id)
    const index = this.bodies.findIndex(body => body.id === normalized)
    if (index < 0) throw new Error(`unknown memory body: ${normalized}`)
    const current = this.bodies[index]!
    if (request.openViking !== undefined && current.providerId !== 'openviking') throw new Error('OpenViking connection settings only apply to OpenViking memory bodies')
    if ((request.connection !== undefined || request.clearSecrets !== undefined) && current.providerId === 'mnemon-native') {
      throw new Error('Mnemon Native memory bodies do not have provider connection settings')
    }
    const legacyPatch = request.openViking === undefined ? undefined : {
      ...request.openViking,
      ...(request.openViking.clearApiKey === true ? { apiKey: '' } : {}),
    } as unknown as MemoryProviderConnection
    const previousConnection = current.providerId === 'mnemon-native' ? {} : current.connection ?? {}
    const connectionPatch = request.connection ?? legacyPatch
    let connection: MemoryProviderConnection | undefined
    if (current.providerId !== 'mnemon-native') {
      const split = splitProviderConnection(current.providerId, connectionPatch)
      const clearSecrets = [...(request.clearSecrets ?? []), ...(request.openViking?.clearApiKey === true ? ['apiKey'] : [])]
      if (Object.keys(split.service).length > 0 || clearSecrets.length > 0) {
        this.services[current.providerId] = normalizeProviderServiceConnection(current.providerId, split.service, this.services[current.providerId] ?? {}, clearSecrets)
        this.serviceEnabled[current.providerId] = true
      }
      if (!this.providerServiceEnabled(current.providerId)) throw new Error(`${memoryProviderDescriptor(current.providerId).label} service is not enabled; enable it in Settings first`)
      connection = normalizeProviderMemoryConnection(current.providerId, split.memory, previousConnection)
      normalizeProviderConnection(current.providerId, { ...this.services[current.providerId], ...connection })
    }
    const { openViking: _legacyOpenViking, ...currentBody } = current
    const body: StoredMemoryBody = {
      ...currentBody,
      ...(request.name === undefined ? {} : { name: requiredText(request.name, 'name', 100) }),
      ...(request.description === undefined ? {} : { description: optionalText(request.description, 'description', 1000) }),
      ...(request.active === undefined ? {} : { active: request.active }),
      ...(current.providerId === 'mnemon-native' || (request.name === undefined && request.description === undefined) ? {} : { metadataSource: 'manual' as const }),
      ...(connection === undefined ? {} : { connection }),
      updatedAt: this.now().toISOString(),
    }
    this.bodies[index] = body
    this.save()
    return this.view(body)
  }

  /** Validate every model-authored update before committing the batch. */
  updateMetadata(updates: readonly MemoryBodyMetadataUpdate[]): MemoryBody[] {
    if (updates.length === 0 || updates.length > 20) throw new Error('metadata maintenance requires 1 through 20 Memory Spaces')
    const seen = new Set<string>()
    const replacements = updates.map(update => {
      const id = validateMemoryBodyId(update.memoryBodyId)
      if (seen.has(id)) throw new Error(`duplicate metadata update: ${id}`)
      seen.add(id)
      const index = this.bodies.findIndex(body => body.id === id)
      if (index < 0) throw new Error(`unknown memory body: ${id}`)
      return {
        index,
        body: {
          ...this.bodies[index]!,
          name: requiredText(update.title, 'title', 48),
          description: requiredText(update.description, 'description', 200),
          metadataSource: 'ai',
          updatedAt: this.now().toISOString(),
        } satisfies StoredMemoryBody,
      }
    })
    for (const replacement of replacements) this.bodies[replacement.index] = replacement.body
    this.save()
    return replacements.map(replacement => this.view(replacement.body))
  }

  async remove(id: string, signal?: AbortSignal): Promise<MemoryBody> {
    const body = this.get(id)
    if (body.provider.id !== 'mnemon-native') {
      this.bodies = this.bodies.filter(entry => entry.id !== body.id)
      this.save()
      return body
    }
    const nativeStoreIds = this.nativeStoreIds()
    if (nativeStoreIds.includes(body.id) && nativeStoreIds.length === 1) {
      throw new Error(`cannot delete the last Mnemon Store "${body.id}"; disable it for DSH or create another Memory Space first`)
    }
    const persistedStore = this.runner.persistedStore()
    const commands: MnemonTextCommand[] = []
    let commandStore = persistedStore
    if (persistedStore === body.id) {
      const nativeIds = new Set(nativeStoreIds)
      const replacement = this.list()
        .filter(candidate => candidate.id !== body.id && nativeIds.has(candidate.id))
        .sort((left, right) => Number(right.active) - Number(left.active) || left.id.localeCompare(right.id))[0]?.id
        ?? nativeStoreIds.filter(candidate => candidate !== body.id).sort()[0]
      if (replacement === undefined) throw new Error(`cannot switch away from Mnemon Store "${body.id}" before deleting it`)
      commandStore = replacement
      commands.push({
        args: ['store', 'set', replacement],
        options: { ...(signal === undefined ? {} : { signal }), store: replacement },
      })
    }
    commands.push({
      args: ['store', 'remove', body.id],
      // Mnemon treats --store as the active Store even for `store remove`.
      // Keep the deletion target out of command context or every removal fails.
      options: { ...(signal === undefined ? {} : { signal }), store: commandStore },
    })
    await this.runner.runTextBatch(commands)
    this.bodies = this.bodies.filter(entry => entry.id !== body.id)
    this.save()
    return body
  }

  setActive(id: string, active: boolean): MemoryBody {
    return this.update(id, { active })
  }

  /** Refresh metadata after an atomic Pack import replaced the data component. */
  reload(): void {
    this.bodies = []
    this.services = {}
    this.serviceEnabled = {}
    this.loadAndReconcile()
  }

  private loadAndReconcile(): void {
    let migratedSyntheticDefault = false
    let migratedProviderRegistry = false
    if (this.persistent && existsSync(this.registryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8')) as NativeRegistryFile | LegacyProviderRegistryFile
        if ((parsed.version === NATIVE_REGISTRY_VERSION || parsed.version === 2) && Array.isArray(parsed.bodies)) {
          migratedProviderRegistry = parsed.version === 2
          this.bodies = parsed.bodies.filter(body => ID_PATTERN.test(body.id)).map(body => {
            // Earlier dsh-mnemon builds gave an already-existing upstream
            // `default` Store a synthetic Chinese product name. That made a
            // compatibility import look like a newly-created default Memory
            // Space. Preserve the Store and its activation state, but restore
            // its neutral on-disk identity.
            const syntheticDefault = body.id === 'default'
              && body.name === '默认记忆体'
              && body.description === '从现有 Mnemon Store 自动接入。'
            migratedSyntheticDefault ||= syntheticDefault
            const providerId: MemoryProviderId = 'providerId' in body && isMemoryProviderId(body.providerId) ? body.providerId : 'mnemon-native'
            const placement = 'placement' in body ? normalizePlacementDecision(body.placement, providerId) : undefined
            const rawConnection = 'connection' in body && body.connection != null
              ? body.connection as MemoryProviderConnection
              : providerId === 'openviking' && 'openViking' in body && body.openViking != null
                ? body.openViking as unknown as MemoryProviderConnection
                : undefined
            const split = providerId === 'mnemon-native' ? undefined : splitProviderConnection(providerId, rawConnection)
            if (split !== undefined && this.services[providerId] === undefined) {
              this.services[providerId] = normalizeProviderServiceConnection(providerId, split.service)
              this.serviceEnabled[providerId] = true
            }
            const connection = split === undefined ? undefined : normalizeProviderMemoryConnection(providerId, split.memory)
            if (connection !== undefined) normalizeProviderConnection(providerId, { ...this.services[providerId], ...connection })
            return {
              id: body.id,
              name: requiredText(syntheticDefault ? body.id : body.name || body.id, 'name', 100),
              description: optionalText(syntheticDefault ? 'Existing Mnemon Store discovered on disk.' : body.description, 'description', 1000),
              active: body.active === true,
              providerId,
              ...(placement === undefined ? {} : { placement }),
              ...(connection === undefined ? {} : { connection }),
              createdAt: body.createdAt,
              updatedAt: body.updatedAt,
            }
          })
        }
      } catch {
        // Rebuild a valid catalog from native stores without touching their DBs.
        this.bodies = []
      }
    }
    if (this.persistent && existsSync(this.providerRegistryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.providerRegistryPath, 'utf8')) as ProviderRegistryFile | LegacyProviderRegistryFileV3 | LegacyProviderRegistryFileOnDisk
        if ((parsed.version === 3 || parsed.version === PROVIDER_REGISTRY_VERSION) && typeof parsed.services === 'object' && parsed.services !== null) {
          for (const [providerId, settings] of Object.entries(parsed.services)) {
            if (!isMemoryProviderId(providerId) || providerId === 'mnemon-native' || typeof settings !== 'object' || settings === null) continue
            this.services[providerId] = normalizeProviderServiceConnection(providerId, settings)
            this.serviceEnabled[providerId] = parsed.enabled === undefined ? true : parsed.enabled[providerId] === true
          }
        }
        if ((parsed.version === 1 || parsed.version === 2 || parsed.version === 3 || parsed.version === PROVIDER_REGISTRY_VERSION) && Array.isArray(parsed.bodies)) {
          migratedProviderRegistry ||= parsed.version !== PROVIDER_REGISTRY_VERSION
          const existingIds = new Set(this.bodies.map(body => body.id))
          this.bodies.push(...parsed.bodies
            .filter(body => isMemoryProviderId(body.providerId) && body.providerId !== 'mnemon-native' && ID_PATTERN.test(body.id) && !existingIds.has(body.id))
            .map(body => {
              const providerId = body.providerId
              const placement = normalizePlacementDecision(body.placement, providerId)
              const rawConnection = body.connection ?? (providerId === 'openviking' && body.openViking !== undefined
                ? body.openViking as unknown as MemoryProviderConnection
                : undefined)
              const split = parsed.version === 3 || parsed.version === PROVIDER_REGISTRY_VERSION
                ? { service: {}, memory: rawConnection ?? {} }
                : splitProviderConnection(providerId, rawConnection)
              if (parsed.version !== 3 && parsed.version !== PROVIDER_REGISTRY_VERSION && this.services[providerId] === undefined) {
                this.services[providerId] = normalizeProviderServiceConnection(providerId, split.service)
                this.serviceEnabled[providerId] = true
              }
              const connection = normalizeProviderMemoryConnection(providerId, split.memory)
              normalizeProviderConnection(providerId, { ...this.services[providerId], ...connection })
              return {
                id: body.id,
                name: requiredText(body.name || body.id, 'name', 100),
                description: optionalText(body.description, 'description', 1000),
                active: body.active === true,
                providerId,
                ...(typeof body.externalId !== 'string' || body.externalId.trim() === '' ? {} : { externalId: body.externalId.trim() }),
                ...(body.metadataSource === 'provider' || body.metadataSource === 'manual' || body.metadataSource === 'ai' ? { metadataSource: body.metadataSource } : {}),
                ...(placement === undefined ? {} : { placement }),
                connection,
                createdAt: body.createdAt,
                updatedAt: body.updatedAt,
              }
            }))
        }
      } catch {
        // Ignore an invalid optional provider registry; native Stores remain usable.
      }
    }
    const retainedBodies = this.bodies.filter(body => body.providerId === 'mnemon-native' || this.providerServiceEnabled(body.providerId))
    if (retainedBodies.length !== this.bodies.length) {
      this.bodies = retainedBodies
      migratedProviderRegistry = true
    }
    this.reconcileDiscoveredStores()
    if (migratedSyntheticDefault || migratedProviderRegistry) this.save()
  }

  private reconcileDiscoveredStores(): void {
    if (!this.persistent || !existsSync(this.directory)) return
    const timestamp = this.now().toISOString()
    const legacyActive = this.runner.effectiveStore()
    let changed = false
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID_PATTERN.test(entry.name) || !existsSync(join(this.directory, entry.name, 'mnemon.db'))) continue
      if (this.bodies.some(body => body.id === entry.name)) continue
      this.bodies.push({
        id: entry.name,
        name: entry.name,
        description: 'Existing Mnemon Store discovered on disk.',
        active: this.bodies.length === 0 || entry.name === legacyActive,
        providerId: 'mnemon-native',
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      changed = true
    }
    if (changed) this.save()
  }

  private nativeStoreIds(): string[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && ID_PATTERN.test(entry.name))
      .map(entry => entry.name)
      .sort()
  }

  private view(body: StoredMemoryBody): MemoryBody {
    const descriptor = memoryProviderDescriptor(body.providerId)
    const connection = body.providerId === 'mnemon-native' ? {} : this.providerConnection(body.id)
    const effectivePublicConnection = publicProviderConnection(body.providerId, connection)
    const publicConnection = body.providerId === 'mnemon-native'
      ? effectivePublicConnection
      : publicScopedProviderConnection(body.providerId, 'memory', body.connection ?? {})
    const location = body.providerId === 'mnemon-native'
      ? join(this.directory, body.id, 'mnemon.db')
      : String(connection.endpoint ?? connection.workingDirectory ?? connection.dataPath ?? connection.defaultDirectory ?? connection.cliPath ?? '')
    const provider: MemoryBodyProvider = {
      id: descriptor.id,
      label: descriptor.label,
      kind: descriptor.kind,
      location,
      ...(typeof connection.targetUri === 'string' && connection.targetUri !== '' ? { targetUri: connection.targetUri } : {}),
      ...(typeof connection.account === 'string' && connection.account !== '' ? { account: connection.account } : {}),
      ...(typeof connection.user === 'string' && connection.user !== '' ? { user: connection.user } : {}),
      ...(typeof connection.actorPeerId === 'string' && connection.actorPeerId !== '' ? { actorPeerId: connection.actorPeerId } : {}),
      apiKeyConfigured: effectivePublicConnection.configuredSecrets.includes('apiKey'),
      ...publicConnection,
      capabilities: descriptor.capabilities,
    }
    const { providerId: _providerId, externalId: _externalId, metadataSource: _metadataSource, connection: _connection, openViking: _openViking, ...metadata } = body
    return { ...metadata, dbPath: provider.id === 'mnemon-native' ? provider.location : '', provider }
  }

  private save(): void {
    if (!this.persistent) return
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const nativeBodies: StoredNativeMemoryBody[] = this.bodies
      .filter(body => body.providerId === 'mnemon-native')
      .map(({ providerId: _providerId, connection: _connection, openViking: _openViking, ...body }) => body)
    this.writeRegistry(this.registryPath, { version: NATIVE_REGISTRY_VERSION, bodies: nativeBodies })

    const providerBodies = this.bodies.filter(body => body.providerId !== 'mnemon-native')
    if (providerBodies.length === 0 && Object.keys(this.services).length === 0) {
      rmSync(this.providerRegistryPath, { force: true })
      return
    }
    mkdirSync(join(this.runner.effectiveDataDir(), 'state'), { recursive: true, mode: 0o700 })
    this.writeRegistry(this.providerRegistryPath, { version: PROVIDER_REGISTRY_VERSION, services: this.services, enabled: this.serviceEnabled, bodies: providerBodies })
  }

  private writeRegistry(path: string, file: NativeRegistryFile | ProviderRegistryFile): void {
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, path)
  }
}
