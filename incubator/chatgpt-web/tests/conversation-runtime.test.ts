import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  defaultWebPreferences,
  PreferencesStore,
  type WebPreferences,
} from '../src/preferences.js'
import {
  ConversationRuntime,
  type ConversationRuntimeOptions,
} from '../src/conversation-runtime.js'
import type { InsightStageOutcome } from '../src/insight-contract.js'
import type {
  StudioGraph,
  StudioRun,
  WorkflowStudioApi,
} from '@lisihao/dsh-solar-native-collaboration/studio-contracts'
import { StudioStore } from '../../native-collaboration/src/studio-store.js'
import type {
  StudioBoundPorts,
  StudioExternalPortRequest,
} from '../src/studio-provider.js'
import type { WebController } from '../src/controller.js'
import { WebRunStore, type WebRunRecord, type WebRunRequest } from '../src/store.js'

const PROVIDER = 'solar-chatgpt-web'
const SESSION_ID = 'runtime-session'
const roots: string[] = []

const fixtureGeminiSemantics = {
  submitSelector: '[data-fixture-submit]',
  promptReceiptSelector: '[data-fixture-receipt]',
  planReadyMarker: 'FIXTURE_PLAN_READY',
  researchStartSelector: '[data-fixture-research-start]',
  researchReportReadyMarker: 'FIXTURE_REPORT_READY',
  thinking: {
    triggerSelector: '[data-fixture-thinking-trigger]',
    optionSelector: '[data-fixture-thinking-option]',
    selectedSelector: '[data-fixture-thinking-selected]',
  },
} as const

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dsh-conversation-runtime-'))
  roots.push(value)
  return value
}

function webRecord(id: string, request: WebRunRequest, text: string): WebRunRecord {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return {
    formatVersion: 1,
    id,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    request,
    stage: 'completed',
    output: { text, markdown: text },
  }
}

function completion(
  request: Pick<StudioExternalPortRequest, 'resource' | 'requested'>,
  text: string,
  clarification?: { readonly brief?: string; readonly questions: readonly { readonly id: string; readonly text: string }[] },
): InsightStageOutcome {
  return {
    kind: 'complete',
    resource: { ...request.resource, remoteId: `remote:${request.resource.id}` },
    observed: { availability: 'not-exposed' },
    artifact: {
      text,
      provenance: {
        provider: request.requested.provider,
        source: `${request.requested.provider} fixture result`,
        visibleEvidence: ['fixture visible result'],
        citations: ['https://example.test/source'],
        limitations: ['Keyless fixture; no hidden reasoning retained.'],
      },
    },
    ...(clarification === undefined ? {} : { clarification }),
  }
}

function fixturePorts(calls: string[]): StudioBoundPorts {
  return {
    async clarify(request) {
      calls.push(`clarify:${request.phase}`)
      return completion(request, 'clarification brief', { brief: '完整研究简报', questions: [] })
    },
    async askQuestions() {
      calls.push('questions')
      return { kind: 'pending' }
    },
    async confirmPlan(request) {
      calls.push(`confirm:${request.phase}`)
      return { kind: 'confirmed' }
    },
    async execute(request) {
      calls.push(`execute:${request.phase}`)
      return completion(request, `${request.phase} fixture artifact`)
    },
    async observe(request) {
      calls.push(`observe:${request.phase}`)
      return completion(request, `${request.phase} observed fixture artifact`)
    },
    async finished(runId) {
      calls.push(`finished:${runId}`)
    },
  }
}

function request(model: string, reasoningEffort?: string): GenerateOptions {
  return {
    provider: PROVIDER,
    model,
    sessionId: SESSION_ID as GenerateOptions['sessionId'],
    messages: [{
      id: 'runtime-user-1' as never,
      role: 'user',
      source: { kind: 'user' },
      content: [{ type: 'text', text: '请完整保留上下文并用 Markdown 回答。' }],
    }],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort: reasoningEffort as never }),
  }
}

