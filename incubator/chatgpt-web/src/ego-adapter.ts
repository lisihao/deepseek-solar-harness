import { isAbsolute } from 'node:path'

import { inspectChatGptPage, type ChatGptPageObservation } from './page-observation.js'
import {
  WebBrowserError,
  type WebBrowserAdapter,
} from './browser-contract.js'
import type { WebModelCatalog, WebModelCatalogRefreshInput } from './model-catalog.js'
import { runEgoProcess } from './process.js'
import { EgoProcessError, type EgoProcessRequest, type EgoProcessResult } from './process-contract.js'
import type { WebRunRequest, WebRunResource } from './store.js'

export const EGO_FRAME_MARKER = '__DSH_SOLAR_CHATGPT_WEB_FRAME__:'

const CHATGPT_ORIGINS = new Set(['chatgpt.com', 'chat.openai.com'])
/** Exact fresh-page URL observed from an Ego-created TaskSpace page. */
const EGO_EMPTY_NEW_TAB_URL = 'chrome://new-tab-page/'
const MODEL_BUTTON_SELECTOR = 'button[aria-label="选择 ChatGPT 模型"]'
const MODEL_MENU_SELECTOR = '[role="menu"]'
const MODEL_VIEW_TOGGLE_SELECTOR = '[data-model-picker-view-toggle="true"][role="menuitem"]'
const MODEL_ADVANCED_VIEW_SELECTOR = '[data-model-picker-view="advanced"]'
const MODEL_SIMPLE_VIEW_SELECTOR = '[data-model-picker-view="simple"]'
const COMPOSER_TOOL_BUTTON_SELECTOR = 'button[aria-label="添加文件等内容"]'
const WEB_SEARCH_OPTION_SELECTOR = 'button[data-list-navigation-item="true"]:has-text("网页搜索")'
const COMPOSER_SELECTORS = [
  'div.ProseMirror[contenteditable="true"]',
  'textarea#prompt-textarea',
  'textarea[data-testid="prompt-textarea"]',
  '[data-testid="prompt-textarea"][contenteditable="true"]',
  '[role="textbox"][contenteditable="true"][data-testid="prompt-textarea"]',
].join(',')
const DEFAULT_STDOUT_MAX_BYTES = 512 * 1024
const DEFAULT_STDERR_MAX_BYTES = 32 * 1024
const STDERR_NOTICE_OVERHEAD_BYTES = 64 * 1024
/** Operational output bound, never a list of model or effort names. */
const MAX_CATALOG_CHOICES = 128
const EGO_NOTICE_PREFIX = '[ego-browser:notice]'
const OBSERVATION_KEYS = [
  'url',
  'loginRequired',
  'composerCount',
  'composerText',
  'hasAttachments',
  'userMessages',
  'userMessageCount',
  'assistantMessages',
  'generating',
  'modelLabel',
  'effortLabel',
  'effortId',
  'webSearchActive',
  'visibleError',
] as const

type JsonRecord = Record<string, unknown>

export interface EgoProcessRunner {
  (request: EgoProcessRequest): Promise<EgoProcessResult>
}

export interface EgoWebAdapterOptions {
  readonly executable: string
  readonly cwd: string
  readonly commandTimeoutMs: number
  readonly stdoutMaxBytes: number
  readonly spaceId?: number
  /** Allocate a fresh Page inside the configured TaskSpace instead of reusing p1. */
  readonly createPage?: boolean
  /** Retain the shared TaskSpace for the enclosing multi-stage flow. */
  readonly retainSpace?: boolean
}

type EgoOperation = 'create' | 'catalog' | 'prepare' | 'observe' | 'submit' | 'finish'

interface FrameSuccess {
  readonly ok: true
  readonly value: unknown
}

interface FrameFailure {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

type EgoFrame = FrameSuccess | FrameFailure

function browserError(code: string, message: string): WebBrowserError {
  return new WebBrowserError(code, message)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertExactKeys(value: JsonRecord, keys: readonly string[], code: string, message: string): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) throw browserError(code, message)
}

function assertNonEmptyString(value: unknown, code: string, message: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw browserError(code, message)
}

function isChatGptUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false
    const hostname = parsed.hostname.toLowerCase()
    return CHATGPT_ORIGINS.has(hostname) || [...CHATGPT_ORIGINS].some((origin) => hostname.endsWith(`.${origin}`))
  } catch {
    return false
  }
}

function assertResource(resource: WebRunResource): void {
  if (!isRecord(resource) || !Number.isSafeInteger(resource.spaceId) || resource.spaceId <= 0) {
    throw browserError('WEB_RESOURCE_INVALID', 'ChatGPT Web resource is invalid')
  }
  if (typeof resource.pageLabel !== 'string' || !/^p[1-9]\d*$/.test(resource.pageLabel)
    || !Number.isSafeInteger(Number(resource.pageLabel.slice(1)))) {
    throw browserError('WEB_RESOURCE_INVALID', 'ChatGPT Web page label is invalid')
  }
  if (resource.conversationUrl !== undefined && !isChatGptUrl(resource.conversationUrl)) {
    throw browserError('WEB_RESOURCE_INVALID', 'ChatGPT Web conversation URL is invalid')
  }
}

function assertRequest(request: WebRunRequest): void {
  if (!isRecord(request) || typeof request.prompt !== 'string') {
    throw browserError('WEB_REQUEST_INVALID', 'ChatGPT Web request is invalid')
  }
  if (request.modelLabel !== undefined && typeof request.modelLabel !== 'string') {
    throw browserError('WEB_REQUEST_INVALID', 'ChatGPT Web model label is invalid')
  }
  if (request.effortLabel !== undefined && typeof request.effortLabel !== 'string') {
    throw browserError('WEB_REQUEST_INVALID', 'ChatGPT Web effort label is invalid')
  }
  if (request.webSearch !== undefined && typeof request.webSearch !== 'boolean') {
    throw browserError('WEB_REQUEST_INVALID', 'ChatGPT Web search mode is invalid')
  }
}

function matchesRequestedEffort(observation: Pick<ChatGptPageObservation, 'effortLabel' | 'effortId'>, requested: string | undefined): boolean {
  return requested === undefined || observation.effortLabel === requested || observation.effortId === requested
}

function assertRequestedLabels(
  request: WebRunRequest,
  observation: ChatGptPageObservation,
  requireWebSearch = false,
): void {
  if (observation.modelLabel === undefined || observation.modelLabel.trim().length === 0) {
    throw browserError('WEB_MODEL_UNKNOWN', 'The observed ChatGPT model is unavailable')
  }
  if (requireWebSearch && request.webSearch === true && observation.webSearchActive !== true) {
    throw browserError('WEB_SEARCH_ACTIVE_REQUIRED', 'The observed ChatGPT webpage search mode is unavailable')
  }
  if (requireWebSearch && request.webSearch === true
    && (observation.effortLabel === undefined || observation.effortLabel.trim().length === 0)
    && (observation.effortId === undefined || observation.effortId.trim().length === 0)) {
    throw browserError('WEB_EFFORT_UNKNOWN', 'The observed ChatGPT reasoning effort is unavailable')
  }
  if (request.modelLabel !== undefined && observation.modelLabel !== request.modelLabel) {
    throw browserError('WEB_MODEL_MISMATCH', 'The observed model label does not match the request')
  }
  if (!matchesRequestedEffort(observation, request.effortLabel)) {
    throw browserError('WEB_EFFORT_MISMATCH', 'The observed reasoning label does not match the request')
  }
}

function assertObservation(value: unknown): ChatGptPageObservation {
  if (!isRecord(value)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid observation')
  assertExactKeys(value, OBSERVATION_KEYS, 'WEB_EGO_FRAME', 'Ego browser returned an invalid observation shape')
  if (typeof value.url !== 'string' || !isChatGptUrl(value.url)) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid page URL')
  }
  if (typeof value.loginRequired !== 'boolean'
    || typeof value.composerCount !== 'number' || !Number.isSafeInteger(value.composerCount) || value.composerCount < 0
    || typeof value.composerText !== 'string'
    || typeof value.hasAttachments !== 'boolean'
    || !Array.isArray(value.userMessages) || value.userMessages.some((message) => typeof message !== 'string')
    || typeof value.userMessageCount !== 'number' || !Number.isSafeInteger(value.userMessageCount) || value.userMessageCount < 0
    || value.userMessages.length !== value.userMessageCount
    || !Array.isArray(value.assistantMessages)
    || typeof value.generating !== 'boolean') {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid observation')
  }
  for (const message of value.assistantMessages) {
    if (!isRecord(message)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid assistant message')
    assertExactKeys(message, ['text', 'markdown'], 'WEB_EGO_FRAME', 'Ego browser returned an invalid assistant message shape')
    if (typeof message.text !== 'string' || typeof message.markdown !== 'string') {
      throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid assistant message')
    }
  }
  for (const key of ['modelLabel', 'effortLabel', 'effortId', 'visibleError'] as const) {
    if (hasOwn(value, key) && value[key] !== undefined && typeof value[key] !== 'string') {
      throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid optional observation field')
    }
  }
  if (hasOwn(value, 'webSearchActive') && value.webSearchActive !== undefined && typeof value.webSearchActive !== 'boolean') {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid optional observation field')
  }
  return value as unknown as ChatGptPageObservation
}

function assertCatalogInput(value: WebModelCatalogRefreshInput): void {
  if (!isRecord(value)) throw browserError('WEB_CATALOG_INVALID', 'ChatGPT model catalog input is invalid')
  assertExactKeys(value, ['modelLabel'], 'WEB_CATALOG_INVALID', 'ChatGPT model catalog input is invalid')
  if (value.modelLabel !== undefined && (typeof value.modelLabel !== 'string' || value.modelLabel.length > 120)) {
    throw browserError('WEB_CATALOG_INVALID', 'ChatGPT model catalog model label is invalid')
  }
}

function assertCatalogLabel(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    throw browserError('WEB_EGO_FRAME', message)
  }
}

