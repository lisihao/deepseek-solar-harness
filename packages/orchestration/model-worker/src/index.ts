/** Pluggable one-shot model worker registry. @module @deepseek-ai/dsh-model-worker */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError, type ContentBlock, type RequestAdmission, type RequestAdmissionInput, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'

/** Serializable owner-local tool bridge usable by an in-process model worker. */
export interface ModelWorkerToolBridgeV1 {
  readonly version: 1
  readonly socketPath: string
  readonly sessionId: string
  readonly tools: readonly {
    readonly name: string
    readonly description: string
    readonly inputSchema: Readonly<Record<string, unknown>>
  }[]
}

/**
 * The sealed evaluation scope of a request: the generation limits it must send and the admission that meters every physical
 * request it makes. Set only by an orchestration layer that holds a scope; a request without it keeps the worker's ordinary
 * behavior.
 */
export interface ModelWorkerEvaluationV1 {
  /** The model every physical request names on the wire, whatever the allocation chose for this request. */
  readonly model: string
  /** `max_tokens` ceiling of one physical request; the worker never sends more, and never falls back to a provider default. */
  readonly maxOutputTokens: number
  /** Reasoning effort id sent on every physical request. */
  readonly reasoningEffort: string
  /** Output tokens the scope can still reserve right now; advisory, because admission re-checks atomically. */
  remainingOutputTokens(): number
  /**
   * Admission for one physical request.
   * @param label - names the request in the scope's ledger (the logical command and the tool round).
   * @returns the admission to set on that request's `GenerateOptions`.
   */
  admission(label: string): RequestAdmission
}

/** Transport evidence for one actual provider request, separate from usage accounting. */
export interface ModelWorkerPhysicalRequestEvidence {
  /** Record entry to dispatch after any existing scope has admitted the request. */
  dispatching(): void
  /** Record proof of refusal before the provider dispatch can begin. */
  notSent(): void
  /** Record the provider's terminal response, including a response with no usage. */
  terminalResponse(): void
  /** Keep a dispatched request whose provider outcome cannot be proved. */
  unknown(): void
}

/**
 * Observe each serialized physical request before its provider dispatch.
 * This process-local observer supplies no quota, usage, or execution authority.
 * @param request - exact serialized request facts from the provider admission seam.
 * @returns the recorder owned by this physical request alone.
 */
export type ModelWorkerPhysicalRequestObserver = (request: RequestAdmissionInput) => ModelWorkerPhysicalRequestEvidence

/** Sealed one-shot request dispatched to a selected model worker. */
export interface ModelWorkerExecuteRequest {
  readonly commandId: string
  readonly workerId: string
  readonly model: string
  readonly prompt: readonly ContentBlock[]
  /** Exact orchestration Agent when this worker must enter a physical operator. */
  readonly parent?: Agent
  readonly rlmPlan?: RlmExecutionPlanV1
  readonly modelToolBridge?: ModelWorkerToolBridgeV1
  /** Present when the request runs under an evaluation scope; see {@link ModelWorkerEvaluationV1}. */
  readonly evaluation?: ModelWorkerEvaluationV1
  /** Optional attempt-owned evidence for every actual request, including all tool rounds and transport attempts. */
  readonly physicalRequestObserver?: ModelWorkerPhysicalRequestObserver
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
  /** True only when every physical request reaches the supplied request observer. */
  readonly observesPhysicalRequests?: boolean
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
    if (request.physicalRequestObserver !== undefined && provider.observesPhysicalRequests !== true) {
      throw new ModelWorkerError(`model worker cannot report physical request evidence: ${request.workerId}`, 'MODEL_WORKER_INVALID')
    }
    return provider.execute(request)
  }
}

export default ModelWorkerRuntime
