import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, type ImageBlock, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { decodeChatRequest, encodeChatStream, type ModelRoute } from '../src/model-wire.js'

async function collect(chunks: AsyncIterable<string>): Promise<string[]> {
  const result: string[] = []
  for await (const chunk of chunks) result.push(chunk)
  return result
}

function payloads(lines: readonly string[]): unknown[] {
  return lines.map(line => {
    expect(line.startsWith('data: ')).toBe(true)
    const data = line.slice('data: '.length).trim()
    return data === '[DONE]' ? data : JSON.parse(data)
  })
}

function route(overrides: Partial<ModelRoute> = {}): ModelRoute {
  return {
    provider: 'configured-dsh',
    model: 'configured-model',
    reasoningEffort: 'medium',
    maxTokens: 128,
    ...overrides,
  }
}

describe('decodeChatRequest', () => {
  it('maps Prime-compatible history and controls to immutable DSH messages', async () => {
    const resolveImage = vi.fn(async (url: string) => ({
      type: 'image' as const,
      attachment: { url } as unknown as ImageBlock['attachment'],
    }))
    const replayFor = vi.fn((message: unknown) => ({ replayed: message }))

    const decoded = await decodeChatRequest({
      model: 'selected',
      stream: true,
      stream_options: { include_usage: true },
      store: false,
      max_completion_tokens: 512,
      reasoning_effort: 'high',
      temperature: 0,
      stop: ['END', ''],
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Look up a record.',
          parameters: { type: 'object', properties: { id: { type: 'string' } } },
          strict: false,
        },
      }],
      messages: [
        { role: 'system', content: 'system instruction' },
        { role: 'developer', content: 'developer instruction' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'image_url', image_url: { url: 'attachment://diagram' } },
          ],
        },
        {
          role: 'assistant',
          content: null,
          reasoning_content: 'consider the record',
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }],
          tool_calls: [{
            id: 'call_lookup',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_lookup', content: '' },
      ],
    }, route(), { resolveImage, replayFor })

    expect(decoded).toMatchObject({
      provider: 'configured-dsh',
      model: 'configured-model',
      reasoningEffort: 'high',
      maxTokens: 512,
      temperature: 0,
      stop: ['END', ''],
      tools: [{
        name: 'lookup',
        description: 'Look up a record.',
        parameters: { type: 'object', properties: { id: { type: 'string' } } },
      }],
    })
    expect(decoded.messages.map(message => message.role)).toEqual(['system', 'developer', 'user', 'assistant', 'tool'])
    expect(decoded.messages[0]!.source).toMatchObject({ kind: 'system-prompt' })
    expect(decoded.messages[1]!.source).toMatchObject({ kind: 'dsh-solar-rlm/openai-completions', openaiRole: 'developer' })
    expect(decoded.messages[2]!.content).toMatchObject([
      { type: 'text', text: '' },
      { type: 'image' },
    ])
    expect(decoded.messages[3]!).toMatchObject({
      source: {
        kind: 'model',
        provider: 'configured-dsh',
        model: 'configured-model',
      },
      content: [
        { type: 'reasoning', text: 'consider the record' },
        { type: 'tool-call', id: 'call_lookup', name: 'lookup', arguments: '{"id":' },
      ],
    })
    expect((decoded.messages[3]!.source as { replayState?: unknown }).replayState).toMatchObject({
      replayed: { reasoning_details: [{ data: 'opaque' }] },
    })
    expect(decoded.messages[4]!).toMatchObject({
      source: { kind: 'tool', callId: 'call_lookup' },
      toolCallId: 'call_lookup',
      content: [{ type: 'text', text: '' }],
    })
    expect(Object.isFrozen(decoded.messages[3]!)).toBe(true)
    expect(resolveImage).toHaveBeenCalledWith('attachment://diagram')
    expect(replayFor).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed and unsupported behavior while keeping the configured DSH route', async () => {
    const base = { model: 'selected', messages: [] }
    await expect(decodeChatRequest({ ...base, stream: false }, route()))
      .rejects.toThrow('only stream: true')
    await expect(decodeChatRequest({ ...base, top_p: 0.5 }, route()))
      .rejects.toThrow('body.top_p')
    await expect(decodeChatRequest({ ...base, model: '' }, route()))
      .rejects.toThrow('must be a non-empty string')
    await expect(decodeChatRequest({ ...base, max_tokens: 17 }, route())).resolves.toMatchObject({
      provider: 'configured-dsh',
      model: 'configured-model',
      maxTokens: 17,
    })
    await expect(decodeChatRequest({
      ...base,
      messages: [{ role: 'assistant', content: null, reasoning_details: [] }],
    }, route())).rejects.toThrow('requires replayFor')
    await expect(decodeChatRequest({
      ...base,
      messages: [{ role: 'assistant', content: null, reasoning_details: [] }],
    }, route(), { replayFor: () => undefined })).rejects.toThrow('did not return recoverable provider state')
  })

  it('uses the supplied image resolver and refuses image URLs without it', async () => {
    const body = {
      model: 'selected',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }],
      }],
    }
    await expect(decodeChatRequest(body, route())).rejects.toThrow('requires the caller to supply resolveImage')
  })
})

