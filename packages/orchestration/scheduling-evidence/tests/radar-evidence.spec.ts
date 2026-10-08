import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelAllocationRequest, ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import SubscriptionFirstModelAllocation from '@deepseek-ai/dsh-model-allocation-local'
import { radarEvidence, type RadarDeclaration } from '../src/radar-evidence.ts'

const NOW = Date.parse('2026-10-01T12:00:00Z')

const declaration: RadarDeclaration = {
  benchmark: 'Codex Radar community tasks',
  harness: 'codex-radar-community',
  taskType: 'coding',
  modelAliases: {},
}

function offer(model: string, overrides: Partial<ModelExecutionOffer> = {}): ModelExecutionOffer {
  return {
    offerId: `codex:${model}`, operatorId: 'codex', provider: 'codex', model, displayName: model,
    source: 'native-subscription', tier: 'high', available: true, maxConcurrency: 4, activeCount: 0,
    tags: ['coding'], profile: { model, effort: 'high' }, ...overrides,
  }
}

function row(model: string, passRate: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { provider: 'codex', model, reasoning_effort: 'high', pass_rate: passRate, sample_count: 1000, ...overrides }
}

function snapshot(models: readonly unknown[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    snapshot_id: 'radar-gen-1',
    digest: 'sha256:radar1',
    fetched_at: '2026-10-01T08:00:00Z',
    source_updated_at: '2026-10-01T07:00:00Z',
    cache: { stale_after_seconds: 604_800 },
    models,
    ...overrides,
  }
}

const options = { taskType: 'coding', declaration, nowMs: NOW }
const sol = offer('gpt-5.6-sol', { rank: 2 })
const terra = offer('gpt-5.6-terra', { rank: 1 })

