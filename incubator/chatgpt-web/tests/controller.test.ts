import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { WebBrowserError, type WebBrowserAdapter } from '../src/browser-contract.js'
import { WebController, type WebControllerOptions } from '../src/controller.js'
import type { ChatGptPageObservation } from '../src/page-observation.js'
import { EgoProcessError } from '../src/process-contract.js'
import { WebRunStore, type WebRunRequest, type WebRunResource } from '../src/store.js'

const roots: string[] = []
const TEST_PROMPT = 'Preserve this exact test input.'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-web-controller-'))
  roots.push(root)
  return join(root, 'records')
}

function request(overrides: Partial<WebRunRequest> = {}): WebRunRequest {
  return { prompt: TEST_PROMPT, modelLabel: 'gpt-5', effortLabel: 'medium', ...overrides }
}

function page(overrides: Partial<ChatGptPageObservation> = {}): ChatGptPageObservation {
  return {
    url: 'https://chatgpt.com/',
    loginRequired: false,
    composerCount: 1,
    composerText: '',
    hasAttachments: false,
    userMessageCount: 0,
    userMessages: [],
    assistantMessages: [],
    generating: false,
    modelLabel: 'gpt-5',
    effortLabel: 'medium',
    ...overrides,
  }
}

function receipt(overrides: Partial<ChatGptPageObservation> = {}): ChatGptPageObservation {
  return page({
    url: 'https://chatgpt.com/c/controller-test',
    userMessageCount: 1,
    userMessages: [TEST_PROMPT],
    ...overrides,
  })
}

function answer(
  text = 'Visible answer',
  markdown = '**Visible answer**',
  overrides: Partial<ChatGptPageObservation> = {},
): ChatGptPageObservation {
  return receipt({
    assistantMessages: [{ text, markdown }],
    ...overrides,
  })
}

function options(overrides: Partial<WebControllerOptions> = {}): WebControllerOptions {
  return {
    timeoutMs: 1_000,
    pollMs: 0,
    stableObservations: 2,
    maxOutputBytes: 16 * 1024,
    ...overrides,
  }
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
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
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
}

class FakeBrowser implements WebBrowserAdapter {
  readonly resource: WebRunResource = {
    spaceId: 17,
    pageLabel: 'Test TaskSpace',
  }
  readonly createIds: string[] = []
  readonly prepareResources: WebRunResource[] = []
  readonly submitResources: WebRunResource[] = []
  readonly observeResources: WebRunResource[] = []
  finishCalls = 0
  createError?: unknown
  prepareError?: unknown
  submitError?: unknown
  observeError?: unknown
  finishError?: unknown
  createResult?: Promise<WebRunResource>
  submitResult?: ChatGptPageObservation
  observations: ChatGptPageObservation[] = []
  fallback = receipt()
  onObserve?: (count: number) => void

  async create(runId: string, signal?: AbortSignal): Promise<WebRunResource> {
    this.createIds.push(runId)
    if (signal?.aborted) throw new EgoProcessError('EGO_ABORTED', 'pre-aborted', true, false)
    if (this.createError !== undefined) throw this.createError
    return this.createResult ? this.createResult : this.resource
  }

  async prepare(resource: WebRunResource, _request: WebRunRequest, signal?: AbortSignal): Promise<ChatGptPageObservation> {
    this.prepareResources.push(resource)
    if (signal?.aborted) throw new EgoProcessError('EGO_ABORTED', 'pre-aborted', true, false)
    if (this.prepareError !== undefined) throw this.prepareError
    return page()
  }

  async observe(resource: WebRunResource, signal?: AbortSignal): Promise<ChatGptPageObservation> {
    this.observeResources.push(resource)
    this.onObserve?.(this.observeResources.length)
    if (signal?.aborted) throw new EgoProcessError('EGO_ABORTED', 'pre-aborted', true, false)
    if (this.observeError !== undefined) throw this.observeError
    return this.observations.shift() ?? this.fallback
  }

