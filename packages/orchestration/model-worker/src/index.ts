/** Pluggable one-shot model worker registry. @module @deepseek-ai/dsh-model-worker */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError, type ContentBlock, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'

/** Sealed one-shot request dispatched to a selected model worker. */
export interface ModelWorkerExecuteRequest {
  readonly commandId: string
  readonly workerId: string
  readonly model: string
  readonly prompt: readonly ContentBlock[]
  readonly rlmPlan?: RlmExecutionPlanV1
  readonly signal: AbortSignal
}

/** Bounded model-worker result returned to the Scheduler. */
export interface ModelWorkerResult {
  readonly output: readonly ContentBlock[]
  readonly stopReason: 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'
  readonly usage?: TokenUsage
}

/** Replaceable Provider that exposes offers and executes one-shot model work. */
export interface ModelWorkerProvider {
  readonly id: string
  offers(): Promise<readonly ModelExecutionOffer[]>
  execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult>
}

/** Structured model-worker registration or dispatch failure. */
export class ModelWorkerError extends HarnessError {
  constructor(message: string, code: 'MODEL_WORKER_UNAVAILABLE' | 'MODEL_WORKER_DUPLICATE' | 'MODEL_WORKER_INVALID') {
    super(message, code)
    this.name = 'ModelWorkerError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { modelWorkers: ModelWorkerRuntime }
}

/** Registry authority; concrete billed or local inference Providers remain separate plugins. */
export class ModelWorkerRuntime extends Service {
  private readonly providers = new Map<string, ModelWorkerProvider>()

  constructor(ctx: Context) { super(ctx, 'modelWorkers') }

  /**
   * Register a model worker Provider for the lifetime of the current plugin effect.
   * @param provider Provider that exposes offers and executes sealed requests.
   * @returns An effect disposer that unregisters the Provider.
   */
  register(provider: ModelWorkerProvider): () => Promise<void> {
    return this.ctx.effect(function* (this: ModelWorkerRuntime) {
      if (this.providers.has(provider.id)) throw new ModelWorkerError(`duplicate model worker: ${provider.id}`, 'MODEL_WORKER_DUPLICATE')
      this.providers.set(provider.id, provider)
      yield () => { this.providers.delete(provider.id) }
    }.bind(this), 'modelWorkers.register()')
  }

  /**
   * List the currently available model execution offers from every Provider.
   * @returns A flattened snapshot of qualified execution offers.
   */
  async offers(): Promise<ModelExecutionOffer[]> {
    return (await Promise.all([...this.providers.values()].map(provider => provider.offers()))).flat()
  }

  /**
   * Dispatch a sealed worker request to its selected Provider.
   * @param request Selected worker, model, sealed prompt, and optional RLM plan.
   * @returns The bounded model output and usage metadata.
   */
  execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult> {
    const provider = this.providers.get(request.workerId)
    if (provider === undefined) throw new ModelWorkerError(`unknown model worker: ${request.workerId}`, 'MODEL_WORKER_UNAVAILABLE')
    return provider.execute(request)
  }
}

export default ModelWorkerRuntime
