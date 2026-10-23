/**
 * Browser-safe validation for the editable workflow contract.  Durable I/O
 * belongs in studio-store.ts; this module deliberately has no Node imports.
 */
import type {
  JsonObject,
  JsonValue,
  StudioEdge,
  StudioGraph,
  StudioIssue,
  StudioNode,
  StudioNodeKind,
  StudioNodeResult,
  StudioProviderId,
  StudioRun,
  StudioRunStatus,
} from './studio-contract.js'

export const STUDIO_LIMITS = {
  maxGraphJsonBytes: 16 * 1024 * 1024,
  maxRunJsonBytes: 64 * 1024 * 1024,
  maxPromptCharacters: 1_000_000,
  maxOutputCharacters: 8 * 1024 * 1024,
  maxTextCharacters: 2 * 1024 * 1024,
  maxMessageCharacters: 2 * 1024 * 1024,
  maxNodes: 128,
  maxEdges: 1024,
  maxJsonDepth: 16,
  maxJsonEntries: 32768,
  maxJsonObjectKeys: 128,
  maxJsonArrayItems: 1024,
  maxCoordinateMagnitude: 1_000_000,
} as const

export type StudioValidationCode =
  | 'STUDIO_JSON_INVALID'
  | 'STUDIO_GRAPH_INVALID'
  | 'STUDIO_RUN_INVALID'
  | 'STUDIO_IDENTIFIER_INVALID'

/** A named, user-diagnosable Host boundary error. */
export class StudioValidationError extends Error {
  constructor(readonly code: StudioValidationCode, message: string) {
    super(message)
    this.name = 'StudioValidationError'
  }
}

const PROVIDERS = ['native', 'web', 'insight'] as const satisfies readonly StudioProviderId[]
const NODE_KINDS = [
  'native',
  'chatgpt-web',
  'clarify',
  'gemini-research',
  'gemini-thinking',
  'chatgpt-search',
  'chatgpt-review',
  'output',
] as const satisfies readonly StudioNodeKind[]
const RUN_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'needs-input'] as const satisfies readonly StudioRunStatus[]
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Identifiers the workflow studio stores: sources, drafts, runs and graphs. */
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

type JsonRecord = Record<string, unknown>

function fail(code: StudioValidationCode, message: string): never {
  throw new StudioValidationError(code, message)
}

function isPlainRecord(value: unknown): value is JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertExactKeys(value: JsonRecord, keys: readonly string[], field: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('STUDIO_JSON_INVALID', `${field} 含有不支持的字段「${key}」。`)
  }
}

function requireRecord(value: unknown, field: string): JsonRecord {
  if (!isPlainRecord(value)) fail('STUDIO_JSON_INVALID', `${field} 必须是 JSON 对象。`)
  return value
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) fail('STUDIO_JSON_INVALID', `${field} 必须是 JSON 数组。`)
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) fail('STUDIO_JSON_INVALID', `${field} 不能包含稀疏数组项。`)
  }
  return value
}

function requireText(value: unknown, field: string, maximum = STUDIO_LIMITS.maxTextCharacters, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes('\u0000')) {
    fail('STUDIO_JSON_INVALID', `${field} 必须是长度不超过 ${maximum} 的${allowEmpty ? '' : '非空 '}文本。`)
  }
  return value
}

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail('STUDIO_IDENTIFIER_INVALID', `${field} 必须是 1–160 位的字母、数字、点、下划线、连字符或冒号，且不能以标点开头。`)
  }
  return value
}

function requireProvider(value: unknown, field: string): StudioProviderId {
  if (typeof value !== 'string' || !PROVIDERS.includes(value as StudioProviderId)) {
    fail('STUDIO_GRAPH_INVALID', `${field} 必须是 native、web 或 insight。`)
  }
  return value as StudioProviderId
}

