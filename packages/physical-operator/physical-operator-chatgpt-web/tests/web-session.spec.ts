import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BrowserRuntime, {
  BrowserProviderId,
  BrowserWorkspaceId,
  type BrowserCapabilityV1,
  type BrowserJsonValue,
  type BrowserProvider,
  type BrowserRunProgramResultV1,
  type BrowserRunProgramV1,
} from '@deepseek-ai/dsh-browser'
import { PhysicalOperatorExecutionId, type PhysicalOperatorProviderStartRequest } from '@deepseek-ai/dsh-physical-operator'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { WebModelPreferences } from '../src/model-catalog.ts'
import { runCoordinatedWebSession, type CoordinatedWebSessionObservation } from '../src/web-session.ts'

const CAPABILITIES: readonly BrowserCapabilityV1[] = [
  'authenticated-profile-reuse',
  'named-workspace',
  'page-evaluate',
]

const AsyncFunction = (async function () {}).constructor as unknown as new (
  ...args: string[]
) => (browser: ProgramBrowser) => Promise<BrowserJsonValue>

interface ProgramOperation {
  readonly id: string
  readonly kind: string
}

interface ProgramBrowser {
  run(operation: ProgramOperation): Promise<unknown>
  evaluate(page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue>
}

interface BrowserProgramRequest {
  readonly workspaceName: string
  readonly url: string
  readonly prompt?: string
  readonly freshLane?: boolean
  readonly previousTurn?: {
    readonly userMessageId: string
    readonly assistantMessageId?: string
  }
  readonly profile?: WebModelPreferences
}

interface AppliedProfile {
  readonly phase: 'prepare' | 'submit'
  readonly profile: WebModelPreferences
}

interface FixtureTurn {
  readonly conversationId: string
  readonly userMessageId: string
  readonly assistantMessageId: string
  readonly response: string
  readonly terminal?: 'completed' | 'stopped' | 'failed'
  readonly requestIds?: readonly string[]
}

/** Fixture browser that executes the generated browser-js-v1 source verbatim. */
class FixtureBrowserProvider implements BrowserProvider, ProgramBrowser {
  readonly descriptor: BrowserProvider['descriptor'] = {
    id: BrowserProviderId('web-session-fixture'),
    layers: ['browser-js-v1'],
    capabilities: CAPABILITIES,
  }
  readonly programs: BrowserRunProgramV1[] = []
  readonly operations: ProgramOperation[] = []
  readonly observations: BrowserJsonValue[] = []
  readonly turns = new Map<string, FixtureTurn>()
  readonly drafts = new Set<string>()
  readonly missingConnectors = new Set<string>()
  readonly afterSubmitOverrides = new Map<string, BrowserJsonValue>()
  readonly submissionProofOverrides = new Map<string, BrowserJsonValue>()
  readonly pollOverrides = new Map<string, BrowserJsonValue>()
  readonly unavailableModels = new Set<string>()
  readonly appliedProfiles: AppliedProfile[] = []
  readonly trace: string[] = []
  private active: BrowserProgramRequest | undefined

  available(): boolean {
    return true
  }

  async runProgram(program: BrowserRunProgramV1): Promise<BrowserRunProgramResultV1> {
    this.programs.push(program)
    this.active = serializedRequest(program)
    const value = await new AsyncFunction('browser', program.source)(this)
    return {
      version: 1,
      workspace: {
        id: BrowserWorkspaceId('web-session-fixture'),
        name: this.active.workspaceName,
        lifecycle: 'active',
        control: 'agent',
      },
      output: { kind: 'json', value },
    }
  }

  async run(operation: ProgramOperation): Promise<void> {
    this.operations.push(operation)
    this.trace.push(operation.id)
  }

