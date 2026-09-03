/**
 * ChatGPT Web physical-operator Provider over the provider-neutral browser
 * service. It submits one text task through the user's authenticated web
 * session; it never calls an OpenAI API or takes ownership of the browser.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  BrowserError,
  type BrowserCapabilityV1,
  type BrowserJsonValue,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorDescriptor,
  type PhysicalOperatorProgressEvent,
  type PhysicalOperatorProgressPage,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'physical-operator-chatgpt-web'
/** Provider-neutral browser and physical-operator Services required by this plugin. */
export const inject = ['browser', 'physicalOperators']

/** Stable default discovery identity for the ChatGPT web operator. */
export const DEFAULT_OPERATOR_ID = 'chatgpt-web'
/** Default visible name for the ChatGPT web operator. */
export const DEFAULT_DISPLAY_NAME = 'ChatGPT Web'
/** Default discovery description for the ChatGPT web operator. */
export const DEFAULT_DESCRIPTION = 'Uses the authenticated ChatGPT website through the configured browser provider.'
/** Default discovery tags for the ChatGPT web operator. */
export const DEFAULT_TAGS = Object.freeze(['chatgpt', 'browser', 'subscription'])
/** Default named Ego Lite task space reused by this operator. */
export const DEFAULT_WORKSPACE_NAME = 'dsh-chatgpt-web'
/** Default ChatGPT website opened inside the named browser workspace. */
export const DEFAULT_CHATGPT_URL = 'https://chatgpt.com/'
/** Default bounded generation wait in milliseconds. */
export const DEFAULT_GENERATION_TIMEOUT_MS = 30 * 60_000
/** Default polling delay in milliseconds while the website is generating. */
export const DEFAULT_POLL_INTERVAL_MS = 500
/** Default maximum JSON result size returned across `ctx.browser`. */
export const DEFAULT_OUTPUT_MAX_BYTES = 24 * 1024

const MAX_TIMER_DELAY_MS = 2_147_483_647
const MIN_OUTPUT_MAX_BYTES = 1_024
const MAX_MODEL_LENGTH = 160
const REQUIRED_BROWSER_CAPABILITIES: readonly BrowserCapabilityV1[] = Object.freeze([
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
])

/** Deployment-owned settings for one ChatGPT web operator. */
export interface Config {
  /** Stable physical-operator identity. */
  readonly id?: string
  /** Human-readable discovery name. */
  readonly displayName?: string
  /** Concise discovery description. */
  readonly description?: string
  /** Selection hints with no authority semantics. */
  readonly tags?: string[]
  /** Named browser workspace that owns the authenticated ChatGPT page. */
  readonly workspaceName?: string
  /** HTTPS ChatGPT URL opened or reused within the named workspace. */
  readonly url?: string
  /** Maximum time spent awaiting one assistant response. */
  readonly generationTimeoutMs?: number
  /** Polling delay while awaiting a finished assistant response. */
  readonly pollIntervalMs?: number
  /** Maximum serialized output retained from the webpage. */
  readonly outputMaxBytes?: number
}

/** Loader schema for the deployment-owned ChatGPT web settings. */
export const Config: z<Config> = z.object({
  id: z.string().default(DEFAULT_OPERATOR_ID),
  displayName: z.string().default(DEFAULT_DISPLAY_NAME),
  description: z.string().default(DEFAULT_DESCRIPTION),
  tags: z.array(z.string()).default([...DEFAULT_TAGS]),
  workspaceName: z.string().default(DEFAULT_WORKSPACE_NAME),
  url: z.string().default(DEFAULT_CHATGPT_URL),
  generationTimeoutMs: z.number().default(DEFAULT_GENERATION_TIMEOUT_MS),
  pollIntervalMs: z.number().default(DEFAULT_POLL_INTERVAL_MS),
  outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
})

