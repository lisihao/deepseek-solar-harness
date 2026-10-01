import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelAllocationEvidence, ModelAllocationRequest, ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import ModelAllocationService from '@deepseek-ai/dsh-model-allocation'
import SubscriptionFirstModelAllocation, {
  apply,
  canonicalCohortKey,
  type PublicEvidenceMode,
} from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function allocator(mode?: PublicEvidenceMode): SubscriptionFirstModelAllocation {
  const ctx = new Context()
  contexts.push(ctx)
  return new SubscriptionFirstModelAllocation(ctx, mode === undefined ? undefined : { publicEvidence: mode })
}

function offer(model: string, overrides: Partial<ModelExecutionOffer> = {}): ModelExecutionOffer {
  return {
    offerId: `codex:${model}`, operatorId: 'codex', provider: 'codex', model, displayName: model,
    source: 'native-subscription', tier: 'high', available: true, maxConcurrency: 4, activeCount: 0,
    tags: ['coding'], profile: { model, effort: 'high' }, ...overrides,
  }
}

const COHORT = {
  benchmark: 'swe-bench', benchmark_version: 'v1', harness: 'harness-a', metric_kind: 'pass_rate', score_kind: 'resolved',
  task_type: 'coding', unit: 'ratio',
}

/** A record naming the offer the way the allocator derives its identity. */
function record(target: ModelExecutionOffer, value: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = {
    ...COHORT,
    reasoning_effort: target.profile?.effort,
    execution_surface: target.operatorId,
    billing_identity: target.source,
    source: 'dradar-codex',
    provider: target.provider,
    canonical_model_id: target.model,
    value,
    sample_count: 1000,
    lineage_id: `lineage-${target.model}`,
    correlation_group: 'grp',
    comparability: { status: 'comparable' },
    ...overrides,
  }
  return { ...row, cohort_key: canonicalCohortKey(row) }
}

const SNAPSHOT = { source: 'radar', snapshotId: 'gen-42', digest: 'sha256:abc' }

function evidence(entries: Record<string, readonly unknown[]>): ModelAllocationEvidence {
  return { taskType: 'coding', snapshots: [SNAPSHOT], records: entries }
}

function request(offers: readonly ModelExecutionOffer[], extra: Partial<ModelAllocationRequest> = {}): ModelAllocationRequest {
  return {
    runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'implement the repository change',
    preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 4, offers,
    now: '2026-10-01T00:00:00.000Z', ...extra,
  }
}

/** Astra is first by catalog rank, so it wins a tie without evidence. */
const astra = offer('astra', { rank: 1 })
const sol = offer('sol', { rank: 2 })
const solWins = evidence({ 'codex:astra': [record(astra, 0.5)], 'codex:sol': [record(sol, 0.9)] })
const astraWins = evidence({ 'codex:astra': [record(astra, 0.9)], 'codex:sol': [record(sol, 0.5)] })

