import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  CallId,
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import PhysicalOperatorRuntime, {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProgressEvent,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import * as tool from '../src/index.ts'
import { PhysicalOperatorModelToolBridge } from '../src/model-tool-bridge.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionDataMap {
    'debate/preferences': { readonly mode: 'auto' | 'enabled' | 'disabled' }
  }
}

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

  constructor(
    readonly id: 'codex' | 'claude-code' | 'chatgpt-web',
    private readonly immediate = true,
    private readonly bridgeToolName?: string,
    private readonly usage?: PhysicalOperatorResult['usage'],
    private readonly progressPhases: readonly string[] = [],
    private readonly stopReason: PhysicalOperatorResult['stopReason'] = 'completed',
    private readonly progressError?: string,
    private readonly observations: readonly Record<string, unknown>[] = [],
    private readonly observationsAfterSettle = false,
    private readonly startErrorCode?: string,
    private readonly executionModes: readonly ('ephemeral' | 'resident')[] = ['ephemeral', 'resident'],
  ) {
    this.descriptor = {
      id: PhysicalOperatorId(id),
      displayName: id === 'codex' ? 'Codex' : id === 'claude-code' ? 'Claude Code' : 'ChatGPT Web',
      description: `${id} fixture.`,
      tags: id === 'codex' ? ['coding'] : id === 'claude-code' ? ['analysis'] : ['browser', 'subscription'],
      maxConcurrency: 1,
      executionModes: this.executionModes,
    }
  }

  availability() {
    return { available: true as const }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    this.requests.push(request)
    if (this.startErrorCode !== undefined) {
      throw new PhysicalOperatorError(`${this.id} qualification failed`, this.startErrorCode)
    }
    const id = String(request.executionId)
    let receipt = this.receipts.get(id)
    let created = false
    if (receipt === undefined) {
      created = true
      this.productStarts += 1
      receipt = { result: Promise.withResolvers<PhysicalOperatorResult>() }
      this.receipts.set(id, receipt)
    }
    const bridged = this.bridgeToolName === undefined
      ? undefined
      : await callBridgeTool(request, this.bridgeToolName, { value: 'hello' })
    if (created && this.immediate) receipt.result.resolve(this.resultValue(bridged))
    const activeReceipt = receipt
    let settled = false
    void activeReceipt.result.promise.then(() => { settled = true }, () => { settled = true })
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
    const initialEvents: readonly PhysicalOperatorProgressEvent[] = [
      ...this.progressPhases.map((phase, index): PhysicalOperatorProgressEvent => ({
        sequence: index + 1,
        type: 'turn.progress',
        time: new Date(index + 1).toISOString(),
        data: { commandId: id, phase },
      })),
    ]
    const observationEvents = this.observations.map((data, index): PhysicalOperatorProgressEvent => ({
      sequence: initialEvents.length + index + 1,
      type: 'turn.observation',
      time: new Date(initialEvents.length + index + 1).toISOString(),
      data: { commandId: id, ...data },
    }))
    const terminal: PhysicalOperatorProgressEvent = {
      sequence: initialEvents.length + observationEvents.length + 1,
      type: 'turn.settled',
      time: new Date(initialEvents.length + observationEvents.length + 1).toISOString(),
      data: {
        commandId: id,
        stopReason: this.stopReason,
        ...this.usage === undefined ? {} : {
          inputTokens: this.usage.inputTokens,
          outputTokens: this.usage.outputTokens,
          ...this.usage.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: this.usage.cacheReadInputTokens },
          ...this.usage.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: this.usage.cacheWriteInputTokens },
        },
      },
    }
    return {
      readEvents: async (afterSequence, limit) => {
        if (this.progressError !== undefined) throw new Error(this.progressError)
        const visibleObservations = this.observationsAfterSettle && !settled ? [] : observationEvents
        const progressEvents = [
          ...initialEvents,
          ...visibleObservations,
          ...(settled ? [terminal] : []),
        ]
        return {
          events: progressEvents.filter(event => event.sequence > afterSequence).slice(0, limit),
          nextSequence: progressEvents.filter(event => event.sequence > afterSequence).at(-1)?.sequence ?? afterSequence,
        }
      },
      result: callerResult,
      dispose: async () => {},
    }
  }

  private resultValue(bridged: unknown): PhysicalOperatorResult {
    return {
      output: [{ type: 'text', text: bridged === undefined ? `${this.id} resident answer` : JSON.stringify(bridged) }],
      stopReason: this.stopReason,
      ...this.usage === undefined ? {} : { usage: this.usage },
    }
  }
}

