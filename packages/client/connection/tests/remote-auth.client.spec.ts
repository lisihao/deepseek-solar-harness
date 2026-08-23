/** Browser Remote Auth client transport and credential boundaries. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebRemoteAuthClient } from '../src/client/remote-auth-client.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('WebRemoteAuthClient', () => {
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
