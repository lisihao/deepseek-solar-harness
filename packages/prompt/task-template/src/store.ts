/**
 * Persisted store document of the task-template seam: the on-disk JSON format
 * and its trust-boundary validation. Every value read from disk passes through
 * {@link parseStoreDocument}, which rejects unsupported format versions and
 * structurally corrupt documents loud instead of silently accepting them; the
 * same field validators guard the lifecycle write inputs for constraints the
 * static types cannot express.
 *
 * 任务模板接缝的持久化存储文档：磁盘 JSON 格式及其信任边界校验。所有从磁盘
 * 读入的值都经过 {@link parseStoreDocument}，对不支持的格式版本与结构损坏的
 * 文档立即报错而非静默接受；同一组字段校验器也用于生命周期写入中静态类型
 * 无法表达的约束。
 *
 * @module @deepseek-ai/dsh-task-template/store
 */

import { TASK_TEMPLATE_ID_PATTERN } from './brand.ts'
import { validateTaskTemplateMethod } from './render.ts'
import type {
  TaskPriority,
  TaskRiskLevel,
  TaskTemplate,
  TaskTemplateChangeKind,
  TaskTemplateId,
  TaskTemplateMatch,
  TaskTemplatePersonalization,
  TaskTemplateRevision,
} from './types.ts'

/** The one store format this build reads and writes. 本构建读写的存储格式版本。 */
export const TASK_TEMPLATE_STORE_FORMAT_VERSION = 1

/**
 * Complete persisted state: every template with its revision history, plus the
 * separate personalization layer keyed by template id.
 *
 * 完整持久化状态：所有模板及其修订历史，加上按模板 ID 键控的独立个性化层。
 */
export interface TaskTemplateStoreDocument {
  /** Store format version; only {@link TASK_TEMPLATE_STORE_FORMAT_VERSION} loads. 格式版本。 */
  formatVersion: typeof TASK_TEMPLATE_STORE_FORMAT_VERSION
  /** Every stored template, unique by id. 全部模板，ID 唯一。 */
  templates: TaskTemplate[]
  /** Personal layers keyed by an existing template id. 个性化层，键为已存在的模板 ID。 */
  personalization: Record<string, TaskTemplatePersonalization>
}

/**
 * The empty document a provider publishes when its storage does not exist yet.
 * 存储尚不存在时提供者发布的空文档。
 * @returns a fresh empty store document.
 */
export function emptyStoreDocument(): TaskTemplateStoreDocument {
  return { formatVersion: TASK_TEMPLATE_STORE_FORMAT_VERSION, templates: [], personalization: {} }
}

const RISK_LEVELS: readonly TaskRiskLevel[] = ['low', 'medium', 'high', 'critical']
const PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent']

/** Thrown for every rejected store document or field value. 校验失败抛出的错误。 */
export class TaskTemplateStoreError extends TypeError {
  /** Stable machine code for callers mapping this to their own taxonomy. */
  readonly code = 'TASK_TEMPLATE_STORE'

  /**
   * @param message - what was rejected and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'TaskTemplateStoreError'
  }
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Reject keys outside the allowed set, naming the first offender. */
function rejectUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], at: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new TaskTemplateStoreError(`${at} has unsupported key "${key}"`)
    }
  }
}

/**
 * Validate one non-blank string field.
 * @param value - candidate value.
 * @param at - `$`-rooted location for the error message.
 * @returns the validated string.
 */
export function validateNonBlankString(value: unknown, at: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TaskTemplateStoreError(`${at} must be a non-blank string`)
  }
  return value
}

/**
 * Validate non-blank method text and its reserved placeholder syntax.
 * @param value - candidate method value.
 * @param at - `$`-rooted location for the error message.
 * @returns the validated method text.
 */
export function validateMethod(value: unknown, at: string): string {
  const method = validateNonBlankString(value, at)
  validateTaskTemplateMethod(method, at)
  return method
}

/**
 * Validate one template rank: a finite number used only for deterministic ordering.
 * @param value - candidate value.
 * @param at - `$`-rooted location for the error message.
 * @returns the validated rank.
 */
export function validateRank(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TaskTemplateStoreError(`${at} must be a finite number`)
  }
  return value
}

