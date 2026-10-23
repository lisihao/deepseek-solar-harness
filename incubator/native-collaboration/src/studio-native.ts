import type {
  Executor,
  GraphSnapshot,
  GraphStatus,
  NodeSnapshot,
  NodeStatus,
  ResidentApi,
  TaskGraph,
  TaskNode,
  TaskScope,
} from '@lisihao/dsh-solar-native-resident/contracts'
import type {
  JsonObject,
  JsonValue,
  StudioExecuteRequest,
  StudioGraph,
  StudioIssue,
  StudioNode,
  StudioNodeResult,
  StudioProvider,
  StudioRun,
  StudioRunStatus,
} from './studio-contract.js'

type ResidentStudioApi = Pick<ResidentApi, 'submit' | 'inspect'>

export interface NativeStudioProviderOptions {
  readonly resident: ResidentStudioApi
  readonly label?: string
  /** Used only for provider-owned bookkeeping and deterministic test clocks. */
  readonly now?: () => Date
}

const GRAPH_KNOWN_KEYS = new Set(['formatVersion', 'id', 'label', 'cwd', 'maxParallel', 'notBefore', 'bridgeId', 'nodes'])
const NODE_KNOWN_KEYS = new Set(['id', 'executor', 'prompt', 'dependsOn', 'scope', 'sessionKey', 'profile', 'notBefore', 'retry', 'inputFrom'])
const GRAPH_PARAMETER_KEYS = new Set(['cwd', 'maxParallel', 'notBefore', 'bridgeId'])
const NODE_PARAMETER_KEYS = new Set(['executor', 'scope', 'sessionKey', 'profile', 'notBefore', 'retry', 'inputFrom'])
const EXECUTORS: readonly Executor[] = ['codex', 'claude-code']
const GRAPH_STATUSES: readonly GraphStatus[] = ['queued', 'running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled', 'indeterminate']
const NODE_STATUSES: readonly NodeStatus[] = ['pending', 'ready', 'running', 'cancelling', 'succeeded', 'failed', 'blocked', 'cancelled', 'indeterminate']

const GRAPH_STATUS_MAP: Readonly<Record<GraphStatus, StudioRunStatus>> = {
  queued: 'pending',
  running: 'running',
  paused: 'pending',
  cancelling: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  indeterminate: 'unknown',
}

const NODE_STATUS_MAP: Readonly<Record<NodeStatus, StudioRunStatus>> = {
  pending: 'pending',
  ready: 'pending',
  running: 'running',
  cancelling: 'running',
  succeeded: 'completed',
  failed: 'failed',
  blocked: 'failed',
  cancelled: 'cancelled',
  indeterminate: 'unknown',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) {
    throw new Error(`Native Studio ${field} must be a non-empty string without NUL characters.`)
  }
  return value
}

function cloneJson(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Native Studio ${field} must contain finite JSON numbers.`)
    return value
  }
  if (Array.isArray(value)) return value.map((entry, index) => cloneJson(entry, `${field}[${index}]`))
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {}
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJson(entry, `${field}.${key}`)
    return result
  }
  throw new Error(`Native Studio ${field} must be JSON data.`)
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Native Studio ${field} must be an object.`)
  return value
}

function optionalJson(value: unknown, field: string): JsonValue | undefined {
  return value === undefined ? undefined : cloneJson(value, field)
}

function layoutPosition(index: number): { readonly x: number; readonly y: number } {
  // Four columns keep a captured graph readable at the normal editor width;
  // importantly, positions depend only on source order and never on runtime.
  return { x: (index % 4) * 320, y: Math.floor(index / 4) * 180 }
}

function unknownProperties(source: Record<string, unknown>, known: ReadonlySet<string>, field: string): JsonObject {
  const metadata: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) metadata[key] = cloneJson(value, `${field}.${key}`)
  }
  return metadata
}

function edgeId(source: string, target: string): string {
  return `${source}->${target}`
}

