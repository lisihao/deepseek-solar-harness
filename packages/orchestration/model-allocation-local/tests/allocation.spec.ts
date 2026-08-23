import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import { SubscriptionFirstModelAllocation } from '../src/index.ts'

const offer = (overrides: Partial<ModelExecutionOffer>): ModelExecutionOffer => ({
  offerId: 'codex:terra', operatorId: 'codex', provider: 'codex', model: 'terra', displayName: 'Terra',
  source: 'native-subscription', tier: 'medium', available: true, maxConcurrency: 4, activeCount: 0,
  tags: ['coding'], profile: { model: 'terra' }, ...overrides,
})

describe('subscription-first model allocation', () => {
  it('uses high-tier subscription planning and low-tier parallel workers', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const offers = [
      offer({ offerId: 'codex:luna', model: 'luna', tier: 'low', profile: { model: 'luna' } }),
      offer({ offerId: 'codex:sol', model: 'sol', tier: 'high', profile: { model: 'sol' } }),
      offer({ offerId: 'deepseek:flash', operatorId: 'deepseek-api', provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'metered-api', tier: 'low' }),
    ]
    const common = { runId: 'r', nodeId: 'n', role: 'implementation', task: 'implement tests', preferredOperatorIds: [], objective: 'balanced' as const, rlm: 'disabled' as const, graphMaxParallel: 4, offers, now: '2026-08-21T00:00:00.000Z' }
    await expect(service.allocate({ ...common, phase: 'planning' })).resolves.toMatchObject({ model: 'sol', source: 'native-subscription' })
    await expect(service.allocate({ ...common, phase: 'execution' })).resolves.toMatchObject({ model: 'luna', source: 'native-subscription', suggestedParallelism: 4 })
    await ctx.root.fiber.dispose()
  })

  it('treats Spark as an independent pool and accelerates unused quota before reset', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const observedAt = '2026-08-21T00:00:00.000Z'
    const offers = [
      offer({ offerId: 'codex:terra', model: 'terra', quotaPool: { poolId: 'codex', displayName: 'Codex', models: ['terra'], meter: 'native-subscription', primary: { usedPercent: 60, resetsAt: 1_777_000_000 }, observedAt } }),
      offer({ offerId: 'codex:spark', model: 'gpt-5.3-codex-spark', tier: 'low', quotaPool: { poolId: 'codex_bengalfox', displayName: 'GPT-5.3-Codex-Spark', models: ['gpt-5.3-codex-spark'], meter: 'native-subscription', primary: { usedPercent: 5, resetsAt: 1_777_003_600 }, observedAt } }),
    ]
    const result = await service.allocate({ runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'write fixture', preferredOperatorIds: [], objective: 'speed', rlm: 'disabled', graphMaxParallel: 8, offers, now: new Date(1_777_000_000_000).toISOString() })
    expect(result).toMatchObject({ model: 'gpt-5.3-codex-spark', quotaPoolId: 'codex_bengalfox' })
    expect(result.rationale).toContain('accelerate-before-quota-reset')
    await ctx.root.fiber.dispose()
  })

  it('does not probe Spark when any simultaneous quota window is exhausted', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const observedAt = '2026-08-23T00:00:00.000Z'
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'write fixture',
      preferredOperatorIds: [], objective: 'speed', rlm: 'disabled', graphMaxParallel: 8,
      offers: [
        offer({ offerId: 'codex:luna', model: 'luna', tier: 'low' }),
        offer({
          offerId: 'codex:spark', model: 'gpt-5.3-codex-spark', tier: 'low',
          quotaPool: {
            poolId: 'codex_bengalfox', displayName: 'GPT-5.3-Codex-Spark',
            models: ['gpt-5.3-codex-spark'], meter: 'native-subscription',
            primary: { usedPercent: 100 }, secondary: { usedPercent: 52 }, observedAt,
          },
        }),
      ],
      now: observedAt,
    })
    expect(result).toMatchObject({ model: 'luna', offerId: 'codex:luna' })
    await ctx.root.fiber.dispose()
  })

  it('uses a high-tier metered model only when no qualified high-tier subscription is available', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'plan', phase: 'planning', role: 'architect', task: 'plan the change',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 4,
      offers: [
        offer({ offerId: 'codex:luna', model: 'luna', tier: 'low' }),
        offer({ offerId: 'deepseek:pro', operatorId: 'deepseek-api', provider: 'deepseek-official', model: 'deepseek-v4-pro', source: 'metered-api', tier: 'high' }),
      ],
      now: '2026-08-22T00:00:00.000Z',
    })
    expect(result).toMatchObject({ model: 'deepseek-v4-pro', source: 'metered-api', tier: 'high' })
    await ctx.root.fiber.dispose()
  })

  it('reports temporary saturation instead of spending API capacity for a balanced run', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    expect(() => service.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'write fixture',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 8,
      offers: [
        offer({ offerId: 'codex:luna', model: 'luna', maxConcurrency: 2, activeCount: 2 }),
        offer({ offerId: 'deepseek:flash', operatorId: 'deepseek-api', provider: 'deepseek-official', model: 'deepseek-v4-flash', source: 'metered-api', tier: 'low' }),
      ],
      now: '2026-08-23T00:00:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'MODEL_CAPACITY_BUSY' }))
    await ctx.root.fiber.dispose()
  })

  it('recommends only currently free subscription slots rather than nominal provider capacity', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'write fixture',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 8,
      offers: [offer({ offerId: 'codex:luna', model: 'luna', tier: 'low', maxConcurrency: 4, activeCount: 3 })],
      now: '2026-08-23T00:00:00.000Z',
    })
    expect(result.suggestedParallelism).toBe(1)
    await ctx.root.fiber.dispose()
  })
})