/** Validate a positive-integer method-layer version. */
function validateVersion(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TaskTemplateStoreError(`${at} must be a positive integer`)
  }
  return value
}

/** Validate a canonical ISO-8601 UTC instant emitted by `Date#toISOString`. */
function validateInstant(value: unknown, at: string): string {
  const text = validateNonBlankString(value, at)
  const instant = new Date(text)
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== text) {
    throw new TaskTemplateStoreError(`${at} must be a canonical ISO-8601 UTC instant`)
  }
  return text
}

/** Validate one non-empty list of unique non-blank strings. */
function validateStringList(value: unknown, at: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TaskTemplateStoreError(`${at} must be a non-empty array`)
  }
  const entries = value.map((entry, index) => validateNonBlankString(entry, `${at}[${String(index)}]`))
  if (new Set(entries).size !== entries.length) {
    throw new TaskTemplateStoreError(`${at} must not contain duplicates`)
  }
  return entries
}

/** Validate a string list whose members must come from a closed union. */
function validateUnionList<T extends string>(value: unknown, members: readonly T[], at: string): T[] {
  const entries = validateStringList(value, at)
  for (const entry of entries) {
    if (!(members as readonly string[]).includes(entry)) {
      throw new TaskTemplateStoreError(`${at} contains "${entry}"; allowed: ${members.join(', ')}`)
    }
  }
  return entries as T[]
}

const MATCH_KEYS = [
  'taskTypes',
  'domains',
  'objectiveKeywords',
  'outputFormats',
  'riskLevels',
  'requiredTools',
  'requiredSkills',
  'operators',
  'languages',
  'priorities',
] as const

/**
 * Validate one match-criteria record. Absent fields stay absent (wildcard);
 * present fields must be non-empty unique lists, so an accidental empty list
 * can never silently turn into match-nothing or match-everything.
 * @param value - candidate match record.
 * @param at - `$`-rooted location for the error message.
 * @returns the validated, detached match record.
 */
export function validateMatch(value: unknown, at: string): TaskTemplateMatch {
  if (!isPlainObject(value)) {
    throw new TaskTemplateStoreError(`${at} must be an object of match criteria`)
  }
  rejectUnknownKeys(value, MATCH_KEYS, at)
  const match: TaskTemplateMatch = {}
  for (const key of MATCH_KEYS) {
    if (value[key] === undefined) continue
    if (key === 'riskLevels') {
      match.riskLevels = validateUnionList(value[key], RISK_LEVELS, `${at}.${key}`)
    } else if (key === 'priorities') {
      match.priorities = validateUnionList(value[key], PRIORITIES, `${at}.${key}`)
    } else {
      match[key] = validateStringList(value[key], `${at}.${key}`)
    }
  }
  return match
}

/** Validate one template id read from disk. */
function validateStoredId(value: unknown, at: string): TaskTemplateId {
  const text = validateNonBlankString(value, at)
  if (!TASK_TEMPLATE_ID_PATTERN.test(text)) {
    throw new TaskTemplateStoreError(`${at} must match ${String(TASK_TEMPLATE_ID_PATTERN)}`)
  }
  return text as TaskTemplateId
}

const REVISION_KEYS = ['version', 'name', 'rank', 'match', 'method', 'updatedAt'] as const

/** Validate one archived method-layer revision. */
function validateRevision(value: unknown, at: string): TaskTemplateRevision {
  if (!isPlainObject(value)) {
    throw new TaskTemplateStoreError(`${at} must be a revision object`)
  }
  rejectUnknownKeys(value, REVISION_KEYS, at)
  return {
    version: validateVersion(value['version'], `${at}.version`),
    name: validateNonBlankString(value['name'], `${at}.name`),
    rank: validateRank(value['rank'], `${at}.rank`),
    match: validateMatch(value['match'], `${at}.match`),
    method: validateMethod(value['method'], `${at}.method`),
    updatedAt: validateInstant(value['updatedAt'], `${at}.updatedAt`),
  }
}

const TEMPLATE_KEYS = ['id', 'enabled', 'createdAt', 'version', 'name', 'rank', 'match', 'method', 'updatedAt', 'history'] as const

