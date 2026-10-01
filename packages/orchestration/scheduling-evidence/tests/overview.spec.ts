import { describe, expect, it } from 'vitest'
import { projectStore } from '../src/overview.ts'

const shown = {
  snapshot_id: 'gen-1',
  digest: 'sha256:abc',
  fetched_at: '2026-10-01T14:05:07Z',
  source_updated_at: '2026-10-01T14:04:43+00:00',
  cache: { state: 'fresh', stale_after_seconds: 604_800 },
  authorization: { status: 'consented' },
  models: [
    { provider: 'codex', model: 'gpt-6-astra', reasoning_effort: 'high', pass_rate: 0.736, sample_count: 140, iq: 110.4, avg_cost_usd: 2.8, avg_runtime_seconds: 826, routing_eligible: false },
    { provider: 'claude', model: 'claude-opus-5', reasoning_effort: 'low', pass_rate: null, sample_count: 'many', iq: Number.NaN },
    { provider: 'codex', model: '', reasoning_effort: 'high' },
    'not a row',
  ],
}
const status = { age_seconds: 1898, cache_status: 'cache', database: { row_counts: { radar_models: 89, radar_snapshots: 1, bad: 'x' } } }

describe('projectStore', () => {
  it('describes the stored generation, its tables, and each usable row', () => {
    const { store, models } = projectStore(status, shown, 'gen-1', undefined)

    expect(store).toEqual({
      available: true,
      snapshotId: 'gen-1',
      digest: 'sha256:abc',
      state: 'fresh',
      fetchedAt: '2026-10-01T14:05:07Z',
      sourceUpdatedAt: '2026-10-01T14:04:43+00:00',
      ageSeconds: 1898,
      staleAfterSeconds: 604_800,
      authorization: 'consented',
      rowCounts: { radar_models: 89, radar_snapshots: 1 },
      loaded: true,
    })
    expect(models).toEqual([
      {
        provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high', passRate: 0.736, sampleCount: 140, iq: 110.4,
        avgCostUsd: 2.8, avgRuntimeSeconds: 826, usedForEvidence: true,
      },
      {
        provider: 'claude', model: 'claude-opus-5', reasoningEffort: 'low', passRate: null, sampleCount: null, iq: null,
        avgCostUsd: null, avgRuntimeSeconds: null, usedForEvidence: false,
      },
    ])
  })

  it('says the allocator does not hold the generation yet', () => {
    expect(projectStore(status, shown, undefined, undefined).store).toMatchObject({ available: true, loaded: false })
    expect(projectStore(status, shown, 'older', undefined).store).toMatchObject({ loaded: false })
  })

  it('falls back to the status document for state and tolerates missing parts', () => {
    const { store, models } = projectStore(undefined, { snapshot_id: 'gen-2' }, undefined, undefined)

    expect(store).toEqual({
      available: true, snapshotId: 'gen-2', digest: '', state: 'unknown', fetchedAt: null, sourceUpdatedAt: null,
      ageSeconds: null, staleAfterSeconds: null, authorization: null, rowCounts: {}, loaded: false,
    })
    expect(models).toEqual([])
    expect(projectStore({ cache_status: 'stale-cache' }, { snapshot_id: 'gen-3' }, undefined, undefined).store)
      .toMatchObject({ state: 'stale-cache' })
  })

  it('reports why nothing is stored, preferring a call failure, then the collector error', () => {
    expect(projectStore(undefined, undefined, undefined, 'Python 3.9 is too old').store)
      .toEqual({ available: false, reason: 'Python 3.9 is too old' })
    expect(projectStore({ last_error: 'authorization receipt is invalid' }, { ok: false }, undefined, undefined).store)
      .toEqual({ available: false, reason: 'authorization receipt is invalid' })
    expect(projectStore({}, { ok: false }, undefined, undefined).store)
      .toEqual({ available: false, reason: 'No generation is stored yet.' })
  })
})
