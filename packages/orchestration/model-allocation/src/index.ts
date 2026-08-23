/** Quota-aware model allocation capability seam. @module @deepseek-ai/dsh-model-allocation */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorExecutionPreference } from '@deepseek-ai/dsh-physical-operator'
import type {
  ModelAllocationObjective,
  RlmExecutionMode,
} from './strategy-types.ts'

export type * from './strategy-types.ts'
/** Position of a node in a quality-gated TaskGraph. */
export type ModelTaskPhase = 'planning' | 'execution' | 'verification' | 'synthesis'

/** One allowance window attached to an execution offer. */
export interface ModelQuotaWindow {
  readonly usedPercent: number
  readonly resetsAt?: number
  readonly windowDurationMinutes?: number
}

/** One independent subscription or billed-API pool. */
export interface ModelQuotaPool {
  readonly poolId: string
  readonly displayName: string
  readonly models: readonly string[]
  readonly meter: 'native-subscription' | 'metered-api'
  readonly primary?: ModelQuotaWindow
  readonly secondary?: ModelQuotaWindow
  readonly observedAt: string
}

/** One currently executable product/model lane. */
export interface ModelExecutionOffer {
  readonly offerId: string
  readonly operatorId: string
  readonly provider: string
  readonly model: string
  readonly displayName: string
  readonly source: 'native-subscription' | 'metered-api'
  readonly tier: 'low' | 'medium' | 'high'
  readonly available: boolean
  readonly maxConcurrency: number
  readonly activeCount: number
  readonly tags: readonly string[]
  readonly quotaPool?: ModelQuotaPool
  readonly profile?: PhysicalOperatorExecutionPreference
}

/** Complete deterministic allocation input for one ready node. */
export interface ModelAllocationRequest {
  readonly runId: string
  readonly nodeId: string
  readonly phase: ModelTaskPhase
  readonly role: string
  readonly task: string
  readonly preferredOperatorIds: readonly string[]
  readonly objective: ModelAllocationObjective
  readonly rlm: RlmExecutionMode
  readonly graphMaxParallel: number
  readonly offers: readonly ModelExecutionOffer[]
  readonly now: string
}

/** Sealed model choice and graph-wide concurrency advice. */
export interface ModelAllocationPlan {
  readonly offerId: string
  readonly operatorId: string
  readonly provider: string
  readonly model: string
  readonly source: ModelExecutionOffer['source']
  readonly tier: ModelExecutionOffer['tier']
  readonly profile?: PhysicalOperatorExecutionPreference
  readonly quotaPoolId?: string
  readonly suggestedParallelism: number
  readonly rationale: readonly string[]
}

/** Structured model-capacity or explicit-selection failure. */
export class ModelAllocationError extends HarnessError {
  constructor(message: string, code: 'NO_MODEL_CAPACITY' | 'MODEL_CAPACITY_BUSY' | 'EXPLICIT_MODEL_UNAVAILABLE') {
    super(message, code)
    this.name = 'ModelAllocationError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { modelAllocation: ModelAllocationService }
}

/** Scheduler-facing Service Definition; implementations remain replaceable plugins. */
export abstract class ModelAllocationService extends Service {
  constructor(ctx: Context) {
    if (new.target === ModelAllocationService) throw new Error('@deepseek-ai/dsh-model-allocation is an abstract seam; load a Provider')
    super(ctx, 'modelAllocation')
  }

  /**
   * Select one qualified execution offer and recommend safe parallelism.
   * @param request Node phase, policy, quota, and currently qualified offers.
   * @returns The selected model plan and parallelism recommendation.
   */
  abstract allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan>
}

export default ModelAllocationService
