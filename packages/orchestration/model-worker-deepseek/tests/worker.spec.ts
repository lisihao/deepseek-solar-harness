import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { localIpcAddress } from '@deepseek-ai/dsh-home-paths'
import LlmRuntime, { CallId, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelWorkerRuntime from '@deepseek-ai/dsh-model-worker'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import apply, { DEEPSEEK_WORKER_ID } from '../src/index.ts'

class FixtureAdapter extends LlmAdapter {
  override readonly enforcesAdmission = true
  readonly requests: GenerateOptions[] = []

  override providerInfo() { return { id: 'deepseek-official', name: 'DeepSeek fixture' } }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const payload = JSON.stringify({ model: options.model, messages: options.messages })
    const ticket = options.admission?.({
      model: options.model, bodyBytes: Buffer.byteLength(payload),
      bodySha256: createHash('sha256').update(payload).digest('hex'),
      maxOutputTokens: options.maxTokens, thinking: undefined, reasoningEffort: undefined, hasNonTextContent: false,
    })
    if (options.tools !== undefined && this.requests.length === 1) {
      const id = CallId('fixture-tool-call')
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: 'typescript_repl', argumentsDelta: '{"code":"1 + 1"}' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'typescript_repl', arguments: '{"code":"1 + 1"}' } }
      ticket?.settle({ inputTokens: 8, outputTokens: 1 })
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `result-${String(this.requests.length)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    ticket?.settle({ inputTokens: 10, outputTokens: 2 })
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(() => { vi.unstubAllEnvs() })

async function setup() {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ModelWorkerRuntime)
  const adapter = new FixtureAdapter()
  ctx.llm.registerAdapter(['deepseek-official'], adapter)
  await ctx.plugin(apply)
  return { ctx, adapter }
}

describe('DeepSeekModelWorker', () => {
  it('publishes metered offers that remain distinguishable from subscriptions', async () => {
    const { ctx } = await setup()
    await expect(ctx.modelWorkers.offers()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operatorId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-flash', source: 'metered-api', tier: 'low' }),
      expect.objectContaining({ operatorId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro', source: 'metered-api', tier: 'high' }),
    ]))
    await ctx.root.fiber.dispose()
  })

  it('runs a genuine DeepSeek tool loop against the owner-local TypeScript REPL bridge', async () => {
    const { ctx, adapter } = await setup()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-deepseek-tool-'))
    const socketPath = localIpcAddress(directory, 'bridge')
    const bridgeRequests: Array<{ method: string; params: Record<string, unknown> }> = []
    const physicalEvidence: string[][] = []
    const server = createServer((socket) => {
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.onRequest((method, params) => {
        bridgeRequests.push({ method, params })
        return Promise.resolve({ method, params, value: 2 })
      })
      transport.start()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      const result = await ctx.modelWorkers.execute({
        commandId: 'command', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro',
        prompt: [{ type: 'text', text: 'analyze alternatives' }],
        signal: new AbortController().signal,
        physicalRequestObserver: () => {
          const events: string[] = []
          physicalEvidence.push(events)
          return {
            dispatching: () => { events.push('dispatching') },
            notSent: () => { events.push('not-sent') },
            terminalResponse: () => { events.push('terminal') },
            unknown: () => { events.push('unknown') },
          }
        },
        rlmPlan: {
          version: 1, enabled: true, fidelity: 'dsh-optimized', strategyId: 'test', strategyVersion: '1', reason: 'test',
          instruction: 'bounded test', maxDepth: 2, maxChildren: 3, maxTurns: 6, planSha256: 'test',
        },
        modelToolBridge: {
          version: 1, socketPath, sessionId: 'rlm-session',
          tools: [{ name: 'typescript_repl', description: 'execute TypeScript', inputSchema: { type: 'object' } }],
        },
      })
      expect(result.stopReason).toBe('completed')
      expect(result.usage).toMatchObject({ inputTokens: 18, outputTokens: 3 })
      expect(adapter.requests).toHaveLength(2)
      expect(physicalEvidence).toEqual([['dispatching', 'terminal'], ['dispatching', 'terminal']])
      expect(adapter.requests[0]?.tools?.[0]?.name).toBe('typescript_repl')
      expect(adapter.requests[1]?.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user'])
      expect(adapter.requests[1]?.messages[2]?.content[0]).toMatchObject({ type: 'tool-result', isError: false })
      expect(bridgeRequests).toEqual([{
        method: 'tool.call',
        params: {
          session_id: 'rlm-session',
          command_id: 'command:deepseek-tool:fixture-tool-call',
          tool: 'typescript_repl',
          arguments: { code: '1 + 1' },
        },
      }])
    } finally {
      await ctx.root.fiber.dispose()
      await new Promise<void>((resolve) => { server.close(() =>{  resolve() }) })
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps ordinary non-RLM generation tool-free', async () => {
    const { ctx, adapter } = await setup()
    try {
      await ctx.modelWorkers.execute({
        commandId: 'ordinary', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-flash',
        prompt: [{ type: 'text', text: 'answer directly' }], signal: new AbortController().signal,
      })
      expect(adapter.requests).toHaveLength(1)
      expect(adapter.requests[0]?.tools).toBeUndefined()
    } finally {
      await ctx.root.fiber.dispose()
    }
  })
})
