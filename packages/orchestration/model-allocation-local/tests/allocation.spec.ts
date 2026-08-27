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

  it('makes Codex Sol gates and Luna workers explicit switchable preferences', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const offers = [
      offer({ offerId: 'codex:sol', model: 'gpt-5.6-sol', tier: 'high' }),
      offer({
        offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code',
        model: 'opus', tier: 'high',
      }),
      offer({ offerId: 'codex:terra', model: 'gpt-5.6-terra', tier: 'medium' }),
      offer({ offerId: 'codex:luna', model: 'gpt-5.6-luna', tier: 'low' }),
    ]
    const common = {
      runId: 'r', nodeId: 'n', role: 'architect', task: 'review and implement the repository change',
      preferredOperatorIds: [], objective: 'balanced' as const, rlm: 'disabled' as const,
      graphMaxParallel: 4, offers, now: '2026-08-27T00:00:00.000Z',
    }
    const sol = await service.allocate({
      ...common, phase: 'planning', plannerVerifierPreference: 'codex-sol', executionPreference: 'balanced',
    })
    expect(sol.model).toBe('gpt-5.6-sol')
    expect(sol.rationale).toContain('codex-sol-planner-verifier')
    await expect(service.allocate({
      ...common, phase: 'planning', plannerVerifierPreference: 'best-high-tier', executionPreference: 'balanced',
    })).resolves.toMatchObject({ model: 'opus' })
    const luna = await service.allocate({
      ...common, phase: 'execution', role: 'implementation', task: 'implement the repository change',
      plannerVerifierPreference: 'best-high-tier', executionPreference: 'luna-first',
    })
    expect(luna.model).toBe('gpt-5.6-luna')
    expect(luna.rationale).toContain('codex-luna-worker')
    await expect(service.allocate({
      ...common, phase: 'execution', role: 'implementation', task: 'implement the repository change',
      plannerVerifierPreference: 'best-high-tier', executionPreference: 'balanced',
    })).resolves.toMatchObject({ model: 'gpt-5.6-terra' })
    await ctx.root.fiber.dispose()
  })

  it('keeps product affinity when a remote Server namespaces the operator id', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'implementation', task: 'implement the code change',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 2,
      offers: [
        offer({
          offerId: 'remote.mini.codex:luna', operatorId: 'remote.mini.codex',
          provider: 'codex', model: 'luna', tier: 'low',
        }),
        offer({
          offerId: 'remote.lab.claude:haiku', operatorId: 'remote.lab.claude-code',
          provider: 'claude-code', model: 'haiku', tier: 'low',
        }),
      ],
      now: '2026-08-27T12:00:00.000Z',
    })
    expect(result).toMatchObject({ operatorId: 'remote.mini.codex', provider: 'codex' })
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

  it('protects Claude reserve when quota is unknown or reaches the admission stop line', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const claudeGuard = {
      unknownQuota: 'block' as const,
      protectedRemainingPercent: 20,
      stopAdmissionAtRemainingPercent: 25,
      accelerateBeforeReset: false,
    }
    const common = {
      runId: 'r', nodeId: 'n', phase: 'execution' as const, role: 'worker', task: 'implement fixture',
      preferredOperatorIds: [], objective: 'balanced' as const, rlm: 'disabled' as const,
      graphMaxParallel: 4, now: '2026-08-23T00:00:00.000Z',
    }
    const codex = offer({ offerId: 'codex:luna', model: 'luna', tier: 'low' })
    const unknownClaude = offer({
      offerId: 'claude:sonnet', operatorId: 'claude-code', provider: 'claude-code', model: 'sonnet',
      quotaGuard: claudeGuard,
    })
    await expect(service.allocate({ ...common, offers: [unknownClaude, codex] }))
      .resolves.toMatchObject({ offerId: 'codex:luna' })

    const protectedClaude = offer({
      ...unknownClaude,
      quotaPool: {
        poolId: 'claude-five-hour', displayName: 'Claude five-hour', models: ['sonnet'], meter: 'native-subscription',
        primary: { usedPercent: 75 }, observedAt: common.now,
      },
    })
    await expect(service.allocate({ ...common, offers: [protectedClaude, codex] }))
      .resolves.toMatchObject({ offerId: 'codex:luna' })
    await ctx.root.fiber.dispose()
  })

  it('admits Claude above the stop line without spending its protected reserve near reset', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const now = 1_777_000_000
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'architect', task: 'review architecture',
      preferredOperatorIds: ['claude-code'], objective: 'quality', rlm: 'disabled', graphMaxParallel: 2,
      offers: [offer({
        offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code', model: 'opus', tier: 'high',
        quotaGuard: {
          unknownQuota: 'block', protectedRemainingPercent: 20,
          stopAdmissionAtRemainingPercent: 25, accelerateBeforeReset: false,
        },
        quotaPool: {
          poolId: 'claude-five-hour', displayName: 'Claude five-hour', models: ['opus'], meter: 'native-subscription',
          primary: { usedPercent: 60, resetsAt: now + 60 }, observedAt: new Date(now * 1_000).toISOString(),
        },
      })],
      now: new Date(now * 1_000).toISOString(),
    })
    expect(result).toMatchObject({ offerId: 'claude:opus' })
    expect(result.rationale).toContain('protected-reserve:20%')
    expect(result.rationale).not.toContain('accelerate-before-quota-reset')
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
