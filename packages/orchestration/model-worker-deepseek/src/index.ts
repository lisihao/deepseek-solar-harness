/** DeepSeek official API last-resort orchestration worker. @module @deepseek-ai/dsh-model-worker-deepseek */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import type { ModelWorkerExecuteRequest, ModelWorkerProvider, ModelWorkerResult } from '@deepseek-ai/dsh-model-worker'
import type { RlmExecutionPlanV1 } from '@deepseek-ai/dsh-rlm-strategy'

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
      tags: ['api', 'deepseek', 'text-only', 'no-tools'],
    }))
  }

  async execute(request: ModelWorkerExecuteRequest): Promise<ModelWorkerResult> {
    this.activeCount += 1
    try {
      if (request.rlmPlan?.enabled === true) return await this.executeRlm(request, request.rlmPlan)
      return await this.generate(request, request.prompt)
    } finally {
      this.activeCount -= 1
    }
  }

  private async generate(request: ModelWorkerExecuteRequest, prompt: readonly import('@deepseek-ai/dsh-llm').ContentBlock[]): Promise<ModelWorkerResult> {
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream({
      provider: 'deepseek-official',
      model: request.model,
      messages: [createUserMessage({
        content: [...prompt],
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-model-worker-deepseek' },
      })],
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

  private async executeRlm(request: ModelWorkerExecuteRequest, plan: RlmExecutionPlanV1): Promise<ModelWorkerResult> {
    const branches = Math.max(1, Math.min(plan.maxChildren, plan.maxTurns - 1, 4))
    const branchResults = await Promise.all(Array.from({ length: branches }, async (_value, index) => {
      return this.generate(request, [
        ...request.prompt,
        { type: 'text' as const, text: `RLM branch ${String(index + 1)} of ${String(branches)}: independently analyze one useful decomposition or solution path. Keep this branch self-contained and evidence-oriented.` },
      ])
    }))
    const branchText = branchResults.map((result, index) => {
      const text = result.output.filter(block => block.type === 'text').map(block => block.text).join('\n')
      return `Branch ${String(index + 1)}:\n${text}`
    }).join('\n\n')
    return this.generate(request, [
      ...request.prompt,
      { type: 'text', text: `Synthesize and verify the following independent RLM branches into one final answer. Resolve contradictions and retain concrete evidence.\n\n${branchText}` },
    ])
  }
}

/** Services required by the billed DeepSeek worker Provider. */
export const inject = ['modelWorkers', 'llm']

export const apply = Object.assign(
  (ctx: Context): void => { ctx.modelWorkers.register(new DeepSeekModelWorker(ctx)) },
  { inject },
)
export default apply
