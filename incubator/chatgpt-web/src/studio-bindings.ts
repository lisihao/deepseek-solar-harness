import { matchesWebEffort } from './web-selection.js'
import { createHash } from 'node:crypto'
import { isAbsolute, join, parse } from 'node:path'

import type { ResidentApi } from '@lisihao/dsh-solar-native-resident/contracts'

import { WebController } from './controller.js'
import { EgoWebAdapter } from './ego-adapter.js'
import { FlowSpaces, type FlowSpacesOptions } from './flow-space.js'
import {
  createGeminiPort,
  type GeminiPort,
  type GeminiPortOptions,
  type GeminiSemanticSelectors,
} from './gemini-port.js'
import type {
  InsightExternalResource,
  InsightModelSelection,
  InsightObservedSelection,
  InsightStageOutcome,
} from './insight-contract.js'
import {
  createNativeClarifier,
  type NativeClarifier,
  type NativeClarifierOptions,
} from './native-clarifier.js'
import { WebRunStore, type WebRunRecord, type WebRunRequest } from './store.js'
import type {
  StudioBoundPorts,
  StudioClarifyPortRequest,
  StudioExternalPortRequest,
} from './studio-provider.js'

const WEB_RENDERED_INPUT_MAX_BYTES = 128 * 1024
const WEB_STABLE_OBSERVATIONS = 2
const WEB_FRAME_OVERHEAD_BYTES = 128 * 1024
const MAX_GEMINI_WAIT_MS = 3_600_000
const NATIVE_CLARIFIER_MAX_WAIT_MS = 60_000
const CHATGPT_SEARCH_MODE = 'Web search and analysis'

type StudioWebController = Pick<WebController, 'read' | 'start' | 'observe' | 'dispose'>
type StudioFlowSpaces = Pick<FlowSpaces, 'forRun' | 'finish'>

export interface StudioWebControllerFactoryInput {
  /** Durable state root for exactly one deterministic external Web stage. */
  readonly root: string
  readonly executable: string
  readonly commandTimeoutMs: number
  readonly runTimeoutMs: number
  readonly pollMs: number
  readonly maxOutputBytes: number
  readonly stageId: string
  /** Undefined for a read-only observation controller. */
  readonly spaceId?: number
  readonly createPage: boolean
  readonly retainSpace: boolean
}

/** Focused local seams so the binding can be verified without a browser or model call. */
export interface StudioBoundPortsFactories {
  readonly createNativeClarifier?: (options: NativeClarifierOptions) => NativeClarifier
  readonly createGeminiPort?: (options: GeminiPortOptions) => GeminiPort
  readonly createFlowSpaces?: (options: FlowSpacesOptions) => StudioFlowSpaces
  readonly createWebController?: (input: StudioWebControllerFactoryInput) => StudioWebController
}

export interface StudioBoundPortsOptions {
  /** Plugin-owned durable root supplied by the Host binding. */
  readonly root: string
  readonly executable: string
  readonly commandTimeoutMs: number
  readonly runTimeoutMs: number
  readonly pollMs: number
  readonly maxOutputBytes: number
  readonly resident: () => ResidentApi
  /** Appends the complete request before the corresponding execution effect. */
  readonly logRequest: (sessionId: string, text: string) => Promise<void>
  readonly askQuestions: StudioBoundPorts['askQuestions']
  readonly confirmPlan: StudioBoundPorts['confirmPlan']
  /** Fixed selector snapshot for every Gemini run created by this binding. */
  readonly geminiSemantics?: GeminiSemanticSelectors
  /**
   * Resolves the immutable selector snapshot stored with one Studio execution.
   * The result is cached by run and session, so mutable preferences are never
   * re-read halfway through that execution.
   */
  readonly semanticsForRun?: (runId: string, sessionId: string) => Promise<GeminiSemanticSelectors | undefined>
  /** Resolves the immutable Deep Research observation window for this run. */
  readonly waitMsForRun?: (runId: string, sessionId: string) => Promise<number>
  readonly factories?: StudioBoundPortsFactories
}

export type StudioBoundPortsBinding = StudioBoundPorts & {
  finished(runId: string, sessionId: string): Promise<void>
  /** Stops only local waits and browser processes owned by this binding. */
  dispose(): void
}