function requireNodeKind(value: unknown, field: string): StudioNodeKind {
  if (typeof value !== 'string' || !NODE_KINDS.includes(value as StudioNodeKind)) {
    fail('STUDIO_GRAPH_INVALID', `${field} 不是受支持的流程阶段类型。`)
  }
  return value as StudioNodeKind
}

function requireFiniteCoordinate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > STUDIO_LIMITS.maxCoordinateMagnitude) {
    fail('STUDIO_GRAPH_INVALID', `${field} 必须是绝对值不超过 ${STUDIO_LIMITS.maxCoordinateMagnitude} 的有限数值。`)
  }
  return value
}

function requireRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('STUDIO_JSON_INVALID', `${field} 必须是非负安全整数。`)
  return value
}

function requireTimestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime())) {
    fail('STUDIO_JSON_INVALID', `${field} 必须是有效的 ISO 时间。`)
  }
  return value
}

interface JsonState { entries: number }

function assertJsonValue(value: unknown, field: string, state: JsonState, depth = 0): asserts value is JsonValue {
  if (depth > STUDIO_LIMITS.maxJsonDepth) fail('STUDIO_JSON_INVALID', `${field} 超过 JSON 最大嵌套深度 ${STUDIO_LIMITS.maxJsonDepth}。`)
  state.entries += 1
  if (state.entries > STUDIO_LIMITS.maxJsonEntries) fail('STUDIO_JSON_INVALID', `${field} 超过 JSON 最大项目数 ${STUDIO_LIMITS.maxJsonEntries}。`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('STUDIO_JSON_INVALID', `${field} 不能包含 NaN 或无穷数值。`)
    return
  }
  if (Array.isArray(value)) {
    if (value.length > STUDIO_LIMITS.maxJsonArrayItems) fail('STUDIO_JSON_INVALID', `${field} 超过 JSON 数组长度上限。`)
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) fail('STUDIO_JSON_INVALID', `${field} 不能包含稀疏数组项。`)
      assertJsonValue(value[index], `${field}[${index}]`, state, depth + 1)
    }
    return
  }
  if (!isPlainRecord(value)) fail('STUDIO_JSON_INVALID', `${field} 只能包含 JSON 值，不能包含运行时对象。`)
  const keys = Object.keys(value)
  if (keys.length > STUDIO_LIMITS.maxJsonObjectKeys) fail('STUDIO_JSON_INVALID', `${field} 超过 JSON 对象字段上限。`)
  for (const key of keys) {
    if (key.length > 256 || key.includes('\u0000')) fail('STUDIO_JSON_INVALID', `${field} 含有不支持的 JSON 字段名。`)
    assertJsonValue(value[key], `${field}.${key}`, state, depth + 1)
  }
}

function requireJsonObject(value: unknown, field: string, maxBytes?: number): JsonObject {
  const record = requireRecord(value, field)
  assertJsonValue(record, field, { entries: 0 })
  if (maxBytes !== undefined && utf8Bytes(JSON.stringify(record)) > maxBytes) {
    fail('STUDIO_JSON_INVALID', `${field} 的 JSON 不能超过 ${maxBytes} 字节。`)
  }
  return cloneStudio(record) as JsonObject
}

function parsePosition(value: unknown, field: string): StudioNode['position'] {
  const record = requireRecord(value, field)
  assertExactKeys(record, ['x', 'y'], field)
  return { x: requireFiniteCoordinate(record.x, `${field}.x`), y: requireFiniteCoordinate(record.y, `${field}.y`) }
}

function parseNode(value: unknown, index: number): StudioNode {
  const field = `nodes[${index}]`
  const record = requireRecord(value, field)
  assertExactKeys(record, ['id', 'label', 'kind', 'prompt', 'parameters', 'metadata', 'position'], field)
  return {
    id: requireIdentifier(record.id, `${field}.id`),
    label: requireText(record.label, `${field}.label`, 256),
    kind: requireNodeKind(record.kind, `${field}.kind`),
    prompt: requireText(record.prompt, `${field}.prompt`, STUDIO_LIMITS.maxPromptCharacters, true),
    parameters: requireJsonObject(record.parameters, `${field}.parameters`),
    metadata: requireJsonObject(record.metadata, `${field}.metadata`),
    position: parsePosition(record.position, `${field}.position`),
  }
}