  async evaluate(_page: string, evaluator: string, input?: BrowserJsonValue): Promise<BrowserJsonValue> {
    if (evaluator.includes('model-picker-unavailable')) {
      const profile = this.active?.profile
      if (profile === undefined) throw new Error('fixture received an unexpected profile evaluator')
      const phase = this.programs.at(-1)?.source.includes("id: 'chatgpt-web-session-fill'") === true ? 'submit' : 'prepare'
      this.appliedProfiles.push({ phase, profile: { ...profile } })
      this.trace.push(`model-selection:${phase}`)
      if (profile.model !== undefined && this.unavailableModels.has(profile.model)) {
        return { status: 'model-selection-unavailable' }
      }
      return {
        status: 'ok',
        models: profile.model === undefined ? [] : [{ id: profile.model, label: profile.model }],
        efforts: profile.effort === undefined ? [] : [{ id: profile.effort, label: profile.effort }],
        ...profile.model === undefined ? {} : { selectedModel: profile.model },
        ...profile.effort === undefined ? {} : { selectedEffort: profile.effort },
        observedAt: '2026-09-23T00:00:00.000Z',
      }
    }
    const prompt = this.active?.prompt
    if (evaluator.includes("const phase = 'prepare'")) {
      if (prompt !== undefined && this.drafts.has(prompt)) {
        return { status: 'draft-present', phase: 'prepare', inputCharacters: 13, attachmentCount: 0 }
      }
      if (prompt !== undefined && this.missingConnectors.has(prompt)) return { status: 'connector-required', phase: 'prepare' }
      return { status: 'ready', phase: 'prepare', beforeUserIds: [] }
    }
    if (evaluator.includes("const phase = 'verify'")) return { status: 'ready', phase: 'verify' }
    if (evaluator.includes("const phase = 'after-submit'")) {
      if (prompt !== undefined) {
        const override = this.afterSubmitOverrides.get(prompt)
        if (override !== undefined) return override
      }
      return this.acceptedForPrompt(prompt)
    }
    if (evaluator.includes("const phase = 'submission-proof'")) {
      const proofPrompt = inputRecord(input).prompt
      if (proofPrompt !== undefined) {
        const override = this.submissionProofOverrides.get(proofPrompt)
        if (override !== undefined) return override
      }
      return this.acceptedForPrompt(proofPrompt)
    }
    if (evaluator.includes("const phase = 'poll'")) {
      const userMessageId = inputRecord(input).userMessageId
      if (userMessageId === undefined) return { status: 'protocol-error' }
      const override = this.pollOverrides.get(userMessageId)
      if (override !== undefined) return { status: 'observation', phase: 'poll', observation: override }
      const turn = [...this.turns.values()].find(value => value.userMessageId === userMessageId)
      if (turn === undefined) return { status: 'observation', phase: 'poll', observation: unprovenObservation() }
      const observation = observationFor(turn)
      this.observations.push(observation)
      return { status: 'observation', phase: 'poll', observation }
    }
    if (evaluator.includes("const phase = 'inspect-unproven'")) {
      return { status: 'inspected', phase: 'inspect-unproven', conversationUrl: this.active?.url ?? '', generating: false }
    }
    throw new Error('fixture received an unexpected browser evaluator')
  }

  private acceptedForPrompt(prompt: string | undefined): BrowserJsonValue {
    if (prompt === undefined) return { status: 'protocol-error' }
    const turn = this.turns.get(prompt)
    if (turn === undefined) return { status: 'submission-pending', candidateUrl: this.active?.url ?? '' }
    return {
      status: 'accepted',
      phase: 'after-submit',
      observation: {
        identity: 'exact',
        conversationId: turn.conversationId,
        conversationUrl: `https://chatgpt.com/c/${turn.conversationId}`,
        userMessageId: turn.userMessageId,
        requestIds: [...(turn.requestIds ?? ['request-current'])],
        model: 'fixture-model',
        generating: true,
        terminal: 'running',
      },
    }
  }
}

function inputRecord(input: BrowserJsonValue | undefined): Readonly<Record<string, string>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return {}
  return input as Readonly<Record<string, string>>
}

