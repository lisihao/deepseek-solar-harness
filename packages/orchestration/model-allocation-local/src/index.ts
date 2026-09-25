/** Deterministic subscription-first allocation Provider. @module @deepseek-ai/dsh-model-allocation-local */

import type { Context } from '@deepseek-ai/cordis'
import ModelAllocationService, {
  ModelAllocationError,
  validateAdaptiveExecutionPreference,
  type AdaptiveExecutionPreferenceV1,
  type ModelAllocationFallbackProvenance,
  type ModelAllocationFallbackReasonCode,
  type ModelAllocationPlan,
  type ModelAllocationRequest,
  type ModelExecutionOffer,
  type ModelQuotaWindow,
} from '@deepseek-ai/dsh-model-allocation'

export const name = 'model-allocation-local'

const RESET_ACCELERATION_SECONDS = 6 * 60 * 60

function remaining(window: ModelQuotaWindow | undefined): number {
  return window === undefined ? 100 : Math.max(0, 100 - window.usedPercent)
}

function poolRemaining(offer: ModelExecutionOffer): number | undefined {
  const pool = offer.quotaPool
  if (pool === undefined) return undefined
  const windows = [pool.primary, pool.secondary].filter(window => window !== undefined)
  return windows.length === 0 ? undefined : Math.min(...windows.map(window => remaining(window)))
}

function quotaAdmitted(offer: ModelExecutionOffer): boolean {
  if (offer.source === 'metered-api') return true
  const observed = poolRemaining(offer)
  const guard = offer.quotaGuard
  if (observed === undefined) return guard?.unknownQuota !== 'block'
  return observed > (guard?.stopAdmissionAtRemainingPercent ?? 0)
}

/**
 * A requested model is an exact pin at the allocation boundary.  Provider
 * aliases should already have been normalized into `offer.model` before they
 * reach this Provider; silently matching a sibling model here would turn an
 * explicit Opus/Sonnet (or Sol/Luna) selection into an accidental downgrade.
 */
function matchesRequestedModel(offer: ModelExecutionOffer, requestedModel: string | undefined): boolean {
  return requestedModel === undefined || offer.model === requestedModel
}

function resetUrgency(window: ModelQuotaWindow | undefined, nowSeconds: number): number {
  if (window?.resetsAt === undefined) return 0
  const seconds = window.resetsAt - nowSeconds
  if (seconds <= 0 || seconds > RESET_ACCELERATION_SECONDS) return 0
  return Math.round((1 - (seconds / RESET_ACCELERATION_SECONDS)) * remaining(window) * 3)
}

function qualityFit(offer: ModelExecutionOffer, request: ModelAllocationRequest): number {
  const highPhase = request.phase === 'planning' || request.phase === 'verification' || request.phase === 'synthesis'
  const wantsHigh = highPhase || request.rlm === 'enabled'
  if (wantsHigh) return offer.tier === 'high' ? 260 : offer.tier === 'medium' ? 80 : -220
  if (request.objective === 'quality') return offer.tier === 'high' ? 220 : offer.tier === 'medium' ? 100 : 0
  if (request.objective === 'speed' || request.objective === 'economy') {
    return offer.tier === 'low' ? 220 : offer.tier === 'medium' ? 160 : 20
  }
  return offer.tier === 'medium' ? 180 : offer.tier === 'low' ? 120 : 80
}

function productFit(offer: ModelExecutionOffer, request: ModelAllocationRequest): number {
  const text = `${request.role} ${request.task}`.toLowerCase()
  if (/architect|review|analysis|research|long.context|架构|审查|研究|长上下文/u.test(text)) {
    return offer.provider === 'claude-code' ? 120 : 0
  }
  if (/implement|debug|test|code|repo|实现|调试|测试|代码|仓库/u.test(text)) {
    return offer.provider === 'codex' ? 120 : 0
  }
  return 0
}

function isCodingExecution(request: ModelAllocationRequest): boolean {
  if (request.phase !== 'execution') return false
  return /implement|debug|test|code|repo|worker|实现|调试|测试|代码|仓库|执行/u
    .test(`${request.role} ${request.task}`.toLowerCase())
}

function adaptiveTarget(
  request: ModelAllocationRequest,
  preference: AdaptiveExecutionPreferenceV1 | undefined,
): 'luna' | 'terra' | undefined {
  if (preference === undefined || !isCodingExecution(request)) return undefined
  const escalated = preference.executionRisk !== 'low'
    || preference.priorFailures > 0
    || preference.crossDomain === true
  return escalated ? 'terra' : 'luna'
}

