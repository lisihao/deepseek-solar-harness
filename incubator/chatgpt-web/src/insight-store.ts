import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'

import {
  INSIGHT_STORE_FORMAT_VERSION,
  InsightContractError,
  assertInsightConfig,
  cloneInsight,
  stableInsightJson,
  templateHash,
  type InsightAnswer,
  type InsightArtifact,
  type InsightExternalResource,
  type InsightModelSelection,
  type InsightObservedSelection,
  type InsightProvenance,
  type InsightQuestion,
  type InsightRun,
  type InsightRunPatch,
  type InsightRunRequest,
  type InsightRunStatus,
  type InsightStageKind,
  type InsightStageName,
  type InsightStageRecord,
  type InsightStageStatus,
  type InsightTemplate,
} from './insight-contract.js'

export type InsightStoreErrorCode =
  | 'INSIGHT_COMMAND_CONFLICT'
  | 'INSIGHT_STATE_VERSION'
  | 'INSIGHT_STATE_INVALID'
  | 'INSIGHT_STATE_CONFLICT'

export class InsightStoreError extends Error {
  constructor(readonly code: InsightStoreErrorCode, message: string) {
    super(message)
    this.name = 'InsightStoreError'
  }
}

const ROOT_MODE = 0o700
const RECORD_MODE = 0o600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVISION_FILE_PATTERN = /^(0|[1-9][0-9]*)\.json$/
const RUN_STATUSES = new Set<InsightRunStatus>(['running', 'needs-input', 'needs-confirmation', 'paused', 'completed', 'failed', 'cancelled'])
const STAGE_NAMES = new Set<InsightStageName>([
  'clarify',
  'questions',
  'plan',
  'plan-confirmation',
  'research',
  'research-fallback',
  'critique',
  'polish',
  'polish-fallback',
  'final',
])
const STAGE_KINDS = new Set<InsightStageKind>(['native', 'host-question', 'host-confirmation', 'external', 'local'])
const STAGE_STATUSES = new Set<InsightStageStatus>([
  'calling',
  'complete',
  'needs-input',
  'needs-confirmation',
  'quota-exhausted',
  'unknown',
  'paused',
  'failed',
  'cancelled',
  'rejected',
  'skipped',
])

type JsonObject = Record<string, unknown>

function storeError(code: InsightStoreErrorCode, message: string): InsightStoreError {
  return new InsightStoreError(code, message)
}

function invalidState(): InsightStoreError {
  return storeError('INSIGHT_STATE_INVALID', 'Insight state is invalid')
}

function stateConflict(): InsightStoreError {
  return storeError('INSIGHT_STATE_CONFLICT', 'Insight state changed concurrently')
}

function commandConflict(): InsightStoreError {
  return storeError('INSIGHT_COMMAND_CONFLICT', 'Insight run id was already used with different input or configuration')
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertKeys(value: JsonObject, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) if (!allowedKeys.has(key)) throw invalidState()
}

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw invalidState()
}

function assertNonEmpty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw invalidState()
}

function assertOptionalString(value: JsonObject, key: string): void {
  if (!hasOwn(value, key)) return
  if (typeof value[key] !== 'string') throw invalidState()
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw invalidState()
  if (!Number.isFinite(new Date(value).getTime())) throw invalidState()
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidState()
}

function assertArray(value: unknown): asserts value is unknown[] {
  if (!Array.isArray(value)) throw invalidState()
}

function assertUniqueStrings(values: readonly unknown[]): asserts values is string[] {
  const seen = new Set<string>()
  for (const value of values) {
    assertNonEmpty(value)
    if (seen.has(value)) throw invalidState()
    seen.add(value)
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function assertSelection(value: unknown): asserts value is InsightModelSelection {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['provider', 'modelId', 'modelLabel', 'effortLabel', 'modeLabel'])
  if (value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw invalidState()
  assertOptionalString(value, 'modelId')
  assertNonEmpty(value.modelLabel)
  assertOptionalString(value, 'effortLabel')
  assertOptionalString(value, 'modeLabel')
}

function assertObserved(value: unknown): asserts value is InsightObservedSelection {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['availability', 'providerLabel', 'modelLabel', 'effortLabel', 'modeLabel'])
  if (value.availability !== 'observed' && value.availability !== 'not-exposed') throw invalidState()
  assertOptionalString(value, 'providerLabel')
  assertOptionalString(value, 'modelLabel')
  assertOptionalString(value, 'effortLabel')
  assertOptionalString(value, 'modeLabel')
}

function assertTemplate(value: unknown): asserts value is InsightTemplate {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['formatVersion', 'id', 'version', 'text', 'hash'])
  if (value.formatVersion !== 1) throw invalidState()
  assertNonEmpty(value.id)
  assertNonEmpty(value.version)
  assertString(value.text)
  assertNonEmpty(value.hash)
  if (value.hash !== templateHash(value.text)) throw invalidState()
}

