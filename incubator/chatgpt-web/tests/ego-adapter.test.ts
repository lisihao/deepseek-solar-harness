import { describe, expect, it, vi } from 'vitest'

import { EgoWebAdapter, EGO_FRAME_MARKER, type EgoProcessRunner } from '../src/ego-adapter.js'
import { EgoProcessError } from '../src/process-contract.js'
import type { ChatGptPageObservation } from '../src/page-observation.js'
import type { WebRunRequest, WebRunResource } from '../src/store.js'

const options = {
  executable: '/usr/local/bin/ego-browser',
  cwd: '/tmp/dsh-chatgpt-web',
  commandTimeoutMs: 1_000,
  stdoutMaxBytes: 128 * 1024,
}

const resource: WebRunResource = {
  spaceId: 3,
  pageLabel: 'p1',
  conversationUrl: 'https://chatgpt.com/c/fixed-resource',
}

type AdapterObservation = ChatGptPageObservation & { readonly userMessages: readonly string[] }

const observation: AdapterObservation = {
  url: resource.conversationUrl!,
  loginRequired: false,
  composerCount: 1,
  composerText: '',
  hasAttachments: false,
  userMessages: [],
  userMessageCount: 0,
  assistantMessages: [],
  generating: false,
  modelLabel: 'GPT-5',
  effortLabel: 'Medium',
}

function catalogFrameValue() {
  return {
    formatVersion: 1,
    observedAt: '2026-10-20T08:09:00.000Z',
    browser: { kind: 'ego-lite' as const, spaceId: resource.spaceId, pageLabel: resource.pageLabel },
    models: [{ label: 'Future Medium', available: true, selected: true }],
    effortModelLabel: 'Future Medium',
    efforts: [{ label: 'Novel horizon', id: 'horizon-v17', index: 4, available: true, selected: true }],
    selected: { modelLabel: 'Future Medium', effortLabel: 'Novel horizon', effortId: 'horizon-v17' },
  }
}

function success(value: unknown) {
  return {
    stdout: `${EGO_FRAME_MARKER}${JSON.stringify({ ok: true, value })}\n`,
    stderr: '',
    exitCode: 0 as const,
    executionStopped: true as const,
  }
}

function failure(code: string, message = 'fixture failure') {
  return {
    stdout: `${EGO_FRAME_MARKER}${JSON.stringify({ ok: false, error: { code, message } })}\n`,
    stderr: '',
    exitCode: 0 as const,
    executionStopped: true as const,
  }
}

function runnerReturning(value: unknown): { readonly run: EgoProcessRunner; readonly calls: ReturnType<typeof vi.fn> } {
  const calls = vi.fn(async () => success(value))
  return { run: calls as unknown as EgoProcessRunner, calls }
}

