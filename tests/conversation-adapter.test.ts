import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  ConversationWebAdapter,
  GROK_LLM_MODEL,
  GROK_LLM_NAME,
  INSIGHT_LLM_MODEL,
  INSIGHT_LLM_NAME,
} from '../incubator/chatgpt-web/src/conversation-adapter.js'
import type { GrokExecutionPort, GrokRequest, GrokRunRecord } from '../incubator/chatgpt-web/src/grok-contract.js'
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

function grokRecord(
  request: GrokRequest,
  stage: GrokRunRecord['stage'] = 'completed',
  text = 'Grok 可见文本回答',
  overrides: Partial<GrokRunRecord> = {},
): GrokRunRecord {
  const timestamp = '2026-10-24T00:00:00.000Z'
  return {
    formatVersion: 1,
    revision: 1,
    id: request.id,
    createdAt: timestamp,
    updatedAt: timestamp,
    request,
    stage,
    ...(stage === 'completed' ? { output: { text, sha256: 'a'.repeat(64) } } : {}),
    ...overrides,
  }
}

function fakeGrok(overrides: Partial<{
  start: GrokExecutionPort['start']
  observe: GrokExecutionPort['observe']
  read: GrokExecutionPort['read']
}> = {}): {
  port: GrokExecutionPort & {
    start: ReturnType<typeof vi.fn>
    observe: ReturnType<typeof vi.fn>
    read: ReturnType<typeof vi.fn>
  }
} {
  const requests = new Map<string, GrokRequest>()
  const port = {
    start: vi.fn(async (input: GrokRequest) => {
      requests.set(input.id, input)
      return grokRecord(input)
    }),
    observe: vi.fn(async (id: string) => {
      const request = requests.get(id)
      if (!request) throw new Error('fixture does not know this Grok request')
      return grokRecord(request)
    }),
    read: vi.fn(async () => undefined),
    ...overrides,
  } as GrokExecutionPort & {
    start: ReturnType<typeof vi.fn>
    observe: ReturnType<typeof vi.fn>
    read: ReturnType<typeof vi.fn>
  }
  return { port }
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

  it('advertises and resolves Grok only when its independent execution port exists', async () => {
    const web = fakeWeb()
    const grok = fakeGrok()
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      grok: grok.port,
      grokModelLabel: 'Expert',
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      insightWaitMs: 20,
      pollMs: 1,
    })

    await expect(adapter.listModels(WEB_LLM_PROVIDER)).resolves.toEqual([
      { provider: WEB_LLM_PROVIDER, id: WEB_LLM_MODEL, name: 'ChatGPT 网页算子' },
      { provider: WEB_LLM_PROVIDER, id: INSIGHT_LLM_MODEL, name: INSIGHT_LLM_NAME },
      { provider: WEB_LLM_PROVIDER, id: GROK_LLM_MODEL, name: GROK_LLM_NAME },
    ])
    await expect(adapter.resolveModel(WEB_LLM_PROVIDER, GROK_LLM_MODEL)).resolves.toEqual({
      provider: WEB_LLM_PROVIDER,
      id: GROK_LLM_MODEL,
      name: GROK_LLM_NAME,
    })

    const withoutGrok = new ConversationWebAdapter({
      web: web.adapter,
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      insightWaitMs: 20,
      pollMs: 1,
    })
    await expect(withoutGrok.resolveModel(WEB_LLM_PROVIDER, GROK_LLM_MODEL)).rejects.toMatchObject({ code: 'CHATGPT_WEB_MODEL_INVALID' })
  })

  it('allows default model selection to follow the target browser without inventing a label', async () => {
    const web = fakeWeb()
    const grok = fakeGrok()
    const adapter = new ConversationWebAdapter({
      web: web.adapter, grok: grok.port, startInsight: vi.fn(), inspectInsight: vi.fn(), insightWaitMs: 20, pollMs: 1,
    })
    await collect(adapter.stream(request(GROK_LLM_MODEL)))
    expect(grok.port.start.mock.calls[0]?.[0]).not.toHaveProperty('modelLabel')
    await expect(adapter.listModels(WEB_LLM_PROVIDER)).resolves.toHaveLength(3)
  })

  it('routes Grok before Studio delivery, logs its durable identity, and does not map native effort into a webpage label', async () => {
    const web = fakeWeb()
    const order: string[] = []
    const grok = fakeGrok({
      start: vi.fn(async (input: GrokRequest) => {
        order.push('start')
        return grokRecord(input)
      }),
    })
    const resolveDelivery = vi.fn(async () => '# an old Web or Insight delivery that must not answer Grok')
    const onGrokRequest = vi.fn(async (_sessionId: string, _text: string) => { order.push('log') })
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      grok: grok.port,
      grokModelLabel: 'Expert',
      onGrokRequest,
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })

    const chunks = await collect(adapter.stream({ ...request(GROK_LLM_MODEL), reasoningEffort: 'high' as never }))

    expect(chunks[1]).toEqual({ type: 'text-delta', index: 0, text: 'Grok 可见文本回答' })
    expect(resolveDelivery).not.toHaveBeenCalled()
    expect(grok.port.start).toHaveBeenCalledOnce()
    expect(order).toEqual(['log', 'start'])
    const grokRequest = grok.port.start.mock.calls[0]?.[0] as GrokRequest | undefined
    expect(grokRequest).toMatchObject({ sessionId: 'conversation-session', modelLabel: 'Expert' })
    expect(grokRequest?.canonical).toContain('"provider":"solar-chatgpt-web"')
    expect(grokRequest?.canonical).toContain('"model":"grok-web"')
    expect(grokRequest).not.toHaveProperty('effortLabel')
    expect(grokRequest?.prompt).toContain('"modelLabel":"Expert"')
    expect(grokRequest?.prompt).not.toContain('effortLabel')
    expect(onGrokRequest).toHaveBeenCalledOnce()
    const [loggedSession, loggedText] = onGrokRequest.mock.calls[0] ?? []
    expect(loggedSession).toBe('conversation-session')
    expect(JSON.parse(loggedText as string)).toEqual({
      kind: 'grok-request',
      id: grokRequest?.id,
      model: 'Expert',
      prompt: grokRequest?.prompt,
      canonical: grokRequest?.canonical,
    })
  })

  it('uses the portable request projection for Grok and rejects compaction before any Grok or Studio effect', async () => {
    const web = fakeWeb()
    const grok = fakeGrok()
    const resolveDelivery = vi.fn(async () => undefined)
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      grok: grok.port,
      grokModelLabel: 'Auto',
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })
    const runtimeBackground = `runtime-background-marker:${'R'.repeat(140 * 1024)}`
    const input = {
      ...request(GROK_LLM_MODEL),
      messages: [
        {
          id: 'actual-user' as never,
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'GROK PORTABLE USER QUESTION' }],
        },
        {
          id: 'explicit-instructions' as never,
          role: 'system',
          source: { kind: 'user-explicit-instructions', form: 'instructions' } as never,
          content: [{ type: 'text', text: 'GROK EXPLICIT INSTRUCTION RETAIN' }],
        },
        {
          id: 'runtime-background' as never,
          role: 'user',
          source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'runtime', text: runtimeBackground }] } as never,
          content: [{ type: 'text', text: runtimeBackground }],
        },
      ] as GenerateOptions['messages'],
    }
    const before = JSON.stringify(input)

    await collect(adapter.stream(input))
    const submitted = grok.port.start.mock.calls[0]?.[0] as GrokRequest | undefined
    expect(submitted?.prompt).toContain('GROK PORTABLE USER QUESTION')
    expect(submitted?.prompt).toContain('GROK EXPLICIT INSTRUCTION RETAIN')
    expect(submitted?.prompt).not.toContain('runtime-background-marker')
    expect(JSON.stringify(input)).toBe(before)
    expect(resolveDelivery).not.toHaveBeenCalled()

    await expect(collect(adapter.stream({ ...request(GROK_LLM_MODEL), purpose: 'compaction' as never }))).rejects.toMatchObject({ code: 'WEB_PURPOSE_UNSUPPORTED' })
    expect(grok.port.start).toHaveBeenCalledOnce()
    expect(grok.port.read).toHaveBeenCalledOnce()
    expect(resolveDelivery).not.toHaveBeenCalled()
  })

  it('keeps the Grok id stable on re-entry and observes an already durable record without re-logging or starting', async () => {
    const web = fakeWeb()
    const grok = fakeGrok()
    const onGrokRequest = vi.fn(async (_sessionId: string, _text: string) => undefined)
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      grok: grok.port,
      grokModelLabel: 'Build',
      onGrokRequest,
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      insightWaitMs: 20,
      pollMs: 1,
    })

    await collect(adapter.stream(request(GROK_LLM_MODEL)))
    await collect(adapter.stream(request(GROK_LLM_MODEL)))
    expect(grok.port.start).toHaveBeenCalledOnce()
    expect(grok.port.observe).toHaveBeenCalledOnce()
    expect(grok.port.observe.mock.calls[0]?.[0]).toBe(grok.port.start.mock.calls[0]?.[0]?.id)
    expect(onGrokRequest).toHaveBeenCalledOnce()

    const existing = fakeGrok()
    const original = grok.port.start.mock.calls[0]?.[0] as GrokRequest
    existing.port.read.mockImplementation(async () => grokRecord(original, 'completed', '已存在的 Grok 回答'))
    existing.port.observe.mockImplementation(async () => grokRecord(original, 'completed', '已存在的 Grok 回答'))
    const existingLog = vi.fn(async () => undefined)
    const recovered = new ConversationWebAdapter({
      web: web.adapter,
      grok: existing.port,
      grokModelLabel: 'Build',
      onGrokRequest: existingLog,
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      insightWaitMs: 20,
      pollMs: 1,
    })
    const recoveredChunks = await collect(recovered.stream(request(GROK_LLM_MODEL)))
    expect(recoveredChunks[1]).toEqual({ type: 'text-delta', index: 0, text: '已存在的 Grok 回答' })
    expect(existing.port.start).not.toHaveBeenCalled()
    expect(existing.port.observe).toHaveBeenCalledOnce()
    expect(existingLog).not.toHaveBeenCalled()

    const foreign = fakeGrok({ read: vi.fn(async () => grokRecord({ ...original, canonical: 'foreign-canonical' })) })
    const conflict = new ConversationWebAdapter({
      web: web.adapter, grok: foreign.port, grokModelLabel: 'Build',
      startInsight: vi.fn(), inspectInsight: vi.fn(), insightWaitMs: 20, pollMs: 1,
    })
    await expect(collect(conflict.stream(request(GROK_LLM_MODEL)))).rejects.toMatchObject({ code: 'GROK_COMMAND_ID_CONFLICT' })
    expect(foreign.port.start).not.toHaveBeenCalled()
    expect(foreign.port.observe).not.toHaveBeenCalled()
  })

  it('surfaces an unknown Grok result without a resend and never asks Studio to resolve a different route', async () => {
    const web = fakeWeb()
    let original: GrokRequest | undefined
    const grok = fakeGrok({
      start: vi.fn(async (input: GrokRequest) => {
        original = input
        return grokRecord(input, 'indeterminate', '', { error: { code: 'GROK_TIMEOUT', message: 'fixture timeout' } })
      }),
      observe: vi.fn(async () => {
        if (!original) throw new Error('fixture original request is missing')
        return grokRecord(original, 'indeterminate', '', { error: { code: 'GROK_TIMEOUT', message: 'fixture timeout' } })
      }),
    })
    const resolveDelivery = vi.fn(async () => '# must not be used for Grok')
    const onGrokRequest = vi.fn(async (_sessionId: string, _text: string) => undefined)
    const adapter = new ConversationWebAdapter({
      web: web.adapter,
      grok: grok.port,
      grokModelLabel: 'Heavy',
      onGrokRequest,
      startInsight: vi.fn(async () => studioRun('completed', 'must not run')),
      inspectInsight: vi.fn(async () => studioRun('completed', 'must not inspect')),
      resolveDelivery,
      insightWaitMs: 20,
      pollMs: 1,
    })

    await expect(collect(adapter.stream(request(GROK_LLM_MODEL)))).rejects.toMatchObject({ code: 'GROK_RUN_INDETERMINATE' })
    await expect(collect(adapter.stream(request(GROK_LLM_MODEL)))).rejects.toMatchObject({ code: 'GROK_RUN_INDETERMINATE' })
    expect(grok.port.start).toHaveBeenCalledOnce()
    expect(grok.port.observe).toHaveBeenCalledOnce()
    expect(onGrokRequest).toHaveBeenCalledOnce()
    expect(resolveDelivery).not.toHaveBeenCalled()
  })
})
