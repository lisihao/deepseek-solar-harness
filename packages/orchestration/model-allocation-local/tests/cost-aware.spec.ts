import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import type { ModelAllocationEvidence, ModelAllocationRequest, ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import SubscriptionFirstModelAllocation, { canonicalCohortKey, type CostAwareMode } from '../src/index.ts'
import { selectCostAware } from '../src/cost-aware.ts'

/** Cost only, unless a test says what a minute is worth. */
const choose = (
  baseline: ModelExecutionOffer,
  candidates: readonly ModelExecutionOffer[],
  objective: 'economy' | 'balanced' | 'speed',
  proof: ModelAllocationEvidence,
  minuteValueUsd = 0,
) => selectCostAware(baseline, candidates, objective, proof, minuteValueUsd)

function offer(model: string, effort: string, rank: number, overrides: Partial<ModelExecutionOffer> = {}): ModelExecutionOffer {
  return {
    offerId: `codex:${model}:${effort}`, operatorId: 'codex', provider: 'codex', model, displayName: model,
    source: 'native-subscription', tier: 'high', available: true, maxConcurrency: 4, activeCount: 0,
    tags: ['coding'], profile: { model, effort: effort as 'high' }, rank, ...overrides,
  }
}

const COHORT = {
  benchmark: 'Codex Radar community tasks', benchmark_version: '2026-10-01', billing_identity: 'native-subscription',
  execution_surface: 'codex', harness: 'codex-radar-community', metric_kind: 'pass_rate', score_kind: 'resolved_rate',
  task_type: 'coding', unit: 'proportion',
}

interface Row { readonly passRate: number; readonly n: number; readonly usd: number; readonly seconds: number }

function record(target: ModelExecutionOffer, row: Row, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ...COHORT, reasoning_effort: target.profile?.effort, source: 'codex-radar', provider: 'codex', canonical_model_id: target.model,
    value: row.passRate, sample_count: row.n, avg_cost_usd: row.usd, avg_runtime_seconds: row.seconds,
    lineage_id: target.offerId, correlation_group: 'g', comparability: { status: 'comparable' }, ...overrides,
  }
  return { ...base, cohort_key: canonicalCohortKey(base) }
}

function evidence(
  entries: ReadonlyArray<readonly [ModelExecutionOffer, Row]>,
  overrides: Record<string, unknown> = {},
): ModelAllocationEvidence {
  return {
    taskType: 'coding',
    snapshots: [{ source: 'radar', snapshotId: 'g1', digest: 'd' }],
    records: Object.fromEntries(entries.map(([target, row]) => [target.offerId, [record(target, row, overrides)]])),
  }
}

// Numbers follow the shape of the owner's collected GPT-6 rows.
const astraHigh = offer('gpt-6-astra', 'high', 0)
const astraMedium = offer('gpt-6-astra', 'medium', 1)
const astraLow = offer('gpt-6-astra', 'low', 2)
const solHigh = offer('gpt-6-sol', 'high', 3)
const lunaHigh = offer('gpt-6-luna', 'high', 4, { tier: 'low' })
const ROWS: ReadonlyArray<readonly [ModelExecutionOffer, Row]> = [
  [astraHigh, { passRate: 0.736, n: 140, usd: 2.51, seconds: 780 }],
  [astraMedium, { passRate: 0.716, n: 141, usd: 1.81, seconds: 660 }],
  [astraLow, { passRate: 0.656, n: 157, usd: 1.69, seconds: 600 }],
  [solHigh, { passRate: 0.658, n: 149, usd: 0.76, seconds: 681 }],
  [lunaHigh, { passRate: 0.277, n: 119, usd: 0.02, seconds: 471 }],
]
const OFFERS = ROWS.map(([target]) => target)