/** Convert the durable Resident graph into the editor's provider-neutral graph. */
export function nativeGraphToStudio(graph: TaskGraph, sessionId: string): StudioGraph {
  const source = asRecord(graph, 'graph')
  if (source.formatVersion !== 1) throw new Error('Native Studio graph.formatVersion must be 1.')
  const graphId = requireText(source.id, 'graph.id')
  const title = requireText(source.label, 'graph.label')
  const ownerSessionId = requireText(sessionId, 'sessionId')
  if (!Array.isArray(source.nodes) || source.nodes.length === 0) throw new Error('Native Studio graph.nodes must be a non-empty array.')

  const parameters: Record<string, JsonValue> = {
    cwd: cloneJson(source.cwd, 'graph.cwd'),
    maxParallel: cloneJson(source.maxParallel, 'graph.maxParallel'),
  }
  for (const key of ['notBefore', 'bridgeId'] as const) {
    const value = optionalJson(source[key], `graph.${key}`)
    if (value !== undefined) parameters[key] = value
  }

  const nodes: StudioNode[] = []
  const edges: Array<{ readonly id: string; readonly source: string; readonly target: string }> = []
  for (const [index, rawNode] of source.nodes.entries()) {
    const nodeSource = asRecord(rawNode, `graph.nodes[${index}]`)
    const id = requireText(nodeSource.id, `graph.nodes[${index}].id`)
    const prompt = requireText(nodeSource.prompt, `graph.nodes[${index}].prompt`)
    const nodeParameters: Record<string, JsonValue> = {
      executor: cloneJson(nodeSource.executor, `graph.nodes[${index}].executor`),
    }
    for (const key of ['scope', 'sessionKey', 'profile', 'notBefore', 'retry', 'inputFrom'] as const) {
      const value = optionalJson(nodeSource[key], `graph.nodes[${index}].${key}`)
      if (value !== undefined) nodeParameters[key] = value
    }
    nodes.push({
      id,
      label: `任务 ${index + 1}`,
      kind: 'native',
      prompt,
      parameters: nodeParameters,
      metadata: unknownProperties(nodeSource, NODE_KNOWN_KEYS, `graph.nodes[${index}]`),
      position: layoutPosition(index),
    })
    const dependencies = nodeSource.dependsOn
    if (dependencies !== undefined) {
      if (!Array.isArray(dependencies)) throw new Error(`Native Studio graph.nodes[${index}].dependsOn must be an array.`)
      for (const [dependencyIndex, dependency] of dependencies.entries()) {
        const sourceId = requireText(dependency, `graph.nodes[${index}].dependsOn[${dependencyIndex}]`)
        edges.push({ id: edgeId(sourceId, id), source: sourceId, target: id })
      }
    }
  }

  return {
    formatVersion: 1,
    id: graphId,
    sessionId: ownerSessionId,
    providerId: 'native',
    title,
    nodes,
    edges,
    parameters,
    metadata: unknownProperties(source, GRAPH_KNOWN_KEYS, 'graph'),
  }
}

function issue(message: string, field?: string, nodeId?: string): StudioIssue {
  return { message, ...(field === undefined ? {} : { field }), ...(nodeId === undefined ? {} : { nodeId }) }
}

function valueIsJson(value: unknown): boolean {
  try {
    cloneJson(value, 'value')
    return true
  } catch {
    return false
  }
}

function textIssue(value: unknown, field: string, nodeId?: string): StudioIssue | undefined {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\u0000')) return issue(`${field} must be a non-empty string without NUL characters.`, field, nodeId)
  return undefined
}

function positiveIntegerIssue(value: unknown, field: string, nodeId?: string): StudioIssue | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return issue(`${field} must be a positive safe integer.`, field, nodeId)
  return undefined
}

function optionalTimeIssue(value: unknown, field: string, nodeId?: string): StudioIssue | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return issue(`${field} must be a non-negative safe integer.`, field, nodeId)
  return undefined
}

