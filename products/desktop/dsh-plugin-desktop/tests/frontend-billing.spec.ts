import { describe, expect, it } from 'vitest'
import {
  mergeFrontendBillingState,
  parseFrontendBillingBaseline,
  startFrontendBillingBridge,
} from '../src/frontend-billing.ts'

const baseline = {
  calls: 415,
  cost: 11.6173779,
  costUsd: 1.697263652,
  inputTokens: 2_043_980,
  cacheReadTokens: 23_318_912,
  outputTokens: 200_035,
}

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
    })).toEqual(baseline)
  })

  it.each([
    undefined,
    {},
    { totals: { calls: -1 } },
    { totals: { calls: 1, cost: Number.NaN } },
  ])('rejects an incomplete or invalid durable ledger boundary', (value) => {
    expect(() => parseFrontendBillingBaseline(value)).toThrow()
  })

  it('adds the local baseline once while preserving the original Server totals', () => {
    const serverTotals = {
      calls: 2,
      cost: 0.5,
      costUsd: 0.07,
      costNominal: 0.5,
      costNominalUsd: 0.07,
      savings: 0,
      savingsUsd: 0,
      inputTokens: 10,
      cacheReadTokens: 20,
      outputTokens: 30,
    }
    expect(mergeFrontendBillingState({ ok: true, totals: serverTotals }, baseline)).toEqual({
      ok: true,
      totals: {
        ...serverTotals,
        calls: 417,
        cost: 12.1173779,
        costUsd: 1.767263652,
        costNominal: 12.1173779,
        costNominalUsd: 1.767263652,
        inputTokens: 2_043_990,
        cacheReadTokens: 23_318_932,
        outputTokens: 200_065,
      },
      desktopFrontend: { baseline, serverTotals },
    })
  })

  it('serves the merged state through a private loopback redirect target', async () => {
    const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(String(input)).toBe('https://server.example/billing/state')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer short-lived')
      return Response.json({
        ok: true,
        totals: {
          calls: 0,
          cost: 0,
          costUsd: 0,
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
        },
      })
    }
    const bridge = await startFrontendBillingBridge({
      origin: 'https://server.example',
      baseline,
      accessToken: () => 'short-lived',
      request,
    })
    try {
      const response = await fetch(bridge.url, { headers: { origin: 'https://server.example' } })
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('https://server.example')
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: true,
        totals: expect.objectContaining({ calls: 415, cost: 11.6173779 }),
      }))
    } finally {
      await bridge.close()
    }
  })
})
