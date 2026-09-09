import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  TaskTemplateService,
  emptyStoreDocument,
  type TaskTemplateStoreDocument,
} from '@deepseek-ai/dsh-task-template'
import { createTaskTemplateRpcHandler } from '@deepseek-ai/dsh-task-template-rpc'

class MemoryTemplates extends TaskTemplateService {
  protected load(): Promise<TaskTemplateStoreDocument> { return Promise.resolve(emptyStoreDocument()) }
  protected persist(_document: TaskTemplateStoreDocument): Promise<void> { return Promise.resolve() }
}

async function service(): Promise<TaskTemplateService> {
  const ctx = new Context()
  await ctx.plugin(MemoryTemplates)
  return ctx.taskTemplates
}

const signal = new AbortController().signal
const requestContext = { request: new Request('http://localhost/'), remoteAddress: '127.0.0.1' }

describe('task-template Host RPC', () => {
  it('manages reusable and private layers and previews deterministic selection', async () => {
    const handler = createTaskTemplateRpcHandler(await service())
    const created = await handler('create', { draft: {
      id: 'insight-report', name: '洞察报告', rank: 20,
      match: { taskTypes: ['insight-report'], languages: ['zh-CN'] },
      method: '围绕 {{objective}} 形成 {{outputFormat}}。',
    } }, signal, requestContext)
    expect(created).toMatchObject({ ok: true, value: { templates: [{ id: 'insight-report', version: 1 }] } })

    const personalized = await handler('personalize', {
      id: 'insight-report', personalization: { preferences: '结论优先。', memory: '区分事实和推断。' },
    }, signal, requestContext)
    expect(personalized).toMatchObject({
      ok: true,
      value: { templates: [{ personalization: { preferences: '结论优先。', memory: '区分事实和推断。' } }] },
    })

    const preview = await handler('preview', {
      id: 'insight-report',
      attributes: {
        taskType: 'insight-report', domain: 'agent-systems', objective: '分析 DSH 趋势', outputFormat: 'document',
        riskLevel: 'low', tools: [], skills: [], operators: ['codex'], language: 'zh-CN', priority: 'normal',
      },
    }, signal, requestContext)
    expect(preview).toMatchObject({
      ok: true,
      value: { decision: 'inject', selected: { content: { method: '围绕 分析 DSH 趋势 形成 document。' } } },
    })
  })

  it('returns a structured failure without mutating the store', async () => {
    const handler = createTaskTemplateRpcHandler(await service())
    const rejected = await handler('create', { draft: { id: 'Bad ID', name: 'x', method: 'x' } }, signal, requestContext)
    expect(rejected).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await handler('list', {}, signal, requestContext)).toMatchObject({ ok: true, value: { templates: [] } })
    await expect(handler('create', {
      draft: { id: 'valid-id', name: 'x', method: 'x', ignored: true },
    }, signal, requestContext)).resolves.toMatchObject({
      ok: false, error: { message: expect.stringContaining('unsupported key') },
    })
    await expect(handler('preview', {
      id: 'missing',
      attributes: {
        taskType: 'research', domain: 'general', objective: 'x', outputFormat: 'text',
        riskLevel: 'unknown', tools: [], skills: [], operators: [], language: 'en', priority: 'normal',
      },
    }, signal, requestContext)).resolves.toMatchObject({
      ok: false, error: { message: expect.stringContaining('riskLevel') },
    })
  })
})
