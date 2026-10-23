import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'

import type {
  StudioDraft,
  StudioGraph,
  StudioRun,
  StudioRunRecord,
  StudioSource,
} from './studio-contract.js'
import {
  assertStudioCommandId,
  assertStudioDraftId,
  assertStudioRevision,
  assertStudioSessionId,
  assertStudioTimestamp,
  cloneStudio,
  isStudioRunActive,
  isStudioRunTerminal,
  parseStudioGraph,
  parseStudioRun,
  stableStudioJson,
} from './studio-validation.js'

export const STUDIO_STORE_FORMAT_VERSION = 1 as const

export type StudioStoreErrorCode =
  | 'STUDIO_STATE_INVALID'
  | 'STUDIO_STATE_VERSION'
  | 'STUDIO_DRAFT_CONFLICT'
  | 'STUDIO_COMMAND_CONFLICT'
  | 'STUDIO_NOT_FOUND'
  | 'STUDIO_RESOURCE_COORDINATION_REQUIRED'
  | 'STUDIO_DELIVERY_CONFLICT'

export class StudioStoreError extends Error {
  constructor(readonly code: StudioStoreErrorCode, message: string) {
    super(message)
    this.name = 'StudioStoreError'
  }
}

export interface StudioDraftSave {
  readonly sessionId: string
  readonly id: string
  readonly expectedRevision: number
  readonly graph: StudioGraph
  readonly sourceId?: string
}

export interface StudioRunIntentInput {
  readonly sessionId: string
  readonly draftId: string
  readonly expectedRevision: number
  readonly commandId: string
}

export type StudioDeliveryStatus = 'calling' | 'submitted' | 'unknown'

/** Append-only record for the optional original-session callback. */
export interface StudioDeliveryRecord {
  readonly formatVersion: 1
  readonly revision: number
  readonly sessionId: string
  readonly commandId: string
  readonly status: StudioDeliveryStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly message?: string
}

interface SourceSnapshot {
  readonly formatVersion: 1
  readonly revision: number
  readonly source: StudioSource
}

interface RunSnapshot {
  readonly formatVersion: 1
  readonly revision: number
  readonly sourceKey: string
  readonly record: StudioRunRecord
}

const ROOT_MODE = 0o700
const RECORD_MODE = 0o600
const REVISION_FILE = /^(0|[1-9][0-9]*)\.json$/

function storeError(code: StudioStoreErrorCode, message: string): StudioStoreError {
  return new StudioStoreError(code, message)
}

function invalidState(message = '流程图持久化状态损坏或不完整。'): never {
  throw storeError('STUDIO_STATE_INVALID', message)
}

function stateVersion(message = '流程图持久化状态版本不受支持。'): never {
  throw storeError('STUDIO_STATE_VERSION', message)
}

function draftConflict(message = '草稿已被其他保存操作更新，请刷新后再保存。'): never {
  throw storeError('STUDIO_DRAFT_CONFLICT', message)
}

function commandConflict(message = '该执行命令已用于不同的草稿或版本，不能复用。'): never {
  throw storeError('STUDIO_COMMAND_CONFLICT', message)
}

function notFound(message = '当前会话中未找到请求的流程图记录。'): never {
  throw storeError('STUDIO_NOT_FOUND', message)
}

function coordinationRequired(message = '同一流程来源仍有进行中或结果未确认的执行，请先刷新并协调原执行。'): never {
  throw storeError('STUDIO_RESOURCE_COORDINATION_REQUIRED', message)
}

function deliveryConflict(message = '原会话回写记录已变化，不能自动重复提交。'): never {
  throw storeError('STUDIO_DELIVERY_CONFLICT', message)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const keys = new Set(allowed)
  for (const key of Object.keys(value)) if (!keys.has(key)) invalidState()
}

function assertOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  if (!hasOwn(value, key)) return undefined
  if (typeof value[key] !== 'string') invalidState()
  return value[key] as string
}

function safeIdentifier(value: unknown, subject: string): string {
  try {
    return assertStudioCommandId(value)
  } catch {
    return invalidState(`${subject} 不合法。`)
  }
}

function safeSession(value: unknown): string {
  try {
    return assertStudioSessionId(value)
  } catch {
    return invalidState('持久化记录的会话标识不合法。')
  }
}

function safeDraftId(value: unknown): string {
  try {
    return assertStudioDraftId(value)
  } catch {
    return invalidState('持久化记录的草稿 id 不合法。')
  }
}

function safeRevision(value: unknown, subject: string): number {
  try {
    return assertStudioRevision(value, subject)
  } catch {
    return invalidState(`${subject} 不合法。`)
  }
}

function safeTimestamp(value: unknown, subject: string): string {
  try {
    return assertStudioTimestamp(value, subject)
  } catch {
    return invalidState(`${subject} 不合法。`)
  }
}