async function callBridgeTool(
  request: PhysicalOperatorProviderStartRequest,
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const bridge = request.modelToolBridge
  if (bridge === undefined) throw new Error('fixture expected a model-tool bridge')
  const socket = createConnection(bridge.socketPath)
  await once(socket, 'connect')
  const transport = new JsonRpcLineTransport(socket, socket)
  transport.start()
  try {
    return await transport.request('tool.call', {
      session_id: bridge.sessionId,
      command_id: `${String(request.executionId)}:fixture-tool`,
      tool: toolName,
      arguments: args,
    }, request.signal)
  } finally {
    transport.close()
    socket.destroy()
  }
}

async function setup(options: {
  codexImmediate?: boolean
  codexBridgeTool?: string
  codexUsage?: PhysicalOperatorResult['usage']
  codexProgressPhases?: readonly string[]
  codexStopReason?: PhysicalOperatorResult['stopReason']
  codexProgressError?: string
  codexObservations?: readonly Record<string, unknown>[]
  codexObservationsAfterSettle?: boolean
  claudeStartErrorCode?: string
  primary?: 'deepseek' | 'codex' | 'claude-code' | 'chatgpt-web'
  registerDeepSeek?: boolean
  mountTool?: boolean
} = {}) {
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
  if (options.registerDeepSeek !== false) ctx.llm.registerAdapter(['deepseek'], deepseek)
  const echoCalls: string[] = []
  ctx.tools.register(defineTool({
    name: 'subscription_echo',
    description: 'Echo through the real DSH tool runtime.',
    parameters: { value: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: (args) => {
      echoCalls.push(args.value)
      return Promise.resolve(`subscription:${args.value}`)
    },
  }))
  const codex = new DurableOperator(
    'codex',
    options.codexImmediate ?? true,
    options.codexBridgeTool,
    options.codexUsage,
    options.codexProgressPhases,
    options.codexStopReason,
    options.codexProgressError,
    options.codexObservations,
    options.codexObservationsAfterSettle,
  )
  const claude = new DurableOperator(
    'claude-code',
    true,
    undefined,
    undefined,
    [],
    'completed',
    undefined,
    [],
    false,
    options.claudeStartErrorCode,
  )
  const chatgpt = new DurableOperator(
    'chatgpt-web',
    true,
    undefined,
    undefined,
    [],
    'completed',
    undefined,
    [],
    false,
    undefined,
    ['ephemeral'],
  )
  ctx.physicalOperators.registerOperator(codex)
  ctx.physicalOperators.registerOperator(claude)
  ctx.physicalOperators.registerOperator(chatgpt)
  const mounted = options.mountTool === false ? undefined : await ctx.plugin(tool)
  const primary = options.primary ?? 'deepseek'
  const agent = ctx.agentLoop.create(SessionId('router-session'), primary === 'deepseek'
    ? { provider: 'deepseek', model: 'deepseek' }
    : { provider: 'dsh-physical-operator', model: primary })
  return { ctx, deepseek, codex, claude, chatgpt, mounted, agent, echoCalls }
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

function callPhysicalOperator(ctx: Context, agent: Agent, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId('physical-operator-explicit-run'),
    name: 'physical_operator',
    arguments: args,
    agent,
  })
}

function lastAssistantMessage(agent: Agent) {
  for (const event of [...agent.session.events].reverse()) {
    if (event.type === 'assistant/message') return event.data.message
  }
  throw new Error('expected an assistant message')
}

