/**
 * Text-only orchestration adapter for the authenticated ChatGPT website.
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/model-worker
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import {
  ModelWorkerError,
  type ModelWorkerExecuteRequest,
  type ModelWorkerProvider,
  type ModelWorkerResult,
} from '@deepseek-ai/dsh-model-worker'
import { PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'

/** Stable model-worker and physical-operator identity for ChatGPT Web. */
export const CHATGPT_WEB_MODEL_WORKER_ID = 'chatgpt-web'
/** Routing token meaning that the user-selected website model remains authoritative. */
export const CHATGPT_WEB_WEBSITE_DEFAULT_MODEL = 'website-default'

const ROUTING_TAGS = Object.freeze(['browser-subscription', 'text-only', 'planning', 'research'])

/**
 * Dispatches one text-only advisory request through the existing ephemeral
 * ChatGPT Web physical operator without inventing a website model identity.
 */
export class ChatGptWebModelWorker implements ModelWorkerProvider {
  constructor(
    private readonly ctx: Context,
    readonly id = CHATGPT_WEB_MODEL_WORKER_ID,
  ) {}

  /** Return the single website-selected route using live physical-operator admission state. */
  offers(): Promise<readonly ModelExecutionOffer[]> {
    const status = this.ctx.physicalOperators.list().find(value => String(value.id) === this.id)
    const unavailable = status === undefined || status.state === 'unavailable'
    return Promise.resolve([{
      offerId: `${this.id}:${CHATGPT_WEB_WEBSITE_DEFAULT_MODEL}`,
      operatorId: this.id,
      provider: 'chatgpt-web',
      model: CHATGPT_WEB_WEBSITE_DEFAULT_MODEL,
      displayName: 'ChatGPT Web — website selection',
      source: 'native-subscription',
      tier: 'high',
      available: !unavailable,
      maxConcurrency: status?.maxConcurrency ?? 0,
      activeCount: status?.active ?? 0,
      tags: ROUTING_TAGS,
      ...unavailable ? { unavailableReasonCode: 'OPERATOR_UNAVAILABLE' as const } : {},
    }])
  }

  /**
   * Submit a sealed text prompt through the ephemeral physical operator and
   * wait for its browser work to settle before releasing the run holder.
   * @param request - selected route, text prompt, parent Agent, and cancellation signal.
   * @returns the physical operator terminal output with compatible token metadata.
   */
  async execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult> {
    if (request.parent === undefined) {
      throw new ModelWorkerError('ChatGPT Web model worker requires an orchestration parent Agent', 'MODEL_WORKER_INVALID')
    }
    if (request.model !== CHATGPT_WEB_WEBSITE_DEFAULT_MODEL) {
      throw new ModelWorkerError('ChatGPT Web model worker requires website-default routing', 'MODEL_WORKER_INVALID')
    }
    if (request.rlmPlan?.enabled === true) {
      throw new ModelWorkerError('ChatGPT Web model worker does not support RLM execution', 'MODEL_WORKER_INVALID')
    }
    if (request.modelToolBridge !== undefined) {
      throw new ModelWorkerError('ChatGPT Web model worker does not support a model-tool bridge', 'MODEL_WORKER_INVALID')
    }
    const run = await this.ctx.physicalOperators.start(this.id, {
      executionId: PhysicalOperatorExecutionId(request.commandId),
      mode: 'ephemeral',
      prompt: [...request.prompt],
      parent: request.parent,
      signal: request.signal,
    })
    try {
      const result = await run.result
      const usage = result.usage
      return {
        output: result.output,
        stopReason: result.stopReason,
        ...usage === undefined ? {} : {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...usage.cacheReadInputTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadInputTokens },
            ...usage.cacheWriteInputTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteInputTokens },
          },
        },
      }
    } finally {
      await run.dispose()
    }
  }
}
