/** Browser Remote Auth client transport and credential boundaries. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBrowserRemoteAccessToken,
  setBrowserRemoteAccessToken,
  withBrowserRemoteAuthorization,
} from '../src/client/browser-access-token.ts'
import { WebRemoteAuthClient } from '../src/client/remote-auth-client.ts'
import {
  parseRemoteAccessSession,
  parseRemoteDeviceCredential,
  parseRemoteDeviceList,
  parseRemotePairingChallenge,
} from '../src/remote-auth-wire.ts'

afterEach(() => {
  setBrowserRemoteAccessToken(undefined)
  vi.unstubAllGlobals()
})

const expiresAt = '2026-08-23T08:15:00.000Z'

describe('Remote Auth wire parsing', () => {
  it('accepts every fixed scope and optional revocation projection', () => {
    expect(parseRemotePairingChallenge({ code: '12345678', scope: 'cockpit', expiresAt }))
      .toEqual({ code: '12345678', scope: 'cockpit', expiresAt })
    expect(parseRemoteDeviceCredential({ deviceId: 'device-1', credential: 'secret', scope: 'pocket' }))
      .toEqual({ deviceId: 'device-1', credential: 'secret', scope: 'pocket' })
    expect(parseRemoteAccessSession({
      deviceId: 'device-2', deviceName: 'Admin', scope: 'admin', accessToken: 'token', expiresAt,
    })).toMatchObject({ deviceId: 'device-2', scope: 'admin', accessToken: 'token' })
    expect(parseRemoteDeviceList({
      devices: [
        { deviceId: 'device-1', deviceName: 'Phone', scope: 'pocket', createdAt: expiresAt },
        {
          deviceId: 'device-2', deviceName: 'Old', scope: 'cockpit', createdAt: expiresAt,
          revokedAt: expiresAt,
        },
      ],
    })).toEqual([
      { deviceId: 'device-1', deviceName: 'Phone', scope: 'pocket', createdAt: expiresAt },
      {
        deviceId: 'device-2', deviceName: 'Old', scope: 'cockpit', createdAt: expiresAt,
        revokedAt: expiresAt,
      },
    ])
  })

  it('rejects each malformed object, string, scope, date, and device-list boundary', () => {
    for (const value of [undefined, null, []]) {
      expect(() => parseRemotePairingChallenge(value)).toThrow('must be an object')
    }
    expect(() => parseRemoteDeviceCredential(null)).toThrow('must be an object')
    expect(() => parseRemotePairingChallenge({ code: 1, scope: 'cockpit', expiresAt }))
      .toThrow('code must be a non-empty string')
    expect(() => parseRemotePairingChallenge({ code: '', scope: 'cockpit', expiresAt }))
      .toThrow('code must be a non-empty string')
    expect(() => parseRemotePairingChallenge({ code: '12345678', scope: 'operator', expiresAt }))
      .toThrow('scope is invalid')
    expect(() => parseRemotePairingChallenge({ code: '12345678', scope: 'cockpit', expiresAt: 'never' }))
      .toThrow('not an ISO instant')
    expect(() => parseRemoteDeviceList({ devices: {} })).toThrow('devices must be an array')
    expect(() => parseRemoteDeviceList({ devices: [null] })).toThrow('device must be an object')
    expect(() => parseRemoteDeviceList({
      devices: [{
        deviceId: 'device-1', deviceName: 'Phone', scope: 'pocket', createdAt: expiresAt,
        revokedAt: 'never',
      }],
    })).toThrow('revokedAt is not an ISO instant')
  })
})

describe('browser access token', () => {
  it('keeps the bearer in memory and preserves an explicit authorization header', () => {
    const init = { method: 'POST' }
    expect(getBrowserRemoteAccessToken()).toBeUndefined()
    expect(withBrowserRemoteAuthorization(init)).toBe(init)

    setBrowserRemoteAccessToken('short-lived')
    expect(getBrowserRemoteAccessToken()).toBe('short-lived')
    expect(new Headers(withBrowserRemoteAuthorization().headers).get('authorization'))
      .toBe('Bearer short-lived')
    expect(new Headers(withBrowserRemoteAuthorization({
      headers: { authorization: 'Bearer caller-owned' },
    }).headers).get('authorization')).toBe('Bearer caller-owned')
  })
})

describe('WebRemoteAuthClient', () => {
  it('calls pairing, redemption, revocation, and default-page endpoints', async () => {
    vi.stubGlobal('location', { origin: 'https://page.example' })
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(request.method)
      const value = request.method === 'pairing.issue'
        ? { code: '12345678', scope: 'cockpit', expiresAt }
        : request.method === 'pairing.redeem'
          ? { deviceId: 'device-1', credential: 'durable', scope: 'cockpit' }
          : request.method === 'device.revoke'
            ? { revoked: true }
            : { devices: [] }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value },
      })
    }))
    const signal = new AbortController().signal
    const client = new WebRemoteAuthClient(undefined, 'short-lived')
    await expect(client.issuePairing('cockpit', signal)).resolves.toMatchObject({ code: '12345678' })
    await expect(client.redeemPairing('12345678', 'MacBook')).resolves.toMatchObject({ credential: 'durable' })
    await expect(client.listDevices()).resolves.toEqual([])
    await expect(client.revokeDevice('device-1')).resolves.toBeUndefined()
    expect(methods).toEqual(['pairing.issue', 'pairing.redeem', 'device.list', 'device.revoke'])
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toEqual(new URL('https://page.example/remote-auth/pairing.issue'))
    expect(new Headers(vi.mocked(fetch).mock.calls[0]?.[1]?.headers).get('authorization'))
      .toBe('Bearer short-lived')
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toHaveProperty('signal', signal)
  })

  it('uses the internal fallback origin and rejects transport, correlation, remote, and revoke failures', async () => {
    vi.stubGlobal('location', { origin: 'null' })
    const client = new WebRemoteAuthClient()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('offline', { status: 503 })))
    await expect(client.listDevices()).rejects.toThrow('HTTP 503')
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toEqual(new URL('http://dsh.internal/remote-auth/device.list'))
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).not.toHaveProperty('signal')

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      type: 'server-response', rpcId: 'different', result: { ok: true, value: { devices: [] } },
    }))
    await expect(client.listDevices()).rejects.toThrow('rpcId mismatch')

    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'closed', details: {} } },
      })
    })
    await expect(client.listDevices()).rejects.toThrow('internal: closed')

    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { revoked: false } },
      })
    })
    await expect(client.revokeDevice('device-1')).rejects.toThrow('revoke result is invalid')
  })

  it('exchanges the durable credential without placing it or the access token in the URL', async () => {
    const calls: Array<{ url: string; headers: Headers; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string; payload: unknown }
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push({ url, headers: new Headers(init.headers), body: request.payload })
      return new Response(JSON.stringify({
        type: 'server-response',
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            deviceId: 'device-1', deviceName: 'MacBook', scope: 'cockpit',
            accessToken: 'short-lived', expiresAt: '2026-08-23T08:15:00.000Z',
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    const session = await new WebRemoteAuthClient('https://server.example').exchange('durable-secret')
    expect(session).toMatchObject({ deviceId: 'device-1', accessToken: 'short-lived' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      url: 'https://server.example/remote-auth/session.exchange',
      body: { credential: 'durable-secret' },
    })
    expect(calls[0]!.url).not.toContain('durable-secret')
    expect(calls[0]!.headers.get('authorization')).toBeNull()
  })

  it('sends the short-lived token as a bearer header for admin operations', async () => {
    let seenUrl = ''
    let seenAuthorization: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seenAuthorization = new Headers(init.headers).get('authorization')
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { devices: [] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    await expect(new WebRemoteAuthClient('https://server.example', 'short-lived').listDevices())
      .resolves.toEqual([])
    expect(seenAuthorization).toBe('Bearer short-lived')
    expect(seenUrl).not.toContain('short-lived')
  })
})
