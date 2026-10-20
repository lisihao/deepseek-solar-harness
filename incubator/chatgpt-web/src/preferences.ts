import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import {
  assertInsightConfig,
  cloneInsight,
  defaultInsightConfig,
  stableInsightJson,
  versionedTemplate,
  type InsightConfigV1,
  type InsightStageConfig,
  type InsightTemplate,
} from './insight-contract.js'
import type { GeminiSemanticSelectors, GeminiThinkingSelectors, GeminiVisibleQuotaSelector } from './gemini-port.js'

export const WEB_PREFERENCES_FORMAT_VERSION = 1 as const
export const WEB_PREFERENCES_FILE = 'preferences.json' as const
export const WEB_PREFERENCES_MAX_TEXT_BYTES = 256 * 1024
export const WEB_PREFERENCES_MAX_JSON_BYTES = 4 * 1024 * 1024

export interface WebPreferences {
  readonly formatVersion: 1
  readonly revision: number
  readonly web: {
    readonly modelLabel: string
    readonly effortLabel: string
  }
  readonly insight: InsightConfigV1
  /** Optional semantic selectors supplied only after explicit Gemini UI evidence. */
  readonly geminiSemantics?: GeminiSemanticSelectors
}

export interface WebPreferencesSaveInput {
  readonly expectedRevision: number
  readonly value: WebPreferences
}

export type WebPreferencesErrorCode =
  | 'WEB_PREFERENCES_VERSION'
  | 'WEB_PREFERENCES_INVALID'
  | 'WEB_PREFERENCES_CONFLICT'

export class WebPreferencesError extends Error {
  constructor(readonly code: WebPreferencesErrorCode, message: string) {
    super(message)
    this.name = 'WebPreferencesError'
  }
}

const ROOT_MODE = 0o700
const RECORD_MODE = 0o600
const PREFERENCE_KEYS = ['formatVersion', 'revision', 'web', 'insight', 'geminiSemantics'] as const
const WEB_KEYS = ['modelLabel', 'effortLabel'] as const
const INSIGHT_KEYS = [
  'formatVersion',
  'clarification',
  'plan',
  'research',
  'fallbackResearch',
  'critique',
  'polish',
  'fallbackPolish',
  'delivery',
  'researchWaitMs',
  'sizeLimits',
  'geminiQuotaFallback',
] as const
const STAGE_KEYS = ['requested', 'template'] as const
const SELECTION_KEYS = ['provider', 'modelId', 'modelLabel', 'effortLabel', 'modeLabel'] as const
const TEMPLATE_KEYS = ['formatVersion', 'id', 'version', 'text', 'hash'] as const
const CLARIFICATION_KEYS = ['requested', 'template', 'maxRounds', 'maxQuestionsPerRound'] as const
const DELIVERY_KEYS = ['template', 'language', 'style'] as const
const SIZE_LIMIT_KEYS = ['maxRenderedInputBytes', 'maxArtifactBytes'] as const
const LABEL_LIMIT_BYTES = 120
const SEMANTIC_TEXT_MAX_BYTES = 16 * 1024
const GEMINI_SEMANTIC_KEYS = [
  'submitSelector',
  'promptReceiptSelector',
  'planReadyMarker',
  'researchStartSelector',
  'researchReportReadyMarker',
  'researchActivitySelector',
  'visibleQuota',
  'thinking',
] as const
const GEMINI_QUOTA_KEYS = ['selector', 'requiredText', 'scope'] as const
const GEMINI_THINKING_KEYS = ['triggerSelector', 'optionSelector', 'selectedSelector'] as const

type JsonRecord = Record<string, unknown>

function preferencesError(code: WebPreferencesErrorCode, message: string): WebPreferencesError {
  return new WebPreferencesError(code, message)
}

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertKeys(value: JsonRecord, allowed: readonly string[], field: string): void {
  const accepted = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw preferencesError('WEB_PREFERENCES_INVALID', `${field}.${key} is not a supported preference field.`)
  }
}

