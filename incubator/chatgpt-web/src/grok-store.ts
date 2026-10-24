import { createHash, randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'

import type { GrokRequest, GrokResource, GrokRunRecord, GrokStage } from './grok-contract.js'

export const GROK_RUN_FORMAT_VERSION = 1 as const

export type GrokRunPatch = Partial<Pick<
  GrokRunRecord,
  'stage' | 'resource' | 'observedModelLabel' | 'intentAt' | 'promptReceiptId' | 'replyId' | 'output' | 'error'
>>

export type GrokStoreErrorCode =
  | 'GROK_COMMAND_CONFLICT'
  | 'GROK_STATE_VERSION'
  | 'GROK_STATE_INVALID'
  | 'GROK_STATE_CONFLICT'

export class GrokStoreError extends Error {
  constructor(readonly code: GrokStoreErrorCode, message: string) {
    super(message)
    this.name = 'GrokStoreError'
  }
}

export interface GrokCreateResult {
  readonly record: GrokRunRecord
  /** True only for the process that atomically appended revision zero. */
  readonly created: boolean
}

const ROOT_MODE = 0o700
const RECORD_MODE = 0o600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVISION_FILE_PATTERN = /^(0|[1-9][0-9]*)\.json$/
const STAGES = new Set<GrokStage>([
  'created',
  'preparing',
  'prepared',
  'submission-unknown',
  'submitted',
  'completed',
  'blocked',
  'failed',
  'indeterminate',
  'cancelled',
])

type JsonRecord = Record<string, unknown>

export type GrokResourceUrl =
  | { readonly kind: 'root'; readonly value: string }
  | { readonly kind: 'conversation'; readonly value: string; readonly conversationId: string; readonly replyId?: string }

function storeError(code: GrokStoreErrorCode, message: string): GrokStoreError {
  return new GrokStoreError(code, message)
}

function invalidState(): GrokStoreError {
  return storeError('GROK_STATE_INVALID', 'Grok durable state is invalid')
}

function stateConflict(): GrokStoreError {
  return storeError('GROK_STATE_CONFLICT', 'Grok durable state changed concurrently')
}

function commandConflict(): GrokStoreError {
  return storeError('GROK_COMMAND_CONFLICT', 'Grok request id was already used with a different request')
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertKeys(value: JsonRecord, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw invalidState()
  }
}

function assertString(value: unknown, nonEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0)) throw invalidState()
}

function assertOptionalString(value: JsonRecord, key: string, nonEmpty = false): void {
  if (!hasOwn(value, key)) return
  if (value[key] === undefined || value[key] === null) throw invalidState()
  assertString(value[key], nonEmpty)
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw invalidState()
  }
  if (!Number.isFinite(new Date(value).getTime())) throw invalidState()
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidState()
}

export function parseGrokResourceUrl(value: string): GrokResourceUrl | undefined {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:'
      || parsed.hostname !== 'grok.com'
      || parsed.port !== ''
      || parsed.username !== ''
      || parsed.password !== ''
      || parsed.hash !== ''
      || parsed.toString() !== value) return undefined
    if (parsed.pathname === '/' && parsed.search === '') return { kind: 'root', value }
    const match = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(parsed.pathname)
    if (!match || match[1] === undefined) return undefined
    const entries = Array.from(parsed.searchParams.entries())
    if (entries.length > 1) return undefined
    const entry = entries[0]
    if (entry !== undefined && (entry[0] !== 'rid' || !UUID_PATTERN.test(entry[1]))) return undefined
    if (entry !== undefined && parsed.search !== `?rid=${entry[1]}`) return undefined
    return {
      kind: 'conversation',
      value,
      conversationId: match[1],
      ...(entry === undefined ? {} : { replyId: entry[1] }),
    }
  } catch {
    return undefined
  }
}

export function isGrokResourceUrl(value: string): boolean {
  return parseGrokResourceUrl(value) !== undefined
}

function conversationTransitionAllowed(previous: GrokResource, next: GrokResource, nextRecord: GrokRunRecord): boolean {
  if (previous.provider !== next.provider || previous.spaceId !== next.spaceId || previous.pageLabel !== next.pageLabel) return false
  if (previous.conversationUrl === next.conversationUrl) return true
  const before = parseGrokResourceUrl(previous.conversationUrl)
  const after = parseGrokResourceUrl(next.conversationUrl)
  if (!before || !after) return false
  if (before.kind === 'root' && after.kind === 'conversation') {
    return typeof nextRecord.promptReceiptId === 'string' && nextRecord.promptReceiptId.length > 0
  }
  if (before.kind !== 'conversation' || after.kind !== 'conversation' || before.conversationId !== after.conversationId) return false
  if (before.replyId !== undefined && before.replyId !== after.replyId) return false
  return after.replyId === undefined || stableReplyMatchesRoute(nextRecord.replyId, after.replyId)
}

