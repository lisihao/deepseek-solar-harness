import { isAbsolute } from 'node:path'

import {
  findGrokModelOption,
  GROK_EXACT_SELECTABLE_MODEL_LABELS,
  findUniqueGrokComposer,
  findUniqueGrokModelTrigger,
  findUniqueGrokSubmitControl,
  GROK_APP_URL,
  inspectGrokPage,
  readGrokCheckedModelLabel,
  type GrokPageInspectionInput,
} from './grok-page.js'
import type { GrokBrowserPort, GrokPageObservation, GrokResource } from './grok-contract.js'
import { runEgoProcess } from './process.js'
import { EgoProcessError, type EgoProcessRequest, type EgoProcessResult } from './process-contract.js'

/** A single JSON frame is the only accepted Ego process output. */
export const GROK_EGO_FRAME_MARKER = '__DSH_SOLAR_GROK_WEB_FRAME__:'

const DEFAULT_STDOUT_MAX_BYTES = 512 * 1024
const DEFAULT_STDERR_MAX_BYTES = 32 * 1024
const STDERR_NOTICE_OVERHEAD_BYTES = 64 * 1024
// Match the host's supported 8-MiB answer bound, plus observation framing.
const MAX_STDOUT_MAX_BYTES = 8 * 1024 * 1024 + 512 * 1024
const MAX_PROMPT_BYTES = 128 * 1024
const MAX_COMMAND_TIMEOUT_MS = 120_000
const EGO_NOTICE_PREFIX = '[ego-browser:notice]'
const EXACT_SELECTABLE_MODEL_LABELS = new Set<string>(GROK_EXACT_SELECTABLE_MODEL_LABELS)
const GROK_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type JsonRecord = Record<string, unknown>
type GrokOperation = 'allocate' | 'prepare' | 'submit' | 'observe' | 'finish'

interface FrameSuccess {
  readonly ok: true
  readonly value: unknown
}

interface FrameFailure {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
  }
}

type GrokFrame = FrameSuccess | FrameFailure

interface PreparedDraft {
  readonly prompt: string
  readonly modelLabel?: string
}

export interface GrokEgoProcessRunner {
  (request: EgoProcessRequest): Promise<EgoProcessResult>
}

/**
 * `challengeSelector` deliberately has no default.  The retained Grok DOM
 * evidence does not establish a challenge selector, so a caller must provide
 * an observed selector before this adapter classifies a visible node as one.
 */
export interface GrokEgoAdapterOptions {
  readonly executable: string
  readonly cwd: string
  readonly commandTimeoutMs: number
  readonly stdoutMaxBytes?: number
  readonly challengeSelector?: string
}

export class GrokEgoAdapterError extends Error {
  constructor(readonly code: string, message: string, readonly mayHaveLateEffects = false) {
    super(message)
    this.name = 'GrokEgoAdapterError'
  }
}

function adapterError(code: string, message: string, mayHaveLateEffects = false): GrokEgoAdapterError {
  return new GrokEgoAdapterError(code, message, mayHaveLateEffects)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function assertExactKeys(value: JsonRecord, keys: readonly string[], code: string, message: string): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some((key) => !allowed.has(key))) throw adapterError(code, message)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Only the retained root and /c/ conversation routes are in operator scope. */
export function isGrokUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'grok.com'
      || parsed.port !== '' || parsed.username !== '' || parsed.password !== ''
      || parsed.hash !== '' || parsed.toString() !== value) return false
    if (parsed.pathname === '/' && parsed.search === '') return true
    const conversation = /^\/c\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(parsed.pathname)
    if (!conversation || conversation[1] === undefined) return false
    const entries = Array.from(parsed.searchParams.entries())
    if (entries.length === 0) return true
    const entry = entries[0]
    return entry !== undefined && entries.length === 1 && entry[0] === 'rid' && GROK_UUID_PATTERN.test(entry[1])
      && parsed.search === `?rid=${entry[1]}`
  } catch {
    return false
  }
}

function resourceKey(resource: GrokResource): string {
  return `${resource.spaceId}\u0000${resource.pageLabel}`
}

