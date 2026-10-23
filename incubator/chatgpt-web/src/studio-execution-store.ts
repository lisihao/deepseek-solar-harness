import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'

import type {
  JsonObject,
  JsonValue,
  StudioGraph,
  StudioNode,
  StudioProviderId,
  StudioRun,
  StudioRunStatus,
} from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import {
  INSIGHT_STORE_FORMAT_VERSION,
  cloneInsight,
  stableInsightJson,
  templateHash,
  type InsightArtifact,
  type InsightExternalResource,
  type InsightModelSelection,
  type InsightObservedSelection,
  type InsightProvenance,
  type InsightAnswer,
  type InsightQuestion,
  type InsightTemplate,
} from './insight-contract.js'

export const STUDIO_EXECUTION_FORMAT_VERSION = 1 as const

export type StudioExecutionPhase = 'web' | 'clarify' | 'questions' | 'plan' | 'confirmation' | 'research' | 'thinking' | 'search' | 'review' | 'output'
export type StudioExecutionPhaseStatus = 'pending' | 'calling' | 'complete' | 'needs-input' | 'needs-confirmation' | 'quota-exhausted' | 'unknown' | 'failed' | 'cancelled'

export interface StudioPhaseExecution {
  readonly nodeId: string
  readonly phase: StudioExecutionPhase
  readonly round?: number
  /** Immutable phase identity; a resource can be shared by distinct phases. */
  readonly commandId: string
  readonly status: StudioExecutionPhaseStatus
  readonly resource?: InsightExternalResource
  /** The resource which produced a plan when research continues in that same page/session. */
  readonly sourceResource?: InsightExternalResource
  readonly requested?: InsightModelSelection
  readonly observed?: InsightObservedSelection
  readonly template?: InsightTemplate
  readonly renderedInput: string
  readonly assetIds: readonly string[]
  readonly questions?: readonly InsightQuestion[]
  readonly answers?: readonly InsightAnswer[]
  readonly reason?: string
  readonly failureCode?: string
  readonly quotaEvidence?: string
  readonly resetInformation?: string
  readonly intentAt?: string
  readonly completedAt?: string
}

export interface StudioNodeExecution {
  readonly nodeId: string
  readonly status: StudioRunStatus
  readonly phases: readonly StudioPhaseExecution[]
  readonly outputAssetId?: string
  readonly error?: string
}

export interface StudioExecutionRecord {
  readonly formatVersion: 1
  readonly commandId: string
  readonly revision: number
  /** Immutable edited graph snapshot captured at admission. */
  readonly graph: StudioGraph
  readonly status: StudioRunStatus
  readonly nodes: readonly StudioNodeExecution[]
  /** Full raw provider artifacts, citations, visible evidence and provenance. */
  readonly artifacts: readonly InsightArtifact[]
  readonly output?: string
  readonly message?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export interface StudioExecutionPatch {
  readonly status?: StudioRunStatus
  readonly nodes?: readonly StudioNodeExecution[]
  readonly artifacts?: readonly InsightArtifact[]
  readonly output?: string
  readonly message?: string
}

export type StudioExecutionStoreErrorCode =
  | 'STUDIO_COMMAND_CONFLICT'
  | 'STUDIO_SESSION_MISMATCH'
  | 'STUDIO_STATE_VERSION'
  | 'STUDIO_STATE_INVALID'
  | 'STUDIO_STATE_CONFLICT'

export class StudioExecutionStoreError extends Error {
  constructor(readonly code: StudioExecutionStoreErrorCode, message: string) {
    super(message)
    this.name = 'StudioExecutionStoreError'
  }
}

const ROOT_MODE = 0o700
const RECORD_MODE = 0o600
const REVISION_FILE_PATTERN = /^(0|[1-9][0-9]*)\.json$/
const PROVIDERS = new Set<StudioProviderId>(['native', 'web', 'insight'])
const NODE_KINDS = new Set(['native', 'chatgpt-web', 'clarify', 'gemini-research', 'gemini-thinking', 'chatgpt-search', 'chatgpt-review', 'output'])
const RUN_STATUSES = new Set<StudioRunStatus>(['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown', 'needs-input'])
const PHASES = new Set<StudioExecutionPhase>(['web', 'clarify', 'questions', 'plan', 'confirmation', 'research', 'thinking', 'search', 'review', 'output'])
const PHASE_STATUSES = new Set<StudioExecutionPhaseStatus>(['pending', 'calling', 'complete', 'needs-input', 'needs-confirmation', 'quota-exhausted', 'unknown', 'failed', 'cancelled'])

type JsonRecord = Record<string, unknown>

function storeError(code: StudioExecutionStoreErrorCode, message: string): StudioExecutionStoreError {
  return new StudioExecutionStoreError(code, message)
}

function invalid(): StudioExecutionStoreError {
  return storeError('STUDIO_STATE_INVALID', 'Studio execution state is invalid')
}

function conflict(): StudioExecutionStoreError {
  return storeError('STUDIO_STATE_CONFLICT', 'Studio execution state changed concurrently')
}

function commandConflict(): StudioExecutionStoreError {
  return storeError('STUDIO_COMMAND_CONFLICT', 'Studio command id was already used with a different graph')
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertKeys(value: JsonRecord, keys: readonly string[]): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw invalid()
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw invalid()
}

function assertNonEmpty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw invalid()
}

