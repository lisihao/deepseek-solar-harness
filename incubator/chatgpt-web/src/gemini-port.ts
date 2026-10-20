import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

import {
  GEMINI_APP_URL,
  GEMINI_COMPOSER_SELECTOR,
  GEMINI_DEEP_RESEARCH_SELECTOR,
  GEMINI_MODEL_BUTTON_SELECTOR,
  GEMINI_MORE_TOOLS_SELECTOR,
  GEMINI_UPLOAD_TOOLS_SELECTOR,
  findUniqueGeminiControl,
  findUniqueGeminiTextSelector,
  inspectGeminiPage,
  inspectGeminiSelector,
  type GeminiPageObservation,
  type GeminiSelectorObservation,
} from './gemini-page.js'
import {
  type InsightArtifact,
  type InsightExternalResource,
  type InsightModelSelection,
  type InsightObservedSelection,
  type InsightStageOutcome,
  type InsightTemplate,
} from './insight-contract.js'
import { runEgoProcess } from './process.js'
import { EgoProcessError, type EgoProcessRequest, type EgoProcessResult } from './process-contract.js'

const GEMINI_PORT_FORMAT_VERSION = 1 as const
const FRAME_MARKER = '__DSH_SOLAR_GEMINI_PORT_FRAME__:'
const RECORD_MODE = 0o600
const DIRECTORY_MODE = 0o700
const STDERR_OVERHEAD_BYTES = 64 * 1024
const FRAME_OVERHEAD_BYTES = 256 * 1024

type JsonRecord = Record<string, unknown>
type GeminiPhase = 'plan' | 'research' | 'thinking'
type ScriptOperation = 'prepare-prompt' | 'prepare-research' | 'submit-prompt' | 'start-research' | 'observe'

/**
 * This deliberately accepts the broader Studio `phase` string structurally.
 * The implementation validates the fixed Gemini subset at the execution
 * boundary instead of forcing Studio callers to cast their request.
 */
export interface GeminiPortRequest {
  readonly runId: string
  readonly sessionId: string
  readonly nodeId: string
  readonly nodeKind: string
  readonly phase: string
  readonly commandId: string
  readonly resource: InsightExternalResource
  readonly requested: InsightModelSelection
  readonly template: InsightTemplate
  readonly renderedInput: string
  readonly assets: readonly InsightArtifact[]
  /** Optional to remain structurally compatible with StudioExternalPortRequest. */
  readonly signal?: AbortSignal
}

export interface GeminiVisibleQuotaSelector {
  /** A semantic, visible notice selector supplied after UI evidence exists. */
  readonly selector: string
  /** Exact stage-relevant wording which must be visibly present in that notice. */
  readonly requiredText: string
  readonly scope: 'Deep Research'
}

export interface GeminiThinkingSelectors {
  /** Visible control that opens the documented 低 / 中 / 高 choices. */
  readonly triggerSelector: string
  /** Selector matching those visible choices. */
  readonly optionSelector: string
  /** Selector that resolves to exactly the selected visible choice after click. */
  readonly selectedSelector: string
}

/**
 * Deep Research controls were not observed in the live read-only inspection.
 * They therefore have no invented default.  A host can provide exact,
 * reviewable semantic selectors and markers after an explicit UI observation.
 */
export interface GeminiSemanticSelectors {
  /** Unique visible normal-composer submit control. */
  readonly submitSelector?: string
  /** Exact visible receipt for the original submitted prompt. */
  readonly promptReceiptSelector?: string
  /** Visible marker that proves the Deep Research plan is ready. */
  readonly planReadyMarker?: string
  /** Unique visible control that starts approved Deep Research. */
  readonly researchStartSelector?: string
  /** Visible marker that proves a Deep Research report is complete. */
  readonly researchReportReadyMarker?: string
  /** Optional visible activity marker; it is used only for a no-active-effect quota proof. */
  readonly researchActivitySelector?: string
  /** Optional explicit visible quota proof.  No selector means no quota claim. */
  readonly visibleQuota?: GeminiVisibleQuotaSelector
  /** Required only when a thinking request selects an effort. */
  readonly thinking?: GeminiThinkingSelectors
}

export interface GeminiPortOptions {
  /** Plugin-owned state root; records are isolated below `gemini-port/`. */
  readonly root: string
  readonly executable: string
  readonly commandTimeoutMs: number
  readonly pollMs: number
  readonly waitMs: number
  readonly maxOutputBytes: number
  /** The Host owns TaskSpace allocation and must return its existing agent space. */
  readonly spaceForRun: (runId: string, signal: AbortSignal) => Promise<number>
  readonly semantics?: GeminiSemanticSelectors
}

export interface GeminiProcessRunner {
  (request: EgoProcessRequest): Promise<EgoProcessResult>
}

export interface GeminiPort {
  execute(request: GeminiPortRequest): Promise<InsightStageOutcome>
  observe(request: GeminiPortRequest): Promise<InsightStageOutcome>
}

export class GeminiPortError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'GeminiPortError'
  }
}

interface LocalPageResource {
  readonly spaceId: number
  readonly pageLabel: string
  /** URL seen before an external click.  Observation never navigates away from this page. */
  readonly initialUrl: string
}

interface GeminiIntentRecord {
  readonly formatVersion: 1
  readonly commandId: string
  readonly runId: string
  readonly sessionId: string
  readonly nodeId: string
  readonly nodeKind: string
  readonly phase: GeminiPhase
  readonly resource: InsightExternalResource
  readonly requested: InsightModelSelection
  readonly template: InsightTemplate
  readonly renderedInput: string
  /** Retained in full for reconstruction; the port never executes these values. */
  readonly assets: readonly unknown[]
  /** The receipt which must remain visible before a completion can be claimed. */
  readonly promptReceipt: string
  readonly local: LocalPageResource
  readonly observed: InsightObservedSelection
  readonly intentAt: string
}

interface ScriptSelection {
  readonly modelLabel?: string
  readonly effortLabel?: string
  readonly modeLabel?: string
}

interface ScriptSnapshot {
  readonly observation: GeminiPageObservation
  readonly semantic: {
    readonly promptReceipt?: GeminiSelectorObservation
    readonly planReady?: GeminiSelectorObservation
    readonly reportReady?: GeminiSelectorObservation
    readonly activity?: GeminiSelectorObservation
    readonly quota?: GeminiSelectorObservation
    readonly thinkingSelected?: GeminiSelectorObservation
  }
  readonly selection: ScriptSelection
}

interface ScriptInput {
  readonly local: LocalPageResource
  readonly request: {
    readonly phase: GeminiPhase
    readonly renderedInput: string
    readonly requested: InsightModelSelection
  }
  readonly semantics: GeminiSemanticSelectors
  readonly maxOutputBytes: number
  readonly commandTimeoutMs: number
  readonly promptReceipt?: string
}

function portError(code: string, message: string): GeminiPortError {
  return new GeminiPortError(code, message)
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwn(value: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { readonly code?: unknown }).code === code
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n')
}

function samePrompt(left: string, right: string): boolean {
  return normalizeNewlines(left) === normalizeNewlines(right)
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal
}