interface ResolvedConfig {
  readonly id: string
  readonly displayName: string
  readonly description: string
  readonly tags: readonly string[]
  readonly workspaceName: string
  readonly url: string
  readonly generationTimeoutMs: number
  readonly pollIntervalMs: number
  readonly outputMaxBytes: number
}

interface ProgramRequest {
  readonly url: string
  readonly workspaceName: string
  readonly prompt: string
  readonly model?: string
  readonly generationTimeoutMs: number
  readonly pollIntervalMs: number
  readonly outputMaxBytes: number
}

interface CompletedProgramOutcome {
  readonly status: 'completed'
  readonly response: string
  readonly truncated: boolean
}

type ProgramOutcome = CompletedProgramOutcome
  | { readonly status: 'auth-required' }
  | { readonly status: 'input-unavailable' }
  | { readonly status: 'model-selection-unavailable' }
  | { readonly status: 'generation-timeout' }
  | { readonly status: 'protocol-error' }

const INSPECT_PAGE = String.raw`() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const label = (element) => normalize(
    element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent,
  );
  const loginRequired = [...document.querySelectorAll('button,a')]
    .filter(visible)
    .some((element) => /^(log in|sign in|登录)$/i.test(label(element)));
  const replies = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .map((element) => element.querySelector('.markdown') ?? element)
    .map((element) => element.textContent ?? '')
    .filter((text) => text.trim().length > 0);
  let input = document.querySelector('#prompt-textarea');
  if (input === null || !visible(input)) {
    input = [...document.querySelectorAll('textarea,div[contenteditable="true"]')]
      .find((element) => visible(element)) ?? null;
  }
  document.querySelectorAll('[data-dsh-chatgpt-web-input="true"]')
    .forEach((element) => element.removeAttribute('data-dsh-chatgpt-web-input'));
  if (input !== null) input.setAttribute('data-dsh-chatgpt-web-input', 'true');
  return {
    loginRequired,
    inputReady: input !== null,
    assistantCount: replies.length,
  };
}`

const SELECT_MODEL = String.raw`async (input) => {
  if (input === null || typeof input !== 'object') return { selected: false };
  const record = input;
  if (typeof record.model !== 'string' || typeof record.waitMs !== 'number') return { selected: false };
  const normalize = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const target = normalize(record.model);
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const label = (element) => normalize(
    element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent,
  );
  const controls = [...document.querySelectorAll('button,[role="button"]')].filter(visible);
  const selectors = controls.filter((element) => /model|模型/i.test(label(element)));
  if (selectors.length !== 1) return { selected: false };
  const selector = selectors[0];
  selector.click();
  await new Promise((resolve) => setTimeout(resolve, record.waitMs));
  const options = [...document.querySelectorAll('button,[role="menuitem"],[role="option"]')]
    .filter(visible)
    .filter((element) => label(element) === target);
  if (options.length !== 1) return { selected: false };
  options[0].click();
  await new Promise((resolve) => setTimeout(resolve, record.waitMs));
  return { selected: label(selector) === target };
}`

const RESPONSE_STATE = String.raw`() => {
  const replies = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
    .map((element) => element.querySelector('.markdown') ?? element)
    .map((element) => element.textContent ?? '')
    .filter((text) => text.trim().length > 0);
  const generating = [...document.querySelectorAll('button,[role="button"]')].some((element) => {
    const label = String(element.getAttribute('aria-label') ?? element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return /stop generating|stop streaming|停止生成/i.test(label);
  });
  return {
    assistantCount: replies.length,
    response: replies.at(-1) ?? '',
    generating,
  };
}`

const REMOVE_INPUT_MARKER = String.raw`() => {
  document.querySelectorAll('[data-dsh-chatgpt-web-input="true"]')
    .forEach((element) => element.removeAttribute('data-dsh-chatgpt-web-input'));
  return true;
}`

/**
 * Build one trusted browser program for a single ChatGPT webpage request.
 * @param request - normalized prompt, optional model, and browser bounds.
 * @returns a provider-neutral browser-js-v1 request for the configured workspace.
 */