function validateScope(value: unknown, field: string, nodeId: string): StudioIssue[] {
  if (value === undefined) return []
  if (!isRecord(value)) return [issue(`${field} must be an object.`, field, nodeId)]
  const result: StudioIssue[] = []
  for (const key of Object.keys(value)) if (key !== 'read' && key !== 'write') result.push(issue(`${field}.${key} is not a legal native scope field.`, `${field}.${key}`, nodeId))
  for (const key of ['read', 'write'] as const) {
    const paths = value[key]
    if (paths === undefined) continue
    if (!Array.isArray(paths)) {
      result.push(issue(`${field}.${key} must be an array of relative paths.`, `${field}.${key}`, nodeId))
      continue
    }
    for (const [index, path] of paths.entries()) {
      if (typeof path !== 'string' || path.trim() === '' || path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path) || path.split('/').includes('..')) {
        result.push(issue(`${field}.${key}[${index}] must be a relative path.`, `${field}.${key}[${index}]`, nodeId))
      }
    }
  }
  return result
}

function validateProfile(value: unknown, field: string, nodeId: string): StudioIssue[] {
  if (value === undefined) return []
  if (!isRecord(value)) return [issue(`${field} must be an object.`, field, nodeId)]
  const result: StudioIssue[] = []
  for (const key of Object.keys(value)) if (key !== 'model' && key !== 'reasoningEffort') result.push(issue(`${field}.${key} is not a legal native profile field.`, `${field}.${key}`, nodeId))
  for (const key of ['model', 'reasoningEffort'] as const) {
    const valueForKey = value[key]
    if (valueForKey !== undefined) {
      const textError = textIssue(valueForKey, `${field}.${key}`, nodeId)
      if (textError) result.push(textError)
    }
  }
  return result
}

function validateRetry(value: unknown, field: string, nodeId: string): StudioIssue[] {
  if (value === undefined) return []
  if (!isRecord(value)) return [issue(`${field} must be an object.`, field, nodeId)]
  const result: StudioIssue[] = []
  for (const key of Object.keys(value)) if (!['maxAttempts', 'delayMs', 'codes'].includes(key)) result.push(issue(`${field}.${key} is not a legal native retry field.`, `${field}.${key}`, nodeId))
  const maxAttempts = positiveIntegerIssue(value.maxAttempts, `${field}.maxAttempts`, nodeId)
  if (maxAttempts) result.push(maxAttempts)
  if (value.delayMs !== undefined && (typeof value.delayMs !== 'number' || !Number.isSafeInteger(value.delayMs) || value.delayMs < 0)) result.push(issue(`${field}.delayMs must be a non-negative safe integer.`, `${field}.delayMs`, nodeId))
  if (!Array.isArray(value.codes) || value.codes.length === 0) result.push(issue(`${field}.codes must be a non-empty array.`, `${field}.codes`, nodeId))
  else for (const [index, code] of value.codes.entries()) {
    const textError = textIssue(code, `${field}.codes[${index}]`, nodeId)
    if (textError) result.push(textError)
  }
  return result
}

function validateInputFrom(value: unknown, field: string, nodeId: string): StudioIssue[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return [issue(`${field} must be an array of predecessor node ids.`, field, nodeId)]
  return value.flatMap((entry, index) => {
    const textError = textIssue(entry, `${field}[${index}]`, nodeId)
    return textError ? [textError] : []
  })
}