function phaseOf(value: string): GeminiPhase | undefined {
  return value === 'plan' || value === 'research' || value === 'thinking' ? value : undefined
}

function isGeminiResource(resource: unknown): resource is InsightExternalResource {
  return isRecord(resource)
    && resource.provider === 'gemini'
    && nonEmptyString(resource.id)
    && (resource.remoteId === undefined || typeof resource.remoteId === 'string')
    && (resource.url === undefined || typeof resource.url === 'string')
}

function optionalString(value: JsonRecord, key: string): string | undefined {
  const raw = value[key]
  return typeof raw === 'string' ? raw : undefined
}

function optionalBoolean(value: JsonRecord, key: string): boolean | undefined {
  const raw = value[key]
  return typeof raw === 'boolean' ? raw : undefined
}

function isGeminiUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      && (parsed.hostname === 'gemini.google.com' || parsed.hostname.endsWith('.gemini.google.com'))
  } catch {
    return false
  }
}

function boundedAdd(value: number, addition: number): number {
  return value > Number.MAX_SAFE_INTEGER - addition ? Number.MAX_SAFE_INTEGER : value + addition
}

function jsonHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function pageLabel(runId: string, nodeId: string, phase: GeminiPhase): string {
  const runHash = jsonHash(runId).slice(0, 16)
  const nodeHash = jsonHash(nodeId).slice(0, 12)
  if (phase === 'plan' || phase === 'research') return `gemini-plan-research-${runHash}-${nodeHash}`
  return `gemini-thinking-${runHash}-${nodeHash}`
}

function copyResource(resource: InsightExternalResource, url?: string): InsightExternalResource {
  return {
    provider: resource.provider,
    id: resource.id,
    ...(resource.remoteId === undefined ? {} : { remoteId: resource.remoteId }),
    ...(url === undefined ? (resource.url === undefined ? {} : { url: resource.url }) : { url }),
  }
}

function requestedObserved(requested: InsightModelSelection, selection: ScriptSelection): InsightObservedSelection {
  if (selection.modelLabel !== requested.modelLabel) {
    throw portError('GEMINI_MODEL_MISMATCH', 'Gemini did not read back the exact requested model label')
  }
  if (requested.effortLabel !== undefined && selection.effortLabel === undefined) {
    throw portError('GEMINI_EFFORT_READBACK_UNAVAILABLE', 'Gemini reasoning effort readback is unavailable')
  }
  if (requested.modeLabel !== undefined && selection.modeLabel !== requested.modeLabel) {
    throw portError('GEMINI_MODE_MISMATCH', 'Gemini did not read back the exact requested mode label')
  }
  return {
    availability: 'observed',
    modelLabel: selection.modelLabel,
    ...(selection.effortLabel === undefined ? {} : { effortLabel: selection.effortLabel }),
    ...(selection.modeLabel === undefined ? {} : { modeLabel: selection.modeLabel }),
  }
}

function scriptRuntime(): string {
  return `
const __frameMarker = ${JSON.stringify(FRAME_MARKER)};
const __publicError = Symbol("gemini-port-public-error");
const __throw = (code, message) => { const error = new Error(message); error.code = code; error[__publicError] = true; throw error; };
const __emit = (value) => process.stdout.write(__frameMarker + JSON.stringify(value) + "\\n");
const __fail = (error) => {
  const code = error && typeof error.code === "string" ? error.code : "GEMINI_EGO_SCRIPT";
  const message = error && error[__publicError] === true && /^GEMINI_[A-Z0-9_]+$/.test(code) && typeof error.message === "string"
    ? error.message
    : "Gemini browser command failed";
  __emit({ ok: false, error: { code, message } });
};
const __assertAgent = (task) => {
  if (!task || task.ownership !== "agent") __throw("GEMINI_USER_CONTROL", "TaskSpace is not agent-owned");
};
const __isGeminiUrl = (value) => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && (parsed.hostname === "gemini.google.com" || parsed.hostname.endsWith(".gemini.google.com"));
  } catch { return false; }
};
const __exactText = ${String(findUniqueGeminiTextSelector)};
const __uniqueControl = ${String(findUniqueGeminiControl)};
const __inspect = ${String(inspectGeminiPage)};
const __inspectSelector = ${String(inspectGeminiSelector)};
`
}

