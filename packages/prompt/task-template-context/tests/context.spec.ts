import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { taskTemplateId, TaskTemplateService, emptyStoreDocument } from '@deepseek-ai/dsh-task-template'
import type { TaskTemplateStoreDocument } from '@deepseek-ai/dsh-task-template'
import * as TaskTemplateContext from '@deepseek-ai/dsh-task-template-context'
import {
  inferOutputFormat,
  inferRiskLevel,
  inferSkillNames,
  inferTaskAttributes,
  inferTaskDomain,
  inferTaskType,
  renderTaskTemplateInjection,
} from '@deepseek-ai/dsh-task-template-context'

class MemoryTemplates extends TaskTemplateService {
  protected load(): Promise<TaskTemplateStoreDocument> {
    return Promise.resolve(emptyStoreDocument())
  }

  protected persist(_document: TaskTemplateStoreDocument): Promise<void> {
    return Promise.resolve()
  }
}

function fakeAgent(session: Session): Agent {
  return {
    id: session.id,
    options: { provider: 'dsh-physical-operator', model: 'codex' },
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

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
})

describe('agent task-template injection', () => {
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
        precedence: expect.stringContaining('current user request'),
        template: { id: 'insight-report', name: '洞察报告' },
        content: { preferences: '结论优先，使用中文。' },
      },
    })
  })

  it('does not inject an old or unrelated template when the current task has no match', async () => {
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
})