function assertOptionalString(value: JsonRecord, key: string): void {
  if (hasOwn(value, key) && typeof value[key] !== 'string') throw invalid()
}

function assertIso(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(new Date(value).getTime())) throw invalid()
}

function assertJson(value: unknown): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid()
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item)
    return
  }
  if (isObject(value)) {
    for (const item of Object.values(value)) assertJson(item)
    return
  }
  throw invalid()
}

function assertJsonObject(value: unknown): asserts value is JsonObject {
  if (!isObject(value)) throw invalid()
  assertJson(value)
}

function assertSelection(value: unknown): asserts value is InsightModelSelection {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['provider', 'modelId', 'modelLabel', 'effortLabel', 'modeLabel'])
  if (value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw invalid()
  if (value.modelId !== undefined) assertNonEmpty(value.modelId)
  if (!(value.provider === 'chatgpt' && value.modelLabel === '')) assertNonEmpty(value.modelLabel)
  if (value.effortLabel !== undefined) assertNonEmpty(value.effortLabel)
  if (value.modeLabel !== undefined) assertNonEmpty(value.modeLabel)
}

function assertObserved(value: unknown): asserts value is InsightObservedSelection {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['availability', 'providerLabel', 'modelLabel', 'effortLabel', 'effortId', 'modeLabel'])
  if (value.availability !== 'observed' && value.availability !== 'not-exposed') throw invalid()
  for (const field of ['providerLabel', 'modelLabel', 'effortLabel', 'effortId', 'modeLabel']) if (value[field] !== undefined) assertString(value[field])
}

function assertTemplate(value: unknown): asserts value is InsightTemplate {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['formatVersion', 'id', 'version', 'text', 'hash'])
  if (value.formatVersion !== 1) throw invalid()
  assertNonEmpty(value.id)
  assertNonEmpty(value.version)
  assertString(value.text)
  assertNonEmpty(value.hash)
  if (templateHash(value.text) !== value.hash) throw invalid()
}

function assertResource(value: unknown): asserts value is InsightExternalResource {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['provider', 'id', 'remoteId', 'url'])
  if (value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw invalid()
  assertNonEmpty(value.id)
  if (value.remoteId !== undefined) assertNonEmpty(value.remoteId)
  if (value.url !== undefined) assertNonEmpty(value.url)
}

