/** Provider-neutral recursive language model strategy seam. @module @deepseek-ai/dsh-rlm-strategy */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {
  ModelAllocationObjective,
  ModelTaskPhase,
  RlmExecutionMode,
} from '@deepseek-ai/dsh-model-allocation'

/** Hard recursion and turn limits for one node-local RLM plan. */
export interface RlmBudgetV1 {
  readonly maxDepth: number
  readonly maxChildren: number
  readonly maxTurns: number
}

/** User-visible RLM semantics sealed into one attempt. */
export type RlmExecutionFidelity = 'standard' | 'prime-strict' | 'dsh-optimized'

/** Complete deterministic input to the RLM strategy Provider. */
export interface RlmStrategyRequest {
  readonly runId: string
  readonly nodeId: string
  readonly phase: ModelTaskPhase
  readonly role: string
  readonly task: string
  readonly requestedMode: RlmExecutionMode
  /** User optimization intent. Omitted values retain the balanced baseline. */
  readonly objective?: ModelAllocationObjective
  readonly requestedBudget?: RlmBudgetV1
}

/** Immutable node-local recursion plan; it never creates or mutates the global TaskGraph. */
export interface RlmExecutionPlanV1 extends RlmBudgetV1 {
  readonly version: 1
  readonly enabled: boolean
  /** Explicit RLM uses Prime inheritance; Smart Auto may use DSH cost-aware child allocation. */
  readonly fidelity: RlmExecutionFidelity
  readonly strategyId: string
  readonly strategyVersion: string
  readonly reason: string
  readonly instruction: string
  readonly planSha256: string
}

/** Structured rejection of an invalid RLM strategy request. */
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

  /**
   * Resolve a bounded node-local RLM plan without modifying the global TaskGraph.
   * @param request User mode, node phase, task, and optional resource budget.
   * @returns An immutable, content-addressed RLM execution plan.
   */
  abstract resolve(request: RlmStrategyRequest): Promise<RlmExecutionPlanV1>
}

export default RlmStrategyService
