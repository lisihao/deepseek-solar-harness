import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ConversationWebAdapter,
  INSIGHT_LLM_MODEL,
  INSIGHT_LLM_NAME,
} from '../incubator/chatgpt-web/src/conversation-adapter.js'
import { WebLlmAdapter, WEB_LLM_MODEL, WEB_LLM_PROVIDER } from '../incubator/chatgpt-web/src/llm-adapter.js'
import type { WebLlmController } from '../incubator/chatgpt-web/src/llm-adapter.js'
import type { WebRunRecord, WebRunRequest } from '../incubator/chatgpt-web/src/store.js'
import type { StudioRun } from '../incubator/native-collaboration/src/studio-contract.js'

const sessionId = 'conversation-session' as GenerateOptions['sessionId']

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

function fakeWeb(overrides: Partial<{
  start: WebLlmController['start']
  observe: WebLlmController['observe']
}> = {}): { adapter: WebLlmAdapter; controller: WebLlmController & { start: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> } } {
  const controller = {
    start: vi.fn(async (id: string, request: WebRunRequest) => webRecord(id, request, '普通网页回答')),
    observe: vi.fn(async (id: string) => webRecord(id, { prompt: 'observed' }, '观察到的普通回答')),
    ...overrides,
  } as WebLlmController & { start: ReturnType<typeof vi.fn>; observe: ReturnType<typeof vi.fn> }
  return { adapter: new WebLlmAdapter(controller), controller }
}

function studioRun(
  status: StudioRun['status'],
  output?: string,
  overrides: Partial<StudioRun> = {},
): StudioRun {
  const timestamp = '2026-10-20T00:00:00.000Z'
  return {
    id: 'insight-command',
    sessionId: 'conversation-session',
    providerId: 'insight',
    status,
    nodes: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(output === undefined ? {} : { output }),
    ...overrides,
  }
}

