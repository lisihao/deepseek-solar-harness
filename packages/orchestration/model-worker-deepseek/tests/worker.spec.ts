import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelWorkerRuntime from '@deepseek-ai/dsh-model-worker'
import { afterEach, describe, expect, it, vi } from 'vitest'
import apply, { DEEPSEEK_WORKER_ID } from '../src/index.ts'

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override providerInfo() { return { id: 'deepseek-official', name: 'DeepSeek fixture' } }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const text = `result-${String(this.requests.length)}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
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

  it('runs bounded parallel RLM branches and one high-tier synthesis call', async () => {
    const { ctx, adapter } = await setup()
    const result = await ctx.modelWorkers.execute({
      commandId: 'command', workerId: DEEPSEEK_WORKER_ID, model: 'deepseek-v4-pro',
      prompt: [{ type: 'text', text: 'analyze alternatives' }],
      signal: new AbortController().signal,
      rlmPlan: {
        version: 1, enabled: true, strategyId: 'test', strategyVersion: '1', reason: 'test',
        instruction: 'bounded test', maxDepth: 2, maxChildren: 3, maxTurns: 6, planSha256: 'test',
      },
    })
    expect(result.stopReason).toBe('completed')
    expect(adapter.requests).toHaveLength(4)
    expect(adapter.requests.at(-1)?.messages[0]?.content[1]).toMatchObject({ type: 'text' })
    await ctx.root.fiber.dispose()
  })
})