function codexFamily(offer: ModelExecutionOffer, family: 'sol' | 'luna' | 'terra'): boolean {
  return offer.provider === 'codex'
    && new RegExp(`(?:^|[._-])${family}(?:$|[._-])`, 'u').test(offer.model.toLowerCase())
}

function claudeFamily(offer: ModelExecutionOffer, family: 'frontier' | 'sonnet'): boolean {
  if (offer.provider !== 'claude-code') return false
  const model = `${offer.model} ${offer.displayName}`.toLowerCase()
  return family === 'frontier'
    ? /(?:^|[ ._-])(opus|fable)(?:$|[ ._-])/u.test(model)
    : /(?:^|[ ._-])sonnet(?:$|[ ._-])/u.test(model)
}

function policyCandidates(
  candidates: readonly ModelExecutionOffer[],
  request: ModelAllocationRequest,
  adaptivePreference: AdaptiveExecutionPreferenceV1 | undefined,
): readonly ModelExecutionOffer[] {
  if ((request.phase === 'planning' || request.phase === 'verification')
    && request.plannerVerifierPreference === 'codex-sol') {
    const sol = candidates.filter(offer => offer.tier === 'high' && codexFamily(offer, 'sol'))
    if (sol.length > 0) return sol
  }
  if ((request.phase === 'planning' || request.phase === 'verification')
    && request.plannerVerifierPreference === 'claude-frontier') {
    const frontier = candidates.filter(offer => offer.tier === 'high' && claudeFamily(offer, 'frontier'))
    if (frontier.length > 0) return frontier
  }
  const target = request.executionPreference === 'claude-sonnet'
    ? undefined
    : adaptiveTarget(request, adaptivePreference)
  if (target !== undefined) {
    const preferred = candidates.filter(offer => codexFamily(offer, target))
    if (preferred.length > 0) return preferred
  }
  if (request.executionPreference === 'luna-first' && isCodingExecution(request)) {
    const luna = candidates.filter(offer => codexFamily(offer, 'luna'))
    if (luna.length > 0) return luna
  }
  if (request.executionPreference === 'claude-sonnet' && request.phase === 'execution') {
    const sonnet = candidates.filter(offer => claudeFamily(offer, 'sonnet'))
    if (sonnet.length > 0) return sonnet
  }
  return candidates
}

function poolFit(offer: ModelExecutionOffer, nowSeconds: number): number {
  if (offer.source === 'metered-api') return -10_000
  const pool = offer.quotaPool
  if (pool === undefined) return 1_000
  // Reported windows are simultaneous allowance constraints, not alternatives.
  // A depleted short window therefore makes the lane unavailable even when its
  // weekly bucket still has room.
  const usable = poolRemaining(offer)
  if (usable === undefined) return 1_000
  if (!quotaAdmitted(offer)) return -100_000
  const urgency = offer.quotaGuard?.accelerateBeforeReset === false
    ? 0
    : resetUrgency(pool.primary, nowSeconds) + resetUrgency(pool.secondary, nowSeconds)
  return 1_000 + urgency
}

function capacityFit(offer: ModelExecutionOffer): number {
  const free = offer.maxConcurrency - offer.activeCount
  return free <= 0 ? -100_000 : free * 20
}

function score(offer: ModelExecutionOffer, request: ModelAllocationRequest, nowSeconds: number): number {
  return poolFit(offer, nowSeconds) + qualityFit(offer, request) + productFit(offer, request) + capacityFit(offer)
}

function operatorCapacity(offers: readonly ModelExecutionOffer[], source: ModelExecutionOffer['source']): number {
  const capacity = new Map<string, number>()
  for (const offer of offers.filter(value => value.source === source)) {
    const free = Math.max(0, offer.maxConcurrency - offer.activeCount)
    capacity.set(offer.operatorId, Math.max(capacity.get(offer.operatorId) ?? 0, free))
  }
  return [...capacity.values()].reduce((total, value) => total + value, 0)
}

function suggestedParallelism(request: ModelAllocationRequest, qualified: readonly ModelExecutionOffer[]): number {
  const subscriptionCapacity = operatorCapacity(qualified, 'native-subscription')
  const meteredCapacity = operatorCapacity(qualified, 'metered-api')
  const usable = subscriptionCapacity > 0
    ? subscriptionCapacity + (request.objective === 'speed' ? meteredCapacity : 0)
    : request.objective === 'speed' ? meteredCapacity : Math.min(meteredCapacity, 1)
  return Math.max(1, Math.min(request.graphMaxParallel, usable))
}