function assertProvenance(value: unknown): asserts value is InsightProvenance {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['provider', 'source', 'visibleEvidence', 'citations', 'limitations', 'fallback', 'sameProviderReview'])
  if (value.provider !== 'host' && value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw invalid()
  assertNonEmpty(value.source)
  for (const field of ['visibleEvidence', 'citations', 'limitations']) {
    if (!Array.isArray(value[field]) || !value[field].every((item) => typeof item === 'string')) throw invalid()
  }
  if (value.fallback !== undefined && typeof value.fallback !== 'boolean') throw invalid()
  if (value.sameProviderReview !== undefined && typeof value.sameProviderReview !== 'boolean') throw invalid()
}

function validateArtifact(value: unknown): InsightArtifact {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['id', 'stageCommandId', 'kind', 'text', 'provenance', 'createdAt'])
  assertNonEmpty(value.id)
  assertNonEmpty(value.stageCommandId)
  assertNonEmpty(value.kind)
  assertString(value.text)
  assertProvenance(value.provenance)
  assertIso(value.createdAt)
  return cloneInsight(value as unknown as InsightArtifact)
}

function validateNode(value: unknown): StudioNode {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['id', 'label', 'kind', 'prompt', 'parameters', 'metadata', 'position'])
  assertNonEmpty(value.id)
  assertString(value.label)
  if (typeof value.kind !== 'string' || !NODE_KINDS.has(value.kind)) throw invalid()
  assertString(value.prompt)
  assertJsonObject(value.parameters)
  assertJsonObject(value.metadata)
  if (!isObject(value.position) || !Number.isFinite(value.position.x) || !Number.isFinite(value.position.y)) throw invalid()
  return cloneInsight(value as unknown as StudioNode)
}

function validateGraph(value: unknown): StudioGraph {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['formatVersion', 'id', 'sessionId', 'providerId', 'title', 'nodes', 'edges', 'parameters', 'metadata'])
  if (value.formatVersion !== 1) throw invalid()
  assertNonEmpty(value.id)
  assertNonEmpty(value.sessionId)
  if (typeof value.providerId !== 'string' || !PROVIDERS.has(value.providerId as StudioProviderId)) throw invalid()
  assertString(value.title)
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw invalid()
  const ids = new Set<string>()
  for (const node of value.nodes) {
    const validated = validateNode(node)
    if (ids.has(validated.id)) throw invalid()
    ids.add(validated.id)
  }
  const edgeIds = new Set<string>()
  for (const edge of value.edges) {
    if (!isObject(edge)) throw invalid()
    assertKeys(edge, ['id', 'source', 'target'])
    assertNonEmpty(edge.id)
    assertNonEmpty(edge.source)
    assertNonEmpty(edge.target)
    if (edgeIds.has(edge.id) || !ids.has(edge.source) || !ids.has(edge.target)) throw invalid()
    edgeIds.add(edge.id)
  }
  assertJsonObject(value.parameters)
  assertJsonObject(value.metadata)
  return cloneInsight(value as unknown as StudioGraph)
}