function parseEdge(value: unknown, index: number): StudioEdge {
  const field = `edges[${index}]`
  const record = requireRecord(value, field)
  assertExactKeys(record, ['id', 'source', 'target'], field)
  return {
    id: requireIdentifier(record.id, `${field}.id`),
    source: requireIdentifier(record.source, `${field}.source`),
    target: requireIdentifier(record.target, `${field}.target`),
  }
}

/** Strictly parse the serializable graph shape. It permits an unfinished draft. */
export function parseStudioGraph(value: unknown): StudioGraph {
  const record = requireRecord(value, 'graph')
  assertExactKeys(record, ['formatVersion', 'id', 'sessionId', 'providerId', 'title', 'nodes', 'edges', 'parameters', 'metadata'], 'graph')
  if (record.formatVersion !== 1) fail('STUDIO_GRAPH_INVALID', '流程图格式版本不是受支持的版本 1。')
  const rawNodes = requireArray(record.nodes, 'graph.nodes')
  const rawEdges = requireArray(record.edges, 'graph.edges')
  if (rawNodes.length > STUDIO_LIMITS.maxNodes) fail('STUDIO_GRAPH_INVALID', `流程图节点数不能超过 ${STUDIO_LIMITS.maxNodes}。`)
  if (rawEdges.length > STUDIO_LIMITS.maxEdges) fail('STUDIO_GRAPH_INVALID', `流程图连线数不能超过 ${STUDIO_LIMITS.maxEdges}。`)
  const nodes = rawNodes.map((item, index) => parseNode(item, index))
  const edges = rawEdges.map((item, index) => parseEdge(item, index))
  const nodeIds = new Set<string>()
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail('STUDIO_GRAPH_INVALID', `节点标识「${node.id}」重复。`)
    nodeIds.add(node.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail('STUDIO_GRAPH_INVALID', `连线标识「${edge.id}」重复。`)
    edgeIds.add(edge.id)
  }
  const graph: StudioGraph = {
    formatVersion: 1,
    id: requireIdentifier(record.id, 'graph.id'),
    sessionId: requireIdentifier(record.sessionId, 'graph.sessionId'),
    providerId: requireProvider(record.providerId, 'graph.providerId'),
    title: requireText(record.title, 'graph.title', 256),
    nodes,
    edges,
    parameters: requireJsonObject(record.parameters, 'graph.parameters'),
    metadata: requireJsonObject(record.metadata, 'graph.metadata'),
  }
  const rendered = stableStudioJson(graph)
  if (utf8Bytes(rendered) > STUDIO_LIMITS.maxGraphJsonBytes) {
    fail('STUDIO_GRAPH_INVALID', `流程图 JSON 不能超过 ${STUDIO_LIMITS.maxGraphJsonBytes} 字节。`)
  }
  return graph
}

export interface StudioGraphValidationOptions {
  readonly sessionId?: string
  readonly providerId?: StudioProviderId
  /** A saved draft can be incomplete; a run must satisfy these additional checks. */
  readonly forRun?: boolean
}

/**
 * Return user-facing graph issues without performing I/O.  Invalid JSON is a
 * single issue; a parsed but unfinished draft returns all useful graph issues.
 */