function preferencesWithUnconfiguredThinking(): WebPreferences {
  const preferences = defaultWebPreferences()
  return {
    ...preferences,
    insight: {
      ...preferences.insight,
      polish: {
        ...preferences.insight.polish,
        requested: { ...preferences.insight.polish.requested, effortLabel: 'medium' },
      },
    },
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

interface Fixture {
  readonly runtime: ConversationRuntime
  readonly preferences: PreferencesStore
  readonly controller: WebControllerLike
  readonly captures: Array<{ readonly id: string; readonly graph: StudioGraph; readonly runId?: string; readonly run?: StudioRun }>
  readonly browserEvents: string[]
  readonly logs: string[]
  readonly portCalls: string[]
  readonly deliveryCalls: string[]
  setDelivery(value: string | undefined): void
}

type RuntimeStudio = WorkflowStudioApi & {
  resolveDelivery(sessionId: string, text: string): Promise<string | undefined>
}

type WebControllerLike = Pick<WebController, 'start' | 'observe'> & {
  readonly start: ReturnType<typeof vi.fn>
  readonly observe: ReturnType<typeof vi.fn>
}

async function fixture(overrides: Partial<{
  stateRoot: string
  preferences: WebPreferences
  controller: WebControllerLike
  ports: StudioBoundPorts
  studio: RuntimeStudio
}> = {}): Promise<Fixture> {
  const stateRoot = overrides.stateRoot ?? await root()
  const preferenceRoot = join(stateRoot, 'preferences')
  const preferences = new PreferencesStore(preferenceRoot, overrides.preferences ?? {
    ...defaultWebPreferences(),
    geminiSemantics: fixtureGeminiSemantics,
  })
  const browserEvents: string[] = []
  const logs: string[] = []
  const captures: Array<{ readonly id: string; readonly graph: StudioGraph; readonly runId?: string; readonly run?: StudioRun }> = []
  const portCalls: string[] = []
  const deliveryCalls: string[] = []
  let delivery: string | undefined
  const controller = overrides.controller ?? {
    start: vi.fn(async (id: string, webRequest: WebRunRequest) => {
      browserEvents.push('start')
      return webRecord(id, webRequest, '普通网页完整回答')
    }),
    observe: vi.fn(async (id: string) => {
      browserEvents.push('observe')
      return webRecord(id, { prompt: 'observed' }, '观察到的普通网页回答')
    }),
  } as WebControllerLike
  const studio: RuntimeStudio = overrides.studio ?? {
    register: () => () => undefined,
    capture: async input => {
      browserEvents.push('capture')
      captures.push(input)
      return { ...input, capturedAt: '2026-10-20T00:00:00.000Z' }
    },
    resolveDelivery: async (sessionId, text) => {
      deliveryCalls.push(`${sessionId}:${text}`)
      return delivery
    },
  }
  const options: ConversationRuntimeOptions = {
    root: stateRoot,
    preferences,
    controller,
    studio: () => studio,
    ports: overrides.ports ?? fixturePorts(portCalls),
    logRequest: async (_sessionId, text) => { logs.push(text) },
    pollMs: 1,
  }
  return {
    runtime: new ConversationRuntime(options),
    preferences,
    controller,
    captures,
    browserEvents,
    logs,
    portCalls,
    deliveryCalls,
    setDelivery(value) { delivery = value },
  }
}

describe('ConversationRuntime', () => {
  it('advertises ordinary Web and Insight models through the public provider', async () => {
    const value = await fixture()
    const models = await value.runtime.listModels(PROVIDER)
    expect(models.map(model => model.id)).toEqual(['chatgpt-web', 'insight-analysis'])
    expect(models.map(model => model.name)).toEqual(['ChatGPT 网页算子', '洞察分析'])
  })

  it('captures the exact ordinary prompt before browser admission and captures its completed output', async () => {
    const value = await fixture()
    const chunks = await collect(value.runtime.stream(request('chatgpt-web')))
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: '普通网页完整回答' })
    expect(value.browserEvents.slice(0, 2)).toEqual(['capture', 'start'])
    const source = value.captures.find(capture => capture.run?.status === 'pending')
    expect(source?.graph.providerId).toBe('web')
    expect(source?.graph.metadata.question).toContain('solar-chatgpt-web conversation')
    expect(source?.graph.nodes[0]?.prompt).toBe(source?.graph.metadata.question)
    expect(source?.graph.nodes[0]?.parameters.requested).toEqual({ provider: 'chatgpt', modelLabel: '' })
    const browserRequest = value.controller.start.mock.calls[0]?.[1] as WebRunRequest | undefined
    expect(browserRequest?.modelLabel).toBeUndefined()
    expect(browserRequest?.effortLabel).toBeUndefined()
    const completed = value.captures.find(capture => capture.run?.status === 'completed')
    expect(completed?.run?.output).toBe('普通网页完整回答')
    expect(value.logs.some(text => text.includes('web-request'))).toBe(true)
  })

  it('retains the prepared Web model and effort after preferences change', async () => {
    const value = await fixture({ preferences: {
      ...defaultWebPreferences(),
      web: { modelLabel: 'GPT-6', effortLabel: 'medium' },
    } })
    const prepared = await value.runtime.prepareCall(PROVIDER, 'chatgpt-web')
    expect(prepared.model.reasoning?.defaultEffort).toBe('medium')
    const current = await value.preferences.read()
    await value.preferences.save({
      ...current,
      web: { modelLabel: 'GPT-6.1 Sol', effortLabel: 'high' },
    }, current.revision)
    await collect(prepared.stream(request('chatgpt-web', 'medium')))
    const browserRequest = value.controller.start.mock.calls[0]?.[1] as WebRunRequest | undefined
    expect(browserRequest?.modelLabel).toBe('GPT-6')
    expect(browserRequest?.effortLabel).toBe('medium')
  })

  it('returns a completed durable delivery without browser or Studio port execution', async () => {
    const value = await fixture()
    value.setDelivery('# 已完成流程结果')
    const chunks = await collect(value.runtime.stream(request('chatgpt-web')))
    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: '# 已完成流程结果' })
    expect(value.controller.start).not.toHaveBeenCalled()
    expect(value.portCalls).toEqual([])
    expect(value.captures).toEqual([])
  })

  it('rejects Insight before any port, browser, log, or capture effect when an unobserved thinking mapping is requested', async () => {
    const value = await fixture({ preferences: preferencesWithUnconfiguredThinking() })
    let failure: unknown
    try {
      await collect(value.runtime.stream(request('insight-analysis')))
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'INSIGHT_NOT_CONFIGURED' })
    expect((failure as Error).message).toContain('本次不会启动前序模型调用')
    expect(value.portCalls).toEqual([])
    expect(value.controller.start).not.toHaveBeenCalled()
    expect(value.controller.observe).not.toHaveBeenCalled()
    expect(value.logs).toEqual([])
    expect(value.captures).toEqual([])
  })

  it('reports the complete Insight entry gate before model resolution when an unobserved thinking mapping is requested', async () => {
    const value = await fixture({ preferences: preferencesWithUnconfiguredThinking() })

    await expect(value.runtime.resolveModel(PROVIDER, 'insight-analysis')).rejects.toMatchObject({
      code: 'INSIGHT_NOT_CONFIGURED',
      message: expect.stringContaining('完整洞察流程尚不能启动'),
    })
    expect(value.portCalls).toEqual([])
    expect(value.controller.start).not.toHaveBeenCalled()
    expect(value.controller.observe).not.toHaveBeenCalled()
    expect(value.logs).toEqual([])
    expect(value.captures).toEqual([])
  })

  it('runs the Insight graph with complete keyless ports and captures the real graph and completed run', async () => {
    const value = await fixture()
    const chunks = await collect(value.runtime.stream(request('insight-analysis')))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(chunks.find(chunk => chunk.type === 'text-delta' && chunk.text.includes('fixture artifact'))).toBeDefined()
    expect(value.controller.start).not.toHaveBeenCalled()
    expect(value.portCalls).toContain('clarify:clarify')
    expect(value.portCalls).toContain('execute:plan')
    expect(value.portCalls).toContain('execute:research')
    expect(value.portCalls).toContain('execute:review')
    expect(value.portCalls).toContain('execute:thinking')
    expect(value.portCalls).not.toContain('questions')
    const source = value.captures.find(capture => capture.graph.providerId === 'insight' && capture.run?.status === 'pending')
    expect(source?.graph.sessionId).toBe(SESSION_ID)
    expect(source?.graph.nodes.map(node => node.id)).toEqual([
      'clarify', 'gemini-research', 'chatgpt-review', 'gemini-thinking', 'output',
    ])
    const completed = value.captures.find(capture => capture.graph.providerId === 'insight' && capture.run?.status === 'completed')
    expect(completed?.run?.output).toContain('fixture artifact')
  })

  it('keeps a deferred Web source fenced from a fork until the original completes', async () => {
    const studioRoot = await root()
    const store = new StudioStore(join(studioRoot, 'workflow-studio'))
    const browserStarts: string[] = []
    let resolveStart: ((record: WebRunRecord) => void) | undefined
    const controller: WebControllerLike = {
      start: vi.fn((id: string, webRequest: WebRunRequest) => new Promise<WebRunRecord>(resolve => {
        browserStarts.push('start')
        resolveStart = () => resolve(webRecord(id, webRequest, '原会话完成产物'))
      })),
      observe: vi.fn(async (id: string) => webRecord(id, { prompt: 'observed' }, '观察到的普通网页回答')),
    }
    const value = await fixture({
      controller,
      studio: {
        register: () => () => undefined,
        capture: input => store.capture(input),
        resolveDelivery: async () => undefined,
      },
    })

    const streamPromise = collect(value.runtime.stream(request('chatgpt-web')))
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    const source = (await store.listSources(SESSION_ID))[0]
    expect(source).toBeDefined()
    expect(source?.run?.status).toBe('pending')

    const draft = await store.saveDraft({
      sessionId: SESSION_ID,
      id: '11111111-1111-4111-8111-111111111111',
      expectedRevision: 0,
      graph: source!.graph,
      sourceId: source!.id,
    })
    await expect(store.createRunIntent({
      sessionId: SESSION_ID,
      draftId: draft.id,
      expectedRevision: draft.revision,
      commandId: '22222222-2222-4222-8222-222222222222',
    })).rejects.toMatchObject({ code: 'STUDIO_RESOURCE_COORDINATION_REQUIRED' })
    expect(browserStarts).toEqual(['start'])

    resolveStart?.(webRecord(
      controller.start.mock.calls[0]?.[0] as string,
      controller.start.mock.calls[0]?.[1] as WebRunRequest,
      '原会话完成产物',
    ))
    const chunks = await streamPromise
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: '原会话完成产物' })

    const completed = await store.readSource(SESSION_ID, source!.id)
    expect(completed?.run?.status).toBe('completed')
    expect(completed?.run?.output).toBe('原会话完成产物')
    const afterCompletion = await store.createRunIntent({
      sessionId: SESSION_ID,
      draftId: draft.id,
      expectedRevision: draft.revision,
      commandId: '33333333-3333-4333-8333-333333333333',
    })
    expect(afterCompletion.created).toBe(true)
    expect(browserStarts).toEqual(['start'])
  })

  it('persists an unknown source fence when external Web start throws', async () => {
    const studioRoot = await root()
    const store = new StudioStore(join(studioRoot, 'workflow-studio'))
    const browserStarts: string[] = []
    const controller: WebControllerLike = {
      start: vi.fn(async () => {
        browserStarts.push('start')
        throw new Error('fixture external start outcome is unknown')
      }),
      observe: vi.fn(async (id: string) => webRecord(id, { prompt: 'observed' }, '观察到的普通网页回答')),
    }
    const value = await fixture({
      controller,
      studio: {
        register: () => () => undefined,
        capture: input => store.capture(input),
        resolveDelivery: async () => undefined,
      },
    })

    await expect(collect(value.runtime.stream(request('chatgpt-web')))).rejects.toMatchObject({ code: 'WEB_CONTROLLER_ERROR' })
    expect(browserStarts).toEqual(['start'])
    const source = (await store.listSources(SESSION_ID))[0]
    expect(source).toBeDefined()
    expect(source?.run?.status).toBe('unknown')
    expect(source?.run?.message).toContain('原执行结果待核对；未重新提交。')

    const draft = await store.saveDraft({
      sessionId: SESSION_ID,
      id: '44444444-4444-4444-8444-444444444444',
      expectedRevision: 0,
      graph: source!.graph,
      sourceId: source!.id,
    })
    await expect(store.createRunIntent({
      sessionId: SESSION_ID,
      draftId: draft.id,
      expectedRevision: draft.revision,
      commandId: '55555555-5555-4555-8555-555555555555',
    })).rejects.toMatchObject({ code: 'STUDIO_RESOURCE_COORDINATION_REQUIRED' })
    expect(browserStarts).toEqual(['start'])
  })

  it('resumes an existing raw Web receipt by observing the exact id without starting another run', async () => {
    const stateRoot = await root()
    const rawStore = new WebRunStore(stateRoot)
    const runId = '66666666-6666-4666-8666-666666666666'
    const rawRequest: WebRunRequest = { prompt: 'persisted unknown request', modelLabel: 'GPT-6', effortLabel: 'medium' }
    const prepared = await rawStore.create(runId, rawRequest)
    await rawStore.transition(runId, prepared.revision, {
      stage: 'submission-unknown',
      error: { code: 'WEB_SUBMISSION_UNKNOWN', message: 'fixture receipt requires observation' },
    })
    const observed = vi.fn(async (id: string) => webRecord(id, rawRequest, '恢复后的完整回答'))
    const controller: WebControllerLike = {
      start: vi.fn(async () => {
        throw new Error('resume must not start a new Web run')
      }),
      observe: observed,
    }
    const value = await fixture({ stateRoot, controller })

    const resumed = await value.runtime.webProvider.resume?.(SESSION_ID, runId)
    expect(resumed).toMatchObject({
      id: runId,
      sessionId: SESSION_ID,
      providerId: 'web',
      status: 'completed',
      output: '恢复后的完整回答',
    })
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed).toHaveBeenCalledWith(runId)
    expect(controller.start).not.toHaveBeenCalled()
    expect(value.portCalls).toEqual([])
    expect(value.logs).toEqual([])
    expect(value.captures).toEqual([])
  })

  it('rejects Web source resume while the original conversation is waiting, then releases the same identity', async () => {
    let resolveStart: ((record: WebRunRecord) => void) | undefined
    const controller: WebControllerLike = {
      start: vi.fn((id: string, webRequest: WebRunRequest) => new Promise<WebRunRecord>(resolve => {
        resolveStart = () => resolve(webRecord(id, webRequest, '等待后的网页回答'))
      })),
      observe: vi.fn(async (id: string) => webRecord(id, { prompt: 'observed' }, '观察到的普通网页回答')),
    }
    const value = await fixture({ controller })
    const streamPromise = collect(value.runtime.stream(request('chatgpt-web')))
    await vi.waitFor(() => expect(controller.start).toHaveBeenCalledTimes(1))
    const source = value.captures.find(capture => capture.run?.status === 'pending')
    expect(source?.id).toBeDefined()
    await expect(value.runtime.webProvider.assertCanResume!(SESSION_ID, source!.id))
      .rejects.toMatchObject({ message: expect.stringContaining('STUDIO_CONVERSATION_ACTIVE') })
    expect(controller.start).toHaveBeenCalledTimes(1)
    expect(value.deliveryCalls).toHaveLength(1)

    resolveStart?.(webRecord(
      controller.start.mock.calls[0]?.[0] as string,
      controller.start.mock.calls[0]?.[1] as WebRunRequest,
      '等待后的网页回答',
    ))
    await streamPromise
    await expect(value.runtime.webProvider.assertCanResume!(SESSION_ID, source!.id)).resolves.toBeUndefined()
    expect(controller.start).toHaveBeenCalledTimes(1)
    expect(value.deliveryCalls).toHaveLength(1)
    expect(value.portCalls).toEqual([])
  })

  it('keeps Insight source resume fenced through polling and releases it after completion', async () => {
    const portCalls: string[] = []
    let finishResearch: (() => void) | undefined
    const execute = vi.fn(async (portRequest: StudioExternalPortRequest): Promise<InsightStageOutcome> => {
      portCalls.push(`execute:${portRequest.phase}`)
      if (portRequest.phase === 'research') {
        return new Promise<InsightStageOutcome>(resolve => {
          finishResearch = () => resolve(completion(portRequest, 'research waited fixture artifact'))
        })
      }
      return completion(portRequest, `${portRequest.phase} fixture artifact`)
    })
    const basePorts = fixturePorts(portCalls)
    const value = await fixture({ ports: { ...basePorts, execute } })
    const streamPromise = collect(value.runtime.stream(request('insight-analysis')))
    await vi.waitFor(() => expect(execute).toHaveBeenCalledWith(expect.objectContaining({ phase: 'research' })))
    const source = value.captures.find(capture => capture.graph.providerId === 'insight' && capture.run?.status === 'pending')
    expect(source?.id).toBeDefined()
    await expect(value.runtime.insightProvider.assertCanResume!(SESSION_ID, source!.id))
      .rejects.toMatchObject({ message: expect.stringContaining('STUDIO_CONVERSATION_ACTIVE') })
    const executeCallsWhileWaiting = execute.mock.calls.length
    expect(value.deliveryCalls).toHaveLength(1)

    finishResearch?.()
    await streamPromise
    await expect(value.runtime.insightProvider.assertCanResume!(SESSION_ID, source!.id)).resolves.toBeUndefined()
    expect(execute.mock.calls.length).toBeGreaterThan(executeCallsWhileWaiting)
    const executeCallsAfterCompletion = execute.mock.calls.length
    await expect(value.runtime.insightProvider.assertCanResume!(SESSION_ID, source!.id)).resolves.toBeUndefined()
    expect(execute.mock.calls.length).toBe(executeCallsAfterCompletion)
    expect(value.deliveryCalls).toHaveLength(1)
  })
})