/** Validate one stored template record, including its revision-history ordering. */
function validateTemplate(value: unknown, at: string): TaskTemplate {
  if (!isPlainObject(value)) {
    throw new TaskTemplateStoreError(`${at} must be a template object`)
  }
  rejectUnknownKeys(value, TEMPLATE_KEYS, at)
  if (typeof value['enabled'] !== 'boolean') {
    throw new TaskTemplateStoreError(`${at}.enabled must be a boolean`)
  }
  if (!Array.isArray(value['history'])) {
    throw new TaskTemplateStoreError(`${at}.history must be an array`)
  }
  const version = validateVersion(value['version'], `${at}.version`)
  const history = value['history'].map((entry, index) => validateRevision(entry, `${at}.history[${String(index)}]`))
  if (history.length !== version - 1) {
    throw new TaskTemplateStoreError(
      `${at}.history must contain every superseded version from 1 through ${String(version - 1)}`,
    )
  }
  for (const [index, revision] of history.entries()) {
    const expectedVersion = index + 1
    if (revision.version !== expectedVersion) {
      throw new TaskTemplateStoreError(
        `${at}.history[${String(index)}].version must be ${String(expectedVersion)} to preserve complete version history`,
      )
    }
  }
  return {
    id: validateStoredId(value['id'], `${at}.id`),
    enabled: value['enabled'],
    createdAt: validateInstant(value['createdAt'], `${at}.createdAt`),
    version,
    name: validateNonBlankString(value['name'], `${at}.name`),
    rank: validateRank(value['rank'], `${at}.rank`),
    match: validateMatch(value['match'], `${at}.match`),
    method: validateMethod(value['method'], `${at}.method`),
    updatedAt: validateInstant(value['updatedAt'], `${at}.updatedAt`),
    history,
  }
}

const PERSONALIZATION_KEYS = ['preferences', 'memory'] as const

/**
 * Validate one personal layer: at least one of `preferences`/`memory`, each a
 * non-blank string.
 * @param value - candidate personalization record.
 * @param at - `$`-rooted location for the error message.
 * @returns the validated, detached personalization record.
 */
export function validatePersonalization(value: unknown, at: string): TaskTemplatePersonalization {
  if (!isPlainObject(value)) {
    throw new TaskTemplateStoreError(`${at} must be an object with "preferences" and/or "memory"`)
  }
  rejectUnknownKeys(value, PERSONALIZATION_KEYS, at)
  const personalization: TaskTemplatePersonalization = {}
  if (value['preferences'] !== undefined) {
    personalization.preferences = validateNonBlankString(value['preferences'], `${at}.preferences`)
  }
  if (value['memory'] !== undefined) {
    personalization.memory = validateNonBlankString(value['memory'], `${at}.memory`)
  }
  if (personalization.preferences === undefined && personalization.memory === undefined) {
    throw new TaskTemplateStoreError(`${at} must carry at least one of "preferences" or "memory"`)
  }
  return personalization
}

const DOCUMENT_KEYS = ['formatVersion', 'templates', 'personalization'] as const

/**
 * Parse and validate one store document text at the disk trust boundary.
 * Unparsable JSON, an unsupported `formatVersion`, unknown keys, duplicate
 * template ids, malformed records, broken history ordering, and
 * personalization entries for unknown templates all reject loud.
 *
 * 在磁盘信任边界解析并校验存储文档文本。无法解析的 JSON、不支持的格式版本、
 * 未知键、重复模板 ID、畸形记录、损坏的历史顺序、指向未知模板的个性化条目
 * 均立即报错。
 * @param text - raw document text read from storage.
 * @param source - storage location named in error messages.
 * @returns the validated, detached store document.
 */