function assertNonEmptyString(value: unknown, field: string, maxBytes = WEB_PREFERENCES_MAX_TEXT_BYTES): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must be a non-empty string.`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw preferencesError('WEB_PREFERENCES_INVALID', `${field} exceeds the ${maxBytes}-byte limit.`)
}

function assertString(value: unknown, field: string, maxBytes = WEB_PREFERENCES_MAX_TEXT_BYTES): asserts value is string {
  if (typeof value !== 'string') throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must be a string.`)
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw preferencesError('WEB_PREFERENCES_INVALID', `${field} exceeds the ${maxBytes}-byte limit.`)
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must be a safe integer >= ${minimum}.`)
  }
}

function assertJson(value: unknown, field: string): void {
  try {
    const text = stableInsightJson(value)
    if (Buffer.byteLength(text, 'utf8') > WEB_PREFERENCES_MAX_JSON_BYTES) {
      throw preferencesError('WEB_PREFERENCES_INVALID', `${field} exceeds the ${WEB_PREFERENCES_MAX_JSON_BYTES}-byte JSON limit.`)
    }
  } catch (error) {
    if (error instanceof WebPreferencesError) throw error
    throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must contain only JSON values.`)
  }
}

function clone<T>(value: T): T {
  return cloneInsight(value)
}

function normalizeTemplate(value: unknown, field: string): InsightTemplate {
  if (!isObject(value)) throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must be an object.`)
  assertKeys(value, TEMPLATE_KEYS, field)
  if (value.formatVersion !== 1) throw preferencesError('WEB_PREFERENCES_VERSION', `${field}.formatVersion is unsupported.`)
  assertNonEmptyString(value.id, `${field}.id`, LABEL_LIMIT_BYTES)
  assertNonEmptyString(value.version, `${field}.version`, LABEL_LIMIT_BYTES)
  assertString(value.text, `${field}.text`)
  // The submitted hash is deliberately ignored.  The durable value is always
  // rebuilt from the supplied text while retaining the template identity.
  return versionedTemplate(value.id, value.version, value.text)
}

function normalizeSelection(value: unknown, field: string): JsonRecord {
  if (!isObject(value)) throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must be an object.`)
  assertKeys(value, SELECTION_KEYS, field)
  if (value.provider !== 'codex' && value.provider !== 'gemini' && value.provider !== 'chatgpt') throw preferencesError('WEB_PREFERENCES_INVALID', `${field}.provider is unsupported.`)
  assertNonEmptyString(value.modelLabel, `${field}.modelLabel`, LABEL_LIMIT_BYTES)
  for (const key of ['modelId', 'effortLabel', 'modeLabel'] as const) {
    if (hasOwn(value, key) && value[key] !== undefined) assertNonEmptyString(value[key], `${field}.${key}`, LABEL_LIMIT_BYTES)
  }
  return value
}

function normalizeStage(value: unknown, field: string, keys: readonly string[] = STAGE_KEYS): InsightStageConfig {
  if (!isObject(value)) throw preferencesError('WEB_PREFERENCES_INVALID', `${field} must be an object.`)
  assertKeys(value, keys, field)
  normalizeSelection(value.requested, `${field}.requested`)
  const template = normalizeTemplate(value.template, `${field}.template`)
  return { requested: value.requested as InsightStageConfig['requested'], template }
}