/** DOM containers expose `response-<uuid>` while the route stores bare `rid=<uuid>`. */
function stableReplyMatchesRoute(stableReplyId: string | undefined, routeReplyId: string): boolean {
  return stableReplyId === routeReplyId || stableReplyId === `response-${routeReplyId}`
}

function validateRequest(value: unknown): GrokRequest {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['id', 'sessionId', 'canonical', 'prompt', 'modelLabel'])
  assertUuid(value.id)
  assertString(value.sessionId, true)
  assertString(value.canonical, true)
  assertString(value.prompt, true)
  assertOptionalString(value, 'modelLabel', true)
  return {
    id: value.id,
    sessionId: value.sessionId,
    canonical: value.canonical,
    prompt: value.prompt,
    ...(value.modelLabel === undefined ? {} : { modelLabel: value.modelLabel as string }),
  }
}

function validateResource(value: unknown): GrokResource {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['provider', 'spaceId', 'pageLabel', 'conversationUrl'])
  if (value.provider !== 'grok') throw invalidState()
  if (!Number.isSafeInteger(value.spaceId) || (value.spaceId as number) <= 0) throw invalidState()
  assertString(value.pageLabel, true)
  assertString(value.conversationUrl, true)
  if (!isGrokResourceUrl(value.conversationUrl)) throw invalidState()
  return {
    provider: 'grok',
    spaceId: value.spaceId as number,
    pageLabel: value.pageLabel,
    conversationUrl: value.conversationUrl,
  }
}

function validateOutput(value: unknown): NonNullable<GrokRunRecord['output']> {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['text', 'sha256'])
  assertString(value.text, true)
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(value.sha256)) throw invalidState()
  if (createHash('sha256').update(value.text, 'utf8').digest('hex') !== value.sha256.toLowerCase()) throw invalidState()
  return { text: value.text, sha256: value.sha256 }
}

function validateError(value: unknown): NonNullable<GrokRunRecord['error']> {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['code', 'message'])
  assertString(value.code, true)
  assertString(value.message, true)
  return { code: value.code, message: value.message }
}

function validateRecord(value: unknown, expectedId?: string, expectedRevision?: number): GrokRunRecord {
  if (!isObject(value)) throw invalidState()
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) throw invalidState()
  if (value.formatVersion !== GROK_RUN_FORMAT_VERSION) {
    throw storeError('GROK_STATE_VERSION', 'Grok durable state format version is unsupported')
  }
  assertKeys(value, [
    'formatVersion', 'revision', 'id', 'createdAt', 'updatedAt', 'request', 'stage', 'resource', 'observedModelLabel',
    'intentAt', 'promptReceiptId', 'replyId', 'output', 'error',
  ])
  assertUuid(value.id)
  if (expectedId !== undefined && value.id !== expectedId) throw invalidState()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw invalidState()
  if (expectedRevision !== undefined && value.revision !== expectedRevision) throw invalidState()
  assertIsoTimestamp(value.createdAt)
  assertIsoTimestamp(value.updatedAt)
  const request = validateRequest(value.request)
  if (request.id !== value.id) throw invalidState()
  if (typeof value.stage !== 'string' || !STAGES.has(value.stage as GrokStage)) throw invalidState()
  if (hasOwn(value, 'resource') && value.resource === undefined) throw invalidState()
  if (hasOwn(value, 'resource') && value.resource !== undefined) validateResource(value.resource)
  assertOptionalString(value, 'observedModelLabel', true)
  if (hasOwn(value, 'intentAt')) assertIsoTimestamp(value.intentAt)
  assertOptionalString(value, 'promptReceiptId', true)
  assertOptionalString(value, 'replyId', true)
  if (hasOwn(value, 'output') && value.output === undefined) throw invalidState()
  if (hasOwn(value, 'output') && value.output !== undefined) validateOutput(value.output)
  if (hasOwn(value, 'error') && value.error === undefined) throw invalidState()
  if (hasOwn(value, 'error') && value.error !== undefined) validateError(value.error)
  return {
    formatVersion: 1,
    revision: value.revision as number,
    id: value.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    request,
    stage: value.stage as GrokStage,
    ...(value.resource === undefined ? {} : { resource: validateResource(value.resource) }),
    ...(value.observedModelLabel === undefined ? {} : { observedModelLabel: value.observedModelLabel as string }),
    ...(value.intentAt === undefined ? {} : { intentAt: value.intentAt as string }),
    ...(value.promptReceiptId === undefined ? {} : { promptReceiptId: value.promptReceiptId as string }),
    ...(value.replyId === undefined ? {} : { replyId: value.replyId as string }),
    ...(value.output === undefined ? {} : { output: validateOutput(value.output) }),
    ...(value.error === undefined ? {} : { error: validateError(value.error) }),
  }
}