function validateGraph(graph: StudioGraph): readonly StudioIssue[] {
  const result: StudioIssue[] = []
  const candidate = graph as unknown as Record<string, unknown>
  if (candidate.formatVersion !== 1) result.push(issue('graph.formatVersion must be 1.', 'formatVersion'))
  if (candidate.providerId !== 'native') result.push(issue('Native Studio provider only accepts providerId "native".', 'providerId'))
  const idError = textIssue(candidate.id, 'graph.id')
  if (idError) result.push(idError)
  const sessionError = textIssue(candidate.sessionId, 'graph.sessionId')
  if (sessionError) result.push(sessionError)
  const titleError = textIssue(candidate.title, 'graph.title')
  if (titleError) result.push(titleError)
  if (!isRecord(candidate.parameters)) result.push(issue('graph.parameters must be an object.', 'parameters'))
  else {
    const parameters = candidate.parameters
    if (!valueIsJson(parameters)) result.push(issue('graph.parameters must contain only JSON values.', 'parameters'))
    for (const key of Object.keys(parameters)) {
      if (!GRAPH_PARAMETER_KEYS.has(key)) result.push(issue(`graph.parameters.${key} is not a legal native graph field.`, `parameters.${key}`))
    }
    const cwdError = textIssue(parameters.cwd, 'graph.parameters.cwd')
    if (cwdError) result.push(cwdError)
    const parallelError = positiveIntegerIssue(parameters.maxParallel, 'graph.parameters.maxParallel')
    if (parallelError) result.push(parallelError)
    const timeError = optionalTimeIssue(parameters.notBefore, 'graph.parameters.notBefore')
    if (timeError) result.push(timeError)
    if (parameters.bridgeId !== undefined) result.push(issue('GUI dsh_tools bridging is unavailable without a live Agent context; graph.parameters.bridgeId cannot be executed.', 'parameters.bridgeId'))
  }
  if (!isRecord(candidate.metadata) || !valueIsJson(candidate.metadata)) result.push(issue('graph.metadata must be a JSON object.', 'metadata'))
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) {
    result.push(issue('graph.nodes must be a non-empty array.', 'nodes'))
  }
  const nodes = Array.isArray(candidate.nodes) ? candidate.nodes : []
  const nodeIds = new Set<string>()
  for (const [index, rawNode] of nodes.entries()) {
    if (!isRecord(rawNode)) {
      result.push(issue(`graph.nodes[${index}] must be an object.`, `nodes[${index}]`))
      continue
    }
    const nodeId = rawNode.id
    const idTextError = textIssue(nodeId, `graph.nodes[${index}].id`)
    if (idTextError) result.push(idTextError)
    const id = typeof nodeId === 'string' ? nodeId : undefined
    if (id !== undefined) {
      if (nodeIds.has(id)) result.push(issue(`Duplicate native Studio node id "${id}".`, 'id', id))
      nodeIds.add(id)
    }
    if (rawNode.kind !== 'native') result.push(issue('Native Studio nodes must have kind "native".', `nodes[${index}].kind`, id))
    const promptError = textIssue(rawNode.prompt, `graph.nodes[${index}].prompt`, id)
    if (promptError) result.push(promptError)
    if (!isRecord(rawNode.parameters)) {
      result.push(issue(`graph.nodes[${index}].parameters must be an object.`, `nodes[${index}].parameters`, id))
      continue
    }
    const parameters = rawNode.parameters
    if (!valueIsJson(parameters)) result.push(issue('node.parameters must contain only JSON values.', 'parameters', id))
    for (const key of Object.keys(parameters)) {
      if (!NODE_PARAMETER_KEYS.has(key)) result.push(issue(`graph.nodes[${index}].parameters.${key} is not a legal native node field.`, `nodes[${index}].parameters.${key}`, id))
    }
    if (!EXECUTORS.includes(parameters.executor as Executor)) result.push(issue('node.parameters.executor must be codex or claude-code.', 'parameters.executor', id))
    result.push(...validateScope(parameters.scope, `graph.nodes[${index}].parameters.scope`, id ?? String(index)))
    const sessionKeyError = parameters.sessionKey === undefined ? undefined : textIssue(parameters.sessionKey, `graph.nodes[${index}].parameters.sessionKey`, id)
    if (sessionKeyError) result.push(sessionKeyError)
    result.push(...validateProfile(parameters.profile, `graph.nodes[${index}].parameters.profile`, id ?? String(index)))
    const nodeTimeError = optionalTimeIssue(parameters.notBefore, `graph.nodes[${index}].parameters.notBefore`, id)
    if (nodeTimeError) result.push(nodeTimeError)
    result.push(...validateRetry(parameters.retry, `graph.nodes[${index}].parameters.retry`, id ?? String(index)))
    result.push(...validateInputFrom(parameters.inputFrom, `graph.nodes[${index}].parameters.inputFrom`, id ?? String(index)))
    if (!isRecord(rawNode.metadata) || !valueIsJson(rawNode.metadata)) result.push(issue('node.metadata must be a JSON object.', 'metadata', id))
  }
  if (!Array.isArray(candidate.edges)) result.push(issue('graph.edges must be an array.', 'edges'))
  const edges = Array.isArray(candidate.edges) ? candidate.edges : []
  const edgePairs = new Set<string>()
  for (const [index, rawEdge] of edges.entries()) {
    if (!isRecord(rawEdge)) {
      result.push(issue(`graph.edges[${index}] must be an object.`, `edges[${index}]`))
      continue
    }
    for (const key of Object.keys(rawEdge)) if (!['id', 'source', 'target'].includes(key)) result.push(issue(`graph.edges[${index}].${key} is not a legal edge field.`, `edges[${index}].${key}`))
    const sourceError = textIssue(rawEdge.source, `graph.edges[${index}].source`)
    const targetError = textIssue(rawEdge.target, `graph.edges[${index}].target`)
    const edgeIdError = textIssue(rawEdge.id, `graph.edges[${index}].id`)
    if (edgeIdError) result.push(edgeIdError)
    if (sourceError) result.push(sourceError)
    if (targetError) result.push(targetError)
    const source = typeof rawEdge.source === 'string' ? rawEdge.source : undefined
    const target = typeof rawEdge.target === 'string' ? rawEdge.target : undefined
    if (source !== undefined && !nodeIds.has(source)) result.push(issue(`Edge source "${source}" is not a graph node.`, `edges[${index}].source`))
    if (target !== undefined && !nodeIds.has(target)) result.push(issue(`Edge target "${target}" is not a graph node.`, `edges[${index}].target`))
    if (source !== undefined && target !== undefined) {
      if (source === target) result.push(issue(`Node "${source}" cannot depend on itself.`, `edges[${index}]`))
      const pair = `${source}\u0000${target}`
      if (edgePairs.has(pair)) result.push(issue(`Duplicate dependency edge ${source}->${target}.`, `edges[${index}]`))
      edgePairs.add(pair)
    }
  }
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  for (const edge of edges) {
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string') continue
    const targets = outgoing.get(edge.source) ?? []
    targets.push(edge.target)
    outgoing.set(edge.source, targets)
    const sources = incoming.get(edge.target) ?? []
    sources.push(edge.source)
    incoming.set(edge.target, sources)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (nodeId: string): void => {
    const current = state.get(nodeId)
    if (current === 'visiting') {
      result.push(issue(`Graph contains a dependency cycle at node "${nodeId}".`, 'edges'))
      return
    }
    if (current === 'done') return
    state.set(nodeId, 'visiting')
    for (const target of outgoing.get(nodeId) ?? []) visit(target)
    state.set(nodeId, 'done')
  }
  for (const nodeId of nodeIds) visit(nodeId)
  for (const [index, rawNode] of nodes.entries()) {
    if (!isRecord(rawNode) || !isRecord(rawNode.parameters)) continue
    const nodeId = typeof rawNode.id === 'string' ? rawNode.id : undefined
    if (nodeId === undefined || !Array.isArray(rawNode.parameters.inputFrom)) continue
    const predecessorSet = new Set(incoming.get(nodeId) ?? [])
    const seen = new Set<string>()
    for (const [inputIndex, input] of rawNode.parameters.inputFrom.entries()) {
      if (typeof input !== 'string') continue
      if (seen.has(input)) result.push(issue(`node.parameters.inputFrom cannot contain duplicate predecessor "${input}".`, `nodes[${index}].parameters.inputFrom[${inputIndex}]`, nodeId))
      seen.add(input)
      if (!nodeIds.has(input)) result.push(issue(`node.parameters.inputFrom references unknown node "${input}".`, `nodes[${index}].parameters.inputFrom[${inputIndex}]`, nodeId))
      else if (!predecessorSet.has(input)) result.push(issue(`node.parameters.inputFrom "${input}" must be a dependency edge of "${nodeId}".`, `nodes[${index}].parameters.inputFrom[${inputIndex}]`, nodeId))
    }
  }
  return result
}

