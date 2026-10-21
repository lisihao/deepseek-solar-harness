import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage, createUserMessage, ReasoningEffortId, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { HandoffEngine as HandoffEngineType } from '../src/index.js'
import { HandoffStore } from '../src/store.js'

const fsReadGate = vi.hoisted(() => ({
  wait: undefined as ((path: string) => Promise<void>) | undefined,
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...actual,
    readFile: async (...args: any[]) => {
      await fsReadGate.wait?.(String(args[0]))
      return (actual.readFile as any)(...args)
    },
  }
})

let HandoffEngineCtor!: typeof HandoffEngineType
let applyRuntime!: typeof import('../src/index.js').apply

beforeAll(async () => {
  // The built plugin intentionally ships JavaScript only; source mode remains typed.
  const module = process.env.MODEL_HANDOFF_BUILT === '1'
    // @ts-expect-error built output has no declaration file
    ? await import('../lib/index.js')
    : await import('../src/index.js')
  HandoffEngineCtor = module.HandoffEngine
  applyRuntime = module.apply
})

interface RecordedCall {
  readonly provider: string
  readonly model: string
  readonly messages: readonly Message[]
}

type TestEngine = HandoffEngineType & {
  runSummary(owner: Agent): Promise<{ summary: readonly { type: string; text?: string }[] }>
}

interface RuntimeFixture {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly engine: TestEngine
  readonly calls: RecordedCall[]
  readonly asks: Array<{ readonly ids: readonly string[]; readonly detail?: string; readonly options?: readonly string[][] }>
  readonly root: string
  readonly events: unknown[]
  cleanup(): Promise<void>
}

const config = {
  summaryProvider: 'fixture-luna',
  summaryModel: 'fixture-luna-model',
  maxInputBytes: 1_500_000,
  maxOutputTokens: 8192,
  maxHandoffBytes: 48_000,
  verbatimMaxChars: 0,
}

const draft = JSON.stringify({
  summary: '交接摘要：保留目标、已完成工作和未决风险。',
  questions: [
    { id: 'next', question: '下一步必须先做什么？', options: ['先运行验证。', '先复核当前约束。'] },
    { id: 'risk', question: '需要保留哪些风险？', options: ['保留失败未知状态。', '先核对未决风险再继续。'] },
  ],
})

const target = { provider: 'target-provider', model: 'target-model' }