describe('radarEvidence', () => {
  it('builds one comparable record per matching offer and names the generation', () => {
    const evidence = radarEvidence(snapshot([row('gpt-5.6-sol', 0.9), row('gpt-5.6-terra', 0.6)]), [sol, terra], options)

    expect(evidence?.taskType).toBe('coding')
    expect(evidence?.snapshots).toEqual([{ source: 'radar', snapshotId: 'radar-gen-1', digest: 'sha256:radar1' }])
    expect(Object.keys(evidence?.records ?? {})).toEqual(['codex:gpt-5.6-sol', 'codex:gpt-5.6-terra'])
    expect(evidence?.records['codex:gpt-5.6-sol']?.[0]).toMatchObject({
      source: 'codex-radar',
      upstream_dataset: 'dradar',
      benchmark: 'Codex Radar community tasks',
      benchmark_version: '2026-10-01T07:00:00Z',
      metric_kind: 'pass_rate',
      score_kind: 'resolved_rate',
      unit: 'proportion',
      harness: 'codex-radar-community',
      reasoning_effort: 'high',
      task_type: 'coding',
      execution_surface: 'codex',
      billing_identity: 'native-subscription',
      provider: 'codex',
      canonical_model_id: 'gpt-5.6-sol',
      value: 0.9,
      sample_count: 1000,
      comparability: { status: 'comparable' },
      provenance: 'community_observation',
    })
  })

  it('lets the allocator pick the higher pass rate among tied offers', async () => {
    const ctx = new Context()
    await ctx.plugin(SubscriptionFirstModelAllocation, { publicEvidence: 'apply' })
    const allocator = ctx.modelAllocation
    const request = (evidence: ModelAllocationRequest['evidence']): ModelAllocationRequest => ({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'implement the repository change',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 4,
      offers: [sol, terra], now: '2026-10-01T12:00:00.000Z', ...evidence === undefined ? {} : { evidence },
    })

    expect((await allocator.allocate(request(undefined))).offerId).toBe('codex:gpt-5.6-terra')
    const strongSol = await allocator.allocate(request(radarEvidence(snapshot([row('gpt-5.6-sol', 0.92), row('gpt-5.6-terra', 0.78)]), [sol, terra], options)))
    expect(strongSol.offerId).toBe('codex:gpt-5.6-sol')
    expect(strongSol.evidence).toMatchObject({ status: 'used', applied: true, snapshots: [{ snapshotId: 'radar-gen-1' }] })
    const closeCall = await allocator.allocate(request(radarEvidence(snapshot([row('gpt-5.6-sol', 0.81), row('gpt-5.6-terra', 0.79)]), [sol, terra], options)))
    expect(closeCall.offerId).toBe('codex:gpt-5.6-terra')
    expect(closeCall.evidence).toMatchObject({ status: 'abstained', applied: false })
    await ctx.root.fiber.dispose()
  })

  it('carries what a run costs and takes only when the row reports both', () => {
    const evidence = radarEvidence(
      snapshot([
        row('gpt-5.6-sol', 0.9, { avg_cost_usd: 2.5, avg_runtime_seconds: 780 }),
        row('gpt-5.6-terra', 0.6, { avg_cost_usd: 1, avg_runtime_seconds: null }),
        row('gpt-5.6-luna', 0.5, { avg_cost_usd: -1, avg_runtime_seconds: 3 }),
      ]),
      [sol, terra, offer('gpt-5.6-luna')],
      options,
    )

    expect(evidence?.records['codex:gpt-5.6-sol']?.[0]).toMatchObject({ avg_cost_usd: 2.5, avg_runtime_seconds: 780 })
    expect(evidence?.records['codex:gpt-5.6-terra']?.[0]).not.toHaveProperty('avg_cost_usd')
    expect(evidence?.records['codex:gpt-5.6-terra']?.[0]).not.toHaveProperty('avg_runtime_seconds')
    expect(evidence?.records['codex:gpt-5.6-luna']?.[0]).not.toHaveProperty('avg_cost_usd')
  })

  it('maps a Radar model name to the offer name', () => {
    const evidence = radarEvidence(
      snapshot([row('gpt-5.6-sol', 0.9)]),
      [offer('sol')],
      { ...options, declaration: { ...declaration, modelAliases: { 'gpt-5.6-sol': 'sol' } } },
    )

    expect(Object.keys(evidence?.records ?? {})).toEqual(['codex:sol'])
  })

  it('uses rows the collector flags as not routing-eligible, such as new GPT-6 models', () => {
    const astra = offer('gpt-6-astra')
    const evidence = radarEvidence(snapshot([row('gpt-6-astra', 0.736, { routing_eligible: false })]), [astra], options)

    expect(Object.keys(evidence?.records ?? {})).toEqual(['codex:gpt-6-astra'])
  })

  it('ignores rows for other vendors, which ran in a different harness', () => {
    const claude = offer('claude-opus-5', { offerId: 'claude-code:claude-opus-5', operatorId: 'claude-code', provider: 'claude-code' })
    const evidence = radarEvidence(
      snapshot([row('claude-opus-5', 0.8, { provider: 'claude' }), row('deepseek-v4-flash', 0.6, { provider: 'unknown' })]),
      [claude, offer('deepseek-v4-flash')],
      options,
    )

    expect(evidence).toBeUndefined()
  })

  it('gives an offer no record for another effort, provider, or unlisted model', () => {
    const evidence = radarEvidence(
      snapshot([row('gpt-5.6-sol', 0.9, { reasoning_effort: 'low' }), row('gpt-5.6-terra', 0.6, { provider: 'other' })]),
      [sol, terra, offer('gpt-9')],
      options,
    )

    expect(evidence).toBeUndefined()
  })

  it('skips rows without a usable pass rate, sample count, or identity', () => {
    const evidence = radarEvidence(
      snapshot([
        'not a row', null,
        row('gpt-5.6-sol', 1.5), row('gpt-5.6-sol', -0.1), row('gpt-5.6-sol', 'high'), row('gpt-5.6-sol', null),
        row('gpt-5.6-sol', 0.9, { sample_count: 0 }), row('gpt-5.6-sol', 0.9, { sample_count: 1.5 }), row('gpt-5.6-sol', 0.9, { sample_count: null }),
        row('gpt-5.6-sol', 0.9, { provider: ' ' }), row('gpt-5.6-sol', 0.9, { model: '' }), row('gpt-5.6-sol', 0.9, { reasoning_effort: undefined }),
        row('gpt-5.6-terra', 0.7),
      ]),
      [sol, terra],
      options,
    )

    expect(Object.keys(evidence?.records ?? {})).toEqual(['codex:gpt-5.6-terra'])
  })

  it('offers no evidence for a missing, malformed, stale, or foreign-task generation', () => {
    const usable = snapshot([row('gpt-5.6-sol', 0.9)])
    expect(radarEvidence(undefined, [sol], options)).toBeUndefined()
    expect(radarEvidence('text', [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, snapshot_id: ' ' }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, digest: undefined }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, models: 'none' }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, fetched_at: 'not a date' }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, fetched_at: undefined }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, cache: undefined }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, cache: { stale_after_seconds: 0 } }, [sol], options)).toBeUndefined()
    expect(radarEvidence({ ...usable, cache: { stale_after_seconds: 3_600 } }, [sol], options)).toBeUndefined()
    expect(radarEvidence(usable, [sol], { ...options, taskType: 'research' })).toBeUndefined()
    expect(radarEvidence(usable, [sol], options)).toBeDefined()
  })

  it('names the generation when it carries no update time', () => {
    const evidence = radarEvidence(snapshot([row('gpt-5.6-sol', 0.9)], { source_updated_at: undefined }), [sol], options)
    expect(evidence?.records['codex:gpt-5.6-sol']?.[0]).toMatchObject({ benchmark_version: '2026-10-01T08:00:00Z' })
  })
})