function validatePhase(value: unknown): StudioPhaseExecution {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['nodeId', 'phase', 'round', 'commandId', 'status', 'resource', 'sourceResource', 'requested', 'observed', 'template', 'renderedInput', 'assetIds', 'questions', 'answers', 'reason', 'failureCode', 'quotaEvidence', 'resetInformation', 'intentAt', 'completedAt'])
  assertNonEmpty(value.nodeId)
  if (typeof value.phase !== 'string' || !PHASES.has(value.phase as StudioExecutionPhase)) throw invalid()
  if (value.round !== undefined && (!Number.isSafeInteger(value.round) || (value.round as number) < 1)) throw invalid()
  assertNonEmpty(value.commandId)
  if (typeof value.status !== 'string' || !PHASE_STATUSES.has(value.status as StudioExecutionPhaseStatus)) throw invalid()
  if (value.resource !== undefined) assertResource(value.resource)
  if (value.sourceResource !== undefined) assertResource(value.sourceResource)
  if (value.requested !== undefined) assertSelection(value.requested)
  if (value.observed !== undefined) assertObserved(value.observed)
  if (value.template !== undefined) assertTemplate(value.template)
  assertString(value.renderedInput)
  if (!Array.isArray(value.assetIds) || !value.assetIds.every((item) => typeof item === 'string' && item.length > 0)) throw invalid()
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions)) throw invalid()
    const ids = new Set<string>()
    for (const question of value.questions) {
      if (!isObject(question)) throw invalid()
      assertKeys(question, ['id', 'text'])
      assertNonEmpty(question.id)
      assertNonEmpty(question.text)
      if (ids.has(question.id)) throw invalid()
      ids.add(question.id)
    }
  }
  if (value.answers !== undefined) {
    if (!Array.isArray(value.answers)) throw invalid()
    const ids = new Set<string>()
    for (const answer of value.answers) {
      if (!isObject(answer)) throw invalid()
      assertKeys(answer, ['questionId', 'text'])
      assertNonEmpty(answer.questionId)
      assertString(answer.text)
      if (ids.has(answer.questionId)) throw invalid()
      ids.add(answer.questionId)
    }
  }
  for (const field of ['reason', 'failureCode', 'quotaEvidence', 'resetInformation']) if (value[field] !== undefined) assertString(value[field])
  for (const field of ['intentAt', 'completedAt']) if (value[field] !== undefined) assertIso(value[field])
  return cloneInsight(value as unknown as StudioPhaseExecution)
}

function validateNodeExecution(value: unknown, nodeId: string): StudioNodeExecution {
  if (!isObject(value)) throw invalid()
  assertKeys(value, ['nodeId', 'status', 'phases', 'outputAssetId', 'error'])
  if (value.nodeId !== nodeId) throw invalid()
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status as StudioRunStatus)) throw invalid()
  if (!Array.isArray(value.phases)) throw invalid()
  const ids = new Set<string>()
  for (const phase of value.phases) {
    const validated = validatePhase(phase)
    if (validated.nodeId !== nodeId || ids.has(validated.commandId)) throw invalid()
    ids.add(validated.commandId)
  }
  if (value.outputAssetId !== undefined) assertNonEmpty(value.outputAssetId)
  if (value.error !== undefined) assertString(value.error)
  return cloneInsight(value as unknown as StudioNodeExecution)
}

function validateRecord(value: unknown, expectedCommandId?: string, expectedRevision?: number): StudioExecutionRecord {
  if (!isObject(value)) throw invalid()
  if (!hasOwn(value, 'formatVersion') || !Number.isInteger(value.formatVersion)) throw invalid()
  if (value.formatVersion !== STUDIO_EXECUTION_FORMAT_VERSION) throw storeError('STUDIO_STATE_VERSION', 'Studio execution format version is unsupported')
  assertKeys(value, ['formatVersion', 'commandId', 'revision', 'graph', 'status', 'nodes', 'artifacts', 'output', 'message', 'createdAt', 'updatedAt'])
  assertNonEmpty(value.commandId)
  if (expectedCommandId !== undefined && value.commandId !== expectedCommandId) throw invalid()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || (expectedRevision !== undefined && value.revision !== expectedRevision)) throw invalid()
  const graph = validateGraph(value.graph)
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status as StudioRunStatus)) throw invalid()
  if (!Array.isArray(value.nodes) || value.nodes.length !== graph.nodes.length) throw invalid()
  const nodes: StudioNodeExecution[] = []
  for (let index = 0; index < graph.nodes.length; index += 1) {
    const node = graph.nodes[index]
    if (!node) throw invalid()
    nodes.push(validateNodeExecution(value.nodes[index], node.id))
  }
  if (!Array.isArray(value.artifacts)) throw invalid()
  const artifacts = value.artifacts.map(validateArtifact)
  const artifactIds = new Set<string>()
  for (const artifact of artifacts) {
    if (artifactIds.has(artifact.id)) throw invalid()
    artifactIds.add(artifact.id)
  }
  for (const node of nodes) {
    if (node.outputAssetId !== undefined && !artifactIds.has(node.outputAssetId)) throw invalid()
    for (const phase of node.phases) for (const assetId of phase.assetIds) if (!artifactIds.has(assetId)) throw invalid()
  }
  if (value.output !== undefined) assertString(value.output)
  if (value.message !== undefined) assertString(value.message)
  assertIso(value.createdAt)
  assertIso(value.updatedAt)
  return {
    formatVersion: 1,
    commandId: value.commandId,
    revision: value.revision as number,
    graph,
    status: value.status as StudioRunStatus,
    nodes,
    artifacts,
    ...(value.output === undefined ? {} : { output: value.output as string }),
    ...(value.message === undefined ? {} : { message: value.message as string }),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return stableInsightJson(left) === stableInsightJson(right)
}