function nativeGraphFromStudio(graph: StudioGraph, commandId: string): TaskGraph {
  const errors = validateGraph(graph)
  if (errors.length > 0) throw new Error(errors.map((entry) => entry.message).join(' '))
  const parameters = graph.parameters as unknown as Record<string, unknown>
  const dependencies = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const existing = dependencies.get(edge.target) ?? []
    existing.push(edge.source)
    dependencies.set(edge.target, existing)
  }
  const nativeNodes: TaskNode[] = graph.nodes.map((node) => {
    const nodeParameters = node.parameters as unknown as Record<string, unknown>
    const inputFrom = nodeParameters.inputFrom
    const nativeNode = {
      id: node.id,
      executor: nodeParameters.executor as Executor,
      prompt: node.prompt,
      ...(dependencies.get(node.id)?.length ? { dependsOn: dependencies.get(node.id) } : {}),
      ...(nodeParameters.scope === undefined ? {} : { scope: nodeParameters.scope as TaskScope }),
      ...(nodeParameters.sessionKey === undefined ? {} : { sessionKey: nodeParameters.sessionKey as string }),
      ...(nodeParameters.profile === undefined ? {} : { profile: nodeParameters.profile as TaskNode['profile'] }),
      ...(nodeParameters.notBefore === undefined ? {} : { notBefore: nodeParameters.notBefore as number }),
      ...(nodeParameters.retry === undefined ? {} : { retry: nodeParameters.retry as TaskNode['retry'] }),
      ...(inputFrom === undefined ? {} : { inputFrom: inputFrom as readonly string[] }),
    } as unknown as TaskNode
    return nativeNode
  })
  return {
    formatVersion: 1,
    id: `studio-native-${commandId}`,
    label: graph.title,
    cwd: parameters.cwd as string,
    maxParallel: parameters.maxParallel as number,
    ...(parameters.notBefore === undefined ? {} : { notBefore: parameters.notBefore as number }),
    // bridgeId is rejected by validateGraph: a GUI request cannot prove the
    // live Agent authorization required by Resident's bridge binding.
    nodes: nativeNodes,
  }
}

