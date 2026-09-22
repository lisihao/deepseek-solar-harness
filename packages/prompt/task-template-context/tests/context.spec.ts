import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents, Inbox, installModelSelection, type Agent, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { createUserMessage, CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { taskTemplateId, TaskTemplateService, emptyStoreDocument } from '@deepseek-ai/dsh-task-template'
import type { TaskTemplateStoreDocument } from '@deepseek-ai/dsh-task-template'
import * as TaskTemplateContext from '@deepseek-ai/dsh-task-template-context'
import * as TaskTemplateContextInvariant from '@deepseek-ai/dsh-task-template-context/invariant'
import {
  inferOutputFormat,
  inferRiskLevel,
  inferSkillNames,
  inferTaskAttributes,
  inferTaskDomain,
  inferTaskType,
  renderTaskTemplateInjection,
  renderTaskTemplateReceipt,
} from '@deepseek-ai/dsh-task-template-context'

class MemoryTemplates extends TaskTemplateService {
  protected load(): Promise<TaskTemplateStoreDocument> {
    return Promise.resolve(emptyStoreDocument())
  }

  protected persist(_document: TaskTemplateStoreDocument): Promise<'committed'> {
    return Promise.resolve('committed')
  }
}

function fakeAgent(
  session: Session,
  options: Agent['options'] = { provider: 'dsh-physical-operator', model: 'codex' },
  ctx = new Context(),
): Agent {
  return {
    id: session.id,
    options,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

function decisionEvents(session: Session): SessionEvent<'task-template/decided'>[] {
  return session.events.filter(
    (event): event is SessionEvent<'task-template/decided'> => event.type === 'task-template/decided',
  )
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolCallResponse(callId = 'advance-1'): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: CallId(callId), name: 'advance', arguments: '{}' },
    },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: StreamChunk[][]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('ScriptedAdapter: script exhausted')
    for (const chunk of chunks) yield chunk
  }
}

