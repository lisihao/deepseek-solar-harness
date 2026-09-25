// @vitest-environment jsdom

import { Script } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserJsonValue, BrowserRunProgramV1 } from '@deepseek-ai/dsh-browser'
import {
  buildCoordinatedWebPollProgram,
  buildCoordinatedWebSubmissionProofProgram,
  buildCoordinatedWebSubmitProgram,
} from '../src/web-session-browser.ts'

interface ProgramOperation {
  readonly id: string
  readonly kind: string
  readonly locator?: { readonly selector?: string }
  readonly value?: string
  readonly url?: string
}

interface ProgramBrowser {
  run(operation: ProgramOperation): Promise<unknown>
  evaluate(page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue>
}

const ProgramAsyncFunction = (async function () {}).constructor as unknown as new (
  ...args: string[]
) => (browser: ProgramBrowser) => Promise<BrowserJsonValue>

function executeProgram(program: BrowserRunProgramV1, browser: ProgramBrowser): Promise<BrowserJsonValue> {
  return new ProgramAsyncFunction('browser', program.source)(browser)
}

async function evaluatePage(
  evaluator: string,
  input?: BrowserJsonValue,
  pageLocation: Pick<Location, 'href'> = location,
): Promise<BrowserJsonValue> {
  const evaluate = new Script('(' + evaluator + ')').runInNewContext({
    document,
    location: pageLocation,
    URL,
    Node,
    TextEncoder,
    Object,
    Set,
    Array,
    getComputedStyle: window.getComputedStyle.bind(window),
  }) as (argument?: BrowserJsonValue) => BrowserJsonValue
  return evaluate(input)
}

function visible(element: Element): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: 100, height: 20 }),
  })
}

function nullRecord(values: Record<string, unknown>): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, values)
}

function attachReactProps(element: Element, value: Record<string, unknown>): void {
  Object.defineProperty(element, '__reactProps$fixture', { configurable: true, value })
}

function userMessage(id: string, text: string): HTMLDivElement {
  const node = document.createElement('div')
  node.setAttribute('data-message-author-role', 'user')
  node.setAttribute('data-message-id', id)
  const bubble = document.createElement('div')
  bubble.setAttribute('data-user-message-bubble', 'true')
  bubble.textContent = text
  node.append(bubble)
  return node
}

function assistantMessage(id: string, text: string): HTMLDivElement {
  const node = document.createElement('div')
  node.setAttribute('data-message-author-role', 'assistant')
  node.setAttribute('data-message-id', id)
  const content = document.createElement('div')
  content.setAttribute('data-markdown-text-style', 'assistant-message')
  content.textContent = text
  node.append(content)
  return node
}

function basicProgram(url = 'https://chatgpt.com/c/current'): Omit<Parameters<typeof buildCoordinatedWebPollProgram>[0], 'userMessageId'> {
  return { workspaceName: 'fixture', url, outputMaxBytes: 4_096 }
}

afterEach(() => {
  document.body.replaceChildren()
  window.history.replaceState(null, '', '/')
})

