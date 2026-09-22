// @vitest-environment jsdom

import { Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime, {
  BrowserError,
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserCapabilityV1,
  type BrowserJsonValue,
  type BrowserProvider,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import PhysicalOperatorRuntime, { PhysicalOperatorError } from '@deepseek-ai/dsh-physical-operator'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  buildOperatorContextEnvelope,
  renderOperatorContextEnvelopeText,
} from '@deepseek-ai/dsh-system-prompt'
import * as adapter from '../src/index.ts'

const CAPABILITIES: readonly BrowserCapabilityV1[] = [
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
]

function fakeParent(): Agent {
  return { id: SessionId('chatgpt-web-parent') } as unknown as Agent
}

function resultFor(value: BrowserJsonValue): BrowserRunProgramResultV1 {
  return {
    version: 1,
    workspace: {
      id: BrowserWorkspaceId('chatgpt-web-fixture'),
      name: 'fixture-chatgpt-web',
      lifecycle: 'active',
      control: 'agent',
    },
    output: { kind: 'json', value },
  }
}

class StubBrowserProvider implements BrowserProvider {
  readonly descriptor: BrowserProvider['descriptor']
  readonly programs: BrowserRunProgramV1[] = []
  readonly signals: (AbortSignal | undefined)[] = []

  constructor(
    private readonly execute: (
      program: BrowserRunProgramV1,
      signal?: AbortSignal,
    ) => Promise<BrowserRunProgramResultV1> = async () => resultFor({
      status: 'completed', response: 'fixture response', truncated: false,
    }),
    capabilities: readonly BrowserCapabilityV1[] = CAPABILITIES,
  ) {
    this.descriptor = {
      id: BrowserProviderId('fixture-browser'),
      layers: ['browser-js-v1'],
      capabilities,
    }
  }

  available(): boolean {
    return true
  }

  async runProgram(program: BrowserRunProgramV1, signal?: AbortSignal): Promise<BrowserRunProgramResultV1> {
    this.programs.push(program)
    this.signals.push(signal)
    return this.execute(program, signal)
  }
}

interface SetupConfig {
  readonly generationTimeoutMs?: number
  readonly submissionTimeoutMs?: number
  readonly pollIntervalMs?: number
  readonly progressIntervalMs?: number
  readonly outputMaxBytes?: number
}

async function setup(
  provider = new StubBrowserProvider(),
  config: SetupConfig = {},
) {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime)
  await ctx.plugin(PhysicalOperatorRuntime)
  ctx.browser.registerProvider(provider)
  const plugin = await ctx.plugin(adapter, {
    workspaceName: 'fixture-chatgpt-web',
    generationTimeoutMs: 1_000,
    submissionTimeoutMs: 100,
    pollIntervalMs: 10,
    progressIntervalMs: 20,
    outputMaxBytes: 2_048,
    ...config,
  })
  return { ctx, plugin, provider }
}

function request(signal = new AbortController().signal) {
  return {
    label: 'fixture ChatGPT task',
    prompt: [{ type: 'text' as const, text: 'private task body' }],
    systemPrompt: 'system instructions',
    parent: fakeParent(),
    signal,
  }
}

function serializedProgramRequest(program: BrowserRunProgramV1): Record<string, unknown> {
  const match = /^const request = (.*);$/m.exec(program.source)
  if (match?.[1] === undefined) throw new Error('fixture did not find serialized browser program request')
  return JSON.parse(match[1]) as Record<string, unknown>
}

interface ProgramOperation {
  readonly id: string
  readonly kind: string
  readonly locator?: { readonly selector?: string }
  readonly value?: string
}

interface ProgramBrowser {
  run(operation: ProgramOperation): Promise<void>
  evaluate(page: string, evaluator: string, input?: unknown): Promise<unknown>
}

const ProgramAsyncFunction = (async function () {}).constructor as unknown as new (
  ...args: string[]
) => (browserArgument: ProgramBrowser) => Promise<unknown>

function executeGeneratedProgram(program: BrowserRunProgramV1, browser: ProgramBrowser): Promise<unknown> {
  return new ProgramAsyncFunction('browser', program.source)(browser)
}

async function evaluatePage(evaluator: string, input?: unknown): Promise<unknown> {
  const evaluate = new Script('(' + evaluator + ')').runInNewContext({
    document, location, Node, setTimeout, getComputedStyle: window.getComputedStyle.bind(window),
  }) as (argument?: unknown) => unknown
  return await evaluate(input)
}

function operationTarget(operation: ProgramOperation): Element {
  const selector = operation.locator?.selector
  if (selector === undefined) throw new Error('fixture operation ' + operation.id + ' has no CSS selector')
  const target = document.querySelector(selector)
  if (target === null) throw new Error('fixture did not find ' + selector)
  return target
}

function makeVisible(element: Element): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 100, height: 20 }),
  })
}

