import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  Executor,
  GraphSnapshot,
  ModelCatalog,
  NativeModel,
  NativeProfile,
  ResidentApi,
  TaskGraph,
  TaskNode,
  TaskScope,
} from '@lisihao/dsh-solar-native-resident/contracts'
import { normalizeDshTools } from './validation.js'

const EXECUTORS: readonly Executor[] = ['codex', 'claude-code']
const RESIDENT_PROTOCOL_VERSION = 1

export interface AllocationHint {
  readonly profile?: string
  readonly executor?: Executor
  readonly model?: string
  readonly reasoningEffort?: string
}

export interface AllocationProfile extends AllocationHint {
  readonly profile?: never
}

export interface AllocationConfig {
  readonly allocationProfiles: Readonly<Record<string, AllocationProfile>>
  readonly roleMapping: Readonly<Record<string, string>>
}

export interface CoordinateNodeAssignment {
  readonly nodeId: string
  readonly executor: Executor
  readonly model?: string
  readonly reasoningEffort?: string
  readonly profile?: string
}

export interface CoordinateOutput {
  readonly kind: 'resident-graph'
  readonly graphId: string
  readonly status: GraphSnapshot['status']
  readonly revision: number
  readonly assignments: CoordinateNodeAssignment[]
}

interface RawNode {
  readonly id: string
  readonly prompt: string
  readonly executor?: Executor
  readonly role?: string
  readonly dependsOn?: readonly string[]
  readonly scope?: TaskScope
  readonly sessionKey?: string
  readonly profile?: NativeProfile
  readonly allocation?: AllocationHint
  readonly notBefore?: number
  readonly retry?: TaskNode['retry']
}

interface RawGraph {
  readonly formatVersion: 1
  readonly id?: string
  readonly label: string
  readonly cwd: string
  readonly maxParallel: number
  readonly notBefore?: number
  readonly nodes: readonly RawNode[]
}

interface RawAllocation {
  readonly profile?: string
  readonly executor?: Executor
  readonly model?: string
  readonly reasoningEffort?: string
  readonly roles: Readonly<Record<string, string>>
  readonly nodes: Readonly<Record<string, AllocationHint>>
}

interface ParsedCoordinateInput {
  readonly graph: RawGraph
  readonly allocation: RawAllocation
}

interface PartialSelection {
  executor?: Executor
  model?: string
  reasoningEffort?: string
  profile?: string
}

type CoordinateExecution = ToolRunContext

export interface CoordinateServices {
  readonly resident: ResidentApi
  readonly bindBridge?: (bridgeId: string, owner: ToolRunContext, allowedTools?: readonly string[]) => Promise<void>
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`solar_coordinate ${field} must be a string`)
  const result = value.trim()
  if (!result) throw new Error(`solar_coordinate ${field} must not be empty`)
  if (result.includes('\u0000')) throw new Error(`solar_coordinate ${field} must not contain NUL characters`)
  return result
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field)
}

function executor(value: unknown, field: string): Executor {
  if (typeof value !== 'string' || !EXECUTORS.includes(value as Executor)) {
    throw new Error(`solar_coordinate ${field} must be one of: ${EXECUTORS.join(', ')}`)
  }
  return value as Executor
}

function optionalExecutor(value: unknown, field: string): Executor | undefined {
  return value === undefined ? undefined : executor(value, field)
}

function positiveInteger(value: unknown, field: string, defaultValue?: number): number {
  if (value === undefined && defaultValue !== undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`solar_coordinate ${field} must be a positive safe integer`)
  }
  return value
}

function nonNegativeNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`solar_coordinate ${field} must be a non-negative number`)
  }
  return value
}

function relativePaths(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error(`solar_coordinate ${field} must be an array of relative paths`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const [index, entry] of value.entries()) {
    const path = text(entry, `${field}[${index}]`)
    if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) {
      throw new Error(`solar_coordinate ${field}[${index}] must be a relative path`)
    }
    if (!seen.has(path)) {
      seen.add(path)
      result.push(path)
    }
  }
  return result.length === 0 ? undefined : result
}