  async submit(resource: WebRunResource, _request: WebRunRequest, signal?: AbortSignal): Promise<ChatGptPageObservation> {
    this.submitResources.push(resource)
    if (signal?.aborted) throw new EgoProcessError('EGO_ABORTED', 'pre-aborted', true, false)
    if (this.submitError !== undefined) throw this.submitError
    return this.submitResult ?? receipt()
  }

  async finish(_resource: WebRunResource): Promise<void> {
    this.finishCalls += 1
    if (this.finishError !== undefined) throw this.finishError
  }
}

describe('WebController', () => {
  it('does no browser work for list/read, then completes only after stable full visible output', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    const controller = new WebController(store, browser, options())
    const id = randomUUID()
    browser.submitResult = receipt({ url: 'https://chatgpt.com/' })
    browser.observations = [answer('完整回答', '# 完整回答'), answer('完整回答', '# 完整回答')]

    await expect(controller.list()).resolves.toEqual([])
    await expect(controller.read(id)).resolves.toBeUndefined()
    expect(browser.createIds).toEqual([])
    expect(browser.observeResources).toEqual([])

    const result = await controller.start(id, request())

    expect(result).toMatchObject({
      id,
      stage: 'completed',
      observed: { modelLabel: 'gpt-5', effortLabel: 'medium' },
      output: { text: '完整回答', markdown: '# 完整回答' },
      resource: { conversationUrl: 'https://chatgpt.com/c/controller-test' },
    })
    expect(browser.createIds).toEqual([id])
    expect(browser.submitResources).toEqual([browser.resource])
    expect(browser.observeResources).toHaveLength(2)
    expect(browser.observeResources.map((resource) => resource.spaceId)).toEqual([browser.resource.spaceId, browser.resource.spaceId])
    expect(browser.observeResources[1]).toMatchObject({ conversationUrl: 'https://chatgpt.com/c/controller-test' })
    expect(browser.finishCalls).toBe(1)
    await expect(controller.read(id)).resolves.toEqual(result)
  })

  it('accepts only CRLF-normalized exact receipt text and retains the preflight selection when menus close', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    const controller = new WebController(store, browser, options())
    const crlfRequest: WebRunRequest = { ...request(), prompt: 'first line\r\nsecond line' }
    const absentControls = { modelLabel: undefined, effortLabel: undefined }
    browser.submitResult = receipt({ userMessages: ['first line\nsecond line'], ...absentControls })
    browser.observations = [
      answer('answer', 'answer', { userMessages: ['first line\nsecond line'], ...absentControls }),
      answer('answer', 'answer', { userMessages: ['first line\nsecond line'], ...absentControls }),
    ]

    const result = await controller.start(randomUUID(), crlfRequest)

    expect(result).toMatchObject({
      stage: 'completed',
      observed: { modelLabel: 'gpt-5', effortLabel: 'medium' },
      output: { text: 'answer', markdown: 'answer' },
    })
  })

  it('records confirmed webpage search at preflight without requiring an unknown post-send pill location', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.prepare = async (resource: WebRunResource) => {
      browser.prepareResources.push(resource)
      return page({ webSearchActive: true })
    }
    browser.submitResult = receipt()
    browser.observations = [answer(), answer()]
    const controller = new WebController(store, browser, options())

    const result = await controller.start(randomUUID(), request({ webSearch: true }))

    expect(result).toMatchObject({
      stage: 'completed',
      request: { webSearch: true },
      observed: { webSearchActive: true },
    })
    expect(browser.submitResources).toEqual([browser.resource])
  })

  it('blocks a webpage-search request before submission when the pill was not observed', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    const controller = new WebController(store, browser, options())

    const result = await controller.start(randomUUID(), request({ webSearch: true }))

    expect(result).toMatchObject({ stage: 'blocked', error: { code: 'WEB_SEARCH_ACTIVE_REQUIRED' } })
    expect(browser.submitResources).toEqual([])
  })

  it.each([
    ['unknown model', page({ modelLabel: undefined }), 'WEB_MODEL_UNKNOWN'],
    ['model mismatch', page({ modelLabel: 'gpt-4.1' }), 'WEB_MODEL_MISMATCH'],
    ['effort mismatch', page({ effortLabel: 'high' }), 'WEB_EFFORT_MISMATCH'],
    ['login required', page({ loginRequired: true }), 'WEB_LOGIN_REQUIRED'],
    ['dirty composer', page({ composerText: 'left over draft' }), 'WEB_COMPOSER_DIRTY'],
    ['attachments', page({ hasAttachments: true }), 'WEB_ATTACHMENTS_PRESENT'],
    ['multiple composers', page({ composerCount: 2 }), 'WEB_COMPOSER_COUNT'],
  ])('blocks strict preflight for %s without submitting', async (_name, observation, code) => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.prepare = async (resource: WebRunResource) => {
      browser.prepareResources.push(resource)
      return observation
    }
    const controller = new WebController(store, browser, options())

    const result = await controller.start(randomUUID(), request())

    expect(result).toMatchObject({ stage: 'blocked', error: { code } })
    expect(browser.createIds).toHaveLength(1)
    expect(browser.submitResources).toEqual([])
    expect(browser.finishCalls).toBe(0)
  })

  it('returns the active same-id promise and blocks a different id while a submission is unresolved', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    const reachedObservation = deferred<void>()
    browser.onObserve = (count) => {
      if (count === 1) reachedObservation.resolve()
    }
    browser.fallback = receipt({ generating: true })
    const controller = new WebController(store, browser, options({ pollMs: 10, timeoutMs: 2_000 }))
    const firstId = randomUUID()
    const first = controller.start(firstId, request())
    const same = controller.start(firstId, request())
    const conflicting = controller.start(firstId, { ...request(), prompt: 'different command identity' })

    expect(same).toBe(first)
    await expect(conflicting).rejects.toMatchObject({ code: 'WEB_COMMAND_CONFLICT' })
    await reachedObservation.promise
    const other = await controller.start(randomUUID(), request())
    expect(other).toMatchObject({ stage: 'blocked', error: { code: 'WEB_BUSY' } })
    expect(browser.createIds).toEqual([firstId])
    expect(browser.submitResources).toHaveLength(1)

    const cancelled = await controller.cancel(firstId)
    expect(cancelled).toMatchObject({ stage: 'indeterminate', error: { code: 'WEB_CANCELLED' } })
    expect(browser.finishCalls).toBe(0)
    await expect(first).resolves.toEqual(cancelled)
  })

  it('does not replay a crashed unknown run, reconciles only its original resource, then releases its fence on completion', async () => {
    const root = await makeRoot()
    const id = randomUUID()
    const store = new WebRunStore(root)
    const initialBrowser = new FakeBrowser()
    initialBrowser.submitError = new EgoProcessError('EGO_TIMEOUT', 'submission transport timed out', true, true)
    const initial = new WebController(store, initialBrowser, options())

    const unknown = await initial.start(id, request())
    expect(unknown).toMatchObject({ stage: 'indeterminate', error: { code: 'EGO_TIMEOUT' } })
    expect(initialBrowser.finishCalls).toBe(0)
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).resolves.toBeUndefined()

    const reopenedBrowser = new FakeBrowser()
    reopenedBrowser.observations = [answer(), answer()]
    const reopened = new WebController(new WebRunStore(root), reopenedBrowser, options())
    await expect(reopened.start(id, request())).resolves.toEqual(unknown)
    expect(reopenedBrowser.createIds).toEqual([])
    expect(reopenedBrowser.submitResources).toEqual([])

    const blocked = await reopened.start(randomUUID(), request())
    expect(blocked).toMatchObject({ stage: 'blocked', error: { code: 'WEB_BUSY' } })
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).resolves.toBeUndefined()

    const completed = await reopened.observe(id)
    expect(completed).toMatchObject({ stage: 'completed', output: { text: 'Visible answer' } })
    expect(reopenedBrowser.observeResources).toHaveLength(2)
    expect(reopenedBrowser.observeResources.map((resource) => resource.spaceId)).toEqual([
      reopenedBrowser.resource.spaceId,
      reopenedBrowser.resource.spaceId,
    ])
    expect(reopenedBrowser.observeResources[1]).toMatchObject({ conversationUrl: 'https://chatgpt.com/c/controller-test' })
    expect(reopenedBrowser.createIds).toEqual([])
    expect(reopenedBrowser.submitResources).toEqual([])
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).rejects.toThrow()

    const nextId = randomUUID()
    reopenedBrowser.observations = [answer('next', 'next'), answer('next', 'next')]
    const next = await reopened.start(nextId, request())
    expect(next).toMatchObject({ stage: 'completed', id: nextId })
    expect(reopenedBrowser.createIds).toEqual([nextId])
  })

  it('records known pre-send process failure and releases its admission without attempting a model call', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.prepareError = new EgoProcessError('EGO_SPAWN_FAILED', 'browser command was never launched', true, false)
    const controller = new WebController(store, browser, options())

    const failed = await controller.start(randomUUID(), request())

    expect(failed).toMatchObject({ stage: 'failed', error: { code: 'EGO_SPAWN_FAILED' }, resource: browser.resource })
    expect(browser.submitResources).toEqual([])
    expect(browser.finishCalls).toBe(0)
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).rejects.toThrow()
  })

  it('turns a post-submission timeout into indeterminate and preserves the durable fence', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.fallback = receipt({ generating: true })
    const controller = new WebController(store, browser, options({ timeoutMs: 500, pollMs: 2 }))
    const id = randomUUID()

    const result = await controller.start(id, request())

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'WEB_TIMEOUT' } })
    expect(browser.submitResources).toHaveLength(1)
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).resolves.toBeUndefined()
    const blocked = await controller.start(randomUUID(), request())
    expect(blocked).toMatchObject({ stage: 'blocked', error: { code: 'WEB_BUSY' } })
  })

  it('records output overflow instead of truncating an observed answer', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.observations = [answer('12345', '12345'), answer('12345', '12345')]
    const controller = new WebController(store, browser, options({ maxOutputBytes: 8 }))

    const result = await controller.start(randomUUID(), request())

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'WEB_OUTPUT_TOO_LARGE' } })
    expect(result.output).toBeUndefined()
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).resolves.toBeUndefined()
  })

  it('makes an explicit observation use only the durable original TaskSpace and never submit', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    const id = randomUUID()
    const created = await store.create(id, request())
    await store.transition(id, created.revision, {
      stage: 'submission-unknown',
      resource: browser.resource,
      observed: { modelLabel: 'gpt-5', effortLabel: 'medium' },
    })
    browser.observations = [answer('reconciled', 'reconciled'), answer('reconciled', 'reconciled')]
    const controller = new WebController(store, browser, options())

    const result = await controller.observe(id)

    expect(result).toMatchObject({ stage: 'completed', output: { text: 'reconciled', markdown: 'reconciled' } })
    expect(browser.createIds).toEqual([])
    expect(browser.prepareResources).toEqual([])
    expect(browser.submitResources).toEqual([])
    expect(browser.observeResources).toHaveLength(2)
    expect(browser.observeResources.map((resource) => resource.spaceId)).toEqual([browser.resource.spaceId, browser.resource.spaceId])
    expect(browser.observeResources[1]).toMatchObject({ conversationUrl: 'https://chatgpt.com/c/controller-test' })
  })

  it('stops local waiting during disposal without claiming that the website stopped', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    const reachedObservation = deferred<void>()
    browser.onObserve = (count) => {
      if (count === 1) reachedObservation.resolve()
    }
    browser.fallback = receipt({ generating: true })
    const controller = new WebController(store, browser, options({ pollMs: 100, timeoutMs: 2_000 }))
    const id = randomUUID()
    const running = controller.start(id, request())
    await reachedObservation.promise

    await controller.dispose()
    const result = await running

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'WEB_DISPOSED' } })
    expect(browser.finishCalls).toBe(0)
    await expect(controller.start(randomUUID(), request())).rejects.toMatchObject({ code: 'WEB_CONTROLLER_DISPOSED' })
  })

  it('surfaces a cleanup failure without resubmitting', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.observations = [answer(), answer()]
    browser.finishError = new Error('finish failed')
    const controller = new WebController(store, browser, options())
    const id = randomUUID()

    await expect(controller.start(id, request())).rejects.toMatchObject({ code: 'WEB_FINISH_FAILED' })
    expect(browser.submitResources).toHaveLength(1)
    expect(browser.finishCalls).toBe(1)
    await expect(controller.read(id)).resolves.toMatchObject({ stage: 'completed' })
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).resolves.toBeUndefined()
  })

  it('reports a visible-but-unverifiable submission as indeterminate instead of claiming a receipt', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.submitResult = page({ userMessageCount: 0 })
    const controller = new WebController(store, browser, options())

    const result = await controller.start(randomUUID(), request())

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'WEB_SUBMISSION_MISMATCH' } })
    expect(browser.submitResources).toHaveLength(1)
  })

  it('retains the fence when a later observation switches away from the confirmed conversation URL', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const browser = new FakeBrowser()
    browser.observations = [answer('other', 'other', { url: 'https://chatgpt.com/c/other-conversation' })]
    const controller = new WebController(store, browser, options())

    const result = await controller.start(randomUUID(), request())

    expect(result).toMatchObject({ stage: 'indeterminate', error: { code: 'WEB_RESOURCE_MISMATCH' } })
    await expect(access(join(root, '.chatgpt-web-admission.lock'))).resolves.toBeUndefined()
  })

  it.each([
    ['unknown format version', JSON.stringify({ formatVersion: 99 }), 'WEB_ADMISSION_VERSION'],
    ['malformed JSON', '{not-json', 'WEB_ADMISSION_INVALID'],
  ])('reports %s without touching the browser or replacing the durable fence', async (_name, contents, code) => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const priorId = randomUUID()
    const prior = await store.create(priorId, request())
    await store.transition(priorId, prior.revision, { stage: 'completed' })
    const lock = join(root, '.chatgpt-web-admission.lock')
    await writeFile(lock, contents, { mode: 0o600 })
    const browser = new FakeBrowser()
    const controller = new WebController(store, browser, options())

    const result = await controller.start(randomUUID(), request())

    expect(result).toMatchObject({ stage: 'failed', error: { code } })
    expect(browser.createIds).toEqual([])
    expect(await readFile(lock, 'utf8')).toBe(contents)
  })

  it('does not unlink a newer admission lease when a delayed older release reaches its claim step', async () => {
    const root = await makeRoot()
    const store = new WebRunStore(root)
    const oldId = randomUUID()
    const oldLease = randomUUID()
    const old = await store.create(oldId, request())
    await store.transition(oldId, old.revision, { stage: 'completed' })
    const lock = join(root, '.chatgpt-web-admission.lock')
    await writeFile(lock, JSON.stringify({ formatVersion: 1, id: oldId, lease: oldLease }), { mode: 0o600 })

    const newOwner = { formatVersion: 1, id: randomUUID(), lease: randomUUID() }
    const controller = new WebController(store, new FakeBrowser(), options())
    const internals = controller as unknown as {
      readAdmissionOwner(path?: string): Promise<unknown>
      releaseAdmission(id: string): Promise<void>
    }
    const readOriginal = internals.readAdmissionOwner.bind(controller)
    let firstRead = true
    internals.readAdmissionOwner = async (path?: string): Promise<unknown> => {
      if (firstRead && path === undefined) {
        firstRead = false
        await unlink(lock)
        await writeFile(lock, JSON.stringify(newOwner), { mode: 0o600 })
        return { kind: 'owned', id: oldId, lease: oldLease }
      }
      return readOriginal(path)
    }

    await internals.releaseAdmission(oldId)

    expect(JSON.parse(await readFile(lock, 'utf8'))).toEqual(newOwner)
  })
})