function mapGraphStatus(value: unknown): StudioRunStatus {
  return GRAPH_STATUSES.includes(value as GraphStatus) ? GRAPH_STATUS_MAP[value as GraphStatus] : 'unknown'
}

function mapNodeStatus(value: unknown): StudioRunStatus {
  return NODE_STATUSES.includes(value as NodeStatus) ? NODE_STATUS_MAP[value as NodeStatus] : 'unknown'
}

function timestamp(value: unknown, fallback: Date): string {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : fallback.toISOString()
}

function aggregateOutput(nodes: readonly NodeSnapshot[]): { readonly output?: string; readonly message?: string } {
  const outputs = nodes.filter((node) => node.output !== undefined).map((node) => `${node.id}: ${node.output ?? ''}`)
  const errors = nodes.filter((node) => node.error !== undefined).map((node) => `${node.id}: ${node.error?.code ?? 'NATIVE_ERROR'}: ${node.error?.message ?? 'Native node failed.'}`)
  return {
    ...(outputs.length === 0 ? {} : { output: outputs.join('\n\n') }),
    ...(errors.length === 0 ? {} : { message: errors.join('\n\n') }),
  }
}

export function nativeSnapshotToStudioRun(snapshot: GraphSnapshot, sessionId: string, commandId: string, now: Date): StudioRun {
  const nodeResults: StudioNodeResult[] = snapshot.nodes.map((node) => ({
    nodeId: node.id,
    status: mapNodeStatus(node.status),
    ...(node.output === undefined ? {} : { output: node.output }),
    ...(node.error === undefined ? {} : { error: `${node.error.code}: ${node.error.message}` }),
  }))
  const aggregate = aggregateOutput(snapshot.nodes)
  return {
    id: commandId,
    sessionId,
    providerId: 'native',
    status: mapGraphStatus(snapshot.status),
    nodes: nodeResults,
    createdAt: timestamp(snapshot.createdAt, now),
    updatedAt: timestamp(snapshot.updatedAt, now),
    ...aggregate,
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

/** Create the native provider around the public Resident submit/inspect seam. */
export function createNativeStudioProvider(options: NativeStudioProviderOptions): StudioProvider {
  if (!options.resident || typeof options.resident.submit !== 'function' || typeof options.resident.inspect !== 'function') {
    throw new Error('Native Studio provider requires Resident submit and inspect capabilities.')
  }
  const now = options.now ?? (() => new Date())
  const commandSessions = new Map<string, string>()
  const commandInputs = new Map<string, string>()
  const commandRuns = new Map<string, Promise<StudioRun>>()

  const provider: StudioProvider = {
    id: 'native',
    label: options.label ?? 'Native Resident',
    async validate(graph) {
      return validateGraph(graph)
    },
    async execute(request: StudioExecuteRequest): Promise<StudioRun> {
      const requestRecord = request as unknown as Record<string, unknown>
      const sessionError = textIssue(requestRecord.sessionId, 'request.sessionId')
      if (sessionError) throw new Error(sessionError.message)
      const commandError = textIssue(requestRecord.commandId, 'request.commandId')
      if (commandError) throw new Error(commandError.message)
      if (request.sessionId !== request.graph.sessionId) throw new Error('Native Studio session mismatch: request.sessionId must equal graph.sessionId.')
      if (request.graph.providerId !== 'native') throw new Error('Native Studio provider only accepts providerId "native".')
      const graphErrors = validateGraph(request.graph)
      if (graphErrors.length > 0) throw new Error(graphErrors.map((entry) => entry.message).join(' '))
      request.signal?.throwIfAborted()
      const commandId = request.commandId
      const graphFingerprint = canonicalJson(request.graph)
      const previousSession = commandSessions.get(commandId)
      if (previousSession !== undefined && previousSession !== request.sessionId) throw new Error(`Native Studio command ${commandId} belongs to another session.`)
      const previousInput = commandInputs.get(commandId)
      if (previousInput !== undefined && previousInput !== graphFingerprint) throw new Error(`Native Studio command ${commandId} was already submitted with different graph input.`)
      const previousRun = commandRuns.get(commandId)
      if (previousRun !== undefined) return previousRun

      commandSessions.set(commandId, request.sessionId)
      commandInputs.set(commandId, graphFingerprint)
      const nativeGraph = nativeGraphFromStudio(request.graph, commandId)
      const runPromise = (async (): Promise<StudioRun> => {
        const snapshot = await options.resident.submit({ commandId, graph: nativeGraph })
        if (snapshot.graph.id !== nativeGraph.id) throw new Error(`Resident returned graph ${snapshot.graph.id}, expected ${nativeGraph.id}.`)
        return nativeSnapshotToStudioRun(snapshot, request.sessionId, commandId, now())
      })()
      commandRuns.set(commandId, runPromise)
      return runPromise
    },
    async inspect(sessionId: string, commandId: string): Promise<StudioRun> {
      requireText(sessionId, 'sessionId')
      requireText(commandId, 'commandId')
      const previousSession = commandSessions.get(commandId)
      if (previousSession !== undefined && previousSession !== sessionId) throw new Error(`Native Studio command ${commandId} belongs to another session.`)
      const graphId = `studio-native-${commandId}`
      const snapshot = await options.resident.inspect(graphId)
      if (snapshot.graph.id !== graphId) throw new Error(`Resident returned graph ${snapshot.graph.id}, expected ${graphId}.`)
      commandSessions.set(commandId, sessionId)
      const run = nativeSnapshotToStudioRun(snapshot, sessionId, commandId, now())
      // An inspection proves that this command already exists.  Keep an
      // explicit marker so a later execute call cannot turn the read into a
      // replacement submission with the same command id.
      if (!commandInputs.has(commandId)) commandInputs.set(commandId, `inspection:${graphId}`)
      if (!commandRuns.has(commandId)) commandRuns.set(commandId, Promise.resolve(run))
      return run
    },
  }
  return provider
}

/** Focused adapter validation is intentionally exported for provider tests only. */
export function validateNativeStudioGraph(graph: StudioGraph): readonly StudioIssue[] {
  return validateGraph(graph)
}