function assertResource(resource: GrokResource): void {
  const value = resource as unknown
  if (!isRecord(value)) throw adapterError('GROK_RESOURCE_INVALID', 'Grok browser resource is invalid')
  assertExactKeys(value, ['provider', 'spaceId', 'pageLabel', 'conversationUrl'], 'GROK_RESOURCE_INVALID', 'Grok browser resource is invalid')
  if (value.provider !== 'grok' || !positiveInteger(value.spaceId) || value.pageLabel !== 'p1'
    || typeof value.conversationUrl !== 'string' || !isGrokUrl(value.conversationUrl)) {
    throw adapterError('GROK_RESOURCE_INVALID', 'Grok browser resource is invalid')
  }
}

function assertAllocateInput(input: { readonly id: string; readonly sessionId: string }): void {
  const value = input as unknown
  if (!isRecord(value)) throw adapterError('GROK_REQUEST_INVALID', 'Grok allocation input is invalid')
  assertExactKeys(value, ['id', 'sessionId'], 'GROK_REQUEST_INVALID', 'Grok allocation input is invalid')
  if (!nonEmptyString(value.id) || value.id.length > 512 || !nonEmptyString(value.sessionId) || value.sessionId.length > 512) {
    throw adapterError('GROK_REQUEST_INVALID', 'Grok allocation input is invalid')
  }
}

function assertPrepareInput(input: { readonly prompt: string; readonly modelLabel?: string }): void {
  const value = input as unknown
  if (!isRecord(value)) throw adapterError('GROK_REQUEST_INVALID', 'Grok prepare input is invalid')
  assertExactKeys(value, ['prompt', 'modelLabel'], 'GROK_REQUEST_INVALID', 'Grok prepare input is invalid')
  if (typeof value.prompt !== 'string' || value.prompt.length === 0 || Buffer.byteLength(value.prompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw adapterError('GROK_REQUEST_INVALID', 'Grok prompt is invalid or exceeds the 128-KiB client bound')
  }
  if (value.modelLabel !== undefined && (!nonEmptyString(value.modelLabel) || !EXACT_SELECTABLE_MODEL_LABELS.has(value.modelLabel))) {
    throw adapterError('GROK_MODEL_UNSUPPORTED', 'Requested Grok model is not currently observed as an exact single-line selectable label')
  }
}

function optionalBoolean(value: JsonRecord, key: string): boolean | undefined {
  return hasOwn(value, key) && typeof value[key] === 'boolean' ? value[key] as boolean : undefined
}

function optionalString(value: JsonRecord, key: string): string | undefined {
  return hasOwn(value, key) && typeof value[key] === 'string' ? value[key] as string : undefined
}

function parseObservation(value: unknown): GrokPageObservation {
  if (!isRecord(value)) throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok observation')
  assertExactKeys(value, [
    'url', 'authenticated', 'loginRequired', 'challenge', 'busy', 'composerCount', 'composerText',
    'submitCount', 'submitEnabled', 'modelLabel', 'messages', 'errors',
  ], 'GROK_EGO_FRAME', 'Ego browser returned an invalid Grok observation shape')
  if (typeof value.url !== 'string' || !isGrokUrl(value.url)
    || typeof value.authenticated !== 'boolean'
    || typeof value.loginRequired !== 'boolean'
    || typeof value.challenge !== 'boolean'
    || !nonNegativeInteger(value.composerCount)
    || typeof value.composerText !== 'string'
    || !nonNegativeInteger(value.submitCount)
    || typeof value.submitEnabled !== 'boolean'
    || !Array.isArray(value.messages)
    || !Array.isArray(value.errors)
    || !value.errors.every((item) => typeof item === 'string')) {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok observation')
  }
  if (hasOwn(value, 'busy') && value.busy !== undefined && typeof value.busy !== 'boolean') {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok busy state')
  }
  if (hasOwn(value, 'modelLabel') && value.modelLabel !== undefined && !nonEmptyString(value.modelLabel)) {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok model label')
  }
  const messages = value.messages.map((message): GrokPageObservation['messages'][number] => {
    if (!isRecord(message)) throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok message')
    assertExactKeys(message, ['id', 'role', 'text', 'hasCopyControl', 'hasArtifacts'], 'GROK_EGO_FRAME', 'Ego browser returned an invalid Grok message shape')
    if (!nonEmptyString(message.id) || !message.id.startsWith('response-')
      || (message.role !== 'user' && message.role !== 'assistant')
      || typeof message.text !== 'string'
      || typeof message.hasCopyControl !== 'boolean'
      || typeof message.hasArtifacts !== 'boolean') {
      throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok message')
    }
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      hasCopyControl: message.hasCopyControl,
      hasArtifacts: message.hasArtifacts,
    }
  })
  if (new Set(messages.map((message) => message.id)).size !== messages.length) {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser returned duplicate Grok message identities')
  }
  return {
    url: value.url,
    authenticated: value.authenticated,
    loginRequired: value.loginRequired,
    challenge: value.challenge,
    busy: optionalBoolean(value, 'busy'),
    composerCount: value.composerCount,
    composerText: value.composerText,
    submitCount: value.submitCount,
    submitEnabled: value.submitEnabled,
    modelLabel: optionalString(value, 'modelLabel'),
    messages,
    errors: [...value.errors],
  }
}