export function validateStudioGraph(value: unknown, options: StudioGraphValidationOptions = {}): readonly StudioIssue[] {
  let graph: StudioGraph
  try {
    graph = parseStudioGraph(value)
  } catch (error) {
    return [{ message: error instanceof Error ? error.message : '流程图 JSON 无法验证。' }]
  }
  const issues: StudioIssue[] = []
  if (options.sessionId !== undefined && graph.sessionId !== options.sessionId) {
    issues.push({ field: 'sessionId', message: '流程图不属于当前会话。' })
  }
  if (options.providerId !== undefined && graph.providerId !== options.providerId) {
    issues.push({ field: 'providerId', message: '流程图 Provider 与当前目标不一致。' })
  }
  if (options.forRun && graph.nodes.length === 0) {
    issues.push({ field: 'nodes', message: '流程图至少需要一个节点后才能运行。' })
  }
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const relationIds = new Set<string>()
  const usableEdges: StudioEdge[] = []
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      issues.push({ field: 'edges', message: `连线「${edge.id}」引用了不存在的节点。` })
      continue
    }
    if (edge.source === edge.target) {
      issues.push({ field: 'edges', message: `连线「${edge.id}」不能连接节点自身。` })
      continue
    }
    const relation = `${edge.source}\u0000${edge.target}`
    if (relationIds.has(relation)) {
      issues.push({ field: 'edges', message: `节点「${edge.source}」到「${edge.target}」的连线重复。` })
      continue
    }
    relationIds.add(relation)
    usableEdges.push(edge)
  }
  if (options.forRun) {
    for (const node of graph.nodes) {
      if (node.prompt.trim().length === 0) issues.push({ nodeId: node.id, field: 'prompt', message: '运行前每个节点都需要非空提示词。' })
    }
  }
  if (containsCycle(graph.nodes.map((node) => node.id), usableEdges)) {
    issues.push({ field: 'edges', message: '流程图包含依赖环，删除相应连线后才能运行。' })
  }
  return issues
}

function containsCycle(nodeIds: readonly string[], edges: readonly StudioEdge[]): boolean {
  const outgoing = new Map<string, string[]>()
  const indegree = new Map<string, number>()
  for (const id of nodeIds) {
    outgoing.set(id, [])
    indegree.set(id, 0)
  }
  for (const edge of edges) {
    outgoing.get(edge.source)?.push(edge.target)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }
  const queue = nodeIds.filter((id) => indegree.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) continue
    visited += 1
    for (const target of outgoing.get(node) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1
      indegree.set(target, next)
      if (next === 0) queue.push(target)
    }
  }
  return visited !== nodeIds.length
}

/** Parse a graph and reject incomplete/dangerous states before provider admission. */
export function assertRunnableStudioGraph(value: unknown, options: Omit<StudioGraphValidationOptions, 'forRun'> = {}): StudioGraph {
  const graph = parseStudioGraph(value)
  const issues = validateStudioGraph(graph, { ...options, forRun: true })
  if (issues.length > 0) {
    fail('STUDIO_GRAPH_INVALID', `流程图尚不能运行：${issues.map((issue) => issue.message).join('；')}`)
  }
  return graph
}

export function assertStudioSessionId(value: unknown): string {
  return requireIdentifier(value, 'sessionId')
}

/** Draft identities are independent UUIDs; graph.id stays the logical source-flow identity. */
export function assertStudioDraftId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail('STUDIO_IDENTIFIER_INVALID', '草稿 id 必须是 UUID。')
  }
  return value
}

export function assertStudioCommandId(value: unknown): string {
  return requireIdentifier(value, 'commandId')
}

export function assertStudioRevision(value: unknown, field = 'expectedRevision'): number {
  return requireRevision(value, field)
}

export function assertStudioTimestamp(value: unknown, field: string): string {
  return requireTimestamp(value, field)
}

function parseNodeResult(value: unknown, index: number, maxJsonBytes: number): StudioNodeResult {
  const field = `run.nodes[${index}]`
  const record = requireRecord(value, field)
  assertExactKeys(record, ['nodeId', 'status', 'output', 'error', 'observed'], field)
  const status = requireRunStatus(record.status, `${field}.status`)
  const output = record.output === undefined ? undefined : requireText(record.output, `${field}.output`, STUDIO_LIMITS.maxOutputCharacters, true)
  const error = record.error === undefined ? undefined : requireText(record.error, `${field}.error`, STUDIO_LIMITS.maxMessageCharacters, true)
  const observed = record.observed === undefined ? undefined : requireJsonObject(record.observed, `${field}.observed`, maxJsonBytes)
  return { nodeId: requireIdentifier(record.nodeId, `${field}.nodeId`), status, ...(output === undefined ? {} : { output }), ...(error === undefined ? {} : { error }), ...(observed === undefined ? {} : { observed }) }
}

