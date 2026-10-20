import { randomUUID } from 'node:crypto'
import { chmod, link, lstat, mkdir, open, readdir, readFile, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'

export const WEB_RUN_FORMAT_VERSION = 1 as const

export type WebRunStage =
  | 'prepared'
  | 'ready'
  | 'submission-unknown'
  | 'submitted'
  | 'completed'
  | 'blocked'
  | 'indeterminate'
  | 'failed'
  | 'cancelled'

export interface WebRunRequest {
  readonly prompt: string
  readonly modelLabel?: string
  readonly effortLabel?: string
}

export interface WebRunResource {
  readonly spaceId: number
  readonly pageLabel: string
  readonly conversationUrl?: string
}

export interface WebRunObserved {
  readonly modelLabel?: string
  readonly effortLabel?: string
}

export interface WebRunOutput {
  readonly text: string
  readonly markdown: string
}

export interface WebRunErrorDetail {
  readonly code: string
  readonly message: string
}

export interface WebRunRecord {
  readonly formatVersion: 1
  readonly id: string
  readonly revision: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly request: WebRunRequest
  readonly stage: WebRunStage
  readonly resource?: WebRunResource
  readonly observed?: WebRunObserved
  readonly output?: WebRunOutput
  readonly error?: WebRunErrorDetail
}

export type WebRunPatch = Partial<Pick<WebRunRecord, 'stage' | 'resource' | 'observed' | 'output' | 'error'>>

export type WebRunStoreErrorCode =
  | 'WEB_COMMAND_CONFLICT'
  | 'WEB_STATE_VERSION'
  | 'WEB_STATE_INVALID'
  | 'WEB_STATE_CONFLICT'

export class WebRunStoreError extends Error {
  constructor(readonly code: WebRunStoreErrorCode, message: string) {
    super(message)
    this.name = 'WebRunStoreError'
  }
}

const ROOT_MODE = 0o700
const RECORD_MODE = 0o600
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVISION_FILE_PATTERN = /^(0|[1-9][0-9]*)\.json$/
const STAGES = new Set<WebRunStage>([
  'prepared',
  'ready',
  'submission-unknown',
  'submitted',
  'completed',
  'blocked',
  'indeterminate',
  'failed',
  'cancelled',
])

type JsonRecord = Record<string, unknown>

function storeError(code: WebRunStoreErrorCode, message: string): WebRunStoreError {
  return new WebRunStoreError(code, message)
}

function invalidState(): WebRunStoreError {
  return storeError('WEB_STATE_INVALID', 'Web run state is invalid')
}

function stateConflict(): WebRunStoreError {
  return storeError('WEB_STATE_CONFLICT', 'Web run state changed concurrently')
}

function commandConflict(): WebRunStoreError {
  return storeError('WEB_COMMAND_CONFLICT', 'Web run id was already used with a different request')
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

function assertString(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw invalidState()
}

function assertOptionalString(value: JsonRecord, key: string): void {
  if (hasOwn(value, key) && value[key] !== undefined) assertString(value[key])
  if (hasOwn(value, key) && value[key] === null) throw invalidState()
}

function assertIsoTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw invalidState()
  }
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw invalidState()
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalidState()
}

function isChatGptUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false
    const host = parsed.hostname.toLowerCase()
    return host === 'chatgpt.com'
      || host.endsWith('.chatgpt.com')
      || host === 'chat.openai.com'
      || host.endsWith('.chat.openai.com')
  } catch {
    return false
  }
}

function validateRequest(value: unknown): WebRunRequest {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['prompt', 'modelLabel', 'effortLabel'])
  if (!hasOwn(value, 'prompt')) throw invalidState()
  assertString(value.prompt)
  assertOptionalString(value, 'modelLabel')
  assertOptionalString(value, 'effortLabel')
  return {
    prompt: value.prompt,
    ...(value.modelLabel === undefined ? {} : { modelLabel: value.modelLabel as string }),
    ...(value.effortLabel === undefined ? {} : { effortLabel: value.effortLabel as string }),
  }
}

function validateResource(value: unknown): WebRunResource {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['spaceId', 'pageLabel', 'conversationUrl'])
  if (!Number.isSafeInteger(value.spaceId) || (value.spaceId as number) <= 0) throw invalidState()
  if (typeof value.pageLabel !== 'string') throw invalidState()
  if (hasOwn(value, 'conversationUrl')) {
    if (typeof value.conversationUrl !== 'string' || !isChatGptUrl(value.conversationUrl)) throw invalidState()
  }
  return {
    spaceId: value.spaceId as number,
    pageLabel: value.pageLabel,
    ...(value.conversationUrl === undefined ? {} : { conversationUrl: value.conversationUrl as string }),
  }
}

