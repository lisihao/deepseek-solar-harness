import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { localIpcAddress } from '@deepseek-ai/dsh-home-paths'
import LlmRuntime, {
  CallId,
  LlmAdapter,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type RequestAdmission,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import ModelWorkerRuntime, { type ModelWorkerEvaluationV1 } from '@deepseek-ai/dsh-model-worker'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import apply, { DEEPSEEK_WORKER_ID } from '../src/index.ts'

/** Records the options of every call; calls its admission the way the real adapter does, so the labels are observable. */
class MeteredFixture extends LlmAdapter {
  override readonly enforcesAdmission = true
  readonly requests: GenerateOptions[] = []

  override providerInfo() { return { id: 'deepseek-official', name: 'DeepSeek fixture' } }

  /** Offers the effort the scope asks for, with no default, so only a request that names one carries one. */
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const high = ReasoningEffortId('high')
    return Promise.resolve({ provider, id: model, name: model, reasoning: { efforts: [{ id: high, name: 'high' }] } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    options.admission?.({
      model: options.model, bodyBytes: 10, bodySha256: 'b'.repeat(64), maxOutputTokens: options.maxTokens,
      thinking: 'enabled', reasoningEffort: 'high', hasNonTextContent: false,
    })
    if (options.tools !== undefined && this.requests.length === 1) {
      const id = CallId('fixture-tool-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'typescript_repl', arguments: '{"code":"1"}' } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class UnmeteredFixture extends LlmAdapter {
  calls = 0
  override providerInfo() { return { id: 'deepseek-official', name: 'unmetered' } }
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    await Promise.resolve()
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(() => { vi.unstubAllEnvs() })

async function setup(adapter: LlmAdapter) {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelWorkerRuntime)
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  await ctx.plugin(apply)
  return ctx
}

function evaluation(remaining: () => number, labels: string[]): ModelWorkerEvaluationV1 {
  const admission = (label: string): RequestAdmission => {
    labels.push(label)
    return () => ({ settle: () => undefined, abandon: () => undefined })
  }
  return { model: 'deepseek-v4-flash', maxOutputTokens: 100, reasoningEffort: 'high', remainingOutputTokens: remaining, admission }
}

describe('DeepSeekModelWorker under an evaluation scope', () => {
  it('names the scope model, effort, ceiling, and a per-request admission on a plain request', async () => {
    const adapter = new MeteredFixture()
    const ctx = await setup(adapter)
    const labels: string[] = []
    const result = await ctx.modelWorkers.execute({
      commandId: 'cmd', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro', prompt: [{ type: 'text', text: 'hi' }],
      evaluation: evaluation(() => 250, labels), signal: new AbortController().signal,
    })
    expect(result.stopReason).toBe('completed')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ model: 'deepseek-v4-flash', maxTokens: 100, reasoningEffort: 'high' })
    expect(typeof adapter.requests[0]?.admission).toBe('function')
    expect(labels).toEqual(['cmd#plain'])
    await ctx.root.fiber.dispose()
  })

  it('lowers the ceiling to what is left, and never below 1, so an exhausted scope is refused rather than defaulted', async () => {
    const adapter = new MeteredFixture()
    const ctx = await setup(adapter)
    for (const remaining of [37, 0]) {
      await ctx.modelWorkers.execute({
        commandId: 'cmd', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro', prompt: [{ type: 'text', text: 'hi' }],
        evaluation: evaluation(() => remaining, []), signal: new AbortController().signal,
      })
    }
    expect(adapter.requests.map(request => request.maxTokens)).toEqual([37, 1])
    await ctx.root.fiber.dispose()
  })

  it('gives each round of a tool loop its own admission and the same limits, and the scope model in the history', async () => {
    const adapter = new MeteredFixture()
    const ctx = await setup(adapter)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-deepseek-eval-bridge-'))
    const socketPath = localIpcAddress(directory, 'bridge')
    const server = createServer((socket) => {
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.onRequest(() => Promise.resolve({ value: 2 }))
      transport.start()
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve) })
    try {
      const labels: string[] = []
      const result = await ctx.modelWorkers.execute({
        commandId: 'cmd', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro', prompt: [{ type: 'text', text: 'go' }],
        rlmPlan: { enabled: true, maxTurns: 4 } as never,
        modelToolBridge: {
          version: 1, socketPath, sessionId: 's',
          tools: [{ name: 'typescript_repl', description: 'repl', inputSchema: { type: 'object' } }],
        },
        evaluation: evaluation(() => 250, labels), signal: new AbortController().signal,
      })
      expect(result.stopReason).toBe('completed')
      expect(labels).toEqual(['cmd#round0', 'cmd#round1'])
      expect(adapter.requests.map(request => [request.model, request.maxTokens, request.reasoningEffort])).toEqual([
        ['deepseek-v4-flash', 100, 'high'], ['deepseek-v4-flash', 100, 'high'],
      ])
      const history = adapter.requests[1]?.messages.find(message => message.role === 'assistant')
      expect(history?.source).toMatchObject({ kind: 'model', model: 'deepseek-v4-flash' })
    } finally {
      server.close()
      await rm(directory, { recursive: true, force: true })
      await ctx.root.fiber.dispose()
    }
  })

  it('does not meter, cap, or retarget a request that has no scope', async () => {
    const adapter = new MeteredFixture()
    const ctx = await setup(adapter)
    await ctx.modelWorkers.execute({
      commandId: 'cmd', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro', prompt: [{ type: 'text', text: 'hi' }],
      signal: new AbortController().signal,
    })
    const [request] = adapter.requests
    expect(request?.model).toBe('deepseek-v4-pro')
    expect(request).not.toHaveProperty('admission')
    expect(request).not.toHaveProperty('maxTokens')
    expect(request).not.toHaveProperty('reasoningEffort')
    await ctx.root.fiber.dispose()
  })

  it('fails a scoped request on a provider that cannot enforce admission, instead of sending it unmetered', async () => {
    const adapter = new UnmeteredFixture()
    const ctx = await setup(adapter)
    const result = await ctx.modelWorkers.execute({
      commandId: 'cmd', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro', prompt: [{ type: 'text', text: 'hi' }],
      evaluation: evaluation(() => 250, []), signal: new AbortController().signal,
    })
    expect(result.stopReason).toBe('error')
    expect(adapter.calls).toBe(0)
    await ctx.root.fiber.dispose()
  })
})