function parseAllocated(value: unknown): GrokResource {
  if (!isRecord(value)) throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok allocation')
  assertExactKeys(value, ['resource'], 'GROK_EGO_FRAME', 'Ego browser returned an invalid Grok allocation shape')
  if (!isRecord(value.resource)) throw adapterError('GROK_EGO_FRAME', 'Ego browser returned an invalid Grok allocation')
  const resource = value.resource
  assertExactKeys(resource, ['provider', 'spaceId', 'pageLabel', 'conversationUrl'], 'GROK_EGO_FRAME', 'Ego browser returned an invalid Grok allocation resource')
  const parsed: GrokResource = {
    provider: resource.provider as 'grok',
    spaceId: resource.spaceId as number,
    pageLabel: resource.pageLabel as string,
    conversationUrl: resource.conversationUrl as string,
  }
  assertResource(parsed)
  return parsed
}

function parseAcknowledgement(value: unknown, operation: 'submit' | 'finish'): void {
  if (!isRecord(value)) throw adapterError('GROK_EGO_FRAME', `Ego browser did not confirm Grok ${operation}`)
  assertExactKeys(value, [operation === 'submit' ? 'submitted' : 'finished'], 'GROK_EGO_FRAME', `Ego browser did not confirm Grok ${operation}`)
  if ((operation === 'submit' && value.submitted !== true) || (operation === 'finish' && value.finished !== true)) {
    throw adapterError('GROK_EGO_FRAME', `Ego browser did not confirm Grok ${operation}`)
  }
}

function parseFrameLine(line: string, maxBytes: number): GrokFrame {
  if (!line.startsWith(GROK_EGO_FRAME_MARKER) || Buffer.byteLength(line, 'utf8') > maxBytes) {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok frame')
  }
  let frame: unknown
  try {
    frame = JSON.parse(line.slice(GROK_EGO_FRAME_MARKER.length)) as unknown
  } catch {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted malformed Grok JSON')
  }
  if (!isRecord(frame) || typeof frame.ok !== 'boolean') {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok frame')
  }
  if (frame.ok) {
    assertExactKeys(frame, ['ok', 'value'], 'GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok success frame')
    if (!hasOwn(frame, 'value')) throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted an empty Grok success frame')
    return { ok: true, value: frame.value }
  }
  assertExactKeys(frame, ['ok', 'error'], 'GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok error frame')
  if (!isRecord(frame.error)) throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok error frame')
  assertExactKeys(frame.error, ['code', 'message'], 'GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok error frame')
  if (!/^GROK_[A-Z0-9_]+$/.test(String(frame.error.code)) || !nonEmptyString(frame.error.message)) {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok error frame')
  }
  return { ok: false, error: { code: frame.error.code as string, message: frame.error.message } }
}

