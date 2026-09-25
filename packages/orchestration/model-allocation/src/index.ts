/** Quota-aware model allocation capability seam. @module @deepseek-ai/dsh-model-allocation */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { PhysicalOperatorExecutionPreference } from '@deepseek-ai/dsh-physical-operator'
import type {
  AdaptiveExecutionRisk,
  AdaptiveExecutionPreferenceV1,
  ExecutionModelPreference,
  ModelAllocationObjective,
  PlannerVerifierPreference,
  RlmExecutionMode,
} from './strategy-types.ts'

export type * from './strategy-types.ts'

const ADAPTIVE_EXECUTION_RISKS = new Set<AdaptiveExecutionRisk>(['low', 'medium', 'high'])

/** Stable allocation failure codes used by Service-boundary validation. */
export type ModelAllocationErrorCode =
  | 'NO_MODEL_CAPACITY'
  | 'MODEL_CAPACITY_BUSY'
  | 'EXPLICIT_MODEL_UNAVAILABLE'
  | 'MODEL_ALLOCATION_INVALID'

function allocationInvalid(path: string, message: string): never {
  throw new ModelAllocationError(`${path}: ${message}`, 'MODEL_ALLOCATION_INVALID')
}

/**
 * Validate one adaptive preference received at a Provider boundary.
 * @param value - untrusted allocation preference.
 * @returns validated version-1 adaptive preference.
 */
export function validateAdaptiveExecutionPreference(value: unknown): AdaptiveExecutionPreferenceV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) allocationInvalid('adaptiveExecutionPreference', 'must be an object')
  const record = value as Record<string, unknown>
  const allowed = new Set(['version', 'executionRisk', 'priorFailures', 'crossDomain'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) allocationInvalid(`adaptiveExecutionPreference.${key}`, 'unknown field')
  }
  if (record.version !== 1) allocationInvalid('adaptiveExecutionPreference.version', 'must be 1')
  if (typeof record.executionRisk !== 'string' || !ADAPTIVE_EXECUTION_RISKS.has(record.executionRisk as AdaptiveExecutionRisk)) {
    allocationInvalid('adaptiveExecutionPreference.executionRisk', 'must be low, medium, or high')
  }
  if (typeof record.priorFailures !== 'number' || !Number.isSafeInteger(record.priorFailures) || record.priorFailures < 0) {
    allocationInvalid('adaptiveExecutionPreference.priorFailures', 'must be a non-negative safe integer')
  }
  if (record.crossDomain !== undefined && typeof record.crossDomain !== 'boolean') {
    allocationInvalid('adaptiveExecutionPreference.crossDomain', 'must be a boolean')
  }
  return {
    version: 1,
    executionRisk: record.executionRisk as AdaptiveExecutionRisk,
    priorFailures: record.priorFailures,
    crossDomain: record.crossDomain === true,
  }
}
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

/** Admission policy applied before a native-subscription offer may be scheduled. */
export interface ModelQuotaGuard {
  /** Whether an offer without a product-reported quota snapshot may start. */
  readonly unknownQuota: 'allow' | 'block'
  /** Remaining percentage reserved for a user-owned workload such as Claude PPT authoring. */
  readonly protectedRemainingPercent: number
  /** Stop admitting new work at or below this remaining percentage. */
  readonly stopAdmissionAtRemainingPercent: number
  /** Whether unused allowance may increase priority as its reset approaches. */
  readonly accelerateBeforeReset: boolean
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
  /** Why a known lane cannot currently qualify for explicit operator selection. */
  readonly unavailableReasonCode?: ModelAllocationFallbackReasonCode
  readonly quotaPool?: ModelQuotaPool
  readonly quotaGuard?: ModelQuotaGuard
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
  /** Operator ids admitted only when every preferred operator is unqualified. */
  readonly fallbackOperatorIds?: readonly string[]
  /** Explicit model requested from the preferred operator, when one was pinned. */
  readonly preferredModel?: string
  readonly objective: ModelAllocationObjective
  readonly plannerVerifierPreference?: PlannerVerifierPreference
  readonly executionPreference?: ExecutionModelPreference
  /** Optional adaptive hint; omission preserves the existing preference behavior. */
  readonly adaptiveExecutionPreference?: AdaptiveExecutionPreferenceV1
  readonly rlm: RlmExecutionMode
  readonly graphMaxParallel: number
  readonly offers: readonly ModelExecutionOffer[]
  readonly now: string
}

/** Stable reason why an explicit preferred operator was replaced. */
export type ModelAllocationFallbackReasonCode =
  | 'OPERATOR_UNAVAILABLE'
  | 'AUTHENTICATION_UNQUALIFIED'
  | 'MODEL_UNAVAILABLE'
  | 'QUOTA_UNQUALIFIED'

/** Structured provenance retained when an explicitly admitted fallback is selected. */
export interface ModelAllocationFallbackProvenance {
  readonly fromOperatorId: string
  readonly fromModel?: string
  readonly reasonCode: ModelAllocationFallbackReasonCode
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
  readonly fallback?: ModelAllocationFallbackProvenance
  readonly suggestedParallelism: number
  readonly rationale: readonly string[]
}

/** Structured model-capacity or explicit-selection failure. */
export class ModelAllocationError extends HarnessError {
  constructor(message: string, code: ModelAllocationErrorCode) {
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
   * @throws {ModelAllocationError} When no admitted lane qualifies, an explicit
   * model is unavailable, or qualified capacity is busy.
   */
  abstract allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan>
}

export default ModelAllocationService
