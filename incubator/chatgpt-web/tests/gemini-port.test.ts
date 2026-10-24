import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createGeminiPort,
  type GeminiPortOptions,
  type GeminiPortRequest,
  type GeminiProcessRunner,
} from '../src/gemini-port.js'
import { EgoProcessError, type EgoProcessRequest } from '../src/process-contract.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-gemini-port-'))
  roots.push(value)
  return value
}

function template() {
  return { formatVersion: 1 as const, id: 'test-template', version: '1', text: 'full prompt', hash: 'test-hash' }
}

function request(overrides: Partial<GeminiPortRequest> = {}): GeminiPortRequest {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    nodeId: 'node-1',
    nodeKind: 'gemini-research',
    phase: 'plan',
    commandId: 'command-plan-1',
    resource: { provider: 'gemini', id: 'resource-plan-1' },
    requested: { provider: 'gemini', modelLabel: '4 Argon', modeLabel: 'Deep Research' },
    template: template(),
    renderedInput: '完整研究简报\n不得开始研究。',
    assets: [],
    signal: new AbortController().signal,
    ...overrides,
  }
}

const semantics = {
  submitSelector: '#submit',
  promptReceiptSelector: '#prompt-receipt',
  planReadyMarker: '#plan-ready',
  researchStartSelector: '#research-start',
  researchReportReadyMarker: '#report-ready',
  researchActivitySelector: '#research-activity',
  thinking: {
    triggerSelector: '#thinking-trigger',
    optionSelector: '#thinking-option',
    selectedSelector: '#thinking-selected',
  },
} as const

type PageState = {
  readonly label: string
  url: string
  composer: string
  model: string
  modelMenuOpen: boolean
  toolsOpen: boolean
  deepResearch: boolean
  effort: string | undefined
  outputMarkdown: string | undefined
  promptReceipt: string | undefined
  submitted: boolean
  researchStarted: boolean
  readonly clicks: string[]
  readonly fills: Array<{ readonly selector: string; readonly value: string }>
}