function assertCatalogModelChoice(value: unknown): { readonly label: string; readonly available: boolean; readonly selected: boolean } {
  if (!isRecord(value)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog choice')
  assertExactKeys(value, ['label', 'available', 'selected'], 'WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog choice')
  assertCatalogLabel(value.label, 'Ego browser returned an invalid model catalog label')
  if (typeof value.available !== 'boolean' || typeof value.selected !== 'boolean') {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog choice')
  }
  return value as { readonly label: string; readonly available: boolean; readonly selected: boolean }
}

function assertCatalogEffortChoice(value: unknown): { readonly label: string; readonly id?: string; readonly index?: number; readonly available: boolean; readonly selected: boolean } {
  if (!isRecord(value)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid effort catalog choice')
  assertExactKeys(value, ['label', 'id', 'index', 'available', 'selected'], 'WEB_EGO_FRAME', 'Ego browser returned an invalid effort catalog choice')
  assertCatalogLabel(value.label, 'Ego browser returned an invalid effort catalog label')
  if (hasOwn(value, 'id') && value.id !== undefined) assertCatalogLabel(value.id, 'Ego browser returned an invalid effort catalog identifier')
  if (hasOwn(value, 'index') && value.index !== undefined && (!Number.isSafeInteger(value.index) || typeof value.index !== 'number')) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid effort catalog index')
  }
  if (typeof value.available !== 'boolean' || typeof value.selected !== 'boolean') {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid effort catalog choice')
  }
  return value as { readonly label: string; readonly id?: string; readonly index?: number; readonly available: boolean; readonly selected: boolean }
}

function assertModelCatalog(value: unknown, resource: WebRunResource): WebModelCatalog {
  if (!isRecord(value)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog')
  assertExactKeys(value, ['formatVersion', 'observedAt', 'browser', 'models', 'effortModelLabel', 'efforts', 'selected'], 'WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog shape')
  if (value.formatVersion !== 1 || typeof value.observedAt !== 'string' || value.observedAt.length > 64 || Number.isNaN(Date.parse(value.observedAt))) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog header')
  }
  if (!isRecord(value.browser)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog browser')
  assertExactKeys(value.browser, ['kind', 'spaceId', 'pageLabel'], 'WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog browser')
  if (value.browser.kind !== 'ego-lite' || value.browser.spaceId !== resource.spaceId || value.browser.pageLabel !== resource.pageLabel) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned a model catalog for another target page')
  }
  if (!Array.isArray(value.models) || value.models.length === 0 || value.models.length > MAX_CATALOG_CHOICES) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid model catalog choices list')
  }
  const models = value.models.map(assertCatalogModelChoice)
  if (new Set(models.map((choice) => choice.label)).size !== models.length || models.filter((choice) => choice.selected).length !== 1) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an ambiguous model catalog')
  }
  assertCatalogLabel(value.effortModelLabel, 'Ego browser returned an invalid effort model label')
  if (!models.some((choice) => choice.label === value.effortModelLabel)) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an effort catalog for an unknown model')
  }
  if (!Array.isArray(value.efforts) || value.efforts.length > MAX_CATALOG_CHOICES) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid effort catalog choices list')
  }
  const efforts = value.efforts.map(assertCatalogEffortChoice)
  if (new Set(efforts.map((choice) => `${choice.index ?? ''}\u0000${choice.id ?? ''}\u0000${choice.label}`)).size !== efforts.length
    || (efforts.length > 0 && efforts.filter((choice) => choice.selected).length !== 1)) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an ambiguous effort catalog')
  }
  if (!isRecord(value.selected)) throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid selected catalog value')
  const selected = value.selected
  assertExactKeys(selected, ['modelLabel', 'effortLabel', 'effortId'], 'WEB_EGO_FRAME', 'Ego browser returned an invalid selected catalog value')
  assertCatalogLabel(selected.modelLabel, 'Ego browser returned an invalid selected model label')
  if (!models.some((choice) => choice.label === selected.modelLabel && choice.selected)) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser returned an inconsistent selected model')
  }
  if (hasOwn(selected, 'effortLabel') && selected.effortLabel !== undefined) {
    assertCatalogLabel(selected.effortLabel, 'Ego browser returned an invalid selected effort label')
  }
  if (hasOwn(selected, 'effortId') && selected.effortId !== undefined) {
    assertCatalogLabel(selected.effortId, 'Ego browser returned an invalid selected effort identifier')
  }
  if (selected.modelLabel === value.effortModelLabel) {
    const selectedEffort = efforts.find((choice) => choice.selected)
    if ((selectedEffort === undefined && (selected.effortLabel !== undefined || selected.effortId !== undefined))
      || (selectedEffort !== undefined && (selected.effortLabel !== selectedEffort.label
        || (selectedEffort.id !== undefined && selected.effortId !== selectedEffort.id)))) {
      throw browserError('WEB_EGO_FRAME', 'Ego browser returned an inconsistent selected effort')
    }
  }
  return value as unknown as WebModelCatalog
}

function decodeFrame(stdout: string, maxBytes = DEFAULT_STDOUT_MAX_BYTES): EgoFrame {
  if (typeof stdout !== 'string') throw browserError('WEB_EGO_FRAME', 'Ego browser stdout is invalid')
  if (Buffer.byteLength(stdout, 'utf8') > maxBytes) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser frame exceeds its bound')
  }
  const withoutTrailingNewline = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
  if (withoutTrailingNewline.length === 0 || withoutTrailingNewline.includes('\n') || !withoutTrailingNewline.startsWith(EGO_FRAME_MARKER)) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser emitted unexpected stdout')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(withoutTrailingNewline.slice(EGO_FRAME_MARKER.length)) as unknown
  } catch {
    throw browserError('WEB_EGO_FRAME', 'Ego browser emitted malformed JSON')
  }
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') {
    throw browserError('WEB_EGO_FRAME', 'Ego browser emitted an invalid frame')
  }
  if (parsed.ok) {
    assertExactKeys(parsed, ['ok', 'value'], 'WEB_EGO_FRAME', 'Ego browser emitted an invalid success frame')
    if (!hasOwn(parsed, 'value')) throw browserError('WEB_EGO_FRAME', 'Ego browser success frame has no value')
    return { ok: true, value: parsed.value }
  }
  assertExactKeys(parsed, ['ok', 'error'], 'WEB_EGO_FRAME', 'Ego browser emitted an invalid error frame')
  if (!isRecord(parsed.error)) throw browserError('WEB_EGO_FRAME', 'Ego browser error frame is invalid')
  assertExactKeys(parsed.error, ['code', 'message'], 'WEB_EGO_FRAME', 'Ego browser error frame is invalid')
  if (typeof parsed.error.code !== 'string' || parsed.error.code.length === 0
    || typeof parsed.error.message !== 'string' || parsed.error.message.length === 0) {
    throw browserError('WEB_EGO_FRAME', 'Ego browser error frame is invalid')
  }
  return { ok: false, error: parsed.error as { code: string; message: string } }
}

function decodeTransportFrame(
  stdout: string,
  stderr: string,
  maxBytes = DEFAULT_STDOUT_MAX_BYTES,
): { readonly frame: EgoFrame; readonly notices: readonly string[] } {
  const frames: string[] = []
  const notices: string[] = []
  for (const channel of [stdout, stderr]) {
    if (typeof channel !== 'string') throw browserError('WEB_EGO_FRAME', 'Ego browser transport output is invalid')
    for (const rawLine of channel.split(/\r?\n/)) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.trim().length === 0) continue
      if (line.startsWith(EGO_FRAME_MARKER)) {
        frames.push(line)
      } else if (line.startsWith(EGO_NOTICE_PREFIX)) {
        notices.push(line.slice(EGO_NOTICE_PREFIX.length).trim())
      } else {
        throw browserError('WEB_EGO_FRAME', 'Ego browser emitted unexpected transport output')
      }
    }
  }
  if (frames.length !== 1) throw browserError('WEB_EGO_FRAME', 'Ego browser emitted an invalid frame count')
  return { frame: decodeFrame(frames[0]!, maxBytes), notices }
}

