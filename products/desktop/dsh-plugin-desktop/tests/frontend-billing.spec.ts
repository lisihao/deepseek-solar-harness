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
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer short-lived')
      if (String(input).endsWith('/remote-sync/describe')) {
        return Response.json({ result: { ok: true, value: { deploymentId: 'server-primary' } } })
      }
      expect(String(input)).toBe('https://server.example/billing/state')
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
      sources: [{
        id: 'primary', label: 'Primary', origin: 'https://server.example',
        accessToken: () => 'short-lived',
      }],
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

  it('closes without waiting for an active renderer request', async () => {
    let releaseSources!: () => void
    const sourcesReleased = new Promise<void>((resolve) => { releaseSources = resolve })
    let markSourcesStarted!: () => void
    const sourcesStarted = new Promise<void>((resolve) => { markSourcesStarted = resolve })
    let requestCount = 0
    const request = async (input: string | URL | Request): Promise<Response> => {
      requestCount += 1
      if (requestCount === 2) markSourcesStarted()
      await sourcesReleased
      if (String(input).endsWith('/remote-sync/describe')) {
        return Response.json({ result: { ok: true, value: { deploymentId: 'server-primary' } } })
      }
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
      sources: [{ id: 'primary', label: 'Primary', origin: 'https://server.example' }],
      request,
    })
    const rendererRequest = fetch(bridge.url).catch(() => undefined)
    await sourcesStarted
    const closing = bridge.close()
    const outcome = await Promise.race([
      closing.then(() => 'closed' as const),
      new Promise<'blocked'>((resolve) => { setTimeout(() => { resolve('blocked') }, 100) }),
    ])
    releaseSources()
    await Promise.allSettled([closing, rendererRequest])
    expect(outcome).toBe('closed')
  })

  it('aggregates every configured Server and retains unavailable source provenance', async () => {
    const request = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input))
      const origin = url.origin
      if (origin === 'https://offline.example') return new Response('offline', { status: 503 })
      if (url.pathname === '/remote-sync/describe') {
        return Response.json({ result: { ok: true, value: { deploymentId: origin } } })
      }
      const multiplier = origin === 'https://leader.example' ? 1 : 2
      return Response.json({
        ok: true,
        totals: {
          calls: multiplier,
          cost: multiplier * 0.5,
          costUsd: multiplier * 0.07,
          inputTokens: multiplier * 10,
          cacheReadTokens: multiplier * 20,
          outputTokens: multiplier * 30,
        },
        today: {
          calls: multiplier,
          cost: multiplier * 0.5,
          costUsd: multiplier * 0.07,
          inputTokens: multiplier * 10,
          cacheReadTokens: multiplier * 20,
          outputTokens: multiplier * 30,
        },
        month: {
          calls: multiplier,
          cost: multiplier * 0.5,
          costUsd: multiplier * 0.07,
          inputTokens: multiplier * 10,
          cacheReadTokens: multiplier * 20,
          outputTokens: multiplier * 30,
        },
        byModel: {},
      })
    }
    const bridge = await startFrontendBillingBridge({
      origin: 'https://leader.example',
      baseline,
      sources: [
        { id: 'leader', label: 'Leader', origin: 'https://leader.example' },
        { id: 'worker', label: 'Worker', origin: 'https://worker.example' },
        { id: 'offline', label: 'Offline', origin: 'https://offline.example' },
      ],
      request,
    })
    try {
      const response = await fetch(bridge.url)
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expect.objectContaining({
        totals: expect.objectContaining({ calls: 418, cost: 13.1173779 }),
        today: expect.objectContaining({ calls: 3, cost: 1.5 }),
        desktopFrontend: expect.objectContaining({
          serverTotals: expect.objectContaining({ calls: 3, cost: 1.5 }),
          sources: [
            expect.objectContaining({ id: 'leader', status: 'ready', totals: expect.objectContaining({ calls: 1 }) }),
            expect.objectContaining({ id: 'worker', status: 'ready', totals: expect.objectContaining({ calls: 2 }) }),
            expect.objectContaining({ id: 'offline', status: 'unavailable', error: 'HTTP 503' }),
          ],
        }),
      }))
    } finally {
      await bridge.close()
    }
  })

  it('deduplicates two ingress URLs for the same deployment ledger', async () => {
    const request = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input))
      if (url.pathname === '/remote-sync/describe') {
        return Response.json({ result: { ok: true, value: { deploymentId: 'same-server' } } })
      }
      return Response.json({ ok: true, totals: { calls: 2, cost: 1, costUsd: 0.1, inputTokens: 10, cacheReadTokens: 20, outputTokens: 30 }, ledgerId: 'shared-ledger' })
    }
    const bridge = await startFrontendBillingBridge({
      origin: 'https://one.example', baseline,
      sources: [
        { id: 'one', label: 'One', origin: 'https://one.example' },
        { id: 'two', label: 'Two', origin: 'https://two.example' },
      ], request,
    })
    try {
      const value = await (await fetch(bridge.url)).json() as any
      expect(value.totals.calls).toBe(baseline.calls + 2)
      expect(value.desktopFrontend.sources[1]).toEqual(expect.objectContaining({ deduplicated: true, ledgerId: 'shared-ledger', deadlineMs: 3000, stale: false }))
    } finally { await bridge.close() }
  })
})