describe('host physical-operator routing', () => {
  it('keeps the physical product directory as generic operator discovery', async () => {
    const { ctx } = await setup()
    expect(ctx.physicalOperators.list().map(value => String(value.id))).toEqual(['codex', 'claude-code', 'chatgpt-web'])
  })

  it('lets an explicit current-message Codex request override a Claude preference without calling DeepSeek', async () => {
    const { ctx, agent, deepseek, codex, claude } = await setup()
    await ctx.commands.execute(agent, '/operator claude-code', new AbortController().signal)

    send(agent, '用codex给我深度分析下美国当前排华法案相关的情况')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(codex.requests).toHaveLength(1)
    expect(claude.requests).toHaveLength(0)
    expect(codex.requests[0]).toMatchObject({
      mode: 'resident',
      nativeToolPolicy: 'dsh-tools-authoritative',
    })
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'codex',
    })
  })

  it('runs Codex as the first-class main model without a DeepSeek adapter and exposes the real DSH tools', async () => {
    const { agent, deepseek, codex } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexBridgeTool: 'subscription_echo',
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(codex.requests).toHaveLength(1)
    expect(codex.requests[0]?.nativeToolPolicy).toBe('dsh-tools-authoritative')
    expect(codex.requests[0]?.residentLaneId).toBeUndefined()
    expect(codex.requests[0]?.systemPrompt).toContain('physical')
    expect(codex.requests[0]?.modelToolBridge?.tools.map(value => value.name)).toContain('subscription_echo')
    const answer = lastAssistantMessage(agent).content[0]
    expect(answer?.type).toBe('text')
    expect(answer?.type === 'text' ? answer.text : '').toContain('subscription:hello')
    expect(agent.session.events.some(event => event.type === 'physical-operator/tool-call')).toBe(true)
    expect(agent.session.events.some(event => event.type === 'physical-operator/tool-result')).toBe(true)
    const toolCall = agent.session.events.find(event => event.type === 'physical-operator/tool-call')
    const toolResult = agent.session.events.find(event => event.type === 'physical-operator/tool-result')
    if (toolCall?.type !== 'physical-operator/tool-call' || toolResult?.type !== 'physical-operator/tool-result') {
      throw new Error('expected durable physical tool call/result events')
    }
    expect(toolCall.data.toolCallId).toBe(toolCall.data.commandId)
    expect(toolResult.data.toolCallId).toBe(toolResult.data.commandId)
    expect(toolCall.data.executionCommandId).toBe(toolResult.data.executionCommandId)
    expect(toolCall.data.executionCommandId).not.toBe(toolCall.data.commandId)
  })

  it('runs ChatGPT Web as a first-class ephemeral main-model route without DeepSeek or a Resident bridge', async () => {
    const { agent, deepseek, chatgpt } = await setup({
      primary: 'chatgpt-web',
      registerDeepSeek: false,
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(chatgpt.requests).toHaveLength(1)
    expect(chatgpt.requests[0]).toMatchObject({ mode: 'ephemeral' })
    expect(chatgpt.requests[0]?.nativeToolPolicy).toBeUndefined()
    expect(chatgpt.requests[0]?.modelToolBridge).toBeUndefined()
    expect(chatgpt.requests[0]?.residentProfile).toBeUndefined()
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'chatgpt-web',
    })
    expect(agent.session.events.find(event => event.type === 'physical-operator/dispatch')).toMatchObject({
      data: { operatorId: 'chatgpt-web', executionMode: 'ephemeral' },
    })
    expect(agent.session.events.filter(event => event.type === 'physical-operator/progress')).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          operatorId: 'chatgpt-web',
          type: 'turn.settled',
          data: expect.objectContaining({ stopReason: 'completed' }),
        }),
      }),
    ])
  })

  it('recognizes an explicitly named ChatGPT Web request without changing Smart Auto', async () => {
    const { agent, deepseek, chatgpt } = await setup()

    send(agent, '请用 ChatGPT 网页版回答：你好。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(chatgpt.requests).toHaveLength(1)
    expect(chatgpt.requests[0]).toMatchObject({ mode: 'ephemeral' })
  })

  it('accepts ChatGPT Web only as an explicit policy and keeps it out of Smart Auto', async () => {
    const selected = await setup()
    await expect(selected.ctx.commands.execute(
      selected.agent,
      '/operator chatgpt-web',
      new AbortController().signal,
    )).resolves.toMatchObject({ result: { kind: 'success', text: 'routing chatgpt-web' } })
    await expect(selected.ctx.commands.execute(
      selected.agent,
      '/operator-profile chatgpt-web auto auto',
      new AbortController().signal,
    )).resolves.toMatchObject({ result: { kind: 'error' } })

    send(selected.agent, '请分析这个架构设计，并列出三个可执行建议。')
    await selected.agent.whenIdle()

    expect(selected.deepseek.requests).toHaveLength(0)
    expect(selected.codex.requests).toHaveLength(0)
    expect(selected.claude.requests).toHaveLength(0)
    expect(selected.chatgpt.requests).toHaveLength(1)
    expect(selected.chatgpt.requests[0]).toMatchObject({ mode: 'ephemeral' })
    expect(selected.agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
      data: { policy: 'chatgpt-web', route: 'ephemeral', operatorId: 'chatgpt-web' },
    })

    const automatic = await setup()
    send(automatic.agent, '请分析这个架构设计，并列出三个可执行建议。')
    await automatic.agent.whenIdle()
    expect(automatic.chatgpt.requests).toHaveLength(0)
    expect(automatic.claude.requests).toHaveLength(1)
  })

  it('persists one indeterminate trace across bridge restart when a recovered receipt has no result', async () => {
    const { ctx, agent } = await setup({ mountTool: false })
    const executionCommandId = 'resident-recovered-command'
    const commandId = `${executionCommandId}:codex-tool:1`
    agent.session.append('physical-operator/tool-call', {
      commandId,
      toolCallId: commandId,
      executionCommandId,
      tool: 'subscription_echo',
      arguments: { value: 'side effect may have happened' },
    }, { ignorable: true })
    const bridge = new PhysicalOperatorModelToolBridge(ctx)
    const schema: ToolSchema = {
      name: 'subscription_echo',
      description: 'test',
      parameters: { type: 'object' },
    }
    const bound = await bridge.bind(
      executionCommandId,
      agent,
      [schema],
      new AbortController().signal,
    )
    try {
      expect(agent.session.events.filter(event => event.type === 'physical-operator/tool-indeterminate')).toMatchObject([{
        ignorable: true,
        data: {
          commandId,
          toolCallId: commandId,
          executionCommandId,
          tool: 'subscription_echo',
          code: 'COMMAND_INDETERMINATE',
        },
      }])
    } finally {
      bound.release()
      await bridge.dispose()
    }

    const restartedBridge = new PhysicalOperatorModelToolBridge(ctx)
    const restarted = await restartedBridge.bind(
      executionCommandId,
      agent,
      [schema],
      new AbortController().signal,
    )
    try {
      expect(agent.session.events.filter(event => event.type === 'physical-operator/tool-indeterminate')).toHaveLength(1)
    } finally {
      restarted.release()
      await restartedBridge.dispose()
    }
  })

  it('carries Resident product usage into the durable assistant message for billing', async () => {
    const { agent, deepseek } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexUsage: {
        inputTokens: 17,
        outputTokens: 9,
        cacheReadInputTokens: 23,
        cacheWriteInputTokens: 4,
        costUsd: 0.42,
      },
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    const message = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.usage : undefined).toEqual({
      inputTokens: 17,
      outputTokens: 9,
      cacheReadTokens: 23,
      cacheWriteTokens: 4,
    })
  })

  it('keeps unknown optional usage buckets absent instead of fabricating zero tokens', async () => {
    const { agent, deepseek } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexUsage: { inputTokens: 17, outputTokens: 9 },
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    const message = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
    expect(message?.type === 'assistant/message' ? message.data.usage : undefined).toEqual({
      inputTokens: 17,
      outputTokens: 9,
    })
  })

  it('projects native Resident progress and terminal stop into ignorable Session Trace', async () => {
    const { agent, deepseek } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexProgressPhases: ['connecting', 'tool_activity', 'finalizing'],
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    const progress = agent.session.events.filter(event => event.type === 'physical-operator/progress')
    expect(progress).toHaveLength(4)
    expect(progress.every(event => event.ignorable === true)).toBe(true)
    expect(progress.map(event => event.type === 'physical-operator/progress' ? event.data.data.phase : undefined))
      .toEqual(['connecting', 'tool_activity', 'finalizing', undefined])
    const terminal = progress.at(-1)
    if (terminal?.type !== 'physical-operator/progress') throw new Error('expected a terminal progress event')
    expect(terminal.data.commandId).toMatch(/^resident-[0-9a-f]{32}$/u)
    expect(terminal.data.operatorId).toBe('codex')
    expect(terminal.data.type).toBe('turn.settled')
    expect(terminal.data.data).toMatchObject({ commandId: terminal.data.commandId, stopReason: 'completed' })
    expect(JSON.stringify(progress)).not.toContain('你好')
  })

  it('projects bounded Resident observations before settle and drains late observations without duplicates', async () => {
    const { agent, codex } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexImmediate: false,
      codexProgressPhases: ['connecting'],
      codexObservationsAfterSettle: true,
      codexObservations: [
        { kind: 'public-output', preview: 'public native update', prompt: 'must stay hidden' },
        { kind: 'tool-started', toolName: 'Bash', arguments: { secret: 'must stay hidden' } },
      ],
    })
    send(agent, '让 Codex 持续执行')
    while (codex.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(codex.requests[0]?.nativeToolPolicy).toBe('dsh-tools-authoritative')
    const beforeSettle = agent.session.events.filter(event => event.type === 'physical-operator/progress')
    expect(beforeSettle.some(event => event.type === 'physical-operator/progress' && event.data.data.phase === 'connecting')).toBe(true)
    expect(beforeSettle.some(event => event.type === 'physical-operator/progress' && event.data.type === 'turn.observation')).toBe(false)

    const receipt = codex.receipts.values().next().value
    if (receipt === undefined) throw new Error('expected durable receipt')
    receipt.result.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
    await agent.whenIdle()

    const observations = agent.session.events.filter(event => (
      event.type === 'physical-operator/progress' && event.data.type === 'turn.observation'
    ))
    expect(observations).toHaveLength(2)
    expect(observations.map(event => event.type === 'physical-operator/progress' ? event.data.sequence : undefined)).toEqual([2, 3])
    expect(observations.map(event => event.type === 'physical-operator/progress' ? event.data.data.kind : undefined))
      .toEqual(['public-output', 'tool-started'])
    expect(JSON.stringify(observations)).not.toContain('must stay hidden')
  })

  it('starts an explicit resident physical_operator trace and projects its public observation', async () => {
    const { ctx, agent, codex } = await setup({
      codexImmediate: false,
      codexBridgeTool: 'subscription_echo',
      codexObservations: [{ kind: 'tool-completed', toolName: 'Read' }],
    })
    const pending = callPhysicalOperator(ctx, agent, {
      action: 'run', operator_id: 'codex', description: 'inspect repository', prompt: 'read only', mode: 'resident',
      required_capabilities: ['browser'],
    })
    while (codex.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(codex.requests[0]?.nativeToolPolicy).toBe('dsh-tools-authoritative')
    expect(codex.requests[0]?.modelToolBridge?.tools.map(value => value.name)).toContain('subscription_echo')
    expect(codex.requests[0]?.residentLaneId).toBe(`explicit-tool:${String(agent.id)}`)
    expect(agent.session.events.find(event => event.type === 'physical-operator/tool-dispatch')).toMatchObject({
      ignorable: true,
      data: { operatorId: 'codex', mode: 'resident', description: 'inspect repository' },
    })
    expect(agent.session.events.find(event => (
      event.type === 'physical-operator/progress' && event.data.type === 'turn.observation'
    ))).toMatchObject({ data: { data: { kind: 'tool-completed', toolName: 'Read' } } })
    const receipt = codex.receipts.values().next().value
    if (receipt === undefined) throw new Error('expected durable receipt')
    receipt.result.resolve({ output: [{ type: 'text', text: 'complete' }], stopReason: 'completed' })
    await pending
  })

  it('rejects browser capability requests that omit Resident mode instead of silently using ephemeral', async () => {
    const { ctx, agent, codex } = await setup()
    const result = await callPhysicalOperator(ctx, agent, {
      action: 'run', operator_id: 'codex', description: 'browse repository', prompt: 'inspect the browser',
      required_capabilities: ['browser'],
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).toMatch(/requires mode=.*resident/u)
    expect(codex.requests).toHaveLength(0)
  })

  it('keeps a settled answer while marking a failed Resident progress projection degraded', async () => {
    const { agent } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexProgressError: 'remote event stream disconnected',
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(lastAssistantMessage(agent).content).toEqual([{ type: 'text', text: 'codex resident answer' }])
    expect(agent.session.events.find(event => event.type === 'physical-operator/trace-degraded')).toMatchObject({
      ignorable: true,
      data: {
        operatorId: 'codex',
        code: 'PROGRESS_UNAVAILABLE',
        message: 'remote event stream disconnected',
      },
    })
  })

  it.each([
    ['aborted', 'error'],
    ['error', 'error'],
    ['refusal', 'error'],
  ] as const)('preserves a native %s terminal reason in the DSH turn Trace', async (stopReason, expectedKind) => {
    const { agent, deepseek } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexStopReason: stopReason,
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    const turnEnd = [...agent.session.events].reverse().find(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' ? turnEnd.data.reason.kind : undefined).toBe(expectedKind)
    expect(agent.session.events.some(event => (
      event.type === 'physical-operator/progress'
      && event.data.data.stopReason === stopReason
    ))).toBe(true)
    expect(agent.session.events.some(event => (
      event.type === 'physical-operator/dispatch-terminal'
      && event.data.code === (stopReason === 'aborted' ? undefined : `OPERATOR_${stopReason === 'refusal' ? 'REFUSED' : 'ERROR'}`)
    ))).toBe(stopReason !== 'aborted')
  })

  it('does not replay a bridged tool command whose persisted result is indeterminate', async () => {
    const { ctx, agent, echoCalls } = await setup({ mountTool: false })
    const bridge = new PhysicalOperatorModelToolBridge(ctx)
    const commandId = 'native-tool-indeterminate'
    agent.session.append('physical-operator/tool-call', {
      commandId,
      tool: 'subscription_echo',
      arguments: { nested: { b: 2, a: 1 }, value: 'hello' },
    }, { ignorable: true })
    const bound = await bridge.bind('outer-command', agent, [{
      name: 'subscription_echo',
      description: 'Echo through the real DSH tool runtime.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }], new AbortController().signal)
    if (bound.descriptor === undefined) throw new Error('expected a model tool descriptor')
    const socket = createConnection(bound.descriptor.socketPath)
    await once(socket, 'connect')
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.start()
    try {
      await expect(transport.request('tool.call', {
        session_id: bound.descriptor.sessionId,
        command_id: commandId,
        tool: 'subscription_echo',
        arguments: { value: 'hello', nested: { a: 1, b: 2 } },
      })).rejects.toThrow(/indeterminate and will not be replayed/u)
      expect(echoCalls).toEqual([])
    } finally {
      transport.close()
      socket.destroy()
      bound.release()
      await bridge.dispose()
      await ctx.root.fiber.dispose()
    }
  })

  it('settles an active indeterminate binding from a later durable result without re-executing', async () => {
    const { ctx, agent, echoCalls } = await setup({ mountTool: false })
    const bridge = new PhysicalOperatorModelToolBridge(ctx)
    const executionCommandId = 'outer-late-settlement'
    const commandId = 'native-tool-late-settlement'
    const requestArguments = { nested: { b: 2, a: 1 }, value: 'hello' }
    agent.session.append('physical-operator/tool-call', {
      commandId,
      toolCallId: commandId,
      executionCommandId,
      tool: 'subscription_echo',
      arguments: requestArguments,
    }, { ignorable: true })
    const bound = await bridge.bind(executionCommandId, agent, [{
      name: 'subscription_echo',
      description: 'Echo through the real DSH tool runtime.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }], new AbortController().signal)
    if (bound.descriptor === undefined) throw new Error('expected a model tool descriptor')
    const persistedResult = {
      isError: false,
      content: [{ type: 'text', text: 'settled elsewhere' }],
      value: { echoed: 'settled elsewhere' },
    }
    agent.session.append('physical-operator/tool-result', {
      commandId,
      toolCallId: commandId,
      executionCommandId,
      tool: 'subscription_echo',
      result: persistedResult,
    }, { ignorable: true })
    const socket = createConnection(bound.descriptor.socketPath)
    await once(socket, 'connect')
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.start()
    const request = {
      session_id: bound.descriptor.sessionId,
      command_id: commandId,
      tool: 'subscription_echo',
      arguments: { value: 'hello', nested: { a: 1, b: 2 } },
    }
    try {
      await expect(transport.request('tool.call', request)).resolves.toEqual(persistedResult)
      await expect(transport.request('tool.call', request)).resolves.toEqual(persistedResult)
      expect(echoCalls).toEqual([])
      expect(agent.session.events.filter(event => event.type === 'physical-operator/tool-call')).toHaveLength(1)
      expect(agent.session.events.filter(event => event.type === 'physical-operator/tool-result')).toHaveLength(1)
    } finally {
      transport.close()
      socket.destroy()
      bound.release()
      await bridge.dispose()
      await ctx.root.fiber.dispose()
    }
  })

  it('gives simultaneous model-tool bridge owners distinct endpoints', async () => {
    const first = await setup({ mountTool: false })
    const second = await setup({ mountTool: false })
    const firstBridge = new PhysicalOperatorModelToolBridge(first.ctx)
    const secondBridge = new PhysicalOperatorModelToolBridge(second.ctx)
    const signal = new AbortController().signal
    const schemas = [{
      name: 'subscription_echo',
      description: 'Echo through the real DSH tool runtime.',
      parameters: { type: 'object' as const, properties: { value: { type: 'string' } }, required: ['value'] },
    }]
    const firstBinding = await firstBridge.bind('first', first.agent, schemas, signal)
    const secondBinding = await secondBridge.bind('second', second.agent, schemas, signal)
    try {
      expect(firstBinding.descriptor?.socketPath).not.toBe(secondBinding.descriptor?.socketPath)
    } finally {
      firstBinding.release()
      secondBinding.release()
      await firstBridge.dispose()
      await secondBridge.dispose()
      await first.ctx.root.fiber.dispose()
      await second.ctx.root.fiber.dispose()
    }
  })

  it('serves model tools when DSH_HOME exceeds Unix socket limits', async () => {
    vi.stubEnv('DSH_HOME', join('/tmp', 'dsh-model-tool-long-home-'.repeat(8)))
    const { ctx, agent } = await setup({ mountTool: false })
    const bridge = new PhysicalOperatorModelToolBridge(ctx)
    let socketPath = ''
    const bound = await bridge.bind('long-home', agent, [{
      name: 'subscription_echo',
      description: 'Echo through the real DSH tool runtime.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }], new AbortController().signal)
    try {
      expect(bound.descriptor).toBeDefined()
      socketPath = bound.descriptor?.socketPath ?? ''
      expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(103)
      const socket = createConnection(socketPath)
      await once(socket, 'connect')
      socket.destroy()
    } finally {
      bound.release()
      await bridge.dispose()
      await ctx.root.fiber.dispose()
      if (socketPath.length > 0) expect(existsSync(socketPath)).toBe(false)
      vi.unstubAllEnvs()
    }
  })

  it('runs Claude Code as the first-class main model without a DeepSeek adapter', async () => {
    const { agent, deepseek, claude } = await setup({
      primary: 'claude-code',
      registerDeepSeek: false,
    })

    send(agent, '你好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(1)
    expect(claude.requests[0]).toMatchObject({
      mode: 'resident',
      nativeToolPolicy: 'dsh-tools-authoritative',
    })
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'claude-code',
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

  it('falls back from an automatically selected unauthenticated Claude to Codex with a distinct durable trace', async () => {
    const { agent, deepseek, codex, claude } = await setup({
      claudeStartErrorCode: 'AUTH_MODE_MISMATCH',
    })

    send(agent, '你觉得 DSH 应该怎么优化架构更好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(1)
    expect(claude.productStarts).toBe(0)
    expect(codex.requests).toHaveLength(1)
    expect(codex.productStarts).toBe(1)
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'codex',
    })

    const dispatches = agent.session.events.filter(event => event.type === 'physical-operator/dispatch')
    expect(dispatches).toHaveLength(2)
    expect(dispatches[0]).toMatchObject({
      data: { operatorId: 'claude-code', fallbackOperatorId: 'codex' },
    })
    expect(dispatches[1]).toMatchObject({ data: { operatorId: 'codex' } })
    if (dispatches[0]?.type !== 'physical-operator/dispatch'
      || dispatches[1]?.type !== 'physical-operator/dispatch') throw new Error('expected two dispatches')
    expect(dispatches[1].data.commandId).not.toBe(dispatches[0].data.commandId)
    expect(agent.session.events).toContainEqual(expect.objectContaining({
      type: 'physical-operator/dispatch-terminal',
      data: { commandId: dispatches[0].data.commandId, code: 'AUTH_MODE_MISMATCH' },
    }))
    expect(agent.session.events.filter(event => event.type === 'physical-operator/routing-decision')).toHaveLength(2)
  })

  it('does not override an explicit Claude request when subscription qualification fails', async () => {
    const { agent, deepseek, codex, claude } = await setup({
      claudeStartErrorCode: 'AUTH_MODE_MISMATCH',
    })

    send(agent, '用 Claude 分析这个架构')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'physical-operator/dispatch')).toHaveLength(1)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error', error: { code: 'AUTH_MODE_MISMATCH' } } },
    })
  })

  it('does not override a manually selected Claude policy when subscription qualification fails', async () => {
    const { ctx, agent, codex, claude } = await setup({
      claudeStartErrorCode: 'AUTH_MODE_MISMATCH',
    })
    await ctx.commands.execute(agent, '/operator claude-code', new AbortController().signal)

    send(agent, '请分析这个完整架构并给出改进方案')
    await agent.whenIdle()

    expect(claude.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'physical-operator/dispatch')).toHaveLength(1)
  })

  it('yields Smart Auto host routing when the Session explicitly enables Debate', async () => {
    const { agent, deepseek, codex, claude } = await setup()
    agent.session.append('debate/preferences', { mode: 'enabled' }, { ignorable: true })

    send(agent, '请深度分析 DSH 是否代表 Agent 架构趋势。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(0)
    const decision = agent.session.events.find(event => event.type === 'physical-operator/routing-decision')
    if (decision?.type !== 'physical-operator/routing-decision') throw new Error('missing routing decision')
    expect(decision.data.policy).toBe('auto')
    expect(decision.data.route).toBe('taskgraph-candidate')
    expect(decision.data.reason).toContain('Debate')
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

  it('keeps an explicit ChatGPT Web policy on its bounded ephemeral route for parallel-looking prompts', async () => {
    const { ctx, agent, deepseek, chatgpt } = await setup()
    await ctx.commands.execute(agent, '/operator chatgpt-web', new AbortController().signal)
    send(agent, '请并行研究三个独立方案，再综合输出最终建议。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(chatgpt.requests).toHaveLength(1)
    expect(chatgpt.requests[0]).toMatchObject({ mode: 'ephemeral' })
    expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
      data: {
        policy: 'chatgpt-web',
        route: 'ephemeral',
        operatorId: 'chatgpt-web',
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

    if (mounted === undefined) throw new Error('expected the physical-operator plugin')
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
    const { ctx, agent, deepseek, codex, mounted, echoCalls } = await setup({
      codexImmediate: false,
      codexBridgeTool: 'subscription_echo',
      codexObservations: [{ kind: 'public-output', preview: 'resume-safe observation' }],
    })
    send(agent, '用 Codex 深度检查这个仓库并持续执行')
    while (codex.requests.length === 0 || echoCalls.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const firstRequest = codex.requests[0]
    if (firstRequest === undefined) throw new Error('expected the first Codex request')
    const firstId = String(firstRequest.executionId)

    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'aborted' } },
    })
    if (mounted === undefined) throw new Error('expected the physical-operator plugin')
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
    expect(echoCalls).toEqual(['hello'])
    const replayRequest = codex.requests[1]
    if (replayRequest === undefined) throw new Error('expected the replayed Codex request')
    expect(String(replayRequest.executionId)).toBe(firstId)
    expect(lastAssistantMessage(agent).content).toEqual([
      { type: 'text', text: 'reconnected codex result' },
    ])
    expect(agent.session.events.filter(event => (
      event.type === 'physical-operator/progress'
      && event.data.type === 'turn.observation'
      && event.data.data.preview === 'resume-safe observation'
    ))).toHaveLength(1)
  })
})