function scriptRuntime(): string {
  return `
const __frameMarker = ${JSON.stringify(EGO_FRAME_MARKER)};
const __emit = (value) => process.stdout.write(__frameMarker + JSON.stringify(value) + "\\n");
const __publicError = Symbol("solar-public-error");
const __throw = (code, message) => { const error = new Error(message); error.code = code; error[__publicError] = true; throw error; };
const __fail = (error) => {
  const code = error && typeof error.code === "string" ? error.code : "WEB_EGO_SCRIPT";
  const safeCode = /^(?:WEB|EGO)_[A-Z0-9_]+$/.test(code);
  const message = error && error[__publicError] === true && safeCode && typeof error.message === "string"
    ? error.message
    : "Ego browser command failed";
  __emit({ ok: false, error: { code, message } });
};
const __assertAgent = (task) => {
  if (!task || task.ownership !== "agent") __throw("WEB_USER_CONTROL", "TaskSpace is not agent-owned");
};
`
}

function modelMenuSource(): string {
  return `
const __closeModelMenu = async () => {
  let __menuVisible = false;
  try {
    __menuVisible = await __page.evaluate((selector) => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      return Array.from(document.querySelectorAll(selector)).some(visible);
    }, ${JSON.stringify(MODEL_MENU_SELECTOR)});
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu state could not be read");
  }
  if (!__menuVisible) return;
  try {
    await __page.press(${JSON.stringify(MODEL_BUTTON_SELECTOR)}, "Escape", { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu could not be closed");
  }
  try {
    await __page.waitForFunction((selector) => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (buttons.length !== 1 || buttons[0].getAttribute("aria-expanded") !== "false") return false;
      return !Array.from(document.querySelectorAll(${JSON.stringify(MODEL_MENU_SELECTOR)})).some(visible);
    }, ${JSON.stringify(MODEL_BUTTON_SELECTOR)}, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu close was not confirmed");
  }
};

const __modelViewState = async () => __page.evaluate(() => {
  const visible = (element) => {
    for (let current = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      if (style.display !== "contents" && current.getClientRects().length === 0) return false;
    }
    return true;
  };
  const advanced = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)})).some(visible);
  const simple = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_SIMPLE_VIEW_SELECTOR)})).some(visible);
  const toggle = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_VIEW_TOGGLE_SELECTOR)})).some((element) => visible(element)
    && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true"
    && (!("disabled" in element) || !element.disabled));
  return { advanced, simple, toggle };
});

const __waitForModelViewToggle = async () => {
  try {
    await __page.waitForFunction(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const enabled = (element) => !element.hasAttribute("disabled")
        && element.getAttribute("aria-disabled") !== "true"
        && (!("disabled" in element) || !element.disabled);
      return Array.from(document.querySelectorAll(${JSON.stringify(MODEL_VIEW_TOGGLE_SELECTOR)}))
        .filter((element) => visible(element) && enabled(element)).length === 1;
    }, undefined, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model view toggle is unavailable");
  }
};

const __waitForModelButton = async () => {
  try {
    await __page.waitForFunction((selector) => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (buttons.length !== 1) return false;
      const expanded = buttons[0].getAttribute("aria-expanded");
      return expanded === "true" || expanded === "false";
    }, ${JSON.stringify(MODEL_BUTTON_SELECTOR)}, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model control is unavailable");
  }
};

const __waitForModelView = async () => {
  try {
    await __page.waitForFunction(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      return Array.from(document.querySelectorAll(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)})).some(visible)
        || Array.from(document.querySelectorAll(${JSON.stringify(MODEL_SIMPLE_VIEW_SELECTOR)})).some(visible);
    }, undefined, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu view is unavailable");
  }
};

const __waitForCheckedModel = async () => {
  try {
    await __page.waitForFunction(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      return Array.from(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]'))
        .filter((element) => element.closest(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)}) !== null)
        .filter(visible).length === 1;
    }, undefined, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu has no checked model");
  }
};

const __waitForRequestedModel = async (requestedLabel) => {
  try {
    await __page.waitForFunction((label) => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const enabled = (element) => {
        if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
        return !("disabled" in element) || !element.disabled;
      };
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const matches = Array.from(document.querySelectorAll('[role="menuitemradio"][aria-checked="true"]'))
        .filter((element) => element.closest(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)}) !== null)
        .filter((element) => visible(element) && enabled(element))
        .filter((element) => [element.getAttribute("data-model-label"), element.getAttribute("data-model-name"), element.getAttribute("aria-label"), element.innerText, element.textContent]
          .map(normalize).filter((value) => value.length > 0).includes(label));
      return matches.length === 1;
    }, requestedLabel, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_SELECTION_UNAVAILABLE", "Requested ChatGPT model selection was not confirmed");
  }
};

const __waitForModelSelectionSettled = async () => {
  try {
    await __page.waitForFunction((selector) => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (buttons.length !== 1) return false;
      const expanded = buttons[0].getAttribute("aria-expanded");
      const menuVisible = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_MENU_SELECTOR)})).some(visible);
      if (expanded === "false") return !menuVisible;
      if (expanded !== "true" || !menuVisible) return false;
      const advancedVisible = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)})).some(visible);
      const simpleVisible = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_SIMPLE_VIEW_SELECTOR)})).some(visible);
      return simpleVisible && !advancedVisible;
    }, ${JSON.stringify(MODEL_BUTTON_SELECTOR)}, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_MODEL_SELECTION_UNAVAILABLE", "Requested ChatGPT model transition was not confirmed");
  }
};

const __openModelMenu = async (requestedView, __reopened = false) => {
  await __waitForModelButton();
  const __buttonState = await __page.evaluate((selector) => {
    const visible = (element) => {
      for (let current = element; current !== null; current = current.parentElement) {
        if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
        if (style.display !== "contents" && current.getClientRects().length === 0) return false;
      }
      return true;
    };
    const buttons = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (buttons.length !== 1) return null;
    const expanded = buttons[0].getAttribute("aria-expanded");
    if (expanded !== "true" && expanded !== "false") return null;
    return { expanded };
  }, ${JSON.stringify(MODEL_BUTTON_SELECTOR)});
  if (!__buttonState) __throw("WEB_MODEL_UNKNOWN", "ChatGPT model control is unavailable");
  if (__buttonState.expanded === "false") {
    try {
      await __page.click(${JSON.stringify(MODEL_BUTTON_SELECTOR)}, { timeout: __input.timeoutMs, label: "open ChatGPT model menu" });
    } catch {
      __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu could not be opened");
    }
  }
  try {
    await __page.waitForSelector(${JSON.stringify(MODEL_MENU_SELECTOR)}, { state: "visible", timeout: 5000 });
  } catch {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu is unavailable");
  }
  await __waitForModelView();
  let __viewState = await __modelViewState();
  if (!__viewState || (!__viewState.advanced && !__viewState.simple)) {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu view is unavailable");
  }
  if (requestedView === "simple" && !__viewState.simple && !__viewState.toggle && !__reopened) {
    await __closeModelMenu();
    return __openModelMenu(requestedView, true);
  }
  if ((requestedView === "advanced" && !__viewState.advanced)
    || (requestedView === "simple" && !__viewState.simple)) {
    if (!__viewState.toggle) {
      await __waitForModelViewToggle();
      __viewState = await __modelViewState();
    }
    if (!__viewState.toggle) __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu view cannot be changed");
    try {
      await __page.click(${JSON.stringify(MODEL_VIEW_TOGGLE_SELECTOR)}, { timeout: __input.timeoutMs, label: requestedView === "advanced" ? "open ChatGPT model choices" : "return to ChatGPT effort choices" });
      await __page.waitForSelector(requestedView === "advanced" ? ${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)} : ${JSON.stringify(MODEL_SIMPLE_VIEW_SELECTOR)}, { state: "visible", timeout: 5000 });
    } catch {
      __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu view could not be changed");
    }
  }
};

const __observeModelMenu = async () => {
  let __menuObservation;
  try {
    await __openModelMenu("advanced");
    await __waitForCheckedModel();
    __menuObservation = await __page.evaluate(__inspect);
    if (!__menuObservation || typeof __menuObservation.modelLabel !== "string" || __menuObservation.modelLabel.trim().length === 0) {
      __throw("WEB_MODEL_UNKNOWN", "ChatGPT model menu has no checked model");
    }
  } finally {
    await __closeModelMenu();
  }
  const __settledObservation = await __page.evaluate(__inspect);
  if (!__settledObservation) __throw("WEB_MODEL_UNKNOWN", "ChatGPT settled page could not be observed");
  return { ...__settledObservation, modelLabel: __menuObservation.modelLabel };
};

const __observeEffortMenu = async () => {
  try {
    await __openModelMenu("simple");
    return await __page.evaluate(__inspect);
  } finally {
    await __closeModelMenu();
  }
};

const __matchesRequestedEffort = (observation, requestedLabel) => requestedLabel === undefined
  || observation?.effortLabel === requestedLabel
  || observation?.effortId === requestedLabel;

const __cssPath = (element) => {
  const parts = [];
  let current = element;
  while (current && current.nodeType === 1 && current !== document.body) {
    const tag = current.tagName.toLowerCase();
    const parent = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(tag + ":nth-of-type(" + index + ")");
    current = parent;
  }
  return parts.join(" > ");
};

const __selectRequestedModel = async (requestedLabel) => {
  let __selectedObservation;
  try {
    await __openModelMenu("advanced");
    await __waitForCheckedModel();
    const __targetSelector = await __page.evaluate((label) => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const enabled = (element) => {
        if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
        return !("disabled" in element) || !element.disabled;
      };
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const radios = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        .filter((element) => element.closest(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)}) !== null)
        .filter((element) => visible(element) && enabled(element));
      const matches = radios.filter((element) => {
        const labels = [element.getAttribute("data-model-label"), element.getAttribute("data-model-name"), element.getAttribute("aria-label"), element.innerText, element.textContent]
          .map(normalize)
          .filter((value) => value.length > 0);
        return labels.includes(label);
      });
      if (matches.length !== 1) return null;
      const target = matches[0];
      const parts = [];
      let current = target;
      while (current && current.nodeType === 1 && current !== document.body) {
        const tag = current.tagName.toLowerCase();
        const parent = current.parentElement;
        if (!parent) { parts.unshift(tag); break; }
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
        current = parent;
      }
      return parts.join(" > ");
    }, requestedLabel);
    if (!__targetSelector) __throw("WEB_MODEL_SELECTION_UNAVAILABLE", "Requested ChatGPT model is not a unique visible enabled choice");
    try {
      await __page.click(__targetSelector, { timeout: __input.timeoutMs, label: "select requested ChatGPT model" });
    } catch {
      __throw("WEB_MODEL_SELECTION_UNAVAILABLE", "Requested ChatGPT model could not be selected");
    }
    // Selecting a model either closes the picker or switches it to the simple
    // effort view. Wait for one of those observable settled states before
    // reopening advanced; do not click the requested model again.
    await __waitForModelSelectionSettled();
    await __openModelMenu("advanced");
    await __waitForRequestedModel(requestedLabel);
    __selectedObservation = await __page.evaluate(__inspect);
  } finally {
    await __closeModelMenu();
  }
  const __settledObservation = await __page.evaluate(__inspect);
  if (!__selectedObservation || !__settledObservation) {
    __throw("WEB_MODEL_SELECTION_UNAVAILABLE", "Requested ChatGPT model selection could not be observed");
  }
  return { ...__settledObservation, modelLabel: __selectedObservation.modelLabel };
};

const __readModelChoices = async () => __page.evaluate(() => {
  const visible = (element) => {
    for (let current = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      if (style.display !== "contents" && current.getClientRects().length === 0) return false;
    }
    return true;
  };
  const enabled = (element) => !element.hasAttribute("disabled")
    && element.getAttribute("aria-disabled") !== "true"
    && (!("disabled" in element) || !element.disabled);
  const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
  const radios = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    .filter((element) => element.closest(${JSON.stringify(MODEL_ADVANCED_VIEW_SELECTOR)}) !== null)
    .filter(visible);
  if (radios.length === 0 || radios.length > ${MAX_CATALOG_CHOICES}) return null;
  const choices = radios.map((element) => {
    const label = [element.getAttribute("data-model-label"), element.getAttribute("data-model-name"), element.getAttribute("aria-label"), element.innerText, element.textContent]
      .map(normalize).find((value) => value.length > 0);
    if (!label) return null;
    return { label, available: enabled(element), selected: element.getAttribute("aria-checked") === "true" };
  });
  if (choices.some((choice) => choice === null)) return null;
  if (new Set(choices.map((choice) => choice.label)).size !== choices.length) return null;
  if (choices.filter((choice) => choice.selected).length !== 1) return null;
  return choices;
});

const __catalogModelChoices = async () => {
  try {
    await __openModelMenu("advanced");
    await __waitForCheckedModel();
    const choices = await __readModelChoices();
    if (!choices) __throw("WEB_MODEL_UNKNOWN", "ChatGPT model choices are unavailable or ambiguous");
    return choices;
  } finally {
    await __closeModelMenu();
  }
};

const __readEffortState = async () => __page.evaluate(() => {
  const visible = (element) => {
    for (let current = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      if (style.display !== "contents" && current.getClientRects().length === 0) return false;
    }
    return true;
  };
  const enabled = (element) => {
    if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
    return !("disabled" in element) || !element.disabled;
  };
  const wrappers = Array.from(document.querySelectorAll('[data-reasoning-slider="true"][role="menuitem"]'))
    .filter((element) => visible(element) && enabled(element));
  if (wrappers.length !== 1) return null;
  const shortcuts = wrappers[0].getAttribute("aria-keyshortcuts") || "";
  if (!/\\bArrowLeft\\b/.test(shortcuts) || !/\\bArrowRight\\b/.test(shortcuts)) return null;
  const slider = wrappers[0].querySelector('[role="slider"]');
  if (!slider) return null;
  const min = Number(slider.getAttribute("aria-valuemin"));
  const max = Number(slider.getAttribute("aria-valuemax"));
  const now = Number(slider.getAttribute("aria-valuenow"));
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || !Number.isSafeInteger(now)
    || min > max || max - min >= ${MAX_CATALOG_CHOICES} || now < min || now > max) return null;
  const buttons = Array.from(document.querySelectorAll(${JSON.stringify(MODEL_BUTTON_SELECTOR)})).filter(visible);
  if (buttons.length !== 1) return null;
  const rawId = (buttons[0].getAttribute("data-selected-reasoning-effort") || "").trim();
  const displayLabel = (slider.getAttribute("aria-valuetext")
    || buttons[0].getAttribute("data-reasoning-effort-label")
    || buttons[0].getAttribute("data-effort-label")
    || "").replace(/\\s+/g, " ").trim();
  const cssPath = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
      parts.unshift(tag + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")");
      current = parent;
    }
    return parts.join(" > ");
  };
  return {
    sliderSelector: cssPath(wrappers[0]), min, max, now,
    ...(rawId.length === 0 ? {} : { rawId }),
    ...(displayLabel.length === 0 ? {} : { displayLabel }),
  };
});

const __readEffortReading = async (state) => {
  const observation = await __page.evaluate(__inspect);
  const observedLabel = typeof observation?.effortLabel === "string" && observation.effortLabel.trim().length > 0
    ? observation.effortLabel
    : undefined;
  const observedId = typeof observation?.effortId === "string" && observation.effortId.trim().length > 0
    ? observation.effortId
    : undefined;
  const label = observedLabel ?? state.displayLabel ?? state.rawId;
  const id = observedId ?? state.rawId;
  return {
    ...(label === undefined ? {} : { label }),
    ...(id === undefined ? {} : { id }),
  };
};

const __hasVisibleEffortControl = async () => {
  try {
    return await __page.evaluate(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const wrappers = Array.from(document.querySelectorAll('[data-reasoning-slider="true"][role="menuitem"]'))
        .filter((element) => visible(element) && element.querySelector('[role="slider"]') !== null);
      return wrappers.length === 1;
    });
  } catch {
    return true;
  }
};

const __waitForEffortControl = async () => {
  try {
    await __page.waitForFunction(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const enabled = (element) => {
        if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") return false;
        return !("disabled" in element) || !element.disabled;
      };
      const wrappers = Array.from(document.querySelectorAll('[data-reasoning-slider="true"][role="menuitem"]'))
        .filter((element) => visible(element) && enabled(element));
      if (wrappers.length !== 1) return false;
      const slider = wrappers[0].querySelector('[role="slider"]');
      if (!slider) return false;
      const min = Number(slider.getAttribute("aria-valuemin"));
      const max = Number(slider.getAttribute("aria-valuemax"));
      const now = Number(slider.getAttribute("aria-valuenow"));
      return Number.isSafeInteger(min) && Number.isSafeInteger(max) && Number.isSafeInteger(now)
        && min <= max && max - min < ${MAX_CATALOG_CHOICES} && now >= min && now <= max;
    }, undefined, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider is unavailable");
  }
};

const __waitEffortIndex = async (sliderSelector, expectedIndex) => {
  try {
    await __page.waitForFunction((input) => {
      const wrapper = document.querySelector(input.selector);
      const slider = wrapper && wrapper.querySelector('[role="slider"]');
      return slider !== null && slider.getAttribute("aria-valuenow") === String(input.expectedIndex);
    }, { selector: sliderSelector, expectedIndex }, { timeout: __input.timeoutMs });
    return true;
  } catch {
    return false;
  }
};

const __restoreEffortIndex = async (sliderSelector, targetIndex) => {
  let __state = await __readEffortState();
  if (!__state) return false;
  for (let __step = 0; __step < ${MAX_CATALOG_CHOICES} && __state.now !== targetIndex; __step += 1) {
    const __key = __state.now > targetIndex ? "ArrowLeft" : "ArrowRight";
    const __expectedIndex = __state.now + (__key === "ArrowLeft" ? -1 : 1);
    await __page.press(sliderSelector, __key, { timeout: __input.timeoutMs });
    if (!await __waitEffortIndex(sliderSelector, __expectedIndex)) return false;
    __state = await __readEffortState();
    if (!__state) return false;
  }
  return __state.now === targetIndex;
};

const __selectRequestedEffort = async (requestedLabel) => {
  let __originalState;
  try {
    await __openModelMenu("simple");
    await __waitForEffortControl();
    __originalState = await __readEffortState();
    if (!__originalState) __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider is unavailable");
    let __state = __originalState;
    if (!await __restoreEffortIndex(__state.sliderSelector, __state.min)) {
      __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider could not reach its minimum");
    }
    __state = await __readEffortState();
    if (!__state) __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider disappeared");
    let __found = false;
    for (let __step = 0; __step <= __state.max - __state.min; __step += 1) {
      const __reading = await __readEffortReading(__state);
      if (__matchesRequestedEffort({ effortLabel: __reading.label, effortId: __reading.id }, requestedLabel)) {
        __found = true;
        break;
      }
      if (__state.now >= __state.max) break;
      const __expectedIndex = __state.now + 1;
      await __page.press(__state.sliderSelector, "ArrowRight", { timeout: __input.timeoutMs });
      if (!await __waitEffortIndex(__state.sliderSelector, __expectedIndex)) break;
      __state = await __readEffortState();
      if (!__state) break;
    }
    if (!__found) {
      let __restored = false;
      try { __restored = await __restoreEffortIndex(__state?.sliderSelector ?? __originalState.sliderSelector, __originalState.now); } catch { /* report below */ }
      if (!__restored) __throw("WEB_SELECTION_RESTORE_FAILED", "ChatGPT reasoning effort restoration could not be confirmed");
      __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "Requested ChatGPT reasoning effort is unavailable");
    }
  } catch (__error) {
    if (__originalState) {
      let __restored = false;
      try { __restored = await __restoreEffortIndex(__originalState.sliderSelector, __originalState.now); } catch { /* report below */ }
      if (!__restored) __throw("WEB_SELECTION_RESTORE_FAILED", "ChatGPT reasoning effort restoration could not be confirmed");
    }
    throw __error;
  } finally {
    await __closeModelMenu();
  }
};

const __captureSelectedEffort = async () => {
  try {
    await __openModelMenu("simple");
    const state = await __readEffortState();
    if (!state) {
      if (await __hasVisibleEffortControl()) __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider is unavailable");
      return undefined;
    }
    const reading = await __readEffortReading(state);
    if (reading.label === undefined && reading.id === undefined) {
      __throw("WEB_EFFORT_UNKNOWN", "ChatGPT selected reasoning effort could not be observed");
    }
    return { state, reading };
  } finally {
    await __closeModelMenu();
  }
};

const __restoreCapturedEffort = async (captured) => {
  if (!captured) return true;
  let restored = false;
  try {
    await __openModelMenu("simple");
    await __waitForEffortControl();
    let state = await __readEffortState();
    if (state && state.min === captured.state.min && state.max === captured.state.max
      && await __restoreEffortIndex(state.sliderSelector, captured.state.now)) {
      state = await __readEffortState();
      if (state && state.min === captured.state.min && state.max === captured.state.max && state.now === captured.state.now) {
        const reading = await __readEffortReading(state);
        restored = reading.label === captured.reading.label && reading.id === captured.reading.id;
      }
    }
  } catch { /* report false below */ }
  try { await __closeModelMenu(); } catch { return false; }
  return restored;
};

const __catalogEfforts = async () => {
  let originalState;
  try {
    await __openModelMenu("simple");
    originalState = await __readEffortState();
    if (!originalState) {
      if (await __hasVisibleEffortControl()) __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider is unavailable");
      return { efforts: [] };
    }
    if (!await __restoreEffortIndex(originalState.sliderSelector, originalState.min)) {
      __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider could not reach its minimum");
    }
    const efforts = [];
    let state = await __readEffortState();
    if (!state) __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider disappeared");
    for (let step = 0; step < ${MAX_CATALOG_CHOICES}; step += 1) {
      const reading = await __readEffortReading(state);
      const label = reading.label ?? reading.id;
      if (label === undefined) __throw("WEB_EFFORT_UNKNOWN", "ChatGPT reasoning effort label could not be observed");
      efforts.push({
        label,
        ...(reading.id === undefined ? {} : { id: reading.id }),
        index: state.now,
        available: true,
        selected: state.now === originalState.now,
      });
      if (state.now >= state.max) break;
      const expectedIndex = state.now + 1;
      await __page.press(state.sliderSelector, "ArrowRight", { timeout: __input.timeoutMs });
      if (!await __waitEffortIndex(state.sliderSelector, expectedIndex)) {
        __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider transition was not confirmed");
      }
      state = await __readEffortState();
      if (!state) __throw("WEB_EFFORT_SELECTION_UNAVAILABLE", "ChatGPT reasoning slider disappeared");
    }
    if (efforts.length === 0 || efforts.length > ${MAX_CATALOG_CHOICES} || !efforts.some((effort) => effort.selected)) {
      __throw("WEB_CATALOG_BOUND", "ChatGPT reasoning effort catalog is invalid");
    }
    const selected = efforts.find((effort) => effort.selected);
    return { efforts, selected };
  } finally {
    if (originalState) {
      let restored = false;
      try { restored = await __restoreEffortIndex(originalState.sliderSelector, originalState.now); } catch { /* report below */ }
      if (!restored) __throw("WEB_SELECTION_RESTORE_FAILED", "ChatGPT reasoning effort restoration could not be confirmed");
    }
    await __closeModelMenu();
  }
};
`
}

