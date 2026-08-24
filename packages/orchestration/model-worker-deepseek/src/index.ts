/** DeepSeek official API last-resort orchestration worker. @module @deepseek-ai/dsh-model-worker-deepseek */

import { createConnection } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  BlockAssembler,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  type Message,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import { ModelWorkerError, type ModelWorkerExecuteRequest, type ModelWorkerProvider, type ModelWorkerResult, type ModelWorkerToolBridgeV1 } from '@deepseek-ai/dsh-model-worker'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

export const name = 'model-worker-deepseek'
/** Stable allocator identity for the metered DeepSeek API worker. */
export const DEEPSEEK_WORKER_ID = 'deepseek-api'
const MODELS = Object.freeze([
  { model: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', tier: 'low' as const },
  { model: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', tier: 'high' as const },
])

/** Last-resort DeepSeek API Provider used only after subscription offers. */
export class DeepSeekModelWorker implements ModelWorkerProvider {
  readonly id = DEEPSEEK_WORKER_ID
  private activeCount = 0

  constructor(private readonly ctx: Context) {}

  async offers(): Promise<ModelExecutionOffer[]> {
    const credentials = this.ctx.get('credentials')
    const available = credentials === undefined
      ? typeof process.env.DEEPSEEK_API_KEY === 'string' && process.env.DEEPSEEK_API_KEY.length > 0
      : await credentials.resolve(credentialRef('DEEPSEEK_API_KEY')) !== undefined
    return MODELS.map(model => ({
      offerId: `${this.id}:${model.model}`,
      operatorId: this.id,
      provider: 'deepseek-official',
      model: model.model,
      displayName: model.displayName,
      source: 'metered-api',
      tier: model.tier,
      available,
      maxConcurrency: 4,
      activeCount: this.activeCount,
      tags: ['api', 'deepseek', 'text-only', 'dynamic-tools'],
    }))
  }

  async execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult> {
    this.activeCount += 1
    try {
      if (request.rlmPlan?.enabled === true) {
        if (request.modelToolBridge === undefined) throw new ModelWorkerError('RLM model worker requires a genuine model-tool bridge', 'MODEL_WORKER_INVALID')
        return await this.generateWithTools(request, request.modelToolBridge)
      }
      return await this.generate(request, [createUserMessage({
        content: [...request.prompt],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-model-worker-deepseek' },
      })])
    } finally {
      this.activeCount -= 1
    }
  }

  private async generate(request: ModelWorkerExecuteRequest, messages: Message[]): Promise<ModelWorkerResult> {
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      provider: 'deepseek-official',
      model: request.model,
      messages,
      signal: request.signal,
    })) assembler.push(chunk)
    const finish = assembler.finish
    const stopReason = finish.kind === 'stop' ? 'completed' as const
      : finish.kind === 'max-tokens' ? 'max-tokens' as const
        : finish.kind === 'aborted' ? 'aborted' as const
          : 'error' as const
    return {
      output: assembler.blocks(),
      stopReason,
      ...assembler.usage === undefined ? {} : { usage: assembler.usage },
    }
  }

  private async generateWithTools(request: ModelWorkerExecuteRequest, bridge: ModelWorkerToolBridgeV1): Promise<ModelWorkerResult> {
    if (bridge.tools.length !== 1 || bridge.tools[0]?.name !== 'typescript_repl') {
      throw new ModelWorkerError('DeepSeek RLM requires the single qualified typescript_repl model tool', 'MODEL_WORKER_INVALID')
    }
    const messages: Message[] = [createUserMessage({
      content: [...request.prompt],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-model-worker-deepseek' },
    })]
    let usage: TokenUsage | undefined
    const maxToolRounds = Math.max(4, Math.min((request.rlmPlan?.maxTurns ?? 8) * 4, 64))
    for (let round = 0; round <= maxToolRounds; round += 1) {
      const assembler = new BlockAssembler()
      for await (const chunk of this.ctx.llm.stream({
        provider: 'deepseek-official',
        model: request.model,
        messages,
        tools: bridge.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: { ...tool.inputSchema } })),
        signal: request.signal,
      })) assembler.push(chunk)
      usage = mergeUsage(usage, assembler.usage)
      const blocks = assembler.blocks()
      if (assembler.finish.kind !== 'tool-calls') {
        const stopReason = assembler.finish.kind === 'stop' ? 'completed' as const
          : assembler.finish.kind === 'max-tokens' ? 'max-tokens' as const
            : assembler.finish.kind === 'aborted' ? 'aborted' as const
              : 'error' as const
        return { output: blocks, stopReason, ...usage === undefined ? {} : { usage } }
      }
      if (round === maxToolRounds) throw new ModelWorkerError('DeepSeek RLM exceeded the bounded model-tool round limit', 'MODEL_WORKER_INVALID')
      messages.push(createAssistantMessage({
        content: blocks,
        source: {
          provider: 'deepseek-official', model: request.model,
          ...assembler.replayState === undefined ? {} : { replayState: assembler.replayState },
        },
      }))
      const calls = blocks.filter(block => block.type === 'tool-call')
      if (calls.length === 0) throw new ModelWorkerError('DeepSeek returned tool_calls without a complete tool call', 'MODEL_WORKER_INVALID')
      for (const call of calls) {
        let isError = false
        let result: unknown
        try {
          if (!bridge.tools.some(tool => tool.name === call.name)) throw new Error(`tool is outside the sealed bridge: ${call.name}`)
          const argumentsValue = JSON.parse(call.arguments) as unknown
          if (argumentsValue === null || typeof argumentsValue !== 'object' || Array.isArray(argumentsValue)) throw new Error('tool arguments must be an object')
          result = await callModelToolBridge(
            bridge,
            call.name,
            argumentsValue as Readonly<Record<string, unknown>>,
            `${request.commandId}:deepseek-tool:${String(call.id)}`,
            request.signal,
          )
        } catch (error) {
          isError = true
          result = { error: error instanceof Error ? error.message : String(error) }
        }
        messages.push(createToolResultMessage({
          callId: call.id,
          content: [{ type: 'text', text: JSON.stringify(result) }],
          isError,
        }))
      }
    }
    throw new ModelWorkerError('DeepSeek RLM tool loop terminated unexpectedly', 'MODEL_WORKER_INVALID')
  }
}

function mergeUsage(left: TokenUsage | undefined, right: TokenUsage | undefined): TokenUsage | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    cacheWriteTokens: (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0),
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
  }
}

async function callModelToolBridge(
  bridge: ModelWorkerToolBridgeV1,
  tool: string,
  argumentsValue: Readonly<Record<string, unknown>>,
  commandId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const socket = createConnection(bridge.socketPath)
  const transport = new JsonRpcLineTransport(socket, socket)
  const connected = new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const abort = (): void => { socket.destroy(signal.reason instanceof Error ? signal.reason : new Error('model tool bridge aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await connected
    transport.start()
    return await transport.request('tool.call', {
      session_id: bridge.sessionId,
      command_id: commandId,
      tool,
      arguments: argumentsValue,
    }, signal)
  } finally {
    signal.removeEventListener('abort', abort)
    transport.close()
    socket.destroy()
  }
}

/** Services required by the billed DeepSeek worker Provider. */
export const inject = ['modelWorkers', 'llm']

export const apply = Object.assign(
  (ctx: Context): void => { ctx.modelWorkers.register(new DeepSeekModelWorker(ctx)) },
  { inject },
)
export default apply