export function buildChatGptWebProgram(request: ProgramRequest): BrowserRunProgramV1 {
  const encodedRequest = JSON.stringify(request)
  return {
    version: 1,
    language: 'browser-js-v1',
    workspace: {
      kind: 'named',
      name: request.workspaceName,
      createIfMissing: true,
    },
    requiredCapabilities: REQUIRED_BROWSER_CAPABILITIES,
    output: { kind: 'json', maxBytes: request.outputMaxBytes },
    source: String.raw`const request = ${encodedRequest};
const page = 'chatgpt-web';
const asRecord = (value) => value !== null && typeof value === 'object' ? value : undefined;
await browser.run({
  id: 'chatgpt-open',
  kind: 'open',
  page,
  url: request.url,
  reuse: 'exact-url',
  waitUntil: 'dom-content-loaded',
});
const inspect = asRecord(await browser.evaluate(page, ${JSON.stringify(INSPECT_PAGE)}));
if (inspect === undefined) return { status: 'protocol-error' };
if (inspect.loginRequired === true) return { status: 'auth-required' };
if (inspect.inputReady !== true || !Number.isSafeInteger(inspect.assistantCount)) {
  return { status: 'input-unavailable' };
}
if (request.model !== undefined) {
  const selection = asRecord(await browser.evaluate(page, ${JSON.stringify(SELECT_MODEL)}, {
    model: request.model,
    waitMs: request.pollIntervalMs,
  }));
  if (selection?.selected !== true) return { status: 'model-selection-unavailable' };
}
await browser.run({
  id: 'chatgpt-fill',
  kind: 'fill',
  page,
  locator: { kind: 'css', selector: '[data-dsh-chatgpt-web-input="true"]' },
  value: request.prompt,
});
await browser.run({
  id: 'chatgpt-send',
  kind: 'press',
  page,
  locator: { kind: 'css', selector: '[data-dsh-chatgpt-web-input="true"]' },
  key: 'Enter',
});
await browser.evaluate(page, ${JSON.stringify(REMOVE_INPUT_MARKER)});
const initialCount = inspect.assistantCount;
const startedAt = Date.now();
let sawGenerating = false;
let stableResponse = '';
let stableSamples = 0;
while (Date.now() - startedAt <= request.generationTimeoutMs) {
  const state = asRecord(await browser.evaluate(page, ${JSON.stringify(RESPONSE_STATE)}));
  if (state === undefined
    || !Number.isSafeInteger(state.assistantCount)
    || typeof state.response !== 'string'
    || typeof state.generating !== 'boolean') {
    return { status: 'protocol-error' };
  }
  if (state.generating) sawGenerating = true;
  if (state.assistantCount > initialCount && state.response.trim().length > 0) {
    stableSamples = state.response === stableResponse && !state.generating ? stableSamples + 1 : 0;
    stableResponse = state.response;
    if ((sawGenerating && !state.generating) || stableSamples >= 2) {
      const reserveBytes = Math.min(512, Math.floor(request.outputMaxBytes / 2));
      const responseBudget = request.outputMaxBytes - reserveBytes;
      const encoder = new TextEncoder();
      const segments = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(state.response));
      const kept = [];
      let usedBytes = 0;
      for (const segment of segments) {
        const size = encoder.encode(segment.segment).byteLength;
        if (usedBytes + size > responseBudget) break;
        kept.push(segment.segment);
        usedBytes += size;
      }
      return {
        status: 'completed',
        response: kept.join(''),
        truncated: kept.length < segments.length,
      };
    }
  }
  await new Promise((resolve) => setTimeout(resolve, request.pollIntervalMs));
}
return { status: 'generation-timeout' };
`,
  }
}

/** ChatGPT website physical operator with exactly one active web turn. */
export class ChatGptWebPhysicalOperator implements PhysicalOperator {
  readonly descriptor: PhysicalOperatorDescriptor