function safeGraph(value: unknown): StudioGraph {
  if (isPlainRecord(value) && value.formatVersion !== STUDIO_STORE_FORMAT_VERSION) {
    return stateVersion('持久化流程图格式版本不受支持。')
  }
  try {
    return parseStudioGraph(value)
  } catch {
    return invalidState('持久化记录中的流程图不合法。')
  }
}

function safeRun(value: unknown): StudioRun {
  try {
    return parseStudioRun(value)
  } catch {
    return invalidState('持久化记录中的执行回执不合法。')
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableStudioJson(left) === stableStudioJson(right)
}

function sameOptionalJson(left: unknown | undefined, right: unknown | undefined): boolean {
  return left === undefined || right === undefined ? left === right : sameJson(left, right)
}

function sourceKeyFor(draft: StudioDraft): string {
  // graph.id is the source logical-flow identity.  Hash it into a bounded
  // filename-safe resource key so a newly invented draft id cannot bypass an
  // active or unknown execution of that same source flow.
  const identity = `${draft.graph.providerId}\u0000${draft.graph.id}`
  return `flow:${createHash('sha256').update(identity).digest('hex')}`
}

function now(): string {
  return new Date().toISOString()
}

function assertSource(value: unknown, expectedSession?: string): StudioSource {
  if (!isPlainRecord(value)) invalidState()
  assertKeys(value, ['id', 'graph', 'capturedAt', 'runId', 'run'])
  const id = safeIdentifier(value.id, '来源 id')
  const graph = safeGraph(value.graph)
  const capturedAt = safeTimestamp(value.capturedAt, '来源 capturedAt')
  const runId = assertOptionalString(value, 'runId')
  if (runId !== undefined) safeIdentifier(runId, '来源 runId')
  const run = hasOwn(value, 'run') ? safeRun(value.run) : undefined
  if (expectedSession !== undefined && graph.sessionId !== expectedSession) invalidState('来源会话与存储命名空间不一致。')
  if (run !== undefined && (run.sessionId !== graph.sessionId || run.providerId !== graph.providerId)) {
    invalidState('来源执行投影与原始流程图不一致。')
  }
  if (runId !== undefined && run !== undefined && run.id !== runId) {
    invalidState('来源执行投影与原始执行 id 不一致。')
  }
  return { id, graph, capturedAt, ...(runId === undefined ? {} : { runId }), ...(run === undefined ? {} : { run }) }
}

function assertSourceSnapshot(value: unknown, expectedSession?: string, expectedRevision?: number): SourceSnapshot {
  if (!isPlainRecord(value)) invalidState()
  assertKeys(value, ['formatVersion', 'revision', 'source'])
  if (value.formatVersion !== STUDIO_STORE_FORMAT_VERSION) stateVersion()
  const revision = safeRevision(value.revision, '来源 revision')
  if (expectedRevision !== undefined && revision !== expectedRevision) invalidState('来源快照 revision 与文件名不一致。')
  return { formatVersion: 1, revision, source: assertSource(value.source, expectedSession) }
}

function assertImmutableSource(previous: SourceSnapshot, next: SourceSnapshot): void {
  const frozen = (source: StudioSource) => ({
    id: source.id,
    graph: source.graph,
    capturedAt: source.capturedAt,
    ...(source.runId === undefined ? {} : { runId: source.runId }),
  })
  if (next.revision !== previous.revision + 1 || !sameJson(frozen(previous.source), frozen(next.source))) {
    invalidState('来源快照尝试修改原始流程图或来源身份。')
  }
}

function assertDraft(value: unknown, expectedSession?: string, expectedRevision?: number): StudioDraft {
  if (!isPlainRecord(value)) invalidState()
  assertKeys(value, ['formatVersion', 'id', 'revision', 'graph', 'createdAt', 'updatedAt', 'sourceId'])
  if (value.formatVersion !== STUDIO_STORE_FORMAT_VERSION) stateVersion()
  const id = safeDraftId(value.id)
  const revision = safeRevision(value.revision, '草稿 revision')
  if (expectedRevision !== undefined && revision !== expectedRevision) invalidState('草稿快照 revision 与文件名不一致。')
  const graph = safeGraph(value.graph)
  if (expectedSession !== undefined && graph.sessionId !== expectedSession) invalidState('草稿会话与存储命名空间不一致。')
  const sourceId = assertOptionalString(value, 'sourceId')
  if (sourceId !== undefined) safeIdentifier(sourceId, '草稿 sourceId')
  return {
    formatVersion: 1,
    id,
    revision,
    graph,
    createdAt: safeTimestamp(value.createdAt, '草稿 createdAt'),
    updatedAt: safeTimestamp(value.updatedAt, '草稿 updatedAt'),
    ...(sourceId === undefined ? {} : { sourceId }),
  }
}

function assertRunRecord(value: unknown, expectedSession?: string): StudioRunRecord {
  if (!isPlainRecord(value)) invalidState()
  assertKeys(value, ['formatVersion', 'commandId', 'draftId', 'draftRevision', 'graph', 'run'])
  if (value.formatVersion !== STUDIO_STORE_FORMAT_VERSION) stateVersion()
  const commandId = safeIdentifier(value.commandId, '执行 commandId')
  const draftId = safeDraftId(value.draftId)
  const draftRevision = safeRevision(value.draftRevision, '执行 draftRevision')
  const graph = safeGraph(value.graph)
  const run = safeRun(value.run)
  if (expectedSession !== undefined && graph.sessionId !== expectedSession) invalidState('执行会话与存储命名空间不一致。')
  if (run.id !== commandId || run.sessionId !== graph.sessionId || run.providerId !== graph.providerId) {
    invalidState('执行回执与冻结流程图不一致。')
  }
  const graphNodes = new Set(graph.nodes.map((node) => node.id))
  for (const node of run.nodes) if (!graphNodes.has(node.nodeId)) invalidState('执行回执引用了流程图中不存在的节点。')
  return { formatVersion: 1, commandId, draftId, draftRevision, graph, run }
}

function assertRunSnapshot(value: unknown, expectedSession?: string, expectedRevision?: number): RunSnapshot {
  if (!isPlainRecord(value)) invalidState()
  assertKeys(value, ['formatVersion', 'revision', 'sourceKey', 'record'])
  if (value.formatVersion !== STUDIO_STORE_FORMAT_VERSION) stateVersion()
  const revision = safeRevision(value.revision, '执行快照 revision')
  if (expectedRevision !== undefined && revision !== expectedRevision) invalidState('执行快照 revision 与文件名不一致。')
  const sourceKey = safeIdentifier(value.sourceKey, '执行来源键')
  return { formatVersion: 1, revision, sourceKey, record: assertRunRecord(value.record, expectedSession) }
}

function assertDelivery(value: unknown, expectedSession?: string, expectedRevision?: number): StudioDeliveryRecord {
  if (!isPlainRecord(value)) invalidState()
  assertKeys(value, ['formatVersion', 'revision', 'sessionId', 'commandId', 'status', 'createdAt', 'updatedAt', 'message'])
  if (value.formatVersion !== STUDIO_STORE_FORMAT_VERSION) stateVersion()
  const revision = safeRevision(value.revision, '回写 revision')
  if (expectedRevision !== undefined && revision !== expectedRevision) invalidState('回写 revision 与文件名不一致。')
  const sessionId = safeSession(value.sessionId)
  if (expectedSession !== undefined && sessionId !== expectedSession) invalidState('回写会话与存储命名空间不一致。')
  if (value.status !== 'calling' && value.status !== 'submitted' && value.status !== 'unknown') invalidState('回写状态不合法。')
  const message = assertOptionalString(value, 'message')
  return {
    formatVersion: 1,
    revision,
    sessionId,
    commandId: safeIdentifier(value.commandId, '回写 commandId'),
    status: value.status,
    createdAt: safeTimestamp(value.createdAt, '回写 createdAt'),
    updatedAt: safeTimestamp(value.updatedAt, '回写 updatedAt'),
    ...(message === undefined ? {} : { message }),
  }
}

function assertImmutableRun(previous: RunSnapshot, next: RunSnapshot): void {
  if (next.revision !== previous.revision + 1
    || next.sourceKey !== previous.sourceKey
    || !sameJson({
      commandId: previous.record.commandId,
      draftId: previous.record.draftId,
      draftRevision: previous.record.draftRevision,
      graph: previous.record.graph,
    }, {
      commandId: next.record.commandId,
      draftId: next.record.draftId,
      draftRevision: next.record.draftRevision,
      graph: next.record.graph,
    })) {
    invalidState('执行快照尝试修改已冻结的命令或流程图。')
  }
}

function assertImmutableDraft(previous: StudioDraft, next: StudioDraft): void {
  if (next.revision !== previous.revision + 1 || next.id !== previous.id || next.sourceId !== previous.sourceId || next.graph.id !== previous.graph.id || next.createdAt !== previous.createdAt) {
    invalidState('草稿快照尝试修改不可变身份或来源。')
  }
}

async function removeTemporary(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if (!isErrno(error, 'ENOENT')) return }
}