function requestText(request: GenerateOptions): string {
  return request.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

async function loopHarness(adapter: ScriptedAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(TaskTemplateContextInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(MemoryTemplates)
  await ctx.plugin(TaskTemplateContext)
  ctx.llm.registerAdapter(['mock'], adapter)
  loopContexts.push(ctx)
  return ctx
}

const loopContexts: Context[] = []

afterEach(async () => {
  while (loopContexts.length > 0) await loopContexts.pop()!.fiber.dispose()
})

describe('task attribute inference', () => {
  it('classifies insight reports before their broader research and writing words', () => {
    const objective = '请使用 $Research skill 撰写一份中文 AI 行业洞察报告，并输出 HTML。'

    expect(inferTaskType(objective)).toBe('insight-report')
    expect(inferTaskDomain(objective)).toBe('agent-systems')
    expect(inferOutputFormat(objective)).toBe('html-report')
    expect(inferRiskLevel(objective)).toBe('low')
    expect(inferSkillNames(objective)).toEqual(['research'])
    expect(inferTaskAttributes({ objective, operator: 'codex', tools: ['web', 'read', 'web'] })).toMatchObject({
      taskType: 'insight-report',
      domain: 'agent-systems',
      outputFormat: 'html-report',
      operators: ['codex'],
      tools: ['read', 'web'],
      language: 'zh-CN',
      priority: 'normal',
    })
  })

  it('treats task characteristics as routing metadata rather than authority', () => {
    expect(inferRiskLevel('立即删除生产数据库')).toBe('critical')
    expect(inferTaskAttributes({ objective: '立即删除生产数据库' })).not.toHaveProperty('authorized')
  })

  it('covers every stable task, domain, output, and risk category', () => {
    expect([
      'research a paper',
      'architecture proposal',
      'audit the patch',
      'plan the roadmap',
      'implement code',
      'write an article',
      'answer a question',
    ].map(inferTaskType)).toEqual([
      'research', 'architecture', 'review', 'planning', 'coding', 'writing', 'general',
    ])
    expect([
      'review React UI',
      'inspect the backend API',
      'deploy infrastructure',
      'analyze a finance portfolio',
      'check legal compliance',
      'answer a question',
    ].map(inferTaskDomain)).toEqual([
      'frontend', 'backend', 'infrastructure', 'finance', 'legal', 'general',
    ])
    expect([
      'draw a diagram',
      'return structured JSON',
      'write a report',
      'implement code',
      'answer a question',
    ].map(inferOutputFormat)).toEqual([
      'diagram', 'structured-data', 'document', 'code-change', 'answer',
    ])
    expect(['deploy this service', 'edit this file'].map(inferRiskLevel)).toEqual(['high', 'medium'])
    expect(inferSkillNames('Use skill: Review_Checklist and $review_checklist.')).toEqual(['review_checklist'])
  })
})

describe('agent task-template injection', () => {
  it('preserves rejection and empty inputs, and selects without an operator when none is configured', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('all-tasks'),
      name: 'All tasks',
      method: 'Complete {{objective}}.',
    })

    const rejectedSession = Session.create(SessionId('task-template-context-rejected'))
    const rejectedAgent = fakeAgent(rejectedSession)
    await expect(agentEvents(ctx, rejectedAgent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' as const }),
    )).resolves.toEqual({ kind: 'reject' })
    expect(decisionEvents(rejectedSession)).toHaveLength(0)

    const emptySession = Session.create(SessionId('task-template-context-empty'))
    const emptyAgent = fakeAgent(emptySession)
    await expect(agentEvents(ctx, emptyAgent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )).resolves.toEqual({ kind: 'enter', messages: [] })

    const blank = createUserMessage({ content: [{ type: 'text', text: '  ' }], source: { kind: 'user' } })
    await expect(agentEvents(ctx, emptyAgent).waterfall(
      'agent/pre-step',
      { messages: [blank], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [blank] }),
    )).resolves.toEqual({ kind: 'enter', messages: [blank] })
    expect(decisionEvents(emptySession)).toHaveLength(0)

    const operatorlessSession = Session.create(SessionId('task-template-context-operatorless'))
    const operatorless = fakeAgent(operatorlessSession, { model: 'mock' })
    const user = createUserMessage({ content: [{ type: 'text', text: 'Inspect this task.' }], source: { kind: 'user' } })
    const selected = await agentEvents(ctx, operatorless).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )
    if (selected.kind !== 'enter') throw new Error('fixture step was rejected')
    const injected = selected.messages.find(message => message.source.kind === 'task-template')
    if (injected?.source.kind !== 'task-template') throw new Error('missing task template')
    expect(injected.source.receipt.attributes.operators).toEqual([])
  })

  it.each([
    { initialProvider: 'claude', initialModel: 'claude', provider: 'chatgpt', model: 'chatgpt', template: 'operator-chatgpt' },
    { initialProvider: 'claude', initialModel: 'claude', provider: 'codex', model: 'codex', template: 'operator-codex' },
    { initialProvider: 'dsh-physical-operator', initialModel: 'codex', provider: 'ordinary', model: 'ordinary-model', template: 'operator-ordinary' },
  ])('uses the captured route after the initial route', async (route) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    const initialOperator = route.initialProvider === 'dsh-physical-operator' ? route.initialModel : route.initialProvider
    await ctx.taskTemplates.create({
      id: taskTemplateId('operator-initial'),
      name: 'operator-initial',
      match: { operators: [initialOperator] },
      method: 'Use the stale initial route.',
    })
    await ctx.taskTemplates.create({
      id: taskTemplateId(route.template),
      name: route.template,
      match: { operators: [route.provider] },
      method: 'Use the captured selected route.',
    })

    const session = Session.create(SessionId('task-template-context-' + route.provider))
    const agent = fakeAgent(session, { provider: route.initialProvider, model: route.initialModel }, ctx)
    const selection: ModelSelectionRef = {
      current: { provider: route.initialProvider, model: route.initialModel },
      assembled: undefined,
    }
    const disposeSelection = installModelSelection(ctx, selection)
    try {
      await ctx.systemPrompt.assemble({ scope: agent })
      selection.current = { provider: route.provider, model: route.model }
      await ctx.systemPrompt.assemble({ scope: agent })

      const user = createUserMessage({
        content: [{ type: 'text', text: 'Inspect this task.' }],
        source: { kind: 'user' },
      })
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
      )
      if (decision.kind !== 'enter') throw new Error('fixture step was rejected')
      const injected = decision.messages.find(message => message.source.kind === 'task-template')
      if (injected?.source.kind !== 'task-template') throw new Error('missing task template')
      expect(injected.source.receipt.templateId).toBe(route.template)
      expect(injected.source.receipt.attributes.operators).toEqual([route.provider])
    } finally {
      disposeSelection()
      await ctx.fiber.dispose()
    }
  })

  it('does not fall back to immutable Agent options before selection capture', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('operator-claude'),
      name: 'operator-claude',
      match: { operators: ['claude'] },
      method: 'Use the immutable Claude route.',
    })

    const session = Session.create(SessionId('task-template-context-uncaptured'))
    const agent = fakeAgent(session, { provider: 'claude', model: 'claude' }, ctx)
    const disposeSelection = installModelSelection(ctx, {
      current: { provider: 'chatgpt', model: 'chatgpt' },
      assembled: undefined,
    })
    try {
      const user = createUserMessage({
        content: [{ type: 'text', text: 'Inspect this task.' }],
        source: { kind: 'user' },
      })
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
      )
      expect(decision).toEqual({ kind: 'enter', messages: [user] })
      expect(decisionEvents(session)[0]?.data.receipt.attributes.operators).toEqual([])
    } finally {
      disposeSelection()
      await ctx.fiber.dispose()
    }
  })

  it('selects one matching template and logs exact rendered content in the entered message', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('insight-report'),
      name: '洞察报告',
      match: { taskTypes: ['insight-report'], languages: ['zh-CN'], operators: ['codex'] },
      method: '围绕 {{objective}} 输出可核验的 {{outputFormat}}。',
      rank: 10,
    })
    await ctx.taskTemplates.personalize(taskTemplateId('insight-report'), {
      preferences: '结论优先，使用中文。',
      memory: '区分事实、推断和未知项。',
    })
    const session = Session.create(SessionId('task-template-context-fixture'))
    const agent = fakeAgent(session)
    const user = createUserMessage({
      content: [{ type: 'text', text: '请生成一份 Agent 趋势洞察报告。' }],
      source: { kind: 'user' },
    })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )

    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('fixture step was rejected')
    expect(decision.messages).toHaveLength(2)
    const injected = decision.messages[1]!
    expect(injected.source.kind).toBe('task-template')
    if (injected.source.kind !== 'task-template') throw new Error('missing task-template source')
    expect(injected.source.receipt).toMatchObject({
      decision: 'inject',
      templateId: taskTemplateId('insight-report'),
      overrideSource: 'automatic',
      renderedContent: {
        method: '围绕 请生成一份 Agent 趋势洞察报告。 输出可核验的 document。',
        preferences: '结论优先，使用中文。',
        memory: '区分事实、推断和未知项。',
      },
    })
    const modelText = injected.content[0]?.type === 'text' ? injected.content[0].text : ''
    expect(JSON.parse(modelText)).toMatchObject({
      dshTaskPromptTemplate: {
        precedence: 'The current user request and system safety rules take priority over this user-managed template.',
        template: { id: 'insight-report', name: '洞察报告' },
        content: { preferences: '结论优先，使用中文。' },
      },
    })
  })

  it('does not inject an old or unrelated template when the current task has no match, but logs an attributable skip receipt', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('frontend-only'),
      name: 'Frontend only',
      match: { domains: ['frontend'] },
      method: 'Inspect the UI.',
    })
    const session = Session.create(SessionId('task-template-context-skip'))
    const agent = fakeAgent(session)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Summarize this poem.' }], source: { kind: 'user' } })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )

    expect(decision).toEqual({ kind: 'enter', messages: [user] })
    const decided = decisionEvents(session)
    expect(decided).toHaveLength(1)
    expect(decided[0]?.ignorable).toBe(true)
    expect('surfaceOp' in (decided[0] ?? {})).toBe(false)
    expect(decided[0]?.data.receipt).toMatchObject({
      decision: 'skip',
      rationale: [expect.stringContaining('no enabled template matches')],
    })

    const laterStep = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )
    expect(laterStep).toEqual({ kind: 'enter', messages: [user] })
    expect(decisionEvents(session)).toHaveLength(1)
  })

  it('injects once per logical user request and reuses it across later model steps', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('all-tasks'),
      name: 'All tasks',
      method: 'Complete {{objective}}.',
    })
    const session = Session.create(SessionId('task-template-context-dedupe'))
    const agent = fakeAgent(session)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Inspect this task.' }], source: { kind: 'user' } })
    const first = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )
    if (first.kind !== 'enter') throw new Error('fixture step was rejected')

    const second = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: first.messages, turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: first.messages }),
    )

    expect(second.kind).toBe('enter')
    if (second.kind !== 'enter') throw new Error('fixture step was rejected')
    expect(second.messages.filter(message => message.source.kind === 'task-template')).toHaveLength(1)
  })

  it('selects for the current task when its retained history carries an unrelated parent receipt', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('all-tasks'),
      name: 'All tasks',
      method: 'Complete {{objective}}.',
    })
    const parentSelection = ctx.taskTemplates.select({
      attributes: inferTaskAttributes({ objective: 'Review the parent frontend task.' }),
    })
    const parent = createUserMessage({
      content: [{ type: 'text', text: renderTaskTemplateInjection(parentSelection) }],
      source: { kind: 'task-template', form: 'instructions', receipt: parentSelection.receipt },
    })
    const user = createUserMessage({
      content: [{ type: 'text', text: 'Research the child backend task.' }],
      source: { kind: 'user' },
    })
    const session = Session.create(SessionId('task-template-context-child'))
    const agent = fakeAgent(session)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', parent, { surfaceOp: 'append' })
    session.append('user/message', user, { surfaceOp: 'append' })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )

    if (decision.kind !== 'enter') throw new Error('fixture step was rejected')
    const templates = decision.messages.filter(message => message.source.kind === 'task-template')
    expect(templates).toHaveLength(1)
    const selected = templates[0]
    if (selected?.source.kind !== 'task-template') throw new Error('missing child task template')
    expect(selected.source.receipt.attributes.objective).toBe('Research the child backend task.')
    expect(selected.source.receipt).not.toEqual(parentSelection.receipt)
    expect(decisionEvents(session)).toHaveLength(1)
  })

  it('restores the exact pinned receipt once after compaction shadows the injection within the same turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('all-tasks'),
      name: 'All tasks',
      method: 'Complete {{objective}}.',
    })
    const session = Session.create(SessionId('task-template-context-compact-restore'))
    const agent = fakeAgent(session)
    session.append('turn/start', { turn: 1 })
    const user = createUserMessage({ content: [{ type: 'text', text: 'Inspect this task.' }], source: { kind: 'user' } })
    const userEvent = session.append('user/message', user, { surfaceOp: 'append' })

    const first = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    if (first.kind !== 'enter') throw new Error('fixture step was rejected')
    const injected = first.messages[0]
    if (injected === undefined) throw new Error('expected the fresh selection to inject')
    const injectedEvent = session.append('user/message', injected, { surfaceOp: 'append' })
    expect(decisionEvents(session)).toHaveLength(1)
    expect(decisionEvents(session)[0]?.data.restored).toBeUndefined()

    // Simulate compaction shadowing both the original user message and the
    // injected task-template message with one replacement summary.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted summary' }],
      source: { kind: 'plugin', plugin: 'compaction-basic' },
    }), {
      surfaceOp: { op: 'replace', start: userEvent.seq, end: injectedEvent.seq },
      sourceEventSeqs: [userEvent.seq, injectedEvent.seq],
    })
    expect(session.surface.nodes.includes(injectedEvent.seq)).toBe(false)

    const second = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 2, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    if (second.kind !== 'enter') throw new Error('fixture step was rejected')
    const restored = second.messages.find(message => message.source.kind === 'task-template')
    if (restored === undefined || restored.source.kind !== 'task-template') {
      throw new Error('expected the pinned receipt to be restored')
    }
    expect(restored.source.receipt).toEqual(injected.source.kind === 'task-template' ? injected.source.receipt : undefined)
    expect(restored.content).toEqual(injected.content)
    const decidedAfterRestore = decisionEvents(session)
    expect(decidedAfterRestore).toHaveLength(2)
    expect(decidedAfterRestore[1]?.data.restored).toBe(true)

    // A third step after the same compacted shadow must not restore again:
    // the surface message is now live, so it is reused as is.
    session.append('user/message', restored, { surfaceOp: 'append' })
    const third = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 3, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    if (third.kind !== 'enter') throw new Error('fixture step was rejected')
    expect(third.messages.filter(message => message.source.kind === 'task-template')).toHaveLength(0)
    expect(decisionEvents(session)).toHaveLength(2)

    const restoredEvent = session.events.findLast(
      event => event.type === 'user/message' && event.data.source.kind === 'task-template',
    )
    if (restoredEvent === undefined) throw new Error('expected the restored message event')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second compacted summary' }],
      source: { kind: 'plugin', plugin: 'compaction-basic' },
    }), {
      surfaceOp: { op: 'replace', start: restoredEvent.seq, end: restoredEvent.seq },
      sourceEventSeqs: [restoredEvent.seq],
    })
    const fourth = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 4, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    if (fourth.kind !== 'enter') throw new Error('fixture step was rejected')
    expect(fourth.messages).toHaveLength(0)
    expect(decisionEvents(session)).toHaveLength(2)
  })

  it('never reactivates an earlier turn\'s template once a new logical user task starts', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.plugin(TaskTemplateContext)
    await ctx.taskTemplates.create({
      id: taskTemplateId('frontend-only'),
      name: 'Frontend only',
      match: { domains: ['frontend'] },
      method: 'Inspect the UI for {{objective}}.',
    })
    const session = Session.create(SessionId('task-template-context-new-turn'))
    const agent = fakeAgent(session)
    session.append('turn/start', { turn: 1 })
    const frontendUser = createUserMessage({ content: [{ type: 'text', text: 'Review the React frontend UI.' }], source: { kind: 'user' } })
    session.append('user/message', frontendUser, { surfaceOp: 'append' })
    const firstTurn = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    if (firstTurn.kind !== 'enter') throw new Error('fixture step was rejected')
    expect(firstTurn.messages.some(message => message.source.kind === 'task-template')).toBe(true)
    for (const message of firstTurn.messages) session.append('user/message', message, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    session.append('turn/start', { turn: 2 })
    const poemUser = createUserMessage({ content: [{ type: 'text', text: 'Summarize this poem.' }], source: { kind: 'user' } })
    session.append('user/message', poemUser, { surfaceOp: 'append' })
    const secondTurn = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 2, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    if (secondTurn.kind !== 'enter') throw new Error('fixture step was rejected')

    // The new turn's unrelated task never reactivates turn 1's frontend
    // template: it is judged fresh, and it has no match, so it skips.
    expect(secondTurn.messages).toHaveLength(0)
    const decided = decisionEvents(session)
    expect(decided).toHaveLength(2)
    expect(decided[0]?.data).toMatchObject({ turn: 1, receipt: { decision: 'inject', templateId: 'frontend-only' } })
    expect(decided[1]?.data).toMatchObject({ turn: 2, receipt: { decision: 'skip' } })
  })

  it('rejects rendering a skip outcome', () => {
    expect(() => renderTaskTemplateInjection({
      decision: 'skip',
      overrideSource: 'none',
      candidates: [],
      rationale: ['no match'],
      receipt: {
        receiptVersion: 1,
        decision: 'skip',
        overrideSource: 'none',
        candidates: [],
        rationale: ['no match'],
        attributes: inferTaskAttributes({ objective: 'fixture' }),
      },
    })).toThrow('cannot render a skipped selection')
  })

  it('rejects restoring a skipped receipt', () => {
    expect(() => renderTaskTemplateReceipt({
      receiptVersion: 1,
      decision: 'skip',
      overrideSource: 'none',
      candidates: [],
      rationale: ['no match'],
      attributes: inferTaskAttributes({ objective: 'fixture' }),
    })).toThrow('cannot restore a skipped receipt')
  })

  it('restores a pinned display name even when an explicit winner is absent from automatic candidates', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(MemoryTemplates)
      const id = taskTemplateId('fixture-explicit')
      await ctx.taskTemplates.create({
        id,
        name: 'Explicit fixture display name',
        match: { domains: ['frontend'] },
        method: 'Follow the explicit fixture for {{objective}}.',
      })
      const selection = ctx.taskTemplates.select({
        attributes: inferTaskAttributes({ objective: 'Summarize this poem.' }),
        explicitTemplateId: id,
      })
      expect(selection.candidates).toEqual([])
      expect(renderTaskTemplateReceipt(selection.receipt)).toBe(renderTaskTemplateInjection(selection))
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('falls back to the template id for a legacy receipt with no display name or winning candidate', () => {
    const text = renderTaskTemplateReceipt({
      receiptVersion: 1,
      decision: 'inject',
      overrideSource: 'explicit',
      templateId: taskTemplateId('fixture-explicit'),
      templateVersion: 1,
      contentSha256: 'deadbeef',
      renderedContent: { method: 'Fictional method.' },
      candidates: [],
      rationale: ['explicit override'],
      attributes: inferTaskAttributes({ objective: 'fixture' }),
    })
    expect(JSON.parse(text)).toMatchObject({
      dshTaskPromptTemplate: { template: { id: 'fixture-explicit', name: 'fixture-explicit' } },
    })
  })
})