type FakeBrowser = {
  readonly runner: GeminiProcessRunner
  readonly runnerCalls: ReturnType<typeof vi.fn>
  readonly outputs: string[]
  readonly spaceForRun: ReturnType<typeof vi.fn>
  readonly spaceIds: number[]
  readonly pages: Map<string, PageState>
  ownership: 'agent' | 'user'
  researchStartEnabled: boolean
  quotaText?: string
  defaultOutputMarkdown?: string
  assertIntentBeforeSubmit?: () => Promise<void>
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>

async function executeSource(source: string, taskSpace: (...args: unknown[]) => unknown) {
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
  return { stdout, stderr: '', stderrTruncated: false, exitCode: 0 as const, executionStopped: true as const }
}

function selectorState(page: PageState, selector: string, quotaText: string | undefined) {
  if (selector === 'button[data-test-id="bard-mode-menu-button"]') return { count: 1, texts: ['4 Argon'] }
  if (selector === '#prompt-receipt' || selector === 'user-query-content .query-text') return page.promptReceipt === undefined ? { count: 0, texts: [] } : { count: 1, texts: [page.promptReceipt] }
  if (selector === '#plan-ready' || selector === 'deep-research-confirmation-widget') return page.submitted ? { count: 1, texts: ['计划已生成'] } : { count: 0, texts: [] }
  if (selector === '#report-ready' || selector === 'deep-research-immersive-panel') return page.researchStarted ? { count: 1, texts: ['报告已完成'] } : { count: 0, texts: [] }
  if (selector === '#research-activity') return { count: 0, texts: [] }
  if (selector === '#thinking-selected') return page.effort === undefined ? { count: 0, texts: [] } : { count: 1, texts: [page.effort] }
  if (selector === '#quota') return quotaText === undefined ? { count: 0, texts: [] } : { count: 1, texts: [quotaText] }
  return { count: 0, texts: [] }
}

function pageObservation(page: PageState) {
  const markdown = !page.submitted
    ? undefined
    : page.outputMarkdown ?? (page.researchStarted
      ? '## 完整研究报告\n\n事实与来源。'
      : page.label.includes('thinking')
        ? '## 完整思考答复\n\n可见结论与来源。'
        : '## 完整研究计划\n\n待确认后才启动研究。')
  return {
    url: page.url,
    loginRequired: false,
    composerCount: 1,
    composerText: page.composer,
    modelButtonCount: 1,
    ...(page.modelMenuOpen ? { selectedModelLabel: page.model } : {}),
    deepResearchCount: page.toolsOpen ? 1 : 0,
    ...(page.toolsOpen ? { deepResearchChecked: page.deepResearch } : {}),
    ...(page.researchStarted ? { researchReportReady: true } : {}),
    ...(markdown === undefined ? {} : { responseText: markdown.replace(/[#\n]/g, '') }),
    ...(markdown === undefined ? {} : { responseMarkdown: markdown }),
    citations: markdown === undefined ? [] : ['https://example.test/source'],
  }
}

function makeBrowser(): FakeBrowser {
  const pages = new Map<string, PageState>()
  const spaceIds: number[] = []
  const browser: Omit<FakeBrowser, 'runner' | 'runnerCalls'> = {
    spaceForRun: vi.fn(async () => 73),
    spaceIds,
    pages,
    outputs: [],
    ownership: 'agent',
    researchStartEnabled: true,
  }
  const pageFor = (label: string): PageState => {
    let page = pages.get(label)
    if (page === undefined) {
      page = {
        label,
        url: 'about:blank',
        composer: '',
        model: '4 Argon',
        modelMenuOpen: false,
        toolsOpen: false,
        deepResearch: false,
        effort: undefined,
        outputMarkdown: browser.defaultOutputMarkdown,
        promptReceipt: undefined,
        submitted: false,
        researchStarted: false,
        clicks: [],
        fills: [],
      }
      pages.set(label, page)
    }
    return page
  }
  const taskSpace = async (spaceId: unknown) => {
    if (typeof spaceId !== 'number') throw new Error('taskSpace received a non-number')
    spaceIds.push(spaceId)
    return {
      ownership: browser.ownership,
      spaceId,
      page: (label: string) => {
        const page = pageFor(label)
        return {
          async url() { return page.url },
          async goto(url: string) { page.url = url },
          async waitForSelector() {},
          async press(_selector: string, key: string) {
            if (key === 'Escape') page.modelMenuOpen = false
          },
          async evaluate(fn: unknown, argument?: unknown) {
            const source = String(fn)
            if (source.includes('function inspectGeminiSelector')) return selectorState(page, String(argument), browser.quotaText)
            if (source.includes('function inspectGeminiPage')) return pageObservation(page)
            if (source.includes('function findGeminiModelOption')) {
              const input = argument as { readonly modelLabel?: string }
              return input.modelLabel === '4 Argon' ? 'button.model-option' : undefined
            }
            if (source.includes('function findGeminiThinkingTrigger')) return 'button.thinking-trigger'
            if (source.includes('function findGeminiThinkingOption')) {
              const input = argument as { readonly label?: string }
              return input.label === '高' ? 'button.thinking-high' : undefined
            }
            if (source.includes('function readGeminiThinkingSelection')) return page.effort
            if (source.includes('function findUniqueGeminiTextSelector')) {
              const input = argument as { readonly selector?: string; readonly text?: string }
              if (input.text === 'Deep Research') return 'button.deep-research'
              return undefined
            }
            if (source.includes('function findUniqueGeminiControl')) {
              if (argument === '#submit' || argument === 'button[aria-label="发送"]') return 'button.submit'
              if (argument === '#research-start' || argument === 'button[aria-label="开始研究"]') return browser.researchStartEnabled ? 'button.research-start' : undefined
              if (argument === '#thinking-trigger') return 'button.thinking-trigger'
              return undefined
            }
            throw new Error(`unexpected evaluate function: ${source.slice(0, 80)}`)
          },
          async fill(selector: string, value: string) {
            page.fills.push({ selector, value })
            page.composer = value
          },
          async click(selector: string) {
            page.clicks.push(selector)
            if (selector === 'button[data-test-id="bard-mode-menu-button"]') page.modelMenuOpen = true
            else if (selector === 'button.model-option') page.model = '4 Argon'
            else if (selector === 'button[aria-label="上传和工具"]' || selector === 'button[aria-label="更多工具"]') page.toolsOpen = true
            else if (selector === 'button.deep-research') page.deepResearch = true
            else if (selector === 'button.thinking-high') page.effort = '高'
            else if (selector === 'button.submit') {
              await browser.assertIntentBeforeSubmit?.()
              page.promptReceipt = page.composer
              page.composer = ''
              page.submitted = true
              page.url = `https://gemini.google.com/app/${page.label}`
            } else if (selector === 'button.research-start') {
              page.researchStarted = true
              page.url = `https://gemini.google.com/app/${page.label}/report`
            }
          },
        }
      },
    }
  }
  const runnerCalls = vi.fn(async (input: EgoProcessRequest) => {
    const result = await executeSource(input.source, taskSpace)
    browser.outputs.push(result.stdout)
    return result
  })
  return Object.assign(browser, { runner: runnerCalls as GeminiProcessRunner, runnerCalls }) as FakeBrowser
}

function options(rootValue: string, browser: FakeBrowser, overrides: Partial<GeminiPortOptions> = {}): GeminiPortOptions {
  return {
    root: rootValue,
    executable: '/usr/local/bin/ego-browser',
    commandTimeoutMs: 1_000,
    pollMs: 0,
    waitMs: 0,
    maxOutputBytes: 64 * 1024,
    spaceForRun: browser.spaceForRun,
    semantics,
    ...overrides,
  }
}

describe.sequential('Gemini Web port', () => {
  it('rejects unsupported phases before allocating a TaskSpace or browser action', async () => {
    const state = makeBrowser()
    const port = createGeminiPort(options(await root(), state), state.runner)

    await expect(port.execute(request({ phase: 'critique' }))).resolves.toMatchObject({
      kind: 'failed',
      code: 'GEMINI_PHASE_UNSUPPORTED',
      certainty: 'no-active-effect',
    })
    expect(state.spaceForRun).not.toHaveBeenCalled()
    expect(state.runnerCalls).not.toHaveBeenCalled()
  })

  it('does not click or create a new research intent when the observed start control is disabled', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    state.researchStartEnabled = false
    const port = createGeminiPort(options(rootValue, state, { semantics: {} }), state.runner)
    await expect(port.execute(request())).resolves.toMatchObject({ kind: 'complete' })

    await expect(port.execute(request({
      phase: 'research',
      commandId: 'command-research-disabled-start',
      nodeId: 'node-research-disabled-start',
    }))).resolves.toMatchObject({ kind: 'unknown', reason: 'GEMINI_RESEARCH_START_CONTROL_UNAVAILABLE' })
    expect(await readdir(join(rootValue, 'gemini-port', 'intents'))).toHaveLength(1)
    const page = state.pages.values().next().value as PageState
    expect(page.clicks.filter((value) => value === 'button.submit')).toHaveLength(1)
    expect(page.clicks).not.toContain('button.research-start')
  })

  it('refuses a user-controlled TaskSpace without claiming it or clicking the page', async () => {
    const state = makeBrowser()
    state.ownership = 'user'
    const port = createGeminiPort(options(await root(), state), state.runner)

    await expect(port.execute(request())).resolves.toMatchObject({ kind: 'unknown', reason: 'GEMINI_USER_CONTROL' })
    expect([...state.pages.values()].flatMap((page) => page.clicks)).toEqual([])
  })

  it('persists format-1 intent before the one plan submit click and returns a visible plan only after stable observation', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    state.assertIntentBeforeSubmit = async () => {
      const directory = join(rootValue, 'gemini-port', 'intents')
      const entries = await readdir(directory)
      expect(entries).toHaveLength(1)
      const record = JSON.parse(await readFile(join(directory, entries[0]!), 'utf8')) as { formatVersion?: unknown; renderedInput?: unknown }
      expect(record).toMatchObject({ formatVersion: 1, renderedInput: request().renderedInput })
    }
    const port = createGeminiPort(options(rootValue, state), state.runner)

    const outcome = await port.execute(request())

    expect(outcome).toMatchObject({
      kind: 'complete',
      observed: { availability: 'observed', modelLabel: '4 Argon', modeLabel: 'Deep Research' },
      artifact: { text: '## 完整研究计划\n\n待确认后才启动研究。' },
    })
    expect(outcome.resource.url).toMatch(/^https:\/\/gemini\.google\.com\/app\/gemini-plan-research-[a-f0-9]{16}-[a-f0-9]{12}$/)
    expect(state.spaceForRun).toHaveBeenCalledTimes(1)
    expect([...state.pages.keys()]).toEqual([expect.stringMatching(/^gemini-plan-research-[a-f0-9]{16}-[a-f0-9]{12}$/)])
    const page = state.pages.values().next().value as PageState
    expect(page.clicks.filter((value) => value === 'button.submit')).toHaveLength(1)
    expect(page.fills).toEqual([{ selector: '[contenteditable][role="textbox"][aria-label="为 Gemini 输入提示"]', value: request().renderedInput }])
    const source = state.runnerCalls.mock.calls[0]?.[0].source ?? ''
    expect(source).toContain('taskSpace(__input.local.spaceId)')
    expect(source).toContain('button[data-test-id="bard-mode-menu-button"]')
    expect(source).toContain('上传和工具')
    expect(source).toContain('model-response-content')
    expect(source).toContain('response-container')
    expect(source).toContain('sources-list')
    expect(source).toContain('thinking-overlay')
    expect(source).not.toContain('playwright')
    expect(source).not.toContain('CDP')
  })

  it('does not resend an already durable command and a restarted client only observes its original page', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    const first = createGeminiPort(options(rootValue, state), state.runner)
    await expect(first.execute(request())).resolves.toMatchObject({ kind: 'complete' })
    const page = state.pages.values().next().value as PageState
    const runnerCalls = state.runnerCalls.mock.calls.length

    await expect(first.execute(request())).resolves.toMatchObject({
      kind: 'unknown',
      reason: 'GEMINI_INTENT_ALREADY_DURABLE_OBSERVE_ORIGINAL_RESOURCE',
    })
    expect(page.clicks.filter((value) => value === 'button.submit')).toHaveLength(1)
    expect(state.runnerCalls).toHaveBeenCalledTimes(runnerCalls)

    const restarted = createGeminiPort(options(rootValue, state), state.runner)
    await expect(restarted.observe(request())).resolves.toMatchObject({ kind: 'complete' })
    expect(state.spaceForRun).toHaveBeenCalledTimes(1)
    expect(page.clicks.filter((value) => value === 'button.submit')).toHaveLength(1)
  })

  it('does not start research while observing, then reuses the plan page without allocating another TaskSpace', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    const port = createGeminiPort(options(rootValue, state), state.runner)
    const plan = request()
    await expect(port.execute(plan)).resolves.toMatchObject({ kind: 'complete' })
    const research = request({
      phase: 'research',
      commandId: 'command-research-1',
      nodeId: 'node-research-1',
      renderedInput: '只在主机确认计划后启动。',
    })

    await expect(port.observe(research)).resolves.toMatchObject({ kind: 'unknown', reason: 'GEMINI_RESEARCH_NOT_DISPATCHED' })
    await expect(port.execute(research)).resolves.toMatchObject({
      kind: 'complete',
      artifact: { text: '## 完整研究报告\n\n事实与来源。' },
    })
    expect(state.spaceForRun).toHaveBeenCalledTimes(1)
    expect([...state.pages.keys()]).toEqual([expect.stringMatching(/^gemini-plan-research-[a-f0-9]{16}-[a-f0-9]{12}$/)])
    const page = state.pages.values().next().value as PageState
    expect(page.clicks.filter((value) => value === 'button.research-start')).toHaveLength(1)
  })

  it('rechecks a configured research-start control before making a durable research intent', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    const port = createGeminiPort(options(rootValue, state, {
      semantics: { ...semantics, researchStartSelector: '#missing-visible-start' },
    }), state.runner)
    await expect(port.execute(request())).resolves.toMatchObject({ kind: 'complete' })
    const research = request({
      phase: 'research',
      commandId: 'command-research-start-missing',
      nodeId: 'node-research-start-missing',
      renderedInput: '等待确认后才开始研究。',
    })

    await expect(port.execute(research)).resolves.toMatchObject({
      kind: 'unknown',
      reason: 'GEMINI_RESEARCH_START_CONTROL_UNAVAILABLE',
    })
    expect(await readdir(join(rootValue, 'gemini-port', 'intents'))).toHaveLength(1)
    expect([...state.pages.values()].flatMap((page) => page.clicks)).not.toContain('button.research-start')
  })

  it('maps only the explicit high to 高 effort after visible readback and gives thinking a separate page', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    const port = createGeminiPort(options(rootValue, state), state.runner)
    await expect(port.execute(request())).resolves.toMatchObject({ kind: 'complete' })
    const thinking = request({
      phase: 'thinking',
      commandId: 'command-thinking-1',
      nodeId: 'node-thinking-1',
      nodeKind: 'gemini-thinking',
      requested: { provider: 'gemini', modelLabel: '4 Argon', effortLabel: 'high' },
      renderedInput: '保持引用、数字和限定词。',
    })

    await expect(port.execute(thinking)).resolves.toMatchObject({
      kind: 'complete',
      observed: { modelLabel: '4 Argon', effortLabel: '高' },
      artifact: { text: '## 完整思考答复\n\n可见结论与来源。' },
    })
    expect(state.spaceForRun).toHaveBeenCalledTimes(1)
    expect([...state.pages.keys()].sort()).toEqual([
      expect.stringMatching(/^gemini-plan-research-[a-f0-9]{16}-[a-f0-9]{12}$/),
      expect.stringMatching(/^gemini-thinking-[a-f0-9]{16}-[a-f0-9]{12}$/),
    ])
  })

  it('uses the recorded high to 高 adapter without inventing preference selectors', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    const { thinking: _unusedThinking, ...withoutThinkingSelectors } = semantics
    const port = createGeminiPort(options(rootValue, state, { semantics: withoutThinkingSelectors }), state.runner)
    await expect(port.execute(request())).resolves.toMatchObject({ kind: 'complete' })
    const thinking = request({
      phase: 'thinking',
      commandId: 'command-thinking-observed-map',
      nodeId: 'node-thinking-observed-map',
      nodeKind: 'gemini-thinking',
      requested: { provider: 'gemini', modelLabel: '4 Argon', effortLabel: 'high' },
      renderedInput: '保留完整证据。',
    })

    await expect(port.execute(thinking)).resolves.toMatchObject({
      kind: 'complete',
      observed: { modelLabel: '4 Argon', effortLabel: '高' },
    })
    expect([...state.pages.values()].flatMap((page) => page.clicks).filter((value) => value === 'button.thinking-high')).toHaveLength(1)
  })

  it('does not alias Gemini 4 Argon when the exact requested label is unavailable', async () => {
    const state = makeBrowser()
    const port = createGeminiPort(options(await root(), state), state.runner)
    const outcome = await port.execute(request({ requested: { provider: 'gemini', modelLabel: 'Gemini 4 Argon', modeLabel: 'Deep Research' } }))

    expect(outcome).toMatchObject({ kind: 'unknown', reason: 'GEMINI_MODEL_SELECTION_UNAVAILABLE' })
    expect([...state.pages.values()].flatMap((page) => page.clicks).filter((value) => value === 'button.submit')).toHaveLength(0)
  })

  it('returns a quota outcome only from configured visible Deep Research evidence before a click', async () => {
    const state = makeBrowser()
    state.quotaText = 'Deep Research quota exhausted'
    const port = createGeminiPort(options(await root(), state, {
      semantics: { ...semantics, visibleQuota: { selector: '#quota', requiredText: 'Deep Research quota exhausted', scope: 'Deep Research' } },
    }), state.runner)

    const outcome = await port.execute(request())
    const firstFrame = JSON.parse(state.outputs[0]!.slice(state.outputs[0]!.indexOf('{'))) as { readonly value?: { readonly semantic?: { readonly quota?: unknown } } }
    expect(firstFrame.value?.semantic?.quota).toEqual({ count: 1, texts: ['Deep Research quota exhausted'] })
    expect(outcome).toMatchObject({
      kind: 'quota-exhausted',
      certainty: 'no-active-effect',
      evidence: 'Deep Research quota exhausted',
    })
    expect([...state.pages.values()].flatMap((page) => page.clicks).filter((value) => value === 'button.submit')).toHaveLength(0)
  })

  it('rejects over-limit visible output without truncating it or claiming completion', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    state.defaultOutputMarkdown = `# 报告\n${'完整内容 '.repeat(200)}`
    const port = createGeminiPort(options(rootValue, state, { maxOutputBytes: 32 }), state.runner)

    await expect(port.execute(request())).resolves.toMatchObject({
      kind: 'unknown',
      reason: 'GEMINI_OUTPUT_TOO_LARGE',
    })
    const entries = await readdir(join(rootValue, 'gemini-port', 'intents'))
    expect(entries).toHaveLength(1)
    expect([...state.pages.values()].flatMap((page) => page.clicks).filter((value) => value === 'button.submit')).toHaveLength(1)
  })

  it('fences an Ego timeout as unknown and never mislabels it as Gemini quota', async () => {
    const rootValue = await root()
    const state = makeBrowser()
    let calls = 0
    const runner: GeminiProcessRunner = async (input) => {
      calls += 1
      if (calls === 2) throw new EgoProcessError('EGO_TIMEOUT', 'simulated timeout', true, true)
      return state.runner(input)
    }
    const port = createGeminiPort(options(rootValue, state), runner)

    await expect(port.execute(request())).resolves.toMatchObject({
      kind: 'unknown',
      reason: 'GEMINI_CLI_EGO_TIMEOUT',
    })
    expect([...state.pages.values()].flatMap((page) => page.clicks).filter((value) => value === 'button.submit')).toHaveLength(0)
  })
})