describe('model-handoff runtime boundary', () => {
  const fixtures: RuntimeFixture[] = []

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(fixture => fixture.cleanup()))
  })

  it('runs the isolated compaction subclass on a real Session and keeps the original log', async () => {
    const fixture = await createFixture({ assertPreparationPublished: true })
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })

    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    await fixture.engine.compactRegion(user!, user!, fixture.agent)

    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0]?.provider).toBe(config.summaryProvider)
    expect(fixture.calls[0]?.model).toBe(config.summaryModel)
    const summaryPrompt = fixture.calls[0]?.messages.at(-1)?.content
    expect(summaryPrompt?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('旧会话中的原始任务') })
    expect(fixture.asks.map(ask => ask.ids)).toEqual([['next'], ['risk'], ['handoff-confirm']])
    const messages = fixture.session.deriveMessages().map(message => message.content)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toEqual([{ type: 'text', text: '系统头' }])
    expect(messages[1]?.some(block => block.type === 'text' && block.text.includes('交接摘要'))).toBe(true)
    expect(fixture.session.snapshotEvents().map(event => event.type)).toEqual([
      'request/header',
      'turn/start',
      'system/message',
      'user/message',
      'compaction/start',
      'compaction/summary',
      'user/message',
      'compaction/end',
    ])
    expect(fixture.events.some(event => JSON.stringify(event).includes('旧会话中的原始任务'))).toBe(true)
  })

  it('offers contextual choices and carries selected full answers without typing into the checkpoint', async () => {
    const fixture = await createFixture({ chooseCandidates: true })
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)!
    await fixture.engine.compactRegion(user, user, fixture.agent)
    expect(fixture.asks.every(ask => ask.ids.length === 1)).toBe(true)
    expect(fixture.asks.slice(0, 2).flatMap(ask => ask.options ?? [])).toEqual([
      ['先运行验证。', '先复核当前约束。', '暂无补充'],
      ['保留失败未知状态。', '先核对未决风险再继续。', '暂无补充'],
    ])
    const saved = await fixture.engine.store.read(fixture.session.id)
    expect(saved?.answers).toEqual([{ id: 'next', answer: '先运行验证。' }, { id: 'risk', answer: '保留失败未知状态。' }])
    const checkpoint = JSON.stringify(fixture.session.deriveMessages())
    expect(checkpoint).toContain('回答1：先运行验证。')
    expect(checkpoint).toContain('回答2：保留失败未知状态。')
    expect(checkpoint).not.toContain('先复核当前约束。')
    expect(fixture.calls).toHaveLength(1)
  })

  it('persists each choice before asking the next question and resumes without re-asking it or calling Luna', async () => {
    const fixture = await createFixture({ chooseCandidates: true, blockQuestionId: 'risk' })
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const controller = new AbortController()
    const user = fixture.session.surface.nodes.at(-1)!
    const pending = fixture.engine.compactRegion(user, user, fixture.agent, controller.signal)
    await waitFor(() => fixture.asks.length === 2)
    const saved = await fixture.engine.store.read(fixture.session.id)
    expect(saved?.phase).toBe('draft')
    expect(saved?.answers).toEqual([{ id: 'next', answer: '先运行验证。' }])
    controller.abort(new Error('pause on second question'))
    await expect(pending).rejects.toThrow('pause on second question')
    await fixture.engine.compactRegion(user, user, fixture.agent)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.asks.map(ask => ask.ids)).toEqual([['next'], ['risk'], ['risk'], ['handoff-confirm']])
    expect((await fixture.engine.store.read(fixture.session.id))?.answers).toHaveLength(2)
  })

  it('does not call Luna when the draft is already persisted and confirmed', async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)
    const operation = { target, selectionSeq: 0 }
    fixture.engine.operations.set(fixture.session, operation)
    const state = {
      formatVersion: 1 as const,
      id: '7ad54f08-6a2d-4ea5-9a55-60b5f7db28dd',
      sessionId: fixture.session.id,
      target,
      fingerprint: (await fixture.engine.source(fixture.session)).fingerprint,
      phase: 'confirmed' as const,
      draftText: draft,
      answers: [
        { id: 'next', answer: '先运行验证。' },
        { id: 'risk', answer: '保留失败未知状态。' },
      ],
      confirmedText: '模型交接\n已确认',
      rawOutput: [{ type: 'text', text: draft }],
    }
    await fixture.engine.store.write(state)

    const result = await fixture.engine.runSummary(fixture.agent)
    expect(result.summary[0]).toMatchObject({ type: 'text', text: '模型交接\n已确认' })
    expect(fixture.calls).toHaveLength(0)
    expect(fixture.asks).toHaveLength(0)
  })

  it('records an in-flight Luna call and rejects replay after cancellation', async () => {
    const fixture = await createFixture({ blockLuna: true })
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    const controller = new AbortController()
    const pending = fixture.engine.compactRegion(user!, user!, fixture.agent, controller.signal)
    await waitFor(() => fixture.calls.length === 1)
    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow('test cancellation')

    const saved = await fixture.engine.store.read(fixture.session.id)
    expect(saved?.phase).toBe('calling')
    expect(fixture.calls).toHaveLength(1)
    await expect(fixture.engine.compactRegion(user!, user!, fixture.agent)).rejects.toThrow('结果未知')
    expect(fixture.calls).toHaveLength(1)
  })

  it('does not dispatch a target request while questions or confirmation are pending', async () => {
    const fixture = await createFixture({ blockQuestions: true })
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    const pending = fixture.engine.compactRegion(user!, user!, fixture.agent)
    await waitFor(() => fixture.asks.length === 1)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.targetRequests).toHaveLength(0)
    fixture.releaseQuestions()
    await pending
    expect(fixture.asks.map(ask => ask.ids)).toEqual([['next'], ['risk'], ['handoff-confirm']])
    expect(fixture.targetRequests).toHaveLength(0)
  })

  it('holds the real agent/request waterfall until the human answers and confirms', async () => {
    const fixture = await createFixture({ blockQuestions: true })
    fixtures.push(fixture)
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    try {
      await applyRuntime(fixture.ctx, config)
      const signal = new AbortController().signal
      let resolvedRoute = 0
      const pending = fixture.ctx.waterfall('agent/request', {
        agent: fixture.agent,
        turn: 1,
        step: 1,
        signal,
      }, async () => {
        resolvedRoute += 1
        return target
      })
      await waitFor(() => fixture.asks.length === 1)
      // `next()` only resolves the route configuration; it must not be mistaken
      // for provider I/O. The target adapter is invoked below, after the gate.
      expect(resolvedRoute).toBe(1)
      expect(fixture.targetRequests).toHaveLength(0)
      fixture.releaseQuestions()
      await pending
      const trigger = fixture.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '新触发输入' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(trigger.type).toBe('user/message')
      const prepared = await fixture.ctx.llm.prepareCall({ provider: target.provider, model: target.model })
      for await (const _chunk of prepared.stream({
        ...prepared.config,
        messages: fixture.session.deriveMessages(),
        signal,
        sessionId: SessionId(`${fixture.session.id}:target`),
      })) { /* the fixture adapter records this provider request */ }
      expect(fixture.targetRequests).toHaveLength(1)
      expect(fixture.targetRequests[0]).toContain('模型交接')
      expect(fixture.targetRequests[0]).toContain('先运行验证。')
      expect(fixture.targetRequests[0]).toContain('新触发输入')
      expect(fixture.targetRequests[0]).not.toContain('旧会话中的原始任务')
      expect(resolvedRoute).toBe(1)
      expect(fixture.asks.map(ask => ask.ids)).toEqual([['next'], ['risk'], ['handoff-confirm']])
    } finally {
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('arms idle model selection before the first target provider request', async () => {
    const fixture = await createFixture({ idle: true, extraHistory: true, blockQuestions: true })
    fixtures.push(fixture)
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    try {
      await applyRuntime(fixture.ctx, config)
      const selection = fixture.session.append('model/selection', target)
      fixture.ctx.emit('session/event', fixture.session, selection)
      await waitFor(() => fixture.asks.length === 1)
      expect(fixture.targetRequests).toHaveLength(0)
      fixture.releaseQuestions()
      await waitFor(() => fixture.asks.length === 3)
      expect(fixture.targetRequests).toHaveLength(0)
      await waitFor(() => fixture.session.deriveMessages().some(message => message.content.some(block => block.type === 'text' && block.text.includes('模型交接'))))
      const receiptStore = new HandoffStore(join(fixture.root, 'solar', 'model-handoff'))
      await waitFor(async () => (await receiptStore.read(fixture.session.id))?.phase === 'committed')
      const trigger = fixture.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'idle 后的新输入' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      expect(trigger.type).toBe('user/message')
      const prepared = await fixture.ctx.llm.prepareCall({ provider: target.provider, model: target.model })
      for await (const _chunk of prepared.stream({
        ...prepared.config,
        messages: fixture.session.deriveMessages(),
        signal: new AbortController().signal,
        sessionId: SessionId(`${fixture.session.id}:idle-target`),
      })) { /* the fixture adapter records this provider request */ }
      expect(fixture.targetRequests).toHaveLength(1)
      expect(fixture.targetRequests[0]).toContain('交接摘要')
      expect(fixture.targetRequests[0]).toContain('先运行验证。')
      expect(fixture.targetRequests[0]).toContain('idle 后的新输入')
      expect(fixture.targetRequests[0]).not.toContain('旧会话中的原始任务')
    } finally {
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('runs only the latest idle selection when B is immediately followed by C', async () => {
    const fixture = await createFixture({ idle: true, extraHistory: true })
    fixtures.push(fixture)
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    const latest = { provider: 'provider-c', model: 'model-c' }
    try {
      await applyRuntime(fixture.ctx, config)
      const first = fixture.session.append('model/selection', { provider: 'provider-b', model: 'model-b' })
      fixture.ctx.emit('session/event', fixture.session, first)
      const second = fixture.session.append('model/selection', latest)
      fixture.ctx.emit('session/event', fixture.session, second)

      await waitFor(() => fixture.calls.length === 1)
      const receiptStore = new HandoffStore(join(fixture.root, 'solar', 'model-handoff'))
      await waitFor(async () => (await receiptStore.read(fixture.session.id))?.phase === 'committed')
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.provider).toBe(config.summaryProvider)
      expect(fixture.calls[0]?.model).toBe(config.summaryModel)
      expect(fixture.targetRequests).toHaveLength(0)
      expect((await receiptStore.read(fixture.session.id))?.target).toEqual(latest)
      expect(fixture.asks.map(ask => ask.ids)).toEqual([['next'], ['risk'], ['handoff-confirm']])
    } finally {
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('projects reasoning effort out of the receipt target and performs one same-route handoff', async () => {
    const fixture = await createFixture({ idle: true, extraHistory: true })
    fixtures.push(fixture)
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    const highEffort = { ...target, reasoningEffort: ReasoningEffortId('high') }
    const lowEffort = { ...target, reasoningEffort: ReasoningEffortId('low') }
    try {
      await applyRuntime(fixture.ctx, config)
      const highSelection = fixture.session.append('model/selection', highEffort)
      fixture.ctx.emit('session/event', fixture.session, highSelection)
      const lowSelection = fixture.session.append('model/selection', lowEffort)
      fixture.ctx.emit('session/event', fixture.session, lowSelection)

      const receiptStore = new HandoffStore(join(fixture.root, 'solar', 'model-handoff'))
      await waitFor(async () => (await receiptStore.read(fixture.session.id))?.phase === 'committed')
      expect(fixture.calls).toHaveLength(1)
      expect(fixture.calls[0]?.provider).toBe(config.summaryProvider)
      expect(fixture.targetRequests).toHaveLength(0)
      const receipt = await receiptStore.read(fixture.session.id)
      expect(receipt?.target).toEqual(target)
      expect((receipt?.target as Record<string, unknown> | undefined)?.reasoningEffort).toBeUndefined()
    } finally {
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('does not call Luna when the target returns to the original model while the receipt read is pending', async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    let blockedRead = false
    let readPending = false
    let releaseRead: (() => void) | undefined
    fsReadGate.wait = async path => {
      if (path.includes('/solar/model-handoff/') && path.endsWith('.json') && !blockedRead) {
        blockedRead = true
        readPending = true
        await new Promise<void>(resolve => {
          releaseRead = () => {
            readPending = false
            resolve()
          }
        })
      }
    }
    try {
      await applyRuntime(fixture.ctx, config)
      const pending = fixture.ctx.waterfall('agent/request', {
        agent: fixture.agent,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, async () => target)
      await waitFor(() => readPending)
      expect(fixture.calls).toHaveLength(0)

      const original = fixture.session.append('model/selection', { provider: 'old-provider', model: 'old-model' })
      fixture.ctx.emit('session/event', fixture.session, original)
      releaseRead?.()
      await expect(pending).rejects.toThrow()
      expect(fixture.calls).toHaveLength(0)
      expect(fixture.targetRequests).toHaveLength(0)
    } finally {
      releaseRead?.()
      fsReadGate.wait = undefined
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('rejects the old target when selection changes during the final flush', async () => {
    const fixture = await createFixture({ blockFlush: true })
    fixtures.push(fixture)
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    try {
      await applyRuntime(fixture.ctx, config)
      const pending = fixture.ctx.waterfall('agent/request', {
        agent: fixture.agent,
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      }, async () => target)
      await waitFor(() => fixture.asks.length === 3 && fixture.flushPending())
      expect(fixture.flushPending()).toBe(true)
      const newerTarget = { provider: 'new-provider', model: 'new-model' }
      const selection = fixture.session.append('model/selection', newerTarget)
      fixture.ctx.emit('session/event', fixture.session, selection)
      fixture.releaseFlush()
      await waitFor(() => fixture.flushPending())
      fixture.releaseFlush()
      await expect(pending).rejects.toThrow()
      expect(fixture.targetRequests).toHaveLength(0)
    } finally {
      fixture.releaseFlush()
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('reuses a confirmed native compaction receipt without a second Luna call or checkpoint', async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    await fixture.engine.compactRegion(user!, user!, fixture.agent)
    const confirmed = await fixture.engine.store.read(fixture.session.id)
    expect(confirmed?.phase).toBe('confirmed')
    expect(confirmed?.compactionId).toBeTruthy()
      const receiptStore = new HandoffStore(join(fixture.root, 'solar', 'model-handoff'))
    await receiptStore.write(confirmed!)
    const checkpointsBefore = fixture.session.snapshotEvents().filter(event => event.type === 'compaction/summary').length
    const callsBefore = fixture.calls.length
    const removeAgents = fixture.ctx.provide('agents', {
      get: (id: Agent['id']) => id === fixture.agent.id ? fixture.agent : undefined,
      roots: () => [fixture.agent],
    })
    const removeCommands = fixture.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = fixture.root
    try {
      await applyRuntime(fixture.ctx, config)
      const result = await fixture.ctx.waterfall('agent/request', {
        agent: fixture.agent,
        turn: 1,
        step: 2,
        signal: new AbortController().signal,
      }, async () => target)
      expect(result).toEqual(target)
      expect(fixture.calls).toHaveLength(callsBefore)
      expect(fixture.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(checkpointsBefore)
    } finally {
      removeCommands(); removeAgents()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('includes first human answers in the source of a later handoff', async () => {
    const fixture = await createFixture()
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    await fixture.engine.compactRegion(user!, user!, fixture.agent)
    fixture.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '第二次交接的新输入' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const source = await fixture.engine.source(fixture.session)
    expect(source.text).toContain('先运行验证。')
    expect(source.text).toContain('保留失败未知状态。')
    expect(source.text).toContain('第二次交接的新输入')
  })

  it('splits bounded history, asks budget approval, and records aggregate raw output without a stream marker', async () => {
    const historyTexts = ['一'.repeat(700), '二'.repeat(700), '三'.repeat(700)]
    const fixture = await createFixture({ historyTexts, contextWindow: 19_500, approveBudget: true })
    fixtures.push(fixture)
    fixture.engine.settings = { ...config, maxSummaryCalls: 8 }
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    await fixture.engine.compactRegion(user!, user!, fixture.agent)

    expect(fixture.calls.length).toBeGreaterThan(1)
    expect(fixture.asks[0]?.ids).toEqual(['handoff-budget'])
    const prompts = fixture.calls.map(call => call.messages.at(-1)?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? '').join('\n')
    for (const text of historyTexts) expect(prompts).toContain(text)
    const finalPrompt = fixture.calls.at(-1)?.messages.at(-1)?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
    const orderedStart = finalPrompt.indexOf('{"orderedChunkDrafts"')
    expect(orderedStart).toBeGreaterThanOrEqual(0)
    const ordered = JSON.parse(finalPrompt.slice(orderedStart)) as {
      orderedChunkDrafts: Array<{ chunkIndex: number; provenance: Record<string, unknown>; draft: string }>
    }
    expect(ordered.orderedChunkDrafts).toHaveLength(fixture.calls.length - 1)
    ordered.orderedChunkDrafts.forEach((item, index) => {
      expect(item.chunkIndex).toBe(index)
      expect(item.provenance).toBeDefined()
      expect(item.draft).toBe(draft)
    })
    const summary = fixture.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    expect(summary?.type).toBe('compaction/summary')
    if (summary?.type === 'compaction/summary') {
      expect(summary.data.llmStreamCall).toBeUndefined()
      expect(summary.data.rawOutput?.[0]).toMatchObject({ type: 'text', text: expect.stringContaining('solar-model-handoff') })
    }
  })

  it('streams an oversized record as attributed fragments and carries them into reduction', async () => {
    const history = '更正预算为1800，原3000作废；先列离线测试。🧭'.repeat(120)
    const fixture = await createFixture({ historyTexts: [history], contextWindow: 19_500, approveBudget: true })
    fixtures.push(fixture)
    fixture.engine.settings = { ...config, maxSummaryCalls: 8 }
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)!
    await fixture.engine.compactRegion(user, user, fixture.agent)
    const prompts = fixture.calls.map(call => call.messages.at(-1)!.content.map(block => block.type === 'text' ? block.text : '').join(''))
    const fragments = prompts.flatMap(prompt => {
      const start = prompt.indexOf('{"historyFragment"')
      return start < 0 ? [] : [(JSON.parse(prompt.slice(start)) as { historyFragment: Record<string, any> }).historyFragment]
    })
    expect(fragments.length).toBeGreaterThan(1)
    expect(fragments.every(fragment => fragment.role === 'user' && fragment.sourceKind === 'user')).toBe(true)
    const restored = JSON.parse(fragments.map(fragment => fragment.text).join(''))
    expect(restored.content).toEqual([{ type: 'text', text: history }])
    const final = prompts.at(-1)!
    const drafts = JSON.parse(final.slice(final.indexOf('{"orderedChunkDrafts"'))).orderedChunkDrafts as Array<{ provenance: Record<string, any> }>
    expect(drafts.filter(item => item.provenance.sha256).map(item => item.provenance)).toEqual(fragments.map(({ text: _text, ...metadata }) => metadata))
    expect(fixture.calls.length).toBeLessThanOrEqual(8)
  })

  it('rejects a history needing more than eight summary calls before any Luna stream', async () => {
    const historyTexts = Array.from({ length: 12 }, (_, index) => `历史-${index}-` + '字'.repeat(700))
    const fixture = await createFixture({ historyTexts, contextWindow: 18_000 })
    fixtures.push(fixture)
    fixture.engine.settings = { ...config, maxSummaryCalls: 8 }
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()

    await expect(fixture.engine.compactRegion(user!, user!, fixture.agent)).rejects.toThrow(/超出配置上限|maxSummaryCalls|summary calls/i)
    expect(fixture.calls).toHaveLength(0)
    expect(fixture.asks).toHaveLength(0)
  })

  it('lets explicit cancellation start fresh before any Luna call and never resurrects the old task', async () => {
    const f = await createFixture({ cancelAt: 'handoff-mode' })
    fixtures.push(f)
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const first = f.session.surface.nodes[1]!
    const last = f.session.surface.nodes.at(-1)!
    await f.engine.compactRegion(first, last, f.agent)
    expect(f.calls).toHaveLength(0)
    expect(f.session.deriveMessages().filter(m => m.role !== 'system').flatMap(m => m.content)).toEqual([])
    expect(JSON.stringify(f.session.snapshotEvents())).toContain('旧会话中的原始任务')
    expect(await f.engine.store.read(f.session.id)).toMatchObject({ mode: 'fresh', phase: 'confirmed', target })
    expect((await f.engine.source(f.session)).records).toEqual([])
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '新任务，不是原任务的继续' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const next = await f.engine.source(f.session)
    expect(next.text).toContain('新任务，不是原任务的继续')
    expect(next.text).not.toContain('旧会话中的原始任务')
  })

  it('cancels the final summary preview into an empty context without another model call', async () => {
    const f = await createFixture({ cancelAt: 'handoff-confirm' })
    fixtures.push(f)
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const user = f.session.surface.nodes.at(-1)!
    await f.engine.compactRegion(user, user, f.agent)
    expect(f.calls).toHaveLength(1)
    expect(f.session.deriveMessages().flatMap(m => m.content).some(b => b.type === 'text' && b.text.includes('交接摘要'))).toBe(false)
    expect(await f.engine.store.read(f.session.id)).toMatchObject({ mode: 'fresh', calls: [{ finish: 'stop' }] })
    expect(f.session.snapshotEvents().findLast(e => e.type === 'compaction/end')?.data).not.toHaveProperty('error')
  })

  it('recovers a persisted fresh checkpoint and admits only the next task after plugin reload', async () => {
    const f = await createFixture({ cancelAt: 'handoff-mode' })
    fixtures.push(f)
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const user = f.session.surface.nodes.at(-1)!
    await f.engine.compactRegion(user, user, f.agent)
    const saved = await f.engine.store.read(f.session.id)
    await new HandoffStore(join(f.root, 'solar', 'model-handoff')).write(saved!)
    f.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'FRESH_AFTER_RELOAD' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const removeAgents = f.ctx.provide('agents', { get: () => f.agent, roots: () => [f.agent] })
    const removeCommands = f.ctx.provide('commands', { register: () => () => undefined })
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = f.root
    try {
      await applyRuntime(f.ctx, config)
      await expect(f.ctx.waterfall('agent/request', { agent: f.agent, turn: 2, step: 1, signal: new AbortController().signal }, async () => target)).resolves.toEqual(target)
      expect(f.calls).toHaveLength(0)
      const messages = JSON.stringify(f.session.deriveMessages())
      expect(messages).toContain('FRESH_AFTER_RELOAD')
      expect(messages).not.toContain('旧会话中的原始任务')
      expect(f.session.snapshotEvents().filter(e => e.type === 'compaction/summary')).toHaveLength(1)
    } finally {
      removeAgents(); removeCommands()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('persists an expanding generated summary as failed and never retries it silently', async () => {
    const f = await createFixture({ historyTexts: ['短任务'] })
    fixtures.push(f)
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const user = f.session.surface.nodes.at(-1)!
    await expect(f.engine.compactRegion(user, user, f.agent)).rejects.toThrow('摘要长于任务原文')
    expect(await f.engine.store.read(f.session.id)).toMatchObject({ phase: 'failed' })
    await expect(f.engine.compactRegion(user, user, f.agent)).rejects.toThrow('未自动重发')
    expect(f.calls).toHaveLength(1)
  })

  it('rejects an expanding completed final receipt after restart without replaying the call', async () => {
    const f = await createFixture({ historyTexts: ['短任务'] })
    fixtures.push(f)
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const source = await f.engine.source(f.session)
    await f.engine.store.write({ formatVersion: 1, id: '12345678-1234-4234-8234-123456789abc', sessionId: f.session.id,
      target, fingerprint: source.fingerprint, phase: 'calling', calls: [{ id: 'final-call', final: true,
        status: 'completed', finish: 'stop', request: {}, rawOutput: [{ type: 'text', text: draft }] }] })
    const user = f.session.surface.nodes.at(-1)!
    await expect(f.engine.compactRegion(user, user, f.agent)).rejects.toThrow('摘要长于任务原文')
    expect(await f.engine.store.read(f.session.id)).toMatchObject({ phase: 'failed', error: expect.stringContaining('摘要长于任务原文') })
    expect(f.calls).toHaveLength(0)
    expect(f.asks).toHaveLength(0)
  })

  it('holds the initial choice before any summary and confirms a short task verbatim without questions or model calls', async () => {
    const task = '这是虚构的灯塔测试；预算1800元，原3000元作废。先列离线测试，不写代码。桥梁🧭-042，截止时间未知。'
    const f = await createFixture({ historyTexts: [task], recordMode: true, blockQuestionId: 'handoff-mode' })
    fixtures.push(f)
    f.engine.settings = { ...config, verbatimMaxChars: 1200 }
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const user = f.session.surface.nodes.at(-1)!
    const pending = f.engine.compactRegion(user, user, f.agent)
    await waitFor(() => f.asks.length === 1)
    expect(f.calls).toHaveLength(0)
    f.releaseQuestions()
    await pending
    expect(f.calls).toHaveLength(0)
    expect(f.asks.map(a => a.ids)).toEqual([['handoff-mode'], ['handoff-confirm']])
    const preview = f.asks.at(-1)!.detail!
    expect(preview).toContain(task)
    expect(preview).toContain('没有调用摘要模型')
    expect(preview).toContain('字符')
    expect(preview).not.toContain('tokens；')
    expect(await f.engine.store.read(f.session.id)).toMatchObject({ mode: 'verbatim', calls: [] })
  })

  it('persists completed malformed-call evidence and never retries it automatically', async () => {
    const fixture = await createFixture({ malformedLuna: true, includeUsage: true })
    fixtures.push(fixture)
    fixture.engine.operations.set(fixture.session, { target, selectionSeq: 0 })
    const user = fixture.session.surface.nodes.at(-1)
    expect(user).toBeDefined()
    await expect(fixture.engine.compactRegion(user!, user!, fixture.agent)).rejects.toThrow()
    const saved = await fixture.engine.store.read(fixture.session.id)
    expect(saved?.phase).toBe('failed')
    expect(saved?.calls?.[0]?.status).toBe('completed')
    expect(saved?.calls?.[0]?.rawOutput).toEqual([{ type: 'text', text: 'not-json' }])
    expect(saved?.calls?.[0]?.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })
    expect(fixture.calls).toHaveLength(1)
    await expect(fixture.engine.compactRegion(user!, user!, fixture.agent)).rejects.toThrow()
    expect(fixture.calls).toHaveLength(1)
  })

  it('retains the actual provider finish failure instead of only a generic Luna message', async () => {
    const f = await createFixture({ failureLuna: true })
    fixtures.push(f)
    f.engine.operations.set(f.session, { target, selectionSeq: 0 })
    const user = f.session.surface.nodes.at(-1)!
    await expect(f.engine.compactRegion(user, user, f.agent)).rejects.toThrow('FIXTURE_STREAM_ERROR')
    expect((await f.engine.store.read(f.session.id))?.calls?.[0]).toMatchObject({ finish: 'error',
      failure: { code: 'FIXTURE_STREAM_ERROR', message: 'fixture upstream ended', status: 503 } })
    expect(f.calls).toHaveLength(1)
  })
})

type FixtureOptions = {
  readonly recordMode?: boolean
  readonly cancelAt?: 'handoff-mode' | 'handoff-budget' | 'handoff-confirm'
  readonly assertPreparationPublished?: boolean
  readonly blockLuna?: boolean
  readonly blockQuestions?: boolean
  readonly extraHistory?: boolean
  readonly idle?: boolean
  readonly blockFlush?: boolean
  readonly contextWindow?: number
  readonly historyTexts?: readonly string[]
  readonly approveBudget?: boolean
  readonly malformedLuna?: boolean
  readonly failureLuna?: boolean
  readonly includeUsage?: boolean
  readonly chooseCandidates?: boolean
  readonly blockQuestionId?: string
}

async function createFixture(options: FixtureOptions = {}): Promise<RuntimeFixture & {
  readonly targetRequests: string[]
  readonly flushPending: () => boolean
  releaseQuestions(): void
  releaseFlush(): void
}> {
  const root = await mkdtemp(join(tmpdir(), 'model-handoff-runtime-'))
  const ctx = new Context()
  const calls: RecordedCall[] = []
  const asks: Array<{ readonly ids: readonly string[]; readonly detail?: string; readonly options?: readonly string[][] }> = []
  const targetRequests: string[] = []
  const events: unknown[] = []
  let releaseQuestions!: () => void
  let releaseFlush!: () => void
  let flushIsPending = false
  let flushedThrough = -1
  let blockedQuestions = options.blockQuestions === true || options.blockQuestionId !== undefined ? 1 : 0

  const session = Session.create(SessionId(`runtime-${Math.random().toString(16).slice(2)}`))
  const append = <T extends Parameters<Session['append']>[0]>(type: T, data: Parameters<Session['append']>[1], opts?: Parameters<Session['append']>[2]) => {
    const event = (session.append as (...args: unknown[]) => unknown)(type, data, ...(opts === undefined ? [] : [opts]))
    events.push(event)
    return event
  }
  append('request/header', {
    header: { config: { provider: 'old-provider', model: 'old-model' } },
    reason: 'initial',
  })
  append('turn/start', { turn: 1 })
  append('system/message', { turn: 1, step: 0, message: createSystemMessage('系统头') }, { surfaceOp: 'append' })
  const historyTexts = options.historyTexts ?? ['旧会话中的原始任务；保留明确事实、更正、失败和下一步边界。'.repeat(8)]
  for (const text of historyTexts) append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (options.extraHistory && options.historyTexts === undefined) append('user/message', createUserMessage({
    content: [{ type: 'text', text: '旧会话中的第二条历史' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (options.idle) append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  const removeLlm = ctx.provide('llm', {
    async prepareCall(request: { provider: string; model: string }) {
      if (options.assertPreparationPublished && request.provider === config.summaryProvider) {
        const start = session.snapshotEvents().findLast(event => event.type === 'compaction/start')
        expect(start).toBeDefined()
        expect(start?.data.compactionId).toMatch(/^solar-model-handoff:/)
        expect(flushedThrough).toBeGreaterThanOrEqual(start!.seq)
      }
      return {
        config: { ...request, maxTokens: config.maxOutputTokens },
        retryPolicy: {},
        adapterDefaults: {},
        context: { contextWindow: options.contextWindow ?? 1_000_000 },
        async *stream(options_: { messages: readonly Message[]; signal?: AbortSignal }): AsyncIterable<StreamChunk> {
          const last = options_.messages.at(-1)
          calls.push({ provider: request.provider, model: request.model, messages: options_.messages })
          if (request.provider !== config.summaryProvider) {
            targetRequests.push(options_.messages.map(message => message.content.map(block => block.type === 'text' ? block.text : '').join('')).join('\n'))
            yield { type: 'text-delta', index: 0, text: 'target output' }
            yield { type: 'finish', reason: { kind: 'stop' } }
            return
          }
          if (options.blockLuna) {
            await new Promise<void>((resolve, reject) => {
              const signal = options_.signal
              if (signal?.aborted) return reject(signal.reason)
              signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
              void resolveQuestions
            })
          }
          yield { type: 'text-delta', index: 0, text: options.malformedLuna ? 'not-json' : draft }
          if (options.failureLuna) {
            yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_STREAM_ERROR', message: 'fixture upstream ended', status: 503 } } }
            return
          }
          if (options.includeUsage) yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        },
      }
    },
  })
  const removeMeter = ctx.provide('tokenMeter', {
    measure: () => ({ totalTokens: 100, nodes: session.surface.nodes.map(seq => ({ seq, tokens: 100, heuristicTokens: 100 })) }),
    estimateMessage: () => 1,
  })
  const removeSessions = ctx.provide('sessions', {
    flush: async () => {
      flushedThrough = session.seq - 1
      if (!options.blockFlush || !session.snapshotEvents().some(event => event.type === 'compaction/end')) return
      await new Promise<void>(resolve => {
        flushIsPending = true
        releaseFlush = () => { flushIsPending = false; resolve() }
      })
    },
  })
  const removeQuery = ctx.provide('sessionQuery', {
    readSession: async () => ({ header: session.header, events: session.snapshotEvents() }),
  })
  let resolveQuestions!: () => void
  const removeQuestions = ctx.provide('userQuestions', {
    ask: async (request: { questions: readonly { id: string; detail?: string; options?: readonly { label: string }[] }[]; signal?: AbortSignal; agent: Agent; }): Promise<unknown> => {
      if (request.questions[0]?.id === 'handoff-mode' && !options.recordMode && options.cancelAt !== 'handoff-mode') return { answers: [{ id: 'handoff-mode', selected: ['携带当前任务上下文'] }] }
      asks.push({ ids: request.questions.map(question => question.id), options: request.questions.map(question => question.options?.map(option => option.label) ?? []), ...request.questions[0]?.detail === undefined ? {} : { detail: request.questions[0].detail } })
      if (blockedQuestions > 0 && (options.blockQuestionId === undefined || request.questions[0]?.id === options.blockQuestionId)) {
        blockedQuestions -= 1
        await new Promise<void>((resolve, reject) => {
          resolveQuestions = resolve
          request.signal?.addEventListener('abort', () => reject(request.signal?.reason), { once: true })
        })
      }
      if (request.questions[0]?.id === 'handoff-budget' && options.approveBudget) return { answers: [{ id: 'handoff-budget', selected: ['按此上限继续'] }] }
      if (request.questions[0]?.id === options.cancelAt) return { answers: [{ id: options.cancelAt, selected: ['取消交接，空白开始'] }] }
      if (request.questions[0]?.id === 'handoff-mode') return { answers: [{ id: 'handoff-mode', selected: ['携带当前任务上下文'] }] }
      if (request.questions[0]?.id === 'handoff-confirm') return { answers: [{ id: 'handoff-confirm', selected: ['确认并继续'] }] }
      if (options.chooseCandidates) return { answers: request.questions.map(question => ({ id: question.id, selected: [question.options![0]!.label] })) }
      return { answers: request.questions.map(question => ({ id: question.id, selected: [], custom: question.id === 'next' ? '先运行验证。' : '保留失败未知状态。' })) }
    },
  })
  const agent = {
    id: session.id,
    session,
    status: options.idle ? 'idle' : 'running',
    ctx,
    runMaintenance: async (operation: (signal: AbortSignal) => Promise<unknown>) => operation(new AbortController().signal),
  } as unknown as Agent
  const engine = new HandoffEngineCtor(ctx)
  engine.settings = config
  engine.store = new HandoffStore(join(root, 'state'))

  class ExposedEngine extends HandoffEngineCtor {
    async runSummary(owner: Agent): Promise<{ summary: readonly { type: string; text?: string }[] }> {
      return this.summarize({ messages: [] }, owner) as Promise<{ summary: readonly { type: string; text?: string }[] }>
    }
  }
  const exposed = Object.setPrototypeOf(engine, ExposedEngine.prototype) as ExposedEngine

  return {
    ctx,
    session,
    agent,
    engine: exposed,
    calls,
    asks,
    root,
    events,
    targetRequests,
    flushPending: () => flushIsPending,
    releaseFlush: () => releaseFlush?.(),
    releaseQuestions: () => resolveQuestions?.(),
    async cleanup(): Promise<void> {
      await new Promise<void>(resolve => setImmediate(resolve))
      removeQuestions(); removeQuery(); removeSessions(); removeMeter(); removeLlm()
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    },
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!(await predicate()) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  expect(await predicate()).toBe(true)
}