function normalizeInsight(value: unknown): InsightConfigV1 {
  assertJson(value, 'insight')
  if (!isObject(value)) throw preferencesError('WEB_PREFERENCES_INVALID', 'insight must be an object.')
  assertKeys(value, INSIGHT_KEYS, 'insight')
  if (value.formatVersion !== 1) throw preferencesError('WEB_PREFERENCES_VERSION', 'insight.formatVersion is unsupported.')

  const clarificationValue = value.clarification
  if (!isObject(clarificationValue)) throw preferencesError('WEB_PREFERENCES_INVALID', 'insight.clarification must be an object.')
  assertKeys(clarificationValue, CLARIFICATION_KEYS, 'insight.clarification')
  const clarification = normalizeStage(clarificationValue, 'insight.clarification', CLARIFICATION_KEYS) as InsightConfigV1['clarification']
  assertSafeInteger(clarificationValue.maxRounds, 'insight.clarification.maxRounds', 1)
  assertSafeInteger(clarificationValue.maxQuestionsPerRound, 'insight.clarification.maxQuestionsPerRound', 1)

  const normalized: JsonRecord = {
    formatVersion: 1,
    clarification: {
      ...clarification,
      maxRounds: clarificationValue.maxRounds,
      maxQuestionsPerRound: clarificationValue.maxQuestionsPerRound,
    },
  }
  for (const field of ['plan', 'research', 'fallbackResearch', 'critique', 'polish', 'fallbackPolish'] as const) {
    normalized[field] = normalizeStage(value[field], `insight.${field}`)
  }

  if (!isObject(value.delivery)) throw preferencesError('WEB_PREFERENCES_INVALID', 'insight.delivery must be an object.')
  assertKeys(value.delivery, DELIVERY_KEYS, 'insight.delivery')
  normalized.delivery = {
    template: normalizeTemplate(value.delivery.template, 'insight.delivery.template'),
    language: value.delivery.language,
    style: value.delivery.style,
  }
  assertNonEmptyString(value.delivery.language, 'insight.delivery.language')
  assertNonEmptyString(value.delivery.style, 'insight.delivery.style')

  assertSafeInteger(value.researchWaitMs, 'insight.researchWaitMs', 1)
  if (!isObject(value.sizeLimits)) throw preferencesError('WEB_PREFERENCES_INVALID', 'insight.sizeLimits must be an object.')
  assertKeys(value.sizeLimits, SIZE_LIMIT_KEYS, 'insight.sizeLimits')
  assertSafeInteger(value.sizeLimits.maxRenderedInputBytes, 'insight.sizeLimits.maxRenderedInputBytes', 1)
  assertSafeInteger(value.sizeLimits.maxArtifactBytes, 'insight.sizeLimits.maxArtifactBytes', 1)
  if (value.geminiQuotaFallback !== 'GPT-6 Astra Pro Web search and analysis') throw preferencesError('WEB_PREFERENCES_INVALID', 'insight.geminiQuotaFallback is fixed by the contract.')
  normalized.researchWaitMs = value.researchWaitMs
  normalized.sizeLimits = {
    maxRenderedInputBytes: value.sizeLimits.maxRenderedInputBytes,
    maxArtifactBytes: value.sizeLimits.maxArtifactBytes,
  }
  normalized.geminiQuotaFallback = value.geminiQuotaFallback

  try {
    assertInsightConfig(normalized)
  } catch (error) {
    throw preferencesError('WEB_PREFERENCES_INVALID', error instanceof Error ? error.message : 'Insight configuration is invalid.')
  }
  return normalized as unknown as InsightConfigV1
}

