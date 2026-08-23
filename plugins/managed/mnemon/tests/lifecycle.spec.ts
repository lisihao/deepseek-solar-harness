import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import type {
  CreateHostAgentOptions,
  HostAgent,
  HostAgentContext,
  HostContextShape,
  HostPreStepDecision,
  HostSessionEvent,
  HostUserMessage,
} from '../src/contracts.ts'
import { MnemonLifecycle } from '../src/lifecycle.ts'
import type { MnemonService } from '../src/service.ts'
import type { MnemonSubagentCoordinator } from '../src/subagent.ts'

type Listener = (...args: unknown[]) => unknown

function userMessage(text = 'Continue the project'): HostUserMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function fixture(config = resolveConfig({ cliPath: '/fake/mnemon' }), options: { taskModelRoute?: boolean } = {}) {
  const agentListeners = new Map<string, Listener>()
  const rootListeners = new Map<string, Listener>()
  const events: HostSessionEvent[] = []
  const followup = vi.fn()
  const steer = vi.fn()
  const taskAgents: HostAgent[] = []
  const disposedTaskAgents: string[] = []
  const taskModelRoute = options.taskModelRoute !== false
  const defaultModel = { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) }
  const llm = {
    listProviders: vi.fn(() => [
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' },
    ]),
    listModels: vi.fn(async (provider: string): Promise<Array<{ id: string; name: string; description?: string; inputModalities?: readonly string[] }>> => provider === 'openai'
      ? [{ id: 'gpt-5', name: 'GPT-5', description: 'General reasoning' }]
      : [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]),
  }
  const agentPresets = {
    resolve: vi.fn(async () => ({ id: 'default' })),
    mount: vi.fn(async () => ({ id: 'default' })),
  }
  const agentCtx = {
    on: vi.fn((name: string, listener: Listener) => {
      agentListeners.set(name, listener)
      return () => agentListeners.delete(name)
    }),
    effect: vi.fn((callback: () => (() => unknown) | void) => {
      const cleanup = callback()
      return () => cleanup?.()
    }),
  } as unknown as HostAgentContext
  const agent = {
    id: 'session-1',
    status: 'idle',
    ...(taskModelRoute ? { options: { provider: 'deepseek', model: 'deepseek-chat' } } : {}),
    session: { events },
    ctx: agentCtx,
    followup,
    steer,
    inject: vi.fn(),
  } satisfies HostAgent
  const service = {
    status: vi.fn(async () => ({
      healthy: true,
      store: 'project',
      stats: { totalInsights: 12, edgeCount: 8 },
      memoryBodies: [{ id: 'project', name: 'Project', description: 'Project context', active: true }],
    })),
  } as unknown as MnemonService
  const coordinator = {
    recall: vi.fn(async (_agent, request) => ({ query: request.query, mode: 'smart', results: [], delegation: { runId: 'recall-child', provider: 'spawn', summary: '', selectedMemoryBodyIds: [] } })),
    write: vi.fn(async () => ({ delegated: true, runId: 'write-child', provider: 'spawn', summary: 'No durable memory', action: 'skipped', memoryBodyIds: [] })),
    answer: vi.fn(async () => ({ answer: 'SQLite.', citations: [], delegation: { runId: 'answer-child', provider: 'spawn' } })),
    review: vi.fn(async () => ({ delegated: true, runId: 'review-child', provider: 'fork', summary: 'No durable change', action: 'skipped', memoryBodyIds: [] })),
    maintainMetadata: vi.fn(async () => ({ delegated: true, runId: 'metadata-child', provider: 'spawn', summary: 'updated', updates: [] })),
    archiveDocument: vi.fn(async () => ({ success: true, action: 'archived', document: { id: 'doc-1' } })),
    snapshot: vi.fn(() => ({ recalls: 0, writes: 0, answers: 0, reviews: 0, failures: 0 })),
  } as unknown as MnemonSubagentCoordinator
  const createTaskAgent = vi.fn(async (options: CreateHostAgentOptions) => {
    const taskCtx = {
      on: vi.fn(() => () => undefined),
      effect: vi.fn((callback: () => (() => unknown) | void) => {
        const cleanup = callback()
        return () => cleanup?.()
      }),
    } as unknown as HostAgentContext
    await options.setup?.(taskCtx)
    const taskAgent = {
      id: options.sessionId,
      status: 'idle' as const,
      ...(options.agentOptions === undefined ? {} : { options: options.agentOptions }),
      session: { header: options.meta ?? {}, events: [] },
      ctx: taskCtx,
      followup: vi.fn(),
      steer: vi.fn(),
      inject: vi.fn(),
    } satisfies HostAgent
    taskAgents.push(taskAgent)
    rootListeners.get('agent/created')?.({ agent: taskAgent })
    return {
      agent: taskAgent,
      dispose: vi.fn(async () => {
        disposedTaskAgents.push(taskAgent.id)
        const index = taskAgents.indexOf(taskAgent)
        if (index >= 0) taskAgents.splice(index, 1)
      }),
    }
  })
  const ctx = {
    agents: { get: (id: string) => id === agent.id ? agent : taskAgents.find(candidate => candidate.id === id), roots: () => [agent, ...taskAgents], create: createTaskAgent },
    get: vi.fn((name: string) => name === 'agentDefaultModel' && taskModelRoute
      ? defaultModel
      : name === 'agentPresets'
        ? agentPresets
        : name === 'llm'
          ? llm
          : undefined),
    on: vi.fn((name: string, listener: Listener) => {
      rootListeners.set(name, listener)
      return () => rootListeners.delete(name)
    }),
  } as unknown as HostContextShape
  const lifecycle = new MnemonLifecycle(ctx, coordinator, config)
  const stop = lifecycle.start()

  const preStep = async (messages: HostUserMessage[], turn: number, step = 1): Promise<HostPreStepDecision> => {
    const listener = agentListeners.get('agent/pre-step')
    if (listener === undefined) throw new Error('pre-step listener missing')
    return await listener({ agent, messages, turn, step, signal: new AbortController().signal }, async () => ({ kind: 'enter', messages })) as HostPreStepDecision
  }
  const turnStopping = async (turn: number) => {
    const listener = agentListeners.get('agent/turn-stopping')
    if (listener === undefined) throw new Error('turn-stopping listener missing')
    await listener({ agent, turn, signal: new AbortController().signal })
  }
  return { agent, agentListeners, events, followup, steer, lifecycle, service, coordinator, createTaskAgent, disposedTaskAgents, defaultModel, llm, agentPresets, preStep, turnStopping, stop }
}

