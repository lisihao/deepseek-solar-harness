import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ModelWorkerExecuteRequest } from '@deepseek-ai/dsh-model-worker'
import PhysicalOperatorRuntime, {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHATGPT_WEB_MODEL_WORKER_ID,
  CHATGPT_WEB_WEBSITE_DEFAULT_MODEL,
  ChatGptWebModelWorker,
} from '../src/model-worker.ts'

const contexts: Context[] = []

const parent = {
  id: SessionId('chatgpt-web-model-worker-parent'),
  session: { header: { cwd: '/fixture/workspace' } },
} as unknown as Agent

class StubChatGptWebOperator implements PhysicalOperator {
  readonly descriptor: PhysicalOperator['descriptor']

  available = true
  disposals = 0
  readonly requests: PhysicalOperatorProviderStartRequest[] = []
  result: Promise<PhysicalOperatorResult> = Promise.resolve({
    output: [{ type: 'text', text: 'website advisor result' }],
    stopReason: 'completed',
    usage: { inputTokens: 5, outputTokens: 3, cacheReadInputTokens: 2, cacheWriteInputTokens: 1 },
  })

  constructor(operatorId = CHATGPT_WEB_MODEL_WORKER_ID) {
    this.descriptor = {
      id: PhysicalOperatorId(operatorId),
      displayName: 'ChatGPT Web',
      description: 'Fixture ChatGPT website operator.',
      tags: ['browser-subscription'],
      maxConcurrency: 1,
      executionModes: ['ephemeral'] as const,
    }
  }

  availability() {
    return this.available
      ? { available: true as const }
      : { available: false as const, reason: 'fixture browser is unavailable' }
  }

  async start(request: PhysicalOperatorProviderStartRequest) {
    this.requests.push(request)
    return {
      result: this.result,
      dispose: async (): Promise<void> => { this.disposals += 1 },
    }
  }
}

function request(): ModelWorkerExecuteRequest {
  return {
    commandId: 'web-advisor-command',
    workerId: CHATGPT_WEB_MODEL_WORKER_ID,
    model: CHATGPT_WEB_WEBSITE_DEFAULT_MODEL,
    prompt: [{ type: 'text', text: 'Assess the design.' }],
    parent,
    signal: new AbortController().signal,
  }
}

async function setup(operatorId = CHATGPT_WEB_MODEL_WORKER_ID) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(PhysicalOperatorRuntime)
  const operator = new StubChatGptWebOperator(operatorId)
  ctx.physicalOperators.registerOperator(operator)
  return { operator, worker: new ChatGptWebModelWorker(ctx, operatorId) }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.root.fiber.dispose()
})

describe('ChatGptWebModelWorker', () => {
  it('publishes the website-selected subscription route from live physical-operator state', async () => {
    const { operator, worker } = await setup()

    await expect(worker.offers()).resolves.toEqual([{
      offerId: 'chatgpt-web:website-default',
      operatorId: 'chatgpt-web',
      provider: 'chatgpt-web',
      model: 'website-default',
      displayName: 'ChatGPT Web — website selection',
      source: 'native-subscription',
      tier: 'high',
      available: true,
      maxConcurrency: 1,
      activeCount: 0,
      tags: ['browser-subscription', 'text-only', 'planning', 'research'],
    }])

    operator.available = false
    await expect(worker.offers()).resolves.toEqual([expect.objectContaining({
      available: false,
      unavailableReasonCode: 'OPERATOR_UNAVAILABLE',
      maxConcurrency: 1,
      activeCount: 0,
    })])
  })

  it('starts one ephemeral text-only physical run with the orchestration parent and waits for disposal', async () => {
    const { operator, worker } = await setup('configured-chatgpt-web')

    await expect(worker.execute({
      ...request(),
      workerId: 'configured-chatgpt-web',
    })).resolves.toEqual({
      output: [{ type: 'text', text: 'website advisor result' }],
      stopReason: 'completed',
      usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1 },
    })
    expect(operator.requests).toEqual([expect.objectContaining({
      executionId: 'web-advisor-command',
      mode: 'ephemeral',
      prompt: [{ type: 'text', text: 'Assess the design.' }],
      parent,
    })])
    expect(operator.requests[0]).not.toHaveProperty('residentProfile')
    expect(operator.requests[0]).not.toHaveProperty('modelToolBridge')
    expect(operator.disposals).toBe(1)
  })

  it('rejects a missing parent, unverified model, RLM, or model-tool bridge before starting the browser operator', async () => {
    const { operator, worker } = await setup()
    const { parent: _parent, ...withoutParent } = request()

    await expect(worker.execute(withoutParent)).rejects.toMatchObject({ code: 'MODEL_WORKER_INVALID' })
    await expect(worker.execute({ ...request(), model: 'gpt-unverified' })).rejects.toMatchObject({ code: 'MODEL_WORKER_INVALID' })
    await expect(worker.execute({
      ...request(),
      rlmPlan: {
        version: 1, enabled: true, fidelity: 'dsh-optimized', strategyId: 'fixture', strategyVersion: '1', reason: 'fixture',
        instruction: 'fixture', maxDepth: 1, maxChildren: 1, maxTurns: 1, planSha256: 'fixture',
      },
    })).rejects.toMatchObject({ code: 'MODEL_WORKER_INVALID' })
    await expect(worker.execute({
      ...request(),
      modelToolBridge: {
        version: 1, socketPath: '/fixture/socket', sessionId: 'fixture',
        tools: [{ name: 'fixture', description: 'fixture', inputSchema: {} }],
      },
    })).rejects.toMatchObject({ code: 'MODEL_WORKER_INVALID' })

    expect(operator.requests).toEqual([])
  })
})