function normalizeGeminiSemantics(value: unknown): GeminiSemanticSelectors {
  if (!isObject(value)) throw preferencesError('WEB_PREFERENCES_INVALID', 'geminiSemantics must be an object.')
  assertKeys(value, GEMINI_SEMANTIC_KEYS, 'geminiSemantics')
  const normalized: JsonRecord = {}
  for (const key of ['submitSelector', 'promptReceiptSelector', 'planReadyMarker', 'researchStartSelector', 'researchReportReadyMarker', 'researchActivitySelector'] as const) {
    if (hasOwn(value, key) && value[key] !== undefined) {
      assertNonEmptyString(value[key], `geminiSemantics.${key}`, SEMANTIC_TEXT_MAX_BYTES)
      normalized[key] = value[key]
    }
  }
  if (hasOwn(value, 'visibleQuota') && value.visibleQuota !== undefined) {
    if (!isObject(value.visibleQuota)) throw preferencesError('WEB_PREFERENCES_INVALID', 'geminiSemantics.visibleQuota must be an object.')
    assertKeys(value.visibleQuota, GEMINI_QUOTA_KEYS, 'geminiSemantics.visibleQuota')
    assertNonEmptyString(value.visibleQuota.selector, 'geminiSemantics.visibleQuota.selector', SEMANTIC_TEXT_MAX_BYTES)
    assertNonEmptyString(value.visibleQuota.requiredText, 'geminiSemantics.visibleQuota.requiredText', SEMANTIC_TEXT_MAX_BYTES)
    if (value.visibleQuota.scope !== 'Deep Research') throw preferencesError('WEB_PREFERENCES_INVALID', 'geminiSemantics.visibleQuota.scope must be Deep Research.')
    normalized.visibleQuota = {
      selector: value.visibleQuota.selector,
      requiredText: value.visibleQuota.requiredText,
      scope: value.visibleQuota.scope,
    } satisfies GeminiVisibleQuotaSelector
  }
  if (hasOwn(value, 'thinking') && value.thinking !== undefined) {
    if (!isObject(value.thinking)) throw preferencesError('WEB_PREFERENCES_INVALID', 'geminiSemantics.thinking must be an object.')
    assertKeys(value.thinking, GEMINI_THINKING_KEYS, 'geminiSemantics.thinking')
    const triggerSelector = value.thinking.triggerSelector
    const optionSelector = value.thinking.optionSelector
    const selectedSelector = value.thinking.selectedSelector
    assertNonEmptyString(triggerSelector, 'geminiSemantics.thinking.triggerSelector', SEMANTIC_TEXT_MAX_BYTES)
    assertNonEmptyString(optionSelector, 'geminiSemantics.thinking.optionSelector', SEMANTIC_TEXT_MAX_BYTES)
    assertNonEmptyString(selectedSelector, 'geminiSemantics.thinking.selectedSelector', SEMANTIC_TEXT_MAX_BYTES)
    normalized.thinking = {
      triggerSelector,
      optionSelector,
      selectedSelector,
    } satisfies GeminiThinkingSelectors
  }
  return normalized as GeminiSemanticSelectors
}

function normalizePreferences(value: unknown): WebPreferences {
  assertJson(value, 'preferences')
  if (!isObject(value)) throw preferencesError('WEB_PREFERENCES_INVALID', 'preferences must be an object.')
  assertKeys(value, PREFERENCE_KEYS, 'preferences')
  if (value.formatVersion !== WEB_PREFERENCES_FORMAT_VERSION) throw preferencesError('WEB_PREFERENCES_VERSION', 'preferences.formatVersion is unsupported.')
  assertSafeInteger(value.revision, 'preferences.revision', 0)
  if (!isObject(value.web)) throw preferencesError('WEB_PREFERENCES_INVALID', 'preferences.web must be an object.')
  assertKeys(value.web, WEB_KEYS, 'preferences.web')
  assertString(value.web.modelLabel, 'preferences.web.modelLabel', LABEL_LIMIT_BYTES)
  assertString(value.web.effortLabel, 'preferences.web.effortLabel', LABEL_LIMIT_BYTES)
  return {
    formatVersion: 1,
    revision: value.revision,
    web: { modelLabel: value.web.modelLabel, effortLabel: value.web.effortLabel },
    insight: normalizeInsight(value.insight),
    ...(value.geminiSemantics === undefined ? {} : { geminiSemantics: normalizeGeminiSemantics(value.geminiSemantics) }),
  }
}

export function defaultWebPreferences(): WebPreferences {
  return {
    formatVersion: 1,
    revision: 0,
    web: { modelLabel: '', effortLabel: '' },
    insight: normalizeInsight(defaultInsightConfig()),
  }
}

export class PreferencesStore {
  readonly root: string
  private readonly initial: WebPreferences

  constructor(root: string, initial?: WebPreferences) {
    if (typeof root !== 'string' || !isAbsolute(root) || root === parse(root).root) throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences root must be an absolute non-root directory.')
    this.root = root
    this.initial = normalizePreferences(initial ?? defaultWebPreferences())
  }