function requireRunStatus(value: unknown, field: string): StudioRunStatus {
  if (typeof value !== 'string' || !RUN_STATUSES.includes(value as StudioRunStatus)) {
    fail('STUDIO_RUN_INVALID', `${field} 不是受支持的执行状态。`)
  }
  return value as StudioRunStatus
}

/** Strictly parse a Provider observation/receipt. It does not infer completion. */
export function parseStudioRun(value: unknown, maxBytes = STUDIO_LIMITS.maxRunJsonBytes): StudioRun {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('STUDIO_RUN_INVALID', '运行 JSON 字节上限必须是正安全整数。')
  const record = requireRecord(value, 'run')
  assertExactKeys(record, ['id', 'sessionId', 'providerId', 'status', 'nodes', 'createdAt', 'updatedAt', 'output', 'message'], 'run')
  const nodes = requireArray(record.nodes, 'run.nodes')
  if (nodes.length > STUDIO_LIMITS.maxNodes) fail('STUDIO_RUN_INVALID', '运行节点结果超过上限。')
  const parsedNodes = nodes.map((node, index) => parseNodeResult(node, index, maxBytes))
  const seen = new Set<string>()
  for (const node of parsedNodes) {
    if (seen.has(node.nodeId)) fail('STUDIO_RUN_INVALID', `运行节点结果「${node.nodeId}」重复。`)
    seen.add(node.nodeId)
  }
  const output = record.output === undefined ? undefined : requireText(record.output, 'run.output', STUDIO_LIMITS.maxOutputCharacters, true)
  const message = record.message === undefined ? undefined : requireText(record.message, 'run.message', STUDIO_LIMITS.maxMessageCharacters, true)
  if (utf8Bytes(JSON.stringify(value)) > maxBytes) fail('STUDIO_RUN_INVALID', `运行 JSON 不能超过 ${maxBytes} 字节。`)
  return {
    id: requireIdentifier(record.id, 'run.id'),
    sessionId: requireIdentifier(record.sessionId, 'run.sessionId'),
    providerId: requireProvider(record.providerId, 'run.providerId'),
    status: requireRunStatus(record.status, 'run.status'),
    nodes: parsedNodes,
    createdAt: requireTimestamp(record.createdAt, 'run.createdAt'),
    updatedAt: requireTimestamp(record.updatedAt, 'run.updatedAt'),
    ...(output === undefined ? {} : { output }),
    ...(message === undefined ? {} : { message }),
  }
}

export function isStudioRunActive(status: StudioRunStatus): boolean {
  return status === 'pending' || status === 'running' || status === 'needs-input' || status === 'unknown'
}

export function isStudioRunTerminal(status: StudioRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

/** Canonical JSON is used for CAS comparisons and immutable snapshot checks. */
export function stableStudioJson(value: unknown): string {
  const state: JsonState = { entries: 0 }
  const render = (current: unknown, field: string, depth: number): string => {
    assertJsonValue(current, field, state, depth)
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current)
    if (typeof current === 'number') return JSON.stringify(current)
    if (Array.isArray(current)) return `[${current.map((item, index) => render(item, `${field}[${index}]`, depth + 1)).join(',')}]`
    const record = current as JsonRecord
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${render(record[key], `${field}.${key}`, depth + 1)}`).join(',')}}`
  }
  return render(value, 'json', 0)
}

/** JSON round-tripping prevents callers from mutating a stored snapshot through a returned reference. */
export function cloneStudio<T>(value: T): T {
  return JSON.parse(stableStudioJson(value)) as T
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