function scriptFor(operation: ScriptOperation, input: ScriptInput): string {
  const data = JSON.stringify(input)
  const semanticState = `
const __semanticState = async () => {
  const __result = {};
  const __read = async (key, selector) => {
    if (typeof selector !== "string" || selector.length === 0) return;
    __result[key] = await __page.evaluate(__inspectSelector, selector);
  };
  await __read("promptReceipt", __input.semantics.promptReceiptSelector);
  await __read("planReady", __input.semantics.planReadyMarker);
  await __read("reportReady", __input.semantics.researchReportReadyMarker);
  await __read("activity", __input.semantics.researchActivitySelector);
  await __read("quota", __input.semantics.visibleQuota && __input.semantics.visibleQuota.selector);
  await __read("thinkingSelected", __input.semantics.thinking && __input.semantics.thinking.selectedSelector);
  return __result;
};
`
  const selectModel = `
const __modelButton = ${JSON.stringify(GEMINI_MODEL_BUTTON_SELECTOR)};
const __openModelMenu = async () => {
  const __buttons = await __page.evaluate(__inspectSelector, __modelButton);
  if (!__buttons || __buttons.count !== 1) __throw("GEMINI_MODEL_CONTROL_UNAVAILABLE", "Gemini model selector is unavailable or ambiguous");
  await __page.click(__modelButton, { timeout: __input.commandTimeoutMs, label: "open Gemini model selector" });
  const __observed = await __page.evaluate(__inspect);
  if (!__observed || typeof __observed.selectedModelLabel !== "string") {
    __throw("GEMINI_MODEL_READBACK_UNAVAILABLE", "Gemini selected model could not be read back");
  }
  return __observed;
};
const __closeModelMenu = async () => {
  try { await __page.press(__modelButton, "Escape", { timeout: __input.commandTimeoutMs }); } catch { /* selection was already closed */ }
};
const __selectModel = async (requested) => {
  let __current = await __openModelMenu();
  if (__current.selectedModelLabel !== requested) {
    const __target = await __page.evaluate(__exactText, {
      selector: '[role="menuitemradio"],[role="option"],[role="menuitem"]',
      text: requested,
    });
    if (!__target) __throw("GEMINI_MODEL_SELECTION_UNAVAILABLE", "Requested exact Gemini model label is unavailable");
    await __page.click(__target, { timeout: __input.commandTimeoutMs, label: "select requested Gemini model" });
    __current = await __page.evaluate(__inspect);
    if (!__current || typeof __current.selectedModelLabel !== "string") {
      // Sites commonly close a menu after selection. Reopen only to read the
      // selected visible choice; this never submits a request.
      __current = await __openModelMenu();
    }
  }
  if (__current.selectedModelLabel !== requested) __throw("GEMINI_MODEL_MISMATCH", "Gemini selected model does not match the request");
  await __closeModelMenu();
  return __current.selectedModelLabel;
};
const __readCurrentModel = async () => {
  const __current = await __openModelMenu();
  const __label = __current.selectedModelLabel;
  await __closeModelMenu();
  return __label;
};
`
  const selectDeepResearch = `
const __openTools = async () => {
  await __page.click(${JSON.stringify(GEMINI_UPLOAD_TOOLS_SELECTOR)}, { timeout: __input.commandTimeoutMs, label: "open Gemini upload and tools" });
  await __page.click(${JSON.stringify(GEMINI_MORE_TOOLS_SELECTOR)}, { timeout: __input.commandTimeoutMs, label: "open Gemini more tools" });
};
const __readDeepResearch = async () => {
  const __observed = await __page.evaluate(__inspect);
  if (!__observed || __observed.deepResearchCount !== 1 || typeof __observed.deepResearchChecked !== "boolean") {
    __throw("GEMINI_DEEP_RESEARCH_READBACK_UNAVAILABLE", "Gemini Deep Research state could not be read back");
  }
  return __observed.deepResearchChecked;
};
const __selectDeepResearch = async () => {
  await __openTools();
  let __checked = await __readDeepResearch();
  if (!__checked) {
    const __target = await __page.evaluate(__exactText, { selector: ${JSON.stringify(GEMINI_DEEP_RESEARCH_SELECTOR)}, text: "Deep Research" });
    if (!__target) __throw("GEMINI_DEEP_RESEARCH_UNAVAILABLE", "Gemini Deep Research control is unavailable or disabled");
    await __page.click(__target, { timeout: __input.commandTimeoutMs, label: "enable Gemini Deep Research" });
    await __openTools();
    __checked = await __readDeepResearch();
  }
  if (!__checked) __throw("GEMINI_DEEP_RESEARCH_MISMATCH", "Gemini Deep Research was not enabled");
  return "Deep Research";
};
const __readDeepResearchSelection = async () => {
  await __openTools();
  const __checked = await __readDeepResearch();
  if (!__checked) __throw("GEMINI_DEEP_RESEARCH_MISMATCH", "Gemini Deep Research is not enabled on the original page");
  return "Deep Research";
};
`
  const selectEffort = `
const __effortDisplay = (requested) => requested === "high" ? "高" : undefined;
const __selectEffort = async (requested) => {
  const __display = __effortDisplay(requested);
  if (!__display) __throw("GEMINI_EFFORT_UNSUPPORTED", "Only the observed high to 高 Gemini effort mapping is supported");
  const __thinking = __input.semantics.thinking;
  if (!__thinking || typeof __thinking.triggerSelector !== "string" || typeof __thinking.optionSelector !== "string" || typeof __thinking.selectedSelector !== "string") {
    __throw("GEMINI_EFFORT_SELECTORS_UNCONFIGURED", "Gemini thinking selectors are required for effort selection");
  }
  const __trigger = await __page.evaluate(__uniqueControl, __thinking.triggerSelector);
  if (!__trigger) __throw("GEMINI_EFFORT_CONTROL_UNAVAILABLE", "Gemini thinking control is unavailable or ambiguous");
  await __page.click(__trigger, { timeout: __input.commandTimeoutMs, label: "open Gemini thinking level selector" });
  const __target = await __page.evaluate(__exactText, { selector: __thinking.optionSelector, text: __display });
  if (!__target) __throw("GEMINI_EFFORT_SELECTION_UNAVAILABLE", "Requested Gemini thinking level is unavailable");
  await __page.click(__target, { timeout: __input.commandTimeoutMs, label: "select Gemini thinking level" });
  const __selected = await __page.evaluate(__inspectSelector, __thinking.selectedSelector);
  if (!__selected || __selected.count !== 1 || !Array.isArray(__selected.texts) || __selected.texts.length !== 1 || __selected.texts[0] !== __display) {
    __throw("GEMINI_EFFORT_MISMATCH", "Gemini thinking level did not read back as 高");
  }
  return __display;
};
`
  const common = `
const __task = await taskSpace(__input.local.spaceId);
__assertAgent(__task);
const __page = __task.page(__input.local.pageLabel);
const __bounded = (value) => {
  if (typeof value === "string" && new TextEncoder().encode(value).length > __input.maxOutputBytes) {
    __throw("GEMINI_OUTPUT_TOO_LARGE", "Gemini visible output exceeds the configured full-retention limit");
  }
};
const __reply = async (selection = {}) => {
  const __observation = await __page.evaluate(__inspect);
  if (!__observation || typeof __observation.url !== "string") __throw("GEMINI_PAGE_OBSERVATION_INVALID", "Gemini page observation is invalid");
  __bounded(__observation.responseMarkdown);
  __emit({ ok: true, value: { observation: __observation, semantic: await __semanticState(), selection } });
};
`
  let body: string
  switch (operation) {
    case 'prepare-prompt':
      body = `
${common}
const __beforeUrl = await __page.url();
if (__beforeUrl !== "about:blank" && !String(__beforeUrl).startsWith("about:blank#")) {
  __throw("GEMINI_PAGE_NOT_FRESH", "Gemini logical-node page is not a fresh blank page");
}
await __page.goto(${JSON.stringify(GEMINI_APP_URL)}, { waitUntil: "domcontentloaded", timeout: __input.commandTimeoutMs });
await __page.waitForSelector(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)}, { state: "visible", timeout: __input.commandTimeoutMs });
let __initial = await __page.evaluate(__inspect);
if (__initial.loginRequired) __throw("GEMINI_LOGIN_REQUIRED", "Gemini login is required");
if (__initial.visibleError) __throw("GEMINI_PAGE_ERROR", "Gemini page reported a visible error");
if (__initial.composerCount !== 1 || __initial.composerText !== "") __throw("GEMINI_COMPOSER_NOT_EMPTY", "Gemini logical-node page has no unique empty composer");
const __model = await __selectModel(__input.request.requested.modelLabel);
let __mode;
if (__input.request.requested.modeLabel !== undefined) {
  if (__input.request.requested.modeLabel !== "Deep Research") __throw("GEMINI_MODE_UNSUPPORTED", "Only the observed Deep Research mode can be selected");
  __mode = await __selectDeepResearch();
}
let __effort;
if (__input.request.requested.effortLabel !== undefined) __effort = await __selectEffort(__input.request.requested.effortLabel);
await __page.fill(${JSON.stringify(GEMINI_COMPOSER_SELECTOR)}, __input.request.renderedInput, { clearFirst: true });
const __afterFill = await __page.evaluate(__inspect);
if (__afterFill.composerText !== __input.request.renderedInput) __throw("GEMINI_PROMPT_READBACK_MISMATCH", "Gemini composer readback did not match the full request");
await __reply({ modelLabel: __model, ...( __effort === undefined ? {} : { effortLabel: __effort }), ...( __mode === undefined ? {} : { modeLabel: __mode }) });
`
      break
    case 'prepare-research':
      body = `
${common}
const __currentUrl = await __page.url();
if (!__isGeminiUrl(__currentUrl)) __throw("GEMINI_RESOURCE_CHANGED", "Gemini original page no longer has a Gemini URL");
const __observation = await __page.evaluate(__inspect);
if (__observation.loginRequired) __throw("GEMINI_LOGIN_REQUIRED", "Gemini login is required");
if (__observation.visibleError) __throw("GEMINI_PAGE_ERROR", "Gemini page reported a visible error");
const __model = await __readCurrentModel();
if (__model !== __input.request.requested.modelLabel) __throw("GEMINI_MODEL_MISMATCH", "Gemini model changed after the plan");
if (__input.request.requested.modeLabel !== "Deep Research") __throw("GEMINI_MODE_UNSUPPORTED", "Deep Research is required for the research stage");
const __mode = await __readDeepResearchSelection();
const __semantic = await __semanticState();
if (!__semantic.planReady || __semantic.planReady.count !== 1) __throw("GEMINI_PLAN_READY_MARKER_MISSING", "Configured Gemini plan-ready marker is absent or ambiguous");
const __receipts = __semantic.promptReceipt && Array.isArray(__semantic.promptReceipt.texts) ? __semantic.promptReceipt.texts : [];
if (__receipts.filter((value) => value === __input.promptReceipt).length !== 1) __throw("GEMINI_PROMPT_RECEIPT_MISMATCH", "Gemini original plan prompt receipt is unavailable or ambiguous");
__bounded(__observation.responseMarkdown);
__emit({ ok: true, value: { observation: __observation, semantic: __semantic, selection: { modelLabel: __model, modeLabel: __mode } } });
`
      break
    case 'submit-prompt':
      body = `
${common}
const __currentUrl = await __page.url();
if (!__isGeminiUrl(__currentUrl)) __throw("GEMINI_RESOURCE_CHANGED", "Gemini original page no longer has a Gemini URL");
const __submit = await __page.evaluate(__uniqueControl, __input.semantics.submitSelector);
if (!__submit) __throw("GEMINI_SUBMIT_CONTROL_UNAVAILABLE", "Configured Gemini submit control is unavailable or ambiguous");
await __page.click(__submit, { timeout: __input.commandTimeoutMs, label: "submit Gemini prompt" });
await __reply();
`
      break
    case 'start-research':
      body = `
${common}
const __currentUrl = await __page.url();
if (!__isGeminiUrl(__currentUrl)) __throw("GEMINI_RESOURCE_CHANGED", "Gemini original page no longer has a Gemini URL");
const __start = await __page.evaluate(__uniqueControl, __input.semantics.researchStartSelector);
if (!__start) __throw("GEMINI_RESEARCH_START_CONTROL_UNAVAILABLE", "Configured Gemini research-start control is unavailable or ambiguous");
await __page.click(__start, { timeout: __input.commandTimeoutMs, label: "start approved Gemini Deep Research" });
await __reply();
`
      break
    case 'observe':
      body = `
${common}
const __currentUrl = await __page.url();
if (!__isGeminiUrl(__currentUrl)) __throw("GEMINI_RESOURCE_CHANGED", "Gemini original page no longer has a Gemini URL");
await __reply();
`
      break
  }
  return `${scriptRuntime()}\nconst __input = ${data};\ntry {\n${semanticState}\n${selectModel}\n${selectDeepResearch}\n${selectEffort}\n${body}\n} catch (__error) { __fail(__error); }\n`
}

