/** Deterministic subscription-first allocation Provider. @module @deepseek-ai/dsh-model-allocation-local */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import ModelAllocationService, {
  ModelAllocationError,
  validateAdaptiveExecutionPreference,
  type AdaptiveExecutionPreferenceV1,
  type ModelAllocationEvidenceReceipt,
  type ModelAllocationFallbackProvenance,
  type ModelAllocationFallbackReasonCode,
  type ModelAllocationPlan,
  type ModelAllocationRequest,
  type ModelExecutionOffer,
  type ModelQuotaWindow,
} from '@deepseek-ai/dsh-model-allocation'
import { rankComparablePublicEvidence, type PublicEvidenceCandidate } from './public-evidence.ts'

export const name = 'model-allocation-local'

/** How public evidence takes part in allocation. */
export type PublicEvidenceMode = 'off' | 'shadow' | 'apply'

/** Provider settings. */
export interface Config {
  /**
   * `off` ignores request evidence; `shadow` records what evidence would pick
   * without using it; `apply` lets evidence break a tie among offers with the
   * same top score. Default `shadow`.
   */
  readonly publicEvidence?: PublicEvidenceMode
}

/** Settings namespace the owner edits in the settings document (`~/.dsh/settings.yaml`). */
export const MODEL_ALLOCATION_SETTINGS_NAMESPACE = settingsNamespace('model-allocation')

/** The owner-editable slice; a change applies to the next allocation. */
export interface ModelAllocationSettings {
  /** The evidence mode; the plugin config's choice is the default. */
  publicEvidence: PublicEvidenceMode
}

/** Runtime schema for {@link ModelAllocationSettings}. */
export const ModelAllocationSettingsSchema: z<ModelAllocationSettings> = z.object({
  publicEvidence: z.union(['off', 'shadow', 'apply']),
})

export { canonicalCohortKey, rankComparablePublicEvidence } from './public-evidence.ts'
export type {
  PublicEvidenceAbstention,
  PublicEvidenceCandidate,
  PublicEvidenceCandidateSummary,
  PublicEvidenceConflict,
  PublicEvidenceIncompleteComparison,
  PublicEvidenceMeasurement,
  PublicEvidenceRanking,
  PublicEvidenceReference,
} from './public-evidence.ts'

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

/** The evidence ranking of the offers that tied for the top score. */
interface EvidenceVerdict {
  readonly status: 'used' | 'abstained'
  readonly reason: string
  readonly tiedOfferIds: readonly string[]
  /** Tier per tied offer; absent when the ranking could not run. */
  readonly tiers: ReadonlyMap<string, number>
}

/** Identity of an offer as public evidence names a candidate. */
function evidenceCandidate(offer: ModelExecutionOffer, records: readonly unknown[] | undefined): PublicEvidenceCandidate {
  return {
    candidateId: offer.offerId,
    provider: offer.provider,
    model: offer.model,
    reasoningEffort: offer.profile?.effort,
    executionSurface: offer.operatorId,
    billingIdentity: offer.source,
    publicEvidence: records,
  }
}

/** Rank the offers that tie for the top score; a failure to rank abstains instead of failing the allocation. */
function rankTiedOffers(tied: readonly ModelExecutionOffer[], evidence: NonNullable<ModelAllocationRequest['evidence']>): EvidenceVerdict {
  const tiedOfferIds = tied.map(offer => offer.offerId).sort((left, right) => left.localeCompare(right))
  try {
    const ranking = rankComparablePublicEvidence(
      tied.map(offer => evidenceCandidate(offer, evidence.records[offer.offerId])),
      { taskType: evidence.taskType },
    )
    return {
      status: ranking.status,
      reason: ranking.reason,
      tiedOfferIds,
      tiers: new Map(Object.entries(ranking.preferenceRanks)),
    }
  } catch (error) {
    return {
      status: 'abstained',
      // The ranking throws only TypeError, for a candidate without an identity field.
      reason: `public evidence could not be ranked: ${(error as TypeError).message}`,
      tiedOfferIds,
      tiers: new Map(),
    }
  }
}

