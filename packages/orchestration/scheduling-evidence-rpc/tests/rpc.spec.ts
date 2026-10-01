import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { SchedulingEvidenceOverview } from '@deepseek-ai/dsh-scheduling-evidence'
import * as schedulingEvidenceRpc from '@deepseek-ai/dsh-scheduling-evidence-rpc'

const { SCHEDULING_EVIDENCE_RPC_CHANNEL, apply, createSchedulingEvidenceRpcHandler, inject } = schedulingEvidenceRpc

const OVERVIEW: SchedulingEvidenceOverview = {
  version: 1,
  radar: { enabled: true, personalUseConsent: true, python: 'python3', refreshIntervalMs: 14_400_000 },
  lastCycle: null,
  store: { available: false, reason: 'No generation is stored yet.' },
  models: [],
}

const signal = new AbortController().signal
const requestContext = { request: new Request('http://localhost/'), remoteAddress: '127.0.0.1' }

describe('scheduling-evidence Host RPC', () => {
  it('uses only the named function-plugin exports', () => {
    expect('default' in schedulingEvidenceRpc).toBe(false)
  })

  it('registers one trusted channel and removes it with the plugin fiber', async () => {
    const ctx = new Context()
    ctx.provide('schedulingEvidence', { overview: () => Promise.resolve(OVERVIEW) } as never)
    const dispose = vi.fn(() => Promise.resolve())
    const handle = vi.fn(() => dispose)
    ctx.provide('connection', { rpc: { handle } } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })

    await fiber.await()
    expect(handle).toHaveBeenCalledWith(
      SCHEDULING_EVIDENCE_RPC_CHANNEL,
      expect.any(Function),
      { authority: 'trusted-host' },
    )
    await fiber.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('returns the store overview with a null evidence mode when no settings service is mounted', async () => {
    const handler = createSchedulingEvidenceRpcHandler({ overview: () => Promise.resolve(OVERVIEW) })

    expect(await handler('overview', {}, signal, requestContext)).toEqual({ ok: true, value: { ...OVERVIEW, publicEvidence: null } })
    expect(await handler('overview', undefined, signal, requestContext)).toMatchObject({ ok: true })
  })

  it.each(['off', 'shadow', 'apply'] as const)('adds the %s evidence mode from the settings', async (mode) => {
    const settings = { get: vi.fn(() => ({ publicEvidence: mode })) }
    const handler = createSchedulingEvidenceRpcHandler({ overview: () => Promise.resolve(OVERVIEW) }, settings as never)

    expect(await handler('overview', {}, signal, requestContext)).toMatchObject({ ok: true, value: { publicEvidence: mode } })
    expect(settings.get).toHaveBeenCalledWith('model-allocation')
  })

  it('reports no evidence mode for a settings value it does not recognize', async () => {
    const settings = { get: () => ({ publicEvidence: 'always' }) }
    const handler = createSchedulingEvidenceRpcHandler({ overview: () => Promise.resolve(OVERVIEW) }, settings as never)

    expect(await handler('overview', {}, signal, requestContext)).toMatchObject({ ok: true, value: { publicEvidence: null } })
  })

  it('rejects an unknown endpoint, a payload, and a failing gateway as bad requests', async () => {
    const handler = createSchedulingEvidenceRpcHandler({ overview: () => Promise.resolve(OVERVIEW) })
    const failing = createSchedulingEvidenceRpcHandler({ overview: () => Promise.reject(new Error('store locked')) })
    const stringFailure = createSchedulingEvidenceRpcHandler({
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the gateway crosses an unknown rejection boundary.
      overview: () => Promise.reject('store locked'),
    })

    expect(await handler('delete', {}, signal, requestContext)).toMatchObject({ ok: false, error: { code: 'bad-request', message: 'unknown scheduling-evidence endpoint: delete' } })
    expect(await handler('overview', { refresh: true }, signal, requestContext)).toMatchObject({ ok: false, error: { message: 'payload must be empty' } })
    expect(await handler('overview', 'text', signal, requestContext)).toMatchObject({ ok: false })
    expect(await handler('overview', null, signal, requestContext)).toMatchObject({ ok: false })
    expect(await failing('overview', {}, signal, requestContext)).toMatchObject({ ok: false, error: { message: 'store locked' } })
    expect(await stringFailure('overview', {}, signal, requestContext)).toMatchObject({ ok: false, error: { message: 'store locked' } })
  })
})