function assertResourceProgression(previous: InsightExternalResource | undefined, next: InsightExternalResource | undefined): void {
  if (!previous) return
  if (!next || previous.provider !== next.provider || previous.id !== next.id) throw invalid()
  if (previous.remoteId !== undefined && previous.remoteId !== next.remoteId) throw invalid()
  if (previous.url !== undefined && previous.url !== next.url) throw invalid()
}

function assertOptionalImmutable(previous: unknown, next: unknown): void {
  if (previous !== undefined && !sameJson(previous, next)) throw invalid()
}

function assertPrefix<T>(previous: readonly T[], next: readonly T[]): void {
  if (next.length < previous.length) throw invalid()
  for (let index = 0; index < previous.length; index += 1) if (!sameJson(previous[index], next[index])) throw invalid()
}

function assertImmutableTransition(previous: StudioExecutionRecord, next: StudioExecutionRecord): void {
  if (previous.commandId !== next.commandId || previous.createdAt !== next.createdAt || !sameJson(previous.graph, next.graph)) throw invalid()
  if (previous.nodes.length !== next.nodes.length) throw invalid()
  for (let index = 0; index < previous.nodes.length; index += 1) {
    const before = previous.nodes[index]
    const after = next.nodes[index]
    if (!before || !after || before.nodeId !== after.nodeId) throw invalid()
    if (after.phases.length < before.phases.length) throw invalid()
    for (let phaseIndex = 0; phaseIndex < before.phases.length; phaseIndex += 1) {
      const oldPhase = before.phases[phaseIndex]
      const newPhase = after.phases[phaseIndex]
      if (!oldPhase || !newPhase) throw invalid()
      for (const field of ['nodeId', 'phase', 'round', 'commandId', 'requested', 'template', 'renderedInput', 'sourceResource'] as const) {
        if (!sameJson(oldPhase[field], newPhase[field])) throw invalid()
      }
      assertResourceProgression(oldPhase.resource, newPhase.resource)
      assertOptionalImmutable(oldPhase.observed, newPhase.observed)
      assertOptionalImmutable(oldPhase.questions, newPhase.questions)
      assertOptionalImmutable(oldPhase.answers, newPhase.answers)
      assertOptionalImmutable(oldPhase.reason, newPhase.reason)
      assertOptionalImmutable(oldPhase.failureCode, newPhase.failureCode)
      assertOptionalImmutable(oldPhase.quotaEvidence, newPhase.quotaEvidence)
      assertOptionalImmutable(oldPhase.resetInformation, newPhase.resetInformation)
      assertOptionalImmutable(oldPhase.intentAt, newPhase.intentAt)
      assertOptionalImmutable(oldPhase.completedAt, newPhase.completedAt)
      assertPrefix(oldPhase.assetIds, newPhase.assetIds)
    }
    // A node may expose its plan, then its research report, as later phases
    // complete. Older immutable revisions retain every earlier output pointer.
  }
  assertPrefix(previous.artifacts, next.artifacts)
  assertOptionalImmutable(previous.output, next.output)
  assertOptionalImmutable(previous.message, next.message)
}