function parseSelectorObservation(value: unknown): GeminiSelectorObservation {
  if (!isRecord(value) || !nonNegativeInteger(value.count) || !Array.isArray(value.texts) || !value.texts.every((item) => typeof item === 'string')) {
    throw portError('GEMINI_EGO_FRAME', 'Gemini selector observation is invalid')
  }
  return { count: value.count, texts: [...value.texts] }
}

function parsePageObservation(value: unknown): GeminiPageObservation {
  if (!isRecord(value)
    || typeof value.url !== 'string'
    || typeof value.loginRequired !== 'boolean'
    || !nonNegativeInteger(value.composerCount)
    || typeof value.composerText !== 'string'
    || !nonNegativeInteger(value.modelButtonCount)
    || !nonNegativeInteger(value.deepResearchCount)
    || !Array.isArray(value.citations)
    || !value.citations.every((item) => typeof item === 'string')) {
    throw portError('GEMINI_EGO_FRAME', 'Gemini page observation is invalid')
  }
  for (const key of ['modelButtonLabel', 'selectedModelLabel', 'responseText', 'responseMarkdown', 'visibleError'] as const) {
    if (hasOwn(value, key) && value[key] !== undefined && typeof value[key] !== 'string') {
      throw portError('GEMINI_EGO_FRAME', 'Gemini page observation contains an invalid text field')
    }
  }
  if (hasOwn(value, 'deepResearchChecked') && value.deepResearchChecked !== undefined && typeof value.deepResearchChecked !== 'boolean') {
    throw portError('GEMINI_EGO_FRAME', 'Gemini page observation contains an invalid Deep Research state')
  }
  return {
    url: value.url,
    loginRequired: value.loginRequired,
    composerCount: value.composerCount,
    composerText: value.composerText,
    modelButtonCount: value.modelButtonCount,
    ...(optionalString(value, 'modelButtonLabel') === undefined ? {} : { modelButtonLabel: optionalString(value, 'modelButtonLabel') }),
    ...(optionalString(value, 'selectedModelLabel') === undefined ? {} : { selectedModelLabel: optionalString(value, 'selectedModelLabel') }),
    deepResearchCount: value.deepResearchCount,
    ...(optionalBoolean(value, 'deepResearchChecked') === undefined ? {} : { deepResearchChecked: optionalBoolean(value, 'deepResearchChecked') }),
    ...(optionalString(value, 'responseText') === undefined ? {} : { responseText: optionalString(value, 'responseText') }),
    ...(optionalString(value, 'responseMarkdown') === undefined ? {} : { responseMarkdown: optionalString(value, 'responseMarkdown') }),
    citations: [...value.citations],
    ...(optionalString(value, 'visibleError') === undefined ? {} : { visibleError: optionalString(value, 'visibleError') }),
  }
}

function parseSelection(value: unknown): ScriptSelection {
  if (!isRecord(value)) throw portError('GEMINI_EGO_FRAME', 'Gemini selection readback is invalid')
  for (const key of ['modelLabel', 'effortLabel', 'modeLabel'] as const) {
    if (hasOwn(value, key) && value[key] !== undefined && typeof value[key] !== 'string') {
      throw portError('GEMINI_EGO_FRAME', 'Gemini selection readback is invalid')
    }
  }
  return {
    ...(optionalString(value, 'modelLabel') === undefined ? {} : { modelLabel: optionalString(value, 'modelLabel') }),
    ...(optionalString(value, 'effortLabel') === undefined ? {} : { effortLabel: optionalString(value, 'effortLabel') }),
    ...(optionalString(value, 'modeLabel') === undefined ? {} : { modeLabel: optionalString(value, 'modeLabel') }),
  }
}