function webSearchSource(): string {
  return `
const __searchControlState = async () => {
  try {
    return await __page.evaluate(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const enabled = (element) => !element.hasAttribute("disabled")
        && element.getAttribute("aria-disabled") !== "true"
        && (!("disabled" in element) || !element.disabled);
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const composerTools = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_TOOL_BUTTON_SELECTOR)}))
        .filter((element) => visible(element) && enabled(element));
      const searchOptions = Array.from(document.querySelectorAll('button[data-list-navigation-item="true"]'))
        .filter((element) => visible(element) && enabled(element))
        .filter((element) => normalize(element.textContent).startsWith("网页搜索查找实时新闻和信息"));
      return { composerTools: composerTools.length, searchOptions: searchOptions.length };
    });
  } catch {
    __throw("WEB_SEARCH_UNAVAILABLE", "ChatGPT webpage search controls could not be inspected");
  }
};

const __assertSearchBaseline = (observation) => {
  if (!observation || typeof observation.modelLabel !== "string" || observation.modelLabel.trim().length === 0) {
    __throw("WEB_MODEL_UNKNOWN", "ChatGPT selected model could not be observed before webpage search");
  }
  if ((typeof observation.effortLabel !== "string" || observation.effortLabel.trim().length === 0)
    && (typeof observation.effortId !== "string" || observation.effortId.trim().length === 0)) {
    __throw("WEB_EFFORT_UNKNOWN", "ChatGPT selected effort could not be observed before webpage search");
  }
};

const __waitForWebSearchPill = async () => {
  try {
    await __page.waitForFunction(() => {
      const visible = (element) => {
        for (let current = element; current !== null; current = current.parentElement) {
          if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
          if (style.display !== "contents" && current.getClientRects().length === 0) return false;
        }
        return true;
      };
      const composers = Array.from(document.querySelectorAll(${JSON.stringify(COMPOSER_SELECTORS)})).filter(visible);
      if (composers.length !== 1) return false;
      const pills = Array.from(composers[0].querySelectorAll('span[data-inline-selection-pill][data-system-hint-type="search"][data-system-hint-label="网页搜索"][data-prompt-link-href="chatgpt-system-hint://search"][data-prompt-link-label="网页搜索"][contenteditable="false"]'))
        .filter(visible);
      return pills.length === 1;
    }, undefined, { timeout: __input.timeoutMs });
  } catch {
    __throw("WEB_SEARCH_PILL_MISSING", "ChatGPT webpage search pill was not observed after selection");
  }
};

const __selectWebSearch = async () => {
  const __beforeControls = await __searchControlState();
  if (!__beforeControls || __beforeControls.composerTools !== 1) {
    __throw("WEB_SEARCH_TOOL_UNAVAILABLE", "ChatGPT webpage search menu control is unavailable or ambiguous");
  }
  try {
    await __page.click(${JSON.stringify(COMPOSER_TOOL_BUTTON_SELECTOR)}, { timeout: __input.timeoutMs, label: "open ChatGPT webpage search menu" });
  } catch {
    __throw("WEB_SEARCH_TOOL_UNAVAILABLE", "ChatGPT webpage search menu could not be opened");
  }
  const __openedControls = await __searchControlState();
  if (!__openedControls || __openedControls.searchOptions !== 1) {
    __throw("WEB_SEARCH_OPTION_UNAVAILABLE", "ChatGPT webpage search choice is unavailable or ambiguous");
  }
  try {
    await __page.click(${JSON.stringify(WEB_SEARCH_OPTION_SELECTOR)}, { timeout: __input.timeoutMs, label: "select ChatGPT webpage search" });
  } catch {
    __throw("WEB_SEARCH_OPTION_UNAVAILABLE", "ChatGPT webpage search choice could not be selected");
  }
  await __waitForWebSearchPill();
  const __afterSelection = await __page.evaluate(__inspect);
  if (!__afterSelection || __afterSelection.webSearchActive !== true) {
    __throw("WEB_SEARCH_PILL_MISSING", "ChatGPT webpage search pill was not observed after selection");
  }
  return __afterSelection;
};
`
}