function assertResource(value: unknown): asserts value is InsightExternalResource {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['provider', 'id', 'remoteId', 'url'])
  if (value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw invalidState()
  assertNonEmpty(value.id)
  assertOptionalString(value, 'remoteId')
  assertOptionalString(value, 'url')
}

function assertProvenance(value: unknown): asserts value is InsightProvenance {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['provider', 'source', 'visibleEvidence', 'citations', 'limitations', 'fallback', 'sameProviderReview'])
  if (value.provider !== 'host' && value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw invalidState()
  assertNonEmpty(value.source)
  for (const field of ['visibleEvidence', 'citations', 'limitations'] as const) {
    assertArray(value[field])
    for (const item of value[field]) assertString(item)
  }
  if (hasOwn(value, 'fallback') && typeof value.fallback !== 'boolean') throw invalidState()
  if (hasOwn(value, 'sameProviderReview') && typeof value.sameProviderReview !== 'boolean') throw invalidState()
}

function assertQuestion(value: unknown): asserts value is InsightQuestion {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['id', 'text'])
  assertNonEmpty(value.id)
  assertNonEmpty(value.text)
}

function assertAnswer(value: unknown): asserts value is InsightAnswer {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['questionId', 'text'])
  assertNonEmpty(value.questionId)
  assertString(value.text)
}

function validateArtifact(value: unknown): InsightArtifact {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['id', 'stageCommandId', 'kind', 'text', 'provenance', 'createdAt'])
  assertNonEmpty(value.id)
  assertNonEmpty(value.stageCommandId)
  assertNonEmpty(value.kind)
  assertString(value.text)
  assertProvenance(value.provenance)
  assertIsoTimestamp(value.createdAt)
  return cloneInsight(value as unknown as InsightArtifact)
}

function validateStage(value: unknown, sequence: number): InsightStageRecord {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, [
    'sequence', 'stage', 'kind', 'commandId', 'status', 'round', 'requested', 'observed', 'resource', 'template',
    'renderedInput', 'assetIds', 'questions', 'answers', 'quotaEvidence', 'resetInformation', 'failureCode', 'reason', 'intentAt', 'completedAt',
  ])
  if (value.sequence !== sequence) throw invalidState()
  if (typeof value.stage !== 'string' || !STAGE_NAMES.has(value.stage as InsightStageName)) throw invalidState()
  if (typeof value.kind !== 'string' || !STAGE_KINDS.has(value.kind as InsightStageKind)) throw invalidState()
  assertNonEmpty(value.commandId)
  if (typeof value.status !== 'string' || !STAGE_STATUSES.has(value.status as InsightStageStatus)) throw invalidState()
  if (hasOwn(value, 'round') && (!Number.isSafeInteger(value.round) || (value.round as number) < 1)) throw invalidState()
  if (hasOwn(value, 'requested')) assertSelection(value.requested)
  if (hasOwn(value, 'observed')) assertObserved(value.observed)
  if (hasOwn(value, 'resource')) assertResource(value.resource)
  if (hasOwn(value, 'template')) assertTemplate(value.template)
  assertString(value.renderedInput)
  assertArray(value.assetIds)
  assertUniqueStrings(value.assetIds)
  if (hasOwn(value, 'questions')) {
    assertArray(value.questions)
    const questionIds = new Set<string>()
    for (const question of value.questions) {
      assertQuestion(question)
      if (questionIds.has(question.id)) throw invalidState()
      questionIds.add(question.id)
    }
  }
  if (hasOwn(value, 'answers')) {
    assertArray(value.answers)
    const answerIds = new Set<string>()
    for (const answer of value.answers) {
      assertAnswer(answer)
      if (answerIds.has(answer.questionId)) throw invalidState()
      answerIds.add(answer.questionId)
    }
  }
  for (const field of ['quotaEvidence', 'resetInformation', 'failureCode', 'reason', 'intentAt', 'completedAt'] as const) {
    if (field === 'intentAt' || field === 'completedAt') {
      if (hasOwn(value, field)) assertIsoTimestamp(value[field])
    } else {
      assertOptionalString(value, field)
    }
  }
  if ((value.kind === 'native' || value.kind === 'external') && (!hasOwn(value, 'requested') || !hasOwn(value, 'resource') || !hasOwn(value, 'template'))) {
    throw invalidState()
  }
  return cloneInsight(value as unknown as InsightStageRecord)
}

