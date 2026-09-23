import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  TaskTemplateService,
  emptyStoreDocument,
  type TaskTemplateStoreDocument,
} from '@deepseek-ai/dsh-task-template'
import * as taskTemplateRpc from '@deepseek-ai/dsh-task-template-rpc'

const { TASK_TEMPLATE_RPC_CHANNEL, apply, createTaskTemplateRpcHandler, inject } = taskTemplateRpc

class MemoryTemplates extends TaskTemplateService {
  protected load(): Promise<TaskTemplateStoreDocument> { return Promise.resolve(emptyStoreDocument()) }
  protected persist(_document: TaskTemplateStoreDocument): Promise<'committed'> { return Promise.resolve('committed') }
}

class RejectingTemplates extends MemoryTemplates {
  protected override persist(_document: TaskTemplateStoreDocument): Promise<'committed'> {
    return new Promise((_resolve, reject) => {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- providers cross an unknown rejection boundary.
      reject('private store unavailable')
    })
  }
}

async function service(): Promise<TaskTemplateService> {
  const ctx = new Context()
  await ctx.plugin(MemoryTemplates)
  return ctx.taskTemplates
}

const signal = new AbortController().signal
const requestContext = { request: new Request('http://localhost/'), remoteAddress: '127.0.0.1' }

describe('task-template Host RPC', () => {
  it('uses only the named function-plugin exports', () => {
    expect('default' in taskTemplateRpc).toBe(false)
  })

  it('registers one trusted channel and removes it with the plugin fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemoryTemplates).await()
    const dispose = vi.fn(() => Promise.resolve())
    const handle = vi.fn(() => dispose)
    ctx.provide('connection', { rpc: { handle } } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })

    await fiber.await()
    expect(handle).toHaveBeenCalledWith(
      TASK_TEMPLATE_RPC_CHANNEL,
      expect.any(Function),
      { authority: 'trusted-host' },
    )
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('returns authoritative snapshots for every lifecycle mutation', async () => {
    const handler = createTaskTemplateRpcHandler(await service())
    const created = await handler('create', {
      draft: { id: 'lifecycle', name: 'Lifecycle', method: 'Handle {{objective}}.' },
    }, signal, requestContext)
    expect(created).toMatchObject({ ok: true, value: { templates: [{ id: 'lifecycle', rank: 0, match: {} }] } })

    const updated = await handler('update', {
      id: 'lifecycle', patch: { name: 'Lifecycle v2' },
    }, signal, requestContext)
    expect(updated).toMatchObject({ ok: true, value: { templates: [{ name: 'Lifecycle v2', version: 2 }] } })
    const disabled = await handler('set-enabled', {
      id: 'lifecycle', enabled: false,
    }, signal, requestContext)
    expect(disabled).toMatchObject({ ok: true, value: { templates: [{ enabled: false }] } })
    const personalized = await handler('personalize', {
      id: 'lifecycle', personalization: { memory: 'Keep evidence.' },
    }, signal, requestContext)
    expect(personalized).toMatchObject({
      ok: true,
      value: { templates: [{ personalization: { memory: 'Keep evidence.' } }] },
    })
    const cleared = await handler('personalize', {
      id: 'lifecycle', personalization: null,
    }, signal, requestContext)
    expect(cleared).toMatchObject({ ok: true, value: { templates: [{ id: 'lifecycle' }] } })
    const deleted = await handler('delete', { id: 'lifecycle' }, signal, requestContext)
    expect(deleted).toMatchObject({ ok: true, value: { templates: [] } })
  })

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
    const invalidRank = await handler('create', {
      draft: { id: 'valid-id', name: 'x', method: 'x', rank: '1' },
    }, signal, requestContext)
    expect(invalidRank.ok).toBe(false)
    if (invalidRank.ok) throw new Error('invalid rank unexpectedly succeeded')
    expect(invalidRank.error.message).toContain('finite number')
    const unsupported = await handler('create', {
      draft: { id: 'valid-id', name: 'x', method: 'x', ignored: true },
    }, signal, requestContext)
    expect(unsupported.ok).toBe(false)
    if (unsupported.ok) throw new Error('unsupported create unexpectedly succeeded')
    expect(unsupported.error.message).toContain('unsupported key')
    const invalidPreview = await handler('preview', {
      id: 'missing',
      attributes: {
        taskType: 'research', domain: 'general', objective: 'x', outputFormat: 'text',
        riskLevel: 'unknown', tools: [], skills: [], operators: [], language: 'en', priority: 'normal',
      },
    }, signal, requestContext)
    expect(invalidPreview.ok).toBe(false)
    if (invalidPreview.ok) throw new Error('invalid preview unexpectedly succeeded')
    expect(invalidPreview.error.message).toContain('riskLevel')
  })

  it('rejects malformed payload fields before dispatch', async () => {
    const handler = createTaskTemplateRpcHandler(await service())
    const cases: ReadonlyArray<readonly [string, unknown, string]> = [
      ['list', null, 'must be an object'],
      ['list', [], 'must be an object'],
      ['list', 'payload', 'must be an object'],
      ['create', { draft: { id: 1, name: 'x', method: 'x' } }, 'non-blank string'],
      ['create', { draft: { id: 'valid-id', name: '', method: 'x' } }, 'non-blank string'],
      ['create', { draft: { id: 'valid-id', name: 'x', method: 'x', match: [] } }, 'must be an object'],
      ['set-enabled', { id: 'valid-id', enabled: 'yes' }, 'must be a boolean'],
      ['personalize', { id: 'valid-id' }, 'personalization must be an object'],
      ['personalize', { id: 'valid-id', personalization: { unknown: true } }, 'unsupported key'],
      ['preview', {
        id: 'valid-id',
        attributes: {
          taskType: 'research', domain: 'general', objective: 'x', outputFormat: 'text',
          riskLevel: 'low', tools: 'web', skills: [], operators: [], language: 'en', priority: 'normal',
        },
      }, 'tools must be an array'],
      ['preview', {
        id: 'valid-id',
        attributes: {
          taskType: 'research', domain: 'general', objective: 'x', outputFormat: 'text',
          riskLevel: 'low', tools: [], skills: [], operators: [], language: 'en', priority: 'invalid',
        },
      }, 'priority is invalid'],
      ['unknown', { id: 'valid-id' }, 'unknown task-template endpoint'],
    ]
    for (const [endpoint, payload, message] of cases) {
      const result = await handler(endpoint, payload, signal, requestContext)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error(`${endpoint} unexpectedly accepted a malformed payload`)
      expect(result.error.message).toContain(message)
    }
  })

  it('normalizes a non-Error provider failure into an RPC failure', async () => {
    const ctx = new Context()
    await ctx.plugin(RejectingTemplates).await()
    const handler = createTaskTemplateRpcHandler(ctx.taskTemplates)

    const result = await handler('create', {
      draft: { id: 'valid-id', name: 'x', method: 'x' },
    }, signal, requestContext)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('rejecting provider unexpectedly created a template')
    expect(result.error.message).toBe('private store unavailable')
  })
})
