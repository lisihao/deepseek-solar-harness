import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { GrokController, type GrokControllerOptions } from '../src/grok-controller.js'
import type {
  GrokBrowserPort,
  GrokPageObservation,
  GrokRequest,
  GrokResource,
} from '../src/grok-contract.js'
import { GrokRunStore } from '../src/grok-store.js'

const roots: string[] = []
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111'
const REPLY_ID = '22222222-2222-4222-8222-222222222222'
const RESPONSE_ID = `response-${REPLY_ID}`
const USER_ID = 'user-message-1'
const PROMPT = '第一行\r\n第二行：精确回执。'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeCallerRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-grok-controller-'))
  roots.push(root)
  return root
}

function request(id = randomUUID(), overrides: Partial<GrokRequest> = {}): GrokRequest {
  return {
    id,
    sessionId: 'session-1',
    canonical: 'provider=grok;messages=portable',
    prompt: PROMPT,
    modelLabel: 'Grok 4',
    ...overrides,
  }
}

function page(overrides: Partial<GrokPageObservation> = {}): GrokPageObservation {
  return {
    url: 'https://grok.com/',
    authenticated: true,
    loginRequired: false,
    challenge: false,
    busy: false,
    composerCount: 1,
    composerText: PROMPT,
    submitCount: 1,
    submitEnabled: true,
    modelLabel: 'Grok 4',
    messages: [],
    errors: [],
    ...overrides,
  }
}

function receipt(overrides: Partial<GrokPageObservation> = {}): GrokPageObservation {
  return page({
    url: `https://grok.com/c/${CONVERSATION_ID}`,
    composerText: '',
    submitEnabled: false,
    messages: [{ id: USER_ID, role: 'user', text: PROMPT.replace(/\r\n/g, '\n'), hasCopyControl: false, hasArtifacts: false }],
    ...overrides,
  })
}

function answer(
  text = '这是可见的普通文字回答。',
  overrides: Partial<GrokPageObservation> = {},
): GrokPageObservation {
  return receipt({
    url: `https://grok.com/c/${CONVERSATION_ID}?rid=${REPLY_ID}`,
    messages: [
      { id: USER_ID, role: 'user', text: PROMPT.replace(/\r\n/g, '\n'), hasCopyControl: false, hasArtifacts: false },
      { id: RESPONSE_ID, role: 'assistant', text, hasCopyControl: true, hasArtifacts: false },
    ],
    ...overrides,
  })
}

function virtualizedAnswer(text = '这是可见的普通文字回答。'): GrokPageObservation {
  return page({
    url: `https://grok.com/c/${CONVERSATION_ID}`,
    composerText: '',
    submitEnabled: false,
    messages: [{ id: RESPONSE_ID, role: 'assistant', text, hasCopyControl: true, hasArtifacts: false }],
  })
}

