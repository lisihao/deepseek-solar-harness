import type {
  MemoryProviderCapabilities,
  MemoryProviderConfigField,
  MemoryProviderConnection,
  MemoryProviderDescriptor,
  MemoryProviderId,
} from '../shared/contracts.ts'

const NATIVE_CAPABILITIES: MemoryProviderCapabilities = {
  search: true,
  browse: true,
  graph: true,
  entities: true,
  related: true,
  remember: true,
  link: true,
  forget: true,
  writeMode: 'exact',
  deletionMode: 'soft',
}

const REMOTE_EXACT_CAPABILITIES: MemoryProviderCapabilities = {
  search: true,
  browse: true,
  graph: false,
  entities: false,
  related: false,
  remember: true,
  link: false,
  forget: true,
  writeMode: 'exact',
  deletionMode: 'hard',
}

const field = (value: MemoryProviderConfigField): MemoryProviderConfigField => value

export const MEMORY_PROVIDER_IDS = [
  'mnemon-native',
  'openviking',
  'honcho',
  'mem0',
  'hindsight',
  'holographic',
  'retaindb',
  'byterover',
  'supermemory',
] as const satisfies readonly MemoryProviderId[]

export const MEMORY_PROVIDER_ID_SET = new Set<MemoryProviderId>(MEMORY_PROVIDER_IDS)