function setComposerText(editor: HTMLElement, value: string): void {
  const newline = String.fromCharCode(10)
  const normalized = value
    .replaceAll(String.fromCharCode(13) + newline, newline)
    .replaceAll(String.fromCharCode(13), newline)
  const blocks = normalized.split(newline).map((line) => {
    const paragraph = document.createElement('p')
    if (line.length === 0) {
      const trailingBreak = document.createElement('br')
      trailingBreak.className = 'ProseMirror-trailingBreak'
      paragraph.append(trailingBreak)
    } else {
      paragraph.textContent = line
    }
    return paragraph
  })
  editor.replaceChildren(...blocks)
}

function createComposer(): HTMLDivElement {
  const editor = document.createElement('div')
  editor.className = 'ProseMirror'
  editor.setAttribute('contenteditable', 'true')
  makeVisible(editor)
  return editor
}

function createSendButton(label: string, disabled = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'submit'
  button.setAttribute('aria-label', label)
  button.disabled = disabled
  makeVisible(button)
  return button
}

function appendCompletedDomTurn(response: string): void {
  window.history.pushState(null, '', '/c/fixture')
  const user = document.createElement('div')
  user.setAttribute('data-message-author-role', 'user')
  const turn = document.createElement('div')
  turn.setAttribute('data-testid', 'conversation-turn-fixture')
  const assistant = document.createElement('div')
  assistant.setAttribute('data-message-author-role', 'assistant')
  const markdown = document.createElement('div')
  markdown.className = 'markdown'
  markdown.textContent = response
  const copy = document.createElement('button')
  copy.setAttribute('data-testid', 'copy-turn-action-button')
  assistant.append(markdown)
  turn.append(assistant, copy)
  document.body.append(user, turn)
}

function contentSearchUser(key: string): HTMLDivElement {
  const unit = document.createElement('div')
  unit.setAttribute('data-content-search-unit-key', key)
  const bubble = document.createElement('div')
  bubble.setAttribute('data-user-message-bubble', 'true')
  unit.append(bubble)
  return unit
}

function contentSearchAssistant(key: string, response: string, nested = false): HTMLDivElement {
  const unit = document.createElement('div')
  unit.setAttribute('data-content-search-unit-key', key)
  const content = nested ? document.createElement('div') : unit
  if (nested) {
    content.setAttribute('data-content-search-unit-key', key)
    unit.append(content)
  }
  const heading = document.createElement('h4')
  heading.textContent = 'ChatGPT说：'
  const body = document.createElement('div')
  body.setAttribute('data-markdown-text-style', 'assistant-message')
  body.textContent = response
  content.append(heading, body)
  return unit
}

function programFor(
  prompt: string,
  options: Readonly<{
    readonly generationTimeoutMs?: number
    readonly submissionTimeoutMs?: number
    readonly pollIntervalMs?: number
  }> = {},
): BrowserRunProgramV1 {
  return adapter.buildChatGptWebProgram({
    url: 'https://chatgpt.com/',
    workspaceName: 'fixture-chatgpt-web',
    prompt,
    generationTimeoutMs: options.generationTimeoutMs ?? 100,
    submissionTimeoutMs: options.submissionTimeoutMs ?? 20,
    pollIntervalMs: options.pollIntervalMs ?? 1,
    outputMaxBytes: 2_048,
  })
}

afterEach(() => {
  document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
})