/**
 * Version-one append-only workflow storage. All records live below one plugin
 * namespace and are partitioned by their owning session before lookup.
 */
export class StudioStore {
  readonly root: string

  constructor(root: string) {
    if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root) invalidState('流程图存储根目录必须是非根绝对路径。')
    this.root = root
  }

  async capture(input: { readonly id: string; readonly graph: StudioGraph; readonly runId?: string; readonly run?: StudioRun }): Promise<StudioSource> {
    const id = safeIdentifier(input.id, '来源 id')
    const graph = safeGraph(input.graph)
    const runId = input.runId === undefined ? undefined : safeIdentifier(input.runId, '来源 runId')
    const run = input.run === undefined ? undefined : safeRun(input.run)
    if (run !== undefined && (run.sessionId !== graph.sessionId || run.providerId !== graph.providerId)) {
      invalidState('来源执行投影与原始流程图不一致。')
    }
    if (runId !== undefined && run !== undefined && run.id !== runId) {
      invalidState('来源执行投影与原始执行 id 不一致。')
    }
    const sessionId = graph.sessionId
    const existing = await this.readSource(sessionId, id)
    if (existing !== undefined) {
      if (!sameJson(existing.graph, graph)) commandConflict('同一来源 id 已对应不同流程图，不能覆盖原始来源。')
      if (run !== undefined && !sameOptionalJson(existing.run, run)) return this.observeSourceRun(sessionId, id, run)
      return cloneStudio(existing)
    }
    const source: StudioSource = { id, graph: cloneStudio(graph), capturedAt: now(), ...(runId === undefined ? {} : { runId }), ...(run === undefined ? {} : { run: cloneStudio(run) }) }
    const directory = this.sourceDirectory(sessionId, id)
    await this.ensureDirectory(directory)
    try {
      await this.publish(directory, '0.json', { formatVersion: 1, revision: 0, source } satisfies SourceSnapshot)
    } catch (error) {
      if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
      const concurrent = await this.readSource(sessionId, id)
      if (concurrent === undefined || !sameJson(concurrent.graph, graph)) commandConflict('同一来源 id 已对应不同流程图，不能覆盖原始来源。')
      if (run !== undefined && !sameOptionalJson(concurrent.run, run)) return this.observeSourceRun(sessionId, id, run)
      return cloneStudio(concurrent)
    }
    return cloneStudio(source)
  }

  async readSource(sessionIdValue: string, idValue: string): Promise<StudioSource | undefined> {
    const sessionId = safeSession(sessionIdValue)
    const id = safeIdentifier(idValue, '来源 id')
    const latest = (await this.readSourceHistory(sessionId, id)).at(-1)
    if (latest === undefined) return undefined
    if (latest.source.id !== id) invalidState('来源文件与其路径不一致。')
    return cloneStudio(latest.source)
  }

  async listSources(sessionIdValue: string): Promise<readonly StudioSource[]> {
    const sessionId = safeSession(sessionIdValue)
    const base = this.sourcesSessionDirectory(sessionId)
    const entries = await this.readDirectories(base)
    const records: StudioSource[] = []
    for (const entry of entries) {
      const source = await this.readSource(sessionId, entry)
      if (source === undefined) invalidState('来源目录缺少 source.json。')
      records.push(source)
    }
    records.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id))
    return cloneStudio(records)
  }

  /** Update only the observed source-run projection; the captured graph stays immutable. */
  async observeSourceRun(sessionIdValue: string, idValue: string, runValue: StudioRun): Promise<StudioSource> {
    const sessionId = safeSession(sessionIdValue)
    const id = safeIdentifier(idValue, '来源 id')
    const observed = safeRun(runValue)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const history = await this.readSourceHistory(sessionId, id)
      const current = history.at(-1)
      if (current === undefined) notFound('要刷新来源不属于当前会话或不存在。')
      if (observed.sessionId !== sessionId || observed.providerId !== current.source.graph.providerId) {
        invalidState('来源 Provider 回执与原始流程图不一致。')
      }
      if (current.source.runId !== undefined && observed.id !== current.source.runId) {
        invalidState('来源 Provider 回执与原始执行 id 不一致。')
      }
      if (current.source.run !== undefined && isStudioRunTerminal(current.source.run.status)) return cloneStudio(current.source)
      if (sameOptionalJson(current.source.run, observed)) return cloneStudio(current.source)
      const next: SourceSnapshot = {
        formatVersion: 1,
        revision: current.revision + 1,
        source: { ...current.source, run: cloneStudio(observed) },
      }
      assertImmutableSource(current, next)
      try {
        await this.publish(this.sourceDirectory(sessionId, id), `${next.revision}.json`, next)
        return cloneStudio(next.source)
      } catch (error) {
        if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
      }
    }
    draftConflict('来源执行状态被并发观察更新，请刷新后再查看。')
  }

  async saveDraft(input: StudioDraftSave): Promise<StudioDraft> {
    const sessionId = safeSession(input.sessionId)
    const id = safeDraftId(input.id)
    const expectedRevision = safeRevision(input.expectedRevision, '草稿 expectedRevision')
    const graph = safeGraph(input.graph)
    if (graph.sessionId !== sessionId) invalidState('草稿流程图不属于当前会话。')
    const sourceId = input.sourceId === undefined ? undefined : safeIdentifier(input.sourceId, '草稿 sourceId')
    if (sourceId !== undefined) {
      const source = await this.readSource(sessionId, sourceId)
      if (source === undefined) notFound('草稿指定的来源不属于当前会话或不存在。')
      if (source.graph.providerId !== graph.providerId || source.graph.id !== graph.id) {
        invalidState('草稿必须保留来源流程的 Provider 和逻辑流程 id。')
      }
    }
    const directory = this.draftDirectory(sessionId, id)
    const history = await this.readDraftHistory(sessionId, id)
    const current = history.at(-1)
    if (current === undefined) {
      if (expectedRevision !== 0) draftConflict('草稿尚未创建，首次保存必须使用 expectedRevision 0。')
      const timestamp = now()
      const draft: StudioDraft = { formatVersion: 1, id, revision: 0, graph: cloneStudio(graph), createdAt: timestamp, updatedAt: timestamp, ...(sourceId === undefined ? {} : { sourceId }) }
      await this.ensureDirectory(directory)
      try {
        await this.publish(directory, '0.json', draft)
      } catch (error) {
        if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
        const concurrent = (await this.readDraftHistory(sessionId, id)).at(-1)
        if (concurrent === undefined || !sameJson(concurrent, draft)) draftConflict()
        return cloneStudio(concurrent)
      }
      return cloneStudio(draft)
    }
    if (current.revision !== expectedRevision) draftConflict()
    if (sourceId !== current.sourceId) draftConflict('草稿来源不可在后续保存中更换。')
    if (graph.id !== current.graph.id || graph.providerId !== current.graph.providerId) {
      draftConflict('草稿不能改变其逻辑流程 id 或 Provider。')
    }
    const next: StudioDraft = {
      formatVersion: 1,
      id,
      revision: current.revision + 1,
      graph: cloneStudio(graph),
      createdAt: current.createdAt,
      updatedAt: now(),
      ...(current.sourceId === undefined ? {} : { sourceId: current.sourceId }),
    }
    assertImmutableDraft(current, next)
    await this.publish(directory, `${next.revision}.json`, next)
    return cloneStudio(next)
  }

  async readDraft(sessionIdValue: string, idValue: string): Promise<StudioDraft | undefined> {
    const sessionId = safeSession(sessionIdValue)
    const id = safeDraftId(idValue)
    const latest = (await this.readDraftHistory(sessionId, id)).at(-1)
    return latest === undefined ? undefined : cloneStudio(latest)
  }

  async listDrafts(sessionIdValue: string): Promise<readonly StudioDraft[]> {
    const sessionId = safeSession(sessionIdValue)
    const entries = await this.readDirectories(this.draftsSessionDirectory(sessionId))
    const drafts: StudioDraft[] = []
    for (const id of entries) {
      const latest = (await this.readDraftHistory(sessionId, id)).at(-1)
      if (latest === undefined) invalidState('草稿目录没有版本快照。')
      drafts.push(latest)
    }
    drafts.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
    return cloneStudio(drafts)
  }

  /** Persist the exact draft snapshot before any Provider execute call. */
  async createRunIntent(input: StudioRunIntentInput): Promise<{ readonly record: StudioRunRecord; readonly created: boolean }> {
    const sessionId = safeSession(input.sessionId)
    const draftId = safeDraftId(input.draftId)
    const expectedRevision = safeRevision(input.expectedRevision, '执行 expectedRevision')
    const commandId = safeIdentifier(input.commandId, '执行 commandId')
    const existing = await this.readRun(sessionId, commandId)
    if (existing !== undefined) {
      this.assertSameCommand(existing, draftId, expectedRevision)
      return { record: cloneStudio(existing), created: false }
    }
    const draft = await this.readDraft(sessionId, draftId)
    if (draft === undefined) notFound('要运行的草稿不属于当前会话或不存在。')
    if (draft.revision !== expectedRevision) draftConflict('草稿版本已变化，请先刷新后再运行。')
    const sourceKey = sourceKeyFor(draft)
    return this.withResourceLock(sessionId, sourceKey, async () => {
      const raced = await this.readRun(sessionId, commandId)
      if (raced !== undefined) {
        this.assertSameCommand(raced, draftId, expectedRevision)
        return { record: cloneStudio(raced), created: false }
      }
      const latestDraft = await this.readDraft(sessionId, draftId)
      if (latestDraft === undefined || latestDraft.revision !== expectedRevision) draftConflict('草稿版本已变化，请先刷新后再运行。')
      const unresolved = (await this.listRunSnapshots(sessionId)).find((snapshot) => snapshot.sourceKey === sourceKey && isStudioRunActive(snapshot.record.run.status))
      if (unresolved !== undefined) coordinationRequired()
      const unresolvedSource = (await this.listSources(sessionId)).find((source) => source.graph.providerId === latestDraft.graph.providerId
        && source.graph.id === latestDraft.graph.id
        && source.run !== undefined
        && isStudioRunActive(source.run.status))
      if (unresolvedSource !== undefined) {
        coordinationRequired('该流程来源的原始执行仍在进行或结果未确认，请先刷新并协调原执行。')
      }
      const timestamp = now()
      const record: StudioRunRecord = {
        formatVersion: 1,
        commandId,
        draftId,
        draftRevision: expectedRevision,
        graph: cloneStudio(latestDraft.graph),
        run: {
          id: commandId,
          sessionId,
          providerId: latestDraft.graph.providerId,
          status: 'pending',
          nodes: [],
          createdAt: timestamp,
          updatedAt: timestamp,
          message: '已持久化执行意图，等待 Provider 接收。',
        },
      }
      const snapshot: RunSnapshot = { formatVersion: 1, revision: 0, sourceKey, record }
      const directory = this.runDirectory(sessionId, commandId)
      await this.ensureDirectory(directory)
      try {
        await this.publish(directory, '0.json', snapshot)
      } catch (error) {
        if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
        const concurrent = await this.readRun(sessionId, commandId)
        if (concurrent === undefined) throw error
        this.assertSameCommand(concurrent, draftId, expectedRevision)
        return { record: concurrent, created: false }
      }
      return { record: cloneStudio(record), created: true }
    })
  }

  async readRun(sessionIdValue: string, commandIdValue: string): Promise<StudioRunRecord | undefined> {
    const sessionId = safeSession(sessionIdValue)
    const commandId = safeIdentifier(commandIdValue, '执行 commandId')
    const latest = (await this.readRunHistory(sessionId, commandId)).at(-1)
    return latest === undefined ? undefined : cloneStudio(latest.record)
  }

  async listRuns(sessionIdValue: string): Promise<readonly StudioRunRecord[]> {
    const sessionId = safeSession(sessionIdValue)
    const snapshots = await this.listRunSnapshots(sessionId)
    const records = snapshots.map((snapshot) => snapshot.record)
    records.sort((left, right) => left.run.createdAt.localeCompare(right.run.createdAt) || left.commandId.localeCompare(right.commandId))
    return cloneStudio(records)
  }

  /** Append an observed Provider state while retaining every frozen input field. */
  async observeRun(sessionIdValue: string, commandIdValue: string, runValue: StudioRun): Promise<StudioRunRecord> {
    const sessionId = safeSession(sessionIdValue)
    const commandId = safeIdentifier(commandIdValue, '执行 commandId')
    const observed = safeRun(runValue)
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const history = await this.readRunHistory(sessionId, commandId)
      const current = history.at(-1)
      if (current === undefined) notFound('要更新的执行不属于当前会话或不存在。')
      if (observed.id !== commandId || observed.sessionId !== sessionId || observed.providerId !== current.record.graph.providerId) {
        invalidState('Provider 回执与原执行命令不一致。')
      }
      const graphNodes = new Set(current.record.graph.nodes.map((node) => node.id))
      for (const node of observed.nodes) if (!graphNodes.has(node.nodeId)) invalidState('Provider 回执包含不属于冻结流程图的节点。')
      if (isStudioRunTerminal(current.record.run.status)) return cloneStudio(current.record)
      if (sameJson(current.record.run, observed)) return cloneStudio(current.record)
      const next: RunSnapshot = {
        formatVersion: 1,
        revision: current.revision + 1,
        sourceKey: current.sourceKey,
        record: { ...current.record, run: cloneStudio(observed) },
      }
      assertImmutableRun(current, next)
      try {
        await this.publish(this.runDirectory(sessionId, commandId), `${next.revision}.json`, next)
        return cloneStudio(next.record)
      } catch (error) {
        if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
      }
    }
    draftConflict('执行状态被并发观察更新，请刷新后再查看。')
  }

  /** A failed execute/inspect has uncertain external effect; preserve the original command id. */
  async markRunUnknown(sessionIdValue: string, commandIdValue: string, message: string): Promise<StudioRunRecord> {
    const sessionId = safeSession(sessionIdValue)
    const commandId = safeIdentifier(commandIdValue, '执行 commandId')
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const history = await this.readRunHistory(sessionId, commandId)
      const current = history.at(-1)
      if (current === undefined) notFound('要标记的执行不属于当前会话或不存在。')
      if (isStudioRunTerminal(current.record.run.status)) return cloneStudio(current.record)
      if (current.record.run.status === 'unknown' && current.record.run.message === message) return cloneStudio(current.record)
      const nextRun: StudioRun = { ...current.record.run, status: 'unknown', updatedAt: now(), message }
      const next: RunSnapshot = { formatVersion: 1, revision: current.revision + 1, sourceKey: current.sourceKey, record: { ...current.record, run: nextRun } }
      assertImmutableRun(current, next)
      try {
        await this.publish(this.runDirectory(sessionId, commandId), `${next.revision}.json`, next)
        return cloneStudio(next.record)
      } catch (error) {
        if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
      }
    }
    draftConflict('执行状态被并发观察更新，请刷新后再查看。')
  }

  async beginDelivery(sessionIdValue: string, commandIdValue: string): Promise<{ readonly record: StudioDeliveryRecord; readonly created: boolean }> {
    const sessionId = safeSession(sessionIdValue)
    const commandId = safeIdentifier(commandIdValue, '回写 commandId')
    const existing = await this.readDelivery(sessionId, commandId)
    if (existing !== undefined) return { record: existing, created: false }
    const timestamp = now()
    const record: StudioDeliveryRecord = {
      formatVersion: 1,
      revision: 0,
      sessionId,
      commandId,
      status: 'calling',
      createdAt: timestamp,
      updatedAt: timestamp,
      message: '已记录原会话回写意图，等待回写接口确认。',
    }
    const directory = this.deliveryDirectory(sessionId, commandId)
    await this.ensureDirectory(directory)
    try {
      await this.publish(directory, '0.json', record)
    } catch (error) {
      if (!(error instanceof StudioStoreError) || error.code !== 'STUDIO_DRAFT_CONFLICT') throw error
      const concurrent = await this.readDelivery(sessionId, commandId)
      if (concurrent === undefined) throw error
      return { record: concurrent, created: false }
    }
    return { record: cloneStudio(record), created: true }
  }

  async finishDelivery(sessionIdValue: string, commandIdValue: string, expectedRevision: number, status: Exclude<StudioDeliveryStatus, 'calling'>, message: string): Promise<StudioDeliveryRecord> {
    const sessionId = safeSession(sessionIdValue)
    const commandId = safeIdentifier(commandIdValue, '回写 commandId')
    const revision = safeRevision(expectedRevision, '回写 expectedRevision')
    const history = await this.readDeliveryHistory(sessionId, commandId)
    const current = history.at(-1)
    if (current === undefined) notFound('原会话回写记录不存在。')
    if (current.revision !== revision || current.status !== 'calling') deliveryConflict()
    const next: StudioDeliveryRecord = { ...current, revision: current.revision + 1, status, updatedAt: now(), message }
    await this.publish(this.deliveryDirectory(sessionId, commandId), `${next.revision}.json`, next)
    return cloneStudio(next)
  }

  async readDelivery(sessionIdValue: string, commandIdValue: string): Promise<StudioDeliveryRecord | undefined> {
    const sessionId = safeSession(sessionIdValue)
    const commandId = safeIdentifier(commandIdValue, '回写 commandId')
    const latest = (await this.readDeliveryHistory(sessionId, commandId)).at(-1)
    return latest === undefined ? undefined : cloneStudio(latest)
  }

  private assertSameCommand(record: StudioRunRecord, draftId: string, revision: number): void {
    if (record.draftId !== draftId || record.draftRevision !== revision) commandConflict()
  }

  private sourcesSessionDirectory(sessionId: string): string { return join(this.root, 'sources', sessionId) }
  private sourceDirectory(sessionId: string, id: string): string { return join(this.sourcesSessionDirectory(sessionId), id) }
  private draftsSessionDirectory(sessionId: string): string { return join(this.root, 'drafts', sessionId) }
  private draftDirectory(sessionId: string, id: string): string { return join(this.draftsSessionDirectory(sessionId), id) }
  private runsSessionDirectory(sessionId: string): string { return join(this.root, 'runs', sessionId) }
  private runDirectory(sessionId: string, commandId: string): string { return join(this.runsSessionDirectory(sessionId), commandId) }
  private deliverySessionDirectory(sessionId: string): string { return join(this.root, 'delivery', sessionId) }
  private deliveryDirectory(sessionId: string, commandId: string): string { return join(this.deliverySessionDirectory(sessionId), commandId) }
  private locksSessionDirectory(sessionId: string): string { return join(this.root, 'locks', sessionId) }

  private async ensureDirectory(directory: string): Promise<void> {
    try {
      await mkdir(directory, { recursive: true, mode: ROOT_MODE })
      const info = await lstat(directory)
      if (!info.isDirectory()) invalidState('流程图存储路径不是目录。')
      await chmod(directory, ROOT_MODE)
    } catch (error) {
      if (error instanceof StudioStoreError) throw error
      invalidState('无法创建或读取流程图存储目录。')
    }
  }

  private async readJsonOptional(file: string): Promise<unknown | undefined> {
    let text: string
    try {
      const info = await lstat(file)
      if (!info.isFile()) invalidState('流程图存储文件不是普通文件。')
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      if (error instanceof StudioStoreError) throw error
      invalidState()
    }
    try { return JSON.parse(text) as unknown } catch { invalidState('流程图存储文件不是有效 JSON。') }
  }

  private async readDirectories(directory: string): Promise<readonly string[]> {
    let entries: readonly { readonly name: string; isDirectory(): boolean; isFile(): boolean }[]
    try { entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' }) } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      invalidState()
    }
    const result: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!entry.isDirectory()) invalidState('流程图命名空间中存在非目录条目。')
      result.push(safeIdentifier(entry.name, '存储目录名'))
    }
    return result.sort()
  }

  private async readDraftHistory(sessionId: string, id: string): Promise<StudioDraft[]> {
    const directory = this.draftDirectory(sessionId, id)
    return this.readHistory(directory, (value, revision) => assertDraft(value, sessionId, revision))
  }

  private async readSourceHistory(sessionId: string, id: string): Promise<SourceSnapshot[]> {
    const directory = this.sourceDirectory(sessionId, id)
    const history = await this.readHistory(directory, (value, revision) => assertSourceSnapshot(value, sessionId, revision))
    let previous: SourceSnapshot | undefined
    for (const snapshot of history) {
      if (snapshot.source.id !== id) invalidState('来源快照与其目录不一致。')
      if (previous !== undefined) assertImmutableSource(previous, snapshot)
      previous = snapshot
    }
    return history
  }

  private async readRunHistory(sessionId: string, commandId: string): Promise<RunSnapshot[]> {
    const directory = this.runDirectory(sessionId, commandId)
    const history = await this.readHistory(directory, (value, revision) => assertRunSnapshot(value, sessionId, revision))
    let previous: RunSnapshot | undefined
    for (const snapshot of history) {
      if (snapshot.record.commandId !== commandId) invalidState('执行快照与其目录不一致。')
      if (previous !== undefined) assertImmutableRun(previous, snapshot)
      previous = snapshot
    }
    return history
  }

  private async readDeliveryHistory(sessionId: string, commandId: string): Promise<StudioDeliveryRecord[]> {
    const directory = this.deliveryDirectory(sessionId, commandId)
    const history = await this.readHistory(directory, (value, revision) => assertDelivery(value, sessionId, revision))
    let previous: StudioDeliveryRecord | undefined
    for (const record of history) {
      if (record.commandId !== commandId) invalidState('回写记录与其目录不一致。')
      if (previous !== undefined && (record.revision !== previous.revision + 1 || record.createdAt !== previous.createdAt || record.sessionId !== previous.sessionId || record.commandId !== previous.commandId)) {
        invalidState('回写快照尝试修改不可变字段。')
      }
      previous = record
    }
    return history
  }

  private async readHistory<T>(directory: string, parseRecord: (value: unknown, revision: number) => T): Promise<T[]> {
    let entries: readonly { readonly name: string; isDirectory(): boolean; isFile(): boolean }[]
    try { entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' }) } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      invalidState()
    }
    const files: Array<{ readonly revision: number; readonly name: string }> = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const match = REVISION_FILE.exec(entry.name)
      if (!match || !entry.isFile()) invalidState('版本目录中存在不受支持的文件。')
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision)) invalidState()
      files.push({ revision, name: entry.name })
    }
    files.sort((left, right) => left.revision - right.revision)
    const records: T[] = []
    for (let index = 0; index < files.length; index += 1) {
      const item = files[index]
      if (item === undefined || item.revision !== index) invalidState('版本快照序列不连续。')
      const value = await this.readJsonOptional(join(directory, item.name))
      if (value === undefined) invalidState()
      records.push(parseRecord(value, item.revision))
    }
    return records
  }

  private async listRunSnapshots(sessionId: string): Promise<readonly RunSnapshot[]> {
    const entries = await this.readDirectories(this.runsSessionDirectory(sessionId))
    const snapshots: RunSnapshot[] = []
    for (const commandId of entries) {
      const latest = (await this.readRunHistory(sessionId, commandId)).at(-1)
      if (latest === undefined) invalidState('执行目录没有版本快照。')
      snapshots.push(latest)
    }
    return snapshots
  }

  private async publish(directory: string, targetName: string, record: unknown): Promise<void> {
    await this.ensureDirectory(directory)
    const target = join(directory, targetName)
    const temporary = join(directory, `.${targetName}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', RECORD_MODE)
      await handle.writeFile(stableStudioJson(record), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      try { await link(temporary, target) } catch (error) {
        if (isErrno(error, 'EEXIST')) draftConflict('同一版本快照已存在。')
        invalidState('无法发布流程图版本快照。')
      }
      await chmod(target, RECORD_MODE)
    } catch (error) {
      if (error instanceof StudioStoreError) throw error
      invalidState('无法写入流程图版本快照。')
    } finally {
      if (handle !== undefined) {
        try { await handle.close() } catch { /* close failure is already handled */ }
      }
      await removeTemporary(temporary)
    }
  }

  private async withResourceLock<T>(sessionId: string, sourceKey: string, operation: () => Promise<T>): Promise<T> {
    const parent = this.locksSessionDirectory(sessionId)
    await this.ensureDirectory(parent)
    const directory = join(parent, sourceKey)
    try {
      await mkdir(directory, { mode: ROOT_MODE })
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) invalidState('无法取得流程来源协调锁。')
      const unresolved = (await this.listRunSnapshots(sessionId)).find((snapshot) => snapshot.sourceKey === sourceKey && isStudioRunActive(snapshot.record.run.status))
      if (unresolved !== undefined) coordinationRequired()
      coordinationRequired('流程来源仍被未完成的协调锁占用；请先检查原执行。')
    }
    try {
      return await operation()
    } finally {
      try { await rmdir(directory) } catch (error) { if (!isErrno(error, 'ENOENT')) { /* stale lock is conservative */ } }
    }
  }
}