function parseSnapshot(value: unknown): ScriptSnapshot {
  if (!isRecord(value) || !hasOwn(value, 'observation') || !hasOwn(value, 'semantic') || !hasOwn(value, 'selection') || !isRecord(value.semantic)) {
    throw portError('GEMINI_EGO_FRAME', 'Gemini browser frame is invalid')
  }
  const semantic = value.semantic
  const optional = (key: keyof ScriptSnapshot['semantic']): GeminiSelectorObservation | undefined => {
    const raw = semantic[key]
    return raw === undefined ? undefined : parseSelectorObservation(raw)
  }
  return {
    observation: parsePageObservation(value.observation),
    semantic: {
      ...(optional('promptReceipt') === undefined ? {} : { promptReceipt: optional('promptReceipt') }),
      ...(optional('planReady') === undefined ? {} : { planReady: optional('planReady') }),
      ...(optional('reportReady') === undefined ? {} : { reportReady: optional('reportReady') }),
      ...(optional('activity') === undefined ? {} : { activity: optional('activity') }),
      ...(optional('quota') === undefined ? {} : { quota: optional('quota') }),
      ...(optional('thinkingSelected') === undefined ? {} : { thinkingSelected: optional('thinkingSelected') }),
    },
    selection: parseSelection(value.selection),
  }
}

function decodeFrame(result: EgoProcessResult, maxBytes: number): unknown {
  if (result.stderrTruncated || result.stderr.length > 0 || Buffer.byteLength(result.stdout, 'utf8') > maxBytes) {
    throw portError('GEMINI_EGO_FRAME', 'Gemini browser transport output is invalid or exceeds its bound')
  }
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length !== 1 || !lines[0]!.startsWith(FRAME_MARKER)) {
    throw portError('GEMINI_EGO_FRAME', 'Gemini browser emitted an unexpected frame')
  }
  let frame: unknown
  try {
    frame = JSON.parse(lines[0]!.slice(FRAME_MARKER.length)) as unknown
  } catch {
    throw portError('GEMINI_EGO_FRAME', 'Gemini browser emitted malformed JSON')
  }
  if (!isRecord(frame) || typeof frame.ok !== 'boolean') throw portError('GEMINI_EGO_FRAME', 'Gemini browser emitted an invalid frame')
  if (frame.ok) {
    if (!hasOwn(frame, 'value')) throw portError('GEMINI_EGO_FRAME', 'Gemini browser success frame is missing a value')
    return frame.value
  }
  if (!isRecord(frame.error) || !nonEmptyString(frame.error.code) || !nonEmptyString(frame.error.message)) {
    throw portError('GEMINI_EGO_FRAME', 'Gemini browser error frame is invalid')
  }
  throw portError(frame.error.code, frame.error.message)
}

function assertRequest(request: GeminiPortRequest): void {
  if (!isRecord(request)
    || !nonEmptyString(request.runId)
    || !nonEmptyString(request.sessionId)
    || !nonEmptyString(request.nodeId)
    || !nonEmptyString(request.nodeKind)
    || !nonEmptyString(request.phase)
    || !nonEmptyString(request.commandId)
    || !isRecord(request.resource)
    || !isGeminiResource(request.resource)
    || !isRecord(request.requested)
    || request.requested.provider !== 'gemini'
    || !nonEmptyString(request.requested.modelLabel)
    || (request.requested.modelId !== undefined && !nonEmptyString(request.requested.modelId))
    || (request.requested.effortLabel !== undefined && !nonEmptyString(request.requested.effortLabel))
    || (request.requested.modeLabel !== undefined && !nonEmptyString(request.requested.modeLabel))
    || !isRecord(request.template)
    || request.template.formatVersion !== 1
    || !nonEmptyString(request.template.id)
    || !nonEmptyString(request.template.version)
    || typeof request.template.text !== 'string'
    || !nonEmptyString(request.template.hash)
    || typeof request.renderedInput !== 'string'
    || !Array.isArray(request.assets)
    || (request.signal !== undefined && typeof request.signal.aborted !== 'boolean')) {
    throw portError('GEMINI_REQUEST_INVALID', 'Gemini port request is invalid')
  }
}

function parseIntent(value: unknown): GeminiIntentRecord {
  if (!isRecord(value)
    || value.formatVersion !== GEMINI_PORT_FORMAT_VERSION
    || !nonEmptyString(value.commandId)
    || !nonEmptyString(value.runId)
    || !nonEmptyString(value.sessionId)
    || !nonEmptyString(value.nodeId)
    || !nonEmptyString(value.nodeKind)
    || phaseOf(typeof value.phase === 'string' ? value.phase : '') === undefined
    || !isGeminiResource(value.resource)
    || !isRecord(value.requested)
    || value.requested.provider !== 'gemini'
    || !nonEmptyString(value.requested.modelLabel)
    || !isRecord(value.template)
    || value.template.formatVersion !== 1
    || !nonEmptyString(value.template.id)
    || !nonEmptyString(value.template.version)
    || typeof value.template.text !== 'string'
    || !nonEmptyString(value.template.hash)
    || typeof value.renderedInput !== 'string'
    || !Array.isArray(value.assets)
    || typeof value.promptReceipt !== 'string'
    || !isRecord(value.local)
    || !positiveInteger(value.local.spaceId)
    || !nonEmptyString(value.local.pageLabel)
    || !nonEmptyString(value.local.initialUrl)
    || !isRecord(value.observed)
    || (value.observed.availability !== 'observed' && value.observed.availability !== 'not-exposed')
    || !nonEmptyString(value.intentAt)) {
    throw portError('GEMINI_INTENT_INVALID', 'Gemini durable intent record is invalid')
  }
  const phase = phaseOf(optionalString(value, 'phase') ?? '')
  if (phase === undefined) throw portError('GEMINI_INTENT_INVALID', 'Gemini durable intent phase is invalid')
  return {
    formatVersion: 1,
    commandId: value.commandId,
    runId: value.runId,
    sessionId: value.sessionId,
    nodeId: value.nodeId,
    nodeKind: value.nodeKind,
    phase,
    resource: copyResource(value.resource),
    requested: {
      provider: 'gemini',
      modelLabel: value.requested.modelLabel,
      ...(typeof value.requested.modelId === 'string' ? { modelId: value.requested.modelId } : {}),
      ...(typeof value.requested.effortLabel === 'string' ? { effortLabel: value.requested.effortLabel } : {}),
      ...(typeof value.requested.modeLabel === 'string' ? { modeLabel: value.requested.modeLabel } : {}),
    },
    template: {
      formatVersion: 1,
      id: value.template.id,
      version: value.template.version,
      text: value.template.text,
      hash: value.template.hash,
    },
    assets: [...value.assets],
    renderedInput: value.renderedInput,
    promptReceipt: value.promptReceipt,
    local: { spaceId: value.local.spaceId, pageLabel: value.local.pageLabel, initialUrl: value.local.initialUrl },
    observed: {
      availability: value.observed.availability,
      ...(optionalString(value.observed, 'providerLabel') === undefined ? {} : { providerLabel: optionalString(value.observed, 'providerLabel') }),
      ...(optionalString(value.observed, 'modelLabel') === undefined ? {} : { modelLabel: optionalString(value.observed, 'modelLabel') }),
      ...(optionalString(value.observed, 'effortLabel') === undefined ? {} : { effortLabel: optionalString(value.observed, 'effortLabel') }),
      ...(optionalString(value.observed, 'modeLabel') === undefined ? {} : { modeLabel: optionalString(value.observed, 'modeLabel') }),
    },
    intentAt: value.intentAt,
  }
}

