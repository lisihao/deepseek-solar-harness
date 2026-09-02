import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { validateAdaptiveExecutionPreference, type AdaptiveExecutionPreferenceV1, type ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import { SubscriptionFirstModelAllocation } from '../src/index.ts'

const offer = (overrides: Partial<ModelExecutionOffer>): ModelExecutionOffer => ({
  offerId: 'codex:terra', operatorId: 'codex', provider: 'codex', model: 'terra', displayName: 'Terra',
  source: 'native-subscription', tier: 'medium', available: true, maxConcurrency: 4, activeCount: 0,
  tags: ['coding'], profile: { model: 'terra' }, ...overrides,
})

describe('subscription-first model allocation', () => {
  const adaptiveCases: readonly {
    name: string
    preference: AdaptiveExecutionPreferenceV1
    expectedModel: string
    rationale: string
  }[] = [
    {
      name: 'low-risk first attempt',
      preference: { version: 1, executionRisk: 'low', priorFailures: 0 },
      expectedModel: 'luna',
      rationale: 'adaptive-codex-luna-low-risk',
    },
    {
      name: 'medium-risk execution',
      preference: { version: 1, executionRisk: 'medium', priorFailures: 0 },
      expectedModel: 'terra',
      rationale: 'adaptive-codex-terra-escalated',
    },
    {
      name: 'high-risk execution',
      preference: { version: 1, executionRisk: 'high', priorFailures: 0 },
      expectedModel: 'terra',
      rationale: 'adaptive-codex-terra-escalated',
    },
    {
      name: 'cross-domain execution',
      preference: { version: 1, executionRisk: 'low', priorFailures: 0, crossDomain: true },
      expectedModel: 'terra',
      rationale: 'adaptive-codex-terra-escalated',
    },
    {
      name: 'execution after a failure',
      preference: { version: 1, executionRisk: 'low', priorFailures: 1 },
      expectedModel: 'terra',
      rationale: 'adaptive-codex-terra-escalated',
    },
  ]

  it.each(adaptiveCases)('uses $expectedModel for $name', async ({ preference, expectedModel, rationale }) => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'implement the repository change',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 4,
      adaptiveExecutionPreference: preference,
      offers: [
        offer({ offerId: 'codex:luna', model: 'luna', tier: 'low' }),
        offer({ offerId: 'codex:terra', model: 'terra', tier: 'medium' }),
      ],
      now: '2026-08-28T00:00:00.000Z',
    })
    expect(result.model).toBe(expectedModel)
    expect(result.rationale).toContain(rationale)
    await ctx.root.fiber.dispose()
  })

  it('falls back to the existing scorer when an adaptive target model is absent', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'execution', role: 'worker', task: 'implement the repository change',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 4,
      adaptiveExecutionPreference: { version: 1, executionRisk: 'high', priorFailures: 2 },
      offers: [offer({ offerId: 'codex:luna', model: 'luna', tier: 'low' })],
      now: '2026-08-28T00:00:00.000Z',
    })
    expect(result.model).toBe('luna')
    expect(result.rationale).toContain('adaptive-terra-unavailable-fallback')
    await ctx.root.fiber.dispose()
  })

  it('keeps an explicit Codex Sol planning gate ahead of adaptive execution hints', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'architect', task: 'plan the implementation',
      preferredOperatorIds: [], objective: 'balanced', rlm: 'disabled', graphMaxParallel: 4,
      plannerVerifierPreference: 'codex-sol',
      adaptiveExecutionPreference: { version: 1, executionRisk: 'high', priorFailures: 1 },
      offers: [
        offer({ offerId: 'codex:sol', model: 'sol', tier: 'high' }),
        offer({ offerId: 'codex:terra', model: 'terra', tier: 'medium' }),
      ],
      now: '2026-08-28T00:00:00.000Z',
    })
    expect(result.model).toBe('sol')
    expect(result.rationale).toContain('codex-sol-planner-verifier')
    await ctx.root.fiber.dispose()
  })

  it('rejects unknown adaptive fields and unsafe numeric values at the Provider boundary', () => {
    expect(() => validateAdaptiveExecutionPreference({ version: 1, executionRisk: 'low', priorFailures: 0, extra: true }))
      .toThrow(expect.objectContaining({ code: 'MODEL_ALLOCATION_INVALID' }))
    expect(() => validateAdaptiveExecutionPreference({ version: 2, executionRisk: 'low', priorFailures: 0 }))
      .toThrow('version')
    expect(() => validateAdaptiveExecutionPreference({ version: 1, executionRisk: 'low', priorFailures: -1 }))
      .toThrow('priorFailures')
    expect(() => validateAdaptiveExecutionPreference({ version: 1, executionRisk: 'low', priorFailures: 1.5 }))
      .toThrow('priorFailures')
    expect(() => validateAdaptiveExecutionPreference({ version: 1, executionRisk: 'low', priorFailures: 0, crossDomain: 'yes' }))
      .toThrow('crossDomain')
  })

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

  it('offers Claude frontier planning and Sonnet execution as first-class switchable preferences', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const offers = [
      offer({ offerId: 'codex:sol', model: 'gpt-5.6-sol', tier: 'high' }),
      offer({ offerId: 'codex:terra', model: 'gpt-5.6-terra', tier: 'medium' }),
      offer({
        offerId: 'claude:fable', operatorId: 'claude-code', provider: 'claude-code',
        model: 'claude-fable-5', displayName: 'Claude Fable', tier: 'high',
      }),
      offer({
        offerId: 'claude:sonnet', operatorId: 'claude-code', provider: 'claude-code',
        model: 'claude-sonnet-5', displayName: 'Claude Sonnet', tier: 'medium',
      }),
    ]
    const common = {
      runId: 'r', nodeId: 'n', role: 'architect', task: 'review and implement the repository change',
      preferredOperatorIds: [], objective: 'balanced' as const, rlm: 'disabled' as const,
      graphMaxParallel: 4, offers, now: '2026-08-29T00:00:00.000Z',
    }
    const frontier = await service.allocate({
      ...common, phase: 'planning', plannerVerifierPreference: 'claude-frontier', executionPreference: 'balanced',
    })
    expect(frontier).toMatchObject({ operatorId: 'claude-code', model: 'claude-fable-5' })
    expect(frontier.rationale).toContain('claude-frontier-planner-verifier')

    const sonnet = await service.allocate({
      ...common, phase: 'execution', role: 'implementation',
      plannerVerifierPreference: 'best-high-tier', executionPreference: 'claude-sonnet',
      adaptiveExecutionPreference: { version: 1, executionRisk: 'high', priorFailures: 2 },
    })
    expect(sonnet).toMatchObject({ operatorId: 'claude-code', model: 'claude-sonnet-5' })
    expect(sonnet.rationale).toContain('claude-sonnet-worker')
    expect(sonnet.rationale).not.toContain('adaptive-codex-terra-escalated')
    await ctx.root.fiber.dispose()
  })

  it('honors the requested model on an explicitly preferred operator', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'judge', task: 'judge the debate',
      preferredOperatorIds: ['codex'], preferredModel: 'gpt-5.6-sol', objective: 'quality',
      rlm: 'disabled', graphMaxParallel: 2,
      offers: [
        offer({ offerId: 'codex:sonnet', model: 'gpt-5.6-sonnet', tier: 'high' }),
        offer({ offerId: 'codex:sol', model: 'gpt-5.6-sol', tier: 'high' }),
      ],
      now: '2026-08-29T00:00:00.000Z',
    })
    expect(result).toMatchObject({ operatorId: 'codex', model: 'gpt-5.6-sol' })
    await ctx.root.fiber.dispose()
  })

  it('fails loudly instead of selecting a sibling model when an explicit model is unavailable', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    expect(() => service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'judge', task: 'judge the debate',
      preferredOperatorIds: ['codex'], preferredModel: 'gpt-5.6-sol', objective: 'quality',
      rlm: 'disabled', graphMaxParallel: 2,
      offers: [offer({ offerId: 'codex:sonnet', model: 'gpt-5.6-sonnet', tier: 'high' })],
      now: '2026-08-29T00:00:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'EXPLICIT_MODEL_UNAVAILABLE' }))
    await ctx.root.fiber.dispose()
  })

  it('does not apply the preferred model pin to an admitted fallback operator', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'judge', task: 'judge the debate',
      preferredOperatorIds: ['claude-code'], fallbackOperatorIds: ['codex'], preferredModel: 'opus',
      objective: 'quality', rlm: 'disabled', graphMaxParallel: 2,
      offers: [
        offer({
          offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code', model: 'opus',
          available: false, unavailableReasonCode: 'AUTHENTICATION_UNQUALIFIED', tier: 'high',
        }),
        offer({ offerId: 'codex:sonnet', model: 'sonnet', tier: 'high' }),
        offer({ offerId: 'codex:opus', model: 'opus', tier: 'low' }),
      ],
      now: '2026-08-29T00:00:00.000Z',
    })
    expect(result).toMatchObject({ operatorId: 'codex', model: 'sonnet' })
    expect(result.fallback).toMatchObject({ fromOperatorId: 'claude-code', fromModel: 'opus' })
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

  it.each([
    {
      name: 'operator outage',
      reasonCode: 'OPERATOR_UNAVAILABLE' as const,
      primary: offer({
        offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code', model: 'opus',
        available: false, unavailableReasonCode: 'OPERATOR_UNAVAILABLE',
      }),
    },
    {
      name: 'authentication failure',
      reasonCode: 'AUTHENTICATION_UNQUALIFIED' as const,
      primary: offer({
        offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code', model: 'opus',
        available: false, unavailableReasonCode: 'AUTHENTICATION_UNQUALIFIED',
      }),
    },
    {
      name: 'model mismatch',
      reasonCode: 'MODEL_UNAVAILABLE' as const,
      primary: offer({
        offerId: 'claude:sonnet', operatorId: 'claude-code', provider: 'claude-code', model: 'sonnet',
        available: false, unavailableReasonCode: 'MODEL_UNAVAILABLE',
      }),
    },
    {
      name: 'quota rejection',
      reasonCode: 'QUOTA_UNQUALIFIED' as const,
      primary: offer({
        offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code', model: 'opus',
        quotaGuard: {
          unknownQuota: 'block', protectedRemainingPercent: 20,
          stopAdmissionAtRemainingPercent: 25, accelerateBeforeReset: false,
        },
        quotaPool: {
          poolId: 'claude-five-hour', displayName: 'Claude five-hour', models: ['opus'],
          meter: 'native-subscription', primary: { usedPercent: 80 }, observedAt: '2026-08-23T00:00:00.000Z',
        },
      }),
    },
  ])('uses an admitted fallback for $name and records structured provenance', async ({ primary, reasonCode }) => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    const result = await service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'judge', task: 'judge the debate',
      preferredOperatorIds: ['claude-code'], fallbackOperatorIds: ['codex'], preferredModel: 'claude-opus-5',
      objective: 'quality', rlm: 'disabled', graphMaxParallel: 2,
      offers: [
        primary,
        offer({ offerId: 'codex:sol', model: 'gpt-5.6-sol', tier: 'high' }),
      ],
      now: '2026-08-23T00:00:00.000Z',
    })
    expect(result).toMatchObject({
      operatorId: 'codex', model: 'gpt-5.6-sol',
      fallback: {
        fromOperatorId: 'claude-code',
        fromModel: 'claude-opus-5',
        reasonCode,
      },
    })
    await ctx.root.fiber.dispose()
  })

  it('keeps a qualified but busy preferred operator pinned instead of using a fallback', async () => {
    const ctx = new Context()
    const service = new SubscriptionFirstModelAllocation(ctx)
    expect(() => service.allocate({
      runId: 'r', nodeId: 'n', phase: 'planning', role: 'judge', task: 'judge the debate',
      preferredOperatorIds: ['claude-code'], fallbackOperatorIds: ['codex'], preferredModel: 'opus',
      objective: 'quality', rlm: 'disabled', graphMaxParallel: 2,
      offers: [
        offer({
          offerId: 'claude:opus', operatorId: 'claude-code', provider: 'claude-code', model: 'opus',
          tier: 'high', maxConcurrency: 1, activeCount: 1,
        }),
        offer({ offerId: 'codex:sol', model: 'gpt-5.6-sol', tier: 'high' }),
      ],
      now: '2026-08-23T00:00:00.000Z',
    })).toThrow(expect.objectContaining({ code: 'MODEL_CAPACITY_BUSY' }))
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