  /**
   * Bind immutable discovery metadata to one deployment configuration.
   * @param ctx - context exposing provider-neutral browser automation.
   * @param config - fully validated deployment configuration.
   */
  constructor(
    private readonly ctx: Context,
    private readonly config: ResolvedConfig,
  ) {
    this.descriptor = Object.freeze({
      id: PhysicalOperatorId(config.id),
      displayName: config.displayName,
      description: config.description,
      tags: config.tags,
      maxConcurrency: 1,
      executionModes: ['ephemeral'] as const,
    })
  }

  /** Return whether one available browser-js-v1 Provider has the required capabilities. */
  availability() {
    try {
      const capabilities = this.ctx.browser.capabilities('browser-js-v1')
      const missing = REQUIRED_BROWSER_CAPABILITIES.filter(capability => !capabilities.includes(capability))
      return missing.length === 0
        ? { available: true as const }
        : { available: false as const, reason: `browser-js-v1 provider lacks required capabilities: ${missing.join(', ')}` }
    } catch (error) {
      const code = error instanceof BrowserError ? error.code : 'BROWSER_UNAVAILABLE'
      return { available: false as const, reason: `browser-js-v1 provider is unavailable (${code})` }
    }
  }

  /**
   * Start one browser-backed ephemeral run. `dispose()` aborts the one browser
   * request and waits for its terminal result without closing the user browser.
   * @param request - service-normalized execution request.
   * @returns a bounded progress reader and the terminal ChatGPT result.
   */
  start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    if (request.mode !== 'ephemeral') {
      throw new PhysicalOperatorError(
        'ChatGPT Web supports only ephemeral execution',
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    if (request.signal.aborted) {
      throw new PhysicalOperatorError('ChatGPT Web execution was aborted before startup', 'OPERATOR_ABORTED')
    }
    const prompt = promptForRequest(request)
    const model = modelForRequest(request)
    const progress = new ProgressLog(String(request.executionId))
    progress.append('chatgpt-web.connecting', { phase: 'connecting' })
    const controller = new AbortController()
    const forwardAbort = (): void => { controller.abort(request.signal.reason) }
    request.signal.addEventListener('abort', forwardAbort, { once: true })
    const result = this.execute({
      url: this.config.url,
      workspaceName: this.config.workspaceName,
      prompt,
      ...model === undefined ? {} : { model },
      generationTimeoutMs: this.config.generationTimeoutMs,
      pollIntervalMs: this.config.pollIntervalMs,
      outputMaxBytes: this.config.outputMaxBytes,
    }, controller.signal, progress)
    void result.then(
      () => { request.signal.removeEventListener('abort', forwardAbort) },
      () => { request.signal.removeEventListener('abort', forwardAbort) },
    )
    let disposal: Promise<void> | undefined
    return Promise.resolve({
      result,
      readEvents: (afterSequence, limit, signal) => progress.read(afterSequence, limit, signal),
      dispose: (): Promise<void> => {
        if (disposal !== undefined) return disposal
        controller.abort(new Error('ChatGPT Web execution was disposed'))
        disposal = settleForDisposal(result)
        return disposal
      },
    })
  }

  private async execute(
    request: ProgramRequest,
    signal: AbortSignal,
    progress: ProgressLog,
  ): Promise<PhysicalOperatorResult> {
    try {
      progress.append('chatgpt-web.submitting', {
        phase: 'submitting',
        ...request.model === undefined ? {} : { requestedModel: request.model },
      })
      progress.append('chatgpt-web.waiting', { phase: 'waiting' })
      const result = await this.ctx.browser.runProgram(buildChatGptWebProgram(request), signal)
      const outcome = programOutcome(result.output.kind === 'json' ? result.output.value : undefined)
      switch (outcome.status) {
        case 'completed': {
          if (outcome.response.length === 0) {
            throw new PhysicalOperatorError('ChatGPT Web returned an empty assistant response', 'CHATGPT_WEB_OUTPUT_UNAVAILABLE')
          }
          progress.append('chatgpt-web.completed', {
            phase: 'completed',
            outputBytes: new TextEncoder().encode(outcome.response).byteLength,
            truncated: outcome.truncated,
          })
          return { output: [{ type: 'text', text: outcome.response }], stopReason: 'completed' }
        }
        case 'auth-required':
          throw new PhysicalOperatorError('ChatGPT Web requires a logged-in browser session', 'CHATGPT_WEB_AUTH_REQUIRED')
        case 'input-unavailable':
          throw new PhysicalOperatorError('ChatGPT Web input is unavailable in the selected browser workspace', 'RUNTIME_UNAVAILABLE')
        case 'model-selection-unavailable':
          throw new PhysicalOperatorError('ChatGPT Web could not verify the explicitly requested model selection', 'MODEL_SELECTION_UNAVAILABLE')
        case 'generation-timeout':
          throw new PhysicalOperatorError('ChatGPT Web did not finish generation before the configured timeout', 'CHATGPT_WEB_TIMEOUT')
        case 'protocol-error':
          throw new PhysicalOperatorError('ChatGPT Web returned an invalid browser program result', 'CHATGPT_WEB_PROTOCOL')
      }
    } catch (error) {
      if (signal.aborted || error instanceof BrowserError && error.code === 'BROWSER_ABORTED') {
        progress.append('chatgpt-web.aborted', { phase: 'aborted' })
        return { output: [], stopReason: 'aborted' }
      }
      progress.append('chatgpt-web.failed', { phase: 'failed', code: errorCode(error) })
      throw error
    }
  }
}

/** Register the browser-backed ChatGPT physical operator. */
export function apply(ctx: Context, config: Config): void {
  ctx.physicalOperators.registerOperator(new ChatGptWebPhysicalOperator(ctx, resolveConfig(config)))
}

function resolveConfig(config: Config): ResolvedConfig {
  const id = requiredTrimmed('id', config.id ?? DEFAULT_OPERATOR_ID)
  const displayName = requiredTrimmed('displayName', config.displayName ?? DEFAULT_DISPLAY_NAME)
  const description = requiredTrimmed('description', config.description ?? DEFAULT_DESCRIPTION)
  const workspaceName = requiredTrimmed('workspaceName', config.workspaceName ?? DEFAULT_WORKSPACE_NAME)
  const tags = uniqueTrimmed('tags', config.tags ?? DEFAULT_TAGS)
  const url = new URL(config.url ?? DEFAULT_CHATGPT_URL)
  if (url.toString() !== DEFAULT_CHATGPT_URL) {
    throw new Error(`physical-operator-chatgpt-web: url must be exactly ${DEFAULT_CHATGPT_URL}`)
  }
  const generationTimeoutMs = positiveTimer('generationTimeoutMs', config.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS)
  const pollIntervalMs = positiveTimer('pollIntervalMs', config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
  if (pollIntervalMs > generationTimeoutMs) {
    throw new Error('physical-operator-chatgpt-web: pollIntervalMs must not exceed generationTimeoutMs')
  }
  const outputMaxBytes = config.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES
  if (!Number.isSafeInteger(outputMaxBytes) || outputMaxBytes < MIN_OUTPUT_MAX_BYTES) {
    throw new Error(`physical-operator-chatgpt-web: outputMaxBytes must be an integer of at least ${MIN_OUTPUT_MAX_BYTES}`)
  }
  return Object.freeze({
    id,
    displayName,
    description,
    tags,
    workspaceName,
    url: url.toString(),
    generationTimeoutMs,
    pollIntervalMs,
    outputMaxBytes,
  })
}

function requiredTrimmed(field: string, value: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(`physical-operator-chatgpt-web: ${field} must be non-blank and trimmed`)
  }
  return value
}

function uniqueTrimmed(field: string, values: readonly string[]): readonly string[] {
  const seen = new Set<string>()
  for (const value of values) {
    requiredTrimmed(field, value)
    if (seen.has(value)) throw new Error(`physical-operator-chatgpt-web: ${field} must not contain duplicate values`)
    seen.add(value)
  }
  return Object.freeze([...seen])
}

function positiveTimer(field: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`physical-operator-chatgpt-web: ${field} must be positive and at most ${MAX_TIMER_DELAY_MS}`)
  }
  return value
}