function decodeTransportFrame(
  result: EgoProcessResult,
  stdoutMaxBytes: number,
  stderrMaxBytes: number,
): { readonly frame: GrokFrame; readonly notices: readonly string[] } {
  if (!isRecord(result) || result.exitCode !== 0 || result.executionStopped !== true
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || result.stderrTruncated === true
    || Buffer.byteLength(result.stdout, 'utf8') > stdoutMaxBytes
    || Buffer.byteLength(result.stderr, 'utf8') > stderrMaxBytes) {
    throw adapterError('GROK_EGO_FRAME', 'Ego browser command did not return a clean bounded frame')
  }
  const frames: string[] = []
  const notices: string[] = []
  for (const channel of [result.stdout, result.stderr]) {
    for (const rawLine of channel.split(/\r?\n/)) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line.length === 0) continue
      if (line.startsWith(GROK_EGO_FRAME_MARKER)) frames.push(line)
      else if (line.startsWith(EGO_NOTICE_PREFIX)) notices.push(line.slice(EGO_NOTICE_PREFIX.length).trim())
      else throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted unexpected transport output')
    }
  }
  if (frames.length !== 1) throw adapterError('GROK_EGO_FRAME', 'Ego browser emitted an invalid Grok frame count')
  return { frame: parseFrameLine(frames[0]!, stdoutMaxBytes), notices }
}

function scriptRuntime(): string {
  return `
const __frameMarker = ${JSON.stringify(GROK_EGO_FRAME_MARKER)};
const __emit = (value) => process.stdout.write(__frameMarker + JSON.stringify(value) + "\\n");
const __publicError = Symbol("grok-public-error");
const __throw = (code, message) => { const error = new Error(message); error.code = code; error[__publicError] = true; throw error; };
const __fail = (error) => {
  const code = error && typeof error.code === "string" ? error.code : "GROK_EGO_SCRIPT";
  const safeCode = /^GROK_[A-Z0-9_]+$/.test(code);
  const message = error && error[__publicError] === true && safeCode && typeof error.message === "string"
    ? error.message
    : "Ego browser command failed";
  __emit({ ok: false, error: { code, message } });
};
const __isGrokUrl = (value) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.hostname !== "grok.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || parsed.toString() !== value) return false;
    if (parsed.pathname === "/" && parsed.search === "") return true;
    const conversation = /^\\/c\\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(parsed.pathname);
    if (!conversation || conversation[1] === undefined) return false;
    const entries = Array.from(parsed.searchParams.entries());
    if (entries.length === 0) return true;
    const entry = entries[0];
    return entry !== undefined && entries.length === 1 && entry[0] === "rid" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry[1]) && parsed.search === "?rid=" + entry[1];
  } catch { return false; }
};
const __assertAgentTask = (task) => {
  if (!task || task.ownership !== "agent" || !Number.isSafeInteger(task.spaceId) || task.spaceId <= 0) {
    __throw("GROK_TASKSPACE_UNAVAILABLE", "Grok TaskSpace is unavailable or not agent-owned");
  }
};
const __originalPage = async (resource) => {
  const task = await taskSpace(resource.spaceId);
  __assertAgentTask(task);
  if (task.spaceId !== resource.spaceId) __throw("GROK_TASKSPACE_MISMATCH", "Grok TaskSpace identity changed");
  const page = task.page(resource.pageLabel);
  if (!page || page.label !== resource.pageLabel) __throw("GROK_PAGE_MISMATCH", "Grok original page is unavailable");
  const url = await page.url();
  if (!__isGrokUrl(url)) __throw("GROK_RESOURCE_CHANGED", "Grok original page left the permitted URL scope");
  return { task, page };
};
`
}