describe('selectCostAware', () => {
  it('takes the cheapest offer that is not worse than the best, so a much cheaper model that passes less often loses to its price only inside the margin', () => {
    const economy = choose(astraHigh, OFFERS, 'economy', evidence(ROWS))

    expect(economy).toMatchObject({ status: 'used', objective: 'economy', metric: 'cost-and-time', selectedOfferId: 'codex:gpt-6-sol:high' })
    expect(economy.sufficientOfferIds).toEqual([
      'codex:gpt-6-astra:high', 'codex:gpt-6-astra:low', 'codex:gpt-6-astra:medium', 'codex:gpt-6-sol:high',
    ])
    expect(economy.sufficientOfferIds).not.toContain('codex:gpt-6-luna:high')
  })

  it('weighs the waiting time, so a cheap model that takes half an hour does not win', () => {
    const luna = offer('gpt-5.6-luna', 'max', 7, { tier: 'low' })
    const rows: ReadonlyArray<readonly [ModelExecutionOffer, Row]> = [
      ...ROWS,
      [luna, { passRate: 0.682, n: 336, usd: 0.43, seconds: 2_280 }],
    ]
    const offers = [...OFFERS, luna]

    expect(choose(astraHigh, offers, 'balanced', evidence(rows)).selectedOfferId).toBe('codex:gpt-5.6-luna:max')
    const weighed = choose(astraHigh, offers, 'balanced', evidence(rows), 0.1)
    expect(weighed.selectedOfferId).toBe('codex:gpt-6-astra:medium')
    expect(choose(astraHigh, offers, 'economy', evidence(rows), 0.1).selectedOfferId).toBe('codex:gpt-6-sol:high')
  })

  it('uses a narrower margin for balanced work', () => {
    const balanced = choose(astraHigh, OFFERS, 'balanced', evidence(ROWS))

    expect(balanced.sufficientOfferIds).toEqual(['codex:gpt-6-astra:high', 'codex:gpt-6-astra:medium'])
    expect(balanced.selectedOfferId).toBe('codex:gpt-6-astra:medium')
  })

  it('minimizes runtime instead of cost for the speed objective', () => {
    const speed = choose(astraHigh, OFFERS, 'speed', evidence(ROWS))

    expect(speed).toMatchObject({ metric: 'runtime', selectedOfferId: 'codex:gpt-6-astra:medium' })
  })

  it('keeps the baseline when it is already the cheapest sufficient offer, and reports every measurement it read', () => {
    const verdict = choose(astraMedium, [astraHigh, astraMedium], 'balanced', evidence(ROWS))

    expect(verdict.selectedOfferId).toBe('codex:gpt-6-astra:medium')
    expect(verdict.considered).toEqual([
      expect.objectContaining({ offerId: 'codex:gpt-6-astra:high', passRate: 0.736, sampleCount: 140, avgCostUsd: 2.51, avgRuntimeSeconds: 780 }),
      expect.objectContaining({ offerId: 'codex:gpt-6-astra:medium', passRate: 0.716, sampleCount: 141 }),
    ])
    expect(verdict.considered[0]!.lower).toBeLessThan(0.736)
    expect(verdict.considered[0]!.upper).toBeGreaterThan(0.736)
  })

  it('does not accept a cheap offer on a lucky point estimate when its interval is clearly below the best', () => {
    const lucky = offer('gpt-6-terra', 'high', 5)
    const rows: ReadonlyArray<readonly [ModelExecutionOffer, Row]> = [
      [astraHigh, { passRate: 0.9, n: 2_000, usd: 2.5, seconds: 780 }],
      [lucky, { passRate: 0.85, n: 20, usd: 0.1, seconds: 100 }],
    ]

    const verdict = choose(astraHigh, [astraHigh, lucky], 'economy', evidence(rows))

    expect(verdict.sufficientOfferIds).toEqual(['codex:gpt-6-astra:high', 'codex:gpt-6-terra:high'])
    expect(verdict.selectedOfferId).toBe('codex:gpt-6-terra:high')
    const tight = choose(astraHigh, [astraHigh, lucky], 'economy', evidence([
      [astraHigh, { passRate: 0.9, n: 2_000, usd: 2.5, seconds: 780 }],
      [lucky, { passRate: 0.7, n: 2_000, usd: 0.1, seconds: 100 }],
    ]))
    expect(tight.selectedOfferId).toBe('codex:gpt-6-astra:high')
  })

  it('breaks a cost tie by the higher pass rate, then catalog rank, then offer id', () => {
    const left = offer('gpt-6-sol', 'high', 1)
    const right = offer('gpt-6-terra', 'high', 0)
    const same: Row = { passRate: 0.7, n: 300, usd: 1, seconds: 100 }

    expect(choose(left, [left, right], 'economy', evidence([[left, same], [right, same]])).selectedOfferId)
      .toBe('codex:gpt-6-terra:high')
    expect(choose(left, [left, right], 'economy', evidence([[left, { ...same, passRate: 0.71 }], [right, same]])).selectedOfferId)
      .toBe('codex:gpt-6-sol:high')
    const unranked = { ...offer('gpt-6-zeta', 'high', 0), rank: undefined } as unknown as ModelExecutionOffer
    const unrankedToo = { ...offer('gpt-6-alpha', 'high', 0), rank: undefined } as unknown as ModelExecutionOffer
    expect(choose(unranked, [unranked, unrankedToo], 'economy', evidence([[unranked, same], [unrankedToo, same]])).selectedOfferId)
      .toBe('codex:gpt-6-alpha:high')
  })

  it('only compares models of the baseline product', () => {
    const claude = offer('claude-opus-5', 'high', 9, { offerId: 'claude-code:claude-opus-5', operatorId: 'claude-code', provider: 'claude-code' })

    const verdict = choose(astraHigh, [...OFFERS, claude], 'economy', evidence([...ROWS, [claude, { passRate: 0.7, n: 100, usd: 0.01, seconds: 1 }]]))

    expect(verdict.considered.map(entry => entry.offerId)).not.toContain('claude-code:claude-opus-5')
  })

  describe('abstains and keeps the baseline', () => {
    const abstained = (verdict: ReturnType<typeof selectCostAware>, reason: RegExp): void => {
      expect(verdict.status).toBe('abstained')
      expect(verdict.selectedOfferId).toBe(verdict.baselineOfferId)
      expect(verdict.sufficientOfferIds).toEqual([])
      expect(verdict.reason).toMatch(reason)
    }

    it('when no offer has a measurement', () => {
      abstained(choose(astraHigh, OFFERS, 'economy', { taskType: 'coding', snapshots: [], records: {} }), /no offer has a complete/u)
    })

    it('but still chooses among the measured offers when only the baseline has no measurement', () => {
      const verdict = choose(astraHigh, OFFERS, 'economy', evidence(ROWS.filter(([target]) => target !== astraHigh)))

      expect(verdict).toMatchObject({ status: 'used', baselineOfferId: 'codex:gpt-6-astra:high', selectedOfferId: 'codex:gpt-6-sol:high' })
      expect(verdict.reason).toContain('the baseline itself has no measurement')
      expect(verdict.considered.map(entry => entry.offerId)).not.toContain('codex:gpt-6-astra:high')
    })

    it.each([
      ['a missing cost', { avg_cost_usd: undefined }],
      ['a negative runtime', { avg_runtime_seconds: -1 }],
      ['a non-numeric cost', { avg_cost_usd: '2.5' }],
      ['a pass rate above one', { value: 1.5 }],
      ['a fractional sample count', { sample_count: 1.5 }],
      ['a zero sample count', { sample_count: 0 }],
      ['another task type', { task_type: 'research' }],
    ] as const)('when every row has %s', (_name, overrides) => {
      const verdict = choose(astraHigh, OFFERS, 'economy', evidence(ROWS, overrides))

      abstained(verdict, /no offer has a complete/u)
    })

    it('when the only offer carries a cohort key that does not match its conditions, a non-record, or two different measurements', () => {
      const only = (records: readonly unknown[]) => choose(astraHigh, [astraHigh], 'economy', {
        ...evidence(ROWS), records: { [astraHigh.offerId]: records },
      })
      const first = record(astraHigh, ROWS[0]![1])
      abstained(only([{ ...first, cohort_key: 'x' }]), /no offer has a complete/u)
      abstained(only(['not a record']), /no offer has a complete/u)
      abstained(only([first, record(astraHigh, { ...ROWS[0]![1], usd: 9 })]), /no offer has a complete/u)
      expect(only([first, first]).status).toBe('used')
    })

    it('when the measurements come from different cohorts', () => {
      const base = evidence(ROWS)
      const other = record(astraMedium, ROWS[1]![1], { harness: 'another-harness' })
      const verdict = choose(astraHigh, OFFERS, 'economy', { ...base, records: { ...base.records, [astraMedium.offerId]: [other] } })

      abstained(verdict, /different cohorts/u)
    })
  })

  it('is deterministic for any order of the candidates', () => {
    const forward = choose(astraHigh, OFFERS, 'economy', evidence(ROWS))
    const reversed = choose(astraHigh, [...OFFERS].reverse(), 'economy', evidence([...ROWS].reverse()))

    expect(reversed).toEqual(forward)
  })
})

