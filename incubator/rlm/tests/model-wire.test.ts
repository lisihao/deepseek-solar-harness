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
    expect(toolDeltas).toHaveLength(1)
    expect(toolDeltas[0]).toMatchObject({
      index: 0,
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup', arguments: '{"id":1}' },
    })

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

  it('buffers reasoning until block-end and emits the authoritative final text exactly once', async () => {
    let finished: { message: unknown } | undefined
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'draft reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: ' with a provisional ending' }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'reasoning', text: 'authoritative reasoning\n\n' },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(), {
      id: 'chatcmpl-authoritative-reasoning',
      model: 'configured-model',
      onFinish: value => { finished = value },
    }))

    const events = payloads(lines).filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
    const deltas = events
      .flatMap(event => (event.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
      .map(choice => choice.delta)
    const reasoning = deltas.map(delta => delta.reasoning_content).filter((value): value is string => typeof value === 'string')

    expect(reasoning).toEqual(['authoritative reasoning\n\n'])
    expect(finished?.message).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'authoritative reasoning\n\n',
    })
    expect(reasoning.join('')).toBe((finished?.message as { reasoning_content: string }).reasoning_content)
  })

  it('flushes buffered reasoning once when finish arrives without block-end', async () => {
    let finished: { message: unknown } | undefined
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'reasoning-delta', index: 0, text: 'buffered reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: ' with no close' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(), {
      id: 'chatcmpl-reasoning-flush',
      model: 'configured-model',
      onFinish: value => { finished = value },
    }))

    const events = payloads(lines).filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
    const reasoning = events
      .flatMap(event => (event.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
      .map(choice => choice.delta.reasoning_content)
      .filter((value): value is string => typeof value === 'string')

    expect(reasoning).toEqual(['buffered reasoning with no close'])
    expect(finished?.message).toEqual({
      role: 'assistant',
      content: null,
      reasoning_content: 'buffered reasoning with no close',
    })
  })

  it('keeps the first reasoning block close and ignores duplicate closes', async () => {
    let finished: { message: unknown } | undefined
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'reasoning-delta', index: 0, text: 'draft' }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first final\n' } }
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'second final\n' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(), {
      id: 'chatcmpl-reasoning-close-once',
      model: 'configured-model',
      onFinish: value => { finished = value },
    }))

    const events = payloads(lines).filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
    const reasoning = events
      .flatMap(event => (event.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
      .map(choice => choice.delta.reasoning_content)
      .filter((value): value is string => typeof value === 'string')

    expect(reasoning).toEqual(['first final\n'])
    expect(finished?.message).toMatchObject({ reasoning_content: 'first final\n' })
  })

  it('still rejects text that does not extend streamed deltas', async () => {
    await expect(collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'draft text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'revised text' } }
    })(), { id: 'chatcmpl-text-mismatch', model: 'configured-model' }))).rejects
      .toThrow('does not extend its emitted delta')
  })

  it('emits only authoritative tool arguments after JSON serialization changes', async () => {
    let finished: { message: unknown } | undefined
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-normalized'), name: 'python_repl', argumentsDelta: '{"code": ' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('call-normalized'), argumentsDelta: '"print(42)"}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('call-normalized'), name: 'python_repl', arguments: '{"code":"print(42)"}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(), { id: 'normalized', model: 'configured-model', onFinish: value => { finished = value } }))
    const tools = payloads(lines).filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
      .flatMap(event => (event.choices as Array<{ delta: { tool_calls?: unknown[] } }> | undefined) ?? [])
      .flatMap(choice => choice.delta.tool_calls ?? [])
    expect(tools).toEqual([{ index: 0, id: 'call-normalized', type: 'function', function: { name: 'python_repl', arguments: '{"code":"print(42)"}' } }])
    expect(finished?.message).toMatchObject({ tool_calls: [{ id: 'call-normalized', function: { arguments: '{"code":"print(42)"}' } }] })
  })

  it('preserves interleaved tool indexes, first close and authoritative revisions', async () => {
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'tool-call-delta', index: 8, id: ToolCallId('first'), name: 'inspect', argumentsDelta: '{"draft":' }
      yield { type: 'tool-call-delta', index: 3, id: ToolCallId('second'), argumentsDelta: '{"b": 2}' }
      yield { type: 'block-end', index: 3, block: { type: 'tool-call', id: ToolCallId('second'), name: 'inspect', arguments: '{"b":2}' } }
      yield { type: 'block-end', index: 8, block: { type: 'tool-call', id: ToolCallId('first'), name: 'inspect', arguments: '{"a":1}' } }
      yield { type: 'tool-call-delta', index: 8, id: ToolCallId('ignored'), argumentsDelta: 'ignored' }
      yield { type: 'block-end', index: 8, block: { type: 'tool-call', id: ToolCallId('ignored'), name: 'ignored', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(), { id: 'interleaved', model: 'configured-model' }))
    const tools = payloads(lines).filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
      .flatMap(event => (event.choices as Array<{ delta: { tool_calls?: unknown[] } }> | undefined) ?? [])
      .flatMap(choice => choice.delta.tool_calls ?? [])
    expect(tools).toEqual([
      { index: 1, id: 'second', type: 'function', function: { name: 'inspect', arguments: '{"b":2}' } },
      { index: 0, id: 'first', type: 'function', function: { name: 'inspect', arguments: '{"a":1}' } },
    ])
  })

  it('flushes delta-only tool arguments once on successful finish', async () => {
    const onFinish = vi.fn()
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('delta-only'), name: 'inspect', argumentsDelta: '{"a":' }
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('delta-only'), argumentsDelta: '1}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    })(), { id: 'delta-only', model: 'configured-model', onFinish }))
    const tools = payloads(lines).filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
      .flatMap(event => (event.choices as Array<{ delta: { tool_calls?: unknown[] } }> | undefined) ?? [])
      .flatMap(choice => choice.delta.tool_calls ?? [])
    expect(tools).toEqual([{ index: 0, id: 'delta-only', type: 'function', function: { name: 'inspect', arguments: '{"a":1}' } }])
    expect(onFinish).toHaveBeenCalledTimes(1)
  })

  it.each(['id', 'name'] as const)('still rejects a changed tool %s', async field => {
    await expect(collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('stable'), name: 'inspect', argumentsDelta: '{}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(field === 'id' ? 'changed' : 'stable'), name: field === 'name' ? 'changed' : 'inspect', arguments: '{}' } }
    })(), { id: 'identity', model: 'configured-model' }))).rejects.toThrow(`changed tool call ${field}`)
  })

  it.each(['error', 'aborted'] as const)('does not flush provisional tool arguments on %s', async kind => {
    const lines: string[] = []
    const onFinish = vi.fn()
    await expect((async () => {
      for await (const line of encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'tool-call-delta', index: 0, id: ToolCallId('unfinished'), name: 'inspect', argumentsDelta: '{"a":' }
        yield { type: 'finish', reason: { kind, failure: { code: 'FAILED', message: 'stopped' } } }
      })(), { id: 'unfinished', model: 'configured-model', onFinish })) lines.push(line)
    })()).rejects.toThrow('stopped')
    expect(lines).toEqual([])
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('round-trips the final OpenAI assistant message into DSH replay state', async () => {
    let finished: { message: unknown; replayState?: unknown } | undefined
    const replayState = { response: { providerCursor: 'opaque' } }
    const lines = await collect(encodeChatStream((async function* (): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: 'answer' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
      yield { type: 'reasoning-delta', index: 1, text: 'provisional reasoning' }
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'authoritative reasoning\n\n' } }
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
    const reasoning = payloads(lines)
      .filter((event): event is Record<string, unknown> => typeof event === 'object' && event !== null)
      .flatMap(event => (event.choices as Array<{ delta: Record<string, unknown> }> | undefined) ?? [])
      .map(choice => choice.delta.reasoning_content)
      .filter((value): value is string => typeof value === 'string')
    expect(reasoning.join('')).toBe((finished!.message as { reasoning_content: string }).reasoning_content)
    const replayFor = vi.fn(() => replayState)
    const decoded = await decodeChatRequest({ model: 'selected', messages: [finished!.message] }, route(), { replayFor })
    expect(replayFor).toHaveBeenCalledWith(finished!.message)
    expect(decoded.messages[0]!).toMatchObject({
      role: 'assistant',
      source: { provider: 'configured-dsh', model: 'configured-model', replayState },
      content: [
        { type: 'text', text: 'answer' },
        { type: 'reasoning', text: 'authoritative reasoning\n\n' },
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