function validateRequest(value: unknown, id: string): InsightRunRequest {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['input', 'config'])
  if (!isObject(value.input)) throw invalidState()
  assertKeys(value.input, ['id', 'question', 'conversationContext'])
  assertUuid(value.input.id)
  if (value.input.id !== id) throw invalidState()
  assertString(value.input.question)
  assertString(value.input.conversationContext)
  try {
    assertInsightConfig(value.config)
  } catch (error) {
    if (error instanceof InsightContractError) throw invalidState()
    throw error
  }
  return cloneInsight(value as unknown as InsightRunRequest)
}

function validateRun(value: unknown, expectedId?: string, expectedRevision?: number): InsightRun {
  if (!isObject(value)) throw invalidState()
  if (!hasOwn(value, 'formatVersion') || !Number.isInteger(value.formatVersion)) throw invalidState()
  if (value.formatVersion !== INSIGHT_STORE_FORMAT_VERSION) {
    throw storeError('INSIGHT_STATE_VERSION', 'Insight state format version is unsupported')
  }
  assertKeys(value, [
    'formatVersion', 'id', 'revision', 'createdAt', 'updatedAt', 'request', 'status', 'stages', 'assets', 'finalMarkdown', 'finalProvenance', 'reason',
  ])
  assertUuid(value.id)
  if (expectedId !== undefined && value.id !== expectedId) throw invalidState()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw invalidState()
  if (expectedRevision !== undefined && value.revision !== expectedRevision) throw invalidState()
  assertIsoTimestamp(value.createdAt)
  assertIsoTimestamp(value.updatedAt)
  const request = validateRequest(value.request, value.id)
  if (typeof value.status !== 'string' || !RUN_STATUSES.has(value.status as InsightRunStatus)) throw invalidState()
  assertArray(value.stages)
  const stages: InsightStageRecord[] = []
  const commandIds = new Set<string>()
  for (let index = 0; index < value.stages.length; index += 1) {
    const stage = validateStage(value.stages[index], index + 1)
    if (commandIds.has(stage.commandId)) throw invalidState()
    commandIds.add(stage.commandId)
    stages.push(stage)
  }
  assertArray(value.assets)
  const assets: InsightArtifact[] = []
  const assetIds = new Set<string>()
  for (const assetValue of value.assets) {
    const asset = validateArtifact(assetValue)
    if (assetIds.has(asset.id) || !commandIds.has(asset.stageCommandId)) throw invalidState()
    assetIds.add(asset.id)
    assets.push(asset)
  }
  for (const stage of stages) for (const assetId of stage.assetIds) if (!assetIds.has(assetId)) throw invalidState()
  if (hasOwn(value, 'finalMarkdown')) assertString(value.finalMarkdown)
  if (hasOwn(value, 'finalProvenance')) {
    assertArray(value.finalProvenance)
    for (const item of value.finalProvenance) assertString(item)
  }
  assertOptionalString(value, 'reason')
  if (value.status === 'completed' && (!hasOwn(value, 'finalMarkdown') || !hasOwn(value, 'finalProvenance'))) throw invalidState()
  return {
    formatVersion: 1,
    id: value.id,
    revision: value.revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    request,
    status: value.status as InsightRunStatus,
    stages,
    assets,
    ...(value.finalMarkdown === undefined ? {} : { finalMarkdown: value.finalMarkdown as string }),
    ...(value.finalProvenance === undefined ? {} : { finalProvenance: cloneInsight(value.finalProvenance as string[]) }),
    ...(value.reason === undefined ? {} : { reason: value.reason as string }),
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return left === right
  return stableInsightJson(left) === stableInsightJson(right)
}

function assertResourceProgression(previous: InsightExternalResource | undefined, next: InsightExternalResource | undefined): void {
  if (!previous) return
  if (!next || previous.provider !== next.provider || previous.id !== next.id) throw invalidState()
  if (previous.remoteId !== undefined && previous.remoteId !== next.remoteId) throw invalidState()
  if (previous.url !== undefined && previous.url !== next.url) throw invalidState()
}

function assertOptionalImmutable<T>(previous: T | undefined, next: T | undefined): void {
  if (previous !== undefined && !sameJson(previous, next)) throw invalidState()
}

function assertPrefix(previous: readonly string[], next: readonly string[]): void {
  if (next.length < previous.length) throw invalidState()
  for (let index = 0; index < previous.length; index += 1) if (previous[index] !== next[index]) throw invalidState()
}

function assertImmutableTransition(previous: InsightRun, next: InsightRun): void {
  if (!sameJson(previous.request, next.request) || previous.createdAt !== next.createdAt || previous.id !== next.id) throw invalidState()
  if (next.stages.length < previous.stages.length || next.assets.length < previous.assets.length) throw invalidState()
  for (let index = 0; index < previous.stages.length; index += 1) {
    const before = previous.stages[index]
    const after = next.stages[index]
    if (!before || !after) throw invalidState()
    for (const field of ['sequence', 'stage', 'kind', 'commandId', 'round', 'requested', 'template', 'renderedInput'] as const) {
      if (!sameJson(before[field], after[field])) throw invalidState()
    }
    assertResourceProgression(before.resource, after.resource)
    assertOptionalImmutable(before.observed, after.observed)
    assertOptionalImmutable(before.questions, after.questions)
    assertOptionalImmutable(before.answers, after.answers)
    assertOptionalImmutable(before.quotaEvidence, after.quotaEvidence)
    assertOptionalImmutable(before.resetInformation, after.resetInformation)
    assertOptionalImmutable(before.failureCode, after.failureCode)
    assertOptionalImmutable(before.reason, after.reason)
    assertOptionalImmutable(before.intentAt, after.intentAt)
    assertOptionalImmutable(before.completedAt, after.completedAt)
    assertPrefix(before.assetIds, after.assetIds)
  }
  for (let index = 0; index < previous.assets.length; index += 1) {
    if (!sameJson(previous.assets[index], next.assets[index])) throw invalidState()
  }
  assertOptionalImmutable(previous.finalMarkdown, next.finalMarkdown)
  assertOptionalImmutable(previous.finalProvenance, next.finalProvenance)
  assertOptionalImmutable(previous.reason, next.reason)
}

function normalizeId(id: unknown): string {
  assertUuid(id)
  return id
}

function normalizeRequest(id: string, request: unknown): InsightRunRequest {
  return validateRequest(request, id)
}

function normalizePatch(patch: unknown): InsightRunPatch {
  if (!isObject(patch)) throw invalidState()
  assertKeys(patch, ['status', 'stages', 'assets', 'finalMarkdown', 'finalProvenance', 'reason'])
  return cloneInsight(patch as unknown as InsightRunPatch)
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) return
  }
}

