import { describe, expect, it } from 'vitest'
import { parseFrontendBillingBaseline } from '../src/frontend-billing.ts'

describe('Frontend billing baseline', () => {
  it('retains the local Host totals used beside the active Server ledger', () => {
    expect(parseFrontendBillingBaseline({
      totals: {
        calls: 415,
        cost: 11.6173779,
        costUsd: 1.697263652,
        inputTokens: 2_043_980,
        cacheReadTokens: 23_318_912,
        outputTokens: 200_035,
      },
    })).toEqual({
      calls: 415,
      cost: 11.6173779,
      costUsd: 1.697263652,
      inputTokens: 2_043_980,
      cacheReadTokens: 23_318_912,
      outputTokens: 200_035,
    })
  })

  it.each([
    undefined,
    {},
    { totals: { calls: -1 } },
    { totals: { calls: 1, cost: Number.NaN } },
  ])('rejects an incomplete or invalid durable ledger boundary', (value) => {
    expect(() => parseFrontendBillingBaseline(value)).toThrow()
  })
})
