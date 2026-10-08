/** Fixed, logged model routes for a bounded kennel scheduling judgment. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, deepFreeze, HarnessError, LlmError, type GenerateOptions, type LlmFailure, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorExecutionId, PhysicalOperatorResult, PhysicalOperatorStartRequest } from '@deepseek-ai/dsh-physical-operator'

/** Deployment-owned routes; only an explicit DeepSeek balance failure permits Codex. */
export interface DispatchModelConfig {
  /** Explicit product Jev route; when present it runs before DeepSeek. */
  readonly jev?: {
    /** Registered provider name. */
    readonly provider: string
    /** Model identity offered by that provider. */
    readonly model: string
  }
  /** Default scheduling route when no product Jev route is configured. */
  readonly deepseek: {
    /** Registered DeepSeek provider name. */
    readonly provider: string
    /** Scheduling model identity. */
    readonly model: string
  }
  /** Subscription fallback used only for an explicit DeepSeek balance failure. */
  readonly codex: {
    /** Registered resident execution entry. */
    readonly operatorId: string
    /** Optional model; absence resolves the qualified catalog default. */
    readonly model?: string
  }
  /** Maximum reported output tokens per scheduling judgment. */
  readonly maxTokens: number
  /** Scheduling request deadline, in milliseconds. */
  readonly timeoutMs: number
  /** Maximum retained output bytes per scheduling judgment. */
  readonly maxOutputBytes: number
}
/** Complete request before dispatch and raw output or failure after settlement. */
export type DispatchModelRecord = {
  readonly source: 'jev' | 'deepseek' | 'codex'
  readonly config: DispatchModelConfig
} & (
  | { readonly phase: 'request'; readonly options: Omit<GenerateOptions, 'signal'>; readonly physicalRequest?: Omit<PhysicalOperatorStartRequest, 'parent' | 'signal'> }
  | { readonly phase: 'result'; readonly options?: Omit<GenerateOptions, 'signal'>; readonly chunks?: readonly StreamChunk[]; readonly output?: PhysicalOperatorResult; readonly usage?: TokenUsage; readonly failure?: LlmFailure }
)
/** Complete immutable input; tools must be absent or empty. */
export interface DispatchModelInput {
  readonly executionId: PhysicalOperatorExecutionId
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly options: Omit<GenerateOptions, 'provider' | 'model' | 'maxTokens' | 'signal'>
  /** Persist the event before resolving; persistence failures stop dispatch. */
  readonly record: (event: DispatchModelRecord) => Promise<void>
}
/** Raw judgment; JSON validation belongs to the dispatcher. */
export interface DispatchModelOutput {
  readonly text: string
  readonly provider: string
  readonly model?: string
  readonly source: 'jev' | 'deepseek' | 'codex'
  readonly fallbackReason?: 'INSUFFICIENT_BALANCE'
}
class BalanceFailure extends LlmError {}
function failure(error: unknown): LlmFailure {
  if (error instanceof LlmError) return error.failure
  return { code: error instanceof HarnessError ? error.code : 'DISPATCH_MODEL_ERROR', message: error instanceof Error ? error.message : String(error) }
}
function checkOutput(bytes: number, tokens: number | undefined, config: DispatchModelConfig): void {
  if (bytes > config.maxOutputBytes) throw new LlmError('Dispatch model output exceeds byte limit', 'OUTPUT_LIMIT')
  if (tokens !== undefined && tokens > config.maxTokens) throw new LlmError('Dispatch model output exceeds token limit', 'OUTPUT_LIMIT')
}
function textOf(output: PhysicalOperatorResult['output']): string {
  return output.filter(block => block.type === 'text').map(block => block.text).join('')
}
/**
 * Generate one judgment without retries; await stream closure or resident disposal.
 * @param ctx - registered product services.
 * @param config - model routes and operation limits.
 * @param input - complete input, agent, cancellation and persistence callback.
 * @returns raw text and actual route.
 */