export const MEMORY_PROVIDER_CATALOG: readonly MemoryProviderDescriptor[] = [
  {
    id: 'mnemon-native',
    label: 'mnemon',
    kind: 'local',
    workspaceBinding: 'automatic',
    summary: 'Official local-first memory with exact writes, typed graph relations, and soft deletion.',
    origin: 'native',
    capabilities: NATIVE_CAPABILITIES,
    fields: [],
  },
  {
    id: 'openviking',
    label: 'OpenViking',
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Filesystem-shaped shared memory with tiered reads and automatic semantic extraction.',
    origin: 'third-party',
    capabilities: {
      ...REMOTE_EXACT_CAPABILITIES,
      writeMode: 'async-extracting',
    },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'http://127.0.0.1:1933', placeholder: 'http://127.0.0.1:1933' }),
      field({ key: 'targetUri', label: 'Memory URI', scope: 'memory', input: 'text', required: true, defaultValue: 'viking://user/memories', placeholder: 'viking://user/memories' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'account', label: 'Account', scope: 'service', input: 'text', required: false }),
      field({ key: 'user', label: 'User', scope: 'memory', input: 'text', required: false }),
      field({ key: 'actorPeerId', label: 'Agent peer', scope: 'memory', input: 'text', required: false, defaultValue: 'dsh' }),
    ],
  },
  {
    id: 'honcho',
    label: 'Honcho',
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Cross-session user modelling, peer profiles, dialectic reasoning, and persistent conclusions.',
    origin: 'third-party',
    capabilities: REMOTE_EXACT_CAPABILITIES,
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.honcho.dev' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'workspace', label: 'Workspace', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'userId', label: 'User peer', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user' }),
      field({ key: 'agentId', label: 'Agent peer', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
    ],
  },
  {
    id: 'mem0',
    label: 'Mem0',
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Automatic fact extraction, semantic retrieval, reranking, and deduplication.',
    origin: 'third-party',
    capabilities: { ...REMOTE_EXACT_CAPABILITIES, writeMode: 'async-extracting' },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.mem0.ai' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'mode', label: 'Mode', scope: 'service', input: 'select', required: true, defaultValue: 'platform', options: [{ value: 'platform', label: 'Mem0 Platform' }, { value: 'self-hosted', label: 'Self-hosted server' }] }),
      field({ key: 'userId', label: 'User ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user' }),
      field({ key: 'agentId', label: 'Agent ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'rerank', label: 'Rerank search results', scope: 'memory', input: 'boolean', required: false, defaultValue: false }),
    ],
  },
  {
    id: 'hindsight',
    label: 'Hindsight',
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Knowledge-graph memory with entity resolution, observations, multi-strategy recall, and reflection.',
    origin: 'third-party',
    capabilities: {
      ...REMOTE_EXACT_CAPABILITIES,
      graph: true,
      entities: true,
      related: true,
      writeMode: 'async-extracting',
      deletionMode: 'soft',
    },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.hindsight.vectorize.io' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: false }),
      field({ key: 'bankId', label: 'Memory bank', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'budget', label: 'Recall budget', scope: 'memory', input: 'select', required: true, defaultValue: 'mid', options: [{ value: 'low', label: 'Low' }, { value: 'mid', label: 'Medium' }, { value: 'high', label: 'High' }] }),
    ],
  },
  {
    id: 'holographic',
    label: 'Holographic',
    kind: 'local',
    workspaceBinding: 'optional-override',
    summary: 'Local structured fact memory with trust scoring, entity resolution, and compositional retrieval.',
    origin: 'third-party',
    capabilities: {
      ...NATIVE_CAPABILITIES,
      link: false,
      deletionMode: 'hard',
    },
    fields: [
      field({ key: 'dataPath', label: 'Fact store path', scope: 'service', role: 'global-location', input: 'path', required: false }),
      field({ key: 'defaultTrust', label: 'Default trust', scope: 'memory', input: 'number', required: true, defaultValue: 0.5 }),
      field({ key: 'minTrust', label: 'Minimum recall trust', scope: 'memory', input: 'number', required: true, defaultValue: 0.3 }),
    ],
  },
  {
    id: 'retaindb',
    label: 'RetainDB',
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Cloud memory with hybrid vector/BM25 retrieval, profiles, and typed durable facts.',
    origin: 'third-party',
    capabilities: REMOTE_EXACT_CAPABILITIES,
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.retaindb.com' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: true }),
      field({ key: 'project', label: 'Project', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'userId', label: 'User ID', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh-user' }),
    ],
  },
  {
    id: 'byterover',
    label: 'ByteRover',
    kind: 'local',
    workspaceBinding: 'optional-override',
    summary: 'Local-first hierarchical knowledge tree accessed through the brv CLI.',
    origin: 'third-party',
    capabilities: {
      ...REMOTE_EXACT_CAPABILITIES,
      browse: false,
      forget: false,
      writeMode: 'async-extracting',
      deletionMode: 'unsupported',
    },
    fields: [
      field({ key: 'cliPath', label: 'brv executable', scope: 'service', input: 'path', required: false, defaultValue: 'brv' }),
      field({ key: 'defaultDirectory', label: 'Default knowledge directory', scope: 'service', role: 'global-location', input: 'path', required: false }),
      field({ key: 'workingDirectory', label: 'Knowledge directory', scope: 'memory', input: 'path', required: false }),
      field({ key: 'apiKey', label: 'Cloud API key', scope: 'service', input: 'secret', required: false }),
    ],
  },
  {
    id: 'supermemory',
    label: 'Supermemory',
    kind: 'remote',
    workspaceBinding: 'provider-global',
    summary: 'Semantic memory, persistent profiles, conversation ingest, and multi-container recall.',
    origin: 'third-party',
    capabilities: { ...REMOTE_EXACT_CAPABILITIES, writeMode: 'async-extracting', deletionMode: 'soft' },
    fields: [
      field({ key: 'endpoint', label: 'Endpoint', scope: 'service', input: 'url', required: true, defaultValue: 'https://api.supermemory.ai' }),
      field({ key: 'apiKey', label: 'API key', scope: 'service', input: 'secret', required: true }),
      field({ key: 'containerTag', label: 'Container tag', scope: 'memory', input: 'text', required: true, defaultValue: 'dsh' }),
      field({ key: 'searchMode', label: 'Search mode', scope: 'memory', input: 'select', required: true, defaultValue: 'hybrid', options: [{ value: 'hybrid', label: 'Hybrid' }, { value: 'memories', label: 'Memories' }, { value: 'documents', label: 'Documents' }] }),
    ],
  },
]

export function memoryProviderDescriptor(id: MemoryProviderId): MemoryProviderDescriptor {
  const descriptor = MEMORY_PROVIDER_CATALOG.find(candidate => candidate.id === id)
  if (descriptor === undefined) throw new Error(`unsupported memory provider: ${String(id)}`)
  return descriptor
}

export function isMemoryProviderId(value: unknown): value is MemoryProviderId {
  return typeof value === 'string' && MEMORY_PROVIDER_ID_SET.has(value as MemoryProviderId)
}