/** Public deterministic Provider, separately mountable from the Scheduler. */
export class SubscriptionFirstModelAllocation extends ModelAllocationService {
  private readonly configuredEvidenceMode: PublicEvidenceMode
  private settings: SettingsScope<ModelAllocationSettings> | undefined

  /** Settings accepted from the Loader; every field is optional. */
  static Config: z<Config> = z.object({
    publicEvidence: z.union(['off', 'shadow', 'apply']),
  })

  /**
   * Register `ctx.modelAllocation`.
   * @param ctx - owning context.
   * @param config - evidence mode; omitted means `shadow`.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx)
    this.configuredEvidenceMode = config.publicEvidence ?? 'shadow'
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        MODEL_ALLOCATION_SETTINGS_NAMESPACE,
        ModelAllocationSettingsSchema,
        { base: { publicEvidence: this.configuredEvidenceMode } },
      )
      settingsCtx.effect(() => () => { this.settings = undefined }, 'model-allocation-local: settings')
    })
  }

  /** The evidence mode in force: the owner's setting over the plugin config. */
  private get evidenceMode(): PublicEvidenceMode {
    return this.settings?.get().publicEvidence ?? this.configuredEvidenceMode
  }

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
    const order = (left: ModelExecutionOffer, right: ModelExecutionOffer, tiers?: ReadonlyMap<string, number>): number => {
      const difference = score(right, request, nowSeconds) - score(left, request, nowSeconds)
      if (difference !== 0) return difference
      const leftTier = tiers?.get(left.offerId)
      const rightTier = tiers?.get(right.offerId)
      if (leftTier !== undefined && rightTier !== undefined && leftTier !== rightTier) return leftTier - rightTier
      const rank = (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY)
      return Number.isNaN(rank) || rank === 0 ? left.offerId.localeCompare(right.offerId) : rank
    }
    const [baseline] = [...routedCandidates].sort((left, right) => order(left, right))
    if (baseline === undefined) throw new ModelAllocationError('no qualified model execution capacity is available', 'NO_MODEL_CAPACITY')
    const topScore = score(baseline, request, nowSeconds)
    const tied = routedCandidates.filter(offer => score(offer, request, nowSeconds) === topScore)
    const verdict = this.evidenceMode === 'off' || request.evidence === undefined || tied.length < 2
      ? undefined
      : rankTiedOffers(tied, request.evidence)
    const evidenceChoice = verdict === undefined
      ? baseline
      : [...routedCandidates].sort((left, right) => order(left, right, verdict.tiers))[0] as ModelExecutionOffer
    const apply = this.evidenceMode === 'apply' && verdict?.status === 'used'
    const selected = apply ? evidenceChoice : baseline
    const evidenceReceipt: ModelAllocationEvidenceReceipt | undefined = verdict === undefined || request.evidence === undefined
      ? undefined
      : {
        mode: this.evidenceMode === 'apply' ? 'apply' : 'shadow',
        status: verdict.status,
        reason: verdict.reason,
        snapshots: request.evidence.snapshots,
        tiedOfferIds: verdict.tiedOfferIds,
        candidates: verdict.tiedOfferIds.map(offerId => ({
          offerId,
          preferenceRank: verdict.tiers.get(offerId) ?? 0,
          status: verdict.status,
        })),
        baselineOfferId: baseline.offerId,
        evidenceOfferId: evidenceChoice.offerId,
        applied: apply && evidenceChoice.offerId !== baseline.offerId,
      }
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
        ...evidenceReceipt?.applied === true ? ['public-evidence-tiebreak'] : [],
      ],
      ...evidenceReceipt === undefined ? {} : { evidence: evidenceReceipt },
    })
  }
}

export function apply(ctx: Context, config?: Config): void { new SubscriptionFirstModelAllocation(ctx, config) }
export default SubscriptionFirstModelAllocation