function scriptFor(operation: EgoOperation, input: unknown): string {
  const data = JSON.stringify(input)
  const inspectSource = String(inspectChatGptPage)
  const menuSource = modelMenuSource()
  const searchSource = webSearchSource()
  let body = ''
  switch (operation) {
    case 'create':
      body = `
const __task = await taskSpace(__input.spaceId === undefined ? "ChatGPT Web " + __input.runId : __input.spaceId);
__assertAgent(__task);
const __page = __input.createPage ? await __task.newPage() : __task.page("p1");
if (!__page || typeof __page.label !== "string") __throw("WEB_RESOURCE_INVALID", "Ego browser returned an invalid Page");
__emit({ ok: true, value: { spaceId: __task.spaceId, pageLabel: __page.label } });
`
      break
    case 'catalog':
      body = `
const __task = await taskSpace(__input.resource.spaceId);
__assertAgent(__task);
const __page = __task.page(__input.resource.pageLabel);
const __inspect = ${inspectSource};
${menuSource}
const __isChatGptUrl = (value) => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com" || hostname.endsWith(".chat.openai.com"));
  } catch {
    return false;
  }
};
const __isChatGptRoot = (value) => {
  try { return __isChatGptUrl(value) && new URL(value).pathname === "/"; } catch { return false; }
};
const __isEmptyStartingPage = (value) => value === "about:blank"
  || String(value).startsWith("about:blank#")
  || value === ${JSON.stringify(EGO_EMPTY_NEW_TAB_URL)};
const __isEmptyChat = (value) => value.composerText === ""
  && !value.hasAttachments
  && value.userMessageCount === 0
  && Array.isArray(value.userMessages) && value.userMessages.length === 0
  && value.assistantMessages.length === 0
  && !value.generating;
let __currentUrl = await __page.url();
if (__isChatGptUrl(__currentUrl)) {
  if (!__isChatGptRoot(__currentUrl)) __throw("WEB_RESOURCE_CHANGED", "ChatGPT catalog initial route is not the root page");
} else if (!__isEmptyStartingPage(__currentUrl)) {
  __throw("WEB_RESOURCE_CHANGED", "ChatGPT catalog initial page is not blank or ChatGPT");
} else {
  await __page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: __input.timeoutMs });
  __currentUrl = await __page.url();
  if (!__isChatGptRoot(__currentUrl)) __throw("WEB_RESOURCE_CHANGED", "ChatGPT catalog navigation did not reach the root page");
}
try {
  await __page.waitForSelector(${JSON.stringify(COMPOSER_SELECTORS)}, { state: "visible", timeout: __input.timeoutMs });
} catch {
  const initial = await __page.evaluate(__inspect);
  if (initial?.loginRequired) __throw("WEB_LOGIN_REQUIRED", "ChatGPT login is required");
  __throw("WEB_PAGE_NOT_READY", "ChatGPT composer is unavailable");
}
const __initial = await __page.evaluate(__inspect);
if (!__initial || __initial.loginRequired) __throw("WEB_LOGIN_REQUIRED", "ChatGPT login is required");
if (__initial.visibleError) __throw("WEB_PAGE_ERROR", "ChatGPT page reported a visible error");
if (__initial.composerCount !== 1) __throw("WEB_PAGE_NOT_READY", "ChatGPT has no unique composer");
if (!__isEmptyChat(__initial)) __throw("WEB_CONVERSATION_NOT_EMPTY", "ChatGPT conversation is not empty");
const __originalModels = await __catalogModelChoices();
const __originalModel = __originalModels.find((choice) => choice.selected);
if (!__originalModel) __throw("WEB_MODEL_UNKNOWN", "ChatGPT selected model could not be observed");
const __originalEffort = await __captureSelectedEffort();
const __requestedModel = typeof __input.input?.modelLabel === "string" && __input.input.modelLabel.trim().length > 0
  ? __input.input.modelLabel
  : undefined;
const __effortModelLabel = __requestedModel ?? __originalModel.label;
let __catalog;
try {
  if (__effortModelLabel !== __originalModel.label) await __selectRequestedModel(__effortModelLabel);
  const __targetModels = await __catalogModelChoices();
  if (!__targetModels.some((choice) => choice.selected && choice.label === __effortModelLabel)) {
    __throw("WEB_MODEL_SELECTION_UNAVAILABLE", "Requested ChatGPT model selection was not confirmed");
  }
  const __targetEfforts = await __catalogEfforts();
  __catalog = {
    formatVersion: 1,
    observedAt: new Date().toISOString(),
    browser: { kind: "ego-lite", spaceId: __input.resource.spaceId, pageLabel: __input.resource.pageLabel },
    models: __originalModels,
    effortModelLabel: __effortModelLabel,
    efforts: __targetEfforts.efforts,
    selected: {
      modelLabel: __originalModel.label,
      ...(__originalEffort?.reading.label === undefined ? {} : { effortLabel: __originalEffort.reading.label }),
      ...(__originalEffort?.reading.id === undefined ? {} : { effortId: __originalEffort.reading.id }),
    },
  };
} finally {
  let __restored = false;
  try {
    if (__effortModelLabel !== __originalModel.label) await __selectRequestedModel(__originalModel.label);
    if (!await __restoreCapturedEffort(__originalEffort)) {
      __throw("WEB_SELECTION_RESTORE_FAILED", "ChatGPT original reasoning effort restoration could not be confirmed");
    }
    const __restoredObservation = await __observeModelMenu();
    __restored = __restoredObservation?.modelLabel === __originalModel.label
      && (__originalEffort === undefined || (
        __restoredObservation?.effortLabel === __originalEffort.reading.label
        && __restoredObservation?.effortId === __originalEffort.reading.id
      ));
  } catch { /* report below */ }
  try { await __closeModelMenu(); } catch { /* restoration status is authoritative */ }
  if (!__restored) __throw("WEB_SELECTION_RESTORE_FAILED", "ChatGPT model or reasoning effort restoration could not be confirmed");
}
__emit({ ok: true, value: __catalog });
`
      break
    case 'prepare':
      body = `
const __task = await taskSpace(__input.resource.spaceId);
__assertAgent(__task);
const __page = __task.page(__input.resource.pageLabel);
const __inspect = ${inspectSource};
${menuSource}
${searchSource}
const __currentUrl = await __page.url();
const __isChatGptUrl = (value) => {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === "https:" && (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com") || hostname === "chat.openai.com" || hostname.endsWith(".chat.openai.com"));
  } catch {
    return false;
  }
};
const __isChatGptRoot = (value) => {
  try { return __isChatGptUrl(value) && new URL(value).pathname === "/"; } catch { return false; }
};
const __isEmptyStartingPage = (value) => value === "about:blank"
  || String(value).startsWith("about:blank#")
  || value === ${JSON.stringify(EGO_EMPTY_NEW_TAB_URL)};
const __isEmptyChat = (value) => value.composerText === ""
  && !value.hasAttachments
  && value.userMessageCount === 0
  && Array.isArray(value.userMessages) && value.userMessages.length === 0
  && value.assistantMessages.length === 0
  && !value.generating;
if (__isChatGptUrl(__currentUrl)) {
  const __current = await __page.evaluate(__inspect);
  if (__current.loginRequired) __throw("WEB_LOGIN_REQUIRED", "ChatGPT login is required");
  if (__current.visibleError) __throw("WEB_PAGE_ERROR", "ChatGPT page reported a visible error");
  if (!__isEmptyChat(__current)) __throw("WEB_CONVERSATION_NOT_EMPTY", "ChatGPT conversation is not empty");
  if (!__isChatGptRoot(__currentUrl)) __throw("WEB_RESOURCE_CHANGED", "ChatGPT resource URL changed");
} else if (!__isEmptyStartingPage(__currentUrl)) {
  __throw("WEB_RESOURCE_CHANGED", "ChatGPT resource URL changed");
} else {
  await __page.goto("https://chatgpt.com/", { waitUntil: "domcontentloaded", timeout: __input.timeoutMs });
}
let __composerReady = true;
try {
  await __page.waitForSelector(${JSON.stringify(COMPOSER_SELECTORS)}, { state: "visible", timeout: __input.timeoutMs });
} catch {
  __composerReady = false;
}
if (!__composerReady) {
  const __initial = await __page.evaluate(__inspect);
  if (__initial.loginRequired) __emit({ ok: true, value: __initial });
  else __throw("WEB_PAGE_NOT_READY", "ChatGPT composer is unavailable");
} else {
  let __observation = await __observeModelMenu();
  const __needsModel = __input.request.modelLabel !== undefined && __observation.modelLabel !== __input.request.modelLabel;
  if (__needsModel) {
    __observation = await __selectRequestedModel(__input.request.modelLabel);
  }
  if (__input.request.webSearch === true) {
    const __preSearch = __observation;
    if (__preSearch.loginRequired) __throw("WEB_LOGIN_REQUIRED", "ChatGPT login is required");
    if (__preSearch.visibleError) __throw("WEB_PAGE_ERROR", "ChatGPT page reported a visible error");
    if (__preSearch.composerCount !== 1) __throw("WEB_PAGE_NOT_READY", "ChatGPT has no unique composer");
    if (!__isEmptyChat(__preSearch)) __throw("WEB_CONVERSATION_NOT_EMPTY", "ChatGPT conversation is not empty");
    __assertSearchBaseline(__preSearch);
    if (__preSearch.webSearchActive === true) {
      __throw("WEB_SEARCH_ALREADY_ACTIVE", "ChatGPT webpage search was already active before preparation");
    }
    await __selectWebSearch();
  }
  if (__input.request.effortLabel !== undefined) {
    const __simpleObservation = await __observeEffortMenu();
    const __needsEffort = !__matchesRequestedEffort(__simpleObservation, __input.request.effortLabel);
    if (__needsEffort) await __selectRequestedEffort(__input.request.effortLabel);
    __observation = await __observeModelMenu();
  } else {
    __observation = await __observeModelMenu();
  }
  if (__input.request.webSearch === true && __observation.webSearchActive !== true) {
    __throw("WEB_SEARCH_PILL_MISSING", "ChatGPT webpage search pill was not observed after preparation");
  }
  __emit({ ok: true, value: __observation });
}
`
      break
    case 'observe':
      body = `
const __task = await taskSpace(__input.resource.spaceId);
__assertAgent(__task);
const __page = __task.page(__input.resource.pageLabel);
if (__input.resource.conversationUrl && await __page.url() !== __input.resource.conversationUrl) {
  __throw("WEB_RESOURCE_CHANGED", "ChatGPT resource URL changed");
}
const __inspect = ${inspectSource};
const __observation = await __page.evaluate(__inspect);
__emit({ ok: true, value: __observation });
`
      break
    case 'submit':
      body = `
const __task = await taskSpace(__input.resource.spaceId);
__assertAgent(__task);
const __page = __task.page(__input.resource.pageLabel);
if (__input.resource.conversationUrl && await __page.url() !== __input.resource.conversationUrl) {
  __throw("WEB_RESOURCE_CHANGED", "ChatGPT resource URL changed");
}
const __inspect = ${inspectSource};
${menuSource}
${searchSource}
const __initial = await __page.evaluate(__inspect);
if (__initial.loginRequired) __throw("WEB_LOGIN_REQUIRED", "ChatGPT login is required");
if (__initial.visibleError) __throw("WEB_PAGE_ERROR", "ChatGPT page reported a visible error");
if (__initial.composerCount !== 1) __throw("WEB_PAGE_NOT_READY", "ChatGPT has no unique composer");
const __before = await __observeModelMenu();
if (__before.generating || __before.composerText !== "" || __before.hasAttachments || __before.userMessageCount !== 0 || __before.assistantMessages.length !== 0) {
  __throw("WEB_CONVERSATION_NOT_EMPTY", "ChatGPT conversation is not empty");
}
if (__input.request.webSearch === true) {
  __assertSearchBaseline(__before);
  if (__before.webSearchActive !== true) {
    __throw("WEB_SEARCH_ACTIVE_REQUIRED", "ChatGPT webpage search was not confirmed before submission");
  }
}
if (__input.request.modelLabel !== undefined && __before.modelLabel !== __input.request.modelLabel) {
  __throw("WEB_MODEL_MISMATCH", "Observed model label does not match the request");
}
if (!__matchesRequestedEffort(__before, __input.request.effortLabel)) {
  __throw("WEB_EFFORT_MISMATCH", "Observed reasoning label does not match the request");
}
const __composerSelector = await __page.evaluate(() => {
  const selectors = [
    "div.ProseMirror[contenteditable=\\"true\\"]",
    "textarea#prompt-textarea",
    "textarea[data-testid=\\"prompt-textarea\\"]",
    "[data-testid=\\"prompt-textarea\\"][contenteditable=\\"true\\"]",
    "[role=\\"textbox\\"][contenteditable=\\"true\\"][data-testid=\\"prompt-textarea\\"]",
  ];
  const visible = (element) => {
    for (let current = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      if (style.display !== "contents" && current.getClientRects().length === 0) return false;
    }
    return true;
  };
  for (const selector of selectors) {
    const matches = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (matches.length === 1) return selector;
  }
  return null;
});
if (!__composerSelector) __throw("WEB_PAGE_NOT_READY", "ChatGPT composer is unavailable");
if (__input.request.webSearch === true) {
  const __focused = await __page.evaluate((selector) => {
    const composer = document.querySelector(selector);
    if (!composer || !(composer instanceof HTMLElement)) return false;
    const selection = document.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    composer.focus();
    return document.activeElement === composer;
  }, __composerSelector);
  if (!__focused) __throw("WEB_SEARCH_COMPOSER_FOCUS_FAILED", "ChatGPT composer could not be focused after webpage search selection");
  try {
    await __page.keyboard.insertText(__input.request.prompt);
  } catch {
    __throw("WEB_SEARCH_TEXT_INSERT_FAILED", "ChatGPT prompt could not be inserted without clearing webpage search");
  }
} else {
  await __page.fill(__composerSelector, __input.request.prompt, { clearFirst: true });
}
const __afterFill = await __observeModelMenu();
if (__afterFill.composerText !== __input.request.prompt || __afterFill.hasAttachments) {
  __throw("WEB_DRAFT_MISMATCH", "ChatGPT composer readback did not match the request");
}
if (__input.request.webSearch === true && __afterFill.webSearchActive !== true) {
  __throw("WEB_SEARCH_PILL_MISSING", "ChatGPT webpage search pill was not observed before submission");
}
if (__input.request.modelLabel !== undefined && __afterFill.modelLabel !== __input.request.modelLabel) {
  __throw("WEB_MODEL_MISMATCH", "Observed model label does not match the request");
}
if (!__matchesRequestedEffort(__afterFill, __input.request.effortLabel)) {
  __throw("WEB_EFFORT_MISMATCH", "Observed reasoning label does not match the request");
}
const __sendSelector = await __page.evaluate(() => {
  const selectors = [
    "button[data-testid=\\"send-button\\"]",
    "[data-testid=\\"send-button\\"]",
    "button[aria-label=\\"Send message\\"]",
    "button[aria-label=\\"Send\\"]",
    "button[aria-label=\\"发送\\"]",
  ];
  const visible = (element) => {
    for (let current = element; current !== null; current = current.parentElement) {
      if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true" || current.hasAttribute("inert")) return false;
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      if (style.display !== "contents" && current.getClientRects().length === 0) return false;
    }
    if (element.getAttribute("aria-disabled") === "true") return false;
    if ("disabled" in element && element.disabled) return false;
    return true;
  };
  for (const selector of selectors) {
    const matches = Array.from(document.querySelectorAll(selector)).filter(visible);
    if (matches.length === 1) return selector;
  }
  return null;
});
if (!__sendSelector) __throw("WEB_SEND_UNAVAILABLE", "ChatGPT send control is unavailable");
await __page.click(__sendSelector, { timeout: __input.timeoutMs, label: "send ChatGPT prompt" });
const __afterClick = await __page.evaluate(__inspect);
__emit({ ok: true, value: {
  ...__afterClick,
  modelLabel: __afterFill.modelLabel,
  effortLabel: __afterFill.effortLabel,
  effortId: __afterFill.effortId,
} });
`
      break
    case 'finish':
      body = `
const __task = await taskSpace(__input.resource.spaceId);
__assertAgent(__task);
await __task.finish({ keep: [__input.resource.pageLabel] });
__emit({ ok: true, value: { finished: true } });
`
      break
  }
  return `${scriptRuntime()}\nconst __input = ${data};\nconst __operation = ${JSON.stringify(operation)};\ntry {${body}\n} catch (__error) { __fail(__error); }\n`
}