type ControllerEntry = {
  readonly controller: StudioWebController
  readonly canCreatePage: boolean
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function asReason(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback
}

function errorCode(error: unknown, fallback: string): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { readonly code?: unknown }).code === 'string'
    ? (error as { readonly code: string }).code
    : fallback
}

function boundedAdd(value: number, extra: number): number {
  return value > Number.MAX_SAFE_INTEGER - extra ? Number.MAX_SAFE_INTEGER : value + extra
}

/** A deterministic UUID lets a stage be reopened without replacing its receipt. */
function stageUuid(commandId: string): string {
  const characters = createHash('sha256').update(commandId, 'utf8').digest('hex').slice(0, 32).split('')
  characters[12] = '5'
  const variant = Number.parseInt(characters[16] ?? '8', 16)
  characters[16] = ((variant & 0x3) | 0x8).toString(16)
  return [
    characters.slice(0, 8).join(''),
    characters.slice(8, 12).join(''),
    characters.slice(12, 16).join(''),
    characters.slice(16, 20).join(''),
    characters.slice(20, 32).join(''),
  ].join('-')
}

function copiedSemantics(value: GeminiSemanticSelectors | undefined): GeminiSemanticSelectors | undefined {
  if (value === undefined) return undefined
  return {
    ...value,
    ...(value.visibleQuota === undefined ? {} : { visibleQuota: { ...value.visibleQuota } }),
    ...(value.thinking === undefined ? {} : { thinking: { ...value.thinking } }),
  }
}

function requestedSelectionLog(renderedInput: string, requested: InsightModelSelection): string {
  return [
    '[studio requested selection]',
    JSON.stringify(requested),
    '[studio rendered input]',
    renderedInput,
  ].join('\n')
}

function linkedSignal(shutdown: AbortSignal, request: AbortSignal | undefined): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const inputs = request === undefined || request === shutdown ? [shutdown] : [shutdown, request]
  const listeners: Array<readonly [AbortSignal, () => void]> = []
  const abort = (input: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(input.reason)
  }
  for (const input of inputs) {
    if (input.aborted) abort(input)
    else {
      const listener = () => abort(input)
      input.addEventListener('abort', listener, { once: true })
      listeners.push([input, listener])
    }
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [input, listener] of listeners) input.removeEventListener('abort', listener)
    },
  }
}

function externalResource(request: StudioExternalPortRequest, stageId: string, record?: WebRunRecord): InsightExternalResource {
  return {
    provider: 'chatgpt',
    id: request.resource.id,
    remoteId: stageId,
    ...(record?.resource?.conversationUrl === undefined
      ? (request.resource.url === undefined ? {} : { url: request.resource.url })
      : { url: record.resource.conversationUrl }),
  }
}

function failed(
  resource: InsightExternalResource,
  code: string,
  reason: string,
  certainty: 'no-active-effect' | 'settled' = 'no-active-effect',
): Extract<InsightStageOutcome, { readonly kind: 'failed' }> {
  return { kind: 'failed', resource, code, reason, certainty }
}

function unknown(
  resource: InsightExternalResource,
  reason: string,
  observed?: InsightObservedSelection,
): Extract<InsightStageOutcome, { readonly kind: 'unknown' }> {
  return { kind: 'unknown', resource, reason, ...(observed === undefined ? {} : { observed }) }
}

function markdownCitations(markdown: string): readonly string[] {
  const citations = new Set<string>()
  for (const match of markdown.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
    const value = match[0].replace(/[),.;:!?]+$/u, '')
    try {
      const url = new URL(value)
      if (url.protocol === 'https:' || url.protocol === 'http:') citations.add(value)
    } catch {
      // A visible non-URL fragment is retained in the full Markdown, but it is
      // not misrepresented as a citation.
    }
  }
  return [...citations]
}

function observedSelection(
  record: WebRunRecord,
  request: StudioExternalPortRequest,
  webSearch: boolean,
): InsightObservedSelection | undefined {
  const observed = record.observed
  if (observed?.modelLabel === undefined || (request.requested.modelLabel !== '' && observed.modelLabel !== request.requested.modelLabel)) return undefined
  if (!matchesWebEffort(request.requested.effortLabel, observed)) return undefined
  if (webSearch && observed.webSearchActive !== true) return undefined
  return {
    availability: 'observed',
    modelLabel: observed.modelLabel,
    ...(observed.effortLabel === undefined ? {} : { effortLabel: observed.effortLabel }),
    ...(observed.effortId === undefined ? {} : { effortId: observed.effortId }),
    ...(webSearch ? { modeLabel: request.requested.modeLabel } : {}),
  }
}

