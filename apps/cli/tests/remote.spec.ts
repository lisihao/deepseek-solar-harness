import { afterEach, describe, expect, it, vi } from 'vitest'
import { runRemoteCommand } from '../src/remote.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('remote CLI', () => {
  it('issues a local pocket pairing code and prints the public Frontend URL', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; payload: unknown }
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      expect(url).toBe('http://127.0.0.1:3080/remote-auth/pairing.issue')
      expect(request.payload).toEqual({ scope: 'pocket' })
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: true, value: { code: '12345678', expiresAt: '2026-08-24T02:00:00.000Z' } },
      }), { status: 200 })
    })
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await expect(runRemoteCommand([
      'pair', '--scope', 'pocket', '--public-url', 'https://mini.example',
    ])).resolves.toBe(0)
    expect(fetch).toHaveBeenCalledOnce()
    expect(write.mock.calls.map(call => String(call[0])).join('')).toContain(
      'Open: https://mini.example/?dsh-deployment-role=frontend',
    )
  })

  it('rejects remote pairing issuance against a non-loopback endpoint', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    await expect(runRemoteCommand([
      'pair', '--endpoint', 'https://mini.example',
    ])).resolves.toBe(1)
  })
})
