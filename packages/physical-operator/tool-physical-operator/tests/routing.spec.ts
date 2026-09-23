import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, {
  agentEvents,
  assembleContextFor,
  installModelSelection,
  type Agent,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
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
import { receiveOperatorContextEnvelope } from '@deepseek-ai/dsh-system-prompt'
import {
  emptyStoreDocument,
  taskTemplateId,
  TaskTemplateService,
  type TaskTemplateDraft,
  type TaskTemplateStoreDocument,
} from '@deepseek-ai/dsh-task-template'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import PhysicalOperatorRuntime, {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorProgressEvent,
  type PhysicalOperatorResidentCatalog,
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
    private readonly catalogAvailable = true,
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

  async residentCatalog(): Promise<PhysicalOperatorResidentCatalog> {
    const models = this.id === 'codex'
      ? [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Fixture Codex model', supportedEfforts: ['low', 'medium', 'high', 'xhigh'] as const, defaultEffort: 'medium' as const, isDefault: true, supportsAdaptiveThinking: false }]
      : this.id === 'claude-code'
        ? [{ model: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', description: 'Fixture Claude model', supportedEfforts: ['low', 'medium', 'high'] as const, defaultEffort: 'medium' as const, isDefault: true, supportsAdaptiveThinking: false }]
        : []
    return {
      operatorId: this.descriptor.id, product: 'fixture', injectionBoundaries: ['pre-dispatch'],
      supportsModelToolBridge: this.id !== 'chatgpt-web', location: 'local', supportsWorkspaceMutationReturn: true,
      available: this.catalogAvailable,
      ...this.catalogAvailable ? {} : { unavailableReason: 'fixture Resident provider unavailable' },
      authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture', models,
    }
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
      ...request.contextEnvelope === undefined ? {} : {
        contextReceipt: receiveOperatorContextEnvelope(request.contextEnvelope, this.id, 'native'),
      },
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

class MemoryTaskTemplates extends TaskTemplateService {
  protected load(): Promise<TaskTemplateStoreDocument> {
    return Promise.resolve(emptyStoreDocument())
  }

  protected persist(_document: TaskTemplateStoreDocument): Promise<'committed' | 'stale'> {
    return Promise.resolve('committed')
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
  codexExecutionModes?: readonly ('ephemeral' | 'resident')[]
  codexCatalogAvailable?: boolean
  claudeStartErrorCode?: string
  claudeExecutionModes?: readonly ('ephemeral' | 'resident')[]
  primary?: 'deepseek' | 'codex' | 'claude-code' | 'chatgpt-web'
  registerDeepSeek?: boolean
  mountTool?: boolean
  echoResult?: string
  taskTemplate?: TaskTemplateDraft
} = {}) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  if (options.taskTemplate !== undefined) {
    await ctx.plugin(MemoryTaskTemplates)
    await ctx.taskTemplates.create(options.taskTemplate)
  }
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
      return Promise.resolve(options.echoResult ?? `subscription:${args.value}`)
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
    undefined,
    options.codexExecutionModes,
    options.codexCatalogAvailable ?? true,
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
    options.claudeExecutionModes,
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
    const secret = 'sk-must-not-be-public'
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY-----'
    const { agent, deepseek, codex } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
      codexBridgeTool: 'subscription_echo',
      echoResult: `subscription:hello token=hidden ${secret}\n${privateKey}\n${'x'.repeat(2_000)}`,
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
    expect(toolCall.data.publicToolName).toBe('subscription_echo')
    expect(toolResult.data.publicToolName).toBe('subscription_echo')
    expect(toolResult.data.publicResultPreview).toContain('subscription:hello')
    expect(toolResult.data.publicResultPreview).toContain('[REDACTED]')
    expect(toolResult.data.publicResultPreview).not.toContain(secret)
    expect(toolResult.data.publicResultPreview).not.toContain('private material')
    expect(toolResult.data.publicResultPreview?.length).toBeLessThanOrEqual(1_600)
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
    const settled = agent.session.events.find(event => event.type === 'physical-operator/progress')
    if (settled?.type !== 'physical-operator/progress') throw new Error('expected a settled progress event')
    expect(settled.data.operatorId).toBe('chatgpt-web')
    expect(settled.data.type).toBe('turn.settled')
    expect(settled.data.data.stopReason).toBe('completed')
  })

  it('forwards one current Web handoff and each later admitted steering in the same frozen request', async () => {
    const { agent, chatgpt } = await setup({
      primary: 'chatgpt-web',
      registerDeepSeek: false,
    })
    const earlierHandoff = createUserMessage({
      content: [{ type: 'text', text: 'EARLIER HANDOFF MUST NOT CROSS.' }],
      source: { kind: 'plugin', plugin: 'chatgpt-web-handoff' },
    })
    agent.session.append('user/message', earlierHandoff, { surfaceOp: 'append' })
    const unrelatedPlugin = createUserMessage({
      content: [{ type: 'text', text: 'UNRELATED PLUGIN MUST NOT CROSS.' }],
      source: { kind: 'plugin', plugin: 'fixture-unrelated-plugin' },
    })
    const handoff = createUserMessage({
      content: [{ type: 'text', text: 'Current Web handoff summary.' }],
      source: { kind: 'plugin', plugin: 'chatgpt-web-handoff' },
    })
    const firstSteering = createUserMessage({
      content: [{ type: 'text', text: 'First direct steering must stay with this task.' }],
      source: { kind: 'user' },
    })
    const finalSteering = createUserMessage({
      content: [{ type: 'text', text: 'Final direct steering is the task.' }],
      source: { kind: 'user' },
    })
    agent.inject(unrelatedPlugin)
    agent.inject(handoff)
    agent.inbox.append('next-step', firstSteering)
    agent.followup(finalSteering)
    await agent.whenIdle()

    const request = chatgpt.requests[0]
    expect(request?.prompt).toEqual(finalSteering.content)
    expect(request?.contextEnvelope?.task).toEqual(finalSteering.content)
    expect(request?.contextEnvelope?.contexts).toEqual([
      { name: `chatgpt-web-handoff:${String(handoff.id)}`, text: 'Current Web handoff summary.' },
      { name: `chatgpt-web-steering:${String(firstSteering.id)}`, text: 'First direct steering must stay with this task.' },
    ])
    expect(JSON.stringify(request?.contextEnvelope)).not.toContain('EARLIER HANDOFF MUST NOT CROSS.')
    expect(JSON.stringify(request?.contextEnvelope)).not.toContain('UNRELATED PLUGIN MUST NOT CROSS.')

    const stepStart = agent.session.events.findLastIndex(event => event.type === 'step/start')
    const handoffEvent = agent.session.events.findIndex(event => (
      event.type === 'user/message' && event.data.id === handoff.id
    ))
    const firstSteeringEvent = agent.session.events.findIndex(event => (
      event.type === 'user/message' && event.data.id === firstSteering.id
    ))
    const finalSteeringEvent = agent.session.events.findIndex(event => (
      event.type === 'user/message' && event.data.id === finalSteering.id
    ))
    const headerEvent = agent.session.events.findLastIndex(event => event.type === 'request/header')
    expect(stepStart).toBeLessThan(handoffEvent)
    expect(handoffEvent).toBeLessThan(firstSteeringEvent)
    expect(firstSteeringEvent).toBeLessThan(finalSteeringEvent)
    expect(finalSteeringEvent).toBeLessThan(headerEvent)
    expect(agent.session.events.find(event => event.type === 'physical-operator/context-envelope')).toMatchObject({
      data: {
        operatorId: 'chatgpt-web',
        envelope: {
          task: finalSteering.content,
          contexts: request?.contextEnvelope?.contexts,
        },
      },
    })
  })

  it('keeps a Web request without a current admitted handoff unchanged', async () => {
    const { agent, chatgpt } = await setup({
      primary: 'chatgpt-web',
      registerDeepSeek: false,
    })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Historical handoff must not become current context.' }],
      source: { kind: 'plugin', plugin: 'chatgpt-web-handoff' },
    }), { surfaceOp: 'append' })

    send(agent, 'Run the current task without a new Web handoff.')
    await agent.whenIdle()

    expect(chatgpt.requests[0]?.contextEnvelope?.contexts).toEqual([])
    expect(JSON.stringify(chatgpt.requests[0]?.contextEnvelope)).not.toContain('Historical handoff must not become current context.')
  })

  it('does not attach a current Web handoff to a non-Web main operator', async () => {
    const { agent, codex } = await setup({
      primary: 'codex',
      registerDeepSeek: false,
    })
    const handoff = createUserMessage({
      content: [{ type: 'text', text: 'Web-only handoff must not cross to Codex.' }],
      source: { kind: 'plugin', plugin: 'chatgpt-web-handoff' },
    })
    agent.inject(handoff)
    send(agent, 'Run this current task with Codex.')
    await agent.whenIdle()

    expect(codex.requests[0]?.contextEnvelope?.contexts).toEqual([])
    expect(JSON.stringify(codex.requests[0]?.contextEnvelope)).not.toContain('Web-only handoff must not cross to Codex.')
  })

  it('keeps a selected ChatGPT Web main model sealed when the prompt looks Claude-shaped', async () => {
    const { agent, deepseek, codex, claude, chatgpt } = await setup({
      primary: 'chatgpt-web',
      registerDeepSeek: false,
      claudeStartErrorCode: 'AUTH_MODE_MISMATCH',
    })

    send(agent, '请深度分析这个架构设计，并给出三个可执行建议。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(codex.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(0)
    expect(chatgpt.requests).toHaveLength(1)
    expect(lastAssistantMessage(agent).source).toMatchObject({
      provider: 'dsh-physical-operator',
      model: 'chatgpt-web',
    })
  })

  it('keeps an installed Codex primary as coordinator when the prompt mentions Claude and ChatGPT Web', async () => {
    const { agent, deepseek, codex, claude, chatgpt } = await setup()
    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'dsh-physical-operator', model: 'codex' },
      assembled: undefined,
    })
    try {
      send(agent, 'Ask ChatGPT Web to plan this repository feature, then have Claude Code implement it.')
      await agent.whenIdle()

      expect(deepseek.requests).toHaveLength(0)
      expect(codex.requests).toHaveLength(1)
      expect(claude.requests).toHaveLength(0)
      expect(chatgpt.requests).toHaveLength(0)
      expect(codex.requests[0]?.systemPrompt).toContain('selected primary model remains the coordinator')
      expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
        data: { policy: 'auto', route: 'resident', operatorId: 'codex' },
      })
    } finally {
      disposeSelection()
    }
  })

  it('keeps a selected physical primary on tool-following steps instead of restoring an older fallback', async () => {
    const { ctx, agent } = await setup()
    const prompt = createUserMessage({
      content: [{ type: 'text', text: 'Continue with the selected primary model.' }],
      source: { kind: 'user' },
    })
    agent.session.append('user/message', prompt, { surfaceOp: 'append' })
    agent.session.append('physical-operator/dispatch', {
      commandId: 'legacy-fallback-route',
      operatorId: 'claude-code',
      promptMessageId: String(prompt.id),
      requestedByMessageId: String(prompt.id),
      turn: 1,
      step: 1,
      recovered: false,
      executionMode: 'resident',
      fallbackConfig: { provider: 'deepseek', model: 'deepseek' },
    }, { ignorable: true })

    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'dsh-physical-operator', model: 'codex' },
      assembled: undefined,
    })
    try {
      const signal = new AbortController().signal
      await ctx.systemPrompt.assemble(assembleContextFor(agent, signal))
      const config = await agentEvents(agent.ctx, agent).waterfall(
        'agent/request',
        { turn: 1, step: 2, signal },
        () => Promise.resolve({ provider: 'dsh-physical-operator', model: 'codex' }),
      )

      expect(config).toMatchObject({ provider: 'dsh-physical-operator', model: 'codex' })
      expect(agent.session.events.findLast(event => event.type === 'physical-operator/dispatch')).toMatchObject({
        data: { operatorId: 'codex', turn: 1, step: 2 },
      })
    } finally {
      disposeSelection()
    }
  })

  it('keeps an installed API primary while a ChatGPT Web preference guides downstream delegation', async () => {
    const { ctx, agent, deepseek, codex, claude, chatgpt } = await setup()
    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'deepseek', model: 'deepseek' },
      assembled: undefined,
    })
    try {
      await ctx.commands.execute(agent, '/operator chatgpt-web', new AbortController().signal)
      send(agent, 'Ask ChatGPT Web to plan this feature, then implement the approved plan.')
      await agent.whenIdle()

      expect(deepseek.requests).toHaveLength(1)
      expect(codex.requests).toHaveLength(0)
      expect(claude.requests).toHaveLength(0)
      expect(chatgpt.requests).toHaveLength(0)
      expect(deepseek.requests[0]?.system).toContain('CHATGPT WEB ADVISOR')
      expect(deepseek.requests[0]?.system).toContain('selected primary model remains the coordinator')
      expect(lastAssistantMessage(agent).source).toMatchObject({ provider: 'deepseek', model: 'deepseek' })
      const decision = agent.session.events.find(event => event.type === 'physical-operator/routing-decision')
      expect(decision).toMatchObject({
        data: { policy: 'chatgpt-web', route: 'primary-model' },
      })
      if (decision?.type !== 'physical-operator/routing-decision') throw new Error('expected routing decision')
      expect(decision.data.reason).toContain('下游委派指导')
    } finally {
      disposeSelection()
    }
  })

  it('keeps an installed ChatGPT Web primary when Claude Code is the saved preference', async () => {
    const { ctx, agent, deepseek, codex, claude, chatgpt } = await setup()
    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'dsh-physical-operator', model: 'chatgpt-web' },
      assembled: undefined,
    })
    try {
      await ctx.commands.execute(agent, '/operator claude-code', new AbortController().signal)
      send(agent, 'Use Claude Code to implement this TypeScript repository change.')
      await agent.whenIdle()

      expect(deepseek.requests).toHaveLength(0)
      expect(codex.requests).toHaveLength(0)
      expect(claude.requests).toHaveLength(0)
      expect(chatgpt.requests).toHaveLength(1)
      expect(chatgpt.requests[0]).toMatchObject({ mode: 'ephemeral' })
      expect(chatgpt.requests[0]?.nativeToolPolicy).toBeUndefined()
      expect(chatgpt.requests[0]?.modelToolBridge).toBeUndefined()
      expect(lastAssistantMessage(agent).source).toMatchObject({
        provider: 'dsh-physical-operator',
        model: 'chatgpt-web',
      })
      expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
        data: { policy: 'claude-code', route: 'ephemeral', operatorId: 'chatgpt-web' },
      })
    } finally {
      disposeSelection()
    }
  })

  it('keeps legacy explicit ChatGPT Web routing when no model selection is installed', async () => {
    const { ctx, agent, deepseek, claude, chatgpt } = await setup()
    await ctx.commands.execute(agent, '/operator claude-code', new AbortController().signal)

    send(agent, 'Ask ChatGPT Web to plan this feature before implementation.')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(0)
    expect(chatgpt.requests).toHaveLength(1)
    expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
      data: { policy: 'claude-code', route: 'ephemeral', operatorId: 'chatgpt-web' },
    })
  })

  it('keeps legacy explicit routing ahead of an Agent option when no model selection is installed', async () => {
    const { agent, codex, claude } = await setup({ primary: 'codex' })

    send(agent, 'Use Claude Code to analyze this architecture.')
    await agent.whenIdle()

    expect(codex.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(1)
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
      await bound.release()
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
      await restarted.release()
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
    await vi.waitFor(() => {
      expect(agent.session.events.find(event => (
        event.type === 'physical-operator/progress' && event.data.type === 'turn.observation'
      ))).toMatchObject({ data: { data: { kind: 'tool-completed', toolName: 'Read' } } })
    })
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

  it('selects and logs a template for the delegated tool task without inheriting the parent template', async () => {
    const { ctx, agent, codex } = await setup({
      taskTemplate: {
        id: taskTemplateId('delegated-review'),
        name: 'Delegated review',
        method: 'Use the delegated-review method for {{objective}}.',
        match: { objectiveKeywords: ['delegated'] },
      },
    })
    const parentTask = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Parent task.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PARENT TEMPLATE MUST NOT CROSS.' }],
      source: {
        kind: 'task-template',
        form: 'instructions',
        taskMessageId: parentTask.data.id,
        receipt: {
          receiptVersion: 1,
          decision: 'skip',
          overrideSource: 'none',
          candidates: [],
          rationale: ['fixture parent receipt'],
          attributes: {
            taskType: 'general', domain: 'general', objective: 'Parent task.', outputFormat: 'answer', riskLevel: 'low',
            tools: [], skills: [], operators: [], language: 'en', priority: 'normal',
          },
        },
      },
    }), { surfaceOp: 'append' })
    agent.session.append('request/header', {
      header: { config: { provider: 'deepseek', model: 'deepseek' }, system: 'fixture system' },
      reason: 'initial',
    })

    await callPhysicalOperator(ctx, agent, {
      action: 'run', operator_id: 'codex', description: 'review delegated work', prompt: 'Review the delegated code change.',
    })

    const request = codex.requests[0]
    expect(request?.contextEnvelope?.contexts).toEqual([expect.objectContaining({ name: 'task-template:delegated-review' })])
    expect(JSON.stringify(request?.contextEnvelope)).not.toContain('PARENT TEMPLATE MUST NOT CROSS.')
    const event = agent.session.events.find(value => value.type === 'physical-operator/context-envelope')
    expect(event).toMatchObject({
      data: {
        taskTemplate: {
          decision: 'inject',
          selected: { id: 'delegated-review' },
          receipt: { attributes: { objective: 'Review the delegated code change.' } },
        },
        envelope: { digest: request?.contextEnvelope?.digest },
      },
    })
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
      await bound.release()
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
      await bound.release()
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
      await firstBinding.release()
      await secondBinding.release()
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
      await bound.release()
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

  it('falls back only after Smart Auto cannot admit its selected Claude runtime', async () => {
    const { agent, deepseek, codex, claude } = await setup({
      claudeStartErrorCode: 'RUNTIME_UNAVAILABLE',
      claudeExecutionModes: ['ephemeral'],
      codexExecutionModes: ['ephemeral'],
    })

    send(agent, '你觉得 DSH 应该怎么优化架构更好')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(1)
    expect(agent.session.events.some(event => (
      event.type === 'physical-operator/dispatch-terminal'
      && event.data.code === 'RUNTIME_UNAVAILABLE'
    ))).toBe(true)
  })

  it.each(['INVALID_RESULT', 'QUOTA_EXHAUSTED'] as const)(
    'preserves a Smart Auto Claude %s error instead of switching providers',
    async (code) => {
      const { agent, deepseek, codex, claude } = await setup({
        claudeStartErrorCode: code,
        claudeExecutionModes: ['ephemeral'],
      })

      send(agent, '你觉得 DSH 应该怎么优化架构更好')
      await agent.whenIdle()

      expect(deepseek.requests).toHaveLength(0)
      expect(claude.requests).toHaveLength(1)
      expect(codex.requests).toHaveLength(0)
      expect(agent.session.events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'error', error: { code } } },
      })
    },
  )

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

  it('keeps a direct DeepSeek route sealed without probing Claude', async () => {
    const { ctx, agent, deepseek, codex, claude, chatgpt } = await setup({
      claudeStartErrorCode: 'AUTH_MODE_MISMATCH',
    })
    await ctx.commands.execute(agent, '/operator direct', new AbortController().signal)

    send(agent, '请深度分析这个架构设计，并给出三个可执行建议。')
    await agent.whenIdle()

    expect(deepseek.requests).toHaveLength(1)
    expect(codex.requests).toHaveLength(0)
    expect(claude.requests).toHaveLength(0)
    expect(chatgpt.requests).toHaveLength(0)
    expect(lastAssistantMessage(agent).source).toMatchObject({ provider: 'deepseek', model: 'deepseek' })
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

  it('lets Smart Auto dispatch recognized work to a physical operator while an API primary is selected', async () => {
    const { agent, deepseek, codex, claude } = await setup()
    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'deepseek', model: 'deepseek' },
      assembled: undefined,
    })
    try {
      send(agent, '给我修复这个 TypeScript 构建 bug 并补齐测试')
      await agent.whenIdle()

      expect(codex.requests).toHaveLength(1)
      expect(claude.requests).toHaveLength(0)
      expect(deepseek.requests).toHaveLength(0)
      expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
        data: { policy: 'auto', operatorId: 'codex', reason: '智能协作选择一个有界物理算子' },
      })
    } finally {
      disposeSelection()
    }
  })

  it('keeps a long single-task paste on the selected API primary under Smart Auto', async () => {
    const { agent, deepseek, codex, claude } = await setup()
    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'deepseek', model: 'deepseek' },
      assembled: undefined,
    })
    try {
      send(agent, `请帮我看看这段播客文字稿：${'主持人讨论了 CPU 与 GPU 在推理集群中的分工。'.repeat(20)}`)
      await agent.whenIdle()

      expect(deepseek.requests).toHaveLength(1)
      expect(codex.requests).toHaveLength(0)
      expect(claude.requests).toHaveLength(0)
      expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
        data: { policy: 'auto', route: 'primary-model' },
      })
    } finally {
      disposeSelection()
    }
  })

  it('asks the selected API primary to build a TaskGraph for parallel Smart Auto work', async () => {
    const { ctx, agent, deepseek, codex, claude } = await setup()
    ctx.tools.register(defineTool({
      name: 'orchestration',
      description: 'Start a durable TaskGraph.',
      parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: () => Promise.resolve('started'),
    }))
    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'deepseek', model: 'deepseek' },
      assembled: undefined,
    })
    try {
      send(agent, '请并行安排多个子任务，分别研究三个独立模块，最后综合验证结论。')
      await agent.whenIdle()

      expect(deepseek.requests).toHaveLength(1)
      expect(codex.requests).toHaveLength(0)
      expect(claude.requests).toHaveLength(0)
      const directive = agent.session.events.find(event => event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'physical-operator-taskgraph')
      expect(directive).toBeDefined()
      expect(JSON.stringify(deepseek.requests[0]?.messages)).toContain('call the `orchestration` tool with action=start')
      expect(agent.session.events.find(event => event.type === 'physical-operator/routing-decision')).toMatchObject({
        data: { policy: 'auto', route: 'taskgraph-candidate' },
      })
    } finally {
      disposeSelection()
    }
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
    expect(agent.session.events.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)
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

  it('rejects a profile model that the live Resident catalog does not advertise without mutating Session state', async () => {
    const { ctx, agent } = await setup()
    const invalidModel = await ctx.commands.execute(agent, '/operator-profile codex gpt-unknown xhigh', new AbortController().signal)
    expect(invalidModel?.result).toMatchObject({ kind: 'error' })
    expect(invalidModel?.result.text).toContain('not advertised by the live Resident catalog')
    expect(agent.session.events.filter(event => event.type === 'physical-operator/profile')).toHaveLength(0)

    const invalidEffort = await ctx.commands.execute(agent, '/operator-profile codex gpt-5.6-sol ultra', new AbortController().signal)
    expect(invalidEffort?.result).toMatchObject({ kind: 'error' })
    expect(invalidEffort?.result.text).toContain('does not advertise ultra effort')
    expect(agent.session.events.filter(event => event.type === 'physical-operator/profile')).toHaveLength(0)
  })

  it('rejects a profile when the Resident catalog is unavailable and permits the auto reset', async () => {
    const { ctx, agent } = await setup({ codexCatalogAvailable: false })
    agent.session.append('physical-operator/profile', {
      operatorId: 'codex', profile: { model: 'gpt-5.6-sol', effort: 'xhigh' },
    }, { ignorable: true })
    const rejected = await ctx.commands.execute(agent, '/operator-profile codex gpt-5.6-sol xhigh', new AbortController().signal)
    expect(rejected?.result).toMatchObject({ kind: 'error' })
    expect(rejected?.result.text).toContain('fixture Resident provider unavailable')
    expect(agent.session.events.filter(event => event.type === 'physical-operator/profile')).toHaveLength(1)

    const reset = await ctx.commands.execute(agent, '/operator-profile codex auto auto', new AbortController().signal)
    expect(reset?.result).toMatchObject({ kind: 'success' })
    expect(agent.session.events.findLast(event => event.type === 'physical-operator/profile')).toMatchObject({
      data: { operatorId: 'codex', profile: null },
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

  it('reattaches a pending Resident receipt when the selected physical main model stays the same', async () => {
    const { agent, codex } = await setup({ codexImmediate: false })
    const selection: ModelSelectionRef = {
      current: { provider: 'dsh-physical-operator', model: 'codex' },
      assembled: undefined,
    }
    const disposeSelection = installModelSelection(agent.ctx, selection)
    try {
      send(agent, '你好')
      while (codex.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
      const first = codex.requests[0]
      if (first === undefined) throw new Error('expected the initial Resident request')
      const commandId = String(first.executionId)
      const receipt = codex.receipts.get(commandId)
      if (receipt === undefined) throw new Error('expected the initial Resident receipt')

      agent.cancel({ kind: 'user' })
      await agent.whenIdle()
      send(agent, '继续啊')
      while (codex.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 1))

      expect(String(codex.requests[1]?.executionId)).toBe(commandId)
      expect(codex.productStarts).toBe(1)
      receipt.result.resolve({
        output: [{ type: 'text', text: 'reattached Resident result' }],
        stopReason: 'completed',
      })
      await agent.whenIdle()
    } finally {
      disposeSelection()
    }
  })

  it('uses a different selected physical main model instead of an older Resident continuation', async () => {
    const { agent, codex, chatgpt } = await setup({ primary: 'codex', codexImmediate: false })

    send(agent, '你好')
    while (codex.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()

    const disposeSelection = installModelSelection(agent.ctx, {
      current: { provider: 'dsh-physical-operator', model: 'chatgpt-web' },
      assembled: undefined,
    })
    try {
      send(agent, '继续啊')
      await agent.whenIdle()

      expect(codex.requests).toHaveLength(1)
      expect(codex.productStarts).toBe(1)
      expect(chatgpt.requests).toHaveLength(1)
    } finally {
      disposeSelection()
    }
  })

  it('does not replay an unfinished ChatGPT Web receipt through a continuation', async () => {
    const { agent, deepseek, chatgpt } = await setup()
    const prompt = createUserMessage({
      content: [{ type: 'text', text: '请用 ChatGPT 网页版回答：你好。' }],
      source: { kind: 'user' },
    })
    agent.session.append('user/message', prompt, { surfaceOp: 'append' })
    agent.session.append('physical-operator/dispatch', {
      commandId: 'unfinished-browser-receipt',
      operatorId: 'chatgpt-web',
      promptMessageId: String(prompt.id),
      requestedByMessageId: String(prompt.id),
      turn: 1,
      step: 0,
      recovered: false,
      executionMode: 'ephemeral',
    }, { ignorable: true })

    send(agent, '继续啊')
    await agent.whenIdle()

    expect(chatgpt.requests).toHaveLength(0)
    expect(deepseek.requests).toHaveLength(1)
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