function recordReason(record: WebRunRecord, fallback: string): string {
  if (record.error !== undefined) return `${record.error.code}: ${record.error.message}`
  return fallback
}

function outputFromRecord(
  request: StudioExternalPortRequest,
  stageId: string,
  record: WebRunRecord,
  webSearch: boolean,
): InsightStageOutcome {
  const resource = externalResource(request, stageId, record)
  if (record.stage === 'completed') {
    const observed = observedSelection(record, request, webSearch)
    if (record.output === undefined || observed === undefined) {
      return unknown(resource, 'WEB_COMPLETED_RECEIPT_INCOMPLETE')
    }
    return {
      kind: 'complete',
      resource,
      observed,
      artifact: {
        text: record.output.markdown,
        provenance: {
          provider: 'chatgpt',
          source: 'ChatGPT webpage visible Markdown response',
          visibleEvidence: [
            ...(record.resource?.conversationUrl === undefined ? [] : [`Conversation URL: ${record.resource.conversationUrl}`]),
            `Model: ${observed.modelLabel ?? ''}`,
            ...(observed.effortLabel === undefined ? [] : [`Reasoning effort: ${observed.effortLabel}`]),
            ...(observed.effortId === undefined ? [] : [`Reasoning identifier: ${observed.effortId}`]),
            ...(webSearch ? ['Web search: enabled'] : []),
          ],
          citations: markdownCitations(record.output.markdown),
          limitations: [
            'Only the complete visible ChatGPT Markdown and visible HTTP(S) links in that Markdown were retained.',
            'Hidden reasoning and unrendered source metadata were not collected.',
          ],
        },
      },
    }
  }
  if (record.stage === 'blocked') {
    return failed(resource, record.error?.code ?? 'WEB_BLOCKED', recordReason(record, 'ChatGPT preflight blocked the request before submission.'), 'no-active-effect')
  }
  if (record.stage === 'failed') {
    return failed(resource, record.error?.code ?? 'WEB_FAILED', recordReason(record, 'ChatGPT browser run reached a known terminal failure.'), 'settled')
  }
  if (record.stage === 'cancelled') {
    return failed(resource, record.error?.code ?? 'WEB_CANCELLED', recordReason(record, 'ChatGPT run was cancelled before a confirmed submission.'), 'no-active-effect')
  }
  return unknown(resource, recordReason(record, `ChatGPT run remains ${record.stage}; the original resource was not retried.`), observedSelection(record, request, webSearch))
}

function defaultWebController(input: StudioWebControllerFactoryInput): StudioWebController {
  const browser = new EgoWebAdapter({
    executable: input.executable,
    cwd: input.root,
    commandTimeoutMs: input.commandTimeoutMs,
    stdoutMaxBytes: boundedAdd(input.maxOutputBytes, WEB_FRAME_OVERHEAD_BYTES),
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    createPage: input.createPage,
    retainSpace: input.retainSpace,
  })
  return new WebController(
    new WebRunStore(input.root),
    browser,
    {
      timeoutMs: input.runTimeoutMs,
      pollMs: input.pollMs,
      stableObservations: WEB_STABLE_OBSERVATIONS,
      maxOutputBytes: input.maxOutputBytes,
    },
  )
}

function validateOptions(options: StudioBoundPortsOptions): void {
  if (!isAbsolute(options.root) || options.root === parse(options.root).root) {
    throw new Error('STUDIO_BINDINGS_ROOT_INVALID: root must be a non-root absolute path.')
  }
  if (!isAbsolute(options.executable) || !nonEmpty(options.executable)) {
    throw new Error('STUDIO_BINDINGS_EXECUTABLE_INVALID: executable must be an absolute path.')
  }
  if (!positiveInteger(options.commandTimeoutMs)
    || !positiveInteger(options.runTimeoutMs)
    || !nonNegativeInteger(options.pollMs)
    || !positiveInteger(options.maxOutputBytes)) {
    throw new Error('STUDIO_BINDINGS_TIMEOUT_INVALID: timeout and output bounds are invalid.')
  }
  if (typeof options.resident !== 'function'
    || typeof options.logRequest !== 'function'
    || typeof options.askQuestions !== 'function'
    || typeof options.confirmPlan !== 'function') {
    throw new Error('STUDIO_BINDINGS_PORT_INVALID: required Host ports are unavailable.')
  }
  if (options.geminiSemantics !== undefined && options.semanticsForRun !== undefined) {
    throw new Error('STUDIO_BINDINGS_GEMINI_SEMANTICS_AMBIGUOUS: provide one Gemini selector source.')
  }
}