function sameIntent(left: GeminiIntentRecord, right: GeminiIntentRecord): boolean {
  return left.commandId === right.commandId
    && left.runId === right.runId
    && left.sessionId === right.sessionId
    && left.nodeId === right.nodeId
    && left.nodeKind === right.nodeKind
    && left.phase === right.phase
    && left.resource.provider === right.resource.provider
    && left.resource.id === right.resource.id
    && left.renderedInput === right.renderedInput
    && left.local.spaceId === right.local.spaceId
    && left.local.pageLabel === right.local.pageLabel
}

class GeminiPortImpl implements GeminiPort {
  readonly #intentsRoot: string
  readonly #frameMaxBytes: number
  readonly #stderrMaxBytes: number
  readonly #spaces = new Map<string, number>()

  constructor(
    private readonly options: Required<Omit<GeminiPortOptions, 'semantics'>> & { readonly semantics: GeminiSemanticSelectors },
    private readonly runner: GeminiProcessRunner,
  ) {
    this.#intentsRoot = join(options.root, 'gemini-port', 'intents')
    this.#frameMaxBytes = boundedAdd(options.maxOutputBytes, FRAME_OVERHEAD_BYTES)
    this.#stderrMaxBytes = Math.max(STDERR_OVERHEAD_BYTES, boundedAdd(this.#frameMaxBytes, STDERR_OVERHEAD_BYTES))
  }

  async execute(request: GeminiPortRequest): Promise<InsightStageOutcome> {
    const phase = phaseOf(request.phase)
    if (phase === undefined) return this.rejected(request, 'GEMINI_PHASE_UNSUPPORTED', 'Gemini port does not execute this phase')
    if (request.requested.provider !== 'gemini' || request.resource.provider !== 'gemini') {
      return this.rejected(request, 'GEMINI_PROVIDER_UNSUPPORTED', 'Gemini port requires Gemini provider and resource identities')
    }
    const signal = requestSignal(request.signal)
    if (signal.aborted) return this.unknown(request, 'GEMINI_ABORTED_BEFORE_DISPATCH')
    try {
      assertRequest(request)
      if ((phase === 'plan' || phase === 'research') && request.requested.modeLabel !== 'Deep Research') {
        return this.unknown(request, 'GEMINI_DEEP_RESEARCH_MODE_REQUIRED')
      }
      const existing = await this.readIntent(request.commandId)
      if (existing !== undefined) {
        return this.unknown(request, 'GEMINI_INTENT_ALREADY_DURABLE_OBSERVE_ORIGINAL_RESOURCE', existing)
      }
      const missing = this.missingSemantics(phase, request)
      if (missing.length > 0) {
        return this.rejected(
          request,
          `GEMINI_${phase.toUpperCase()}_SEMANTICS_UNCONFIGURED`,
          `Required Gemini semantic configuration is missing: ${missing.join(', ')}`,
        )
      }
      if (phase === 'research') return await this.startResearch(request, signal)
      return await this.submitPrompt(request, phase, signal)
    } catch (error) {
      return this.unknown(request, this.errorReason(error))
    }
  }

  async observe(request: GeminiPortRequest): Promise<InsightStageOutcome> {
    const phase = phaseOf(request.phase)
    if (phase === undefined) return this.rejected(request, 'GEMINI_PHASE_UNSUPPORTED', 'Gemini port does not observe this phase')
    if (request.requested.provider !== 'gemini' || request.resource.provider !== 'gemini') {
      return this.rejected(request, 'GEMINI_PROVIDER_UNSUPPORTED', 'Gemini port requires Gemini provider and resource identities')
    }
    try {
      assertRequest(request)
      const signal = requestSignal(request.signal)
      const intent = await this.readIntent(request.commandId)
      if (intent === undefined) {
        // Observation is deliberately non-admitting. In particular, it never
        // starts a research click merely because a plan is present or unknown.
        return this.unknown(request, phase === 'research' ? 'GEMINI_RESEARCH_NOT_DISPATCHED' : 'GEMINI_INTENT_NOT_FOUND')
      }
      if (intent.phase !== phase) return this.unknown(request, 'GEMINI_INTENT_PHASE_CONFLICT', intent)
      return this.waitForCompletion(request, intent, signal)
    } catch (error) {
      return this.unknown(request, this.errorReason(error))
    }
  }

  private async submitPrompt(request: GeminiPortRequest, phase: Exclude<GeminiPhase, 'research'>, signal: AbortSignal): Promise<InsightStageOutcome> {
    const spaceId = await this.resolveSpace(request, signal)
    const local: LocalPageResource = {
      spaceId,
      pageLabel: pageLabel(request.runId, request.nodeId, phase),
      initialUrl: GEMINI_APP_URL,
    }
    const prepared = await this.invoke('prepare-prompt', {
      local,
      request: { phase, renderedInput: request.renderedInput, requested: request.requested },
      semantics: this.options.semantics,
      maxOutputBytes: this.options.maxOutputBytes,
      commandTimeoutMs: this.options.commandTimeoutMs,
    }, signal)
    const observed = requestedObserved(request.requested, prepared.selection)
    const resource = copyResource(request.resource, prepared.observation.url)
    const quota = this.quotaOutcome(request, resource, prepared, true)
    if (quota !== undefined) return quota
    const intent: GeminiIntentRecord = {
      formatVersion: 1,
      commandId: request.commandId,
      runId: request.runId,
      sessionId: request.sessionId,
      nodeId: request.nodeId,
      nodeKind: request.nodeKind,
      phase,
      resource,
      requested: { ...request.requested },
      template: { ...request.template },
      renderedInput: request.renderedInput,
      assets: [...request.assets],
      promptReceipt: request.renderedInput,
      local: { ...local, initialUrl: prepared.observation.url },
      observed,
      intentAt: new Date().toISOString(),
    }
    const durable = await this.persistIntent(intent)
    await this.invoke('submit-prompt', this.scriptInput(durable), signal)
    return this.waitForCompletion(request, durable, signal)
  }

  private async startResearch(request: GeminiPortRequest, signal: AbortSignal): Promise<InsightStageOutcome> {
    const plan = await this.findPlanIntent(request)
    if (plan === undefined) return this.unknown(request, 'GEMINI_PLAN_RESOURCE_NOT_FOUND')
    const prepared = await this.invoke('prepare-research', {
      ...this.scriptInput(plan),
      request: { phase: 'research', renderedInput: request.renderedInput, requested: request.requested },
      promptReceipt: plan.promptReceipt,
    }, signal)
    const observed = requestedObserved(request.requested, prepared.selection)
    const resource = copyResource(request.resource, prepared.observation.url)
    const quota = this.quotaOutcome(request, resource, prepared, false)
    if (quota !== undefined) return quota
    const intent: GeminiIntentRecord = {
      formatVersion: 1,
      commandId: request.commandId,
      runId: request.runId,
      sessionId: request.sessionId,
      nodeId: request.nodeId,
      nodeKind: request.nodeKind,
      phase: 'research',
      resource,
      requested: { ...request.requested },
      template: { ...request.template },
      renderedInput: request.renderedInput,
      assets: [...request.assets],
      promptReceipt: plan.promptReceipt,
      local: { ...plan.local },
      observed,
      intentAt: new Date().toISOString(),
    }
    const durable = await this.persistIntent(intent)
    await this.invoke('start-research', this.scriptInput(durable), signal)
    return this.waitForCompletion(request, durable, signal)
  }