function validateObserved(value: unknown): WebRunObserved {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['modelLabel', 'effortLabel'])
  assertOptionalString(value, 'modelLabel')
  assertOptionalString(value, 'effortLabel')
  return {
    ...(value.modelLabel === undefined ? {} : { modelLabel: value.modelLabel as string }),
    ...(value.effortLabel === undefined ? {} : { effortLabel: value.effortLabel as string }),
  }
}

function validateOutput(value: unknown): WebRunOutput {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['text', 'markdown'])
  if (typeof value.text !== 'string' || typeof value.markdown !== 'string') throw invalidState()
  return { text: value.text, markdown: value.markdown }
}

function validateError(value: unknown): WebRunErrorDetail {
  if (!isObject(value)) throw invalidState()
  assertKeys(value, ['code', 'message'])
  if (typeof value.code !== 'string' || typeof value.message !== 'string') throw invalidState()
  return { code: value.code, message: value.message }
}

function validateRecord(value: unknown, expectedId?: string, expectedRevision?: number): WebRunRecord {
  if (!isObject(value)) throw invalidState()
  if (!hasOwn(value, 'formatVersion')) {
    throw invalidState()
  }
  if (typeof value.formatVersion !== 'number' || !Number.isInteger(value.formatVersion)) throw invalidState()
  if (value.formatVersion !== WEB_RUN_FORMAT_VERSION) {
    throw storeError('WEB_STATE_VERSION', 'Web run state format version is unsupported')
  }
  assertKeys(value, ['formatVersion', 'id', 'revision', 'createdAt', 'updatedAt', 'request', 'stage', 'resource', 'observed', 'output', 'error'])
  assertUuid(value.id)
  if (expectedId !== undefined && value.id !== expectedId) throw invalidState()
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) throw invalidState()
  if (expectedRevision !== undefined && value.revision !== expectedRevision) throw invalidState()
  assertIsoTimestamp(value.createdAt)
  assertIsoTimestamp(value.updatedAt)
  const request = validateRequest(value.request)
  if (typeof value.stage !== 'string' || !STAGES.has(value.stage as WebRunStage)) throw invalidState()
  if (hasOwn(value, 'resource')) {
    if (value.resource === undefined) throw invalidState()
    validateResource(value.resource)
  }
  if (hasOwn(value, 'observed')) {
    if (value.observed === undefined) throw invalidState()
    validateObserved(value.observed)
  }
  if (hasOwn(value, 'output')) {
    if (value.output === undefined) throw invalidState()
    validateOutput(value.output)
  }
  if (hasOwn(value, 'error')) {
    if (value.error === undefined) throw invalidState()
    validateError(value.error)
  }
  return {
    formatVersion: 1,
    id: value.id,
    revision: value.revision as number,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    request,
    stage: value.stage as WebRunStage,
    ...(value.resource === undefined ? {} : { resource: validateResource(value.resource) }),
    ...(value.observed === undefined ? {} : { observed: validateObserved(value.observed) }),
    ...(value.output === undefined ? {} : { output: validateOutput(value.output) }),
    ...(value.error === undefined ? {} : { error: validateError(value.error) }),
  }
}

function normalizeId(id: unknown): string {
  assertUuid(id)
  return id
}

function normalizeRequest(request: unknown): WebRunRequest {
  return validateRequest(request)
}

function normalizePatch(patch: unknown): WebRunPatch {
  if (!isObject(patch)) throw invalidState()
  assertKeys(patch, ['stage', 'resource', 'observed', 'output', 'error'])
  if (hasOwn(patch, 'stage')) {
    if (typeof patch.stage !== 'string' || !STAGES.has(patch.stage as WebRunStage)) throw invalidState()
  }
  if (hasOwn(patch, 'resource') && patch.resource !== undefined) validateResource(patch.resource)
  if (hasOwn(patch, 'observed') && patch.observed !== undefined) validateObserved(patch.observed)
  if (hasOwn(patch, 'output') && patch.output !== undefined) validateOutput(patch.output)
  if (hasOwn(patch, 'error') && patch.error !== undefined) validateError(patch.error)
  return patch as WebRunPatch
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function requestsEqual(left: WebRunRequest, right: WebRunRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

async function removeTemp(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) return
  }
}

export class WebRunStore {
  readonly root: string