function pathKey(commandId: string): string {
  return createHash('sha256').update(commandId, 'utf8').digest('hex')
}

function initialNodes(graph: StudioGraph): readonly StudioNodeExecution[] {
  return graph.nodes.map((node) => ({ nodeId: node.id, status: 'pending', phases: [] }))
}

function observedJson(observed: InsightObservedSelection | undefined, artifact: InsightArtifact | undefined): JsonObject | undefined {
  if (!observed && !artifact) return undefined
  const value: JsonObject = {}
  if (observed) {
    value.observed = cloneInsight(observed) as unknown as JsonValue
  }
  if (artifact) {
    value.provenance = cloneInsight(artifact.provenance) as unknown as JsonValue
  }
  return value
}

export function studioRunFromRecord(record: StudioExecutionRecord): StudioRun {
  const artifacts = new Map(record.artifacts.map((artifact) => [artifact.id, artifact]))
  return {
    id: record.commandId,
    sessionId: record.graph.sessionId,
    providerId: record.graph.providerId,
    status: record.status,
    nodes: record.nodes.map((node) => {
      const artifact = node.outputAssetId === undefined ? undefined : artifacts.get(node.outputAssetId)
      const observed = node.phases.findLast((phase) => phase.observed !== undefined)?.observed
      return {
        nodeId: node.nodeId,
        status: node.status,
        ...(artifact === undefined ? {} : { output: artifact.text }),
        ...(node.error === undefined ? {} : { error: node.error }),
        ...(observedJson(observed, artifact) === undefined ? {} : { observed: observedJson(observed, artifact) }),
      }
    }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.message === undefined ? {} : { message: record.message }),
  }
}

async function removeTemporary(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if (!isErrno(error, 'ENOENT')) return }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

/** Append-only, private execution snapshots. Graph edits never mutate a captured run. */
export class StudioExecutionStore {
  readonly root: string