function promptForRequest(request: PhysicalOperatorProviderStartRequest): string {
  const text: string[] = []
  for (const block of request.prompt) {
    if (block.type !== 'text') {
      throw new PhysicalOperatorError('ChatGPT Web accepts text prompt blocks only', 'INVALID_RESULT')
    }
    text.push(block.text)
  }
  const task = text.join('\n')
  if (task.trim().length === 0) {
    throw new PhysicalOperatorError('ChatGPT Web prompt must not be empty', 'INVALID_RESULT')
  }
  return request.systemPrompt === undefined || request.systemPrompt.length === 0
    ? task
    : `${request.systemPrompt}\n\n---\n\n${task}`
}

function modelForRequest(request: PhysicalOperatorProviderStartRequest): string | undefined {
  if (request.residentProfile?.effort !== undefined) {
    throw new PhysicalOperatorError('ChatGPT Web does not expose a verified reasoning-effort control', 'OPERATOR_OPTION_UNSUPPORTED')
  }
  const model = request.residentProfile?.model
  if (model === undefined) return undefined
  if (model.length === 0 || model.trim() !== model || model.length > MAX_MODEL_LENGTH) {
    throw new PhysicalOperatorError('ChatGPT Web model selection must be a trimmed bounded model name', 'MODEL_SELECTION_UNAVAILABLE')
  }
  return model
}