describe('cost-aware selection in the allocator', () => {
  const contexts: Context[] = []
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
  })

  async function allocate(mode: CostAwareMode | undefined, input: Partial<ModelAllocationRequest>) {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubscriptionFirstModelAllocation, mode === undefined ? {} : { costAware: mode })
    return await ctx.modelAllocation.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'implementation', task: 'fix the build', preferredOperatorIds: [],
      objective: 'quality', rlm: 'disabled', graphMaxParallel: 1, offers: OFFERS, now: '2026-10-01T12:00:00.000Z',
      evidence: evidence(ROWS), costAwareObjective: 'balanced', ...input,
    })
  }

  it('records what it would choose in shadow mode, which is the default, and changes nothing', async () => {
    for (const mode of [undefined, 'shadow'] as const) {
      const plan = await allocate(mode, {})

      expect(plan.offerId).toBe('codex:gpt-6-astra:high')
      expect(plan.rationale).not.toContain('cost-aware-selection')
      expect(plan.selection).toMatchObject({
        mode: 'shadow', status: 'used', objective: 'balanced', metric: 'cost-and-time',
        baselineOfferId: 'codex:gpt-6-astra:high', selectedOfferId: 'codex:gpt-6-astra:medium', applied: false,
      })
    }
  })

  it('takes the selection in apply mode and says so', async () => {
    const plan = await allocate('apply', {})

    expect(plan.offerId).toBe('codex:gpt-6-astra:medium')
    expect(plan.profile).toEqual({ model: 'gpt-6-astra', effort: 'medium' })
    expect(plan.rationale).toContain('cost-aware-selection')
    expect(plan.selection).toMatchObject({ mode: 'apply', applied: true })
  })

  it('does not apply a selection that agrees with the baseline', async () => {
    const plan = await allocate('apply', { offers: [astraMedium, astraHigh].map(entry => ({ ...entry, rank: entry === astraMedium ? 0 : 1 })) })

    expect(plan.offerId).toBe('codex:gpt-6-astra:medium')
    expect(plan.selection).toMatchObject({ applied: false })
    expect(plan.rationale).not.toContain('cost-aware-selection')
  })

  it.each([
    ['off', {}],
    ['apply', { costAwareObjective: undefined }],
    ['apply', { evidence: undefined }],
    ['apply', { phase: 'planning' as const }],
    ['apply', { rlm: 'enabled' as const }],
  ] as const)('does nothing with mode %s and %j', async (mode, input) => {
    const plan = await allocate(mode, input as Partial<ModelAllocationRequest>)

    expect(plan).not.toHaveProperty('selection')
    expect(plan.offerId).toBe('codex:gpt-6-astra:high')
  })

  it('abstains instead of failing when the evidence has no cost for the baseline', async () => {
    const plan = await allocate('apply', { evidence: evidence(ROWS, { avg_cost_usd: undefined }) })

    expect(plan.selection).toMatchObject({ status: 'abstained', applied: false, selectedOfferId: 'codex:gpt-6-astra:high' })
    expect(plan.offerId).toBe('codex:gpt-6-astra:high')
  })

  it('lets the cost-aware choice win over the evidence tie-break when both are applied', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SubscriptionFirstModelAllocation, { costAware: 'apply', publicEvidence: 'apply' })

    const plan = await ctx.modelAllocation.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'implementation', task: 'fix the build', preferredOperatorIds: [],
      objective: 'quality', rlm: 'disabled', graphMaxParallel: 1, offers: OFFERS, now: '2026-10-01T12:00:00.000Z',
      evidence: evidence(ROWS), costAwareObjective: 'economy',
    })

    expect(plan.offerId).toBe('codex:gpt-6-sol:high')
    expect(plan.evidence?.applied).toBe(false)
    expect(plan.rationale).toContain('cost-aware-selection')
    expect(plan.rationale).not.toContain('public-evidence-tiebreak')
  })

  it('reads the owner setting over the plugin config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-cost-aware-'))
    try {
      const path = join(directory, 'settings.yaml')
      await writeFile(path, 'model-allocation:\n  costAware: apply\n')
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(FileSettingsProvider, { path, watch: false })
      await ctx.plugin(SubscriptionFirstModelAllocation, { costAware: 'off' })

      const plan = await ctx.modelAllocation.allocate({
        runId: 'r', nodeId: 'n', phase: 'execution', role: 'implementation', task: 'fix the build', preferredOperatorIds: [],
        objective: 'quality', rlm: 'disabled', graphMaxParallel: 1, offers: OFFERS, now: '2026-10-01T12:00:00.000Z',
        evidence: evidence(ROWS), costAwareObjective: 'balanced',
      })
      expect(plan.offerId).toBe('codex:gpt-6-astra:medium')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