function normalizeUrl(value: string, label: string): string {
  const normalized = value.trim().replace(/\/+$/u, '')
  let url: URL
  try { url = new URL(normalized) } catch { throw new Error(`${label} must be a valid http(s) URL`) }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label} must use http or https`)
  if (url.username !== '' || url.password !== '') throw new Error(`${label} must not contain credentials`)
  return normalized
}

function normalizeString(value: unknown, field: MemoryProviderConfigField): string {
  const normalized = typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value).trim()
  if (normalized.length > (field.input === 'secret' ? 8000 : 2000)) throw new Error(`${field.label} is too long`)
  if (field.required && normalized === '') throw new Error(`${field.label} is required`)
  if (field.input === 'url' && normalized !== '') return normalizeUrl(normalized, field.label)
  if (field.options !== undefined && normalized !== '' && !field.options.some(option => option.value === normalized)) {
    throw new Error(`${field.label} has an unsupported value`)
  }
  return normalized
}

function validateProviderSpecific(providerId: MemoryProviderId, output: MemoryProviderConnection): void {
  if (providerId === 'openviking' && output.targetUri !== undefined) {
    const targetUri = String(output.targetUri).replace(/\/+$/u, '')
    if (!/^viking:\/\/user(?:\/[^/]+)?\/memories$/u.test(targetUri)) {
      throw new Error('OpenViking memory URI must be a viking://user/.../memories root')
    }
    output.targetUri = targetUri
  }
  if (providerId === 'holographic') {
    for (const key of ['defaultTrust', 'minTrust'] as const) {
      if (output[key] === undefined) continue
      const value = Number(output[key])
      if (value < 0 || value > 1) throw new Error(`${key} must be within 0..1`)
    }
  }
  if (providerId === 'supermemory' && output.containerTag !== undefined) {
    const containerTag = String(output.containerTag)
    if (!/^[a-zA-Z0-9_:-]+$/u.test(containerTag) || containerTag.length > 100) {
      throw new Error('Supermemory container tag may contain only letters, numbers, _, :, and - (max 100 characters)')
    }
  }
}

function normalizeScopedProviderConnection(
  providerId: MemoryProviderId,
  scope: MemoryProviderConfigField['scope'],
  input: MemoryProviderConnection | undefined,
  previous: MemoryProviderConnection = {},
  clearSecrets: readonly string[] = [],
): MemoryProviderConnection {
  const descriptor = memoryProviderDescriptor(providerId)
  if (providerId === 'mnemon-native') return {}
  const fields = descriptor.fields.filter(item => item.scope === scope)
  const allowed = new Set(fields.map(item => item.key))
  for (const key of Object.keys(input ?? {})) if (!allowed.has(key)) throw new Error(`unsupported ${descriptor.label} ${scope} setting: ${key}`)
  for (const key of clearSecrets) {
    const configField = fields.find(item => item.key === key)
    if (configField?.input !== 'secret') throw new Error(`cannot clear non-secret ${descriptor.label} ${scope} setting: ${key}`)
  }
  const output: MemoryProviderConnection = {}
  for (const configField of fields) {
    if (clearSecrets.includes(configField.key)) {
      output[configField.key] = ''
      continue
    }
    const supplied = input?.[configField.key]
    const value = supplied ?? previous[configField.key] ?? configField.defaultValue
    if (configField.input === 'boolean') {
      if (value === undefined) continue
      if (typeof value === 'boolean') output[configField.key] = value
      else if (value === 'true' || value === 'false') output[configField.key] = value === 'true'
      else throw new Error(`${configField.label} must be true or false`)
      continue
    }
    if (configField.input === 'number') {
      if (value === undefined || value === '') continue
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${configField.label} must be a finite number`)
      output[configField.key] = parsed
      continue
    }
    const normalized = normalizeString(value, configField)
    if (normalized !== '' || configField.required || configField.input === 'secret') output[configField.key] = normalized
  }
  validateProviderSpecific(providerId, output)
  return output
}

export function providerServiceFields(providerId: MemoryProviderId): MemoryProviderConfigField[] {
  return memoryProviderDescriptor(providerId).fields.filter(field => field.scope === 'service')
}

export function providerMemoryFields(providerId: MemoryProviderId): MemoryProviderConfigField[] {
  return memoryProviderDescriptor(providerId).fields.filter(field => field.scope === 'memory')
}

