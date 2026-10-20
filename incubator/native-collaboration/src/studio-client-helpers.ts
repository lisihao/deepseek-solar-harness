import type {
  JsonObject,
  JsonValue,
  StudioDraft,
  StudioEdge,
  StudioGraph,
  StudioNode,
  StudioNodeKind,
  StudioOverview,
  StudioProviderId,
  StudioRunRecord,
  StudioRun,
  StudioRunStatus,
  StudioSource,
} from './studio-contract.js'

export interface EditableStudioDraft {
  readonly id: string
  readonly expectedRevision: number
  readonly graph: StudioGraph
  readonly sourceId?: string
}

export type StudioInitialSelection =
  | { readonly kind: 'source'; readonly source: StudioSource }
  | { readonly kind: 'draft'; readonly draft: StudioDraft }

export interface StudioChoice {
  readonly value: string
  readonly label: string
}

export interface NodePropertyView {
  readonly modelProvider: string
  readonly modelId: string
  readonly modelLabel: string
  readonly effortLabel: string
  readonly executor: string
  readonly unsupported: readonly string[]
}

export interface JsonObjectParseResult {
  readonly value?: JsonObject
  readonly error?: string
}

export type StudioRunDecision =
  | { readonly kind: 'save-required' }
  | { readonly kind: 'inspect'; readonly commandId: string }
  | { readonly kind: 'run'; readonly commandId: string }

export type StudioModelPropertyKey = 'modelProvider' | 'modelId' | 'modelLabel' | 'effortLabel' | 'executor'

const EXECUTION_PARAMETER_KEYS = ['modelId', 'modelLabel', 'effortLabel', 'executor'] as const

const PROVIDER_NODE_KINDS: Readonly<Record<StudioProviderId, readonly StudioNodeKind[]>> = {
  native: ['native'],
  web: ['chatgpt-web'],
  insight: ['clarify', 'gemini-research', 'gemini-thinking', 'chatgpt-search', 'chatgpt-review', 'output'],
}

const NODE_KIND_LABELS: Readonly<Record<StudioNodeKind, string>> = {
  native: '原生阶段',
  'chatgpt-web': 'ChatGPT 网页阶段',
  clarify: '澄清问题',
  'gemini-research': 'Gemini 研究',
  'gemini-thinking': 'Gemini 推理',
  'chatgpt-search': 'ChatGPT 搜索',
  'chatgpt-review': 'ChatGPT 审核',
  output: '交付输出',
}

const PROVIDER_MODEL_OPTIONS: Readonly<Record<StudioProviderId, readonly StudioChoice[]>> = {
  // Model ids are provider/account configuration, not a safe alias for an executor or a website label.
  // The editor keeps the observed id as a suggestion and lets provider validation reject unavailable choices.
  native: [],
  web: [],
  insight: [],
}

const PROVIDER_EXECUTOR_OPTIONS: Readonly<Record<StudioProviderId, readonly StudioChoice[]>> = {
  native: [
    { value: 'codex', label: 'Codex 原生执行器' },
    { value: 'claude-code', label: 'Claude Code 原生执行器' },
  ],
  web: [],
  insight: [],
}

const EFFORT_OPTIONS: readonly StudioChoice[] = [
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '很高' },
]

const REQUESTED_PROVIDER_OPTIONS: readonly StudioChoice[] = [
  { value: 'chatgpt', label: 'ChatGPT' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'codex', label: 'Codex' },
]

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isExecutionParameterKey(key: string): key is typeof EXECUTION_PARAMETER_KEYS[number] {
  return (EXECUTION_PARAMETER_KEYS as readonly string[]).includes(key)
}

function updateNode(graph: StudioGraph, id: string, updater: (node: StudioNode) => StudioNode): StudioGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(node => node.id === id ? updater(node) : node),
  }
}

export function cloneStudioGraph(graph: StudioGraph): StudioGraph {
  return cloneJson(graph)
}

