/** Deterministic external ChatGPT page for the real coordinated Web session. */

import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserJsonValue,
  type BrowserProvider,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'

const REQUEST_ID = 'wfr_fixture'
const CONVERSATION_ID = 'fixture-conversation'
const USER_MESSAGE_ID = 'fixture-user'
const ASSISTANT_MESSAGE_ID = 'fixture-assistant'
const RESPONSE = 'Web MCP checkpoint completed.'

const AsyncFunction = (async function () {}).constructor as unknown as new (
  ...args: string[]
) => (browser: ProgramBrowser) => Promise<BrowserJsonValue>

interface ProgramOperation {
  readonly id: string
}

interface ProgramBrowser {
  run(operation: ProgramOperation): Promise<unknown>
  evaluate(page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue>
}

interface BrowserProgramRequest {
  readonly workspaceName: string
  readonly prompt?: string
}

let accepted = Promise.withResolvers<undefined>()
let checkpointComplete = false

/** Await the exact native turn that grants the MCP request its owner proof. */
export function waitForExactTurn(): Promise<void> {
  return accepted.promise
}

/** Publish the fake webpage's terminal state only after every real MCP call returns. */
export function completeWebTurn(): void {
  checkpointComplete = true
}

function reset(): void {
  accepted = Promise.withResolvers<undefined>()
  checkpointComplete = false
}

/** The production browser-js source runs verbatim; only webpage observations are fixture data. */
class FixtureBrowserProvider implements BrowserProvider, ProgramBrowser {
  readonly descriptor: BrowserProvider['descriptor'] = {
    id: BrowserProviderId('web-mcp-coordination-browser'),
    layers: ['browser-js-v1'],
    capabilities: ['authenticated-profile-reuse', 'named-workspace', 'page-evaluate'],
  }
  private active: BrowserProgramRequest | undefined
  private submitted = false

  available(): boolean {
    return true
  }

  async runProgram(program: BrowserRunProgramV1): Promise<BrowserRunProgramResultV1> {
    this.active = serializedRequest(program)
    this.submitted = false
    const value = await new AsyncFunction('browser', program.source)(this)
    return {
      version: 1,
      workspace: {
        id: BrowserWorkspaceId('web-mcp-coordination-browser'),
        name: this.active.workspaceName,
        lifecycle: 'active',
        control: 'agent',
      },
      output: { kind: 'json', value },
    }
  }

  async run(operation: ProgramOperation): Promise<void> {
    if (operation.id === 'chatgpt-web-session-send') this.submitted = true
  }

  async evaluate(_page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue> {
    if (evaluator.includes("const phase = 'prepare'")) {
      return { status: 'ready', phase: 'prepare', beforeUserIds: [] }
    }
    if (evaluator.includes("const phase = 'verify'")) return { status: 'ready', phase: 'verify' }
    if (evaluator.includes("const phase = 'after-submit'")) {
      if (!this.submitted || this.active?.prompt === undefined) return { status: 'protocol-error', phase: 'after-submit' }
      accepted.resolve(undefined)
      return { status: 'accepted', phase: 'after-submit', observation: runningObservation() }
    }
    if (evaluator.includes("const phase = 'poll'")) {
      if (inputRecord(input).userMessageId !== USER_MESSAGE_ID) return { status: 'observation', phase: 'poll', observation: unprovenObservation() }
      return { status: 'observation', phase: 'poll', observation: checkpointComplete ? completedObservation() : runningObservation() }
    }
    throw new Error('web-mcp browser fixture received an unexpected browser evaluator')
  }
}

function serializedRequest(program: BrowserRunProgramV1): BrowserProgramRequest {
  const match = /^const request = (.*);$/m.exec(program.source)
  if (match?.[1] === undefined) throw new Error('web-mcp browser fixture did not find the generated request')
  return JSON.parse(match[1]) as BrowserProgramRequest
}

function inputRecord(value: BrowserJsonValue | undefined): Readonly<Record<string, string>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, string>>
    : {}
}

function runningObservation(): BrowserJsonValue {
  return {
    identity: 'exact',
    conversationId: CONVERSATION_ID,
    conversationUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    userMessageId: USER_MESSAGE_ID,
    requestIds: [REQUEST_ID],
    model: 'fixture-chatgpt-web',
    generating: true,
    terminal: 'running',
  }
}

function completedObservation(): BrowserJsonValue {
  return {
    identity: 'exact',
    conversationId: CONVERSATION_ID,
    conversationUrl: `https://chatgpt.com/c/${CONVERSATION_ID}`,
    userMessageId: USER_MESSAGE_ID,
    requestIds: [REQUEST_ID],
    model: 'fixture-chatgpt-web',
    assistantMessageId: ASSISTANT_MESSAGE_ID,
    response: RESPONSE,
    generating: false,
    terminal: 'completed',
  }
}

function unprovenObservation(): BrowserJsonValue {
  return {
    identity: 'unproven',
    conversationUrl: 'https://chatgpt.com/c/unproven',
    requestIds: [],
    model: 'unknown',
    generating: false,
    terminal: 'indeterminate',
  }
}

export const name = 'web-mcp-coordination-browser'
export const inject = ['browser']

/** Register only the fake external browser provider used by this Loader composition. */
export function apply(ctx: Context): void {
  reset()
  ctx.browser.registerProvider(new FixtureBrowserProvider())
}