function serializedRequest(program: BrowserRunProgramV1): BrowserProgramRequest {
  const match = /^const request = (.*);$/m.exec(program.source)
  if (match?.[1] === undefined) throw new Error('fixture did not find the serialized browser request')
  return JSON.parse(match[1]) as BrowserProgramRequest
}

function observationFor(turn: FixtureTurn): BrowserJsonValue {
  const terminal = turn.terminal ?? 'completed'
  return {
    identity: 'exact',
    conversationId: turn.conversationId,
    conversationUrl: `https://chatgpt.com/c/${turn.conversationId}`,
    userMessageId: turn.userMessageId,
    assistantMessageId: turn.assistantMessageId,
    requestIds: [...(turn.requestIds ?? ['request-current'])],
    response: turn.response,
    model: 'fixture-model',
    generating: false,
    terminal,
  }
}

function unprovenObservation(): BrowserJsonValue {
  return {
    identity: 'unproven',
    conversationUrl: 'https://chatgpt.com/c/unknown',
    requestIds: [],
    model: 'unknown',
    generating: false,
    terminal: 'indeterminate',
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(BrowserRuntime)
  const provider = new FixtureBrowserProvider()
  ctx.browser.registerProvider(provider)
  return { ctx, provider }
}

function fakeParent(session = Session.create(SessionId('web-session-parent'))): Agent {
  return { id: session.id, session } as unknown as Agent
}

function request(
  parent: Agent,
  commandId: string,
  prompt: string,
  residentLaneId?: string,
): PhysicalOperatorProviderStartRequest {
  return {
    executionId: PhysicalOperatorExecutionId(commandId),
    mode: 'resident',
    prompt: [{ type: 'text', text: prompt }],
    parent,
    signal: new AbortController().signal,
    ...residentLaneId === undefined ? {} : { residentLaneId },
  }
}

function options(observations: CoordinatedWebSessionObservation[] = [], profile?: WebModelPreferences) {
  return {
    workspaceName: 'fixture-chatgpt-web',
    url: 'https://chatgpt.com/',
    connectorName: 'DSH',
    generationTimeoutMs: 100,
    submissionTimeoutMs: 20,
    pollIntervalMs: 1,
    outputMaxBytes: 4_096,
    canFinish: () => true,
    onObservation: (observation: CoordinatedWebSessionObservation) => { observations.push(observation) },
    ...profile === undefined ? {} : { profile },
  }
}

function workspaceFor(parentId: string, laneId: string): string {
  return `fixture-chatgpt-web-lane-${createHash('sha256').update(`${parentId}:${laneId}`).digest('hex').slice(0, 16)}`
}

describe('coordinated ChatGPT Web session', () => {
  it('returns a completed durable receipt for a duplicate command without resending', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.turns.set('first task', {
      conversationId: 'conversation-one', userMessageId: 'user-one', assistantMessageId: 'assistant-one', response: 'first result',
    })

    const first = await runCoordinatedWebSession(ctx, request(parent, 'command-one', 'first task'), options())
    await expect(first.result).resolves.toMatchObject({
      output: [{ type: 'text', text: 'first result' }],
      stopReason: 'completed',
      continuity: { sessionId: 'web-session-parent:main' },
    })
    const duplicate = await runCoordinatedWebSession(ctx, request(parent, 'command-one', 'first task'), options())
    await expect(duplicate.result).resolves.toMatchObject({ output: [{ text: 'first result' }], stopReason: 'completed' })

    expect(provider.operations.filter(operation => operation.id === 'chatgpt-web-session-send')).toHaveLength(1)
    expect(parent.session.events.filter(event => event.type === 'chatgpt-web/intent')).toHaveLength(1)
    expect(parent.session.events.filter(event => event.type === 'chatgpt-web/completed')).toHaveLength(1)
    expect(parent.session.events.find(event => event.type === 'chatgpt-web/intent')?.data).toMatchObject({
      baselineUserMessageIds: [],
    })
    expect(provider.appliedProfiles).toEqual([])
  })

  it('applies the dispatch-captured Web profile before intent and again immediately before send', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    const profile = { model: 'fixture-model', effort: 'high' }
    provider.turns.set('profile task', {
      conversationId: 'profile-conversation', userMessageId: 'profile-user', assistantMessageId: 'profile-assistant', response: 'profile result',
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, 'profile-command', 'profile task'), options([], profile))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })

    expect(provider.appliedProfiles).toEqual([
      { phase: 'prepare', profile },
      { phase: 'submit', profile },
    ])
    expect(provider.trace.indexOf('model-selection:submit')).toBeLessThan(provider.trace.indexOf('chatgpt-web-session-send'))
    expect(parent.session.events.find(event => event.type === 'chatgpt-web/intent')?.data).toMatchObject({ profile })
  })

  it('rejects an unavailable dispatch profile before intent, fill, or send', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.unavailableModels.add('unavailable-model')

    const run = await runCoordinatedWebSession(
      ctx,
      request(parent, 'unavailable-profile-command', 'unavailable profile task'),
      options([], { model: 'unavailable-model' }),
    )
    await expect(run.result).rejects.toMatchObject({ code: 'MODEL_SELECTION_UNAVAILABLE' })

    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-fill')
    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-send')
    expect(parent.session.events.some(event => event.type === 'chatgpt-web/intent')).toBe(false)
  })

  it('rejects a changed Web profile for the same completed execution id without another send', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.turns.set('profile reuse task', {
      conversationId: 'profile-reuse', userMessageId: 'profile-reuse-user', assistantMessageId: 'profile-reuse-assistant', response: 'profile reuse result',
    })
    const firstProfile = { model: 'fixture-model', effort: 'low' }

    await (await runCoordinatedWebSession(
      ctx,
      request(parent, 'profile-reused-command', 'profile reuse task'),
      options([], firstProfile),
    )).result
    const reused = await runCoordinatedWebSession(
      ctx,
      request(parent, 'profile-reused-command', 'profile reuse task'),
      options([], { model: 'fixture-model', effort: 'high' }),
    )
    await expect(reused.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_INDETERMINATE' })

    expect(provider.operations.filter(operation => operation.id === 'chatgpt-web-session-send')).toHaveLength(1)
    expect(provider.appliedProfiles).toEqual([
      { phase: 'prepare', profile: firstProfile },
      { phase: 'submit', profile: firstProfile },
    ])
  })

  it.each([
    ['a different lane', 'first task', 'other-lane'],
    ['a different rendered prompt', 'changed task', undefined],
  ] as const)('rejects reuse of a completed execution id with %s', async (_name, changedPrompt, changedLane) => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.turns.set('first task', {
      conversationId: 'reuse-conversation', userMessageId: 'reuse-user', assistantMessageId: 'reuse-assistant', response: 'original result',
    })
    await (await runCoordinatedWebSession(ctx, request(parent, 'reused-command', 'first task'), options())).result

    const reused = await runCoordinatedWebSession(ctx, request(parent, 'reused-command', changedPrompt, changedLane), options())
    await expect(reused.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_INDETERMINATE' })

    expect(provider.operations.filter(operation => operation.id === 'chatgpt-web-session-send')).toHaveLength(1)
    expect(parent.session.events.filter(event => event.type === 'chatgpt-web/intent')).toHaveLength(1)
  })

  it('resumes an accepted command by polling its exact native user message without a fill or send', async () => {
    const { ctx, provider } = await setup()
    const session = Session.create(SessionId('web-session-parent'))
    const parent = fakeParent(session)
    const commandId = 'resumed-command'
    const workspaceName = workspaceFor(String(parent.id), 'main')
    const prompt = 'resumed task'
    const profile = { model: 'fixture-model', effort: 'low' }
    session.append('chatgpt-web/intent', {
      commandId, parentId: String(parent.id), laneId: 'main', laneKey: `${String(parent.id)}:main`, workspaceName,
      promptSha256: createHash('sha256').update(prompt).digest('hex'), targetUrl: 'https://chatgpt.com/c/resumed', connectorName: 'DSH',
      baselineUserMessageIds: ['user-before-resume'],
      profile,
    }, { ignorable: true })
    session.append('chatgpt-web/accepted', {
      commandId, parentId: String(parent.id), laneId: 'main', laneKey: `${String(parent.id)}:main`, workspaceName,
      conversationId: 'resumed', conversationUrl: 'https://chatgpt.com/c/resumed', userMessageId: 'user-resumed', connectorName: 'DSH', requestIds: ['request-resumed'],
    }, { ignorable: true })
    provider.turns.set(prompt, {
      conversationId: 'resumed', userMessageId: 'user-resumed', assistantMessageId: 'assistant-resumed', response: 'resumed result',
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, commandId, prompt), options([], profile))
    await expect(run.result).resolves.toMatchObject({ output: [{ text: 'resumed result' }], stopReason: 'completed' })

    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-fill')
    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-send')
    expect(provider.appliedProfiles).toEqual([])
  })

  it('does not publish a transient mismatched poll observation to the MCP owner', async () => {
    const { ctx, provider } = await setup()
    const session = Session.create(SessionId('web-session-parent'))
    const parent = fakeParent(session)
    const commandId = 'mismatched-poll'
    const prompt = 'resume safely'
    const workspaceName = workspaceFor(String(parent.id), 'main')
    session.append('chatgpt-web/intent', {
      commandId, parentId: String(parent.id), laneId: 'main', laneKey: `${String(parent.id)}:main`, workspaceName,
      promptSha256: createHash('sha256').update(prompt).digest('hex'), targetUrl: 'https://chatgpt.com/c/owned', connectorName: 'DSH',
      baselineUserMessageIds: [],
    }, { ignorable: true })
    session.append('chatgpt-web/accepted', {
      commandId, parentId: String(parent.id), laneId: 'main', laneKey: `${String(parent.id)}:main`, workspaceName,
      conversationId: 'owned', conversationUrl: 'https://chatgpt.com/c/owned', userMessageId: 'user-owned', connectorName: 'DSH', requestIds: [],
    }, { ignorable: true })
    provider.pollOverrides.set('user-owned', {
      identity: 'exact', conversationId: 'foreign', conversationUrl: 'https://chatgpt.com/c/foreign', userMessageId: 'user-owned',
      requestIds: ['request-foreign'], model: 'fixture-model', generating: false, terminal: 'running',
    })
    const seen: CoordinatedWebSessionObservation[] = []

    const run = await runCoordinatedWebSession(ctx, request(parent, commandId, prompt), options(seen))
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_INDETERMINATE' })

    expect(seen).toEqual([])
  })

  it('does not create an accepted receipt or publish an unproven post-submit wrapper', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    const prompt = 'unproven submit wrapper'
    const seen: CoordinatedWebSessionObservation[] = []
    provider.afterSubmitOverrides.set(prompt, {
      status: 'accepted', phase: 'after-submit', observation: {
        identity: 'unproven', conversationId: 'foreign', conversationUrl: 'https://chatgpt.com/c/foreign', userMessageId: 'foreign-user',
        requestIds: ['request-foreign'], model: 'fixture-model', generating: false, terminal: 'running',
      },
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, 'unproven-submit-command', prompt), options(seen))
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_PROTOCOL' })

    expect(parent.session.events.some(event => event.type === 'chatgpt-web/accepted')).toBe(false)
    expect(seen).toEqual([])
  })

  it('does not accept a post-submit wrapper whose conversation URL names another native turn', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    const prompt = 'inconsistent submit wrapper'
    const seen: CoordinatedWebSessionObservation[] = []
    provider.afterSubmitOverrides.set(prompt, {
      status: 'accepted', phase: 'after-submit', observation: {
        identity: 'exact', conversationId: 'expected-conversation', conversationUrl: 'https://chatgpt.com/c/other-conversation', userMessageId: 'expected-user',
        requestIds: ['request-expected'], model: 'fixture-model', generating: false, terminal: 'running',
      },
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, 'inconsistent-submit-command', prompt), options(seen))
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_PROTOCOL' })

    expect(parent.session.events.some(event => event.type === 'chatgpt-web/accepted')).toBe(false)
    expect(seen).toEqual([])
  })

  it('does not create an accepted receipt or publish an unproven submission-proof wrapper', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    const prompt = 'unproven proof wrapper'
    const seen: CoordinatedWebSessionObservation[] = []
    provider.afterSubmitOverrides.set(prompt, {
      status: 'submission-pending', phase: 'after-submit', candidateUrl: 'https://chatgpt.com/c/proof-pending',
    })
    provider.submissionProofOverrides.set(prompt, {
      status: 'accepted', phase: 'submission-proof', observation: {
        identity: 'unproven', conversationId: 'foreign', conversationUrl: 'https://chatgpt.com/c/foreign', userMessageId: 'foreign-user',
        requestIds: ['request-foreign'], model: 'fixture-model', generating: false, terminal: 'running',
      },
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, 'unproven-proof-command', prompt), options(seen))
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_PROTOCOL' })

    expect(parent.session.events.some(event => event.type === 'chatgpt-web/accepted')).toBe(false)
    expect(seen).toEqual([])
  })

  it('drops a foreign pending candidate without opening a page or publishing ownership', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    const prompt = 'foreign candidate wrapper'
    const seen: CoordinatedWebSessionObservation[] = []
    provider.afterSubmitOverrides.set(prompt, {
      status: 'submission-pending', phase: 'after-submit', candidateUrl: 'https://example.invalid/c/foreign',
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, 'foreign-candidate-command', prompt), {
      ...options(seen), submissionTimeoutMs: 1,
    })
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_INDETERMINATE' })

    const sendIndex = provider.operations.findIndex(operation => operation.id === 'chatgpt-web-session-send')
    expect(sendIndex).toBeGreaterThanOrEqual(0)
    expect(provider.operations.slice(sendIndex + 1)).toEqual([])
    expect(provider.programs.some(program => program.source.includes("const phase = 'submission-proof'"))).toBe(false)
    expect(parent.session.events.some(event => event.type === 'chatgpt-web/accepted')).toBe(false)
    expect(seen).toEqual([])
  })

  it('continues one completed lane and isolates a fresh lane in a different named workspace', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.turns.set('first', {
      conversationId: 'lane-a', userMessageId: 'user-first', assistantMessageId: 'assistant-first', response: 'first answer',
    })
    provider.turns.set('follow up', {
      conversationId: 'lane-a', userMessageId: 'user-follow', assistantMessageId: 'assistant-follow', response: 'follow answer',
    })
    provider.turns.set('fresh lane', {
      conversationId: 'lane-b', userMessageId: 'user-fresh', assistantMessageId: 'assistant-fresh', response: 'fresh answer',
    })

    await (await runCoordinatedWebSession(ctx, request(parent, 'first-command', 'first', 'lane-a'), options())).result
    await (await runCoordinatedWebSession(ctx, request(parent, 'follow-command', 'follow up', 'lane-a'), options())).result
    await (await runCoordinatedWebSession(ctx, request(parent, 'fresh-command', 'fresh lane', 'lane-b'), options())).result

    const submits = provider.programs.filter(program => program.source.includes("id: 'chatgpt-web-session-fill'"))
      .map(serializedRequest)
    expect(submits).toHaveLength(3)
    expect(submits[1]).toMatchObject({
      url: 'https://chatgpt.com/c/lane-a',
      freshLane: false,
      previousTurn: { userMessageId: 'user-first', assistantMessageId: 'assistant-first' },
      workspaceName: workspaceFor(String(parent.id), 'lane-a'),
    })
    expect(submits[2]).toMatchObject({
      url: 'https://chatgpt.com/',
      freshLane: true,
      workspaceName: workspaceFor(String(parent.id), 'lane-b'),
    })
  })

  it('refuses a composer draft before creating a pre-send receipt, fill, or send', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.drafts.add('draft task')

    const run = await runCoordinatedWebSession(ctx, request(parent, 'draft-command', 'draft task'), options())
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_DRAFT_PRESENT' })

    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-fill')
    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-send')
    expect(parent.session.events.some(event => event.type === 'chatgpt-web/intent')).toBe(false)
  })

  it('requires a real attached connector before fill or send', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.missingConnectors.add('connector task')

    const run = await runCoordinatedWebSession(ctx, request(parent, 'connector-command', 'connector task'), options())
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_CONNECTOR_REQUIRED' })

    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-fill')
    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-send')
  })

  it('inspects but never resends a same command with only a durable pre-send intent', async () => {
    const { ctx, provider } = await setup()
    const session = Session.create(SessionId('web-session-parent'))
    const parent = fakeParent(session)
    const prompt = 'uncertain task'
    const commandId = 'uncertain-command'
    session.append('chatgpt-web/intent', {
      commandId, parentId: String(parent.id), laneId: 'main', laneKey: `${String(parent.id)}:main`,
      workspaceName: workspaceFor(String(parent.id), 'main'),
      promptSha256: createHash('sha256').update(prompt).digest('hex'), targetUrl: 'https://chatgpt.com/', connectorName: 'DSH',
      baselineUserMessageIds: [],
    }, { ignorable: true })

    const run = await runCoordinatedWebSession(ctx, request(parent, commandId, prompt), options())
    await expect(run.result).rejects.toMatchObject({ code: 'CHATGPT_WEB_INDETERMINATE' })

    expect(provider.operations.map(operation => operation.id)).toEqual(['chatgpt-web-session-select'])
    expect(provider.operations.map(operation => operation.id)).not.toContain('chatgpt-web-session-send')
  })

  it('waits for the MCP owner to settle accepted tool work before completing a visually final response', async () => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    provider.turns.set('tool task', {
      conversationId: 'tool-conversation', userMessageId: 'tool-user', assistantMessageId: 'tool-assistant', response: 'tool answer',
    })
    let finishChecks = 0
    const run = await runCoordinatedWebSession(ctx, request(parent, 'tool-command', 'tool task'), {
      ...options(),
      canFinish: () => {
        finishChecks += 1
        return finishChecks > 1
      },
    })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })

    expect(finishChecks).toBe(2)
    expect(provider.operations.filter(operation => operation.id === 'chatgpt-web-session-open')).toHaveLength(4)
  })

  it.each([
    ['stopped', 'aborted'],
    ['failed', 'error'],
  ] as const)('does not treat a %s native terminal state as completed and forwards only its exact request ids', async (terminal, stopReason) => {
    const { ctx, provider } = await setup()
    const parent = fakeParent()
    const seen: CoordinatedWebSessionObservation[] = []
    provider.turns.set(`task ${terminal}`, {
      conversationId: `conversation-${terminal}`,
      userMessageId: `user-${terminal}`,
      assistantMessageId: `assistant-${terminal}`,
      response: 'partial text',
      terminal,
      requestIds: [`request-${terminal}`],
    })

    const run = await runCoordinatedWebSession(ctx, request(parent, `command-${terminal}`, `task ${terminal}`), options(seen))
    await expect(run.result).resolves.toEqual(expect.objectContaining({ output: [], stopReason }))

    expect(seen).toContainEqual(expect.objectContaining({
      commandId: `command-${terminal}`,
      conversationId: `conversation-${terminal}`,
      userMessageId: `user-${terminal}`,
      requestIds: [`request-${terminal}`],
      terminal,
    }))
    expect(parent.session.events.some(event => event.type === 'chatgpt-web/completed')).toBe(false)
  })
})