describe('coordinated Web-session browser programs', () => {
  it('reads request ids only from the exact native user node and ignores a broad ancestor holding another turn', async () => {
    window.history.pushState(null, '', '/c/current')
    const conversation = document.createElement('section')
    const oldUser = userMessage('user-old', 'old task')
    const currentUser = userMessage('user-current', 'current task')
    const currentAssistant = assistantMessage('assistant-current', 'current answer')
    conversation.append(oldUser, currentUser, currentAssistant)
    document.body.append(conversation)
    attachReactProps(currentUser, nullRecord({
      message: nullRecord({
        id: 'user-current',
        metadata: nullRecord({ request_id: 'request-current' }),
      }),
    }))
    attachReactProps(currentAssistant, nullRecord({
      message: nullRecord({
        id: 'assistant-current',
        metadata: nullRecord({ end_turn: true, finished_successfully: true, model_slug: 'gpt-fixture' }),
      }),
    }))
    attachReactProps(conversation, nullRecord({
      message: nullRecord({ id: 'user-old', metadata: nullRecord({ request_id: 'request-stale' }) }),
    }))
    const program = buildCoordinatedWebPollProgram({ ...basicProgram(), userMessageId: 'user-current' })
    const browser: ProgramBrowser = {
      run: async () => undefined,
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeProgram(program, browser)).resolves.toMatchObject({
      status: 'observation',
      observation: {
        identity: 'exact',
        userMessageId: 'user-current',
        assistantMessageId: 'assistant-current',
        requestIds: ['request-current'],
        terminal: 'completed',
      },
    })
  })

  it('refuses to pair an assistant beyond an intervening native user turn', async () => {
    window.history.pushState(null, '', '/c/current')
    const currentUser = userMessage('user-current', 'current task')
    const interveningUser = userMessage('user-intervening', 'later task')
    const laterAssistant = assistantMessage('assistant-later', 'later answer')
    document.body.append(currentUser, interveningUser, laterAssistant)
    attachReactProps(currentUser, nullRecord({ message: nullRecord({ id: 'user-current', metadata: nullRecord({ request_id: 'request-current' }) }) }))
    const program = buildCoordinatedWebPollProgram({ ...basicProgram(), userMessageId: 'user-current' })
    const browser: ProgramBrowser = {
      run: async () => undefined,
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input),
    }

    await expect(executeProgram(program, browser)).resolves.toMatchObject({
      status: 'observation',
      observation: { identity: 'unproven', terminal: 'indeterminate', requestIds: [] },
    })
  })

  it('uses the durable pre-send baseline to distinguish a repeated prompt from the newly submitted native user message', async () => {
    const oldUser = userMessage('user-old', 'repeat task')
    const newUser = userMessage('user-new', 'repeat task')
    const newAssistant = assistantMessage('assistant-new', 'new answer')
    document.body.append(oldUser, newUser, newAssistant)
    attachReactProps(newUser, nullRecord({ message: nullRecord({ id: 'user-new', metadata: nullRecord({ request_id: 'request-new' }) }) }))
    attachReactProps(newAssistant, nullRecord({
      message: nullRecord({ id: 'assistant-new', metadata: nullRecord({ end_turn: true, finished_successfully: true }) }),
    }))
    const program = buildCoordinatedWebSubmissionProofProgram({
      ...basicProgram('https://chatgpt.com/c/repeated'),
      prompt: 'repeat task',
      baselineUserMessageIds: ['user-old'],
    })
    const pageUrl = new URL('https://chatgpt.com/c/repeated')
    const browser: ProgramBrowser = {
      run: async () => undefined,
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input, pageUrl),
    }

    await expect(executeProgram(program, browser)).resolves.toMatchObject({
      status: 'accepted',
      observation: { userMessageId: 'user-new', requestIds: ['request-new'] },
    })
  })

  it('keeps the submit page alias through delayed navigation and proves only its new conversation', async () => {
    const form = document.createElement('form')
    const editor = document.createElement('div')
    editor.className = 'ProseMirror'
    editor.setAttribute('contenteditable', 'true')
    const connector = document.createElement('span')
    connector.setAttribute('data-connector-name', 'DSH')
    const send = document.createElement('button')
    send.type = 'submit'
    send.setAttribute('aria-label', 'Send')
    form.append(editor, connector, send)
    document.body.append(form)
    visible(editor)
    visible(connector)
    visible(send)
    const staleUser = userMessage('user-old', 'delayed task')
    attachReactProps(staleUser, nullRecord({ message: nullRecord({ id: 'user-old', metadata: nullRecord({ request_id: 'request-old' }) }) }))
    const newUser = userMessage('user-delayed', 'delayed task')
    attachReactProps(newUser, nullRecord({ message: nullRecord({ id: 'user-delayed', metadata: nullRecord({ request_id: 'request-delayed' }) }) }))
    let pageUrl = new URL('https://chatgpt.com/')
    const submit = buildCoordinatedWebSubmitProgram({
      ...basicProgram('https://chatgpt.com/'),
      prompt: 'delayed task',
      connectorName: 'DSH',
      freshLane: true,
      baselineUserMessageIds: [],
      modelSelectionTimeoutMs: 100,
      pollIntervalMs: 1,
      submissionTimeoutMs: 20,
    })
    const submitOperations: ProgramOperation[] = []
    let afterSubmitChecks = 0
    const submitBrowser: ProgramBrowser = {
      run: async (operation) => {
        submitOperations.push(operation)
        if (operation.id === 'chatgpt-web-session-fill') editor.textContent = operation.value ?? ''
        if (operation.id === 'chatgpt-web-session-select-owned-conversation') {
          pageUrl = new URL('https://chatgpt.com/c/old')
          document.body.replaceChildren(staleUser)
        }
      },
      evaluate: async (_page, evaluator, input) => {
        const result = await evaluatePage(evaluator, input, pageUrl)
        if (evaluator.includes("const phase = 'after-submit'") && afterSubmitChecks++ === 0) {
          queueMicrotask(() => { pageUrl = new URL('https://chatgpt.com/c/delayed') })
        }
        return result
      },
    }

    await expect(executeProgram(submit, submitBrowser)).resolves.toEqual({
      status: 'submission-pending',
      phase: 'after-submit',
      candidateUrl: 'https://chatgpt.com/c/delayed',
    })
    expect(submitOperations.map(operation => operation.id)).toContain('chatgpt-web-session-send')

    const proof = buildCoordinatedWebSubmissionProofProgram({
      ...basicProgram(pageUrl.href),
      prompt: 'delayed task',
      baselineUserMessageIds: [],
    })
    const proofOperations: ProgramOperation[] = []
    const proofBrowser: ProgramBrowser = {
      run: async (operation) => {
        proofOperations.push(operation)
        if (operation.id === 'chatgpt-web-session-open') document.body.replaceChildren(newUser)
        if (operation.id === 'chatgpt-web-session-select-owned-conversation') {
          pageUrl = new URL('https://chatgpt.com/c/old')
          document.body.replaceChildren(staleUser)
        }
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input, pageUrl),
    }

    await expect(executeProgram(proof, proofBrowser)).resolves.toMatchObject({
      status: 'accepted',
      observation: { userMessageId: 'user-delayed', requestIds: ['request-delayed'] },
    })
    expect(proofOperations).toContainEqual(expect.objectContaining({
      id: 'chatgpt-web-session-open',
      url: 'https://chatgpt.com/c/delayed',
    }))
    expect([...submitOperations, ...proofOperations].some(operation => operation.id === 'chatgpt-web-session-select-owned-conversation')).toBe(false)
  })

  it('does not inspect a stale conversation when submission proof has only the root candidate', async () => {
    const staleUser = userMessage('user-old', 'stale task')
    attachReactProps(staleUser, nullRecord({ message: nullRecord({ id: 'user-old', metadata: nullRecord({ request_id: 'request-old' }) }) }))
    let pageUrl = new URL('https://chatgpt.com/')
    const operations: ProgramOperation[] = []
    const proof = buildCoordinatedWebSubmissionProofProgram({
      ...basicProgram('https://chatgpt.com/'),
      prompt: 'stale task',
      baselineUserMessageIds: [],
    })
    const browser: ProgramBrowser = {
      run: async (operation) => {
        operations.push(operation)
        if (operation.id === 'chatgpt-web-session-select-owned-conversation') {
          pageUrl = new URL('https://chatgpt.com/c/old')
          document.body.replaceChildren(staleUser)
        }
      },
      evaluate: async (_page, evaluator, input) => evaluatePage(evaluator, input, pageUrl),
    }

    await expect(executeProgram(proof, browser)).resolves.toEqual({ status: 'submission-pending', phase: 'submission-proof' })
    expect(operations).toEqual([])
  })
})