function scriptFor(operation: GrokOperation, input: unknown): string {
  const data = JSON.stringify(input)
  const inspection = `__input.inspection`
  const observationHelper = `
const __inspect = ${inspectGrokPage.toString()};
const __pageObservation = async (page) => await page.evaluate(__inspect, ${inspection});
`
  const readyHelper = `
const __assertReady = (observation) => {
  if (!observation || typeof observation !== "object") __throw("GROK_PAGE_OBSERVATION_INVALID", "Grok page observation is invalid");
  if (observation.challenge === true) __throw("GROK_CHALLENGE_REQUIRED", "Grok requires manual challenge completion");
  if (observation.loginRequired === true || observation.authenticated !== true) __throw("GROK_LOGIN_REQUIRED", "Grok login is required before submission");
  if (!Array.isArray(observation.errors) || observation.errors.length > 0) __throw("GROK_PAGE_ERROR", "Grok page shows a visible error");
  if (observation.composerCount !== 1) __throw("GROK_COMPOSER_UNAVAILABLE", "Grok has no unique visible composer");
};
const __assertFresh = (observation) => {
  __assertReady(observation);
  if (observation.composerText !== "" || !Array.isArray(observation.messages) || observation.messages.length !== 0) {
    __throw("GROK_CONVERSATION_NOT_EMPTY", "Grok page is not a fresh empty conversation");
  }
};
`
  const prepareHelper = `
const __findComposer = ${findUniqueGrokComposer.toString()};
const __findModelTrigger = ${findUniqueGrokModelTrigger.toString()};
const __findModelOption = ${findGrokModelOption.toString()};
const __readCheckedModel = ${readGrokCheckedModelLabel.toString()};
const __selectModel = async (page, requested) => {
  let observation = await __pageObservation(page);
  if (requested === undefined) return observation;
  const openMenu = async () => {
    const trigger = await page.evaluate(__findModelTrigger);
    if (!trigger) __throw("GROK_MODEL_CONTROL_UNAVAILABLE", "Grok model trigger is unavailable or ambiguous");
    await page.click(trigger, { timeout: __input.timeoutMs, label: "open Grok model selector" });
    return trigger;
  };
  let trigger = await openMenu();
  if (observation.modelLabel !== requested) {
    const option = await page.evaluate(__findModelOption, { modelLabel: requested });
    if (!option) __throw("GROK_MODEL_SELECTION_UNAVAILABLE", "Requested exact Grok model is unavailable, ambiguous, disabled, or subscription-restricted");
    await page.click(option, { timeout: __input.timeoutMs, label: "select requested Grok model" });
    // Grok may close this menu after selection. Reopen the same trigger only
    // to perform the required visible state readback; no prompt is sent.
    trigger = await openMenu();
  }
  const checked = await page.evaluate(__readCheckedModel);
  observation = await __pageObservation(page);
  if (checked !== requested || observation.modelLabel !== requested || checked !== observation.modelLabel) {
    __throw("GROK_MODEL_MISMATCH", "Grok checked menu choice and trigger label did not agree");
  }
  try { await page.press(trigger, "Escape", { timeout: __input.timeoutMs }); } catch { /* menu may already be closed */ }
  return observation;
};
`
  const submitHelper = `
const __findSubmit = ${findUniqueGrokSubmitControl.toString()};
`
  const helpers = operation === 'finish'
    ? ''
    : operation === 'prepare'
      ? `${observationHelper}${readyHelper}${prepareHelper}`
      : operation === 'submit'
        ? `${observationHelper}${readyHelper}${submitHelper}`
        : observationHelper
  let body: string
  switch (operation) {
    case 'allocate':
      body = `
const __task = await taskSpace(__input.taskName);
__assertAgentTask(__task);
const __pages = await __task.pages();
if (!Array.isArray(__pages) || __pages.length !== 1) __throw("GROK_TASKSPACE_NOT_FRESH", "Grok TaskSpace has unexpected pages");
const __page = __task.page("p1");
if (!__page || __page.label !== "p1") __throw("GROK_PAGE_MISMATCH", "Grok fresh page is unavailable");
const __beforeUrl = await __page.url();
if (__beforeUrl !== "about:blank" && !String(__beforeUrl).startsWith("about:blank#") && __beforeUrl !== "chrome://new-tab-page/") {
  __throw("GROK_TASKSPACE_NOT_FRESH", "Grok TaskSpace page is not fresh");
}
await __page.goto(${JSON.stringify(GROK_APP_URL)}, { waitUntil: "domcontentloaded", timeout: __input.timeoutMs });
const __observation = await __pageObservation(__page);
if (!__observation || !__isGrokUrl(__observation.url)) __throw("GROK_URL_INVALID", "Grok initial page URL is invalid");
__emit({ ok: true, value: { resource: { provider: "grok", spaceId: __task.spaceId, pageLabel: __page.label, conversationUrl: __observation.url } } });
`
      break
    case 'prepare':
      body = `
const { page: __page } = await __originalPage(__input.resource);
let __observation = await __pageObservation(__page);
__assertFresh(__observation);
__observation = await __selectModel(__page, __input.request.modelLabel);
__assertFresh(__observation);
if (__input.request.modelLabel !== undefined && __observation.modelLabel !== __input.request.modelLabel) {
  __throw("GROK_MODEL_MISMATCH", "Grok model did not read back as requested");
}
const __composer = await __page.evaluate(__findComposer);
if (!__composer) __throw("GROK_COMPOSER_UNAVAILABLE", "Grok composer is unavailable or ambiguous");
await __page.fill(__composer, __input.request.prompt);
const __afterFill = await __pageObservation(__page);
__assertReady(__afterFill);
if (__afterFill.composerText !== __input.request.prompt) __throw("GROK_PROMPT_READBACK_MISMATCH", "Grok composer readback did not match the literal request");
if (!Array.isArray(__afterFill.messages) || __afterFill.messages.length !== 0) __throw("GROK_CONVERSATION_NOT_EMPTY", "Grok page changed before submission");
if (__input.request.modelLabel !== undefined && __afterFill.modelLabel !== __input.request.modelLabel) {
  __throw("GROK_MODEL_MISMATCH", "Grok model changed before submission");
}
__emit({ ok: true, value: __afterFill });
`
      break
    case 'submit':
      body = `
const { page: __page } = await __originalPage(__input.resource);
const __beforeSubmit = await __pageObservation(__page);
__assertReady(__beforeSubmit);
if (__beforeSubmit.composerText !== __input.prepared.prompt) __throw("GROK_PROMPT_READBACK_MISMATCH", "Grok composer changed after preparation");
if (__input.prepared.modelLabel !== undefined && __beforeSubmit.modelLabel !== __input.prepared.modelLabel) {
  __throw("GROK_MODEL_MISMATCH", "Grok model changed after preparation");
}
const __submit = await __page.evaluate(__findSubmit);
if (!__submit) __throw("GROK_SUBMIT_UNAVAILABLE", "Grok submit control is unavailable, disabled, or ambiguous");
await __page.click(__submit, { timeout: __input.timeoutMs, label: "submit Grok prompt" });
__emit({ ok: true, value: { submitted: true } });
`
      break
    case 'observe':
      body = `
const { page: __page } = await __originalPage(__input.resource);
const __observation = await __pageObservation(__page);
__emit({ ok: true, value: __observation });
`
      break
    case 'finish':
      body = `
const __task = await taskSpace(__input.resource.spaceId);
__assertAgentTask(__task);
if (__task.spaceId !== __input.resource.spaceId) __throw("GROK_TASKSPACE_MISMATCH", "Grok TaskSpace identity changed");
await __task.finish({ keep: [] });
__emit({ ok: true, value: { finished: true } });
`
      break
  }
  return `${scriptRuntime()}\nconst __input = ${data};\ntry {\n${helpers}\n${body}\n} catch (__error) { __fail(__error); }\n`
}

