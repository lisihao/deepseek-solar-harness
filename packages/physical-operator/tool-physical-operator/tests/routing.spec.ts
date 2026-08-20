import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import PhysicalOperatorRuntime, {
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import * as tool from '../src/index.ts'

class CountingDeepSeek extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'deepseek should not own this request' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'deepseek should not own this request' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface Receipt {
  readonly result: PromiseWithResolvers<PhysicalOperatorResult>
}

class DurableOperator implements PhysicalOperator {
  readonly descriptor
  readonly requests: PhysicalOperatorProviderStartRequest[] = []
  readonly receipts = new Map<string, Receipt>()
  productStarts = 0

  constructor(readonly id: 'codex' | 'claude-code', private readonly immediate = true) {
    this.descriptor = {
      id: PhysicalOperatorId(id),
      displayName: id === 'codex' ? 'Codex' : 'Claude Code',
      description: `Resident ${id} fixture.`,
      tags: id === 'codex' ? ['coding'] : ['analysis'],
      maxConcurrency: 1,
      executionModes: ['ephemeral', 'resident'] as const,
    }
  }

  availability() {
    return { available: true as const }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    this.requests.push(request)
    const id = String(request.executionId)
    let receipt = this.receipts.get(id)
    if (receipt === undefined) {
      this.productStarts += 1
      receipt = { result: Promise.withResolvers<PhysicalOperatorResult>() }
      this.receipts.set(id, receipt)
      if (this.immediate) receipt.result.resolve({
        output: [{ type: 'text', text: `${this.id} resident answer` }],
        stopReason: 'completed',
      })
    }
    const activeReceipt = receipt
    const callerResult = new Promise<PhysicalOperatorResult>((resolve, reject) => {
      const abort = (): void => {
        request.signal.removeEventListener('abort', abort)
        reject(request.signal.reason instanceof Error ? request.signal.reason : new Error('caller aborted'))
      }
      if (request.signal.aborted) { abort(); return }
      request.signal.addEventListener('abort', abort, { once: true })
      activeReceipt.result.promise.then(
        (value) => { request.signal.removeEventListener('abort', abort); resolve(value) },
        (error: unknown) => {
          request.signal.removeEventListener('abort', abort)
          reject(error instanceof Error ? error : new Error(String(error)))
        },
      )
    })
    return { result: callerResult, dispose: async () => {} }
  }
}

async function setup(options: { codexImmediate?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PhysicalOperatorRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const deepseek = new CountingDeepSeek()
  ctx.llm.registerAdapter(['deepseek'], deepseek)
  const codex = new DurableOperator('codex', options.codexImmediate ?? true)
  const claude = new DurableOperator('claude-code')
  ctx.physicalOperators.registerOperator(codex)
  ctx.physicalOperators.registerOperator(claude)
  const mounted = await ctx.plugin(tool)
  const agent = ctx.agentLoop.create(SessionId('router-session'), { provider: 'deepseek', model: 'deepseek' })
  return { ctx, deepseek, codex, claude, mounted, agent }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function lastAssistantMessage(agent: Agent) {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'assistant/message') return event.data.message
  }
  throw new Error('expected an assistant message')
}

describe('host physical-operator routing', () => {
  it('lets an explicit current-message Codex request override a Claude preference without calling DeepSeek', async () => {
    const { ctx, agent, deepseek, codex, claude } = await setup()
    await ctx.commands.execute(agent, '/operator claude-code', new AbortController().signal)

    send(agent, '用codex给我深度分析下美国当前排华法案相关的情况')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(codex.requests).toHaveLength(1)
    expect(claude.requests).toHaveLength(0)
    expect(codex.requests[0]).toMatchObject({ mode: 'resident' })
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'codex',
    })
  })

  it('treats an explicitly named Claude model as a Claude Code route', async () => {
    const { agent, deepseek, claude } = await setup()

    send(agent, '用 Sonnet 回答我的问好：你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(1)
  })

  it('treats an explicitly named GPT execution model as a Codex route', async () => {
    const { agent, deepseek, codex } = await setup()

    send(agent, '用 GPT-5.6-Sol 分析这个问题')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(codex.requests).toHaveLength(1)
  })

  it('routes preferred and smart-auto non-trivial work at the host boundary', async () => {
    const preferred = await setup()
    await preferred.ctx.commands.execute(preferred.agent, '/operator codex', new AbortController().signal)
    send(preferred.agent, '请修复这个 TypeScript 构建 bug')
    await preferred.agent.whenIdle()
    expect(preferred.codex.requests).toHaveLength(1)
    expect(preferred.deepseek.requests).toHaveLength(0)

    const automatic = await setup()
    send(automatic.agent, '给我修复这个 TypeScript 构建 bug 并补齐测试')
    await automatic.agent.whenIdle()
    expect(automatic.codex.requests).toHaveLength(1)
    expect(automatic.deepseek.requests).toHaveLength(0)
  })

  it('keeps a parallel Smart Auto task on the main model for TaskGraph admission and logs the decision', async () => {
    const { agent, deepseek, codex, claude } = await setup()
    send(agent, '请并行安排多个子任务，分别研究三个独立模块，最后综合验证结论。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(0)
    expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
      ignorable: true,
      data: {
        policy: 'auto',
        route: 'taskgraph-candidate',
      },
    })
  })

  it('keeps parallel preferred-product work on the main model with the selected TaskGraph operator hint', async () => {
    const { ctx, agent, deepseek, codex } = await setup()
    await ctx.commands.execute(agent, '/operator codex', new AbortController().signal)
    send(agent, '请并行安排多个模块的实现与测试，并综合验证结果。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
      data: {
        policy: 'codex',
        route: 'taskgraph-candidate',
        operatorId: 'codex',
      },
    })
  })

  it('restores the primary model after one routed turn instead of replaying the settled Resident result', async () => {
    const { ctx, agent, deepseek, claude, mounted } = await setup()

    send(agent, '用 Claude 回答我的问好：你好')
    await agent.whenIdle()
    expect(claude.requests).toHaveLength(1)
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'claude-code',
    })
    expect(agent.session.events.find(event => event.type === 'physical-operator/dispatch')).toMatchObject({
      data: { fallbackConfig: { provider: 'deepseek', model: 'deepseek' } },
    })

    await mounted.dispose()
    await ctx.plugin(tool)
    send(agent, '刚才是哪个模型回答的')
    await agent.whenIdle()

    expect(claude.requests).toHaveLength(1)
    expect(deepseek.requests).toHaveLength(1)
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek',
    })
  })

  it('persists manual model and effort preferences and replays them with the durable dispatch', async () => {
    const { ctx, agent, codex } = await setup()
    await ctx.commands.execute(agent, '/operator codex', new AbortController().signal)
    await ctx.commands.execute(
      agent,
      '/operator-profile codex gpt-5.6-sol xhigh',
      new AbortController().signal,
    )

    send(agent, '实现一个完整的 TypeScript 功能并补齐测试')
    await agent.whenIdle()

    expect(codex.requests[0]).toMatchObject({
      mode: 'resident',
      residentProfile: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    })
    expect(agent.session.events.find(event => event.type === 'physical-operator/profile')).toMatchObject({
      ignorable: true,
      data: { operatorId: 'codex', profile: { model: 'gpt-5.6-sol', effort: 'xhigh' } },
    })
    expect(agent.session.events.find(event => event.type === 'physical-operator/dispatch')).toMatchObject({
      data: { residentProfile: { model: 'gpt-5.6-sol', effort: 'xhigh' } },
    })
  })

  it('rejects an auxiliary title call without duplicating or terminating the active Resident command', async () => {
    const { ctx, agent, codex } = await setup({ codexImmediate: false })
    send(agent, '用 Codex 深度检查这个仓库并持续执行')
    while (codex.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))

    const titleChunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({
      provider: 'dsh-physical-operator',
      model: 'codex',
      purpose: 'session-title',
      sessionId: agent.session.id,
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'Generate the session title.' }],
        source: { kind: 'plugin', plugin: 'dsh-session-title-llm' },
      })],
    })) titleChunks.push(chunk)
    expect(titleChunks.at(-1)).toEqual({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          code: 'UNKNOWN',
          message: 'physical-operator router only accepts the primary agent-loop request',
        },
      },
    })

    expect(codex.requests).toHaveLength(1)
    expect(agent.session.events.some(event => (
      event.type === 'physical-operator/dispatch-terminal'
    ))).toBe(false)

    const receipt = codex.receipts.values().next().value
    if (receipt === undefined) throw new Error('expected the active durable receipt')
    receipt.result.resolve({
      output: [{ type: 'text', text: 'primary codex result' }],
      stopReason: 'completed',
    })
    await agent.whenIdle()
    expect(lastAssistantMessage(agent).content).toEqual([
      { type: 'text', text: 'primary codex result' },
    ])
  })

  it('replays the same durable command after caller interruption and router remount', async () => {
    const { ctx, agent, deepseek, codex, mounted } = await setup({ codexImmediate: false })
    send(agent, '用 Codex 深度检查这个仓库并持续执行')
    while (codex.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const firstRequest = codex.requests[0]
    if (firstRequest === undefined) throw new Error('expected the first Codex request')
    const firstId = String(firstRequest.executionId)

    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
    await mounted.dispose()
    await ctx.plugin(tool)

    const receipt = codex.receipts.get(firstId)
    if (receipt === undefined) throw new Error('expected the durable receipt')
    receipt.result.resolve({
      output: [{ type: 'text', text: 'reconnected codex result' }],
      stopReason: 'completed',
    })
    send(agent, '继续啊')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(codex.productStarts).toBe(1)
    expect(codex.requests).toHaveLength(2)
    const replayRequest = codex.requests[1]
    if (replayRequest === undefined) throw new Error('expected the replayed Codex request')
    expect(String(replayRequest.executionId)).toBe(firstId)
    expect(lastAssistantMessage(agent).content).toEqual([
      { type: 'text', text: 'reconnected codex result' },
    ])
  })
})