function fallbackProvenance(
  request: ModelAllocationRequest,
  preferredOffers: readonly ModelExecutionOffer[],
  primaryOperatorId: string,
): ModelAllocationFallbackProvenance {
  const primaryOffers = preferredOffers.filter(offer => offer.operatorId === primaryOperatorId)
  const modelOffers = request.preferredModel === undefined
    ? primaryOffers
    : primaryOffers.filter(offer => offer.model === request.preferredModel)
  const reasonOrder: readonly ModelAllocationFallbackReasonCode[] = [
    'AUTHENTICATION_UNQUALIFIED',
    'OPERATOR_UNAVAILABLE',
    'QUOTA_UNQUALIFIED',
    'MODEL_UNAVAILABLE',
  ]
  const quotaRejected = primaryOffers.some(offer => offer.available && !quotaAdmitted(offer))
  const reportedReasons = new Set(primaryOffers.flatMap(offer => (
    offer.unavailableReasonCode === undefined ? [] : [offer.unavailableReasonCode]
  )))
  // Preserve an explicit provider/auth/quota failure before diagnosing a
  // missing model.  A provider may expose a canonical model name different
  // from the caller's display alias while it is unavailable for another
  // reason; that must not be mislabeled as MODEL_UNAVAILABLE.
  const reportedReason = reasonOrder.find(reason => reportedReasons.has(reason))
  const reasonCode = quotaRejected
    ? 'QUOTA_UNQUALIFIED'
    : reportedReason !== undefined && reportedReason !== 'MODEL_UNAVAILABLE'
      ? reportedReason
      : request.preferredModel !== undefined && primaryOffers.length > 0 && modelOffers.length === 0
        ? 'MODEL_UNAVAILABLE'
        : reportedReason ?? 'OPERATOR_UNAVAILABLE'
  return {
    fromOperatorId: primaryOperatorId,
    ...request.preferredModel === undefined ? {} : { fromModel: request.preferredModel },
    reasonCode,
  }
}