/**
 * Bounded Grok implementation of `GrokBrowserPort`.  It owns no controller
 * state or durable journal: the caller commits intent before `submit()` and
 * calls `finish()` only after it has completed its task.
 */
export class GrokEgoAdapter implements GrokBrowserPort {
  readonly #inspection: GrokPageInspectionInput
  readonly #stderrMaxBytes: number
  readonly #allocated = new Map<string, { readonly sessionId: string; readonly resource: GrokResource }>()
  readonly #allocating = new Map<string, Promise<GrokResource>>()
  readonly #prepared = new Map<string, PreparedDraft>()
  readonly #submitted = new Set<string>()
  readonly #finishing = new Set<string>()
  readonly #finished = new Set<string>()
  #lastEgoNotices: readonly string[] = []

  constructor(
    private readonly options: Required<Pick<GrokEgoAdapterOptions, 'executable' | 'cwd' | 'commandTimeoutMs' | 'stdoutMaxBytes'>>,
    private readonly runner: GrokEgoProcessRunner = runEgoProcess,
    challengeSelector?: string,
  ) {
    if (!isRecord(options)
      || typeof options.executable !== 'string' || !isAbsolute(options.executable)
      || typeof options.cwd !== 'string' || !isAbsolute(options.cwd)
      || !positiveInteger(options.commandTimeoutMs) || options.commandTimeoutMs > MAX_COMMAND_TIMEOUT_MS
      || !positiveInteger(options.stdoutMaxBytes) || options.stdoutMaxBytes > MAX_STDOUT_MAX_BYTES) {
      throw adapterError('GROK_CONFIG_INVALID', 'Grok Ego adapter configuration is invalid')
    }
    if (challengeSelector !== undefined && (!nonEmptyString(challengeSelector) || challengeSelector.length > 1_024)) {
      throw adapterError('GROK_CONFIG_INVALID', 'Grok challenge selector configuration is invalid')
    }
    this.#inspection = challengeSelector === undefined ? {} : { challengeSelector }
    this.#stderrMaxBytes = Math.max(DEFAULT_STDERR_MAX_BYTES, options.stdoutMaxBytes + STDERR_NOTICE_OVERHEAD_BYTES)
  }