/**
 * Append-only JSON snapshots for Insight only.  `link()` provides create-if-
 * absent publication, so concurrent writers cannot overwrite a revision.
 */
export class InsightStore {
  readonly root: string

  constructor(root: string) {
    if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root) throw invalidState()
    this.root = root
  }

  async create(id: string, request: InsightRunRequest): Promise<InsightRun> {
    const normalizedId = normalizeId(id)
    const normalizedRequest = normalizeRequest(normalizedId, request)
    await this.ensureRoot()
    await this.ensureRunDirectory(normalizedId)
    let history = await this.readHistory(normalizedId)
    if (history && history.length > 0) {
      const original = history[0]
      const latest = history[history.length - 1]
      if (!original || !latest || !sameJson(original.request, normalizedRequest)) throw commandConflict()
      return cloneInsight(latest)
    }
    const now = new Date().toISOString()
    const record: InsightRun = {
      formatVersion: 1,
      id: normalizedId,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      request: normalizedRequest,
      status: 'running',
      stages: [],
      assets: [],
    }
    try {
      await this.publish(normalizedId, record)
    } catch (error) {
      if (!(error instanceof InsightStoreError) || error.code !== 'INSIGHT_STATE_CONFLICT') throw error
      history = await this.readHistory(normalizedId)
      const original = history?.[0]
      const latest = history?.[history.length - 1]
      if (!original || !latest) throw stateConflict()
      if (!sameJson(original.request, normalizedRequest)) throw commandConflict()
      return cloneInsight(latest)
    }
    return cloneInsight(record)
  }

  async read(id: string): Promise<InsightRun | undefined> {
    const normalizedId = normalizeId(id)
    const history = await this.readHistory(normalizedId)
    const latest = history?.[history.length - 1]
    return latest === undefined ? undefined : cloneInsight(latest)
  }

  async list(): Promise<readonly InsightRun[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw invalidState()
    }
    const records: InsightRun[] = []
    for (const entry of entries) {
      if (!UUID_PATTERN.test(entry.name)) continue
      if (!entry.isDirectory()) throw invalidState()
      const history = await this.readHistory(entry.name)
      const latest = history?.[history.length - 1]
      if (latest) records.push(cloneInsight(latest))
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return records
  }

  async transition(id: string, expectedRevision: number, patch: InsightRunPatch): Promise<InsightRun> {
    const normalizedId = normalizeId(id)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw stateConflict()
    const normalizedPatch = normalizePatch(patch)
    const history = await this.readHistory(normalizedId)
    const current = history?.[history.length - 1]
    if (!current) throw invalidState()
    if (current.revision !== expectedRevision) throw stateConflict()
    const next: JsonObject = {
      ...cloneInsight(current) as unknown as JsonObject,
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    }
    for (const key of ['status', 'stages', 'assets', 'finalMarkdown', 'finalProvenance', 'reason'] as const) {
      if (!hasOwn(normalizedPatch as unknown as JsonObject, key)) continue
      next[key] = cloneInsight((normalizedPatch as unknown as JsonObject)[key])
    }
    const normalizedNext = validateRun(next, normalizedId, expectedRevision + 1)
    assertImmutableTransition(current, normalizedNext)
    await this.publish(normalizedId, normalizedNext)
    return cloneInsight(normalizedNext)
  }

  private runDirectory(id: string): string {
    return join(this.root, id)
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: ROOT_MODE })
      await chmod(this.root, ROOT_MODE)
      if (!(await lstat(this.root)).isDirectory()) throw invalidState()
    } catch (error) {
      if (error instanceof InsightStoreError) throw error
      throw invalidState()
    }
  }

  private async ensureRunDirectory(id: string): Promise<void> {
    const directory = this.runDirectory(id)
    try {
      await mkdir(directory, { mode: ROOT_MODE })
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw invalidState()
    }
    try {
      if (!(await lstat(directory)).isDirectory()) throw invalidState()
      await chmod(directory, ROOT_MODE)
    } catch (error) {
      if (error instanceof InsightStoreError) throw error
      throw invalidState()
    }
  }

  private async readHistory(id: string): Promise<InsightRun[] | undefined> {
    const directory = this.runDirectory(id)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw invalidState()
    }
    const revisions: Array<{ revision: number; name: string }> = []
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp')) continue
      const match = REVISION_FILE_PATTERN.exec(entry.name)
      if (!match || !entry.isFile()) throw invalidState()
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision)) throw invalidState()
      revisions.push({ revision, name: entry.name })
    }
    if (revisions.length === 0) return undefined
    revisions.sort((left, right) => left.revision - right.revision)
    const history: InsightRun[] = []
    let previous: InsightRun | undefined
    for (let index = 0; index < revisions.length; index += 1) {
      const item = revisions[index]
      if (!item || item.revision !== index) throw invalidState()
      let text: string
      try {
        text = await readFile(join(directory, item.name), 'utf8')
      } catch {
        throw invalidState()
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        throw invalidState()
      }
      const record = validateRun(parsed, id, item.revision)
      if (previous) assertImmutableTransition(previous, record)
      previous = record
      history.push(record)
    }
    return history
  }

  private async publish(id: string, record: InsightRun): Promise<void> {
    const directory = this.runDirectory(id)
    const target = join(directory, `${record.revision}.json`)
    const temporary = join(directory, `.${record.revision}.${randomUUID()}.tmp`)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', RECORD_MODE)
      await handle.writeFile(JSON.stringify(record), 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      try {
        await link(temporary, target)
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw stateConflict()
        throw invalidState()
      }
      await chmod(target, RECORD_MODE)
    } catch (error) {
      if (error instanceof InsightStoreError) throw error
      throw invalidState()
    } finally {
      if (handle) {
        try { await handle.close() } catch { /* already closed */ }
      }
      await removeTemporary(temporary)
    }
  }
}