export async function generateDispatchModel(
  ctx: Context, config: DispatchModelConfig, input: DispatchModelInput,
): Promise<DispatchModelOutput> {
  if (input.options.tools?.length) throw new LlmError('Scheduling judgments cannot expose tools', 'INVALID_DISPATCH_REQUEST')
  for (const value of [config.maxTokens, config.timeoutMs, config.maxOutputBytes]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new LlmError('Dispatch model limits must be positive integers', 'INVALID_DISPATCH_CONFIG')
  }
  const snapshot = deepFreeze(structuredClone(config))
  const base = deepFreeze(structuredClone(input.options))
  const controller = new AbortController()
  const abort = () => { controller.abort(input.signal.reason) }
  input.signal.addEventListener('abort', abort, { once: true })
  if (input.signal.aborted) abort()
  const timer = setTimeout(() => { controller.abort(new LlmError('Dispatch model timed out', 'TIMEOUT')) }, config.timeoutMs)
  const checkSignal = () => {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new LlmError('Dispatch model cancelled', 'ABORTED')
  }
  async function llm(source: 'jev' | 'deepseek', route: DispatchModelConfig['deepseek']): Promise<DispatchModelOutput> {
    const proposed = deepFreeze({ ...base, ...route, maxTokens: snapshot.maxTokens })
    const chunks: StreamChunk[] = []
    const assembler = new BlockAssembler()
    let bytes = 2
    let finished = false
    try {
      checkSignal()
      const service = ctx.get('llm')
      if (!service) throw new LlmError('LLM service unavailable', 'NO_ADAPTER')
      const prepared = await service.prepareCall(proposed, controller.signal)
      const options = deepFreeze({ ...base, ...prepared.config })
      await input.record({ phase: 'request', source, config: snapshot, options })
      checkSignal()
      for await (const chunk of prepared.stream(deepFreeze({ ...options, signal: controller.signal }))) {
        if (finished) throw new LlmError('Dispatch model emitted after finish', 'INVALID_RESPONSE')
        chunks.push(chunk)
        if (chunk.type === 'finish') finished = true
        assembler.push(chunk)
        bytes += Buffer.byteLength(JSON.stringify(chunk)) + (chunks.length > 1 ? 1 : 0)
        checkOutput(bytes, assembler.usage?.outputTokens, snapshot)
        checkSignal()
      }
      checkSignal()
      const finish = assembler.finish
      if (!finished) throw new LlmError('Dispatch model stream ended without finish', 'INVALID_RESPONSE')
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        const ErrorType = source === 'deepseek' && finish.kind === 'error' && finish.failure.code === 'INSUFFICIENT_BALANCE' ? BalanceFailure : LlmError
        throw new ErrorType(finish.failure.message, finish.failure.code, finish.failure)
      }
      if (finish.kind !== 'stop') throw new LlmError(`Dispatch model stopped with ${finish.kind}`, 'INVALID_RESPONSE')
      checkOutput(Buffer.byteLength(JSON.stringify(assembler.blocks())), assembler.usage?.outputTokens, snapshot)
    } catch (error) {
      await input.record({ phase: 'result', source, config: snapshot, options: proposed, chunks, ...assembler.usage === undefined ? {} : { usage: assembler.usage }, failure: failure(error) })
      throw error
    }
    await input.record({ phase: 'result', source, config: snapshot, chunks, ...assembler.usage === undefined ? {} : { usage: assembler.usage } })
    return { text: textOf(assembler.blocks()), ...route, source }
  }
  async function codex(): Promise<DispatchModelOutput> {
    let actualConfig = snapshot
    let options = deepFreeze({ ...base, provider: snapshot.codex.operatorId, model: snapshot.codex.model ?? '', maxTokens: snapshot.maxTokens })
    let output: PhysicalOperatorResult | undefined
    try {
      checkSignal()
      const service = ctx.get('physicalOperators')
      if (!service) throw new LlmError('Physical operator service unavailable', 'NO_OPERATOR')
      let model = snapshot.codex.model
      if (model === undefined) {
        const operator = service.getOperator(snapshot.codex.operatorId)
        if (!operator) throw new LlmError('Configured Codex operator is not registered', 'NO_OPERATOR')
        if (!operator.residentCatalog) throw new LlmError('Configured Codex operator has no resident model catalog', 'OPERATOR_UNAVAILABLE')
        const catalog = await operator.residentCatalog()
        checkSignal()
        if (!catalog.available) throw new LlmError(catalog.unavailableReason ?? 'Codex resident catalog is unavailable', 'OPERATOR_UNAVAILABLE')
        const selected = catalog.models.find(candidate => candidate.isDefault) ?? catalog.models[0]
        if (!selected) throw new LlmError('Codex resident catalog has no available model', 'OPERATOR_UNAVAILABLE')
        model = selected.resolvedModel ?? selected.model
      }
      actualConfig = deepFreeze({ ...snapshot, codex: { ...snapshot.codex, model } })
      options = deepFreeze({ ...base, provider: snapshot.codex.operatorId, model, maxTokens: snapshot.maxTokens })
      const { system: _system, ...promptOptions } = options
      const request = deepFreeze<Omit<PhysicalOperatorStartRequest, 'parent' | 'signal'>>({
        executionId: input.executionId, residentLaneId: `kennel-dispatch:${input.executionId}`, label: 'Kennel scheduling judgment',
        prompt: [{ type: 'text', text: JSON.stringify({ instruction: 'Return only the scheduling judgment. Do not execute the user task. Native tools are disabled.', request: promptOptions }) }],
        ...base.system === undefined ? {} : { systemPrompt: base.system }, mode: 'resident', nativeToolPolicy: 'disabled',
        generationLimits: { maxTokens: snapshot.maxTokens, maxOutputBytes: snapshot.maxOutputBytes, maxToolCalls: 0 },
        residentProfile: { model },
      })
      await input.record({ phase: 'request', source: 'codex', config: actualConfig, options, physicalRequest: request })
      checkSignal()
      const run = await service.start(snapshot.codex.operatorId, { ...request, parent: input.agent, signal: controller.signal })
      try { output = await run.result } finally { await run.dispose() }
      checkSignal()
      checkOutput(Buffer.byteLength(JSON.stringify(output)), output.usage?.outputTokens, snapshot)
      if (output.stopReason !== 'completed') throw new LlmError(`Codex judgment stopped with ${output.stopReason}`, 'INVALID_RESPONSE')
    } catch (error) {
      await input.record({ phase: 'result', source: 'codex', config: actualConfig, options,
        ...output === undefined ? {} : { output }, failure: failure(error) })
      throw error
    }
    await input.record({ phase: 'result', source: 'codex', config: actualConfig, output })
    return { text: textOf(output.output), provider: snapshot.codex.operatorId, model: options.model,
      source: 'codex', fallbackReason: 'INSUFFICIENT_BALANCE' }
  }
  try {
    if (snapshot.jev) return await llm('jev', snapshot.jev)
    try { return await llm('deepseek', snapshot.deepseek) } catch (error) {
      checkSignal()
      if (!(error instanceof BalanceFailure)) throw error
      return await codex()
    }
  } finally {
    clearTimeout(timer)
    input.signal.removeEventListener('abort', abort)
  }
}
