/** Device pairing and durable refresh credential lifecycle. */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RemoteAuthService, { RemoteAuthError } from '../src/index.ts'

const fibers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

async function start(home: string, config: { accessTtlMs?: number; maxDevices?: number } = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin(RemoteAuthService, { dshHome: home, ...config })
  await fiber.await()
  fibers.push(fiber)
  return ctx.remoteAuth
}

describe('RemoteAuthService', () => {
  it('redeems once, persists only a hash, survives restart, and revokes every access session', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-'))
    const auth = await start(home)
    const pairing = auth.issuePairing('cockpit')
    const credential = await auth.redeemPairing(pairing.code, 'MacBook cockpit')
    await expect(auth.redeemPairing(pairing.code, 'duplicate')).rejects.toMatchObject({
      code: 'PAIRING_INVALID',
    })

    const session = auth.exchange(credential.credential)
    expect(auth.authenticate(session.accessToken)).toMatchObject({
      deviceId: credential.deviceId, deviceName: 'MacBook cockpit', scope: 'cockpit',
    })
    const document = readFileSync(join(home, 'remote-auth', 'v1', 'devices.json'), 'utf8')
    expect(document).not.toContain(credential.credential)
    expect(document).not.toContain(session.accessToken)

    await fibers.shift()!.dispose()
    const resumed = await start(home)
    const resumedSession = resumed.exchange(credential.credential)
    expect(resumed.authenticate(resumedSession.accessToken)).toMatchObject({ deviceId: credential.deviceId })
    await resumed.revoke(credential.deviceId)
    expect(resumed.authenticate(resumedSession.accessToken)).toBeUndefined()
    expect(() => resumed.exchange(credential.credential)).toThrow(RemoteAuthError)
  })

  it('enforces the active-device bound and expires short-lived access tokens', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T08:00:00.000Z'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-limit-'))
    const auth = await start(home, { accessTtlMs: 1_000, maxDevices: 1 })
    const first = auth.issuePairing('pocket')
    const credential = await auth.redeemPairing(first.code, 'Phone')
    const second = auth.issuePairing('cockpit')
    await expect(auth.redeemPairing(second.code, 'MacBook')).rejects.toMatchObject({
      code: 'DEVICE_LIMIT_REACHED',
    })
    const access = auth.exchange(credential.credential)
    vi.advanceTimersByTime(1_001)
    expect(auth.authenticate(access.accessToken)).toBeUndefined()
  })

  it('settles duplicate remote commands once and fences accepted work after restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-command-'))
    const auth = await start(home)
    const pairing = auth.issuePairing('cockpit')
    const credential = await auth.redeemPairing(pairing.code, 'Cockpit')
    const requestHash = 'a'.repeat(64)
    await expect(auth.beginCommand(credential.deviceId, 'command-1', requestHash))
      .resolves.toEqual({ kind: 'accepted' })
    await expect(auth.beginCommand(credential.deviceId, 'command-1', requestHash))
      .resolves.toEqual({ kind: 'running' })
    await auth.settleCommand(credential.deviceId, 'command-1', requestHash, {
      status: 200,
      contentType: 'application/json',
      body: '{"accepted":true}',
    })
    await expect(auth.beginCommand(credential.deviceId, 'command-1', requestHash))
      .resolves.toEqual({
        kind: 'settled',
        response: { status: 200, contentType: 'application/json', body: '{"accepted":true}' },
      })
    await expect(auth.beginCommand(credential.deviceId, 'command-1', 'b'.repeat(64)))
      .resolves.toEqual({ kind: 'conflict' })

    await auth.beginCommand(credential.deviceId, 'command-crashed', 'c'.repeat(64))
    await fibers.shift()!.dispose()
    const resumed = await start(home)
    await expect(resumed.beginCommand(credential.deviceId, 'command-crashed', 'c'.repeat(64)))
      .resolves.toEqual({ kind: 'indeterminate' })
  })
})
