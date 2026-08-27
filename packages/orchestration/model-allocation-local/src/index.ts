/** Deterministic subscription-first allocation Provider. @module @deepseek-ai/dsh-model-allocation-local */

import type { Context } from '@deepseek-ai/cordis'
import ModelAllocationService, {
  ModelAllocationError,
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

function codexFamily(offer: ModelExecutionOffer, family: 'sol' | 'luna'): boolean {
  return offer.provider === 'codex'
    && new RegExp(`(?:^|[._-])${family}(?:$|[._-])`, 'u').test(offer.model.toLowerCase())
}

function policyCandidates(
  candidates: readonly ModelExecutionOffer[],
  request: ModelAllocationRequest,
): readonly ModelExecutionOffer[] {
  if ((request.phase === 'planning' || request.phase === 'verification')
    && request.plannerVerifierPreference === 'codex-sol') {
    const sol = candidates.filter(offer => offer.tier === 'high' && codexFamily(offer, 'sol'))
    if (sol.length > 0) return sol
  }
  if (request.executionPreference === 'luna-first' && isCodingExecution(request)) {
    const luna = candidates.filter(offer => codexFamily(offer, 'luna'))
    if (luna.length > 0) return luna
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

/** Public deterministic Provider, separately mountable from the Scheduler. */
export class SubscriptionFirstModelAllocation extends ModelAllocationService {
  allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan> {
    const qualified = request.offers.filter(offer => offer.available && quotaAdmitted(offer))
    const explicitQualified = request.preferredOperatorIds.length === 0
      ? qualified
      : qualified.filter(offer => request.preferredOperatorIds.includes(offer.operatorId))
    if (request.preferredOperatorIds.length > 0 && explicitQualified.length === 0) {
      throw new ModelAllocationError(
        `none of the explicitly preferred operators has capacity: ${request.preferredOperatorIds.join(', ')}`,
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
    const routedCandidates = policyCandidates(qualityCandidates, request)
    const nowSeconds = Math.floor(Date.parse(request.now) / 1_000)
    const [selected] = [...routedCandidates].sort((left, right) => {
      const difference = score(right, request, nowSeconds) - score(left, request, nowSeconds)
      return difference === 0 ? left.offerId.localeCompare(right.offerId) : difference
    })
    if (selected === undefined) throw new ModelAllocationError('no qualified model execution capacity is available', 'NO_MODEL_CAPACITY')
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
      suggestedParallelism: suggestedParallelism(request, explicitQualified),
      rationale: [
        selected.source === 'native-subscription' ? 'native-subscription-first' : 'metered-api-last-resort',
        request.phase === 'planning' || request.phase === 'verification' ? 'high-tier-quality-gate' : 'worker-tier-throughput',
        ...request.plannerVerifierPreference === 'codex-sol' && codexFamily(selected, 'sol')
          ? ['codex-sol-planner-verifier']
          : [],
        ...request.executionPreference === 'luna-first' && codexFamily(selected, 'luna')
          ? ['codex-luna-worker']
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