function executionGraphValue(graph: StudioGraph): JsonObject {
  return {
    formatVersion: graph.formatVersion,
    id: graph.id,
    sessionId: graph.sessionId,
    providerId: graph.providerId,
    title: graph.title,
    nodes: graph.nodes.map(node => ({
      id: node.id,
      label: node.label,
      kind: node.kind,
      prompt: node.prompt,
      parameters: node.parameters,
      metadata: node.metadata,
    })),
    edges: graph.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
    parameters: graph.parameters,
    metadata: graph.metadata,
  }
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`
}

/** Positions are layout only. Every other graph field, including metadata/context, is executable identity. */
export function sameExecutionGraph(left: StudioGraph, right: StudioGraph): boolean {
  return canonicalJson(executionGraphValue(left)) === canonicalJson(executionGraphValue(right))
}

/** A source result can decorate an unmodified fork, but never a changed draft. */
export function sourceExecutionRun(draft: EditableStudioDraft | undefined, source: StudioSource | undefined): StudioRun | undefined {
  if (draft === undefined || source === undefined || draft.sourceId !== source.id) return undefined
  if (
    source.run === undefined
    || source.run.sessionId !== draft.graph.sessionId
    || source.run.providerId !== draft.graph.providerId
  ) return undefined
  return sameExecutionGraph(draft.graph, source.graph) ? source.run : undefined
}

/** Only Web and Insight runs with an existing command can be explicitly continued. */
export function canResumeStudioRun(
  providerId: StudioProviderId,
  commandId: string | undefined,
  run: StudioRun | undefined,
): boolean {
  if ((providerId !== 'web' && providerId !== 'insight') || commandId === undefined || run === undefined) return false
  return run.status === 'unknown' || run.status === 'running' || run.status === 'needs-input'
}

/** A source becomes a new, unsaved draft. Its logical graph identity stays stable. */
export function forkStudioSource(source: StudioSource, draftId: string): EditableStudioDraft {
  return {
    id: draftId,
    expectedRevision: 0,
    sourceId: source.id,
    graph: cloneStudioGraph(source.graph),
  }
}

export function editableStudioDraft(draft: StudioDraft): EditableStudioDraft {
  return {
    id: draft.id,
    expectedRevision: draft.revision,
    sourceId: draft.sourceId,
    graph: cloneStudioGraph(draft.graph),
  }
}

function sortableTime(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function newest<T>(items: readonly T[], time: (item: T) => string): T | undefined {
  let latest: T | undefined
  let latestTime = Number.NEGATIVE_INFINITY
  for (const item of items) {
    const itemTime = sortableTime(time(item))
    if (latest === undefined || itemTime > latestTime) {
      latest = item
      latestTime = itemTime
    }
  }
  return latest
}

/** Prefer a newer saved draft; otherwise fork the most recently captured session source. */
export function initialStudioSelection(overview: StudioOverview): StudioInitialSelection | undefined {
  const source = newest(overview.sources, item => item.capturedAt)
  const draft = newest(overview.drafts, item => item.updatedAt)
  if (draft !== undefined && (source === undefined || sortableTime(draft.updatedAt) >= sortableTime(source.capturedAt))) {
    return { kind: 'draft', draft }
  }
  return source === undefined ? undefined : { kind: 'source', source }
}

export function nodeKindsForProvider(providerId: StudioProviderId, current?: StudioNodeKind): readonly StudioChoice[] {
  const legal = PROVIDER_NODE_KINDS[providerId]
  const values = current !== undefined && !legal.includes(current) ? [...legal, current] : legal
  return values.map(value => ({
    value,
    label: legal.includes(value) ? NODE_KIND_LABELS[value] : `${NODE_KIND_LABELS[value]}（当前流程值）`,
  }))
}

export function modelChoicesForProvider(providerId: StudioProviderId, current?: string): readonly StudioChoice[] {
  return appendCurrentChoice(PROVIDER_MODEL_OPTIONS[providerId], current, '当前模型')
}

export function executorChoicesForProvider(providerId: StudioProviderId, current?: string): readonly StudioChoice[] {
  return appendCurrentChoice(PROVIDER_EXECUTOR_OPTIONS[providerId], current, '当前执行器')
}

export function effortChoices(current?: string): readonly StudioChoice[] {
  return appendCurrentChoice(EFFORT_OPTIONS, current, '当前力度')
}

export function requestedProviderChoices(providerId: StudioProviderId, current?: string): readonly StudioChoice[] {
  if (providerId === 'native') return []
  const legal = providerId === 'web'
    ? REQUESTED_PROVIDER_OPTIONS.filter(choice => choice.value === 'chatgpt')
    : REQUESTED_PROVIDER_OPTIONS
  return appendCurrentChoice(legal, current, '当前模型服务')
}

function appendCurrentChoice(choices: readonly StudioChoice[], current: string | undefined, fallbackLabel: string): readonly StudioChoice[] {
  const normalized = current?.trim()
  if (normalized === undefined || normalized.length === 0 || choices.some(choice => choice.value === normalized)) return choices
  return [...choices, { value: normalized, label: `${fallbackLabel}：${normalized}` }]
}

export function parseJsonObject(text: string, fieldLabel = 'JSON'): JsonObjectParseResult {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      return { error: `${fieldLabel}必须是对象。` }
    }
    return { value: value as JsonObject }
  } catch {
    return { error: `${fieldLabel}不是有效的 JSON 对象。` }
  }
}

export function formatJsonObject(value: JsonObject): string {
  return JSON.stringify(value, null, 2)
}

export function nodePropertyView(providerId: StudioProviderId, node: StudioNode): NodePropertyView {
  const unsupported: string[] = []
  const values: Record<StudioModelPropertyKey, string> = {
    modelProvider: '',
    modelId: '',
    modelLabel: '',
    effortLabel: '',
    executor: '',
  }
  const read = (value: unknown, key: StudioModelPropertyKey | string): string => {
    if (value === undefined) return ''
    if (typeof value === 'string') return value
    unsupported.push(key)
    return ''
  }
  if (providerId === 'native') {
    values.executor = read(node.parameters.executor, 'executor')
    const profile = node.parameters.profile
    if (profile !== undefined && !isJsonObject(profile)) unsupported.push('profile')
    if (isJsonObject(profile)) {
      values.modelId = read(profile.model, 'profile.model')
      values.effortLabel = read(profile.reasoningEffort, 'profile.reasoningEffort')
    }
    values.modelLabel = read(node.metadata.modelLabel, 'metadata.modelLabel')
  } else {
    const requested = node.parameters.requested
    if (requested !== undefined && !isJsonObject(requested)) unsupported.push('requested')
    if (isJsonObject(requested)) {
      values.modelProvider = read(requested.provider, 'requested.provider')
      values.modelId = read(requested.modelId, 'requested.modelId')
      values.modelLabel = read(requested.modelLabel, 'requested.modelLabel')
      values.effortLabel = read(requested.effortLabel, 'requested.effortLabel')
    }
    values.executor = read(node.parameters.executor, 'executor')
  }
  return { ...values, unsupported }
}

/** Update model fields on the provider's executable schema, never on an invented flat alias. */
export function withProviderNodeStringProperty(
  node: StudioNode,
  providerId: StudioProviderId,
  key: StudioModelPropertyKey,
  value: string,
): StudioNode {
  if (providerId === 'native') {
    if (key === 'executor') return withNodeStringProperty(node, 'executor', value)
    if (key === 'modelLabel') {
      const metadata = cloneJson(node.metadata)
      const normalized = value.trim()
      if (normalized.length === 0) delete metadata.modelLabel
      else metadata.modelLabel = normalized
      return { ...node, metadata }
    }
    if (key === 'modelProvider') return node
    const parameters = cloneJson(node.parameters)
    const profile = isJsonObject(parameters.profile) ? cloneJson(parameters.profile) : {}
    const profileKey = key === 'modelId' ? 'model' : 'reasoningEffort'
    const normalized = value.trim()
    if (normalized.length === 0) delete profile[profileKey]
    else profile[profileKey] = normalized
    if (Object.keys(profile).length === 0) delete parameters.profile
    else parameters.profile = profile
    return { ...node, parameters }
  }

  if (key === 'executor') return withNodeStringProperty(node, 'executor', value)
  const parameters = cloneJson(node.parameters)
  const requested = isJsonObject(parameters.requested) ? cloneJson(parameters.requested) : {}
  const requestedKey = key === 'modelProvider' ? 'provider' : key
  const normalized = value.trim()
  if (normalized.length === 0) delete requested[requestedKey]
  else requested[requestedKey] = normalized
  if (Object.keys(requested).length === 0) delete parameters.requested
  else parameters.requested = requested
  return { ...node, parameters }
}

/** Leaves all unrelated parameters intact; an empty field intentionally removes only that field. */
export function withNodeStringProperty(node: StudioNode, key: typeof EXECUTION_PARAMETER_KEYS[number], value: string): StudioNode {
  const parameters = cloneJson(node.parameters)
  const normalized = value.trim()
  if (normalized.length === 0) delete parameters[key]
  else parameters[key] = normalized
  return { ...node, parameters }
}

/** Returns parameters that belong in the free-form editor, excluding the four dedicated inputs. */
export function additionalNodeParameters(parameters: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (!isExecutionParameterKey(key)) result[key] = cloneJson(value)
  }
  return result
}

function providerParameterReserved(providerId: StudioProviderId, key: string): boolean {
  if (providerId === 'native') return key === 'executor' || key === 'profile'
  return key === 'requested'
}

/** Free-form parameters exclude the nested runtime selection used by the current provider. */
export function additionalNodeParametersForProvider(providerId: StudioProviderId, parameters: JsonObject): JsonObject {
  const result: JsonObject = {}
  for (const [key, value] of Object.entries(parameters)) {
    if (!providerParameterReserved(providerId, key)) result[key] = cloneJson(value)
  }
  return result
}

export function withAdditionalNodeParametersForProvider(node: StudioNode, providerId: StudioProviderId, additional: JsonObject): StudioNode {
  const parameters = cloneJson(node.parameters)
  for (const key of Object.keys(parameters)) {
    if (!providerParameterReserved(providerId, key)) delete parameters[key]
  }
  for (const [key, value] of Object.entries(additional)) {
    if (!providerParameterReserved(providerId, key)) parameters[key] = cloneJson(value)
  }
  return { ...node, parameters }
}

export function validateAdditionalNodeParametersForProvider(providerId: StudioProviderId, value: JsonObject): string | undefined {
  const reserved = Object.keys(value).find(key => providerParameterReserved(providerId, key))
  if (reserved === undefined) return undefined
  const label = providerId === 'native' ? '执行器或原生 profile' : 'requested 模型选择'
  return `“${reserved}”由上方${label}字段管理，请不要放入其余参数 JSON。`
}

/** Replaces only free-form parameters and preserves dedicated execution properties verbatim. */
export function withAdditionalNodeParameters(node: StudioNode, additional: JsonObject): StudioNode {
  const parameters = cloneJson(node.parameters)
  for (const key of Object.keys(parameters)) {
    if (!isExecutionParameterKey(key)) delete parameters[key]
  }
  for (const [key, value] of Object.entries(additional)) {
    if (isExecutionParameterKey(key)) continue
    parameters[key] = cloneJson(value)
  }
  return { ...node, parameters }
}

export function validateAdditionalNodeParameters(value: JsonObject): string | undefined {
  const reserved = Object.keys(value).find(isExecutionParameterKey)
  return reserved === undefined ? undefined : `“${reserved}”由上方执行字段管理，请不要放入其余参数 JSON。`
}

export function withStudioNodePosition(graph: StudioGraph, id: string, position: { readonly x: number; readonly y: number }): StudioGraph {
  return updateNode(graph, id, node => ({ ...node, position: { x: position.x, y: position.y } }))
}

export function withStudioNode(graph: StudioGraph, node: StudioNode): StudioGraph {
  return updateNode(graph, node.id, () => cloneJson(node))
}

export function withStudioNodeStringProperty(
  graph: StudioGraph,
  id: string,
  key: typeof EXECUTION_PARAMETER_KEYS[number],
  value: string,
): StudioGraph {
  return updateNode(graph, id, node => withNodeStringProperty(node, key, value))
}

export function withStudioNodeAdditionalParameters(graph: StudioGraph, id: string, additional: JsonObject): StudioGraph {
  return updateNode(graph, id, node => withAdditionalNodeParameters(node, additional))
}

export function withStudioNodeMetadata(graph: StudioGraph, id: string, metadata: JsonObject): StudioGraph {
  return updateNode(graph, id, node => ({ ...node, metadata: cloneJson(metadata) }))
}

export function withStudioGraphParameters(graph: StudioGraph, parameters: JsonObject): StudioGraph {
  return { ...graph, parameters: cloneJson(parameters) }
}

export function withStudioGraphMetadata(graph: StudioGraph, metadata: JsonObject): StudioGraph {
  return { ...graph, metadata: cloneJson(metadata) }
}

export function withStudioGraphTitle(graph: StudioGraph, title: string): StudioGraph {
  return { ...graph, title }
}

export function nextStudioNode(graph: StudioGraph, id: string): StudioNode {
  const kinds = PROVIDER_NODE_KINDS[graph.providerId]
  const kind = kinds[0] ?? 'native'
  const latest = graph.nodes.at(-1)
  const position = latest === undefined
    ? { x: 80, y: 80 }
    : { x: latest.position.x + 40, y: latest.position.y + 40 }
  return {
    id,
    label: '新阶段',
    kind,
    prompt: '',
    parameters: {},
    metadata: {},
    position,
  }
}

export function withStudioNodeAdded(graph: StudioGraph, node: StudioNode): StudioGraph {
  return { ...graph, nodes: [...graph.nodes, cloneJson(node)] }
}

export function withoutStudioNodes(graph: StudioGraph, nodeIds: ReadonlySet<string>): StudioGraph {
  if (nodeIds.size === 0) return graph
  return {
    ...graph,
    nodes: graph.nodes.filter(node => !nodeIds.has(node.id)),
    edges: graph.edges.filter(edge => !nodeIds.has(edge.source) && !nodeIds.has(edge.target)),
  }
}

export function withoutStudioEdges(graph: StudioGraph, edgeIds: ReadonlySet<string>): StudioGraph {
  if (edgeIds.size === 0) return graph
  return { ...graph, edges: graph.edges.filter(edge => !edgeIds.has(edge.id)) }
}

/** A new dependency is invalid if it links missing nodes, duplicates an edge, or closes a cycle. */
export function canAddStudioEdge(graph: StudioGraph, source: string, target: string): boolean {
  if (source === target) return false
  const known = new Set(graph.nodes.map(node => node.id))
  if (!known.has(source) || !known.has(target)) return false
  if (graph.edges.some(edge => edge.source === source && edge.target === target)) return false
  return !wouldCreateStudioCycle(graph, source, target)
}

export function wouldCreateStudioCycle(graph: StudioGraph, source: string, target: string): boolean {
  if (source === target) return true
  const outgoing = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
  }
  const pending = [target]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined || visited.has(current)) continue
    if (current === source) return true
    visited.add(current)
    for (const successor of outgoing.get(current) ?? []) pending.push(successor)
  }
  return false
}

export function withStudioEdgeAdded(graph: StudioGraph, edge: StudioEdge): StudioGraph {
  if (!canAddStudioEdge(graph, edge.source, edge.target)) return graph
  return { ...graph, edges: [...graph.edges, cloneJson(edge)] }
}

export function isTerminalStudioRun(status: StudioRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function studioRunStatusLabel(status: StudioRunStatus): string {
  const labels: Readonly<Record<StudioRunStatus, string>> = {
    pending: '等待执行',
    running: '正在执行',
    completed: '已完成',
    failed: '执行失败',
    cancelled: '已取消',
    unknown: '执行结果未确认',
    'needs-input': '等待补充输入',
  }
  return labels[status]
}

/** Deciding is pure; callers invoke API.run only after an explicit button action. */
export function decideStudioRunAction(input: {
  readonly dirty: boolean
  readonly pendingCommandId?: string
  readonly createCommandId: () => string
}): StudioRunDecision {
  if (input.dirty) return { kind: 'save-required' }
  if (input.pendingCommandId !== undefined) return { kind: 'inspect', commandId: input.pendingCommandId }
  return { kind: 'run', commandId: input.createCommandId() }
}

export function currentCommandForDraft(
  draftId: string,
  records: readonly StudioRunRecord[],
  pendingCommandId?: string,
  expectedRevision?: number,
): string | undefined {
  if (pendingCommandId !== undefined) return pendingCommandId
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    if (
      record !== undefined
      && record.draftId === draftId
      && (expectedRevision === undefined || record.draftRevision === expectedRevision)
      && !isTerminalStudioRun(record.run.status)
    ) return record.commandId
  }
  return undefined
}

export function upsertStudioRunRecord(records: readonly StudioRunRecord[], record: StudioRunRecord): readonly StudioRunRecord[] {
  const index = records.findIndex(item => item.commandId === record.commandId)
  if (index < 0) return [...records, record]
  const next = [...records]
  next[index] = record
  return next
}

export function upsertStudioDraft(drafts: readonly StudioDraft[], draft: StudioDraft): readonly StudioDraft[] {
  const index = drafts.findIndex(item => item.id === draft.id)
  if (index < 0) return [...drafts, draft]
  const next = [...drafts]
  next[index] = draft
  return next
}

export function upsertStudioSource(sources: readonly StudioSource[], source: StudioSource): readonly StudioSource[] {
  const index = sources.findIndex(item => item.id === source.id)
  if (index < 0) return [...sources, source]
  const next = [...sources]
  next[index] = source
  return next
}

/** Reject an out-of-order response before it can cross a conversation boundary. */
export function isCurrentStudioOverview(
  requestedSessionId: string,
  activeSessionId: string,
  overview: StudioOverview,
): boolean {
  return requestedSessionId === activeSessionId && overview.sessionId === requestedSessionId
}

export function isCurrentStudioRunRecord(sessionId: string, record: StudioRunRecord): boolean {
  return record.run.sessionId === sessionId && record.graph.sessionId === sessionId
}

export function isCurrentStudioSource(sessionId: string, source: StudioSource): boolean {
  return source.graph.sessionId === sessionId && (source.run === undefined || source.run.sessionId === sessionId)
}

export function hasOwnJsonProperty(value: JsonObject, key: string): boolean {
  return hasOwn(value, key)
}