  private async waitForCompletion(request: GeminiPortRequest, intent: GeminiIntentRecord, signal: AbortSignal): Promise<InsightStageOutcome> {
    const deadline = Date.now() + this.options.waitMs
    let previous: string | undefined
    let stable = 0
    let observationCount = 0
    while (true) {
      if (signal.aborted) return this.unknown(request, 'GEMINI_ABORTED_AFTER_DURABLE_INTENT', intent)
      let snapshot: ScriptSnapshot
      try {
        snapshot = await this.invoke('observe', this.scriptInput(intent), signal)
      } catch (error) {
        return this.unknown(request, this.errorReason(error), intent)
      }
      const resource = copyResource(intent.resource, snapshot.observation.url)
      const quota = this.quotaOutcome(request, resource, snapshot, false)
      if (quota !== undefined) return quota
      const candidate = this.completionCandidate(intent, snapshot)
      if (candidate !== undefined) {
        const byteLength = Buffer.byteLength(candidate, 'utf8')
        if (byteLength > this.options.maxOutputBytes) return this.unknown(request, 'GEMINI_OUTPUT_TOO_LARGE', intent, snapshot.observation.url)
        const signature = `${snapshot.observation.url}\u0000${candidate}\u0000${snapshot.observation.citations.join('\u0000')}`
        stable = signature === previous ? stable + 1 : 1
        previous = signature
        if (stable >= 2) return this.complete(intent, resource, candidate, snapshot)
      } else {
        stable = 0
        previous = undefined
      }
      observationCount += 1
      if (observationCount >= 2 && Date.now() >= deadline) {
        return this.unknown(request, `GEMINI_${intent.phase.toUpperCase()}_PENDING_OR_UNOBSERVED`, intent, snapshot.observation.url)
      }
      if (this.options.pollMs > 0) await wait(this.options.pollMs)
    }
  }

  private completionCandidate(intent: GeminiIntentRecord, snapshot: ScriptSnapshot): string | undefined {
    const observation = snapshot.observation
    if (!isGeminiUrl(observation.url)) return undefined
    if (observation.loginRequired || observation.visibleError !== undefined || observation.responseMarkdown === undefined || observation.responseMarkdown.length === 0) {
      return undefined
    }
    const receipt = snapshot.semantic.promptReceipt
    if (receipt === undefined || receipt.texts.filter((text) => samePrompt(text, intent.promptReceipt)).length !== 1) return undefined
    if (intent.phase === 'plan' && snapshot.semantic.planReady?.count !== 1) return undefined
    if (intent.phase === 'research' && snapshot.semantic.reportReady?.count !== 1) return undefined
    return observation.responseMarkdown
  }

  private complete(intent: GeminiIntentRecord, resource: InsightExternalResource, markdown: string, snapshot: ScriptSnapshot): InsightStageOutcome {
    const activity = snapshot.semantic.activity?.texts.filter((text) => text.length > 0) ?? []
    const phaseSource = intent.phase === 'plan'
      ? 'Gemini webpage visible Deep Research plan'
      : intent.phase === 'research'
        ? 'Gemini webpage visible Deep Research report'
        : 'Gemini webpage visible thinking response'
    return {
      kind: 'complete',
      resource,
      observed: intent.observed,
      artifact: {
        text: markdown,
        provenance: {
          provider: 'gemini',
          source: phaseSource,
          visibleEvidence: [
            `URL: ${snapshot.observation.url}`,
            ...(intent.observed.modelLabel === undefined ? [] : [`Model: ${intent.observed.modelLabel}`]),
            ...(intent.observed.effortLabel === undefined ? [] : [`Thinking level: ${intent.observed.effortLabel}`]),
            ...(intent.observed.modeLabel === undefined ? [] : [`Mode: ${intent.observed.modeLabel}`]),
            ...activity.map((text) => `Visible research activity: ${text}`),
          ],
          citations: [...snapshot.observation.citations],
          limitations: [
            'Only visible webpage output, sources, and configured visible activity were retained.',
            'Hidden reasoning and thinking-overlay content were not collected.',
          ],
        },
      },
    }
  }

  private quotaOutcome(
    request: GeminiPortRequest,
    resource: InsightExternalResource,
    snapshot: ScriptSnapshot,
    beforeSubmission: boolean,
  ): Extract<InsightStageOutcome, { readonly kind: 'quota-exhausted' }> | undefined {
    const quota = this.options.semantics.visibleQuota
    if (quota === undefined || quota.scope !== 'Deep Research' || request.requested.modeLabel !== 'Deep Research') return undefined
    const observed = snapshot.semantic.quota
    if (observed === undefined || observed.count !== 1 || !observed.texts.some((text) => text.includes(quota.requiredText))) return undefined
    const activity = snapshot.semantic.activity
    if (!beforeSubmission && (activity === undefined || activity.count !== 0)) return undefined
    return {
      kind: 'quota-exhausted',
      resource,
      evidence: observed.texts.join('\n'),
      certainty: 'no-active-effect',
    }
  }

  private missingSemantics(phase: GeminiPhase, request: GeminiPortRequest): string[] {
    const semantics = this.options.semantics
    const missing: string[] = []
    if (phase === 'plan') {
      if (!nonEmptyString(semantics.submitSelector)) missing.push('submitSelector')
      if (!nonEmptyString(semantics.promptReceiptSelector)) missing.push('promptReceiptSelector')
      if (!nonEmptyString(semantics.planReadyMarker)) missing.push('planReadyMarker')
    } else if (phase === 'research') {
      if (!nonEmptyString(semantics.promptReceiptSelector)) missing.push('promptReceiptSelector')
      if (!nonEmptyString(semantics.researchStartSelector)) missing.push('researchStartSelector')
      if (!nonEmptyString(semantics.researchReportReadyMarker)) missing.push('researchReportReadyMarker')
    } else {
      if (!nonEmptyString(semantics.submitSelector)) missing.push('submitSelector')
      if (!nonEmptyString(semantics.promptReceiptSelector)) missing.push('promptReceiptSelector')
    }
    if (request.requested.effortLabel !== undefined) {
      const thinking = semantics.thinking
      if (!thinking || !nonEmptyString(thinking.triggerSelector) || !nonEmptyString(thinking.optionSelector) || !nonEmptyString(thinking.selectedSelector)) {
        missing.push('thinking')
      }
    }
    return missing
  }

  private scriptInput(intent: GeminiIntentRecord): ScriptInput {
    return {
      local: { ...intent.local },
      request: {
        phase: intent.phase,
        renderedInput: intent.renderedInput,
        requested: { ...intent.requested },
      },
      semantics: this.options.semantics,
      maxOutputBytes: this.options.maxOutputBytes,
      commandTimeoutMs: this.options.commandTimeoutMs,
      promptReceipt: intent.promptReceipt,
    }
  }

