/**
 * Cost- and time-aware choice among offers the allocator has already admitted.
 *
 * Public benchmark rows say how often a model-and-effort passes and what a run costs and takes. For
 * work that does not need the strongest model, the cheapest (or fastest) offer whose pass rate is
 * not statistically worse than the best is the better choice. The function abstains, and the
 * allocator keeps its baseline, whenever no offer has complete evidence or the evidence mixes cohorts.
 * A baseline without a measurement may still be replaced by a measured offer: the newest model is
 * often the one Radar has not measured yet.
 * @module @deepseek-ai/dsh-model-allocation-local/cost-aware
 */

import type {
  ModelAllocationEvidence,
  ModelAllocationSelectionCandidate,
  ModelAllocationSelectionReceipt,
  ModelExecutionOffer,
} from '@deepseek-ai/dsh-model-allocation'
import { canonicalCohortKey, wilsonInterval } from './public-evidence.ts'

/** Objectives a cost-aware selection serves; `quality` keeps the strongest offer. */
export type CostAwareObjective = 'economy' | 'balanced' | 'speed'

/**
 * How far below the best pass rate an offer may be and still count as good enough. A larger margin
 * lets an easier task accept a cheaper offer. The same offer also has to be statistically
 * indistinguishable from the best, so a small sample never passes on a lucky point estimate.
 */
const PASS_RATE_MARGIN: Readonly<Record<CostAwareObjective, number>> = {
  economy: 0.12,
  balanced: 0.06,
  speed: 0.06,
}

/** The verdict of one selection, before the allocator decides whether to apply it. */
export type CostAwareVerdict = Omit<ModelAllocationSelectionReceipt, 'mode' | 'applied'>

function dict(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** The single complete measurement an offer's records carry, or undefined when there is none or it is ambiguous. */
function measurement(
  records: readonly unknown[] | undefined,
  taskType: string,
): (ModelAllocationSelectionCandidate & { readonly cohort: string }) | undefined {
  const valid = (records ?? []).flatMap((raw) => {
    const row = dict(raw)
    if (row === undefined || row.task_type !== taskType) return []
    const full = canonicalCohortKey(row)
    // The reasoning effort is what this selection chooses, so rows that differ only by effort are comparable.
    const cohort = canonicalCohortKey({ ...row, reasoning_effort: 'any' })
    const passRate = nonNegative(row.value)
    const sampleCount = row.sample_count
    const avgCostUsd = nonNegative(row.avg_cost_usd)
    const avgRuntimeSeconds = nonNegative(row.avg_runtime_seconds)
    if (cohort === null || full !== row.cohort_key || passRate === undefined || passRate > 1) return []
    if (typeof sampleCount !== 'number' || !Number.isInteger(sampleCount) || sampleCount <= 0) return []
    if (avgCostUsd === undefined || avgRuntimeSeconds === undefined) return []
    const [lower, upper] = wilsonInterval(passRate, sampleCount)
    return [{ cohort, offerId: '', passRate, sampleCount, lower, upper, avgCostUsd, avgRuntimeSeconds }]
  })
  const [first] = valid
  const same = first !== undefined && valid.every(entry => entry.cohort === first.cohort
    && entry.passRate === first.passRate && entry.sampleCount === first.sampleCount
    && entry.avgCostUsd === first.avgCostUsd && entry.avgRuntimeSeconds === first.avgRuntimeSeconds)
  return same ? first : undefined
}

/**
 * Choose the cheapest or fastest offer that is good enough.
 * @param baseline - the offer the allocator would choose without this selection.
 * @param candidates - offers that passed quota, capacity, and pin checks, including the baseline.
 * @param objective - `economy` and `balanced` minimize cost plus the value of the waiting time; `speed` minimizes runtime.
 * @param evidence - the request's public evidence.
 * @param minuteValueUsd - what one minute of waiting is worth, in the units of the measured cost; zero ignores time.
 * @returns the verdict; `selectedOfferId` equals the baseline when the selection abstains or agrees.
 */
export function selectCostAware(
  baseline: ModelExecutionOffer,
  candidates: readonly ModelExecutionOffer[],
  objective: CostAwareObjective,
  evidence: ModelAllocationEvidence,
  minuteValueUsd: number,
): CostAwareVerdict {
  const metric = objective === 'speed' ? 'runtime' : 'cost-and-time'
  const abstain = (reason: string, considered: readonly ModelAllocationSelectionCandidate[] = []): CostAwareVerdict => ({
    status: 'abstained', reason, objective, metric, baselineOfferId: baseline.offerId, selectedOfferId: baseline.offerId,
    sufficientOfferIds: [], considered,
  })
  // The allocator already chose the product (Codex or Claude Code) for the task; only models of that product compete.
  const measured = candidates
    .filter(offer => offer.operatorId === baseline.operatorId)
    .flatMap((offer) => {
      const found = measurement(evidence.records[offer.offerId], evidence.taskType)
      return found === undefined ? [] : [{ offer, ...found, offerId: offer.offerId }]
    })
    .sort((left, right) => left.offerId.localeCompare(right.offerId))
  const considered = measured.map(({ cohort: _cohort, offer: _offer, ...rest }) => rest)
  if (measured.length === 0) return abstain('no offer has a complete public measurement', considered)
  if (new Set(measured.map(entry => entry.cohort)).size > 1) {
    return abstain('the measurements come from different cohorts', considered)
  }
  const best = measured.reduce((top, entry) => entry.lower > top.lower ? entry : top)
  const margin = PASS_RATE_MARGIN[objective]
  const sufficient = measured.filter(entry => entry.upper >= best.lower && entry.passRate >= best.passRate - margin)
  const key = (entry: (typeof measured)[number]): number => metric === 'runtime'
    ? entry.avgRuntimeSeconds
    : entry.avgCostUsd + entry.avgRuntimeSeconds / 60 * minuteValueUsd
  const chosen = [...sufficient].sort((left, right) => key(left) - key(right)
    || right.passRate - left.passRate
    || (left.offer.rank ?? Number.POSITIVE_INFINITY) - (right.offer.rank ?? Number.POSITIVE_INFINITY)
    || left.offerId.localeCompare(right.offerId))[0]
  /* The best offer is always sufficient, so a choice exists. */
  const selected = chosen as (typeof measured)[number]
  const unmeasured = measured.some(entry => entry.offer.offerId === baseline.offerId) ? '' : '; the baseline itself has no measurement'
  return {
    status: 'used',
    reason: `lowest ${metric === 'runtime' ? 'runtime' : 'cost plus waiting time'} among offers whose pass rate is within ${String(margin)} of the best and statistically indistinguishable from it${unmeasured}`,
    objective, metric,
    baselineOfferId: baseline.offerId,
    selectedOfferId: selected.offerId,
    sufficientOfferIds: sufficient.map(entry => entry.offerId),
    considered,
  }
}