function options(overrides: Partial<GrokControllerOptions> = {}): GrokControllerOptions {
  return {
    timeoutMs: 1_000,
    pollMs: 0,
    stableObservations: 2,
    maxOutputBytes: 16 * 1024,
    ...overrides,
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true')
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

class FakeBrowser implements GrokBrowserPort {
  readonly resource: GrokResource = {
    provider: 'grok',
    spaceId: 7,
    pageLabel: 'Fresh Grok task',
    conversationUrl: 'https://grok.com/',
  }
  readonly allocations: Array<{ readonly id: string; readonly sessionId: string }> = []
  readonly prepareResources: GrokResource[] = []
  readonly submitResources: GrokResource[] = []
  readonly observeResources: GrokResource[] = []
  readonly finishResources: GrokResource[] = []
  prepareObservation?: GrokPageObservation
  observations: GrokPageObservation[] = []
  allocationResult?: Promise<GrokResource>
  allocateError?: unknown
  prepareError?: unknown
  submitError?: unknown
  observeError?: unknown
  finishError?: unknown
  onSubmit?: () => void | Promise<void>

  async allocate(input: { readonly id: string; readonly sessionId: string }, signal?: AbortSignal): Promise<GrokResource> {
    this.allocations.push(input)
    if (signal?.aborted) throw new Error('allocate received aborted signal')
    if (this.allocateError !== undefined) throw this.allocateError
    return this.allocationResult ?? this.resource
  }

  async prepare(resource: GrokResource, input: { readonly prompt: string; readonly modelLabel?: string }, signal?: AbortSignal): Promise<GrokPageObservation> {
    this.prepareResources.push(resource)
    if (signal?.aborted) throw new Error('prepare received aborted signal')
    if (this.prepareError !== undefined) throw this.prepareError
    return this.prepareObservation ?? page({
      composerText: input.prompt,
      ...(input.modelLabel === undefined ? {} : { modelLabel: input.modelLabel }),
    })
  }

  async submit(resource: GrokResource, signal?: AbortSignal): Promise<void> {
    this.submitResources.push(resource)
    if (signal?.aborted) throw new Error('submit received aborted signal')
    await this.onSubmit?.()
    if (this.submitError !== undefined) throw this.submitError
  }

  async observe(resource: GrokResource, signal?: AbortSignal): Promise<GrokPageObservation> {
    this.observeResources.push(resource)
    if (signal?.aborted) throw new Error('observe received aborted signal')
    if (this.observeError !== undefined) throw this.observeError
    const next = this.observations.shift()
    if (!next) throw new Error('fixture needs another observation')
    return next
  }

  async finish(resource: GrokResource): Promise<void> {
    this.finishResources.push(resource)
    if (this.finishError !== undefined) throw this.finishError
  }
}

describe('GrokController', () => {
  it('accepts the host plugin defaults and configured limits without starting browser work', async () => {
    const store = new GrokRunStore(await makeCallerRoot())
    const browser = new FakeBrowser()
    expect(() => new GrokController(store, browser, options({ timeoutMs: 1_800_000, pollMs: 2_000, maxOutputBytes: 1024 * 1024 }))).not.toThrow()
    expect(() => new GrokController(store, browser, options({ timeoutMs: 7_200_000, maxOutputBytes: 8 * 1024 * 1024 }))).not.toThrow()
    expect(() => new GrokController(store, browser, options({ timeoutMs: 7_200_001 }))).toThrow()
    expect(() => new GrokController(store, browser, options({ maxOutputBytes: 8 * 1024 * 1024 + 1 }))).toThrow()
    expect(browser.allocations).toEqual([])
  })

  it('flushes durable intent before its only Send, then completes only after two stable full-text observations', async () => {
    const callerRoot = await makeCallerRoot()
    const store = new GrokRunStore(callerRoot)
    const browser = new FakeBrowser()
    const input = request()
    // The second snapshot models transcript virtualization: it is only valid
    // because the first snapshot durably recorded both original receipt and
    // stable response identity.
    browser.observations = [answer(), virtualizedAnswer()]
    browser.onSubmit = async () => {
      const beforeClick = await store.read(input.id)
      expect(beforeClick).toMatchObject({ stage: 'submission-unknown', intentAt: expect.any(String) })
    }

    const result = await new GrokController(store, browser, options()).start(input)

    expect(result).toMatchObject({
      stage: 'completed',
      promptReceiptId: USER_ID,
      replyId: RESPONSE_ID,
      output: { text: '这是可见的普通文字回答。', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      resource: { conversationUrl: `https://grok.com/c/${CONVERSATION_ID}?rid=${REPLY_ID}` },
    })
    expect(browser.allocations).toEqual([{ id: input.id, sessionId: input.sessionId }])
    expect(browser.prepareResources).toHaveLength(1)
    expect(browser.submitResources).toHaveLength(1)
    expect(browser.observeResources).toHaveLength(2)
    expect(browser.finishResources).toEqual([browser.resource])
  })

  it('reloads an indeterminate original page without allocating, preparing, sending, or closing it', async () => {
    const callerRoot = await makeCallerRoot()
    const firstStore = new GrokRunStore(callerRoot)
    const firstBrowser = new FakeBrowser()
    firstBrowser.submitError = new Error('the click outcome is unknown')
    const input = request()
    const first = await new GrokController(firstStore, firstBrowser, options()).start(input)
    expect(first).toMatchObject({ stage: 'indeterminate', error: { code: 'GROK_BROWSER_ERROR' } })
    expect(firstBrowser.submitResources).toHaveLength(1)
    expect(firstBrowser.finishResources).toHaveLength(0)

    const recoveredBrowser = new FakeBrowser()
    recoveredBrowser.observations = [answer('已恢复的原始回答。'), answer('已恢复的原始回答。')]
    const recovered = await new GrokController(new GrokRunStore(callerRoot), recoveredBrowser, options()).observe(input.id)

    expect(recovered).toMatchObject({ stage: 'completed', output: { text: '已恢复的原始回答。' } })
    expect(recoveredBrowser.allocations).toEqual([])
    expect(recoveredBrowser.prepareResources).toEqual([])
    expect(recoveredBrowser.submitResources).toEqual([])
    expect(recoveredBrowser.finishResources).toEqual([])
    expect(recoveredBrowser.observeResources).toHaveLength(2)
  })

  it('retains cleanup failure after a complete answer and admits the next fresh request', async () => {
    const store = new GrokRunStore(await makeCallerRoot())
    const browser = new FakeBrowser()
    browser.observations = [receipt(), answer(), answer(), receipt(), answer(), answer()]
    browser.finishError = new Error('fixture cleanup failure')
    const controller = new GrokController(store, browser, options())
    const first = await controller.start(request())
    expect(first.stage).toBe('completed')
    expect(first.error?.code).toBe('GROK_FINISH_FAILED')
    expect(first.output?.text).toBe('这是可见的普通文字回答。')
    const second = await controller.start(request())
    expect(second.stage).toBe('completed')
    expect(browser.submitResources).toHaveLength(2)
    expect(browser.finishResources).toHaveLength(2)
    await controller.observe(first.id)
    expect(browser.finishResources).toHaveLength(2)
  })

  it('does not duplicate admission for concurrent starts with the same id', async () => {
    const callerRoot = await makeCallerRoot()
    const input = request()
    const firstBrowser = new FakeBrowser()
    const allocation = deferred<GrokResource>()
    firstBrowser.allocationResult = allocation.promise
    firstBrowser.observations = [answer(), answer()]
    const firstController = new GrokController(new GrokRunStore(callerRoot), firstBrowser, options())
    const firstPromise = firstController.start(input)
    await waitUntil(() => firstBrowser.allocations.length === 1)

    const secondBrowser = new FakeBrowser()
    const duplicate = await new GrokController(new GrokRunStore(callerRoot), secondBrowser, options()).start(input)
    expect(duplicate.stage).toBe('preparing')
    expect(secondBrowser.allocations).toEqual([])
    expect(secondBrowser.prepareResources).toEqual([])
    expect(secondBrowser.submitResources).toEqual([])

    allocation.resolve(firstBrowser.resource)
    const completed = await firstPromise
    expect(completed.stage).toBe('completed')
    expect(firstBrowser.submitResources).toHaveLength(1)
  })

  it.each([
    ['login', page({ authenticated: false, loginRequired: true }), 'GROK_LOGIN_REQUIRED'],
    ['challenge', page({ challenge: true }), 'GROK_CHALLENGE_REQUIRED'],
    ['model mismatch', page({ modelLabel: 'Different Grok model' }), 'GROK_MODEL_MISMATCH'],
  ])('stops %s before intent and never sends', async (_name, prepared, code) => {
    const callerRoot = await makeCallerRoot()
    const browser = new FakeBrowser()
    browser.prepareObservation = prepared
    const result = await new GrokController(new GrokRunStore(callerRoot), browser, options()).start(request())

    expect(result).toMatchObject({ stage: 'blocked', error: { code } })
    expect(browser.submitResources).toEqual([])
    expect(browser.observeResources).toEqual([])
    expect(browser.finishResources).toEqual([])
  })

  it.each([
    ['duplicate prompt', receipt({
      messages: [
        { id: USER_ID, role: 'user', text: PROMPT.replace(/\r\n/g, '\n'), hasCopyControl: false, hasArtifacts: false },
        { id: 'user-message-2', role: 'user', text: PROMPT.replace(/\r\n/g, '\n'), hasCopyControl: false, hasArtifacts: false },
      ],
    }), 'GROK_DUPLICATE_PROMPT'],
    ['ambiguous assistant', receipt({
      url: `https://grok.com/c/${CONVERSATION_ID}?rid=${REPLY_ID}`,
      messages: [
        { id: USER_ID, role: 'user', text: PROMPT.replace(/\r\n/g, '\n'), hasCopyControl: false, hasArtifacts: false },
        { id: RESPONSE_ID, role: 'assistant', text: 'one', hasCopyControl: true, hasArtifacts: false },
        { id: '33333333-3333-4333-8333-333333333333', role: 'assistant', text: 'two', hasCopyControl: true, hasArtifacts: false },
      ],
    }), 'GROK_ASSISTANT_AMBIGUOUS'],
    ['artifact reply', answer('text beside Canvas', {
      messages: [
        { id: USER_ID, role: 'user', text: PROMPT.replace(/\r\n/g, '\n'), hasCopyControl: false, hasArtifacts: false },
        { id: RESPONSE_ID, role: 'assistant', text: 'text beside Canvas', hasCopyControl: true, hasArtifacts: true },
      ],
    }), 'GROK_ARTIFACT_OUTPUT_UNSUPPORTED'],
  ])('retains unknown %s without a resend or automatic finish', async (_name, observation, code) => {
    const callerRoot = await makeCallerRoot()
    const browser = new FakeBrowser()
    browser.observations = [observation]
    const result = await new GrokController(new GrokRunStore(callerRoot), browser, options()).start(request())

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code } })
    expect(browser.submitResources).toHaveLength(1)
    expect(browser.finishResources).toEqual([])
  })

  it('makes an abort after durable intent indeterminate and never retries the click', async () => {
    const callerRoot = await makeCallerRoot()
    const browser = new FakeBrowser()
    const aborter = new AbortController()
    browser.onSubmit = () => aborter.abort()

    const result = await new GrokController(new GrokRunStore(callerRoot), browser, options()).start(request(), aborter.signal)

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'GROK_ABORTED' } })
    expect(browser.submitResources).toHaveLength(1)
    expect(browser.observeResources).toEqual([])
  })

  it('treats timeout after intent as indeterminate rather than a replacement submission', async () => {
    const callerRoot = await makeCallerRoot()
    const browser = new FakeBrowser()
    browser.observations = Array.from({ length: 100 }, () => receipt())
    const result = await new GrokController(new GrokRunStore(callerRoot), browser, options({ timeoutMs: 500, pollMs: 20 })).start(request())

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'GROK_TIMEOUT' } })
    expect(browser.submitResources).toHaveLength(1)
  })
})
