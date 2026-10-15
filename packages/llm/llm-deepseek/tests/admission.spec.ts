import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  ADMISSION_REFUSED_CODE,
  createUserMessage,
  LlmAdapter,
  ReasoningEffortId,
  LlmError,
  type GenerateOptions,
  type RequestAdmission,
  type RequestAdmissionInput,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'
import type { Behavior } from './mock-server.ts'

let testHome: string

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-deepseek-admission-'))
  vi.stubEnv('DSH_HOME', testHome)
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
})

afterEach(async () => {
  await closeMockServers()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
})

async function harness(baseURL: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmDeepSeek, { baseURL })
  return ctx
}

/** What an admission did, in order: the facts it was given, then whether its ticket was settled or abandoned. */
interface Trace {
  readonly inputs: RequestAdmissionInput[]
  readonly events: string[]
  readonly settled: TokenUsage[]
}

function admissionTrace(refuse?: string): { readonly admission: RequestAdmission; readonly trace: Trace } {
  const trace: Trace = { inputs: [], events: [], settled: [] }
  const admission: RequestAdmission = (input) => {
    trace.inputs.push(input)
    trace.events.push('admit')
    if (refuse !== undefined) throw new LlmError(refuse, ADMISSION_REFUSED_CODE)
    return {
      settle: (usage) => { trace.events.push('settle'); trace.settled.push(usage) },
      abandon: () => { trace.events.push('abandon') },
    }
  }
  return { admission, trace }
}

async function drain(ctx: Context, options: Partial<GenerateOptions>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    messages: [createUserMessage({ content: [{ type: 'text', text: 'héllo 世界' }], source: { kind: 'plugin', plugin: 'test' } })],
    ...options,
  })) {
    chunks.push(chunk)
  }
  return chunks
}

describe('request admission at the DeepSeek adapter', () => {
  it('is given the facts of the serialized request, matching the body the server received', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const { admission, trace } = admissionTrace()
    await drain(ctx, { admission, maxTokens: 777, reasoningEffort: ReasoningEffortId('high') })
    expect(server.requests).toHaveLength(1)
    const received = JSON.stringify(server.requests[0])
    const [input] = trace.inputs
    expect(input).toMatchObject({
      model: 'deepseek-v4-flash', maxOutputTokens: 777, thinking: 'enabled', reasoningEffort: 'high', hasNonTextContent: false,
    })
    expect(input?.bodySha256).toBe(createHash('sha256').update(received).digest('hex'))
    // The input bound counts bytes, not characters: the message has multibyte characters.
    expect(input?.bodyBytes).toBe(Buffer.byteLength(received, 'utf8'))
    expect(input?.bodyBytes).toBeGreaterThan(received.length)
  })

  it('records usage before the usage chunk reaches the consumer, and nothing else', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const { admission, trace } = admissionTrace()
    const seen: string[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
      admission,
      maxTokens: 50,
    })) {
      if (chunk.type === 'usage') seen.push(`usage-after:${trace.events.join(',')}`)
    }
    expect(seen).toEqual(['usage-after:admit,settle'])
    expect(trace.settled).toEqual([{ inputTokens: 3, outputTokens: 1 }])
    expect(trace.events).toEqual(['admit', 'settle'])
  })

  it('refuses before anything is sent: a refused request makes no HTTP request', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const { admission, trace } = admissionTrace('scope exhausted')
    const chunks = await drain(ctx, { admission, maxTokens: 50 })
    expect(server.requests).toHaveLength(0)
    expect(trace.events).toEqual(['admit'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: ADMISSION_REFUSED_CODE } } })
  })

  const endings: readonly [string, Behavior, Partial<GenerateOptions> | 'abort' | 'stop-reading'][] = [
    ['an HTTP error status', { kind: 'http-error', status: 500, body: '{"error":{"message":"boom"}}' }, {}],
    ['a 4xx status, which is not proof that nothing was billed', { kind: 'http-error', status: 400, body: '{"error":{"message":"bad"}}' }, {}],
    ['a stream cut before [DONE]', { kind: 'close-early', events: textEvents.slice(0, 2) }, {}],
    ['[DONE] without usage', {
      kind: 'sse',
      events: [textEvents[0]!, textEvents[1]!, '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}', '[DONE]'],
    }, {}],
    ['a caller abort in mid-stream', { kind: 'sse', events: textEvents, delayMs: 40 }, 'abort'],
    ['a consumer that stops reading', { kind: 'sse', events: textEvents }, 'stop-reading'],
  ]
  it.each(endings)('keeps the reservation as unknown after %s: the ticket is abandoned and never settled', async (_name, behavior, mode) => {
    const server = await mockServer([behavior])
    const ctx = await harness(server.url)
    const { admission, trace } = admissionTrace()
    const controller = new AbortController()
    const iterator = ctx.llm.stream({
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'plugin', plugin: 'test' } })],
      admission,
      maxTokens: 50,
      signal: controller.signal,
    })[Symbol.asyncIterator]()
    if (mode === 'abort') setTimeout(() => { controller.abort() }, 20)
    for (;;) {
      const next = await iterator.next()
      if (next.done === true) break
      // A consumer that stops reading does so at the first text it receives, before [DONE].
      if (mode === 'stop-reading' && next.value.type === 'text-delta') {
        await iterator.return?.()
        break
      }
    }
    expect(trace.events).toEqual(['admit', 'abandon'])
    expect(trace.settled).toEqual([])
  })

  it('shows the admission the default max_tokens that would otherwise be sent, instead of hiding it', async () => {
    const server = await mockServer([{ kind: 'sse', events: textEvents }])
    const ctx = await harness(server.url)
    const { admission, trace } = admissionTrace()
    await drain(ctx, { admission })
    const sent = (server.requests[0] as { max_tokens?: number }).max_tokens
    expect(trace.inputs[0]?.maxOutputTokens).toBe(sent)
  })
})