export function splitProviderConnection(providerId: MemoryProviderId, connection: MemoryProviderConnection | undefined): {
  service: MemoryProviderConnection
  memory: MemoryProviderConnection
} {
  const serviceKeys = new Set(providerServiceFields(providerId).map(field => field.key))
  return {
    service: Object.fromEntries(Object.entries(connection ?? {}).filter(([key]) => serviceKeys.has(key))),
    memory: Object.fromEntries(Object.entries(connection ?? {}).filter(([key]) => !serviceKeys.has(key))),
  }
}

export function normalizeProviderServiceConnection(providerId: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}, clearSecrets: readonly string[] = []): MemoryProviderConnection {
  return normalizeScopedProviderConnection(providerId, 'service', input, previous, clearSecrets)
}

export function normalizeProviderMemoryConnection(providerId: MemoryProviderId, input: MemoryProviderConnection | undefined, previous: MemoryProviderConnection = {}): MemoryProviderConnection {
  return normalizeScopedProviderConnection(providerId, 'memory', input, previous)
}

export function normalizeProviderConnection(
  providerId: MemoryProviderId,
  input: MemoryProviderConnection | undefined,
  previous: MemoryProviderConnection = {},
  clearSecrets: readonly string[] = [],
): MemoryProviderConnection {
  const descriptor = memoryProviderDescriptor(providerId)
  if (providerId === 'mnemon-native') return {}
  const allowed = new Set(descriptor.fields.map(item => item.key))
  for (const key of Object.keys(input ?? {})) if (!allowed.has(key)) throw new Error(`unsupported ${descriptor.label} setting: ${key}`)
  for (const key of clearSecrets) {
    const configField = descriptor.fields.find(item => item.key === key)
    if (configField?.input !== 'secret') throw new Error(`cannot clear non-secret ${descriptor.label} setting: ${key}`)
  }

  const output: MemoryProviderConnection = {}
  for (const configField of descriptor.fields) {
    if (clearSecrets.includes(configField.key)) {
      output[configField.key] = ''
      continue
    }
    const supplied = input?.[configField.key]
    const fallback = previous[configField.key] ?? configField.defaultValue
    const value = supplied ?? fallback
    if (configField.input === 'boolean') {
      if (value === undefined) continue
      if (typeof value === 'boolean') output[configField.key] = value
      else if (value === 'true' || value === 'false') output[configField.key] = value === 'true'
      else throw new Error(`${configField.label} must be true or false`)
      continue
    }
    if (configField.input === 'number') {
      if (value === undefined || value === '') continue
      const parsed = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(parsed)) throw new Error(`${configField.label} must be a finite number`)
      output[configField.key] = parsed
      continue
    }
    const normalized = normalizeString(value, configField)
    if (normalized !== '' || configField.required || configField.input === 'secret') output[configField.key] = normalized
  }

  validateProviderSpecific(providerId, output)
  return output
}

export function publicScopedProviderConnection(providerId: MemoryProviderId, scope: MemoryProviderConfigField['scope'], connection: MemoryProviderConnection): {
  settings: MemoryProviderConnection
  configuredSecrets: string[]
} {
  const descriptor = memoryProviderDescriptor(providerId)
  const fields = descriptor.fields.filter(item => item.scope === scope)
  const keys = new Set(fields.map(item => item.key))
  const secrets = new Set(fields.filter(item => item.input === 'secret').map(item => item.key))
  return {
    settings: Object.fromEntries(Object.entries(connection).filter(([key]) => keys.has(key) && !secrets.has(key))),
    configuredSecrets: [...secrets].filter(key => String(connection[key] ?? '') !== ''),
  }
}

export function publicProviderConnection(providerId: MemoryProviderId, connection: MemoryProviderConnection): {
  settings: MemoryProviderConnection
  configuredSecrets: string[]
} {
  const descriptor = memoryProviderDescriptor(providerId)
  const secrets = new Set(descriptor.fields.filter(item => item.input === 'secret').map(item => item.key))
  return {
    settings: Object.fromEntries(Object.entries(connection).filter(([key]) => !secrets.has(key))),
    configuredSecrets: [...secrets].filter(key => String(connection[key] ?? '') !== ''),
  }
}