  private async invoke(operation: ScriptOperation, input: ScriptInput, signal: AbortSignal): Promise<ScriptSnapshot> {
    await mkdir(this.options.root, { recursive: true, mode: DIRECTORY_MODE })
    let result: EgoProcessResult
    try {
      result = await this.runner({
        executable: this.options.executable,
        source: scriptFor(operation, input),
        cwd: this.options.root,
        timeoutMs: this.options.commandTimeoutMs,
        stdoutMaxBytes: this.#frameMaxBytes,
        stderrMaxBytes: this.#stderrMaxBytes,
        signal,
      })
    } catch (error) {
      if (error instanceof EgoProcessError) throw portError(`GEMINI_CLI_${error.code}`, 'Gemini browser command did not yield a reliable receipt')
      if (error instanceof GeminiPortError) throw error
      throw portError('GEMINI_CLI_UNKNOWN', 'Gemini browser command did not yield a reliable receipt')
    }
    return parseSnapshot(decodeFrame(result, this.#frameMaxBytes))
  }

  private async ensureIntentsRoot(): Promise<void> {
    await mkdir(this.#intentsRoot, { recursive: true, mode: DIRECTORY_MODE })
  }

  private intentPath(commandId: string): string {
    return join(this.#intentsRoot, `${jsonHash(commandId)}.json`)
  }

  private async readIntent(commandId: string): Promise<GeminiIntentRecord | undefined> {
    try {
      const raw = await readFile(this.intentPath(commandId), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        throw portError('GEMINI_INTENT_INVALID', 'Gemini durable intent record is not valid JSON')
      }
      const record = parseIntent(parsed)
      if (record.commandId !== commandId) throw portError('GEMINI_INTENT_INVALID', 'Gemini durable intent record has a command mismatch')
      return record
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
  }

  private async persistIntent(intent: GeminiIntentRecord): Promise<GeminiIntentRecord> {
    await this.ensureIntentsRoot()
    const path = this.intentPath(intent.commandId)
    try {
      await writeFile(path, `${JSON.stringify(intent)}\n`, { encoding: 'utf8', mode: RECORD_MODE, flag: 'wx' })
      return intent
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      const existing = await this.readIntent(intent.commandId)
      if (existing === undefined || !sameIntent(existing, intent)) {
        throw portError('GEMINI_COMMAND_CONFLICT', 'Gemini command id already has a different durable intent')
      }
      return existing
    }
  }

  private async findPlanIntent(request: GeminiPortRequest): Promise<GeminiIntentRecord | undefined> {
    await this.ensureIntentsRoot()
    const entries = await readdir(this.#intentsRoot, { withFileTypes: true })
    const candidates: GeminiIntentRecord[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const path = join(this.#intentsRoot, entry.name)
      const raw = await readFile(path, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        throw portError('GEMINI_INTENT_INVALID', 'Gemini durable intent record is not valid JSON')
      }
      const record = parseIntent(parsed)
      if (record.phase === 'plan' && record.runId === request.runId && record.sessionId === request.sessionId) candidates.push(record)
    }
    if (candidates.length === 0) return undefined
    const matchingResource = candidates.filter((candidate) => candidate.resource.id === request.resource.id
      || (request.resource.url !== undefined && candidate.resource.url === request.resource.url))
    if (matchingResource.length === 1) return matchingResource[0]
    if (matchingResource.length > 1 || candidates.length > 1) {
      throw portError('GEMINI_PLAN_RESOURCE_AMBIGUOUS', 'Gemini research cannot choose among multiple plan resources')
    }
    return candidates[0]
  }

  private async resolveSpace(request: GeminiPortRequest, signal: AbortSignal): Promise<number> {
    const key = `${request.sessionId}\u0000${request.runId}`
    const cached = this.#spaces.get(key)
    if (cached !== undefined) return cached
    await this.ensureIntentsRoot()
    const entries = await readdir(this.#intentsRoot, { withFileTypes: true })
    const durableSpaces = new Set<number>()
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const raw = await readFile(join(this.#intentsRoot, entry.name), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw) as unknown
      } catch {
        throw portError('GEMINI_INTENT_INVALID', 'Gemini durable intent record is not valid JSON')
      }
      const record = parseIntent(parsed)
      if (record.runId === request.runId && record.sessionId === request.sessionId) durableSpaces.add(record.local.spaceId)
    }
    if (durableSpaces.size > 1) throw portError('GEMINI_TASKSPACE_CONFLICT', 'Gemini workflow has conflicting durable TaskSpace identities')
    const durable = durableSpaces.values().next().value
    if (durable !== undefined) {
      this.#spaces.set(key, durable)
      return durable
    }
    const created = await this.options.spaceForRun(request.runId, signal)
    if (!positiveInteger(created)) throw portError('GEMINI_TASKSPACE_INVALID', 'Host returned an invalid Gemini TaskSpace id')
    this.#spaces.set(key, created)
    return created
  }

  private unknown(
    request: GeminiPortRequest,
    reason: string,
    intent?: GeminiIntentRecord,
    observedUrl?: string,
  ): Extract<InsightStageOutcome, { readonly kind: 'unknown' }> {
    const resource = copyResource(intent?.resource ?? request.resource, observedUrl)
    return {
      kind: 'unknown',
      resource,
      reason,
      ...(intent === undefined ? {} : { observed: intent.observed }),
    }
  }

  private rejected(
    request: GeminiPortRequest,
    code: string,
    reason: string,
  ): Extract<InsightStageOutcome, { readonly kind: 'failed' }> {
    return {
      kind: 'failed',
      resource: copyResource(request.resource),
      code,
      reason,
      certainty: 'no-active-effect',
    }
  }

  private errorReason(error: unknown): string {
    if (error instanceof GeminiPortError) return error.code
    return 'GEMINI_PORT_UNKNOWN'
  }
}

/**
 * A fixed Gemini Web port.  The optional runner is a focused test seam; the
 * production default is the shared bounded `runEgoProcess` transport.
 */
export function createGeminiPort(options: GeminiPortOptions, runner: GeminiProcessRunner = runEgoProcess): GeminiPort {
  if (!isRecord(options)
    || typeof options.root !== 'string'
    || !isAbsolute(options.root)
    || options.root === parse(options.root).root
    || !nonEmptyString(options.executable)
    || !positiveInteger(options.commandTimeoutMs)
    || !nonNegativeInteger(options.pollMs)
    || !nonNegativeInteger(options.waitMs)
    || !positiveInteger(options.maxOutputBytes)
    || typeof options.spaceForRun !== 'function') {
    throw portError('GEMINI_PORT_CONFIG_INVALID', 'Gemini port configuration is invalid')
  }
  const semantics = options.semantics ?? {}
  return new GeminiPortImpl({
    root: options.root,
    executable: options.executable,
    commandTimeoutMs: options.commandTimeoutMs,
    pollMs: options.pollMs,
    waitMs: options.waitMs,
    maxOutputBytes: options.maxOutputBytes,
    spaceForRun: options.spaceForRun,
    semantics,
  }, runner)
}