function normalizePatch(value: unknown): GrokRunPatch {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['stage', 'resource', 'observedModelLabel', 'intentAt', 'promptReceiptId', 'replyId', 'output', 'error'])
  if (hasOwn(value, 'stage') && (typeof value.stage !== 'string' || !STAGES.has(value.stage as GrokStage))) throw invalidState()
  if (hasOwn(value, 'resource') && value.resource !== undefined) validateResource(value.resource)
  if (hasOwn(value, 'observedModelLabel') && value.observedModelLabel !== undefined) assertString(value.observedModelLabel, true)
  if (hasOwn(value, 'intentAt') && value.intentAt !== undefined) assertIsoTimestamp(value.intentAt)
  if (hasOwn(value, 'promptReceiptId') && value.promptReceiptId !== undefined) assertString(value.promptReceiptId, true)
  if (hasOwn(value, 'replyId') && value.replyId !== undefined) assertString(value.replyId, true)
  if (hasOwn(value, 'output') && value.output !== undefined) validateOutput(value.output)
  if (hasOwn(value, 'error') && value.error !== undefined) validateError(value.error)
  return value as GrokRunPatch
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function requestIdentity(value: GrokRequest): string {
  return JSON.stringify({
    id: value.id,
    sessionId: value.sessionId,
    canonical: value.canonical,
    prompt: value.prompt,
    ...(value.modelLabel === undefined ? {} : { modelLabel: value.modelLabel }),
  })
}