/** Public deterministic Provider, separately mountable from the Scheduler. */
export class SubscriptionFirstModelAllocation extends ModelAllocationService {
  allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan> {
    const adaptivePreference = request.adaptiveExecutionPreference === undefined
      ? undefined
      : validateAdaptiveExecutionPreference(request.adaptiveExecutionPreference)
    const qualified = request.offers.filter(offer => offer.available && quotaAdmitted(offer))
    const preferredOffers = request.offers.filter(offer => request.preferredOperatorIds.includes(offer.operatorId))
    const preferredQualified = qualified.filter(offer => request.preferredOperatorIds.includes(offer.operatorId)
      && matchesRequestedModel(offer, request.preferredModel))
    const fallbackOperatorIds = request.fallbackOperatorIds ?? []
    const primaryOperatorId = request.preferredOperatorIds[0]
    const fallback = primaryOperatorId !== undefined
      && preferredQualified.length === 0
      && fallbackOperatorIds.length > 0
      ? fallbackProvenance(request, preferredOffers, primaryOperatorId)
      : undefined
    const explicitQualified = request.preferredOperatorIds.length === 0
      ? qualified.filter(offer => matchesRequestedModel(offer, request.preferredModel))
      : preferredQualified.length > 0
        ? preferredQualified
        : qualified.filter(offer => fallbackOperatorIds.includes(offer.operatorId))
    if ((request.preferredOperatorIds.length > 0 || request.preferredModel !== undefined)
      && explicitQualified.length === 0) {
      throw new ModelAllocationError(
        fallback === undefined
          ? request.preferredOperatorIds.length > 0
            ? `none of the explicitly preferred operators has the requested model or capacity: ${request.preferredOperatorIds.join(', ')}`
            : `the requested model is unavailable or has no capacity: ${request.preferredModel}`
          : `neither the explicitly preferred nor fallback operators have capacity: ${[
            ...request.preferredOperatorIds, ...fallbackOperatorIds,
          ].join(', ')}`,
        'EXPLICIT_MODEL_UNAVAILABLE',
      )
    }
    if (explicitQualified.length === 0) {
      throw new ModelAllocationError('no qualified model execution capacity is available', 'NO_MODEL_CAPACITY')
    }
    const requiresHighTier = request.phase === 'planning'
      || request.phase === 'verification'
      || request.phase === 'synthesis'
      || request.rlm === 'enabled'
    const subscriptionQualified = explicitQualified.filter(offer => offer.source === 'native-subscription')
    const highSubscriptionAvailable = subscriptionQualified.some(offer => offer.tier === 'high')
    const allocationPool = subscriptionQualified.length > 0
      && request.objective !== 'speed'
      && (!requiresHighTier || highSubscriptionAvailable)
      ? subscriptionQualified
      : explicitQualified
    const candidates = allocationPool.filter(offer => offer.activeCount < offer.maxConcurrency)
    if (candidates.length === 0) {
      throw new ModelAllocationError('qualified model execution capacity is temporarily busy', 'MODEL_CAPACITY_BUSY')
    }
    const qualityCandidates = requiresHighTier && candidates.some(offer => offer.tier === 'high')
      ? candidates.filter(offer => offer.tier === 'high')
      : candidates
    const routedCandidates = policyCandidates(qualityCandidates, request, adaptivePreference)
    const nowSeconds = Math.floor(Date.parse(request.now) / 1_000)
    const [selected] = [...routedCandidates].sort((left, right) => {
      const difference = score(right, request, nowSeconds) - score(left, request, nowSeconds)
      return difference === 0 ? left.offerId.localeCompare(right.offerId) : difference
    })
    if (selected === undefined) throw new ModelAllocationError('no qualified model execution capacity is available', 'NO_MODEL_CAPACITY')
    const adaptiveTargetModel = adaptiveTarget(request, adaptivePreference)
    const adaptiveTargetAvailable = adaptiveTargetModel !== undefined
      && candidates.some(offer => codexFamily(offer, adaptiveTargetModel))
    const urgentCapacity = candidates.filter(offer => offer.quotaPool !== undefined
      && offer.quotaGuard?.accelerateBeforeReset !== false && (
      resetUrgency(offer.quotaPool.primary, nowSeconds) > 0 || resetUrgency(offer.quotaPool.secondary, nowSeconds) > 0
    )).length
    return Promise.resolve({
      offerId: selected.offerId,
      operatorId: selected.operatorId,
      provider: selected.provider,
      model: selected.model,
      source: selected.source,
      tier: selected.tier,
      ...selected.profile === undefined ? {} : { profile: selected.profile },
      ...selected.quotaPool === undefined ? {} : { quotaPoolId: selected.quotaPool.poolId },
      ...fallback === undefined ? {} : { fallback },
      suggestedParallelism: suggestedParallelism(request, explicitQualified),
      rationale: [
        selected.source === 'native-subscription' ? 'native-subscription-first' : 'metered-api-last-resort',
        request.phase === 'planning' || request.phase === 'verification' ? 'high-tier-quality-gate' : 'worker-tier-throughput',
        ...request.plannerVerifierPreference === 'codex-sol' && codexFamily(selected, 'sol')
          ? ['codex-sol-planner-verifier']
          : [],
        ...request.plannerVerifierPreference === 'claude-frontier' && claudeFamily(selected, 'frontier')
          ? ['claude-frontier-planner-verifier']
          : [],
        ...request.executionPreference === 'luna-first' && codexFamily(selected, 'luna')
          ? ['codex-luna-worker']
          : [],
        ...request.executionPreference === 'claude-sonnet' && claudeFamily(selected, 'sonnet')
          ? ['claude-sonnet-worker']
          : [],
        ...adaptiveTargetModel !== undefined && codexFamily(selected, adaptiveTargetModel)
          ? [`adaptive-codex-${adaptiveTargetModel}-${adaptiveTargetModel === 'luna' ? 'low-risk' : 'escalated'}`]
          : adaptiveTargetModel !== undefined && !adaptiveTargetAvailable
            ? [`adaptive-${adaptiveTargetModel}-unavailable-fallback`]
            : [],
        ...selected.quotaPool === undefined ? [] : [`quota-pool:${selected.quotaPool.poolId}`],
        ...selected.quotaGuard === undefined || selected.quotaGuard.protectedRemainingPercent === 0
          ? []
          : [`protected-reserve:${String(selected.quotaGuard.protectedRemainingPercent)}%`],
        ...urgentCapacity === 0 ? [] : ['accelerate-before-quota-reset'],
      ],
    })
  }
}

export function apply(ctx: Context): void { new SubscriptionFirstModelAllocation(ctx) }
export default SubscriptionFirstModelAllocation