  static create(options: GrokEgoAdapterOptions, runner: GrokEgoProcessRunner = runEgoProcess): GrokEgoAdapter {
    const stdoutMaxBytes = options?.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES
    return new GrokEgoAdapter({
      executable: options?.executable ?? '',
      cwd: options?.cwd ?? '',
      commandTimeoutMs: options?.commandTimeoutMs ?? 0,
      stdoutMaxBytes,
    }, runner, options?.challengeSelector)
  }

  get lastEgoNotices(): readonly string[] {
    return [...this.#lastEgoNotices]
  }

  async allocate(input: { readonly id: string; readonly sessionId: string }, signal?: AbortSignal): Promise<GrokResource> {
    assertAllocateInput(input)
    const existing = this.#allocated.get(input.id)
    if (existing !== undefined) {
      if (existing.sessionId !== input.sessionId) throw adapterError('GROK_ALLOCATION_CONFLICT', 'Grok run id already belongs to another session')
      return { ...existing.resource }
    }
    const inflight = this.#allocating.get(input.id)
    if (inflight !== undefined) return { ...(await inflight) }
    const allocation = (async (): Promise<GrokResource> => {
      const resource = parseAllocated(await this.#invoke('allocate', {
        taskName: `dsh-grok-web:${input.id}:${input.sessionId}`,
        timeoutMs: this.options.commandTimeoutMs,
        inspection: this.#inspection,
      }, signal))
      this.#allocated.set(input.id, { sessionId: input.sessionId, resource })
      return resource
    })()
    this.#allocating.set(input.id, allocation)
    try {
      return { ...(await allocation) }
    } finally {
      this.#allocating.delete(input.id)
    }
  }

  async prepare(
    resource: GrokResource,
    input: { readonly prompt: string; readonly modelLabel?: string },
    signal?: AbortSignal,
  ): Promise<GrokPageObservation> {
    assertResource(resource)
    assertPrepareInput(input)
    this.#assertActive(resource)
    const observation = parseObservation(await this.#invoke('prepare', {
      resource,
      request: input,
      timeoutMs: this.options.commandTimeoutMs,
      inspection: this.#inspection,
    }, signal))
    this.#assertPrepared(resource, input, observation)
    this.#prepared.set(resourceKey(resource), { ...input })
    return observation
  }

  async submit(resource: GrokResource, signal?: AbortSignal): Promise<void> {
    assertResource(resource)
    this.#assertActive(resource)
    const key = resourceKey(resource)
    const prepared = this.#prepared.get(key)
    if (prepared === undefined) throw adapterError('GROK_PREPARE_REQUIRED', 'Grok resource was not prepared in this adapter instance')
    if (this.#submitted.has(key)) throw adapterError('GROK_SUBMISSION_ALREADY_ATTEMPTED', 'Grok submission was already attempted')
    // Mark before the one process call: an interrupted call may still have
    // clicked, so retrying it would violate the at-most-once contract.
    this.#submitted.add(key)
    parseAcknowledgement(await this.#invoke('submit', {
      resource,
      prepared,
      timeoutMs: this.options.commandTimeoutMs,
      inspection: this.#inspection,
    }, signal), 'submit')
  }

  async observe(resource: GrokResource, signal?: AbortSignal): Promise<GrokPageObservation> {
    assertResource(resource)
    this.#assertActive(resource)
    return parseObservation(await this.#invoke('observe', {
      resource,
      timeoutMs: this.options.commandTimeoutMs,
      inspection: this.#inspection,
    }, signal))
  }

  async finish(resource: GrokResource): Promise<void> {
    assertResource(resource)
    const key = resourceKey(resource)
    if (this.#finished.has(key) || this.#finishing.has(key)) {
      throw adapterError('GROK_ALREADY_FINISHED', 'Grok TaskSpace was already finished')
    }
    this.#finishing.add(key)
    try {
      parseAcknowledgement(await this.#invoke('finish', { resource }, undefined), 'finish')
      this.#finished.add(key)
    } finally {
      this.#finishing.delete(key)
    }
  }

  #assertActive(resource: GrokResource): void {
    if (this.#finished.has(resourceKey(resource))) throw adapterError('GROK_ALREADY_FINISHED', 'Grok TaskSpace was already finished')
  }

  #assertPrepared(
    resource: GrokResource,
    input: { readonly prompt: string; readonly modelLabel?: string },
    observation: GrokPageObservation,
  ): void {
    if (observation.challenge) throw adapterError('GROK_CHALLENGE_REQUIRED', 'Grok requires manual challenge completion')
    if (observation.loginRequired || !observation.authenticated) throw adapterError('GROK_LOGIN_REQUIRED', 'Grok login is required before submission')
    if (observation.errors.length > 0) throw adapterError('GROK_PAGE_ERROR', 'Grok page shows a visible error')
    if (observation.composerCount !== 1) throw adapterError('GROK_COMPOSER_UNAVAILABLE', 'Grok has no unique visible composer')
    if (observation.messages.length !== 0) throw adapterError('GROK_CONVERSATION_NOT_EMPTY', 'Grok page is not a fresh empty conversation')
    if (observation.composerText !== input.prompt) throw adapterError('GROK_PROMPT_READBACK_MISMATCH', 'Grok composer readback did not match the literal request')
    if (input.modelLabel !== undefined && observation.modelLabel !== input.modelLabel) {
      throw adapterError('GROK_MODEL_MISMATCH', 'Grok model did not read back as requested')
    }
    if (!isGrokUrl(observation.url) || !isGrokUrl(resource.conversationUrl)) {
      throw adapterError('GROK_RESOURCE_INVALID', 'Grok browser resource is invalid')
    }
  }

  async #invoke(operation: GrokOperation, input: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    this.#lastEgoNotices = []
    let result: EgoProcessResult
    try {
      result = await this.runner({
        executable: this.options.executable,
        source: scriptFor(operation, input),
        cwd: this.options.cwd,
        timeoutMs: this.options.commandTimeoutMs,
        stdoutMaxBytes: this.options.stdoutMaxBytes,
        stderrMaxBytes: this.#stderrMaxBytes,
        signal,
      })
    } catch (caught) {
      if (caught instanceof GrokEgoAdapterError) throw caught
      if (caught instanceof EgoProcessError) {
        throw adapterError(`GROK_${caught.code}`, 'Ego browser command failed', caught.mayHaveLateEffects)
      }
      throw adapterError('GROK_EGO_PROCESS', 'Ego browser command failed')
    }
    const decoded = decodeTransportFrame(result, this.options.stdoutMaxBytes, this.#stderrMaxBytes)
    this.#lastEgoNotices = decoded.notices
    if (!decoded.frame.ok) throw adapterError(decoded.frame.error.code, decoded.frame.error.message)
    return decoded.frame.value
  }
}

/** Production factory; tests can inject a fake `GrokEgoProcessRunner`. */
export function createGrokEgoAdapter(
  options: GrokEgoAdapterOptions,
  runner: GrokEgoProcessRunner = runEgoProcess,
): GrokBrowserPort {
  return GrokEgoAdapter.create(options, runner)
}