function validateFrameObservation(value: unknown): ChatGptPageObservation {
  return assertObservation(value)
}

/**
 * Ego-backed ChatGPT Web transport. Requested model and reasoning labels are
 * selected only through exact visible controls when they differ, then read
 * back from the page; this adapter never guesses or silently falls back.
 */
export class EgoWebAdapter implements WebBrowserAdapter {
  readonly #config: Required<Pick<EgoWebAdapterOptions, 'executable' | 'cwd' | 'commandTimeoutMs'>>
  readonly #spaceId: number | undefined
  readonly #createPage: boolean
  readonly #retainSpace: boolean
  readonly #stdoutMaxBytes: number
  readonly #stderrMaxBytes: number
  readonly #run: EgoProcessRunner
  #lastNotices: string[] = []
  readonly #created = new Map<string, WebRunResource>()
  readonly #creating = new Map<string, Promise<WebRunResource>>()
  readonly #prepared = new Map<number, {
    readonly modelLabel?: string
    readonly effortLabel?: string
    readonly effortId?: string
    readonly webSearchActive?: boolean
  }>()
  readonly #submitted = new Set<number>()
  readonly #finishing = new Set<number>()
  readonly #finished = new Set<number>()

  constructor(config: EgoWebAdapterOptions, injectedRun: EgoProcessRunner = runEgoProcess) {
    if (!isRecord(config)
      || typeof config.executable !== 'string' || !isAbsolute(config.executable)
      || typeof config.cwd !== 'string' || !isAbsolute(config.cwd)
      || !Number.isSafeInteger(config.commandTimeoutMs) || config.commandTimeoutMs <= 0) {
      throw browserError('WEB_CONFIG_INVALID', 'Ego browser adapter configuration is invalid')
    }
    const stdoutMaxBytes = config.stdoutMaxBytes
    if (!Number.isSafeInteger(stdoutMaxBytes) || stdoutMaxBytes <= 0) {
      throw browserError('WEB_CONFIG_INVALID', 'Ego browser output bounds are invalid')
    }
    if (config.spaceId !== undefined && (!Number.isSafeInteger(config.spaceId) || config.spaceId <= 0)) {
      throw browserError('WEB_CONFIG_INVALID', 'Ego browser TaskSpace id is invalid')
    }
    if ((config.createPage !== undefined && typeof config.createPage !== 'boolean')
      || (config.retainSpace !== undefined && typeof config.retainSpace !== 'boolean')) {
      throw browserError('WEB_CONFIG_INVALID', 'Ego browser page/space retention options are invalid')
    }
    if (config.createPage === true && config.spaceId === undefined) {
      throw browserError('WEB_CONFIG_INVALID', 'Ego browser createPage requires an existing TaskSpace id')
    }
    this.#config = {
      executable: config.executable,
      cwd: config.cwd,
      commandTimeoutMs: config.commandTimeoutMs,
    }
    this.#spaceId = config.spaceId
    this.#createPage = config.createPage === true
    this.#retainSpace = config.retainSpace === true
    this.#stdoutMaxBytes = stdoutMaxBytes
    this.#stderrMaxBytes = Math.max(
      DEFAULT_STDERR_MAX_BYTES,
      stdoutMaxBytes > Number.MAX_SAFE_INTEGER - STDERR_NOTICE_OVERHEAD_BYTES
        ? Number.MAX_SAFE_INTEGER
        : stdoutMaxBytes + STDERR_NOTICE_OVERHEAD_BYTES,
    )
    this.#run = injectedRun
  }

  get lastEgoNotices(): readonly string[] {
    return [...this.#lastNotices]
  }

  async create(runId: string, signal?: AbortSignal): Promise<WebRunResource> {
    assertNonEmptyString(runId, 'WEB_REQUEST_INVALID', 'ChatGPT Web run id is invalid')
    const existing = this.#created.get(runId)
    if (existing) return { ...existing }
    const inFlight = this.#creating.get(runId)
    if (inFlight) return { ...(await inFlight) }
    const creating = (async (): Promise<WebRunResource> => {
      const value = await this.#invoke<{ spaceId: number; pageLabel: string }>('create', {
        runId,
        ...(this.#spaceId === undefined ? {} : { spaceId: this.#spaceId }),
        createPage: this.#createPage,
      }, signal)
      if (!isRecord(value) || !Number.isSafeInteger(value.spaceId) || value.spaceId <= 0
        || typeof value.pageLabel !== 'string' || !/^p[1-9]\d*$/.test(value.pageLabel)
        || !Number.isSafeInteger(Number(value.pageLabel.slice(1)))) {
        throw browserError('WEB_EGO_FRAME', 'Ego browser returned an invalid TaskSpace resource')
      }
      const resource: WebRunResource = { spaceId: value.spaceId, pageLabel: value.pageLabel }
      this.#created.set(runId, resource)
      return resource
    })()
    this.#creating.set(runId, creating)
    try {
      return { ...(await creating) }
    } finally {
      this.#creating.delete(runId)
    }
  }

  async catalog(resource: WebRunResource, input: WebModelCatalogRefreshInput, signal?: AbortSignal): Promise<WebModelCatalog> {
    assertResource(resource)
    assertCatalogInput(input)
    return assertModelCatalog(await this.#invoke('catalog', {
      resource,
      input,
      timeoutMs: this.#config.commandTimeoutMs,
    }, signal), resource)
  }

  async prepare(resource: WebRunResource, request: WebRunRequest, signal?: AbortSignal): Promise<ChatGptPageObservation> {
    assertResource(resource)
    assertRequest(request)
    const observation = validateFrameObservation(await this.#invoke('prepare', {
      resource,
      request,
      timeoutMs: this.#config.commandTimeoutMs,
    }, signal))
    this.#assertReady(observation, true)
    assertRequestedLabels(request, observation, true)
    this.#prepared.set(resource.spaceId, {
      ...(observation.modelLabel === undefined ? {} : { modelLabel: observation.modelLabel }),
      ...(observation.effortLabel === undefined ? {} : { effortLabel: observation.effortLabel }),
      ...(observation.effortId === undefined ? {} : { effortId: observation.effortId }),
      ...(observation.webSearchActive === undefined ? {} : { webSearchActive: observation.webSearchActive }),
    })
    return observation
  }

  async observe(resource: WebRunResource, signal?: AbortSignal): Promise<ChatGptPageObservation> {
    assertResource(resource)
    const observation = validateFrameObservation(await this.#invoke('observe', { resource, timeoutMs: this.#config.commandTimeoutMs }, signal))
    if (observation.loginRequired) throw browserError('WEB_LOGIN_REQUIRED', 'ChatGPT login is required')
    return observation
  }

  async submit(resource: WebRunResource, request: WebRunRequest, signal?: AbortSignal): Promise<ChatGptPageObservation> {
    assertResource(resource)
    assertRequest(request)
    if (this.#submitted.has(resource.spaceId)) {
      throw browserError('WEB_SUBMISSION_ALREADY_ATTEMPTED', 'ChatGPT Web submission was already attempted')
    }
    const prepared = this.#prepared.get(resource.spaceId)
    if (!prepared) throw browserError('WEB_PREPARE_REQUIRED', 'ChatGPT Web resource was not prepared')
    if (request.modelLabel !== undefined && prepared.modelLabel !== request.modelLabel) {
      throw browserError('WEB_MODEL_MISMATCH', 'ChatGPT model was not prepared for this request')
    }
    if (!matchesRequestedEffort(prepared, request.effortLabel)) {
      throw browserError('WEB_EFFORT_MISMATCH', 'ChatGPT reasoning effort was not prepared for this request')
    }
    if (request.webSearch === true && prepared.webSearchActive !== true) {
      throw browserError('WEB_SEARCH_ACTIVE_REQUIRED', 'ChatGPT webpage search was not prepared for this request')
    }
    this.#submitted.add(resource.spaceId)
    const observation = validateFrameObservation(await this.#invoke('submit', {
      resource,
      request,
      timeoutMs: this.#config.commandTimeoutMs,
    }, signal))
    assertRequestedLabels(request, observation)
    return observation
  }

  async finish(resource: WebRunResource): Promise<void> {
    assertResource(resource)
    if (this.#finished.has(resource.spaceId) || this.#finishing.has(resource.spaceId)) {
      throw browserError('WEB_ALREADY_FINISHED', 'ChatGPT Web TaskSpace was already finished')
    }
    this.#finishing.add(resource.spaceId)
    try {
      if (this.#retainSpace) {
        this.#finished.add(resource.spaceId)
        return
      }
      const value = await this.#invoke<{ finished: boolean }>('finish', { resource }, undefined)
      if (!isRecord(value) || value.finished !== true) throw browserError('WEB_EGO_FRAME', 'Ego browser did not confirm TaskSpace finish')
      this.#finished.add(resource.spaceId)
    } finally {
      this.#finishing.delete(resource.spaceId)
    }
  }

  #assertReady(observation: ChatGptPageObservation, requireEmpty: boolean): void {
    if (observation.loginRequired) throw browserError('WEB_LOGIN_REQUIRED', 'ChatGPT login is required')
    if (observation.visibleError !== undefined) throw browserError('WEB_PAGE_ERROR', 'ChatGPT page reported a visible error')
    if (observation.composerCount !== 1) throw browserError('WEB_PAGE_NOT_READY', 'ChatGPT has no unique composer')
    if (requireEmpty && (observation.composerText !== '' || observation.hasAttachments
      || observation.userMessageCount !== 0 || observation.assistantMessages.length !== 0)) {
      throw browserError('WEB_CONVERSATION_NOT_EMPTY', 'ChatGPT conversation is not empty')
    }
  }

  async #invoke<T>(operation: EgoOperation, input: unknown, signal: AbortSignal | undefined): Promise<T> {
    this.#lastNotices = []
    let result: EgoProcessResult
    try {
      result = await this.#run({
        executable: this.#config.executable,
        source: scriptFor(operation, input),
        cwd: this.#config.cwd,
        timeoutMs: this.#config.commandTimeoutMs,
        stdoutMaxBytes: this.#stdoutMaxBytes,
        stderrMaxBytes: this.#stderrMaxBytes,
        signal,
      })
    } catch (caught) {
      if (caught instanceof WebBrowserError) throw caught
      if (caught instanceof EgoProcessError) {
        throw new WebBrowserError(caught.code, 'Ego browser command failed', caught.mayHaveLateEffects)
      }
      throw browserError('WEB_EGO_PROCESS', 'Ego browser command failed')
    }
    if (result.exitCode !== 0 || !result.executionStopped) {
      throw browserError('WEB_EGO_PROCESS', 'Ego browser command did not stop cleanly')
    }
    if (result.stderrTruncated === true) {
      throw browserError('EGO_OUTPUT_TOO_LARGE', 'Ego browser stderr exceeded its bound')
    }
    const decoded = decodeTransportFrame(result.stdout, result.stderr, this.#stdoutMaxBytes)
    this.#lastNotices = [...decoded.notices]
    if (!decoded.frame.ok) throw browserError(decoded.frame.error.code, decoded.frame.error.message)
    return decoded.frame.value as T
  }
}