export function parseStoreDocument(text: string, source: string): TaskTemplateStoreDocument {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (cause) {
    throw new TaskTemplateStoreError(`task-template store at ${source} is not valid JSON: ${(cause as Error).message}`)
  }
  if (!isPlainObject(root)) {
    throw new TaskTemplateStoreError(`task-template store at ${source}: $ must be an object`)
  }
  rejectUnknownKeys(root, DOCUMENT_KEYS, `task-template store at ${source}: $`)
  if (root['formatVersion'] !== TASK_TEMPLATE_STORE_FORMAT_VERSION) {
    throw new TaskTemplateStoreError(
      `task-template store at ${source} has unsupported formatVersion ${JSON.stringify(root['formatVersion'])}; `
      + `this build reads version ${String(TASK_TEMPLATE_STORE_FORMAT_VERSION)}`,
    )
  }
  if (!Array.isArray(root['templates'])) {
    throw new TaskTemplateStoreError(`task-template store at ${source}: $.templates must be an array`)
  }
  const templates = root['templates'].map((entry, index) =>
    validateTemplate(entry, `task-template store at ${source}: $.templates[${String(index)}]`))
  const ids = new Set<string>()
  for (const template of templates) {
    if (ids.has(template.id)) {
      throw new TaskTemplateStoreError(`task-template store at ${source} has duplicate template id "${template.id}"`)
    }
    ids.add(template.id)
  }
  const rawPersonalization = root['personalization']
  if (!isPlainObject(rawPersonalization)) {
    throw new TaskTemplateStoreError(`task-template store at ${source}: $.personalization must be an object`)
  }
  const personalization: Record<string, TaskTemplatePersonalization> = {}
  for (const [id, entry] of Object.entries(rawPersonalization)) {
    if (!ids.has(id)) {
      throw new TaskTemplateStoreError(
        `task-template store at ${source}: $.personalization["${id}"] names an unknown template`,
      )
    }
    personalization[id] = validatePersonalization(entry, `task-template store at ${source}: $.personalization["${id}"]`)
  }
  return { formatVersion: TASK_TEMPLATE_STORE_FORMAT_VERSION, templates, personalization }
}

/**
 * Render one store document as the canonical persisted JSON text.
 * 将存储文档渲染为规范的持久化 JSON 文本。
 * @param document - the complete document to persist.
 * @returns pretty-printed JSON ending in one newline.
 */
export function renderStoreDocument(document: TaskTemplateStoreDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/** One template's change kind and the version to report it at. */
export interface TaskTemplateStoreDiff {
  id: TaskTemplateId
  kind: TaskTemplateChangeKind
  version: number
}

/**
 * Compare two store documents and report, per affected template, the same
 * `(id, kind, version)` triple {@link TaskTemplateService.write} would have
 * emitted had the change happened through this process's own lifecycle
 * methods instead of being observed from storage. A template present in both
 * documents but otherwise unchanged (same version, enablement, and personal
 * layer) contributes nothing: a provider reload with no net effect must not
 * re-announce every template.
 *
 * Precedence per template mirrors the single-writer lifecycle, which never
 * changes more than one of these facts in one commit: a version bump
 * (`update`) is reported over an enablement flip (`enable`/`disable`) is
 * reported over a personalization-only change (`personalize`), so a
 * multi-field external edit still reports the one most-significant kind
 * rather than silently dropping the others.
 * @param before - the previously committed document.
 * @param after - the newly observed document.
 * @returns the diffs to emit, in `after.templates` order, then removed ids.
 */
export function diffStoreDocuments(
  before: TaskTemplateStoreDocument,
  after: TaskTemplateStoreDocument,
): TaskTemplateStoreDiff[] {
  const beforeById = new Map(before.templates.map(template => [template.id, template]))
  const afterIds = new Set(after.templates.map(template => template.id))
  const diffs: TaskTemplateStoreDiff[] = []
  for (const template of after.templates) {
    const previous = beforeById.get(template.id)
    if (previous === undefined) {
      diffs.push({ id: template.id, kind: 'create', version: template.version })
      continue
    }
    if (previous.version !== template.version) {
      diffs.push({ id: template.id, kind: 'update', version: template.version })
      continue
    }
    if (previous.enabled !== template.enabled) {
      diffs.push({ id: template.id, kind: template.enabled ? 'enable' : 'disable', version: template.version })
      continue
    }
    const previousPersonalization = before.personalization[template.id]
    const nextPersonalization = after.personalization[template.id]
    if (JSON.stringify(previousPersonalization) !== JSON.stringify(nextPersonalization)) {
      diffs.push({ id: template.id, kind: 'personalize', version: template.version })
    }
  }
  for (const template of before.templates) {
    if (!afterIds.has(template.id)) {
      diffs.push({ id: template.id, kind: 'delete', version: template.version })
    }
  }
  return diffs
}