function programOutcome(value: BrowserJsonValue | undefined): ProgramOutcome {
  if (!isRecord(value) || typeof value.status !== 'string') return { status: 'protocol-error' }
  switch (value.status) {
    case 'completed':
      return typeof value.response === 'string' && typeof value.truncated === 'boolean'
        ? { status: 'completed', response: value.response, truncated: value.truncated }
        : { status: 'protocol-error' }
    case 'auth-required': return { status: 'auth-required' }
    case 'input-unavailable': return { status: 'input-unavailable' }
    case 'model-selection-unavailable': return { status: 'model-selection-unavailable' }
    case 'generation-timeout': return { status: 'generation-timeout' }
    case 'protocol-error': return { status: 'protocol-error' }
    default:
      return { status: 'protocol-error' }
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, BrowserJsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorCode(error: unknown): string {
  if (error instanceof BrowserError || error instanceof PhysicalOperatorError) return error.code
  return 'CHATGPT_WEB_PROVIDER_FAILED'
}

async function settleForDisposal(result: Promise<PhysicalOperatorResult>): Promise<void> {
  try {
    await result
  } catch {
    // `result` preserves the terminal failure for the caller; disposal only
    // waits for cancellation to settle and must not replace that failure.
  }
}

class ProgressLog {
  private sequence = 0
  private readonly events: PhysicalOperatorProgressEvent[] = []

  constructor(private readonly commandId: string) {}

  append(type: string, data: Readonly<Record<string, unknown>>): void {
    this.sequence += 1
    this.events.push(Object.freeze({
      sequence: this.sequence,
      type,
      time: new Date().toISOString(),
      data: Object.freeze({ ...data, commandId: this.commandId }),
    }))
  }

  read(afterSequence: number, limit: number, signal?: AbortSignal): Promise<PhysicalOperatorProgressPage> {
    if (signal?.aborted) {
      return Promise.reject(new PhysicalOperatorError('ChatGPT Web progress read was aborted', 'OPERATOR_ABORTED'))
    }
    const events = this.events.filter(event => event.sequence > afterSequence).slice(0, Math.max(0, limit))
    return Promise.resolve({ events, nextSequence: events.at(-1)?.sequence ?? afterSequence })
  }
}