  constructor(root: string) {
    if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root) {
      throw invalidState()
    }
    this.root = root
  }

  async create(id: string, request: WebRunRequest): Promise<WebRunRecord> {
    const normalizedId = normalizeId(id)
    const normalizedRequest = normalizeRequest(request)
    await this.ensureRoot()
    await this.ensureRunDirectory(normalizedId)

    let history = await this.readHistory(normalizedId)
    if (history && history.length > 0) {
      const original = history[0]
      if (!original || !requestsEqual(original.request, normalizedRequest)) throw commandConflict()
      const latest = history[history.length - 1]
      if (!latest) throw invalidState()
      return clone(latest)
    }

    const now = new Date().toISOString()
    const record: WebRunRecord = {
      formatVersion: 1,
      id: normalizedId,
      revision: 0,
      createdAt: now,
      updatedAt: now,
      request: normalizedRequest,
      stage: 'prepared',
    }
    try {
      await this.publish(normalizedId, record)
    } catch (error) {
      if (!(error instanceof WebRunStoreError) || error.code !== 'WEB_STATE_CONFLICT') throw error
      history = await this.readHistory(normalizedId)
      if (!history || history.length === 0) throw stateConflict()
      const original = history[0]
      if (!original || !requestsEqual(original.request, normalizedRequest)) throw commandConflict()
      const latest = history[history.length - 1]
      if (!latest) throw stateConflict()
      return clone(latest)
    }
    return clone(record)
  }

  async read(id: string): Promise<WebRunRecord | undefined> {
    const normalizedId = normalizeId(id)
    const history = await this.readHistory(normalizedId)
    const latest = history?.[history.length - 1]
    return latest ? clone(latest) : undefined
  }

  async list(): Promise<readonly WebRunRecord[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw invalidState()
    }

    const records: WebRunRecord[] = []
    for (const entry of entries) {
      if (!UUID_PATTERN.test(entry.name)) continue
      if (!entry.isDirectory()) throw invalidState()
      const history = await this.readHistory(entry.name)
      const latest = history?.[history.length - 1]
      if (!latest) continue
      records.push(clone(latest))
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    return records
  }

  async transition(id: string, expectedRevision: number, patch: WebRunPatch): Promise<WebRunRecord> {
    const normalizedId = normalizeId(id)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw stateConflict()
    }
    const normalizedPatch = normalizePatch(patch)
    const history = await this.readHistory(normalizedId)
    const current = history?.[history.length - 1]
    if (!current) throw invalidState()
    if (current.revision !== expectedRevision) throw stateConflict()

    const next: Record<string, unknown> = {
      ...clone(current),
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    }
    for (const key of ['stage', 'resource', 'observed', 'output', 'error'] as const) {
      if (!hasOwn(normalizedPatch as JsonRecord, key)) continue
      const value = (normalizedPatch as JsonRecord)[key]
      if (value === undefined) delete next[key]
      else next[key] = clone(value)
    }
    const normalizedNext = validateRecord(next, normalizedId, expectedRevision + 1)
    await this.publish(normalizedId, normalizedNext)
    return clone(normalizedNext)
  }

  private runDirectory(id: string): string {
    return join(this.root, id)
  }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: ROOT_MODE })
      await chmod(this.root, ROOT_MODE)
      const info = await lstat(this.root)
      if (!info.isDirectory()) throw invalidState()
    } catch (error) {
      if (error instanceof WebRunStoreError) throw error
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
      if (!info.isDirectory()) throw invalidState()
      await chmod(directory, ROOT_MODE)
    } catch (error) {
      if (error instanceof WebRunStoreError) throw error
      throw invalidState()
    }
  }

  private async readHistory(id: string): Promise<WebRunRecord[] | undefined> {
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
      if (!match) throw invalidState()
      if (!entry.isFile()) throw invalidState()
      const revision = Number(match[1])
      if (!Number.isSafeInteger(revision)) throw invalidState()
      revisions.push({ revision, name: entry.name })
    }
    if (revisions.length === 0) return undefined
    revisions.sort((left, right) => left.revision - right.revision)
    const history: WebRunRecord[] = []
    let baseline: WebRunRecord | undefined
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
      const record = validateRecord(parsed, id, item.revision)
      if (!baseline) {
        baseline = record
      } else if (!requestsEqual(record.request, baseline.request) || record.createdAt !== baseline.createdAt) {
        throw invalidState()
      }
      history.push(record)
    }
    return history
  }

  private async publish(id: string, record: WebRunRecord): Promise<void> {
    const directory = this.runDirectory(id)
    const target = join(directory, `${record.revision}.json`)
    const temporary = join(directory, `.${record.revision}.${randomUUID()}.tmp`)
    const contents = JSON.stringify(record)
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', RECORD_MODE)
      await handle.writeFile(contents, 'utf8')
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
      if (error instanceof WebRunStoreError) throw error
      throw invalidState()
    } finally {
      if (handle) {
        try { await handle.close() } catch { /* already closed */ }
      }
      await removeTemp(temporary)
    }
  }
}
