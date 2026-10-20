import { describe, expect, it, vi } from 'vitest'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createWebUiApi,
  type WebUiWire,
} from '../src/client-remote.js'
import type { WebRunRecord } from '../src/store.js'
import type { WebUiStatus } from '../src/ui-contract.js'

const id = '11111111-1111-4111-8111-111111111111'

function record(): WebRunRecord {
  return {
    formatVersion: 1,
    id,
    revision: 0,
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    request: { prompt: 'wire contract test' },
    stage: 'prepared',
  }
}

function success<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function failed<T>(error: RemoteFailure): RemoteResult<T> {
  return { ok: false, error }
}

function failure(): RemoteFailure {
  return Object.assign(new Error('wire failure detail'), {
    code: 'gateway/internal',
    details: {},
    isDSHRemoteError: true as const,
  }) as RemoteFailure
}

describe('createWebUiApi', () => {
  it('unwraps successful status, launch, observe and cancel results', async () => {
    const status: WebUiStatus = { runs: [record()], activeIds: [id], errors: [] }
    const launched = { id }
    const observed = record()
    const wire: WebUiWire = {
      status: vi.fn(async () => success(status)),
      launch: vi.fn(async () => success(launched)),
      observe: vi.fn(async () => success(observed)),
      cancel: vi.fn(async () => success(observed)),
    }
    const api = createWebUiApi(wire)

    await expect(api.status()).resolves.toBe(status)
    await expect(api.launch({ id, request: { prompt: 'wire contract test' } })).resolves.toBe(launched)
    await expect(api.observe({ id })).resolves.toBe(observed)
    await expect(api.cancel({ id })).resolves.toBe(observed)
    expect(wire.status).toHaveBeenCalledTimes(1)
    expect(wire.launch).toHaveBeenCalledWith({ id, request: { prompt: 'wire contract test' } })
    expect(wire.observe).toHaveBeenCalledWith({ id })
    expect(wire.cancel).toHaveBeenCalledWith({ id })
  })

  it('throws the official Remote failure instead of treating it as a value', async () => {
    const remoteFailure = failure()
    const wire: WebUiWire = {
      status: vi.fn(async () => failed<WebUiStatus>(remoteFailure)),
      launch: vi.fn(async () => failed<{ readonly id: string }>(remoteFailure)),
      observe: vi.fn(async () => failed<WebRunRecord>(remoteFailure)),
      cancel: vi.fn(async () => failed<WebRunRecord>(remoteFailure)),
    }
    const api = createWebUiApi(wire)

    await expect(api.status()).rejects.toBe(remoteFailure)
    await expect(api.launch({ id, request: { prompt: 'wire contract test' } })).rejects.toBe(remoteFailure)
    await expect(api.observe({ id })).rejects.toBe(remoteFailure)
    await expect(api.cancel({ id })).rejects.toBe(remoteFailure)
    expect(remoteFailure.code).toBe('gateway/internal')
    expect(remoteFailure.message).toBe('wire failure detail')
  })
})