describe('encodeChatStream', () => {
  it('encodes fragmented content and tools once, preserves usage, and finishes as OpenAI SSE', async () => {
    const onFinish = vi.fn()
    const chunks: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'think' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hel' },
      { type: 'text-delta', index: 1, text: 'lo' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), name: 'lookup', argumentsDelta: '{"id":' },
      { type: 'tool-call-delta', index: 2, id: ToolCallId('call-1'), argumentsDelta: '1}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: ToolCallId('call-1'), name: 'lookup', arguments: '{"id":1}' } },
      {
        type: 'usage',
        usage: { inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2, outputTokens: 5, reasoningTokens: 1 },
      },
      { type: 'finish', reason: { kind: 'tool-calls' }, replayState: { response: { cursor: 'opaque' } } },
    ]

    const lines = await collect(encodeChatStream((async function* () { yield* chunks })(), {
      id: 'chatcmpl-test',
      model: 'configured-model',
      onFinish,
    }))
    expect(lines.at(-1)).toBe('data: [DONE]\n\n')

    const events = payloads(lines)
    const chunksOnly = events.filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
    const deltas = chunksOnly
      .flatMap(event => (event.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
      .map(choice => choice.delta)

    expect(deltas.map(delta => delta.content).filter(Boolean)).toEqual(['hel', 'lo'])
    expect(deltas.map(delta => delta.reasoning_content).filter(Boolean)).toEqual(['think'])
    const toolDeltas = deltas.flatMap(delta => (delta.tool_calls as Array<Record<string, unknown>> | undefined) ?? [])
    expect(toolDeltas).toHaveLength(2)
    expect(toolDeltas[0]).toMatchObject({
      index: 0,
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"id":' },
    })
    expect(toolDeltas[1]).toMatchObject({ index: 0, function: { arguments: '1}' } })

    const usage = chunksOnly.find(event => event.usage !== undefined)?.usage as Record<string, unknown>
    expect(usage).toEqual({
      prompt_tokens: 9,
      completion_tokens: 5,
      total_tokens: 14,
      prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    })
    expect(chunksOnly.at(-1)).toMatchObject({ choices: [{ finish_reason: 'tool_calls' }] })
    expect(onFinish).toHaveBeenCalledTimes(1)
    expect(onFinish).toHaveBeenCalledWith(expect.objectContaining({
      replayState: { response: { cursor: 'opaque' } },
      finishReason: 'tool_calls',
      usage: { inputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 2, outputTokens: 5, reasoningTokens: 1 },
    }))
    const completion = onFinish.mock.calls[0]![0].message
    expect(completion).toEqual({
      role: 'assistant',
      content: 'hello',
      reasoning_content: 'think',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"id":1}' },
      }],
    })
  })

  it('round-trips the final OpenAI assistant message into DSH replay state', async () => {
    let finished: { message: unknown; replayState?: unknown } | undefined
    const replayState = { response: { providerCursor: 'opaque' } }
    await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
      yield { type: 'reasoning-delta', index: 1, text: 'because' }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'because' } }
      yield { type: 'tool-call-delta', index: 2, id: ToolCallId('call-roundtrip'), name: 'inspect', argumentsDelta: '{"a":' }
      yield { type: 'tool-call-delta', index: 2, id: ToolCallId('call-roundtrip'), argumentsDelta: '1}' }
      yield {
        type: 'block-end',
        index: 2,
        block: { type: 'tool-call', id: ToolCallId('call-roundtrip'), name: 'inspect', arguments: '{"a":1}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' }, replayState }
    })(), {
      id: 'chatcmpl-roundtrip',
      model: 'selected',
      onFinish: value => { finished = value },
    }))

    expect(finished).toBeDefined()
    const replayFor = vi.fn(() => replayState)
    const decoded = await decodeChatRequest({ model: 'selected', messages: [finished!.message] }, route(), { replayFor })
    expect(replayFor).toHaveBeenCalledWith(finished!.message)
    expect(decoded.messages[0]!).toMatchObject({
      role: 'assistant',
      source: { provider: 'configured-dsh', model: 'configured-model', replayState },
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'because' },
        { type: 'tool-call', id: 'call-roundtrip', name: 'inspect', arguments: '{"a":1}' },
      ],
    })
  })

  it('emits full content for block-end-only chunks without requiring a synthetic delta', async () => {
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'block-end', index: 9, block: { type: 'text', text: 'full block' } }
      yield {
        type: 'block-end',
        index: 13,
        block: { type: 'tool-call', id: ToolCallId('call-only'), name: 'inspect', arguments: '{}' },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(), { id: 'chatcmpl-block-only', model: 'configured-model' }))
    const events = payloads(lines)
    const data = events.filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
    const deltas = data.flatMap(event => event.choices as Array<{ delta: Record<string, unknown> }>)
      .map(choice => choice.delta)
    expect(deltas).toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'full block' }),
      expect.objectContaining({
        tool_calls: [expect.objectContaining({
          id: 'call-only',
          function: { name: 'inspect', arguments: '{}' },
        })],
      }),
    ]))
  })

  it('does not turn terminal DSH errors or aborts into successful finish frames', async () => {
    const onFinish = vi.fn()
    const errorStream = encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'upstream failed' } } }
    })(), { id: 'error', model: 'configured-model', onFinish })
    await expect(collect(errorStream)).rejects.toThrow('upstream failed')

    const abortStream = encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }
    })(), { id: 'aborted', model: 'configured-model', onFinish })
    await expect(collect(abortStream)).rejects.toThrow('cancelled')
    expect(onFinish).not.toHaveBeenCalled()
  })
})