function request(model: string = WEB_LLM_MODEL): GenerateOptions {
  return {
    provider: WEB_LLM_PROVIDER,
    model,
    sessionId,
    messages: [
      {
        id: 'old-user' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '旧问题' }],
      },
      {
        id: 'old-assistant' as never,
        role: 'assistant',
        source: { kind: 'model', provider: 'other', model: 'other' },
        content: [{ type: 'text', text: '旧回答' }],
      },
      {
        id: 'latest-user' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: '当前问题' }],
      },
    ],
  }
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('ConversationWebAdapter', () => {
  it('advertises ordinary Web and Insight catalog entries with one provider retry policy', async () => {
    const web = fakeWeb()
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      startInsight: vi.fn(async () => studioRun('completed', '洞察结果')),
      inspectInsight: vi.fn(async () => studioRun('completed', '洞察结果')),
      insightWaitMs: 20,
      pollMs: 1,
    })
    await expect(adapter.listModels(WEB_LLM_PROVIDER)).resolves.toEqual([
      { provider: WEB_LLM_PROVIDER, id: WEB_LLM_MODEL, name: 'ChatGPT 网页算子' },
      { provider: WEB_LLM_PROVIDER, id: INSIGHT_LLM_MODEL, name: INSIGHT_LLM_NAME },
    ])
    await expect(adapter.resolveModel(WEB_LLM_PROVIDER, WEB_LLM_MODEL)).resolves.toMatchObject({ id: WEB_LLM_MODEL })
    await expect(adapter.resolveModel(WEB_LLM_PROVIDER, INSIGHT_LLM_MODEL)).resolves.toEqual({
      provider: WEB_LLM_PROVIDER,
      id: INSIGHT_LLM_MODEL,
      name: INSIGHT_LLM_NAME,
    })
    expect(adapter.providerRetryPolicy(WEB_LLM_PROVIDER)).toMatchObject({ mode: 'normal', maxRetries: 0 })
  })

  it('delegates ordinary conversation requests to Web after delivery lookup misses', async () => {
    const web = fakeWeb()
    const resolveDelivery = vi.fn(async () => undefined)
    const startInsight = vi.fn(async () => studioRun('completed', 'must not run'))
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      startInsight,
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })
    const chunks = await collect(adapter.stream(request()))
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '普通网页回答' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '普通网页回答' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(resolveDelivery).toHaveBeenCalledWith('conversation-session', '当前问题')
    expect(web.controller.start).toHaveBeenCalledOnce()
    expect(startInsight).not.toHaveBeenCalled()
  })

  it('projects marked Harness background before extracting the latest portable user question', async () => {
    const web = fakeWeb()
    const resolveDelivery = vi.fn(async () => undefined)
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })
    const background = `runtime-background-marker:${'R'.repeat(140 * 1024)}`
    const input = {
      ...request(),
      messages: [
        {
          id: 'actual-question' as never,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'EXACT CURRENT QUESTION: Which constraint still applies?' }],
        },
        {
          id: 'generated-runtime-context' as never,
          role: 'user',
          source: {
            kind: 'runtime-context',
            form: 'snapshot',
            sections: [{ name: 'runtime', text: background }],
          } as never,
          content: [{ type: 'text', text: background }],
        },
      ] as GenerateOptions['messages'],
    }
    const before = JSON.stringify(input)

    await collect(adapter.stream(input))

    expect(resolveDelivery).toHaveBeenCalledWith('conversation-session', 'EXACT CURRENT QUESTION: Which constraint still applies?')
    expect(web.controller.start).toHaveBeenCalledOnce()
    const prompt = web.controller.start.mock.calls[0]?.[1].prompt
    expect(prompt).toContain('EXACT CURRENT QUESTION: Which constraint still applies?')
    expect(prompt).not.toContain('runtime-background-marker')
    expect(JSON.stringify(input)).toBe(before)
  })

  it('returns a durable completed delivery without executing either provider route', async () => {
    const web = fakeWeb()
    const resolveDelivery = vi.fn(async () => '# 已完成流程结果')
    const startInsight = vi.fn(async () => studioRun('completed', 'must not run'))
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      startInsight,
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })
    const ordinary = await collect(adapter.stream(request(WEB_LLM_MODEL)))
    const insight = await collect(adapter.stream(request(INSIGHT_LLM_MODEL)))
    expect(ordinary[1]).toEqual({ type: 'text-delta', index: 0, text: '# 已完成流程结果' })
    expect(insight[1]).toEqual({ type: 'text-delta', index: 0, text: '# 已完成流程结果' })
    expect(web.controller.start).not.toHaveBeenCalled()
    expect(startInsight).not.toHaveBeenCalled()
    expect(resolveDelivery).toHaveBeenCalledTimes(2)
  })

  it('starts Insight once, polls the same durable id, and re-entry only inspects', async () => {
    const web = fakeWeb()
    const states = [studioRun('running'), studioRun('pending'), studioRun('completed', '完整洞察 Markdown')]
    const startInsight = vi.fn(async (input) => {
      expect(input.question).toBe('当前问题')
      expect(input.conversationContext).toContain('旧问题')
      expect(input.conversationContext).toContain('当前问题')
      expect(input.id).toMatch(/^[0-9a-f-]{36}$/)
      return states.shift() ?? studioRun('completed', 'unexpected')
    })
    const inspectInsight = vi.fn(async () => states.shift() ?? studioRun('completed', '完整洞察 Markdown'))
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      startInsight,
      inspectInsight,
      insightWaitMs: 100,
      pollMs: 1,
    })
    const first = await collect(adapter.stream(request(INSIGHT_LLM_MODEL)))
    const second = await collect(adapter.stream(request(INSIGHT_LLM_MODEL)))
    expect(first[1]).toEqual({ type: 'text-delta', index: 0, text: '完整洞察 Markdown' })
    expect(second[1]).toEqual({ type: 'text-delta', index: 0, text: '完整洞察 Markdown' })
    expect(startInsight).toHaveBeenCalledOnce()
    expect(inspectInsight).toHaveBeenCalledTimes(3)
  })

  it('surfaces unknown Insight state without restarting and rejects unsupported attachments before delivery', async () => {
    const web = fakeWeb()
    const startInsight = vi.fn(async () => studioRun('unknown', undefined, { message: 'receipt unknown' }))
    const inspectInsight = vi.fn(async () => studioRun('unknown', undefined, { message: 'still unknown' }))
    const resolveDelivery = vi.fn(async () => undefined)
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      startInsight,
      inspectInsight,
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })
    await expect(collect(adapter.stream(request(INSIGHT_LLM_MODEL)))).rejects.toMatchObject({ code: 'WEB_INSIGHT_UNKNOWN' })
    await expect(collect(adapter.stream(request(INSIGHT_LLM_MODEL)))).rejects.toMatchObject({ code: 'WEB_INSIGHT_UNKNOWN' })
    expect(startInsight).toHaveBeenCalledOnce()
    expect(inspectInsight).toHaveBeenCalledOnce()

    await expect(collect(adapter.stream({
      ...request(WEB_LLM_MODEL),
      messages: [{
        id: 'latest-image' as never,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'image', attachment: {} as never }],
      } as never],
    }))).rejects.toMatchObject({ code: 'CHATGPT_WEB_IMAGE_UNSUPPORTED' })
    expect(resolveDelivery).toHaveBeenCalledTimes(2)
    expect(web.controller.start).not.toHaveBeenCalled()
  })
})
