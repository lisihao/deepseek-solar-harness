/** Provider-neutral recursive language model strategy seam. @module @deepseek-ai/dsh-rlm-strategy */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ModelTaskPhase, RlmExecutionMode } from '@deepseek-ai/dsh-model-allocation'

export interface RlmBudgetV1 {
  readonly maxDepth: number
  readonly maxChildren: number
  readonly maxTurns: number
}

export interface RlmStrategyRequest {
  readonly runId: string
  readonly nodeId: string
  readonly phase: ModelTaskPhase
  readonly role: string
  readonly task: string
  readonly requestedMode: RlmExecutionMode
  readonly requestedBudget?: RlmBudgetV1
}

/** Immutable node-local recursion plan; it never creates or mutates the global TaskGraph. */
export interface RlmExecutionPlanV1 extends RlmBudgetV1 {
  readonly version: 1
  readonly enabled: boolean
  readonly strategyId: string
  readonly strategyVersion: string
  readonly reason: string
  readonly instruction: string
  readonly planSha256: string
}

export class RlmStrategyError extends HarnessError {
  constructor(message: string) {
    super(message, 'RLM_STRATEGY_INVALID')
    this.name = 'RlmStrategyError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { rlmStrategy: RlmStrategyService }
}

/** Replaceable RLM policy Provider; the Scheduler consumes only its immutable plan. */
export abstract class RlmStrategyService extends Service {
  constructor(ctx: Context) {
    if (new.target === RlmStrategyService) throw new Error('@deepseek-ai/dsh-rlm-strategy is an abstract seam; load a Provider')
    super(ctx, 'rlmStrategy')
  }

  abstract resolve(request: RlmStrategyRequest): Promise<RlmExecutionPlanV1>
}

export default RlmStrategyService