function chatGptRequest(request: StudioExternalPortRequest, enforceInputLimit: boolean):
  | { readonly request: WebRunRequest; readonly webSearch: boolean }
  | { readonly code: string; readonly reason: string } {
  if (!nonEmpty(request.commandId)) return { code: 'STUDIO_WEB_COMMAND_INVALID', reason: 'ChatGPT Web stage has no command id.' }
  if (request.requested.provider !== 'chatgpt' || request.resource.provider !== 'chatgpt') {
    return { code: 'STUDIO_WEB_PROVIDER_UNSUPPORTED', reason: 'ChatGPT Web stage requires ChatGPT requested and resource identities.' }
  }
  if (!nonEmpty(request.requested.modelLabel) && !(request.nodeKind === 'chatgpt-web' && request.requested.modelLabel === '')) {
    return { code: 'STUDIO_WEB_MODEL_INVALID', reason: 'ChatGPT Web stage requires an exact non-empty requested model label.' }
  }
  const fallbackSearch = (request.nodeKind === 'gemini-research' || request.nodeKind === 'gemini-thinking')
    && request.phase === 'search'
  const webSearch = request.nodeKind === 'chatgpt-search' || request.nodeKind === 'chatgpt-review' || fallbackSearch
  const expectedPhase = request.nodeKind === 'chatgpt-web'
    ? 'web'
    : request.nodeKind === 'chatgpt-search'
      ? 'search'
      : request.nodeKind === 'chatgpt-review'
        ? 'review'
        : fallbackSearch
          ? 'search'
          : undefined
  if (expectedPhase === undefined || request.phase !== expectedPhase) {
    return { code: 'STUDIO_WEB_STAGE_UNSUPPORTED', reason: 'ChatGPT Web stage kind and phase are not a supported pair.' }
  }
  if (webSearch && request.requested.modeLabel !== CHATGPT_SEARCH_MODE) {
    return { code: 'STUDIO_WEB_MODE_UNSUPPORTED', reason: `ChatGPT search stages require the exact mode label ${CHATGPT_SEARCH_MODE}.` }
  }
  if (!webSearch && request.requested.modeLabel !== undefined) {
    return { code: 'STUDIO_WEB_MODE_UNSUPPORTED', reason: 'Ordinary ChatGPT Web stages cannot silently substitute a requested mode.' }
  }
  if (enforceInputLimit && Buffer.byteLength(request.renderedInput, 'utf8') > WEB_RENDERED_INPUT_MAX_BYTES) {
    return {
      code: 'WEB_RENDERED_INPUT_TOO_LARGE',
      reason: `Complete rendered input exceeds the ${WEB_RENDERED_INPUT_MAX_BYTES}-byte Web limit and was not truncated or submitted.`,
    }
  }
  return {
    request: {
      prompt: request.renderedInput,
      ...(request.requested.modelLabel === '' ? {} : { modelLabel: request.requested.modelLabel }),
      ...(request.requested.effortLabel === undefined ? {} : { effortLabel: request.requested.effortLabel }),
      webSearch,
    },
    webSearch,
  }
}

function isChatGptStage(request: StudioExternalPortRequest): boolean {
  return request.nodeKind === 'chatgpt-web'
    || request.nodeKind === 'chatgpt-search'
    || request.nodeKind === 'chatgpt-review'
    || (request.requested.provider === 'chatgpt'
      && (request.nodeKind === 'gemini-research' || request.nodeKind === 'gemini-thinking')
      && request.phase === 'search')
}

function sameStageResource(request: StudioExternalPortRequest, stageId: string): boolean {
  return request.resource.remoteId === undefined || request.resource.remoteId === stageId
}

/**
 * Binds Studio's durable graph phases to the existing native, Gemini, and
 * ChatGPT page boundaries. It never uses an API/model fallback and it never
 * resumes an uncertain browser effect by creating a replacement page.
 */