describe('evidence in allocation', () => {
  it('leaves an allocation without evidence exactly as it was', async () => {
    const plan = await allocator('apply').allocate(request([astra, sol]))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan).not.toHaveProperty('evidence')
  })

  it('records, but does not use, what evidence would pick in shadow mode, which is the default', async () => {
    for (const service of [allocator(), allocator('shadow')]) {
      const plan = await service.allocate(request([astra, sol], { evidence: solWins }))

      expect(plan.offerId).toBe('codex:astra')
      expect(plan.rationale).not.toContain('public-evidence-tiebreak')
      expect(plan.evidence).toEqual({
        mode: 'shadow',
        status: 'used',
        reason: 'same-cohort public evidence applied as a secondary cold-start preference',
        snapshots: [SNAPSHOT],
        tiedOfferIds: ['codex:astra', 'codex:sol'],
        candidates: [
          { offerId: 'codex:astra', preferenceRank: 1, status: 'used' },
          { offerId: 'codex:sol', preferenceRank: 0, status: 'used' },
        ],
        baselineOfferId: 'codex:astra',
        evidenceOfferId: 'codex:sol',
        applied: false,
      })
    }
  })

  it('lets evidence break a tie in apply mode and says so', async () => {
    const plan = await allocator('apply').allocate(request([astra, sol], { evidence: solWins }))

    expect(plan.offerId).toBe('codex:sol')
    expect(plan.rationale).toContain('public-evidence-tiebreak')
    expect(plan.evidence).toMatchObject({ mode: 'apply', baselineOfferId: 'codex:astra', evidenceOfferId: 'codex:sol', applied: true })
  })

  it('does not mark the choice applied when evidence agrees with the baseline', async () => {
    const plan = await allocator('apply').allocate(request([astra, sol], { evidence: astraWins }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan.rationale).not.toContain('public-evidence-tiebreak')
    expect(plan.evidence).toMatchObject({ status: 'used', evidenceOfferId: 'codex:astra', applied: false })
  })

  it('keeps the baseline when evidence abstains, even in apply mode', async () => {
    const overlapping = evidence({
      'codex:astra': [record(astra, 0.81, { sample_count: 50 })],
      'codex:sol': [record(sol, 0.79, { sample_count: 50 })],
    })
    const plan = await allocator('apply').allocate(request([astra, sol], { evidence: overlapping }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan.evidence).toMatchObject({ status: 'abstained', applied: false, baselineOfferId: 'codex:astra', evidenceOfferId: 'codex:astra' })
    expect(plan.evidence?.candidates.every(candidate => candidate.status === 'abstained')).toBe(true)
  })

  it('ignores evidence for offers that do not tie for the top score', async () => {
    const lower = offer('luna', { tier: 'low', rank: 0 })
    const plan = await allocator('apply').allocate(request([astra, lower], {
      objective: 'quality',
      evidence: evidence({ 'codex:astra': [record(astra, 0.1)], 'codex:luna': [record(lower, 0.99)] }),
    }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan).not.toHaveProperty('evidence')
  })

  it('ignores evidence entirely when the mode is off', async () => {
    const plan = await allocator('off').allocate(request([astra, sol], { evidence: solWins }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan).not.toHaveProperty('evidence')
  })

  it('never lets evidence override a pinned model', async () => {
    const plan = await allocator('apply').allocate(request([astra, sol], { preferredModel: 'astra', evidence: solWins }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan).not.toHaveProperty('evidence')
  })

  it('never lets evidence override quota admission', async () => {
    const exhausted = offer('sol', {
      rank: 2,
      quotaPool: {
        poolId: 'codex', displayName: 'Codex', models: ['sol'], meter: 'native-subscription',
        primary: { usedPercent: 100 }, observedAt: '2026-10-01T00:00:00.000Z',
      },
      quotaGuard: { unknownQuota: 'allow', stopAdmissionAtRemainingPercent: 25, protectedRemainingPercent: 25, accelerateBeforeReset: true },
    })
    const plan = await allocator('apply').allocate(request([astra, exhausted], { evidence: evidence({
      'codex:astra': [record(astra, 0.2)], 'codex:sol': [record(exhausted, 0.99)],
    }) }))

    expect(plan.offerId).toBe('codex:astra')
  })

  it('breaks only the tie: equal tiers fall back to catalog rank', async () => {
    const luna = offer('luna', { rank: 3 })
    const plan = await allocator('apply').allocate(request([luna, sol, astra], { evidence: evidence({
      'codex:astra': [record(astra, 0.5)],
      'codex:sol': [record(sol, 0.5)],
      'codex:luna': [record(luna, 0.95)],
    }) }))

    expect(plan.offerId).toBe('codex:luna')
    expect(plan.evidence?.candidates).toEqual([
      { offerId: 'codex:astra', preferenceRank: 1, status: 'used' },
      { offerId: 'codex:luna', preferenceRank: 0, status: 'used' },
      { offerId: 'codex:sol', preferenceRank: 1, status: 'used' },
    ])
  })

  it('abstains, and does not fail the allocation, when evidence cannot be ranked', async () => {
    const nameless = offer('sol', { rank: 2, model: '  ' })
    const plan = await allocator('apply').allocate(request([astra, nameless], { evidence: solWins }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan.evidence).toMatchObject({ status: 'abstained', applied: false })
    expect(plan.evidence?.reason).toMatch(/^public evidence could not be ranked: public evidence candidate requires/)
    expect(plan.evidence?.candidates.map(candidate => candidate.preferenceRank)).toEqual([0, 0])
  })

  it('abstains for an offer whose profile names no reasoning effort', async () => {
    const { profile: _profile, ...bare } = offer('sol', { rank: 2 })
    const unprofiled: ModelExecutionOffer = bare
    const plan = await allocator('apply').allocate(request([astra, unprofiled], { evidence: solWins }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan.evidence).toMatchObject({ status: 'abstained', applied: false })
  })

  it('treats an offer with no records as having no evidence', async () => {
    const plan = await allocator('apply').allocate(request([astra, sol], { evidence: evidence({ 'codex:astra': [record(astra, 0.9)] }) }))

    expect(plan.offerId).toBe('codex:astra')
    expect(plan.evidence).toMatchObject({ status: 'abstained', applied: false })
  })

  it('gives the same plan for the same input in any offer order', async () => {
    const forward = await allocator('apply').allocate(request([astra, sol], { evidence: solWins }))
    const reversed = await allocator('apply').allocate(request([sol, astra], { evidence: solWins }))

    expect(reversed).toEqual(forward)
  })

  it('does not mutate the request', async () => {
    const input = request([astra, sol], { evidence: solWins })
    const before = JSON.stringify(input)
    await allocator('apply').allocate(input)

    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('Provider config', () => {
  it('accepts the three modes and rejects anything else', () => {
    const { Config } = SubscriptionFirstModelAllocation
    for (const publicEvidence of ['off', 'shadow', 'apply'] as const) expect(Config({ publicEvidence })).toEqual({ publicEvidence })
    expect(Config({})).toEqual({})
    expect(() => Config({ publicEvidence: 'always' } as never)).toThrow()
  })

  it('registers ctx.modelAllocation with the configured mode through apply()', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    apply(ctx, { publicEvidence: 'apply' })

    expect(ctx.get('modelAllocation')).toBeInstanceOf(ModelAllocationService)
    const plan = await ctx.modelAllocation.allocate(request([astra, sol], { evidence: solWins }))
    expect(plan.offerId).toBe('codex:sol')
  })

  it('defaults to shadow when apply() gets no config', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    apply(ctx)

    const plan = await ctx.modelAllocation.allocate(request([astra, sol], { evidence: solWins }))
    expect(plan.offerId).toBe('codex:astra')
    expect(plan.evidence?.mode).toBe('shadow')
  })
})