  constructor(root: string) {
    if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root) throw invalid()
    this.root = root
  }

  async create(commandId: string, graph: StudioGraph): Promise<{ readonly record: StudioExecutionRecord; readonly created: boolean }> {
    assertNonEmpty(commandId)
    const normalizedGraph = validateGraph(graph)
    await this.ensureRoot()
    await this.ensureDirectory(commandId)
    let history = await this.history(commandId)
    if (history && history.length > 0) {
      const original = history[0]
      const latest = history[history.length - 1]
      if (!original || !latest || !sameJson(original.graph, normalizedGraph)) throw commandConflict()
      return { record: cloneInsight(latest), created: false }
    }
    const timestamp = new Date().toISOString()
    const record: StudioExecutionRecord = {
      formatVersion: 1,
      commandId,
      revision: 0,
      graph: normalizedGraph,
      status: 'pending',
      nodes: initialNodes(normalizedGraph),
      artifacts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    try {
      await this.publish(record)
    } catch (error) {
      if (!(error instanceof StudioExecutionStoreError) || error.code !== 'STUDIO_STATE_CONFLICT') throw error
      history = await this.history(commandId)
      const original = history?.[0]
      const latest = history?.[history.length - 1]
      if (!original || !latest) throw conflict()
      if (!sameJson(original.graph, normalizedGraph)) throw commandConflict()
      return { record: cloneInsight(latest), created: false }
    }
    return { record: cloneInsight(record), created: true }
  }

  async read(sessionId: string, commandId: string): Promise<StudioExecutionRecord | undefined> {
    assertNonEmpty(sessionId)
    assertNonEmpty(commandId)
    const history = await this.history(commandId)
    const record = history?.[history.length - 1]
    if (!record) return undefined
    if (record.graph.sessionId !== sessionId) throw storeError('STUDIO_SESSION_MISMATCH', 'Studio command does not belong to this session')
    return cloneInsight(record)
  }

  async transition(commandId: string, expectedRevision: number, patch: StudioExecutionPatch): Promise<StudioExecutionRecord> {
    assertNonEmpty(commandId)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw conflict()
    if (!isObject(patch)) throw invalid()
    assertKeys(patch, ['status', 'nodes', 'artifacts', 'output', 'message'])
    const history = await this.history(commandId)
    const current = history?.[history.length - 1]
    if (!current) throw invalid()
    if (current.revision !== expectedRevision) throw conflict()
    const next: JsonRecord = {
      ...(cloneInsight(current) as unknown as JsonRecord),
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    }
    for (const key of ['status', 'nodes', 'artifacts', 'output', 'message'] as const) {
      if (hasOwn(patch, key)) next[key] = cloneInsight(patch[key])
    }
    const normalized = validateRecord(next, commandId, expectedRevision + 1)
    assertImmutableTransition(current, normalized)
    await this.publish(normalized)
    return cloneInsight(normalized)
  }

  private directory(commandId: string): string {
    return join(this.root, pathKey(commandId))
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: ROOT_MODE })
      await chmod(this.root, ROOT_MODE)
      if (!(await lstat(this.root)).isDirectory()) throw invalid()
    } catch (error) {
      if (error instanceof StudioExecutionStoreError) throw error
      throw invalid()
    }
  }

  private async ensureDirectory(commandId: string): Promise<void> {
    const directory = this.directory(commandId)
    try { await mkdir(directory, { mode: ROOT_MODE }) } catch (error) { if (!isErrno(error, 'EEXIST')) throw invalid() }
    try {
      if (!(await lstat(directory)).isDirectory()) throw invalid()
      await chmod(directory, ROOT_MODE)
    } catch (error) {
      if (error instanceof StudioExecutionStoreError) throw error
      throw invalid()
    }
  }

  private async history(commandId: string): Promise<StudioExecutionRecord[] | undefined> {
    const directory = this.directory(commandId)
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (isErrno(error, 'ENOENT')) return undefined; throw invalid() }
    const revisions: Array<{ readonly revision: number; readonly name: string }> = []
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp')) continue
      const match = REVISION_FILE_PATTERN.exec(entry.name)
      if (!match || !entry.isFile()) throw invalid()
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision)) throw invalid()
      revisions.push({ revision, name: entry.name })
    }
    if (revisions.length === 0) return undefined
    revisions.sort((left, right) => left.revision - right.revision)
    const result: StudioExecutionRecord[] = []
    let previous: StudioExecutionRecord | undefined
    for (let index = 0; index < revisions.length; index += 1) {
      const entry = revisions[index]
      if (!entry || entry.revision !== index) throw invalid()
      let parsed: unknown
      try { parsed = JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as unknown } catch { throw invalid() }
      const record = validateRecord(parsed, commandId, entry.revision)
      if (previous) assertImmutableTransition(previous, record)
      previous = record
      result.push(record)
    }
    return result
  }

  private async publish(record: StudioExecutionRecord): Promise<void> {
    const directory = this.directory(record.commandId)
    const target = join(directory, `${record.revision}.json`)
    const temporary = join(directory, `.${record.revision}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', RECORD_MODE)
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      try { await link(temporary, target) } catch (error) { if (isErrno(error, 'EEXIST')) throw conflict(); throw invalid() }
      await chmod(target, RECORD_MODE)
    } catch (error) {
      if (error instanceof StudioExecutionStoreError) throw error
      throw invalid()
    } finally {
      if (handle) try { await handle.close() } catch { /* already closed */ }
      await removeTemporary(temporary)
    }
  }
}

/** Kept for callers that need to classify malformed persisted Insight snapshots separately. */
export { INSIGHT_STORE_FORMAT_VERSION }