function request(overrides: Partial<WebRunRequest> = {}): WebRunRequest {
  return {
    prompt: 'read "quoted"\nline `code` ${value}',
    modelLabel: 'GPT-5',
    effortLabel: 'Medium',
    ...overrides,
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>

async function executeGeneratedSource(source: string, taskSpace: (...args: unknown[]) => unknown) {
  let stdout = ''
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as typeof process.stdout.write
  try {
    await new AsyncFunction('taskSpace', source)(taskSpace)
  } finally {
    process.stdout.write = originalWrite
  }
  return { stdout, stderr: '', exitCode: 0 as const, executionStopped: true as const }
}

function generatedSubmitFixture(
  postClickObservations: readonly AdapterObservation[],
  fixtureOptions: {
    readonly resource?: WebRunResource
    readonly initialObservation?: AdapterObservation
    readonly initialPageUrl?: string
    readonly beforeSendDelayMs?: number
    readonly requireLiteralPaste?: boolean
  } = {},
) {
  const prompt = request().prompt
  const fixtureResource = fixtureOptions.resource ?? resource
  const initialObservation = fixtureOptions.initialObservation ?? observation
  let filled = false
  let sent = false
  let currentUrl = fixtureOptions.initialPageUrl ?? 'about:blank'
  let modelView: 'simple' | 'advanced' = 'simple'
  let postClickReads = 0
  let sendAt: number | undefined
  const clicks: string[] = []
  const page = {
    async url() { return currentUrl },
    async goto() { currentUrl = 'https://chatgpt.com/' },
    async waitForSelector() {},
    async waitForFunction() {},
    async evaluate(fn: unknown, argument?: unknown) {
      const source = String(fn)
      if (argument === 'button[aria-label="选择 ChatGPT 模型"]') return { expanded: 'false' }
      if (argument === '[role="menu"]') return false
      if (source.includes('function inspectChatGptPage')) {
        if (!filled) return initialObservation
        if (!sent) return { ...initialObservation, composerText: prompt }
        const index = Math.min(postClickReads, postClickObservations.length - 1)
        postClickReads += 1
        return postClickObservations[index]
      }
      if (source.includes('data-model-picker-view')) {
        return { advanced: modelView === 'advanced', simple: modelView === 'simple', toggle: true }
      }
      if (source.includes('div.ProseMirror') && source.includes('prompt-textarea')) return 'textarea#prompt-textarea'
      if (source.includes('send-button')) return 'button[data-testid="send-button"]'
      throw new Error(`unexpected evaluate callback: ${source.slice(0, 80)}`)
    },
    async click(selector: string) {
      clicks.push(selector)
      if (selector === 'button[aria-label="选择 ChatGPT 模型"]') modelView = 'simple'
      if (selector === '[data-model-picker-view-toggle="true"][role="menuitem"]') modelView = 'advanced'
      if (selector === 'button[data-testid="send-button"]') {
        if (fixtureOptions.beforeSendDelayMs !== undefined) vi.advanceTimersByTime(fixtureOptions.beforeSendDelayMs)
        sendAt = Date.now()
        sent = true
      }
    },
    async focus() {},
    keyboard: { async paste(value: string) { if (value !== prompt) throw new Error("changed prompt"); filled = true } },
    async fill() { if (fixtureOptions.requireLiteralPaste) throw new Error("rich editor fill changes serialized Markdown"); filled = true },
    async press() {},
  }
  const taskSpace = async () => ({ ownership: 'agent', spaceId: fixtureResource.spaceId, page: () => page })
  const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
  return {
    run,
    page,
    clicks,
    postClickReads: () => postClickReads,
    sendAt: () => sendAt,
    setConversationUrl: () => {
      if (fixtureResource.conversationUrl !== undefined) currentUrl = fixtureResource.conversationUrl
    },
  }
}

describe('EgoWebAdapter', () => {
  it('creates one agent TaskSpace and reuses the resource without a second call', async () => {
    const fixture = runnerReturning({ spaceId: 3, pageLabel: 'p1' })
    const adapter = new EgoWebAdapter(options, fixture.run)

    await expect(adapter.create('run "quoted"')).resolves.toEqual({ spaceId: 3, pageLabel: 'p1' })
    await expect(adapter.create('run "quoted"')).resolves.toEqual({ spaceId: 3, pageLabel: 'p1' })
    expect(fixture.calls).toHaveBeenCalledOnce()
    const source = fixture.calls.mock.calls[0]?.[0].source ?? ''
    expect(source).toContain('taskSpace(__input.spaceId === undefined ? "ChatGPT Web " + __input.runId : __input.spaceId)')
    expect(source).toContain(JSON.stringify('run "quoted"'))
    expect(source).not.toContain('claimTaskSpace')
  })

  it('resumes a configured existing agent TaskSpace without creating another one', async () => {
    const fixture = runnerReturning({ spaceId: 3, pageLabel: 'p1' })
    const adapter = new EgoWebAdapter({ ...options, spaceId: 3 }, fixture.run)

    await expect(adapter.create('run-existing')).resolves.toEqual({ spaceId: 3, pageLabel: 'p1' })
    expect(fixture.calls).toHaveBeenCalledOnce()
    const input = fixture.calls.mock.calls[0]?.[0]
    expect(input?.source).toContain('taskSpace(__input.spaceId === undefined ?')
    expect(input?.source).not.toContain('claimTaskSpace')
    expect(input?.source).toContain(JSON.stringify({ runId: 'run-existing', spaceId: 3, createPage: false }))
  })

  it('allocates one fresh Page in a configured TaskSpace and preserves its pN label', async () => {
    const page = { label: 'p2' }
    const calls = { page: vi.fn(), newPage: vi.fn(async () => page) }
    const taskSpace = vi.fn(async (spaceId: unknown) => ({
      ownership: 'agent',
      spaceId,
      page: calls.page,
      newPage: calls.newPage,
    }))
    const runMock = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
    const run = runMock as unknown as EgoProcessRunner
    const adapter = new EgoWebAdapter({ ...options, spaceId: 3, createPage: true }, run)

    await expect(adapter.create('run-new-page "quoted"')).resolves.toEqual({ spaceId: 3, pageLabel: 'p2' })
    expect(taskSpace).toHaveBeenCalledWith(3)
    expect(calls.newPage).toHaveBeenCalledOnce()
    expect(calls.page).not.toHaveBeenCalled()
    expect(runMock.mock.calls[0]?.[0].source).toContain(JSON.stringify({ runId: 'run-new-page "quoted"', spaceId: 3, createPage: true }))
  })

  it('rejects createPage without a configured TaskSpace and invalid page labels', async () => {
    expect(() => new EgoWebAdapter({ ...options, createPage: true })).toThrow('createPage requires an existing TaskSpace id')

    const invalid = runnerReturning({ spaceId: 3, pageLabel: 'page2' })
    await expect(new EgoWebAdapter({ ...options, spaceId: 3, createPage: true }, invalid.run).create('invalid-page'))
      .rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })

    const adapter = new EgoWebAdapter(options, runnerReturning(observation).run)
    await expect(adapter.observe({ ...resource, pageLabel: 'p0' })).rejects.toMatchObject({ code: 'WEB_RESOURCE_INVALID' })
  })

  it('retains a shared TaskSpace without invoking CLI finish, while finishing only once', async () => {
    const fixture = runnerReturning({ spaceId: 3, pageLabel: 'p2' })
    const adapter = new EgoWebAdapter({ ...options, spaceId: 3, createPage: true, retainSpace: true }, fixture.run)
    const retained = await adapter.create('retain-space')

    await expect(adapter.finish(retained)).resolves.toBeUndefined()
    expect(fixture.calls).toHaveBeenCalledOnce()
    await expect(adapter.finish(retained)).rejects.toMatchObject({ code: 'WEB_ALREADY_FINISHED' })
    expect(fixture.calls).toHaveBeenCalledOnce()
  })

  it('prepares a fresh ChatGPT page and verifies exact observed labels without changing them', async () => {
    const fixture = runnerReturning(observation)
    const adapter = new EgoWebAdapter(options, fixture.run)
    const output = await adapter.prepare(resource, request())

    expect(output).toEqual(observation)
    const source = fixture.calls.mock.calls[0]?.[0].source ?? ''
    expect(source).toContain('https://chatgpt.com/')
    expect(source).toContain('waitForSelector')
    expect(source).toContain('button[aria-label=\\"选择 ChatGPT 模型\\"]')
    expect(source).toContain('[role=\\"menu\\"]')
    expect(source).toContain('data-model-picker-view=\\"advanced\\"')
    expect(source).toContain('data-model-picker-view-toggle=\\"true\\"')
    expect(source).toContain('WEB_MODEL_SELECTION_UNAVAILABLE')
    expect(source).toContain('WEB_EFFORT_SELECTION_UNAVAILABLE')
    expect(source).toContain('WEB_SELECTION_RESTORE_FAILED')
    expect(source).toContain('waitForFunction')
    expect(source).toContain('__publicError = Symbol')
    expect(source).toContain('Ego browser command failed')
    expect(source).toContain('state: "visible"')
    expect(source).toContain('"Escape"')
    expect(source).toContain('messageMarkdown')
    expect(source).toContain(JSON.stringify(request().prompt))
    expect(source).not.toContain('\u0008')
    const arrowLeft = source.match(/\/(\\bArrowLeft\\b)\/\.test\(shortcuts\)/)?.[1]
    const arrowRight = source.match(/\/(\\bArrowRight\\b)\/\.test\(shortcuts\)/)?.[1]
    expect(arrowLeft).toBe('\\bArrowLeft\\b')
    expect(arrowRight).toBe('\\bArrowRight\\b')
    expect(new RegExp(arrowLeft!).test('ArrowLeft ArrowRight')).toBe(true)
    expect(new RegExp(arrowRight!).test('ArrowLeft ArrowRight')).toBe(true)
  })

  it('requires an observed semantic webpage-search pill and validates its optional frame field', async () => {
    const missing = runnerReturning(observation)
    await expect(new EgoWebAdapter(options, missing.run).prepare(resource, request({ webSearch: true })))
      .rejects.toMatchObject({ code: 'WEB_SEARCH_ACTIVE_REQUIRED' })

    const selectedObservation = { ...observation, webSearchActive: true }
    await expect(new EgoWebAdapter(options, runnerReturning(selectedObservation).run)
      .prepare(resource, request({ webSearch: true }))).resolves.toEqual(selectedObservation)

    const effortUnknown = runnerReturning({ ...selectedObservation, effortLabel: undefined })
    await expect(new EgoWebAdapter(options, effortUnknown.run).prepare(resource, request({ webSearch: true })))
      .rejects.toMatchObject({ code: 'WEB_EFFORT_UNKNOWN' })

    const malformed = runnerReturning({ ...observation, webSearchActive: 'true' })
    await expect(new EgoWebAdapter(options, malformed.run).prepare(resource, request()))
      .rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })
  })

  it('rejects an unknown model while preserving an exact future model label', async () => {
    const missing = runnerReturning({ ...observation, modelLabel: undefined })
    const missingAdapter = new EgoWebAdapter(options, missing.run)
    await expect(missingAdapter.prepare(resource, request({ modelLabel: 'GPT-5' }))).rejects.toMatchObject({ code: 'WEB_MODEL_UNKNOWN' })

    const future = runnerReturning({ ...observation, modelLabel: 'Medium' })
    const futureAdapter = new EgoWebAdapter(options, future.run)
    await expect(futureAdapter.prepare(resource, request({ modelLabel: 'Medium' }))).resolves.toMatchObject({ modelLabel: 'Medium' })
  })

  it('selects one exact visible enabled model radio from an allowed fresh page, or names unavailable selection', async () => {
    const makeScenario = (availableModels: readonly string[], initialUrl = 'about:blank') => {
      let currentModel = 'GPT-5.6 Sol'
      let requestedModel = 'GPT-6'
      let view: 'simple' | 'advanced' = 'simple'
      let currentUrl = initialUrl
      let gotoCalls = 0
      let modelControlReady = false
      let modelRadioReady = false
      let menuOpen = false
      let toggleReady = false
      let waitForFunctionCalls = 0
      const clicks: string[] = []
      const page = {
        async url() { return currentUrl },
        async goto() { gotoCalls += 1; currentUrl = 'https://chatgpt.com/' },
        async waitForSelector() {},
        async waitForFunction(_fn: unknown, argument?: unknown) {
          waitForFunctionCalls += 1
          modelControlReady = true
          if (argument !== 'button[aria-label="选择 ChatGPT 模型"]' && !menuOpen && waitForFunctionCalls >= 4) {
            throw new Error('model radio remains hidden until the picker reopens')
          }
          if (String(_fn).includes('data-model-picker-view-toggle')) toggleReady = true
          if (menuOpen && String(_fn).includes('aria-checked="true"')) {
            if (view !== 'advanced') throw new Error('model radio remains hidden outside advanced view')
            modelRadioReady = true
          }
        },
        async evaluate(fn: unknown, argument?: unknown) {
          const source = String(fn)
          if (argument === 'button[aria-label="选择 ChatGPT 模型"]') {
            return modelControlReady ? { expanded: menuOpen ? 'true' : 'false' } : null
          }
          if (argument === '[role="menu"]') return menuOpen
          if (source.includes('function inspectChatGptPage')) return { ...observation, modelLabel: currentModel }
          if (source.includes('menuitemradio')) {
            if (!modelRadioReady) return null
            return availableModels.includes(String(argument)) ? 'div.model-target' : null
          }
          if (source.includes('data-model-picker-view')) {
            return { advanced: view === 'advanced', simple: view === 'simple', toggle: toggleReady }
          }
          throw new Error('unexpected model-selection evaluate callback')
        },
        async click(selector: string) {
          clicks.push(selector)
          if (selector === 'button[aria-label="选择 ChatGPT 模型"]') {
            menuOpen = true
            view = 'simple'
            toggleReady = false
            modelRadioReady = false
          }
          else if (selector === '[data-model-picker-view-toggle="true"][role="menuitem"]') view = view === 'simple' ? 'advanced' : 'simple'
          else if (selector === 'div.model-target') {
            currentModel = requestedModel
            // The live picker switches to the simple effort view while the
            // selected radio remains on a hidden track.
            menuOpen = true
            view = 'simple'
            modelRadioReady = false
          }
        },
        async press(_selector: string, key: string) {
          if (key === 'Escape') menuOpen = false
        },
      }
      const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
      const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
      const adapter = new EgoWebAdapter(options, run)
      return {
        adapter,
        clicks,
        gotoCalls: () => gotoCalls,
        waitForFunctionCalls: () => waitForFunctionCalls,
        setRequestedModel: (value: string) => { requestedModel = value },
      }
    }

    const selected = makeScenario(['GPT-6'], 'chrome://new-tab-page/')
    selected.setRequestedModel('GPT-6')
    await expect(selected.adapter.prepare(resource, request({ modelLabel: 'GPT-6' }))).resolves.toMatchObject({ modelLabel: 'GPT-6' })
    expect(selected.clicks).toContain('div.model-target')
    expect(selected.clicks.filter((selector) => selector === 'div.model-target')).toHaveLength(1)
    expect(selected.clicks.filter((selector) => selector === '[data-model-picker-view-toggle="true"][role="menuitem"]')).toHaveLength(4)
    expect(selected.gotoCalls()).toBe(1)
    expect(selected.waitForFunctionCalls()).toBeGreaterThan(0)

    const unavailable = makeScenario([])
    unavailable.setRequestedModel('GPT-6')
    await expect(unavailable.adapter.prepare(resource, request({ modelLabel: 'GPT-6' }))).rejects.toMatchObject({ code: 'WEB_MODEL_SELECTION_UNAVAILABLE' })
    expect(unavailable.clicks).not.toContain('div.model-target')
  })

  it('walks the bounded effort slider by raw ids and restores its original index when unmatched', async () => {
    const makeScenario = (requestedEffort: string, blockRestore = false) => {
      let index = 1
      let view: 'simple' | 'advanced' = 'simple'
      let currentUrl = 'about:blank'
      const rawIds = ['low', 'medium', 'high']
      let effortControlReady = false
      let waitForFunctionCalls = 0
      const presses: Array<{ readonly selector: string; readonly key: string }> = []
      const page = {
        async url() { return currentUrl },
        async goto() { currentUrl = 'https://chatgpt.com/' },
        async waitForSelector() {},
        async waitForFunction(_fn: unknown, input?: { readonly expectedIndex?: number }) {
          waitForFunctionCalls += 1
          if (String(_fn).includes('data-reasoning-slider')) effortControlReady = true
          if (input?.expectedIndex !== undefined && index !== input.expectedIndex) throw new Error('slider transition not observed')
        },
        async evaluate(fn: unknown, argument?: unknown) {
          const source = String(fn)
          if (argument === 'button[aria-label="选择 ChatGPT 模型"]') return { expanded: 'false' }
          if (argument === '[role="menu"]') return true
          if (source.includes('function inspectChatGptPage')) return { ...observation, effortLabel: rawIds[index] }
          if (source.includes('data-reasoning-slider')) {
            if (!effortControlReady) return null
            return { sliderSelector: 'div.slider-wrapper', min: 0, max: 2, now: index, rawId: rawIds[index] }
          }
          if (source.includes('data-model-picker-view')) return { advanced: view === 'advanced', simple: view === 'simple', toggle: true }
          throw new Error('unexpected effort-selection evaluate callback')
        },
        async click(selector: string) {
          if (selector === 'button[aria-label="选择 ChatGPT 模型"]') view = 'simple'
          else if (selector === '[data-model-picker-view-toggle="true"][role="menuitem"]') view = view === 'simple' ? 'advanced' : 'simple'
        },
        async press(selector: string, key: string) {
          presses.push({ selector, key })
          if (blockRestore && index === 2 && key === 'ArrowLeft') return
          if (key === 'ArrowLeft') index = Math.max(0, index - 1)
          if (key === 'ArrowRight') index = Math.min(2, index + 1)
        },
      }
      const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
      const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
      const adapter = new EgoWebAdapter(options, run)
      return { adapter, presses, currentIndex: () => index, requestedEffort, waitForFunctionCalls: () => waitForFunctionCalls }
    }

    const matched = makeScenario('high')
    await expect(matched.adapter.prepare(resource, request({ effortLabel: matched.requestedEffort }))).resolves.toMatchObject({ effortLabel: 'high' })
    expect(matched.currentIndex()).toBe(2)
    expect(matched.presses.filter(({ selector }) => selector === 'div.slider-wrapper').length).toBeGreaterThan(0)
    expect(matched.waitForFunctionCalls()).toBeGreaterThan(0)

    const unmatched = makeScenario('missing')
    await expect(unmatched.adapter.prepare(resource, request({ effortLabel: unmatched.requestedEffort }))).rejects.toMatchObject({ code: 'WEB_EFFORT_SELECTION_UNAVAILABLE' })
    expect(unmatched.currentIndex()).toBe(1)
    expect(unmatched.presses.every(({ selector }) => selector === 'div.slider-wrapper' || selector.includes('选择 ChatGPT 模型'))).toBe(true)

    const restoreFailed = makeScenario('missing', true)
    await expect(restoreFailed.adapter.prepare(resource, request({ effortLabel: restoreFailed.requestedEffort }))).rejects.toMatchObject({ code: 'WEB_SELECTION_RESTORE_FAILED' })
    expect(restoreFailed.currentIndex()).toBe(2)
  })

  it('restores a duplicate-raw-id Pro selection by index and never fills or submits during catalog discovery', async () => {
    const originalModel = 'Current Browser Model'
    const targetModel = 'Future Medium'
    const effortChoices = {
      [originalModel]: [
        { label: 'Low focus', id: 'low' },
        { label: '中', id: 'medium' },
        { label: 'High focus', id: 'high' },
        { label: 'Max focus', id: 'max' },
        { label: 'Pro', id: 'medium' },
      ],
      [targetModel]: [
        { label: 'Speculative field', id: 'field-v17' },
        { label: 'Novel horizon', id: 'horizon-v17' },
      ],
    } as const
    const makeScenario = ({
      blockOriginalEffortRestore = false,
      failTargetEnumeration = false,
      initialUrl = 'about:blank',
    }: {
      readonly blockOriginalEffortRestore?: boolean
      readonly failTargetEnumeration?: boolean
      readonly initialUrl?: string
    } = {}) => {
      let currentUrl = initialUrl
      let gotoCalls = 0
      let selectedModel = originalModel
      const selectedIndex: Record<string, number> = { [originalModel]: 4, [targetModel]: 1 }
      let menuOpen = false
      let view: 'simple' | 'advanced' = 'simple'
      const clicks: string[] = []
      const presses: Array<{ readonly selector: string; readonly key: string }> = []
      const fills: string[] = []
      const inserts: string[] = []
      const choicesFor = () => effortChoices[selectedModel as keyof typeof effortChoices]
      const effortFor = () => choicesFor()[selectedIndex[selectedModel] ?? 0]!
      const page = {
        keyboard: {
          async insertText(value: string) { inserts.push(value); throw new Error('catalog must not insert text') },
        },
        async url() { return currentUrl },
        async goto() { gotoCalls += 1; currentUrl = 'https://chatgpt.com/' },
        async waitForSelector() {},
        async waitForFunction(_fn: unknown, argument?: { readonly expectedIndex?: number } | string) {
          if (typeof argument === 'string' && String(_fn).includes('aria-checked="true"')) {
            expect(String(_fn)).toContain('element.getAttribute("data-model-label")')
            expect(String(_fn)).toContain('element.getAttribute("data-model-name")')
          }
          const expectedIndex = typeof argument === 'object' && argument !== null ? argument.expectedIndex : undefined
          if (expectedIndex !== undefined && selectedIndex[selectedModel] !== expectedIndex) {
            throw new Error('reasoning slider transition was not observed')
          }
        },
        async evaluate(fn: unknown, argument?: unknown) {
          const source = String(fn)
          if (source.includes('function inspectChatGptPage')) {
            const effort = effortFor()
            return {
              ...observation,
              url: currentUrl,
              modelLabel: selectedModel,
              ...(menuOpen && view === 'advanced' ? {} : { effortLabel: effort.label }),
              effortId: effort.id,
            }
          }
          if (argument === 'button[aria-label="选择 ChatGPT 模型"]') return { expanded: menuOpen ? 'true' : 'false' }
          if (argument === '[role="menu"]') return menuOpen
          if (source.includes('const radios = Array.from')) {
            if (typeof argument === 'string') {
              expect(source).toContain('element.getAttribute("data-model-label")')
              expect(source).toContain('element.getAttribute("data-model-name")')
              return [originalModel, targetModel].includes(argument) ? `model:${argument}` : null
            }
            return [originalModel, targetModel].map((label) => ({ label, available: true, selected: label === selectedModel }))
          }
          if (source.includes('data-model-picker-view')) {
            return { advanced: view === 'advanced', simple: view === 'simple', toggle: true }
          }
          if (source.includes('return wrappers.length === 1')) return true
          if (source.includes('data-reasoning-slider')) {
            if (failTargetEnumeration && selectedModel === targetModel) return null
            const effort = effortFor()
            return {
              sliderSelector: 'div.reasoning-slider', min: 0, max: choicesFor().length - 1,
              now: selectedIndex[selectedModel], rawId: effort.id,
            }
          }
          throw new Error(`unexpected catalog evaluate callback: ${source.slice(0, 100)}`)
        },
        async click(selector: string) {
          clicks.push(selector)
          if (selector === 'button[aria-label="选择 ChatGPT 模型"]') {
            menuOpen = true
            view = 'simple'
          } else if (selector === '[data-model-picker-view-toggle="true"][role="menuitem"]') {
            view = view === 'simple' ? 'advanced' : 'simple'
          } else if (selector.startsWith('model:')) {
            selectedModel = selector.slice('model:'.length)
            selectedIndex[selectedModel] = 0
            menuOpen = true
            view = 'simple'
          }
        },
        async press(selector: string, key: string) {
          presses.push({ selector, key })
          if (key === 'Escape') {
            menuOpen = false
            return
          }
          if (selector !== 'div.reasoning-slider') throw new Error('unexpected non-slider key press')
          if (blockOriginalEffortRestore && selectedModel === originalModel && selectedIndex[selectedModel] === 0 && key === 'ArrowRight') return
          if (key === 'ArrowLeft') selectedIndex[selectedModel] = Math.max(0, (selectedIndex[selectedModel] ?? 0) - 1)
          if (key === 'ArrowRight') selectedIndex[selectedModel] = Math.min(choicesFor().length - 1, (selectedIndex[selectedModel] ?? 0) + 1)
        },
        async fill(_selector: string, value: string) { fills.push(value); throw new Error('catalog must not fill') },
      }
      const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
      const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
      return {
        adapter: new EgoWebAdapter(options, run),
        current: () => ({ model: selectedModel, index: selectedIndex[selectedModel] }),
        gotoCalls: () => gotoCalls,
        clicks,
        presses,
        fills,
        inserts,
      }
    }

    const success = makeScenario()
    const catalog = await success.adapter.catalog(resource, { modelLabel: targetModel })
    expect(catalog).toMatchObject({
      formatVersion: 1,
      browser: { kind: 'ego-lite', spaceId: resource.spaceId, pageLabel: resource.pageLabel },
      models: [
        { label: originalModel, available: true, selected: true },
        { label: targetModel, available: true, selected: false },
      ],
      effortModelLabel: targetModel,
      efforts: [
        { label: 'Speculative field', id: 'field-v17', index: 0, available: true, selected: true },
        { label: 'Novel horizon', id: 'horizon-v17', index: 1, available: true, selected: false },
      ],
      selected: { modelLabel: originalModel, effortLabel: 'Pro', effortId: 'medium' },
    })
    expect(success.current()).toEqual({ model: originalModel, index: 4 })
    expect(success.clicks).toContain(`model:${targetModel}`)
    expect(success.clicks).toContain(`model:${originalModel}`)
    expect(success.presses.some(({ key }) => key === 'ArrowRight')).toBe(true)
    expect(success.fills).toEqual([])
    expect(success.inserts).toEqual([])
    expect(success.clicks).not.toContain('button[data-testid="send-button"]')
    await expect(success.adapter.prepare(resource, request({ modelLabel: originalModel, effortLabel: 'Pro' })))
      .resolves.toMatchObject({ modelLabel: originalModel, effortLabel: 'Pro', effortId: 'medium' })
    expect(success.current()).toEqual({ model: originalModel, index: 4 })

    const fromObservedEgoNewTab = makeScenario({ initialUrl: 'chrome://new-tab-page/' })
    await expect(fromObservedEgoNewTab.adapter.catalog(resource, { modelLabel: targetModel })).resolves.toMatchObject({
      effortModelLabel: targetModel,
      selected: { modelLabel: originalModel },
    })
    expect(fromObservedEgoNewTab.gotoCalls()).toBe(1)
    expect(fromObservedEgoNewTab.fills).toEqual([])
    expect(fromObservedEgoNewTab.inserts).toEqual([])
    expect(fromObservedEgoNewTab.clicks).not.toContain('button[data-testid="send-button"]')

    const failedDiscovery = makeScenario({ failTargetEnumeration: true })
    await expect(failedDiscovery.adapter.catalog(resource, { modelLabel: targetModel }))
      .rejects.toMatchObject({ code: 'WEB_EFFORT_SELECTION_UNAVAILABLE' })
    expect(failedDiscovery.current()).toEqual({ model: originalModel, index: 4 })
    expect(failedDiscovery.fills).toEqual([])
    expect(failedDiscovery.inserts).toEqual([])

    const failedRestore = makeScenario({ blockOriginalEffortRestore: true })
    await expect(failedRestore.adapter.catalog(resource, { modelLabel: targetModel }))
      .rejects.toMatchObject({ code: 'WEB_SELECTION_RESTORE_FAILED' })
    expect(failedRestore.current()).toEqual({ model: originalModel, index: 0 })
    expect(failedRestore.fills).toEqual([])
    expect(failedRestore.inserts).toEqual([])
  })

  it('strictly validates the catalog frame and binds it to the requested target page', async () => {
    const value = catalogFrameValue()
    await expect(new EgoWebAdapter(options, runnerReturning(value).run).catalog(resource, {})).resolves.toEqual(value)
    await expect(new EgoWebAdapter(options, runnerReturning({ ...value, extra: true }).run).catalog(resource, {}))
      .rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })
    await expect(new EgoWebAdapter(options, runnerReturning({
      ...value,
      browser: { ...value.browser, pageLabel: 'p2' },
    }).run).catalog(resource, {})).rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })
  })

  it('extends and caps catalog process timeout without changing its inner DOM timeout', async () => {
    for (const [commandTimeoutMs, expectedProcessTimeoutMs] of [[25_000, 50_000], [70_000, 120_000]] as const) {
      const fixture = runnerReturning(catalogFrameValue())
      await expect(new EgoWebAdapter({ ...options, commandTimeoutMs }, fixture.run).catalog(resource, {}))
        .resolves.toEqual(catalogFrameValue())

      const invocation = fixture.calls.mock.calls[0]?.[0]
      expect(invocation?.timeoutMs).toBe(expectedProcessTimeoutMs)
      expect(invocation?.source).toContain(`\"timeoutMs\":${commandTimeoutMs}`)
    }
  })

  it('budgets prepare for navigation and selection while keeping other operations at the command timeout', async () => {
    const calls = vi.fn(async (invocation: Parameters<EgoProcessRunner>[0]) => {
      if (invocation.source.includes('const __operation = "create";')) return success({ spaceId: 3, pageLabel: 'p1' })
      if (invocation.source.includes('const __operation = "finish";')) return success({ finished: true })
      if (invocation.source.includes('const __operation = "prepare";')
        || invocation.source.includes('const __operation = "observe";')
        || invocation.source.includes('const __operation = "submit";')) return success(observation)
      throw new Error('unexpected Ego operation')
    })
    const adapter = new EgoWebAdapter({ ...options, commandTimeoutMs: 25_000 }, calls as unknown as EgoProcessRunner)
    const created = await adapter.create('original-operation-budgets')

    await adapter.prepare(created, request())
    await adapter.observe(created)
    await adapter.submit(created, request())
    await adapter.finish(created)

    expect(calls).toHaveBeenCalledTimes(5)
    for (const [invocation] of calls.mock.calls) {
      expect(invocation.timeoutMs).toBe(invocation.source.includes('const __operation = "prepare";') ? 50_000 : 25_000)
      if (invocation.source.includes('const __operation = "prepare";')) expect(invocation.source).toContain('"timeoutMs":25000')
    }
  })

  it('names the catalog URL-boundary phase without returning the page URL', async () => {
    const runFor = (initialUrl: string, afterGoto = initialUrl): EgoProcessRunner => vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => {
      let url = initialUrl
      const page = {
        async url() { return url },
        async goto() { url = afterGoto },
      }
      const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
      return executeGeneratedSource(input.source, taskSpace)
    }) as unknown as EgoProcessRunner

    const existingRoute = await new EgoWebAdapter(options, runFor('https://chatgpt.com/c/private-route')).catalog(resource, {}).catch((error: unknown) => error)
    expect(existingRoute).toMatchObject({ code: 'WEB_RESOURCE_CHANGED', message: 'ChatGPT catalog initial route is not the root page' })
    expect((existingRoute as Error).message).not.toContain('private-route')

    await expect(new EgoWebAdapter(options, runFor('https://example.test/')).catalog(resource, {}))
      .rejects.toMatchObject({ code: 'WEB_RESOURCE_CHANGED', message: 'ChatGPT catalog initial page is not blank or ChatGPT' })
    await expect(new EgoWebAdapter(options, runFor('chrome://settings/')).catalog(resource, {}))
      .rejects.toMatchObject({ code: 'WEB_RESOURCE_CHANGED', message: 'ChatGPT catalog initial page is not blank or ChatGPT' })
    await expect(new EgoWebAdapter(options, runFor('about:blank', 'https://chatgpt.com/c/after-navigation')).catalog(resource, {}))
      .rejects.toMatchObject({ code: 'WEB_RESOURCE_CHANGED', message: 'ChatGPT catalog navigation did not reach the root page' })
  })

  it('propagates user control without claiming or rebuilding the TaskSpace', async () => {
    const fixture = {
      calls: vi.fn(async (_input: Parameters<EgoProcessRunner>[0]) => failure('WEB_USER_CONTROL', 'ownership changed')),
    }
    const adapter = new EgoWebAdapter(options, fixture.calls as unknown as EgoProcessRunner)

    await expect(adapter.observe(resource)).rejects.toMatchObject({ code: 'WEB_USER_CONTROL' })
    const source = fixture.calls.mock.calls[0]?.[0].source ?? ''
    expect(source).toContain('taskSpace(__input.resource.spaceId)')
    expect(source).not.toContain('claimTaskSpace')
  })

  it('submits one exact prompt with one visible send click and does not retry', async () => {
    const afterSubmit = { ...observation, userMessages: [request().prompt], userMessageCount: 1, generating: true }
    const calls = vi.fn(async (_input: Parameters<EgoProcessRunner>[0]) => success(calls.mock.calls.length <= 1 ? observation : afterSubmit))
    const fixture = { run: calls as unknown as EgoProcessRunner, calls }
    const adapter = new EgoWebAdapter(options, fixture.run)
    await adapter.prepare(resource, request())
    const submitted = await adapter.submit(resource, request())

    expect(submitted).toEqual(afterSubmit)
    expect(fixture.calls).toHaveBeenCalledTimes(2)
    const source = fixture.calls.mock.calls[1]?.[0].source ?? ''
    expect(source.match(/__page\.click\(__sendSelector/g)).toHaveLength(1)
    expect(source).toContain('waitForSelector')
    expect(source).toContain('"Escape"')
    expect(source).toContain(JSON.stringify(request().prompt))
    expect(source).toContain('__page.keyboard.paste(__input.request.prompt)')
    expect(source).not.toContain('__page.fill(__composerSelector')
    await expect(adapter.submit(resource, request())).rejects.toMatchObject({ code: 'WEB_SUBMISSION_ALREADY_ATTEMPTED' })
    expect(fixture.calls).toHaveBeenCalledTimes(2)
  })

  it('uses native literal paste in the rich editor instead of fill that reserializes Markdown', async () => {
    const afterSubmit = { ...observation, userMessages: [request().prompt], userMessageCount: 1, generating: true }
    const fixture = generatedSubmitFixture([afterSubmit], { requireLiteralPaste: true })
    const adapter = new EgoWebAdapter(options, fixture.run)
    await adapter.prepare(resource, request())
    fixture.setConversationUrl()
    await expect(adapter.submit(resource, request())).resolves.toEqual(afterSubmit)
    expect(fixture.clicks.filter(value => value === 'button[data-testid="send-button"]')).toHaveLength(1)
  })

  it('executes the generated submit script through a keyless fake page roundtrip', async () => {
    const prompt = request().prompt
    const afterSubmit = { ...observation, modelLabel: undefined, effortLabel: undefined, userMessages: [prompt], userMessageCount: 1, generating: true }
    const expectedSubmit = { ...afterSubmit, modelLabel: observation.modelLabel, effortLabel: observation.effortLabel }
    const calls = {
      evaluate: [] as Array<{ readonly source: string; readonly argument: unknown }>,
      click: [] as string[],
      fill: [] as Array<{ readonly selector: string; readonly value: string }>,
      press: [] as Array<{ readonly selector: string; readonly key: string }>,
      waitForSelector: [] as string[],
    }
    let filled = false
    let modelView: 'simple' | 'advanced' = 'simple'
    let currentUrl = 'about:blank'
    const page = {
      async focus() {},
      keyboard: { async paste(value: string) { calls.fill.push({ selector: 'native-literal-paste', value }); filled = true } },
      async url() { return currentUrl },
      async goto() { currentUrl = 'https://chatgpt.com/' },
      async waitForSelector(selector: string) { calls.waitForSelector.push(selector) },
      async waitForFunction() {},
      async evaluate(fn: unknown, argument?: unknown) {
        expect(typeof fn).toBe('function')
        const source = String(fn)
        calls.evaluate.push({ source, argument })
        if (argument === 'button[aria-label="选择 ChatGPT 模型"]') return { expanded: 'false' }
        if (argument === '[role="menu"]') return true
        if (source.includes('function inspectChatGptPage')) {
          if (!filled) return observation
          if (calls.click.includes('button[data-testid="send-button"]')) return afterSubmit
          return { ...observation, composerText: prompt }
        }
        if (source.includes('data-model-picker-view')) {
          return { advanced: modelView === 'advanced', simple: modelView === 'simple', toggle: modelView === 'simple' }
        }
        if (source.includes('div.ProseMirror') && source.includes('prompt-textarea')) return 'textarea#prompt-textarea'
        if (source.includes('send-button')) return 'button[data-testid="send-button"]'
        throw new Error(`unexpected evaluate callback: ${source.slice(0, 80)}`)
      },
      async click(selector: string) {
        calls.click.push(selector)
        if (selector === 'button[aria-label="选择 ChatGPT 模型"]') modelView = 'simple'
        if (selector === '[data-model-picker-view-toggle="true"][role="menuitem"]') modelView = 'advanced'
      },
      async fill(selector: string, value: string) {
        calls.fill.push({ selector, value })
        filled = true
      },
      async press(selector: string, key: string) { calls.press.push({ selector, key }) },
    }
    const taskSpace = async () => ({
      ownership: 'agent',
      spaceId: resource.spaceId,
      page: () => page,
    })
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>
    const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => {
      let stdout = ''
      const originalWrite = process.stdout.write
      process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        return true
      }) as typeof process.stdout.write
      try {
        await new AsyncFunction('taskSpace', input.source)(taskSpace)
      } finally {
        process.stdout.write = originalWrite
      }
      return {
        stdout,
        stderr: '',
        exitCode: 0 as const,
        executionStopped: true as const,
      }
    })
    const adapter = new EgoWebAdapter(options, run)

    await expect(adapter.prepare(resource, request())).resolves.toEqual(observation)
    currentUrl = resource.conversationUrl!
    calls.evaluate.length = 0
    calls.click.length = 0
    calls.fill.length = 0
    calls.press.length = 0
    calls.waitForSelector.length = 0
    filled = false
    modelView = 'simple'
    await expect(adapter.submit(resource, request())).resolves.toEqual(expectedSubmit)
    expect(calls.fill).toEqual([{ selector: 'native-literal-paste', value: prompt }])
    expect(calls.click).toEqual([
      'button[aria-label="选择 ChatGPT 模型"]',
      '[data-model-picker-view-toggle="true"][role="menuitem"]',
      'button[aria-label="选择 ChatGPT 模型"]',
      '[data-model-picker-view-toggle="true"][role="menuitem"]',
      'button[data-testid="send-button"]',
    ])
    expect(calls.press).toEqual([
      { selector: 'button[aria-label="选择 ChatGPT 模型"]', key: 'Escape' },
      { selector: 'button[aria-label="选择 ChatGPT 模型"]', key: 'Escape' },
    ])
    expect(calls.waitForSelector).toEqual([
      '[role="menu"]',
      '[data-model-picker-view="advanced"]',
      '[role="menu"]',
      '[data-model-picker-view="advanced"]',
    ])
    expect(calls.evaluate.every(({ source }) => !source.includes('function.toString()'))).toBe(true)
  })

  it('polls the generated submit receipt for a delayed matching user bubble without a second click', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const prompt = request().prompt
      const delayed = { ...observation, userMessages: [prompt], userMessageCount: 1, generating: true }
      const fixture = generatedSubmitFixture([observation, delayed])
      const adapter = new EgoWebAdapter({ ...options, commandTimeoutMs: 10_000 }, fixture.run)

      await expect(adapter.prepare(resource, request())).resolves.toEqual(observation)
      fixture.setConversationUrl()
      const submitted = adapter.submit(resource, request())
      await vi.runAllTimersAsync()

      await expect(submitted).resolves.toEqual(delayed)
      expect(fixture.clicks.filter((selector) => selector === 'button[data-testid="send-button"]')).toHaveLength(1)
      expect(fixture.postClickReads()).toBe(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts pre-send work against the same total deadline before receipt polling', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const fixture = generatedSubmitFixture([observation], { beforeSendDelayMs: 8_850 })
      const adapter = new EgoWebAdapter({ ...options, commandTimeoutMs: 10_000 }, fixture.run)

      await expect(adapter.prepare(resource, request())).resolves.toEqual(observation)
      fixture.setConversationUrl()
      const submitted = adapter.submit(resource, request())
      await vi.runAllTimersAsync()

      await expect(submitted).resolves.toMatchObject({ userMessageCount: 0, userMessages: [] })
      expect(fixture.sendAt()).toBe(8_850)
      expect(Date.now()).toBeLessThanOrEqual(9_750)
      expect(fixture.postClickReads()).toBeLessThan(50)
      expect(fixture.clicks.filter((selector) => selector === 'button[data-testid="send-button"]')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows one same-origin root-to-conversation transition for a new resource, then stops on another conversation', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const newResource: WebRunResource = { spaceId: 3, pageLabel: 'p1' }
      const rootObservation = { ...observation, url: 'https://chatgpt.com/' }
      const firstConversation = { ...rootObservation, url: 'https://chatgpt.com/c/first-conversation' }
      const otherConversation = { ...rootObservation, url: 'https://chatgpt.com/c/other-conversation' }
      const fixture = generatedSubmitFixture(
        [rootObservation, firstConversation, otherConversation],
        { resource: newResource, initialObservation: rootObservation, initialPageUrl: 'https://chatgpt.com/' },
      )
      const adapter = new EgoWebAdapter({ ...options, commandTimeoutMs: 10_000 }, fixture.run)

      await expect(adapter.prepare(newResource, request())).resolves.toEqual(rootObservation)
      const submitted = adapter.submit(newResource, request())
      await vi.runAllTimersAsync()

      await expect(submitted).resolves.toEqual(otherConversation)
      expect(fixture.postClickReads()).toBe(3)
      expect(fixture.clicks.filter((selector) => selector === 'button[data-testid="send-button"]')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns a permanently missing receipt within the fixed polling slice', async () => {
    vi.useFakeTimers({ now: 0 })
    try {
      const fixture = generatedSubmitFixture([observation])
      const adapter = new EgoWebAdapter({ ...options, commandTimeoutMs: 10_000 }, fixture.run)

      await expect(adapter.prepare(resource, request())).resolves.toEqual(observation)
      fixture.setConversationUrl()
      const submitted = adapter.submit(resource, request())
      await vi.runAllTimersAsync()

      await expect(submitted).resolves.toMatchObject({ userMessageCount: 0, userMessages: [] })
      expect(fixture.clicks.filter((selector) => selector === 'button[data-testid="send-button"]')).toHaveLength(1)
      expect(fixture.postClickReads()).toBeLessThanOrEqual(50)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['mismatched bubble', { ...observation, userMessages: ['different prompt'], userMessageCount: 1 }],
    ['duplicate bubbles', { ...observation, userMessages: [request().prompt, request().prompt], userMessageCount: 2 }],
    ['assistant appeared', { ...observation, assistantMessages: [{ text: 'answer', markdown: 'answer' }] }],
    ['visible error', { ...observation, visibleError: 'temporary error' }],
    ['login required', { ...observation, loginRequired: true }],
    ['route changed', { ...observation, url: 'https://chatgpt.com/c/other-route' }],
  ] as const)('returns %s immediately without receipt polling or send retries', async (_name, afterClick) => {
    vi.useFakeTimers({ now: 0 })
    try {
      const fixture = generatedSubmitFixture([afterClick])
      const adapter = new EgoWebAdapter({ ...options, commandTimeoutMs: 10_000 }, fixture.run)

      await expect(adapter.prepare(resource, request())).resolves.toEqual(observation)
      fixture.setConversationUrl()
      await expect(adapter.submit(resource, request())).resolves.toEqual(afterClick)

      expect(fixture.clicks.filter((selector) => selector === 'button[data-testid="send-button"]')).toHaveLength(1)
      expect(fixture.postClickReads()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('selects the visible webpage-search option and preserves its pill while inserting the exact prompt', async () => {
    const prompt = '网页搜索用户自己写下的前缀也必须保留。'
    let currentUrl = 'about:blank'
    let modelView: 'simple' | 'advanced' = 'simple'
    let searchMenuOpen = false
    let searchActive = false
    let draft = ''
    let sent = false
    const clicks: string[] = []
    const inserted: string[] = []
    const fills: Array<{ readonly selector: string; readonly value: string }> = []
    const pageObservation = (): AdapterObservation => ({
      ...observation,
      url: currentUrl,
      composerText: sent ? '' : draft,
      userMessages: sent ? [prompt] : [],
      userMessageCount: sent ? 1 : 0,
      generating: sent,
      ...(searchActive && !sent ? { webSearchActive: true } : {}),
    })
    const page = {
      keyboard: {
        async insertText(value: string) {
          if (!searchActive) throw new Error('search pill disappeared before text insertion')
          inserted.push(value)
          draft += value
        },
      },
      async url() { return currentUrl },
      async goto() { currentUrl = 'https://chatgpt.com/' },
      async waitForSelector() {},
      async waitForFunction() {},
      async evaluate(fn: unknown, argument?: unknown) {
        const source = String(fn)
        if (source.includes('function inspectChatGptPage')) return pageObservation()
        if (source.includes('data-list-navigation-item')) {
          return { composerTools: 1, searchOptions: searchMenuOpen ? 1 : 0 }
        }
        if (source.includes('data-model-picker-view')) {
          return { advanced: modelView === 'advanced', simple: modelView === 'simple', toggle: true }
        }
        if (source.includes('selectNodeContents') && source.includes('createRange')) return true
        if (argument === 'button[aria-label="选择 ChatGPT 模型"]') return { expanded: 'false' }
        if (argument === '[role="menu"]') return false
        if (source.includes('div.ProseMirror') && source.includes('prompt-textarea')) return 'textarea#prompt-textarea'
        if (source.includes('send-button')) return 'button[data-testid="send-button"]'
        throw new Error(`unexpected webpage-search evaluate callback: ${source.slice(0, 80)}`)
      },
      async click(selector: string) {
        clicks.push(selector)
        if (selector === 'button[aria-label="选择 ChatGPT 模型"]') modelView = 'simple'
        else if (selector === '[data-model-picker-view-toggle="true"][role="menuitem"]') modelView = 'advanced'
        else if (selector === 'button[aria-label="添加文件等内容"]') searchMenuOpen = true
        else if (selector === 'button[data-list-navigation-item="true"]:has-text("网页搜索")') {
          if (!searchMenuOpen) throw new Error('webpage-search menu was not opened')
          searchActive = true
        } else if (selector === 'button[data-testid="send-button"]') sent = true
      },
      async fill(selector: string, value: string) {
        fills.push({ selector, value })
        throw new Error('webpage-search submission must not clear the selected pill')
      },
      async press() {},
    }
    const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
    const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
    const adapter = new EgoWebAdapter(options, run)

    const prepared = await adapter.prepare(resource, request({ prompt, webSearch: true }))
    expect(prepared.webSearchActive).toBe(true)
    currentUrl = resource.conversationUrl!
    const submitted = await adapter.submit(resource, request({ prompt, webSearch: true }))

    expect(clicks).toContain('button[aria-label="添加文件等内容"]')
    expect(clicks).toContain('button[data-list-navigation-item="true"]:has-text("网页搜索")')
    expect(clicks.filter((selector) => selector === 'button[data-testid="send-button"]')).toHaveLength(1)
    expect(inserted).toEqual([prompt])
    expect(fills).toEqual([])
    expect(submitted.userMessages).toEqual([prompt])
    expect(submitted.webSearchActive).toBeUndefined()
  })

  it('strictly rejects extra stdout and maps process failures without exposing stderr', async () => {
    const noisy: EgoProcessRunner = vi.fn(async () => ({
      ...success({ spaceId: 3, pageLabel: 'p1' }),
      stdout: `${success({ spaceId: 3, pageLabel: 'p1' }).stdout}unexpected\n`,
    }))
    const noisyAdapter = new EgoWebAdapter(options, noisy)
    await expect(noisyAdapter.create('noisy')).rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })

    const processFailure: EgoProcessRunner = vi.fn(async () => {
      throw new EgoProcessError('EGO_TIMEOUT', 'contains no prompt', true, true, 'secret token')
    })
    const failedAdapter = new EgoWebAdapter(options, processFailure)
    const thrown = await failedAdapter.create('timeout').catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'EGO_TIMEOUT', message: 'Ego browser command failed' })
    expect((thrown as Error).message).not.toContain('secret token')

    const spawnFailure: EgoProcessRunner = vi.fn(async () => {
      throw new EgoProcessError('EGO_SPAWN_FAILED', 'missing executable', true, false, 'secret token')
    })
    const spawnAdapter = new EgoWebAdapter(options, spawnFailure)
    await expect(spawnAdapter.create('spawn-failure')).rejects.toMatchObject({
      code: 'EGO_SPAWN_FAILED',
      message: 'Ego browser command failed',
      mayHaveLateEffects: false,
    })
  })

  it('accepts one stderr frame with explicit Ego notices and rejects ambiguous/truncated transport output', async () => {
    const value = { spaceId: 3, pageLabel: 'p1' }
    const frame = success(value).stdout.trimEnd()
    const withNoticeMock = vi.fn(async (_input: Parameters<EgoProcessRunner>[0]) => ({
      ...success(value),
      stdout: '',
      stderr: `${frame}\n[ego-browser:notice] Ego Lite update is available (no automatic upgrade)\n`,
      stderrTruncated: false as const,
    }))
    const withNotice = withNoticeMock as unknown as EgoProcessRunner
    const adapter = new EgoWebAdapter(options, withNotice)
    await expect(adapter.create('stderr-frame')).resolves.toEqual(value)
    expect(withNoticeMock.mock.calls[0]?.[0].stderrMaxBytes).toBeGreaterThanOrEqual(options.stdoutMaxBytes + 64 * 1024)
    expect(adapter.lastEgoNotices).toEqual(['Ego Lite update is available (no automatic upgrade)'])

    const duplicate: EgoProcessRunner = vi.fn(async () => ({
      ...success(value),
      stdout: '',
      stderr: `${frame}\n${frame}\n`,
      stderrTruncated: false as const,
    }))
    await expect(new EgoWebAdapter(options, duplicate).create('duplicate-frame')).rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })

    const noisy: EgoProcessRunner = vi.fn(async () => ({
      ...success(value),
      stdout: '',
      stderr: `${frame}\nwarning from Ego\n`,
      stderrTruncated: false as const,
    }))
    await expect(new EgoWebAdapter(options, noisy).create('noisy-stderr')).rejects.toMatchObject({ code: 'WEB_EGO_FRAME' })

    const truncated: EgoProcessRunner = vi.fn(async () => ({
      ...success(value),
      stdout: '',
      stderr: frame,
      stderrTruncated: true as const,
    }))
    await expect(new EgoWebAdapter(options, truncated).create('truncated-stderr')).rejects.toMatchObject({ code: 'EGO_OUTPUT_TOO_LARGE' })
  })

  it('keeps unknown Ego runtime errors generic while preserving only script-owned static errors', async () => {
    const secret = 'page prompt must not escape'
    const page = {
      async url() { return 'about:blank' },
      async goto() {},
      async waitForSelector() {},
      async waitForFunction() {},
      async evaluate(fn: unknown, argument?: unknown) {
        if (argument === 'button[aria-label="选择 ChatGPT 模型"]') return { expanded: 'false' }
        if (argument === '[role="menu"]') return true
        if (String(fn).includes('function inspectChatGptPage')) {
          const error = new Error(secret) as Error & { code?: string }
          error.code = 'WEB_MODEL_UNKNOWN'
          throw error
        }
        if (String(fn).includes('data-model-picker-view')) return { advanced: false, simple: true, toggle: true }
        const error = new Error(secret) as Error & { code?: string }
        error.code = 'WEB_MODEL_UNKNOWN'
        throw error
      },
      async click() {},
      async press() {},
    }
    const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
    const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
    const adapter = new EgoWebAdapter(options, run)

    const thrown = await adapter.prepare(resource, request()).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ code: 'WEB_MODEL_UNKNOWN', message: 'Ego browser command failed' })
    expect((thrown as Error).message).not.toContain(secret)
  })

  it('finishes exactly once while retaining the named p1 page', async () => {
    const fixture = runnerReturning({ finished: true })
    const adapter = new EgoWebAdapter(options, fixture.run)

    await expect(adapter.finish(resource)).resolves.toBeUndefined()
    await expect(adapter.finish(resource)).rejects.toMatchObject({ code: 'WEB_ALREADY_FINISHED' })
    expect(fixture.calls).toHaveBeenCalledOnce()
    const source = fixture.calls.mock.calls[0]?.[0].source ?? ''
    expect(source).toContain('finish({ keep: [__input.resource.pageLabel] })')
  })

  it('refuses an unknown model frame from the keyless sequence', async () => {
    const fixture = runnerReturning({ ...observation, modelLabel: undefined })
    const adapter = new EgoWebAdapter(options, fixture.run)

    await expect(adapter.prepare(resource, request())).rejects.toMatchObject({ code: 'WEB_MODEL_UNKNOWN' })
    expect(fixture.calls).toHaveBeenCalledOnce()
  })

  it('stops on a changed resource without navigating or rebuilding it', async () => {
    const fixture = runnerReturning(observation)
    const adapter = new EgoWebAdapter(options, fixture.run)

    await expect(adapter.observe(resource)).resolves.toEqual(observation)
    const observeSource = fixture.calls.mock.calls[0]?.[0].source ?? ''
    expect(observeSource).toContain('WEB_RESOURCE_CHANGED')
    expect(observeSource).not.toContain('__page.goto(__input.resource.conversationUrl')

    await expect(adapter.prepare(resource, request())).resolves.toEqual(observation)
    await expect(adapter.submit(resource, request())).resolves.toEqual(observation)
    const submitSource = fixture.calls.mock.calls[2]?.[0].source ?? ''
    expect(submitSource).toContain('WEB_RESOURCE_CHANGED')
    expect(submitSource).not.toContain('__page.goto(__input.resource.conversationUrl')
  })

  it('does not navigate an existing ChatGPT page with a draft or history', async () => {
    for (const state of [
      { composerText: 'existing draft', userMessages: [], userMessageCount: 0 },
      { composerText: '', userMessages: ['existing message'], userMessageCount: 1 },
    ] as const) {
      let gotoCalls = 0
      const page = {
        async url() { return resource.conversationUrl! },
        async goto() { gotoCalls += 1 },
        async evaluate(fn: unknown) {
          if (String(fn).includes('function inspectChatGptPage')) return { ...observation, ...state }
          throw new Error('unexpected navigation-protection evaluate callback')
        },
      }
      const taskSpace = async () => ({ ownership: 'agent', spaceId: resource.spaceId, page: () => page })
      const run: EgoProcessRunner = vi.fn(async (input: Parameters<EgoProcessRunner>[0]) => executeGeneratedSource(input.source, taskSpace))
      const adapter = new EgoWebAdapter(options, run)

      await expect(adapter.prepare(resource, request())).rejects.toMatchObject({ code: 'WEB_CONVERSATION_NOT_EMPTY' })
      expect(gotoCalls).toBe(0)
    }
  })
})