export function createStudioBoundPorts(options: StudioBoundPortsOptions): StudioBoundPortsBinding {
  validateOptions(options)
  const factories = options.factories ?? {}
  const makeNative = factories.createNativeClarifier ?? createNativeClarifier
  const makeGemini = factories.createGeminiPort ?? createGeminiPort
  const makeSpaces = factories.createFlowSpaces ?? (input => new FlowSpaces(input))
  const makeController = factories.createWebController ?? defaultWebController
  const spaces = makeSpaces({
    root: options.root,
    executable: options.executable,
    commandTimeoutMs: options.commandTimeoutMs,
  })
  const shutdown = new AbortController()
  const controllers = new Map<string, ControllerEntry>()
  const allControllers = new Set<StudioWebController>()
  const nativePorts = new Map<string, NativeClarifier>()
  const geminiPorts = new Map<string, Promise<GeminiPort>>()
  const finishingFlows = new Map<string, Promise<void>>()
  let disposed = false

  const stageRoot = (stageId: string): string => join(options.root, 'external-web', stageId)

  const createController = (stageId: string, spaceId: number | undefined): StudioWebController => {
    const controller = makeController({
      root: stageRoot(stageId),
      executable: options.executable,
      commandTimeoutMs: options.commandTimeoutMs,
      runTimeoutMs: options.runTimeoutMs,
      pollMs: options.pollMs,
      maxOutputBytes: options.maxOutputBytes,
      stageId,
      ...(spaceId === undefined ? {} : { spaceId }),
      createPage: spaceId !== undefined,
      retainSpace: spaceId !== undefined,
    })
    allControllers.add(controller)
    return controller
  }

  const controllerForObserve = (stageId: string): StudioWebController => {
    const existing = controllers.get(stageId)
    if (existing !== undefined) return existing.controller
    const controller = createController(stageId, undefined)
    controllers.set(stageId, { controller, canCreatePage: false })
    return controller
  }

  const controllerForExecute = (stageId: string, spaceId: number): StudioWebController => {
    const existing = controllers.get(stageId)
    if (existing?.canCreatePage) return existing.controller
    const controller = createController(stageId, spaceId)
    controllers.set(stageId, { controller, canCreatePage: true })
    return controller
  }

  const nativeFor = (request: StudioClarifyPortRequest | StudioExternalPortRequest): NativeClarifier => {
    const existing = nativePorts.get(request.commandId)
    if (existing !== undefined) return existing
    const requested = { ...request.requested }
    const port = makeNative({
      root: options.root,
      resident: options.resident,
      // Native clarifier's own contract caps local observation at one minute.
      // A longer Studio/Gemini research window must never change that boundary.
      waitMs: Math.min(options.runTimeoutMs, NATIVE_CLARIFIER_MAX_WAIT_MS),
      pollMs: options.pollMs === 0 ? 1 : options.pollMs,
      logRequest: async (sessionId, actualPrompt) => options.logRequest(sessionId, requestedSelectionLog(actualPrompt, requested)),
    })
    nativePorts.set(request.commandId, port)
    return port
  }

  const geminiFor = (request: StudioExternalPortRequest): Promise<GeminiPort> => {
    const key = `${request.runId}\u0000${request.sessionId}`
    const existing = geminiPorts.get(key)
    if (existing !== undefined) return existing
    const created = (async (): Promise<GeminiPort> => {
      const [semantics, waitMs] = await Promise.all([
        options.semanticsForRun === undefined
          ? Promise.resolve(copiedSemantics(options.geminiSemantics))
          : options.semanticsForRun(request.runId, request.sessionId).then(copiedSemantics),
        options.waitMsForRun === undefined
          ? Promise.resolve(options.runTimeoutMs)
          : options.waitMsForRun(request.runId, request.sessionId),
      ])
      if (!positiveInteger(waitMs) || waitMs > MAX_GEMINI_WAIT_MS) {
        throw new Error(`STUDIO_GEMINI_WAIT_INVALID: Gemini waitMs must be an integer between 1 and ${MAX_GEMINI_WAIT_MS}.`)
      }
      return makeGemini({
        root: options.root,
        executable: options.executable,
        commandTimeoutMs: options.commandTimeoutMs,
        pollMs: options.pollMs,
        waitMs,
        maxOutputBytes: options.maxOutputBytes,
        spaceForRun: (runId, signal) => spaces.forRun(runId, signal),
        ...(semantics === undefined ? {} : { semantics }),
      })
    })()
    geminiPorts.set(key, created)
    return created
  }

  const unavailable = (resource: InsightExternalResource): Extract<InsightStageOutcome, { readonly kind: 'failed' }> =>
    failed(resource, 'STUDIO_BINDING_DISPOSED', 'Studio binding has been disposed; no new local or remote effect was started.', 'no-active-effect')

  const runChatGpt = async (request: StudioExternalPortRequest, observeOnly: boolean): Promise<InsightStageOutcome> => {
    const stageId = stageUuid(request.commandId)
    if (!sameStageResource(request, stageId)) {
      return failed(externalResource(request, stageId), 'STUDIO_WEB_RESOURCE_CONFLICT', 'The durable ChatGPT resource does not match this stage command.', 'no-active-effect')
    }
    const prepared = chatGptRequest(request, !observeOnly)
    if ('code' in prepared) return failed(externalResource(request, stageId), prepared.code, prepared.reason, 'no-active-effect')
    if (disposed) return unavailable(externalResource(request, stageId))
    const linked = linkedSignal(shutdown.signal, request.signal)
    try {
      if (observeOnly) {
        try {
          const record = await controllerForObserve(stageId).observe(stageId, linked.signal)
          return outputFromRecord(request, stageId, record, prepared.webSearch)
        } catch (error) {
          return unknown(externalResource(request, stageId), `${errorCode(error, 'WEB_OBSERVE_UNKNOWN')}: ${asReason(error, 'The original ChatGPT receipt could not be observed.')}`)
        }
      }

      let existing: WebRunRecord | undefined
      try {
        // A receipt lookup is deliberately store-only. A new stage therefore
        // receives one execution controller, while an existing stage can be
        // reopened with a read-only controller and never gets a replacement
        // TaskSpace.
        existing = await new WebRunStore(stageRoot(stageId)).read(stageId)
      } catch (error) {
        return unknown(externalResource(request, stageId), `${errorCode(error, 'WEB_RECEIPT_READ_UNKNOWN')}: ${asReason(error, 'The existing ChatGPT receipt could not be read.')}`)
      }
      if (existing !== undefined) {
        try {
          const record = await controllerForObserve(stageId).start(stageId, prepared.request, linked.signal)
          return outputFromRecord(request, stageId, record, prepared.webSearch)
        } catch (error) {
          return unknown(externalResource(request, stageId), `${errorCode(error, 'WEB_EXISTING_RECEIPT_UNKNOWN')}: ${asReason(error, 'The original ChatGPT receipt was not replayed.')}`)
        }
      }

      try {
        await options.logRequest(request.sessionId, requestedSelectionLog(request.renderedInput, request.requested))
      } catch (error) {
        return failed(externalResource(request, stageId), 'STUDIO_WEB_REQUEST_LOG_FAILED', `The complete ChatGPT request was not recorded: ${asReason(error, 'request log failed')}`, 'no-active-effect')
      }
      if (linked.signal.aborted) return unknown(externalResource(request, stageId), 'Local execution was cancelled before a ChatGPT page was created.')

      let spaceId: number
      try {
        spaceId = await spaces.forRun(request.runId, linked.signal)
      } catch (error) {
        return unknown(externalResource(request, stageId), `${errorCode(error, 'FLOW_SPACE_UNKNOWN')}: ${asReason(error, 'TaskSpace allocation receipt is unknown; no replacement space was created.')}`)
      }
      if (linked.signal.aborted) return unknown(externalResource(request, stageId), 'Local execution was cancelled after TaskSpace allocation; no page was created.')
      try {
        const record = await controllerForExecute(stageId, spaceId).start(stageId, prepared.request, linked.signal)
        return outputFromRecord(request, stageId, record, prepared.webSearch)
      } catch (error) {
        return unknown(externalResource(request, stageId), `${errorCode(error, 'WEB_START_UNKNOWN')}: ${asReason(error, 'ChatGPT execution receipt is unknown; it was not retried.')}`)
      }
    } finally {
      linked.dispose()
    }
  }

  const runGemini = async (request: StudioExternalPortRequest, observeOnly: boolean): Promise<InsightStageOutcome> => {
    if (disposed) return unavailable(request.resource)
    const linked = linkedSignal(shutdown.signal, request.signal)
    try {
      if (!observeOnly) {
        try {
          await options.logRequest(request.sessionId, requestedSelectionLog(request.renderedInput, request.requested))
        } catch (error) {
          return failed(request.resource, 'STUDIO_GEMINI_REQUEST_LOG_FAILED', `The complete Gemini request was not recorded: ${asReason(error, 'request log failed')}`, 'no-active-effect')
        }
      }
      if (linked.signal.aborted) return unknown(request.resource, 'Local Gemini observation was cancelled before browser work.')
      try {
        const port = await geminiFor(request)
        const outcome = observeOnly
          ? await port.observe({ ...request, signal: linked.signal })
          : await port.execute({ ...request, signal: linked.signal })
        return outcome
      } catch (error) {
        return unknown(request.resource, `${errorCode(error, 'GEMINI_PORT_UNKNOWN')}: ${asReason(error, 'Gemini retained the original resource and was not retried.')}`)
      }
    } finally {
      linked.dispose()
    }
  }

  const binding: StudioBoundPortsBinding = {
    async clarify(request) {
      if (disposed) return unavailable(request.resource)
      const linked = linkedSignal(shutdown.signal, request.signal)
      try {
        try {
          return await nativeFor(request).clarify({ ...request, signal: linked.signal })
        } catch (error) {
          return unknown(request.resource, `${errorCode(error, 'NATIVE_CLARIFIER_UNKNOWN')}: ${asReason(error, 'Native clarification receipt is unknown; it was not retried.')}`)
        }
      } finally {
        linked.dispose()
      }
    },

    async askQuestions(request) {
      if (disposed) return { kind: 'cancelled', reason: 'STUDIO_BINDING_DISPOSED' }
      const linked = linkedSignal(shutdown.signal, request.signal)
      try {
        return await options.askQuestions({ ...request, signal: linked.signal })
      } finally {
        linked.dispose()
      }
    },

    async confirmPlan(request) {
      if (disposed) return { kind: 'declined', reason: 'STUDIO_BINDING_DISPOSED' }
      const linked = linkedSignal(shutdown.signal, request.signal)
      try {
        return await options.confirmPlan({ ...request, signal: linked.signal })
      } finally {
        linked.dispose()
      }
    },

    async execute(request) {
      if (isChatGptStage(request)) return runChatGpt(request, false)
      if (request.nodeKind === 'gemini-research' || request.nodeKind === 'gemini-thinking') return runGemini(request, false)
      return failed(request.resource, 'STUDIO_EXTERNAL_STAGE_UNSUPPORTED', 'Studio external stage is not bound to a concrete provider.', 'no-active-effect')
    },

    async observe(request) {
      if (request.nodeKind === 'clarify') {
        if (disposed) return unavailable(request.resource)
        const linked = linkedSignal(shutdown.signal, request.signal)
        try {
          try {
            return await nativeFor(request).observe({ ...request, signal: linked.signal })
          } catch (error) {
            return unknown(request.resource, `${errorCode(error, 'NATIVE_CLARIFIER_OBSERVE_UNKNOWN')}: ${asReason(error, 'Native clarification original receipt could not be observed.')}`)
          }
        } finally {
          linked.dispose()
        }
      }
      if (isChatGptStage(request)) return runChatGpt(request, true)
      if (request.nodeKind === 'gemini-research' || request.nodeKind === 'gemini-thinking') return runGemini(request, true)
      return failed(request.resource, 'STUDIO_EXTERNAL_STAGE_UNSUPPORTED', 'Studio external stage is not bound to a concrete provider.', 'no-active-effect')
    },

    async finished(runId) {
      // StudioProvider calls this only after the original completed execution
      // is durable. That contract lets a restarted binding finish the same
      // retained TaskSpace without guessing from transient local state.
      if (disposed) return
      const existing = finishingFlows.get(runId)
      if (existing !== undefined) return existing
      const finishing = spaces.finish(runId)
      finishingFlows.set(runId, finishing)
      return finishing
    },

    dispose() {
      if (disposed) return
      disposed = true
      shutdown.abort(new Error('Studio binding was disposed.'))
      for (const controller of allControllers) {
        void controller.dispose().catch(() => undefined)
      }
    },
  }

  return binding
}