describe('a redirect under an admission', () => {
  it.each([307, 308])('is not followed on a %i: the POST is not sent again to the other endpoint, and the reservation stays held', async (status) => {
    const target = await mockServer([{ kind: 'sse', events: textEvents }])
    const origin = await mockServer([{
      kind: 'http-error', status, body: '', headers: { location: `${target.url}/chat/completions` },
    }])
    const ctx = await harness(origin.url)
    const { admission, trace } = admissionTrace()
    const chunks = await drain(ctx, { admission, maxTokens: 50 })
    expect(origin.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(0)
    expect(trace.events).toEqual(['admit', 'abandon'])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
  })

  it('is still followed by a call that carries no admission, as before', async () => {
    const target = await mockServer([{ kind: 'sse', events: textEvents }])
    const origin = await mockServer([{
      kind: 'http-error', status: 307, body: '', headers: { location: `${target.url}/chat/completions` },
    }])
    const ctx = await harness(origin.url)
    await drain(ctx, { maxTokens: 50 })
    expect(origin.requests).toHaveLength(1)
    expect(target.requests).toHaveLength(1)
  })
})

describe('an adapter that cannot enforce admission', () => {
  class Unmetered extends LlmAdapter {
    called = 0
    async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.called += 1
      await Promise.resolve()
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }

  it('fails a call that carries an admission before the adapter is reached', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new Unmetered()
    ctx.llm.registerAdapter(['unmetered'], adapter)
    const { admission, trace } = admissionTrace()
    const chunks = await drain(ctx, { provider: 'unmetered', admission })
    expect(adapter.called).toBe(0)
    expect(trace.events).toEqual([])
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: ADMISSION_REFUSED_CODE } } })
  })

  it('still runs a call that carries none', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new Unmetered()
    ctx.llm.registerAdapter(['unmetered'], adapter)
    await drain(ctx, { provider: 'unmetered' })
    expect(adapter.called).toBe(1)
  })
})