describe('ChatGPT Web physical operator', () => {
  it('registers an ephemeral, single-flight browser operator and submits the merged text prompt', async () => {
    const { ctx, plugin, provider } = await setup()
    expect(ctx.physicalOperators.status('chatgpt-web')).toMatchObject({
      id: 'chatgpt-web',
      displayName: 'ChatGPT Web',
      maxConcurrency: 1,
      executionModes: ['ephemeral'],
      state: 'available',
    })

    const run = await ctx.physicalOperators.start('chatgpt-web', request())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'fixture response' }],
      stopReason: 'completed',
    })
    expect(provider.programs).toHaveLength(1)
    const program = provider.programs[0]!
    expect(program.workspace).toEqual({
      kind: 'named', name: 'fixture-chatgpt-web', createIfMissing: true,
    })
    expect(program.requiredCapabilities).toEqual(CAPABILITIES)
    expect(serializedProgramRequest(program)).toMatchObject({
      prompt: 'system instructions\n\n---\n\nprivate task body',
      workspaceName: 'fixture-chatgpt-web',
      url: 'https://chatgpt.com/',
    })
    expect(program.source).not.toMatch(/fetch\s*\(|api\.openai\.com|puppeteer|localhost:9222/i)

    const progress = await run.readEvents?.(0, 20)
    expect(progress?.events.map(event => event.type)).toEqual([
      'chatgpt-web.connecting',
      'chatgpt-web.submitting',
      'chatgpt-web.waiting',
      'chatgpt-web.completed',
    ])
    expect(JSON.stringify(progress)).not.toContain('private task body')
    expect(JSON.stringify(progress)).not.toContain('fixture response')

    await plugin.dispose()
    expect(ctx.physicalOperators.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('submits every sealed context field through the text-only ChatGPT Web transport', async () => {
    const { ctx, plugin, provider } = await setup()
    const envelope = buildOperatorContextEnvelope({
      systemText: 'sealed system instructions',
      task: [{ type: 'text', text: 'sealed current task' }],
      contexts: [{ name: 'memory', text: 'sealed preference' }],
      source: { kind: 'tool', requestHeaderEventSeq: 1, toolCallId: 'fixture-tool' },
    })

    const run = await ctx.physicalOperators.start('chatgpt-web', { ...request(), contextEnvelope: envelope })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(run.contextReceipt).toMatchObject({
      digest: envelope.digest, outcome: 'accepted', format: 'text', roleFidelity: 'text-downgrade',
    })
    expect(serializedProgramRequest(provider.programs[0]!)).toMatchObject({
      prompt: renderOperatorContextEnvelopeText(envelope),
    })

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('builds a browser program in the required order: open, reset, inspect, submit, then wait for a fresh response', () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'question',
      model: 'GPT-5',
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 100,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const open = program.source.indexOf("id: 'chatgpt-open'")
    const reset = program.source.indexOf("id: 'chatgpt-reset-conversation'")
    const inspect = program.source.indexOf('const readinessStartedAt =')
    const select = program.source.indexOf('const selection =')
    const fill = program.source.indexOf("id: 'chatgpt-fill'")
    const send = program.source.indexOf("id: 'chatgpt-send'")
    const responsePoll = program.source.indexOf('let submitted = false')
    expect(open).toBeGreaterThan(-1)
    expect(reset).toBeGreaterThan(open)
    expect(inspect).toBeGreaterThan(reset)
    expect(select).toBeGreaterThan(inspect)
    expect(fill).toBeGreaterThan(select)
    expect(send).toBeGreaterThan(fill)
    expect(responsePoll).toBeGreaterThan(send)
    expect(program.source).toContain("return { status: 'auth-required' }")
    expect(program.source).toContain("return { status: 'context-not-isolated' }")
    expect(program.source).toContain("return { status: 'model-selection-unavailable' }")
    expect(program.source).toContain("kind: 'click'")
    expect(program.source).toContain("selector: '[data-dsh-chatgpt-web-send=\"true\"]'")
    expect(program.source).toContain("status: 'submission-failed'")
    expect(program.source).toContain("status: 'generation-timeout'")
    expect(program.source).toContain('copy-turn-action-button')
    expect(program.source).toContain("typeof state.settled !== 'boolean'")
    expect(program.source).toContain('state.settled && !state.generating')
    expect(program.source).not.toContain('(sawGenerating && !state.generating) || stableSamples >= 2')
    expect(program.source).not.toContain("kind: 'close-page'")
  })

  it('does not settle a stable ChatGPT thinking placeholder before final response controls appear', async () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'question',
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 100,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const observations = [
      { page: 'conversation', userCount: 1, assistantCount: 0, inputCharacters: 0, response: '', generating: true, settled: false, sendAvailable: false },
      { page: 'conversation', userCount: 1, assistantCount: 1, inputCharacters: 0, response: 'Pro 思考中', generating: false, settled: false, sendAvailable: true },
      { page: 'conversation', userCount: 1, assistantCount: 1, inputCharacters: 0, response: 'Pro 思考中', generating: false, settled: false, sendAvailable: true },
      { page: 'conversation', userCount: 1, assistantCount: 1, inputCharacters: 0, response: 'final response', generating: false, settled: true, sendAvailable: true },
      { page: 'conversation', userCount: 1, assistantCount: 1, inputCharacters: 0, response: 'final response', generating: false, settled: true, sendAvailable: true },
    ]
    let inspection = 0
    let observation = 0
    const browser = {
      run: async () => undefined,
      evaluate: async (_page: string, evaluator: string) => {
        if (evaluator.includes('loginRequired')) {
          const inputReady = inspection > 0
          inspection += 1
          return { page: 'root', loginRequired: false, inputReady, assistantCount: 0, userCount: 0 }
        }
        if (evaluator.includes('typeof input.prompt')) {
          return {
            page: 'root', userCount: 0, assistantCount: 0, inputCharacters: 8,
            generating: false, settled: false, sendAvailable: true, promptMatches: true, ready: true,
          }
        }
        if (evaluator.includes('removeAttribute')) return true
        return observations[Math.min(observation++, observations.length - 1)]
      },
    }
    const AsyncFunction = (async function () {}).constructor as unknown as new (
      ...args: string[]
    ) => (browserArgument: unknown) => Promise<unknown>
    const execute = new AsyncFunction('browser', program.source)

    await expect(execute(browser)).resolves.toEqual({
      status: 'completed',
      response: 'final response',
      truncated: false,
    })
    expect(inspection).toBe(2)
    expect(observation).toBe(5)
  })

  it('fails within the submission bound when clicking send does not create a user turn', async () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'question',
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 5,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const unchanged = {
      page: 'root',
      userCount: 0,
      assistantCount: 0,
      inputCharacters: 8,
      response: '',
      generating: false,
      settled: false,
      sendAvailable: true,
    }
    const browser = {
      run: async () => undefined,
      evaluate: async (_page: string, evaluator: string) => {
        if (evaluator.includes('loginRequired')) {
          return { page: 'root', loginRequired: false, inputReady: true, assistantCount: 0, userCount: 0 }
        }
        if (evaluator.includes('typeof input.prompt')) {
          return {
            page: 'root', userCount: 0, assistantCount: 0, inputCharacters: 8,
            generating: false, settled: false, sendAvailable: true, promptMatches: true, ready: true,
          }
        }
        if (evaluator.includes('removeAttribute')) return true
        return unchanged
      },
    }
    const AsyncFunction = (async function () {}).constructor as unknown as new (
      ...args: string[]
    ) => (browserArgument: unknown) => Promise<unknown>

    await expect(new AsyncFunction('browser', program.source)(browser)).resolves.toEqual({
      status: 'submission-failed',
      diagnostic: {
        page: 'root',
        userCount: 0,
        assistantCount: 0,
        inputCharacters: 8,
        generating: false,
        settled: false,
        sendAvailable: true,
      },
    })
  })

  it('waits for a hydrated ProseMirror composer, then submits through a no-id Chinese send button', async () => {
    const prompt = 'first line\r\nsecond line'
    const program = programFor(prompt)
    const form = document.createElement('form')
    const ssrTextarea = document.createElement('textarea')
    ssrTextarea.id = 'prompt-textarea'
    makeVisible(ssrTextarea)
    form.append(ssrTextarea)
    const unrelatedForm = document.createElement('form')
    const unrelatedSend = createSendButton('Send')
    unrelatedForm.append(unrelatedSend)
    document.body.append(form, unrelatedForm)

    const editor = createComposer()
    const send = createSendButton('发送')
    let inspectionCount = 0
    let hydrated = false
    let filledBeforeHydration = false
    let filledText = ''
    let sendClicks = 0
    let unrelatedClicks = 0
    const operations: ProgramOperation[] = []
    unrelatedSend.addEventListener('click', (event) => {
      event.preventDefault()
      unrelatedClicks += 1
    })
    send.addEventListener('click', (event) => {
      event.preventDefault()
      sendClicks += 1
      appendCompletedDomTurn('hydrated response')
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        operations.push(operation)
        if (operation.id === 'chatgpt-fill') {
          if (!hydrated) filledBeforeHydration = true
          const target = operationTarget(operation)
          expect(target).toBe(editor)
          filledText = operation.value ?? ''
          setComposerText(editor, filledText)
        }
        if (operation.id === 'chatgpt-send') {
          expect(operationTarget(operation)).toBe(send)
          send.click()
        }
      },
      evaluate: async (_page, evaluator, input) => {
        if (evaluator.includes('loginRequired')) {
          inspectionCount += 1
          if (inspectionCount === 2) {
            form.replaceChildren(editor, send)
            hydrated = true
          }
        }
        return evaluatePage(evaluator, input)
      },
    }

    await expect(executeGeneratedProgram(program, browser)).resolves.toEqual({
      status: 'completed',
      response: 'hydrated response',
      truncated: false,
    })
    expect(filledBeforeHydration).toBe(false)
    expect(filledText).toBe(prompt)
    expect(sendClicks).toBe(1)
    expect(unrelatedClicks).toBe(0)
    expect(operations.map(operation => operation.id)).toEqual([
      'chatgpt-open',
      'chatgpt-reset-conversation',
      'chatgpt-fill',
      'chatgpt-send',
    ])
    expect(editor.hasAttribute('data-dsh-chatgpt-web-input')).toBe(false)
    expect(send.hasAttribute('data-dsh-chatgpt-web-send')).toBe(false)
  })

  it('matches ProseMirror paragraphs and hard breaks without counting trailing breaks', async () => {
    const newline = String.fromCharCode(10)
    const prompt = ['a', '', '---', '', 'b', 'hard break'].join(newline)
    const form = document.createElement('form')
    const editor = createComposer()
    const send = createSendButton('Send prompt')
    form.append(editor, send)
    document.body.append(form)
    let clicks = 0
    send.addEventListener('click', (event) => {
      event.preventDefault()
      clicks += 1
      appendCompletedDomTurn('paragraph response')
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        if (operation.id === 'chatgpt-fill') {
          const first = document.createElement('p')
          first.textContent = 'a'
          const firstTrailing = document.createElement('br')
          firstTrailing.className = 'ProseMirror-trailingBreak'
          first.append(firstTrailing)
          const emptyBeforeDivider = document.createElement('p')
          const emptyBeforeDividerTrailing = document.createElement('br')
          emptyBeforeDividerTrailing.className = 'ProseMirror-trailingBreak'
          emptyBeforeDivider.append(emptyBeforeDividerTrailing)
          const divider = document.createElement('p')
          divider.textContent = '---'
          const emptyAfterDivider = document.createElement('p')
          const emptyAfterDividerTrailing = document.createElement('br')
          emptyAfterDividerTrailing.className = 'ProseMirror-trailingBreak'
          emptyAfterDivider.append(emptyAfterDividerTrailing)
          const finalParagraph = document.createElement('p')
          finalParagraph.append('b', document.createElement('br'), 'hard break')
          const finalTrailing = document.createElement('br')
          finalTrailing.className = 'ProseMirror-trailingBreak'
          finalParagraph.append(finalTrailing)
          editor.replaceChildren(
            first,
            emptyBeforeDivider,
            divider,
            emptyAfterDivider,
            finalParagraph,
          )
        }
        if (operation.id === 'chatgpt-send') {
          expect(operationTarget(operation)).toBe(send)
          send.click()
        }
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor(prompt), browser)).resolves.toEqual({
      status: 'completed',
      response: 'paragraph response',
      truncated: false,
    })
    expect(clicks).toBe(1)
  })


  it('collects a nested current content-search assistant unit and settles from its exact Chinese copy action', async () => {
    const form = document.createElement('form')
    const editor = createComposer()
    const send = createSendButton('发送')
    form.append(editor, send)
    document.body.append(form)
    send.addEventListener('click', (event) => {
      event.preventDefault()
      form.remove()
      window.history.pushState(null, '', '/c/new-dom')
      const cluster = document.createElement('section')
      const user = contentSearchUser('UUID:0:user')
      const assistant = contentSearchAssistant('UUID:2:assistant', '我是 GPT-5.6 Sol。', true)
      const copy = document.createElement('button')
      copy.setAttribute('aria-label', '复制')
      cluster.append(user, assistant, copy)
      document.body.append(cluster)
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        if (operation.id === 'chatgpt-fill') setComposerText(editor, operation.value ?? '')
        if (operation.id === 'chatgpt-send') {
          expect(operationTarget(operation)).toBe(send)
          send.click()
        }
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor('collect current reply'), browser)).resolves.toEqual({
      status: 'completed',
      response: '我是 GPT-5.6 Sol。',
      truncated: false,
    })
  })

  it('does not settle a current content-search assistant from a copy action above multiple assistant units', async () => {
    const form = document.createElement('form')
    const editor = createComposer()
    const send = createSendButton('Send')
    form.append(editor, send)
    document.body.append(form)
    send.addEventListener('click', (event) => {
      event.preventDefault()
      form.remove()
      window.history.pushState(null, '', '/c/multiple-assistants')
      const cluster = document.createElement('section')
      const user = contentSearchUser('UUID:0:user')
      const previous = contentSearchAssistant('UUID:1:assistant', 'old reply')
      const current = contentSearchAssistant('UUID:2:assistant', 'current reply')
      const copy = document.createElement('button')
      copy.setAttribute('aria-label', 'Copy')
      cluster.append(user, previous, current, copy)
      document.body.append(cluster)
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        if (operation.id === 'chatgpt-fill') setComposerText(editor, operation.value ?? '')
        if (operation.id === 'chatgpt-send') send.click()
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor('do not use old copy', {
      generationTimeoutMs: 30,
    }), browser)).resolves.toMatchObject({
      status: 'generation-timeout',
      diagnostic: {
        page: 'conversation',
        userCount: 1,
        assistantCount: 2,
        settled: false,
      },
    })
  })

  it('fails within the readiness bound when an SSR textarea never hydrates into a ProseMirror composer', async () => {
    const form = document.createElement('form')
    const ssrTextarea = document.createElement('textarea')
    ssrTextarea.id = 'prompt-textarea'
    makeVisible(ssrTextarea)
    form.append(ssrTextarea)
    document.body.append(form)
    const operations: ProgramOperation[] = []
    const browser: ProgramBrowser = {
      run: async (operation) => { operations.push(operation) },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor('never fill', {
      generationTimeoutMs: 12,
      submissionTimeoutMs: 5,
    }), browser)).resolves.toEqual({ status: 'input-unavailable' })
    expect(operations.map(operation => operation.id)).toEqual([
      'chatgpt-open',
      'chatgpt-reset-conversation',
    ])
  })

  it('does not click when the filled ProseMirror text no longer matches the request', async () => {
    const form = document.createElement('form')
    const editor = createComposer()
    const send = createSendButton('Send')
    form.append(editor, send)
    document.body.append(form)
    let clicks = 0
    const operations: ProgramOperation[] = []
    send.addEventListener('click', (event) => {
      event.preventDefault()
      clicks += 1
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        operations.push(operation)
        if (operation.id === 'chatgpt-fill') setComposerText(editor, 'rewritten')
        if (operation.id === 'chatgpt-send') send.click()
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor('original', { submissionTimeoutMs: 5 }), browser)).resolves.toEqual({
      status: 'submission-failed',
      diagnostic: {
        page: 'root',
        userCount: 0,
        assistantCount: 0,
        inputCharacters: 'rewritten'.length,
        generating: false,
        settled: false,
        sendAvailable: true,
      },
    })
    expect(clicks).toBe(0)
    expect(operations.map(operation => operation.id)).not.toContain('chatgpt-send')
  })

  it('waits for a disabled public send button without refilling, then clicks it once', async () => {
    const form = document.createElement('form')
    const editor = createComposer()
    const send = createSendButton('Send message', true)
    form.append(editor, send)
    document.body.append(form)
    let readinessChecks = 0
    let fills = 0
    let clicks = 0
    send.addEventListener('click', (event) => {
      event.preventDefault()
      clicks += 1
      appendCompletedDomTurn('enabled response')
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        if (operation.id === 'chatgpt-fill') {
          fills += 1
          setComposerText(editor, operation.value ?? '')
        }
        if (operation.id === 'chatgpt-send') send.click()
      },
      evaluate: async (_page, evaluator, input) => {
        if (evaluator.includes('typeof input.prompt')) {
          readinessChecks += 1
          if (readinessChecks === 2) send.disabled = false
        }
        return evaluatePage(evaluator, input)
      },
    }

    await expect(executeGeneratedProgram(programFor('wait for send'), browser)).resolves.toEqual({
      status: 'completed',
      response: 'enabled response',
      truncated: false,
    })
    expect(readinessChecks).toBeGreaterThanOrEqual(2)
    expect(fills).toBe(1)
    expect(clicks).toBe(1)
  })

  it('fails closed when a composer form contains ambiguous public send controls', async () => {
    const form = document.createElement('form')
    const editor = createComposer()
    const first = createSendButton('Send')
    const second = createSendButton('Send message')
    form.append(editor, first, second)
    document.body.append(form)
    let clicks = 0
    first.addEventListener('click', () => { clicks += 1 })
    second.addEventListener('click', () => { clicks += 1 })
    const operations: ProgramOperation[] = []
    const browser: ProgramBrowser = {
      run: async (operation) => {
        operations.push(operation)
        if (operation.id === 'chatgpt-fill') setComposerText(editor, operation.value ?? '')
        if (operation.id === 'chatgpt-send') operationTarget(operation)
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor('ambiguous', { submissionTimeoutMs: 5 }), browser)).resolves.toMatchObject({
      status: 'submission-failed',
      diagnostic: { sendAvailable: false },
    })
    expect(clicks).toBe(0)
    expect(operations.map(operation => operation.id)).not.toContain('chatgpt-send')
  })

  it('treats an invalid pre-submit browser evaluator result as a protocol error without clicking', async () => {
    const form = document.createElement('form')
    const editor = createComposer()
    const send = createSendButton('Send prompt')
    form.append(editor, send)
    document.body.append(form)
    const operations: ProgramOperation[] = []
    const browser: ProgramBrowser = {
      run: async (operation) => {
        operations.push(operation)
        if (operation.id === 'chatgpt-fill') setComposerText(editor, operation.value ?? '')
        if (operation.id === 'chatgpt-send') send.click()
      },
      evaluate: async (_page, evaluator, input) => evaluator.includes('typeof input.prompt')
        ? {}
        : evaluatePage(evaluator, input),
    }

    await expect(executeGeneratedProgram(programFor('invalid result'), browser)).resolves.toEqual({
      status: 'protocol-error',
    })
    expect(operations.map(operation => operation.id)).not.toContain('chatgpt-send')
  })

  it('emits browser evaluator functions as executable JavaScript rather than TypeScript source', () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'question',
      model: 'GPT-5',
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 100,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const encodedEvaluators = [
      ...program.source.matchAll(/browser\.evaluate\(page, ("(?:\\.|[^"\\])*")/g),
    ].map(match => match[1])
    expect(encodedEvaluators).toHaveLength(7)
    for (const encoded of encodedEvaluators) {
      const evaluator = JSON.parse(encoded!) as string
      expect(() => new Script(`(${evaluator})`)).not.toThrow()
    }
  })

  it('resets a reused conversation before it fills the current standalone task', async () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'current unrelated task only',
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 100,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    let page: 'conversation' | 'root' = 'conversation'
    let filled = ''
    let assistantCount = 0
    const operations: string[] = []
    const browser = {
      run: async (operation: { id: string; kind: string; value?: string }) => {
        operations.push(operation.id)
        if (operation.kind === 'navigate') page = 'root'
        if (operation.kind === 'fill') filled = operation.value ?? ''
        if (operation.id === 'chatgpt-send') assistantCount = 1
      },
      evaluate: async (_page: string, evaluator: string) => {
        if (evaluator.includes('loginRequired')) {
          return { page, loginRequired: false, inputReady: true, assistantCount: 0, userCount: 0 }
        }
        if (evaluator.includes('typeof input.prompt')) {
          return {
            page: 'root', userCount: 0, assistantCount: 0, inputCharacters: 28,
            generating: false, settled: false, sendAvailable: true, promptMatches: true, ready: true,
          }
        }
        if (evaluator.includes('removeAttribute')) return true
        return {
          page: 'conversation',
          userCount: 1,
          assistantCount,
          inputCharacters: 0,
          response: assistantCount === 0 ? '' : 'current task response',
          generating: false,
          settled: assistantCount > 0,
          sendAvailable: true,
        }
      },
    }
    const AsyncFunction = (async function () {}).constructor as unknown as new (
      ...args: string[]
    ) => (browserArgument: unknown) => Promise<unknown>

    await expect(new AsyncFunction('browser', program.source)(browser)).resolves.toEqual({
      status: 'completed',
      response: 'current task response',
      truncated: false,
    })
    expect(operations.slice(0, 4)).toEqual([
      'chatgpt-open',
      'chatgpt-reset-conversation',
      'chatgpt-fill',
      'chatgpt-send',
    ])
    expect(filled).toBe('current unrelated task only')
  })

  it('fails before filling when the ChatGPT root still contains a prior user turn', async () => {
    const program = adapter.buildChatGptWebProgram({
      url: 'https://chatgpt.com/',
      workspaceName: 'fixture-chatgpt-web',
      prompt: 'must not be submitted',
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 100,
      pollIntervalMs: 1,
      outputMaxBytes: 2_048,
    })
    const operations: string[] = []
    const browser = {
      run: async (operation: { id: string }) => { operations.push(operation.id) },
      evaluate: async (_page: string, evaluator: string) => evaluator.includes('loginRequired')
        ? { page: 'root', loginRequired: false, inputReady: true, assistantCount: 0, userCount: 1 }
        : true,
    }
    const AsyncFunction = (async function () {}).constructor as unknown as new (
      ...args: string[]
    ) => (browserArgument: unknown) => Promise<unknown>

    await expect(new AsyncFunction('browser', program.source)(browser)).resolves.toEqual({
      status: 'context-not-isolated',
    })
    expect(operations).toEqual(['chatgpt-open', 'chatgpt-reset-conversation'])
  })

  it('fails loud instead of silently falling back when an explicit model cannot be verified', async () => {
    const provider = new StubBrowserProvider(async () => resultFor({ status: 'model-selection-unavailable' }))
    const { ctx, plugin } = await setup(provider)
    const run = await ctx.physicalOperators.start('chatgpt-web', {
      ...request(),
      residentProfile: { model: 'GPT-5' },
    })
    await expect(run.result).rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })
    expect(provider.programs).toHaveLength(1)
    expect(serializedProgramRequest(provider.programs[0]!)).toMatchObject({ model: 'GPT-5' })

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('does not request a model control unless the caller explicitly selects one', async () => {
    const { ctx, plugin, provider } = await setup()
    const run = await ctx.physicalOperators.start('chatgpt-web', request())
    await run.result
    expect(serializedProgramRequest(provider.programs[0]!)).not.toHaveProperty('model')

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('returns an aborted terminal result and never closes the browser when its caller aborts', async () => {
    const provider = new StubBrowserProvider(async (_program, signal) => {
      return new Promise<BrowserRunProgramResultV1>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new BrowserError('fixture browser was cancelled', 'BROWSER_ABORTED'))
        }, { once: true })
      })
    })
    const { ctx, plugin } = await setup(provider)
    const controller = new AbortController()
    const run = await ctx.physicalOperators.start('chatgpt-web', request(controller.signal))
    controller.abort(new Error('caller cancelled'))

    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    expect(provider.signals[0]?.aborted).toBe(true)
    const events = await run.readEvents?.(0, 20)
    expect(events?.events.at(-1)).toMatchObject({ type: 'chatgpt-web.aborted', data: { phase: 'aborted' } })

    await run.dispose()
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('admits only one active ChatGPT turn at a time', async () => {
    const deferred = Promise.withResolvers<BrowserRunProgramResultV1>()
    const provider = new StubBrowserProvider(async () => deferred.promise)
    const { ctx, plugin } = await setup(provider)
    const first = await ctx.physicalOperators.start('chatgpt-web', request())
    expect(ctx.physicalOperators.status('chatgpt-web')).toMatchObject({ state: 'busy', active: 1 })
    await expect(ctx.physicalOperators.start('chatgpt-web', request())).rejects.toMatchObject({ code: 'OPERATOR_BUSY' })

    deferred.resolve(resultFor({ status: 'completed', response: 'done', truncated: false }))
    await expect(first.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect(ctx.physicalOperators.status('chatgpt-web')).toMatchObject({ state: 'available', active: 0 })

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('emits bounded waiting heartbeats while one browser program remains active', async () => {
    const deferred = Promise.withResolvers<BrowserRunProgramResultV1>()
    const provider = new StubBrowserProvider(async () => deferred.promise)
    const { ctx, plugin } = await setup(provider)
    const run = await ctx.physicalOperators.start('chatgpt-web', request())
    await new Promise(resolve => setTimeout(resolve, 45))

    const progress = await run.readEvents?.(0, 20)
    expect(progress?.events.filter(event => event.type === 'chatgpt-web.waiting').length).toBeGreaterThanOrEqual(2)
    expect(progress?.events.at(-1)?.data).toMatchObject({ phase: 'waiting' })
    expect(progress?.events.at(-1)?.data.elapsedMs).toEqual(expect.any(Number))

    deferred.resolve(resultFor({ status: 'completed', response: 'done', truncated: false }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it('rejects an unavailable browser seam and invalid direct settings before it registers an operator', async () => {
    const unavailable = new StubBrowserProvider(undefined, ['page-evaluate'])
    const { ctx, plugin } = await setup(unavailable)
    const status = ctx.physicalOperators.status('chatgpt-web')
    expect(status.state).toBe('unavailable')
    expect(status.unavailableReason).toContain('authenticated-profile-reuse')
    await expect(ctx.physicalOperators.start('chatgpt-web', request())).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })
    await plugin.dispose()

    expect(() => { adapter.apply(ctx, { url: 'http://chatgpt.com/' }) }).toThrow('https://chatgpt.com/')
    expect(() => { adapter.apply(ctx, { url: 'https://chatgpt.com/other' }) }).toThrow('exactly')
    expect(() => { adapter.apply(ctx, { generationTimeoutMs: 1_000, submissionTimeoutMs: 1_001 }) })
      .toThrow('submissionTimeoutMs must not exceed generationTimeoutMs')
    expect(() => { adapter.apply(ctx, {
      generationTimeoutMs: 1_000,
      submissionTimeoutMs: 100,
      progressIntervalMs: 1_001,
    }) })
      .toThrow('progressIntervalMs must not exceed generationTimeoutMs')
    expect(ctx.physicalOperators.list()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('rejects non-text input, unsupported resident mode, and unverified effort control before browser dispatch', async () => {
    const { ctx, plugin, provider } = await setup()
    await expect(ctx.physicalOperators.start('chatgpt-web', {
      ...request(),
      prompt: [{ type: 'image', image_url: 'data:image/png;base64,AA==' }],
    } as never)).rejects.toMatchObject({ code: 'INVALID_RESULT' })
    await expect(ctx.physicalOperators.start('chatgpt-web', {
      ...request(), mode: 'resident',
    })).rejects.toMatchObject({ code: 'OPERATOR_MODE_UNSUPPORTED' })
    await expect(ctx.physicalOperators.start('chatgpt-web', {
      ...request(), residentProfile: { effort: 'high' },
    })).rejects.toMatchObject({ code: 'OPERATOR_OPTION_UNSUPPORTED' })
    expect(provider.programs).toEqual([])

    await plugin.dispose()
    await ctx.fiber.dispose()
  })

  it.each([
    ['context-not-isolated', 'CHATGPT_WEB_CONTEXT_NOT_ISOLATED'],
    ['submission-failed', 'CHATGPT_WEB_SUBMIT_FAILED'],
    ['generation-timeout', 'CHATGPT_WEB_TIMEOUT'],
  ] as const)('projects %s with bounded non-sensitive diagnostics', async (status, code) => {
    const diagnostic = {
      page: 'root',
      userCount: 0,
      assistantCount: 0,
      inputCharacters: 321,
      generating: false,
      settled: false,
      sendAvailable: true,
    }
    const provider = new StubBrowserProvider(async () => resultFor(
      status === 'context-not-isolated' ? { status } : { status, diagnostic },
    ))
    const { ctx, plugin } = await setup(provider)
    const run = await ctx.physicalOperators.start('chatgpt-web', request())

    const error = await run.result.then(
      () => { throw new Error('expected ChatGPT Web run to fail') },
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(PhysicalOperatorError)
    expect((error as PhysicalOperatorError).code).toBe(code)
    if (status === 'context-not-isolated') {
      expect((error as Error).message).toContain('fresh conversation')
    } else {
      expect((error as Error).message).toContain('inputCharacters=321')
    }
    const progress = await run.readEvents?.(0, 20)
    expect(progress?.events.at(-1)).toMatchObject({
      type: 'chatgpt-web.failed',
      data: { phase: 'failed', code },
    })
    expect(JSON.stringify(progress)).not.toContain('private task body')

    await plugin.dispose()
    await ctx.fiber.dispose()
  })
})
