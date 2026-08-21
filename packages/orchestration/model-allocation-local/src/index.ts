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
    return offer.operatorId === 'claude-code' ? 120 : 0
  }
  if (/implement|debug|test|code|repo|实现|调试|测试|代码|仓库/u.test(text)) {
    return offer.operatorId === 'codex' ? 120 : 0
  }
  return 0
}

function poolFit(offer: ModelExecutionOffer, nowSeconds: number): number {
  if (offer.source === 'metered-api') return -10_000
  const pool = offer.quotaPool
  if (pool === undefined) return 1_000
  const usable = Math.max(remaining(pool.primary), remaining(pool.secondary))
  if (usable <= 0) return -100_000
  return 1_000 + resetUrgency(pool.primary, nowSeconds) + resetUrgency(pool.secondary, nowSeconds)
}

function capacityFit(offer: ModelExecutionOffer): number {
  const free = offer.maxConcurrency - offer.activeCount
  return free <= 0 ? -100_000 : free * 20
}

function score(offer: ModelExecutionOffer, request: ModelAllocationRequest, nowSeconds: number): number {
  return poolFit(offer, nowSeconds) + qualityFit(offer, request) + productFit(offer, request) + capacityFit(offer)
}

/** Public deterministic Provider, separately mountable from the Scheduler. */
export class SubscriptionFirstModelAllocation extends ModelAllocationService {
  allocate(request: ModelAllocationRequest): Promise<ModelAllocationPlan> {
    const available = request.offers.filter(offer => offer.available && offer.activeCount < offer.maxConcurrency)
    const explicit = request.preferredOperatorIds.length === 0
      ? available
      : available.filter(offer => request.preferredOperatorIds.includes(offer.operatorId))
    if (request.preferredOperatorIds.length > 0 && explicit.length === 0) {
      throw new ModelAllocationError(
        `none of the explicitly preferred operators has capacity: ${request.preferredOperatorIds.join(', ')}`,
        'EXPLICIT_MODEL_UNAVAILABLE',
      )
    }
    const candidates = explicit.filter((offer) => {
      const pool = offer.quotaPool
      return pool === undefined || Math.max(remaining(pool.primary), remaining(pool.secondary)) > 0
    })
    if (candidates.length === 0) throw new ModelAllocationError('no qualified model execution capacity is available', 'NO_MODEL_CAPACITY')
    const requiresHighTier = request.phase === 'planning'
      || request.phase === 'verification'
      || request.phase === 'synthesis'
      || request.rlm === 'enabled'
    const qualityCandidates = requiresHighTier && candidates.some(offer => offer.tier === 'high')
      ? candidates.filter(offer => offer.tier === 'high')
      : candidates
    const nowSeconds = Math.floor(Date.parse(request.now) / 1_000)
    const [selected] = [...qualityCandidates].sort((left, right) => {
      const difference = score(right, request, nowSeconds) - score(left, request, nowSeconds)
      return difference === 0 ? left.offerId.localeCompare(right.offerId) : difference
    })
    if (selected === undefined) throw new ModelAllocationError('no qualified model execution capacity is available', 'NO_MODEL_CAPACITY')
    const subscriptionCapacityByOperator = new Map<string, number>()
    for (const offer of candidates.filter(value => value.source === 'native-subscription')) {
      subscriptionCapacityByOperator.set(
        offer.operatorId,
        Math.max(subscriptionCapacityByOperator.get(offer.operatorId) ?? 0, offer.maxConcurrency - offer.activeCount),
      )
    }
    const subscriptionCapacity = [...subscriptionCapacityByOperator.values()].reduce((total, value) => total + value, 0)
    const urgentCapacity = candidates.filter(offer => offer.quotaPool !== undefined && (
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
      suggestedParallelism: Math.max(1, Math.min(request.graphMaxParallel, subscriptionCapacity + urgentCapacity)),
      rationale: [
        selected.source === 'native-subscription' ? 'native-subscription-first' : 'metered-api-last-resort',
        request.phase === 'planning' || request.phase === 'verification' ? 'high-tier-quality-gate' : 'worker-tier-throughput',
        ...selected.quotaPool === undefined ? [] : [`quota-pool:${selected.quotaPool.poolId}`],
        ...urgentCapacity === 0 ? [] : ['accelerate-before-quota-reset'],
      ],
    })
  }
}

export function apply(ctx: Context): void { new SubscriptionFirstModelAllocation(ctx) }
export default SubscriptionFirstModelAllocation