describe('real AgentLoop request history', () => {
  it('reuses one retained injection across later tool-loop steps', async () => {
    const adapter = new ScriptedAdapter([toolCallResponse(), textResponse('done')])
    const ctx = await loopHarness(adapter)
    await ctx.taskTemplates.create({
      id: taskTemplateId('agent-loop-retained'),
      name: 'Agent loop retained fixture',
      method: 'Retain the fixture playbook for {{objective}}.',
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'advance',
      description: 'advance the fixture turn',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text' as const, text: 'advanced' }]),
    }))
    const agent = ctx.agentLoop.create(SessionId('loop-retained'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start the retained task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[0]!)).toContain('agent-loop-retained')
    expect(requestText(adapter.requests[1]!)).toContain('agent-loop-retained')
    expect(agent.session.events.filter(
      event => event.type === 'user/message' && event.data.source.kind === 'task-template',
    )).toHaveLength(1)
    expect(decisionEvents(agent.session)).toHaveLength(1)
  })

  it('injects through a concrete AgentLoop request and restores the pinned receipt after a mid-turn compaction shadow', async () => {
    const adapter = new ScriptedAdapter([toolCallResponse(), textResponse('done')])
    const ctx = await loopHarness(adapter)
    await ctx.taskTemplates.create({
      id: taskTemplateId('agent-loop-fixture'),
      name: 'Agent loop fixture',
      method: 'Follow the fixture playbook for {{objective}}.',
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'advance',
      description: 'advance the fixture turn',
      parameters: {},
      async execute(_args, toolCtx) {
        // Between step 1 (which produced the tool call) and step 2 (which
        // will read the next pre-step context): shadow the lone user/message
        // and the injected task-template message with one compaction-style
        // replacement, exactly as a real compaction backend would mid-turn.
        const session = toolCtx.agent?.session
        if (session === undefined) throw new Error('expected the fixture tool call to carry its owning agent')
        const shadowed = session.events.filter(event => event.type === 'user/message')
        const first = shadowed[0]
        const last = shadowed.at(-1)
        if (first === undefined || last === undefined) throw new Error('expected durable user/message events to shadow')
        session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'compacted summary' }],
          source: { kind: 'plugin', plugin: 'compaction-basic' },
        }), {
          surfaceOp: { op: 'replace', start: first.seq, end: last.seq },
          sourceEventSeqs: shadowed.map(event => event.seq),
        })
        return [{ type: 'text' as const, text: 'advanced' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('loop'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start the fixture task.' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(requestText(adapter.requests[0]!)).toContain('dshTaskPromptTemplate')
    expect(requestText(adapter.requests[1]!)).toContain('dshTaskPromptTemplate')
    const decided = decisionEvents(agent.session)
    expect(decided).toHaveLength(2)
    expect(decided[0]?.data).toMatchObject({ receipt: { decision: 'inject', templateId: 'agent-loop-fixture' } })
    expect(decided[0]?.data.restored).toBeUndefined()
    expect(decided[1]?.data.restored).toBe(true)
    expect(decided[1]?.data.receipt).toEqual(decided[0]?.data.receipt)
  })
})

describe('real Loader export path', () => {
  it('keeps namespace metadata and boots the agent listener through unwrapExports', async () => {
    expect('default' in TaskTemplateContext).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(TaskTemplateContext) as Record<string, unknown>
    expect(unwrapped).toBe(TaskTemplateContext)
    expect(unwrapped.name).toBe('task-template-context')
    expect(unwrapped.inject).toEqual(['taskTemplates', 'tools'])
    expect(typeof unwrapped.apply).toBe('function')

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(MemoryTemplates)
    await ctx.taskTemplates.create({
      id: taskTemplateId('loader-fixture'),
      name: 'Loader fixture',
      method: 'Follow the loader fixture for {{objective}}.',
    })
    const plugin = loader.unwrapExports(TaskTemplateContext) as Parameters<Context['plugin']>[0]
    await ctx.plugin(plugin)
    const session = Session.create(SessionId('loader'))
    const agent = fakeAgent(session)
    const user = createUserMessage({ content: [{ type: 'text', text: 'Inspect this task.' }], source: { kind: 'user' } })

    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [user] }),
    )

    if (decision.kind !== 'enter') throw new Error('fixture step was rejected')
    expect(decision.messages.some(message => message.source.kind === 'task-template')).toBe(true)
  })
})