function requestsEqual(left: GrokRequest, right: GrokRequest): boolean {
  return requestIdentity(left) === requestIdentity(right)
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

async function removeTemp(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

/**
 * Append-only journal for Grok. `callerRoot` is the plugin-owned state root;
 * records always live below `${callerRoot}/grok-web`.
 */
export class GrokRunStore {
  readonly root: string

  constructor(callerRoot: string) {
    if (typeof callerRoot !== 'string' || !isAbsolute(callerRoot) || callerRoot === parse(callerRoot).root) throw invalidState()
    this.root = join(callerRoot, 'grok-web')
  }

  async create(request: GrokRequest): Promise<GrokRunRecord> {
    return (await this.createOrRead(request)).record
  }

  /** Atomically creates revision zero or returns the original command's latest revision. */
  async createOrRead(request: GrokRequest): Promise<GrokCreateResult> {
    const normalized = validateRequest(request)
    await this.ensureRoot()
    await this.ensureRunDirectory(normalized.id)

    let history = await this.readHistory(normalized.id)
    if (history && history.length > 0) return this.existingResult(history, normalized)

    const now = new Date().toISOString()
    const record: GrokRunRecord = {
      formatVersion: 1,
      revision: 0,
      id: normalized.id,
      createdAt: now,
      updatedAt: now,
      request: normalized,
      stage: 'created',
    }
    try {
      await this.publish(normalized.id, record)
      return { record: clone(record), created: true }
    } catch (error) {
      if (!(error instanceof GrokStoreError) || error.code !== 'GROK_STATE_CONFLICT') throw error
      history = await this.readHistory(normalized.id)
      if (!history || history.length === 0) throw stateConflict()
      return this.existingResult(history, normalized)
    }
  }

  async read(id: string): Promise<GrokRunRecord | undefined> {
    assertUuid(id)
    const history = await this.readHistory(id)
    const latest = history?.[history.length - 1]
    return latest === undefined ? undefined : clone(latest)
  }

  async list(): Promise<readonly GrokRunRecord[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw invalidState()
    }
    const records: GrokRunRecord[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (!UUID_PATTERN.test(entry.name) || !entry.isDirectory()) throw invalidState()
      const history = await this.readHistory(entry.name)
      const latest = history?.[history.length - 1]
      if (latest !== undefined) records.push(clone(latest))
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return records
  }

  async transition(id: string, expectedRevision: number, patch: GrokRunPatch): Promise<GrokRunRecord> {
    assertUuid(id)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw stateConflict()
    const normalizedPatch = normalizePatch(patch)
    const history = await this.readHistory(id)
    const current = history?.[history.length - 1]
    if (!current) throw invalidState()
    if (current.revision !== expectedRevision) throw stateConflict()

    const next: Record<string, unknown> = {
      ...clone(current),
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    }
    for (const key of ['stage', 'resource', 'observedModelLabel', 'intentAt', 'promptReceiptId', 'replyId', 'output', 'error'] as const) {
      if (!hasOwn(normalizedPatch as JsonRecord, key)) continue
      const value = (normalizedPatch as JsonRecord)[key]
      if (value === undefined) delete next[key]
      else next[key] = clone(value)
    }
    const normalizedNext = validateRecord(next, id, expectedRevision + 1)
    this.assertImmutableFields(current, normalizedNext)
    await this.publish(id, normalizedNext)
    return clone(normalizedNext)
  }

  private existingResult(history: readonly GrokRunRecord[], request: GrokRequest): GrokCreateResult {
    const original = history[0]
    const latest = history[history.length - 1]
    if (!original || !latest || !requestsEqual(original.request, request)) throw commandConflict()
    return { record: clone(latest), created: false }
  }

  private assertImmutableFields(current: GrokRunRecord, next: GrokRunRecord): void {
    if (!requestsEqual(current.request, next.request) || current.createdAt !== next.createdAt) throw invalidState()
    if (current.resource !== undefined) {
      if (next.resource === undefined || !conversationTransitionAllowed(current.resource, next.resource, next)) throw invalidState()
    }
    for (const key of ['intentAt', 'promptReceiptId', 'replyId', 'output'] as const) {
      const before = current[key]
      const after = next[key]
      if (before !== undefined && !jsonEqual(before, after)) throw invalidState()
    }
  }

  private runDirectory(id: string): string {
    return join(this.root, id)
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: ROOT_MODE })
      const info = await lstat(this.root)
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalidState()
      await chmod(this.root, ROOT_MODE)
    } catch (error) {
      if (error instanceof GrokStoreError) throw error
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
      const info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) throw invalidState()
      await chmod(directory, ROOT_MODE)
    } catch (error) {
      if (error instanceof GrokStoreError) throw error
      throw invalidState()
    }
  }

  private async readHistory(id: string): Promise<GrokRunRecord[] | undefined> {
    const directory = this.runDirectory(id)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw invalidState()
    }
    const revisions: Array<{ readonly revision: number; readonly name: string }> = []
    for (const entry of entries) {
      if (entry.name.endsWith('.tmp')) continue
      const match = REVISION_FILE_PATTERN.exec(entry.name)
      if (!match || !entry.isFile() || entry.isSymbolicLink()) throw invalidState()
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision)) throw invalidState()
      revisions.push({ revision, name: entry.name })
    }
    if (revisions.length === 0) return undefined
    revisions.sort((left, right) => left.revision - right.revision)
    const history: GrokRunRecord[] = []
    let previous: GrokRunRecord | undefined
    for (let index = 0; index < revisions.length; index += 1) {
      const item = revisions[index]
      if (!item || item.revision !== index) throw invalidState()
      let parsed: unknown
      try {
        parsed = JSON.parse(await readFile(join(directory, item.name), 'utf8')) as unknown
      } catch {
        throw invalidState()
      }
      const record = validateRecord(parsed, id, item.revision)
      if (previous) this.assertImmutableFields(previous, record)
      previous = record
      history.push(record)
    }
    return history
  }

  private async publish(id: string, record: GrokRunRecord): Promise<void> {
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
      await this.syncDirectory(directory)
    } catch (error) {
      if (error instanceof GrokStoreError) throw error
      throw invalidState()
    } finally {
      if (handle) {
        try { await handle.close() } catch { /* already closed */ }
      }
      await removeTemp(temporary)
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(path, 'r')
      await handle.sync()
    } finally {
      if (handle) await handle.close()
    }
  }
}