function scope(value: unknown, field: string): TaskScope | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`solar_coordinate ${field} must be an object with read/write arrays`)
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (key !== 'read' && key !== 'write') throw new Error(`solar_coordinate ${field} has unsupported field "${key}"`)
  }
  const read = relativePaths(source.read, `${field}.read`)
  const write = relativePaths(source.write, `${field}.write`)
  return read === undefined && write === undefined ? undefined : { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) }
}

function profile(value: unknown, field: string): NativeProfile | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`solar_coordinate ${field} must be an object`)
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (key !== 'model' && key !== 'reasoningEffort' && key !== 'reasoning_effort') {
      throw new Error(`solar_coordinate ${field} has unsupported field "${key}"`)
    }
  }
  const model = optionalText(source.model, `${field}.model`)
  const reasoningEffort = optionalText(source.reasoningEffort ?? source.reasoning_effort, `${field}.reasoningEffort`)
  if (model === undefined && reasoningEffort === undefined) return undefined
  return { ...(model === undefined ? {} : { model }), ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function allocationHint(value: unknown, field: string): AllocationHint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`solar_coordinate ${field} must be an object`)
  }
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!['profile', 'executor', 'model', 'reasoningEffort', 'reasoning_effort'].includes(key)) {
      throw new Error(`solar_coordinate ${field} has unsupported field "${key}"`)
    }
  }
  const profileName = optionalText(source.profile, `${field}.profile`)
  const selectedExecutor = optionalExecutor(source.executor, `${field}.executor`)
  const model = optionalText(source.model, `${field}.model`)
  const reasoningEffort = optionalText(source.reasoningEffort ?? source.reasoning_effort, `${field}.reasoningEffort`)
  return {
    ...(profileName === undefined ? {} : { profile: profileName }),
    ...(selectedExecutor === undefined ? {} : { executor: selectedExecutor }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function stringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`solar_coordinate ${field} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    result[text(key, `${field} key`)] = text(item, `${field}.${key}`)
  }
  return result
}

function recordMap(value: unknown, field: string): Readonly<Record<string, AllocationHint>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`solar_coordinate ${field} must be an object`)
  const result: Record<string, AllocationHint> = {}
  for (const [key, item] of Object.entries(value)) result[text(key, `${field} key`)] = allocationHint(item, `${field}.${key}`)
  return result
}

function parseRetry(value: unknown, field: string): TaskNode['retry'] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`solar_coordinate ${field} must be an object`)
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!['maxAttempts', 'delayMs', 'codes'].includes(key)) throw new Error(`solar_coordinate ${field} has unsupported field "${key}"`)
  }
  const maxAttempts = positiveInteger(source.maxAttempts, `${field}.maxAttempts`)
  const delayMs = source.delayMs === undefined ? 0 : nonNegativeNumber(source.delayMs, `${field}.delayMs`)
  if (delayMs === undefined || !Number.isSafeInteger(delayMs)) throw new Error(`solar_coordinate ${field}.delayMs must be a non-negative safe integer`)
  if (!Array.isArray(source.codes)) throw new Error(`solar_coordinate ${field}.codes must be an array`)
  const codes = source.codes.map((code, index) => text(code, `${field}.codes[${index}]`))
  return { maxAttempts, delayMs, codes }
}

function parseNode(value: unknown, index: number): RawNode {
  const field = `graph.nodes[${index}]`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const source = value as Record<string, unknown>
  const allowed = new Set(['id', 'prompt', 'executor', 'role', 'dependsOn', 'scope', 'sessionKey', 'session_key', 'profile', 'allocation', 'notBefore', 'retry'])
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`${field} has unsupported field "${key}"`)
  const id = text(source.id, `${field}.id`)
  const prompt = text(source.prompt, `${field}.prompt`)
  const selectedExecutor = optionalExecutor(source.executor, `${field}.executor`)
  const role = optionalText(source.role, `${field}.role`)
  let dependsOn: readonly string[] | undefined
  if (source.dependsOn !== undefined) {
    if (!Array.isArray(source.dependsOn)) throw new Error(`${field}.dependsOn must be an array`)
    dependsOn = source.dependsOn.map((dependency, dependencyIndex) => text(dependency, `${field}.dependsOn[${dependencyIndex}]`))
  }
  if (source.sessionKey !== undefined && source.session_key !== undefined) throw new Error(`${field} must provide only one of sessionKey or session_key`)
  const sessionKey = optionalText(source.sessionKey ?? source.session_key, `${field}.sessionKey`)
  const notBefore = nonNegativeNumber(source.notBefore, `${field}.notBefore`)
  const taskProfile = profile(source.profile, `${field}.profile`)
  const taskAllocation = source.allocation === undefined ? undefined : allocationHint(source.allocation, `${field}.allocation`)
  const mergedAllocation = {
    ...(selectedExecutor === undefined ? {} : { executor: selectedExecutor }),
    ...(taskProfile?.model === undefined ? {} : { model: taskProfile.model }),
    ...(taskProfile?.reasoningEffort === undefined ? {} : { reasoningEffort: taskProfile.reasoningEffort }),
    ...(taskAllocation === undefined ? {} : taskAllocation),
  }
  const hasAllocation = Object.keys(mergedAllocation).length > 0
  return {
    id,
    prompt,
    ...(selectedExecutor === undefined ? {} : { executor: selectedExecutor }),
    ...(role === undefined ? {} : { role }),
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(scope(source.scope, `${field}.scope`) === undefined ? {} : { scope: scope(source.scope, `${field}.scope`) }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(taskProfile === undefined ? {} : { profile: taskProfile }),
    ...(hasAllocation ? { allocation: mergedAllocation } : {}),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(source.retry === undefined ? {} : { retry: parseRetry(source.retry, `${field}.retry`) }),
  }
}

function parseGraph(value: unknown): RawGraph {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('solar_coordinate graph must be an object')
  const source = value as Record<string, unknown>
  const allowed = new Set(['formatVersion', 'id', 'label', 'cwd', 'maxParallel', 'notBefore', 'nodes'])
  for (const key of Object.keys(source)) if (!allowed.has(key)) throw new Error(`solar_coordinate graph has unsupported field "${key}"`)
  if (source.formatVersion !== 1) throw new Error('solar_coordinate graph.formatVersion must be 1')
  const label = source.label === undefined ? 'Solar coordinated collaboration' : text(source.label, 'graph.label')
  const cwd = text(source.cwd, 'graph.cwd')
  const maxParallel = positiveInteger(source.maxParallel, 'graph.maxParallel', 1)
  const notBefore = nonNegativeNumber(source.notBefore, 'graph.notBefore')
  if (!Array.isArray(source.nodes) || source.nodes.length === 0) throw new Error('solar_coordinate graph.nodes must be a non-empty array')
  const nodes = source.nodes.map((node, index) => parseNode(node, index))
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new Error(`solar_coordinate graph has duplicate node id "${node.id}"`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === node.id) throw new Error(`solar_coordinate node "${node.id}" cannot depend on itself`)
      if (!ids.has(dependency)) throw new Error(`solar_coordinate node "${node.id}" depends on unknown node "${dependency}"`)
    }
  }
  assertAcyclic(nodes)
  const id = source.id === undefined ? undefined : text(source.id, 'graph.id')
  return { formatVersion: 1, ...(id === undefined ? {} : { id }), label, cwd, maxParallel, ...(notBefore === undefined ? {} : { notBefore }), nodes }
}

function parseAllocation(value: unknown): RawAllocation {
  if (value === undefined) return { roles: {}, nodes: {} }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('solar_coordinate allocation must be an object')
  const source = value as Record<string, unknown>
  for (const key of Object.keys(source)) if (!['profile', 'executor', 'model', 'reasoningEffort', 'reasoning_effort', 'roles', 'nodes'].includes(key)) throw new Error(`solar_coordinate allocation has unsupported field "${key}"`)
  const direct = allocationHint({
    ...(source.profile === undefined ? {} : { profile: source.profile }),
    ...(source.executor === undefined ? {} : { executor: source.executor }),
    ...(source.model === undefined ? {} : { model: source.model }),
    ...(source.reasoningEffort === undefined ? {} : { reasoningEffort: source.reasoningEffort }),
    ...(source.reasoning_effort === undefined ? {} : { reasoning_effort: source.reasoning_effort }),
  }, 'allocation')
  return {
    ...(direct.profile === undefined ? {} : { profile: direct.profile }),
    ...(direct.executor === undefined ? {} : { executor: direct.executor }),
    ...(direct.model === undefined ? {} : { model: direct.model }),
    ...(direct.reasoningEffort === undefined ? {} : { reasoningEffort: direct.reasoningEffort }),
    roles: stringMap(source.roles, 'allocation.roles'),
    nodes: recordMap(source.nodes, 'allocation.nodes'),
  }
}

function assertAcyclic(nodes: readonly RawNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`solar_coordinate graph contains a dependency cycle at node "${id}"`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const node of nodes) visit(node.id)
}

function mergeSelection(...selections: readonly (PartialSelection | undefined)[]): PartialSelection {
  const result: PartialSelection = {}
  for (const selection of selections) {
    if (selection?.executor !== undefined) result.executor = selection.executor
    if (selection?.model !== undefined) result.model = selection.model
    if (selection?.reasoningEffort !== undefined) result.reasoningEffort = selection.reasoningEffort
    if (selection?.profile !== undefined) result.profile = selection.profile
  }
  return result
}

function profileSelection(name: string | undefined, config: AllocationConfig): PartialSelection | undefined {
  if (name === undefined) return undefined
  const selected = config.allocationProfiles[name]
  if (selected === undefined) throw new Error(`solar_coordinate allocation profile "${name}" is not configured`)
  return { ...selected, profile: name }
}

function resolveHint(hint: AllocationHint | undefined, config: AllocationConfig): PartialSelection | undefined {
  if (hint === undefined) return undefined
  return mergeSelection(profileSelection(hint.profile, config), hint)
}

function rawAllocationSelection(allocation: RawAllocation, config: AllocationConfig): PartialSelection {
  return mergeSelection(
    profileSelection(allocation.profile, config),
    {
      ...(allocation.executor === undefined ? {} : { executor: allocation.executor }),
      ...(allocation.model === undefined ? {} : { model: allocation.model }),
      ...(allocation.reasoningEffort === undefined ? {} : { reasoningEffort: allocation.reasoningEffort }),
    },
  )
}

function selectionForNode(node: RawNode, allocation: RawAllocation, config: AllocationConfig): PartialSelection {
  const roleProfileName = node.role === undefined ? undefined : allocation.roles[node.role] ?? config.roleMapping[node.role]
  return mergeSelection(
    rawAllocationSelection(allocation, config),
    profileSelection(roleProfileName, config),
    resolveHint(allocation.nodes[node.id], config),
    resolveHint(node.allocation, config),
  )
}

function catalogModels(catalogs: readonly ModelCatalog[]): Array<{ executor: Executor; model: NativeModel }> {
  const result: Array<{ executor: Executor; model: NativeModel }> = []
  for (const catalog of catalogs) {
    if (!EXECUTORS.includes(catalog.executor)) continue
    for (const model of catalog.models) {
      if (typeof model.id === 'string' && model.id.trim()) result.push({ executor: catalog.executor, model })
    }
  }
  return result
}

function chooseAdvertised(selection: PartialSelection, advertised: readonly { executor: Executor; model: NativeModel }[]): PartialSelection {
  const filtered = advertised.filter((entry) => selection.executor === undefined || entry.executor === selection.executor).filter((entry) => selection.model === undefined || entry.model.id === selection.model)
  if (filtered.length === 0) {
    throw new Error(`solar_coordinate could not match the requested native selection${selection.model === undefined ? '' : ` model "${selection.model}"`} in the advertised catalog`)
  }
  const chosen = filtered.find((entry) => entry.model.isDefault === true) ?? filtered[0]
  if (chosen === undefined) throw new Error('solar_coordinate advertised model catalog was empty')
  return { ...selection, executor: selection.executor ?? chosen.executor, model: selection.model ?? chosen.model.id }
}

function validateEffort(selection: PartialSelection, advertised: readonly { executor: Executor; model: NativeModel }[]): void {
  if (selection.reasoningEffort === undefined) return
  if (selection.executor === undefined || selection.model === undefined) {
    throw new Error('solar_coordinate cannot validate reasoning effort before executor and model selection')
  }
  const match = advertised.find((entry) => entry.executor === selection.executor && entry.model.id === selection.model)
  if (match === undefined || match.model.reasoningEfforts === undefined || !match.model.reasoningEfforts.includes(selection.reasoningEffort)) {
    throw new Error(`solar_coordinate reasoning effort "${selection.reasoningEffort}" is not advertised for ${selection.executor}/${selection.model}`)
  }
}

function materializePrompt(node: RawNode, assignment: CoordinateNodeAssignment): string {
  return [
    'Solar coordinated collaboration node',
    `node: ${node.id}`,
    `executor: ${assignment.executor}`,
    `model: ${assignment.model ?? '(native default)'}`,
    `reasoning effort: ${assignment.reasoningEffort ?? '(native default)'}`,
    ...(node.role === undefined ? [] : [`role: ${node.role}`]),
    'task:',
    node.prompt,
    'constraints:',
    '- Preserve the graph dependencies and declared scope.',
    '- Report refusal, cancellation, failure, and partial work honestly.',
  ].join('\n')
}

export function parseCoordinateInput(graph: unknown, allocation: unknown): ParsedCoordinateInput {
  return { graph: parseGraph(graph), allocation: parseAllocation(allocation) }
}

export async function buildCoordinateGraph(
  rawGraph: unknown,
  rawAllocation: unknown,
  config: AllocationConfig,
  models: (() => Promise<readonly ModelCatalog[]>) | undefined,
  graphId: string,
): Promise<{ graph: TaskGraph; assignments: CoordinateNodeAssignment[] }> {
  const parsed = parseCoordinateInput(rawGraph, rawAllocation)
  const needsCatalog = parsed.graph.nodes.some((node) => {
    const selection = selectionForNode(node, parsed.allocation, config)
    return selection.executor === undefined || selection.reasoningEffort !== undefined
  })
  let advertised: readonly { executor: Executor; model: NativeModel }[] = []
  if (needsCatalog) {
    if (models === undefined) throw new Error('solar_coordinate automatic allocation requires the Resident model catalog')
    const catalogs = await models()
    advertised = catalogModels(catalogs)
    if (advertised.length === 0) {
      const reasons = catalogs.map((catalog) => catalog.unavailableReason).filter((reason): reason is string => reason !== undefined && reason.trim() !== '')
      throw new Error(`solar_coordinate automatic allocation requires an available Resident model catalog${reasons.length === 0 ? '' : `: ${reasons.join('; ')}`}`)
    }
  }

  const assignments: CoordinateNodeAssignment[] = []
  const nodes: TaskNode[] = []
  for (const node of parsed.graph.nodes) {
    let selection = selectionForNode(node, parsed.allocation, config)
    if (selection.executor === undefined || (selection.model === undefined && selection.reasoningEffort !== undefined)) {
      selection = chooseAdvertised(selection, advertised)
    }
    if (selection.executor === undefined) throw new Error(`solar_coordinate could not select an executor for node "${node.id}"`)
    if (selection.reasoningEffort !== undefined) {
      if (models === undefined) throw new Error(`solar_coordinate cannot verify reasoning effort for node "${node.id}" without the Resident model catalog`)
      validateEffort(selection, advertised)
    }
    const assignment: CoordinateNodeAssignment = {
      nodeId: node.id,
      executor: selection.executor,
      ...(selection.model === undefined ? {} : { model: selection.model }),
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      ...(selection.profile === undefined ? {} : { profile: selection.profile }),
    }
    assignments.push(assignment)
    const nativeProfile: NativeProfile | undefined = selection.model === undefined && selection.reasoningEffort === undefined
      ? undefined
      : { ...(selection.model === undefined ? {} : { model: selection.model }), ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
    nodes.push({
      id: node.id,
      executor: selection.executor,
      prompt: materializePrompt(node, assignment),
      ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }),
      ...(node.scope === undefined ? {} : { scope: node.scope }),
      ...(node.sessionKey === undefined ? {} : { sessionKey: node.sessionKey }),
      ...(nativeProfile === undefined ? {} : { profile: nativeProfile }),
      ...(node.notBefore === undefined ? {} : { notBefore: node.notBefore }),
      ...(node.retry === undefined ? {} : { retry: node.retry }),
    })
  }
  return {
    graph: {
      formatVersion: 1,
      id: graphId,
      label: parsed.graph.label,
      cwd: parsed.graph.cwd,
      maxParallel: parsed.graph.maxParallel,
      ...(parsed.graph.notBefore === undefined ? {} : { notBefore: parsed.graph.notBefore }),
      nodes,
    },
    assignments,
  }
}

export async function coordinateResident(
  rawGraph: unknown,
  rawAllocation: unknown,
  rawDshTools: unknown,
  exec: CoordinateExecution,
  config: AllocationConfig,
  services: CoordinateServices,
): Promise<CoordinateOutput> {
  exec.signal.throwIfAborted()
  if (services.resident.protocolVersion !== RESIDENT_PROTOCOL_VERSION) {
    throw new Error(`solar_coordinate requires Resident protocol version ${RESIDENT_PROTOCOL_VERSION}`)
  }
  const residentWithModels = services.resident as ResidentApi & { models?: (cwd: string) => Promise<readonly ModelCatalog[]> }
  const parsed = parseCoordinateInput(rawGraph, rawAllocation)
  const commandId = `native-collaboration-coordinate:${exec.callId}`
  const graphId = parsed.graph.id ?? `${commandId}:graph`
  const built = await buildCoordinateGraph(rawGraph, rawAllocation, config, residentWithModels.models === undefined ? undefined : () => residentWithModels.models!(parsed.graph.cwd), graphId)
  const dshTools = normalizeDshTools(rawDshTools, 'dsh_tools')
  const bridgeId = dshTools === undefined ? undefined : `${commandId}:bridge`
  if (bridgeId !== undefined) {
    if (services.bindBridge === undefined) {
      throw new Error('solar_coordinate with dsh_tools requires the Resident bindBridge capability')
    }
    if (exec.agent === undefined) {
      throw new Error('solar_coordinate with dsh_tools requires the calling Agent for DSH tool bridge ownership')
    }
    await services.bindBridge(bridgeId, exec, dshTools)
  }
  const snapshot = await services.resident.submit({
    commandId,
    graph: { ...built.graph, ...(bridgeId === undefined ? {} : { bridgeId }) },
  })
  return {
    kind: 'resident-graph',
    graphId: snapshot.graph.id,
    status: snapshot.status,
    revision: snapshot.revision,
    assignments: built.assignments,
  }
}