afterEach(() => vi.useRealTimers())

describe('Mnemon DSH lifecycle integration', () => {
  it('offers an active root Agent to standalone WebUI maintenance when no session is selected', () => {
    const value = fixture()

    expect(value.lifecycle.snapshot()).toMatchObject({
      activeAgents: 1,
      sessionAvailable: true,
      taskAgentAvailable: true,
      current: { sessionId: 'session-1' },
    })
    expect(value.lifecycle.snapshot('missing-session')).toMatchObject({
      sessionAvailable: true,
      current: { sessionId: 'session-1' },
    })
  })

  it('does not advertise task Agent actions when creation has no usable model route', async () => {
    const value = fixture(resolveConfig({ cliPath: '/fake/mnemon' }), { taskModelRoute: false })

    expect(value.lifecycle.snapshot()).toMatchObject({ sessionAvailable: true, taskAgentAvailable: false })
    await expect(value.lifecycle.maintainMetadata('', ['project'], '/tmp/workspace-two')).rejects.toThrow('no default provider/model')
    expect(value.createTaskAgent).not.toHaveBeenCalled()
  })

  it('runs standalone maintenance under a disposable clean root Agent scoped to the selected workspace', async () => {
    const value = fixture()

    await value.lifecycle.maintainMetadata('', ['project'], '/tmp/workspace-two')
    await value.lifecycle.archiveDocument('', 'doc-1', '/tmp/workspace-two')

    expect(value.createTaskAgent).toHaveBeenCalledTimes(2)
    expect(value.createTaskAgent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: expect.any(String),
      meta: { cwd: '/tmp/workspace-two', agentPreset: 'default' },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
      setup: expect.any(Function),
      signal: expect.any(AbortSignal),
    }))
    const metadataAgent = vi.mocked(value.coordinator.maintainMetadata).mock.calls[0]?.[0] as HostAgent
    expect(metadataAgent).not.toBe(value.agent)
    expect(metadataAgent.session.header?.cwd).toBe('/tmp/workspace-two')
    expect(value.coordinator.archiveDocument).toHaveBeenCalledWith(expect.objectContaining({ session: { header: { cwd: '/tmp/workspace-two', agentPreset: 'default' }, events: [] } }), 'doc-1', expect.any(AbortSignal))
    expect(value.defaultModel.currentSelection).toHaveBeenCalledTimes(2)
    expect(value.agentPresets.resolve).toHaveBeenCalledTimes(2)
    expect(value.agentPresets.mount).toHaveBeenCalledTimes(2)
    expect(value.disposedTaskAgents).toHaveLength(2)
    expect(value.lifecycle.snapshot()).toMatchObject({ activeAgents: 1, taskAgentAvailable: true })
  })

  it('uses a fixed Provider and model for independent task Agents when configured', async () => {
    const value = fixture(resolveConfig({
      cliPath: '/fake/mnemon',
      taskAgentModel: { mode: 'fixed', provider: 'openai', model: 'gpt-5' },
    }))

    await value.lifecycle.maintainMetadata('', ['project'], '/tmp/workspace-two')

    expect(value.createTaskAgent).toHaveBeenCalledWith(expect.objectContaining({
      agentOptions: { provider: 'openai', model: 'gpt-5', maxTokens: undefined },
    }))
    expect(value.defaultModel.currentSelection).not.toHaveBeenCalled()
  })

  it('lists model Providers concurrently and reports the effective independent task route', async () => {
    const value = fixture()

    await expect(value.lifecycle.taskAgentModels()).resolves.toEqual({
      effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' },
      defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
      groups: [
        { id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }] },
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5', name: 'GPT-5', description: 'General reasoning' }] },
      ],
      failures: [],
    })
    expect(value.llm.listModels).toHaveBeenCalledTimes(2)
  })

  it('preserves first-party model modality metadata in the task Agent catalog', async () => {
    const value = fixture()
    value.llm.listProviders.mockReturnValue([{ id: 'deepseek-official', name: 'DeepSeek' }])
    value.llm.listModels.mockResolvedValue([{
      id: 'deepseek-v4-flash-vision-exp',
      name: 'DeepSeek-V4-Flash-Vision-Exp',
      inputModalities: ['text', 'image'],
    }])

    await expect(value.lifecycle.taskAgentModels()).resolves.toMatchObject({
      groups: [{
        id: 'deepseek-official',
        models: [{
          id: 'deepseek-v4-flash-vision-exp',
          inputModalities: ['text', 'image'],
        }],
      }],
    })
  })

  it('resolves the inherited task route without loading the full model directory', async () => {
    const value = fixture()

    await expect(value.lifecycle.taskAgentModels(false)).resolves.toEqual({
      effective: { provider: 'deepseek', model: 'deepseek-chat', source: 'dsh-default' },
      defaultSelection: { provider: 'deepseek', model: 'deepseek-chat' },
      groups: [],
      failures: [],
    })
    expect(value.llm.listProviders).not.toHaveBeenCalled()
    expect(value.llm.listModels).not.toHaveBeenCalled()
  })

  it('isolates a stalled Provider while keeping the rest of the model catalog usable', async () => {
    vi.useFakeTimers()
    const value = fixture()
    value.llm.listModels.mockImplementation(async provider => provider === 'openai'
      ? await new Promise<never>(() => {})
      : [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }])

    const pending = value.lifecycle.taskAgentModels()
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(pending).resolves.toMatchObject({
      groups: [{ id: 'deepseek', models: [{ id: 'deepseek-chat' }] }],
      failures: [{ id: 'openai', message: 'model directory timed out after 3 seconds' }],
    })
  })

  it('runs Agent Query synthesis under a disposable clean root Agent', async () => {
    const value = fixture()

    await value.lifecycle.answerTask('', 'Which database?', [], '/tmp/workspace-two')

    expect(value.createTaskAgent).toHaveBeenCalledWith(expect.objectContaining({
      meta: { cwd: '/tmp/workspace-two', agentPreset: 'default' },
      agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
    }))
    expect(value.coordinator.answer).toHaveBeenCalledWith(expect.objectContaining({
      options: { provider: 'deepseek', model: 'deepseek-chat' },
      session: expect.objectContaining({ header: expect.objectContaining({ cwd: '/tmp/workspace-two' }) }),
    }), 'Which database?', [], expect.any(AbortSignal))
    expect(value.disposedTaskAgents).toHaveLength(1)
  })

  it('adds a short optional reminder without forcing recall or remember for an ordinary turn', async () => {
    const value = fixture()
    const prompt = userMessage('Aster 发布前需要检查哪些事项？')
    const decision = await value.preStep([prompt], 1)

    expect(decision).toMatchObject({ kind: 'enter' })
    if (decision.kind !== 'enter') throw new Error('unexpected rejection')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[1]?.source).toMatchObject({ kind: 'plugin', plugin: 'dsh-mnemon', form: 'instructions' })
    expect(decision.messages[1]?.content[0]?.text).toBe('[MNEMON] Search active Documents for substantial project knowledge before deep recall; call mnemon_recall only when durable history or an exact prior detail matters, and use mnemon_runtime_memory only for new explicit reusable facts. Otherwise call none.')
    expect(value.coordinator.recall).not.toHaveBeenCalled()
    expect(value.service.status).not.toHaveBeenCalled()

    const second = await value.preStep([userMessage('Second turn')], 2)
    if (second.kind !== 'enter') throw new Error('unexpected rejection')
    expect(second.messages).toHaveLength(2)
    expect(value.coordinator.recall).not.toHaveBeenCalled()
    expect(value.lifecycle.snapshot('session-1').counters).toMatchObject({ primes: 1, recallCues: 2, writebackCues: 2 })
  })

  it('keeps durable image references intact while scoring only text from a multimodal prompt', async () => {
    const value = fixture()
    const prompt: HostUserMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: [
        {
          type: 'image',
          attachment: {
            attachmentId: 'image:sha256:fixture',
            mediaType: 'image/png',
            bytes: 128,
            width: 16,
            height: 8,
            name: 'architecture.png',
          },
        },
        { type: 'text', text: 'Inspect this diagram.' },
      ],
      source: { kind: 'user' },
    }

    const decision = await value.preStep([prompt], 1)
    await value.turnStopping(1)

    if (decision.kind !== 'enter') throw new Error('unexpected rejection')
    expect(decision.messages[0]).toBe(prompt)
    expect(decision.messages[0]?.content[0]).toEqual(prompt.content[0])
    expect(value.lifecycle.snapshot('session-1').current?.reviewActivity).toMatchObject({
      totalUserTextLength: 'Inspect this diagram.'.length,
      turnCount: 1,
    })
  })

  it('waits for the QoderWork score threshold, then debounces a full-checkpoint review', async () => {
    vi.useFakeTimers()
    const value = fixture(resolveConfig({ idleReviewMs: 5_000 }))
    await value.preStep([userMessage('x'.repeat(150))], 1)
    value.events.push({ type: 'turn/end', data: { turn: 1 } })
    await value.turnStopping(1)

    expect(value.coordinator.review).not.toHaveBeenCalled()
    expect(value.lifecycle.snapshot('session-1').current).toMatchObject({
      idleReviewPending: false,
      reviewActivity: { score: 4, threshold: 5, eligible: false, totalUserTextLength: 150, turnCount: 1 },
    })

    await value.preStep([userMessage('one more turn')], 2)
    value.events.push({ type: 'turn/end', data: { turn: 2 } })
    await value.turnStopping(2)

    expect(value.coordinator.review).not.toHaveBeenCalled()
    expect(value.lifecycle.snapshot('session-1').current).toMatchObject({
      idleReviewPending: true,
      reviewRunning: false,
      reviewActivity: { score: 5, threshold: 5, eligible: true, turnCount: 2 },
    })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(value.coordinator.review).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(value.coordinator.review).toHaveBeenCalledWith(value.agent, expect.any(AbortSignal))
    expect(value.coordinator.write).not.toHaveBeenCalled()
    expect(value.lifecycle.snapshot('session-1').current).toMatchObject({
      idleReviewPending: false,
      lastReviewAction: 'skipped',
      lastReviewScore: 5,
      reviewActivity: { score: 0, eligible: false, turnCount: 0 },
    })
  })

  it('cancels a pending idle review when a new turn begins', async () => {
    vi.useFakeTimers()
    const value = fixture(resolveConfig({ idleReviewMs: 5_000 }))
    await value.preStep([userMessage('x'.repeat(150))], 1)
    value.events.push({ type: 'turn/end', data: { turn: 1 } })
    await value.turnStopping(1)
    await value.preStep([userMessage('threshold turn')], 2)
    value.events.push({ type: 'turn/end', data: { turn: 2 } })
    await value.turnStopping(2)
    await vi.advanceTimersByTimeAsync(4_000)
    await value.preStep([userMessage('A new turn arrived')], 3)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(value.coordinator.review).not.toHaveBeenCalled()
    expect(value.lifecycle.snapshot('session-1').current?.idleReviewPending).toBe(false)
    expect(value.lifecycle.snapshot('session-1').current?.reviewActivity).toMatchObject({ score: 6, turnCount: 3 })
  })

  it('cancels delayed review work when a one-shot Host disposes the plugin', async () => {
    vi.useFakeTimers()
    const value = fixture(resolveConfig({ idleReviewMs: 5_000 }))
    await value.preStep([userMessage('x'.repeat(150))], 1)
    value.events.push({ type: 'turn/end', data: { turn: 1 } })
    await value.turnStopping(1)
    await value.preStep([userMessage('threshold turn')], 2)
    value.events.push({ type: 'turn/end', data: { turn: 2 } })
    await value.turnStopping(2)
    expect(value.lifecycle.snapshot('session-1').current?.idleReviewPending).toBe(true)

    value.stop()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(value.coordinator.review).not.toHaveBeenCalled()
    expect(value.lifecycle.snapshot('session-1').activeAgents).toBe(0)
  })

  it('counts completed tool results and unique tool names with QoderWork weights', async () => {
    vi.useFakeTimers()
    const value = fixture(resolveConfig({ idleReviewMs: 5_000 }))
    await value.preStep([userMessage('x'.repeat(100))], 1)
    const names = ['read', 'read', 'write', 'search', 'read']
    names.forEach((name, index) => {
      value.events.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: `call-${index}`, name } })
      value.events.push({ type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: `call-${index}` } } } })
    })
    value.events.push({ type: 'turn/end', data: { turn: 1 } })
    await value.turnStopping(1)

    expect(value.lifecycle.snapshot('session-1').current).toMatchObject({
      idleReviewPending: true,
      reviewActivity: {
        totalUserTextLength: 100,
        turnCount: 1,
        toolCallCount: 5,
        uniqueToolCount: 3,
        textLengthScore: 2,
        turnScore: 1,
        toolCallScore: 1,
        toolDiversityScore: 1,
        score: 5,
      },
    })
  })

  it('does not double-score repeated stopping notifications for the same turn', async () => {
    const value = fixture()
    await value.preStep([userMessage('short')], 1)
    await value.turnStopping(1)
    await value.turnStopping(1)

    expect(value.lifecycle.snapshot('session-1').current?.reviewActivity).toMatchObject({
      totalUserTextLength: 5,
      turnCount: 1,
      score: 1,
    })
  })

  it('deduplicates the same entered user message across multiple steps', async () => {
    const value = fixture()
    const prompt = userMessage('x'.repeat(50))
    await value.preStep([prompt], 1, 1)
    await value.preStep([prompt], 1, 2)
    await value.turnStopping(1)

    expect(value.lifecycle.snapshot('session-1').current?.reviewActivity).toMatchObject({
      totalUserTextLength: 50,
      turnCount: 1,
      textLengthScore: 1,
      turnScore: 1,
      score: 2,
    })
  })

  it('keeps the activity watermark when a new turn aborts an in-flight review', async () => {
    vi.useFakeTimers()
    const value = fixture(resolveConfig({ idleReviewMs: 5_000 }))
    let finish: (() => void) | undefined
    vi.mocked(value.coordinator.review).mockImplementationOnce(async () => await new Promise(resolve => {
      finish = () => resolve({
        delegated: true,
        runId: 'review-child',
        provider: 'fork',
        summary: 'Stale completion',
        action: 'skipped',
        memoryBodyIds: [],
      })
    }))

    await value.preStep([userMessage('x'.repeat(150))], 1)
    value.events.push({ type: 'turn/end', data: { turn: 1 } })
    await value.turnStopping(1)
    await value.preStep([userMessage('threshold turn')], 2)
    value.events.push({ type: 'turn/end', data: { turn: 2 } })
    await value.turnStopping(2)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(value.lifecycle.snapshot('session-1').current).toMatchObject({ reviewRunning: true })

    await value.preStep([userMessage('new evidence')], 3)
    finish?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(value.lifecycle.snapshot('session-1').current).toMatchObject({
      reviewRunning: false,
      idleReviewPending: false,
      reviewActivity: { score: 6, turnCount: 3, eligible: true },
    })
    expect(value.lifecycle.snapshot('session-1').current?.lastReviewAt).toBeUndefined()
  })

  it('can cue recall and remember independently', async () => {
    const recallOnly = fixture(resolveConfig({ recallMode: 'guided', writebackMode: 'off' }))
    const recallDecision = await recallOnly.preStep([userMessage()], 1)
    if (recallDecision.kind !== 'enter') throw new Error('unexpected rejection')
    expect(recallDecision.messages[1]?.content[0]?.text).toContain('mnemon_recall')
    expect(recallDecision.messages[1]?.content[0]?.text).not.toContain('mnemon_remember')

    const rememberOnly = fixture(resolveConfig({ recallMode: 'off', writebackMode: 'guided' }))
    const rememberDecision = await rememberOnly.preStep([userMessage()], 1)
    if (rememberDecision.kind !== 'enter') throw new Error('unexpected rejection')
    expect(rememberDecision.messages[1]?.content[0]?.text).toContain('mnemon_runtime_memory')
    expect(rememberDecision.messages[1]?.content[0]?.text).not.toContain('mnemon_recall')
  })

  it('delegates memory-tab candidates directly to an isolated memory subagent', async () => {
    const value = fixture()
    const result = await value.lifecycle.supervise('session-1', 'Use SQLite because deployment must remain single-file.')

    expect(result).toMatchObject({ delegated: true, sessionId: 'session-1', runId: 'write-child' })
    expect(value.followup).not.toHaveBeenCalled()
    expect(value.coordinator.write).toHaveBeenCalledWith(value.agent, 'supervised-writeback', {
      content: 'Use SQLite because deployment must remain single-file.',
      source: 'explicit Mnemon tab submission',
    }, expect.any(AbortSignal))
    expect(value.lifecycle.snapshot('session-1').counters.supervisedRequests).toBe(1)
  })

  it('runs workspace-only memory-tab candidates in a disposable top-level task Agent', async () => {
    const value = fixture()

    const result = await value.lifecycle.superviseTask('', 'Keep workspace release decisions durable.', undefined, '/tmp/workspace-two')

    expect(result).toMatchObject({ delegated: true, runId: 'write-child' })
    expect(value.createTaskAgent).toHaveBeenCalledWith(expect.objectContaining({ meta: { cwd: '/tmp/workspace-two', agentPreset: 'default' } }))
    expect(value.coordinator.write).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ header: expect.objectContaining({ cwd: '/tmp/workspace-two' }) }) }), 'supervised-writeback', {
      content: 'Keep workspace release decisions durable.',
      source: 'explicit Mnemon tab submission',
    }, expect.anything())
    expect(value.disposedTaskAgents).toContain(result.sessionId)
  })

  it('deduplicates replayed assistant-message supervision by session and message id', async () => {
    const value = fixture()

    const [first, replay] = await Promise.all([
      value.lifecycle.supervise('session-1', 'Keep the release checklist durable.', 'message-1'),
      value.lifecycle.supervise('session-1', 'Keep the release checklist durable.', 'message-1'),
    ])

    expect(replay).toEqual(first)
    expect(value.coordinator.write).toHaveBeenCalledTimes(1)
    expect(value.coordinator.write).toHaveBeenCalledWith(value.agent, 'supervised-writeback', {
      content: 'Keep the release checklist durable.',
      source: 'explicit assistant memory action',
    }, expect.any(AbortSignal))
    expect(value.lifecycle.snapshot('session-1').counters.supervisedRequests).toBe(1)
    await expect(value.lifecycle.supervise('session-1', 'Different content.', 'message-1')).rejects.toThrow('different content')
  })

  it('extracts assistant text from the durable DSH message content', () => {
    const value = fixture()
    value.events.push({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'message-1',
          role: 'assistant',
          content: [
            { type: 'text', text: 'First paragraph.' },
            { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' },
            { type: 'text', text: 'Second paragraph.' },
          ],
          source: { kind: 'model', provider: 'mock', model: 'mock' },
        },
      },
    })

    expect(value.lifecycle.assistantMessage('session-1', 'message-1')).toEqual({
      messageId: 'message-1',
      text: 'First paragraph.\n\nSecond paragraph.',
    })
    expect(value.lifecycle.assistantMessage('session-1', 'missing')).toBeNull()
  })

  it('keeps disabled lifecycle hooks out of model input while retaining manual supervision', async () => {
    const value = fixture(resolveConfig({ lifecycleEnabled: false, recallMode: 'off', writebackMode: 'off' }))
    const prompt = userMessage()
    const decision = await value.preStep([prompt], 1)
    expect(decision).toEqual({ kind: 'enter', messages: [prompt] })
    expect(value.steer).not.toHaveBeenCalled()
    await expect(value.lifecycle.supervise('session-1', 'Durable preference')).resolves.toMatchObject({ delegated: true })
  })
})