  async read(): Promise<WebPreferences> {
    let text: string
    try {
      text = await readFile(this.path(), 'utf8')
    } catch (error) {
      if (this.isErrno(error, 'ENOENT')) return clone(this.initial)
      throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences file could not be read.')
    }
    if (Buffer.byteLength(text, 'utf8') > WEB_PREFERENCES_MAX_JSON_BYTES) throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences file exceeds the JSON size limit.')
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch {
      throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences file is not valid JSON.')
    }
    return clone(normalizePreferences(parsed))
  }

  async save(value: WebPreferences, expectedRevision: number): Promise<WebPreferences> {
    assertSafeInteger(expectedRevision, 'expectedRevision', 0)
    await this.ensureRoot()
    const lockPath = `${this.path()}.lock`
    let lock: Awaited<ReturnType<typeof open>> | undefined
    let lockOwned = false
    try {
      try {
        lock = await open(lockPath, 'wx', RECORD_MODE)
        lockOwned = true
      } catch (error) {
        if (this.isErrno(error, 'EEXIST')) throw preferencesError('WEB_PREFERENCES_CONFLICT', 'Preferences are being saved by another request.')
        throw error
      }
      const current = await this.read()
      if (current.revision !== expectedRevision) throw preferencesError('WEB_PREFERENCES_CONFLICT', 'Preferences changed concurrently; reload before saving.')
      const candidate = normalizePreferences(value)
      if (candidate.revision !== expectedRevision) throw preferencesError('WEB_PREFERENCES_CONFLICT', 'The submitted preference revision does not match expectedRevision.')
      const next = { ...candidate, revision: expectedRevision + 1 } satisfies WebPreferences
      await this.write(next)
      return clone(next)
    } catch (error) {
      if (error instanceof WebPreferencesError) throw error
      throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences could not be saved.')
    } finally {
      if (lock) {
        try { await lock.close() } catch { /* best effort */ }
      }
      if (lockOwned) {
        try { await unlink(lockPath) } catch { /* no stale cleanup error may mask the result */ }
      }
    }
  }

  private path(): string { return join(this.root, WEB_PREFERENCES_FILE) }

  private async ensureRoot(): Promise<void> {
    try {
      await mkdir(this.root, { recursive: true, mode: ROOT_MODE })
      await chmod(this.root, ROOT_MODE)
    } catch {
      throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences directory is not available.')
    }
  }

  private async write(value: WebPreferences): Promise<void> {
    const target = this.path()
    const temporary = `${target}.${randomUUID()}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, 'wx', RECORD_MODE)
      await handle.writeFile(JSON.stringify(value) + '\n', 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, target)
      await chmod(target, RECORD_MODE)
    } catch {
      throw preferencesError('WEB_PREFERENCES_INVALID', 'Preferences file could not be published atomically.')
    } finally {
      if (handle) {
        try { await handle.close() } catch { /* already closed */ }
      }
      try { await unlink(temporary) } catch { /* temporary may have been renamed */ }
    }
  }

  private isErrno(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
  }
}

const saveSchema = z.strictObject({ expectedRevision: z.number().int().nonnegative(), value: z.unknown() })

export class PreferencesControl extends TypertRemoteService {
  constructor(ctx: Context, readonly store: PreferencesStore) { super(ctx, 'solarWebPreferences') }

  private owner(): void {
    if (this.ctx.invocation !== undefined && this.ctx.invocation.peer.principal.kind !== 'owner') {
      throw new Error('LOCAL_OWNER_REQUIRED: 网页和洞察设置仅允许本机所有者操作。')
    }
  }

  @Remote
  async read(): Promise<WebPreferences> {
    this.owner()
    return this.store.read()
  }

  @Remote
  async save(input: WebPreferencesSaveInput): Promise<WebPreferences> {
    this.owner()
    const value = saveSchema.parse(input)
    return this.store.save(value.value as WebPreferences, value.expectedRevision)
  }
}

declare module '@deepseek-ai/cordis' { interface Context { solarWebPreferences: PreferencesControl } }
