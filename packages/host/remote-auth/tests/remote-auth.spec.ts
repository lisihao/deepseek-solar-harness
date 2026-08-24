/** Device pairing and durable refresh credential lifecycle. */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteCommandReceiptStore } from '../src/command-receipts.ts'
import RemoteAuthService, { RemoteAuthError } from '../src/index.ts'

const fibers: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  vi.useRealTimers()
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

async function start(home: string, config: { pairingTtlMs?: number; accessTtlMs?: number; maxDevices?: number } = {}) {
  const ctx = new Context()
  const fiber = ctx.plugin(RemoteAuthService, { dshHome: home, ...config })
  await fiber.await()
  fibers.push(fiber)
  return ctx.remoteAuth
}

function authDirectory(home: string): string {
  const directory = join(home, 'remote-auth', 'v1')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

function writePrivateJson(filename: string, value: unknown): void {
  writeFileSync(filename, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(filename, 0o600)
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

  it('validates device labels, pairing expiry, roster projection, and idempotent revocation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T08:00:00.000Z'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-validation-'))
    const auth = await start(home, { pairingTtlMs: 10, accessTtlMs: 20, maxDevices: 3 })
    const invalid = auth.issuePairing('cockpit')
    await expect(auth.redeemPairing(invalid.code, '   ')).rejects.toMatchObject({ code: 'PAIRING_INVALID' })
    await expect(auth.redeemPairing(invalid.code, 'x'.repeat(101))).rejects.toMatchObject({ code: 'PAIRING_INVALID' })

    const expired = auth.issuePairing('admin')
    vi.advanceTimersByTime(11)
    await expect(auth.redeemPairing(expired.code, 'Admin')).rejects.toMatchObject({ code: 'PAIRING_EXPIRED' })
    const activePairing = auth.issuePairing('admin')
    const active = await auth.redeemPairing(activePairing.code, '  Admin cockpit  ')
    const secondPairing = auth.issuePairing('pocket')
    const second = await auth.redeemPairing(secondPairing.code, 'Phone')
    const secondAccess = auth.exchange(second.credential)
    auth.issuePairing('cockpit')
    expect(auth.authenticate('unknown-token')).toBeUndefined()
    expect(auth.listDevices()).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: active.deviceId, deviceName: 'Admin cockpit', scope: 'admin' }),
      expect.objectContaining({ deviceId: second.deviceId, scope: 'pocket' }),
    ]))
    await expect(auth.revoke('missing-device')).rejects.toMatchObject({ code: 'DEVICE_NOT_FOUND' })
    await auth.revoke(active.deviceId)
    await auth.revoke(active.deviceId)
    expect(auth.authenticate(secondAccess.accessToken)).toMatchObject({ deviceId: second.deviceId })
    expect(auth.listDevices().find(device => device.deviceId === active.deviceId)?.revokedAt).toBeDefined()
  })

  it('rejects an access session whose durable device disappeared', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-missing-device-'))
    const auth = await start(home)
    const pairing = auth.issuePairing('cockpit')
    const credential = await auth.redeemPairing(pairing.code, 'Cockpit')
    const access = auth.exchange(credential.credential)
    const devices = (auth as unknown as { devices: Map<string, unknown> }).devices
    devices.delete(credential.deviceId)
    expect(auth.authenticate(access.accessToken)).toBeUndefined()
  })

  it('applies constructor defaults even outside the Cordis config normalizer', () => {
    expect(() => new RemoteAuthService(new Context())).not.toThrow()
  })

  it('fences an explicitly indeterminate command and continues after rejected receipt operations', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-indeterminate-'))
    const auth = await start(home)
    const hash = 'd'.repeat(64)
    await expect(auth.settleCommand('device', 'missing', hash, { status: 200, body: 'nope' }))
      .rejects.toThrow('is unavailable')
    await expect(auth.beginCommand('device', 'command', hash)).resolves.toEqual({ kind: 'accepted' })
    await auth.markCommandIndeterminate('device', 'command', hash)
    await auth.markCommandIndeterminate('device', 'command', hash)
    await expect(auth.beginCommand('device', 'command', hash)).resolves.toEqual({ kind: 'indeterminate' })
    await expect(auth.settleCommand('device', 'command', hash, { status: 200, body: 'late' }))
      .rejects.toThrow('cannot settle from indeterminate')
    await expect(auth.beginCommand('device', 'after-error', 'e'.repeat(64))).resolves.toEqual({ kind: 'accepted' })
  })

  it('expires stale pairing and access records during the next public operation', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T08:00:00.000Z'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-sweep-'))
    const auth = await start(home, { pairingTtlMs: 5, accessTtlMs: 5 })
    const pairing = auth.issuePairing('cockpit')
    const credential = await auth.redeemPairing(pairing.code, 'Cockpit')
    const stalePairing = auth.issuePairing('pocket')
    const access = auth.exchange(credential.credential)
    vi.advanceTimersByTime(6)
    auth.issuePairing('admin')
    expect(auth.authenticate(access.accessToken)).toBeUndefined()
    await expect(auth.redeemPairing(stalePairing.code, 'Stale')).rejects.toMatchObject({ code: 'PAIRING_INVALID' })
  })

  it('rejects registries with unsafe permissions', async () => {
    if (process.platform === 'win32') return
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-mode-'))
    const filename = join(authDirectory(home), 'devices.json')
    writePrivateJson(filename, { version: 1, devices: [] })
    chmodSync(filename, 0o644)
    await expect(start(home)).rejects.toThrow('must be owner-only')
  })

  it.each([
    null,
    [],
    {},
    { version: 2, devices: [] },
    { version: 1, devices: 'invalid' },
    { version: 1, devices: [null] },
    { version: 1, devices: [[]] },
    { version: 1, devices: [{}] },
    { version: 1, devices: [{ deviceId: '', deviceName: 'x', scope: 'cockpit', credentialHash: 'a'.repeat(64), createdAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, devices: [{ deviceId: 'id', deviceName: '', scope: 'cockpit', credentialHash: 'a'.repeat(64), createdAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, devices: [{ deviceId: 'id', deviceName: 'x', scope: 'invalid', credentialHash: 'a'.repeat(64), createdAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, devices: [{ deviceId: 'id', deviceName: 'x', scope: 'cockpit', credentialHash: 'bad', createdAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, devices: [{ deviceId: 'id', deviceName: 'x', scope: 'pocket', credentialHash: 'a'.repeat(64), createdAt: 'invalid' }] },
    { version: 1, devices: [{ deviceId: 'id', deviceName: 'x', scope: 'admin', credentialHash: 'a'.repeat(64), createdAt: '2026-08-23T00:00:00Z', revokedAt: 1 }] },
    { version: 1, devices: [{ deviceId: 'id', deviceName: 'x', scope: 'admin', credentialHash: 'a'.repeat(64), createdAt: '2026-08-23T00:00:00Z', revokedAt: 'invalid' }] },
  ])('rejects malformed device registry %#', async (document) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-remote-auth-document-'))
    writePrivateJson(join(authDirectory(home), 'devices.json'), document)
    await expect(start(home)).rejects.toThrow('invalid device registry')
  })
})

describe('RemoteCommandReceiptStore', () => {
  it('loads settled/indeterminate receipts, recovers accepted work, and repairs the file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-command-load-'))
    const filename = join(home, 'receipts.json')
    const acceptedAt = '2026-08-23T00:00:00.000Z'
    writePrivateJson(filename, {
      version: 1,
      receipts: [
        { deviceId: 'd', commandId: 'accepted', requestHash: 'a'.repeat(64), state: 'accepted', acceptedAt },
        { deviceId: 'd', commandId: 'settled', requestHash: 'b'.repeat(64), state: 'settled', acceptedAt, settledAt: acceptedAt, response: { status: 201, body: 'ok' } },
        { deviceId: 'd', commandId: 'indeterminate', requestHash: 'c'.repeat(64), state: 'indeterminate', acceptedAt },
      ],
    })
    const store = new RemoteCommandReceiptStore(filename)
    await store.init()
    await expect(store.begin('d', 'accepted', 'a'.repeat(64))).resolves.toEqual({ kind: 'indeterminate' })
    await expect(store.begin('d', 'settled', 'b'.repeat(64))).resolves.toEqual({
      kind: 'settled', response: { status: 201, body: 'ok' },
    })
    await expect(store.begin('d', 'indeterminate', 'c'.repeat(64))).resolves.toEqual({ kind: 'indeterminate' })
    expect(readFileSync(filename, 'utf8')).toContain('indeterminate')
    const reloaded = new RemoteCommandReceiptStore(filename)
    await expect(reloaded.init()).resolves.toBeUndefined()
  })

  it('prunes oldest settled receipts and preserves active commands', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    const home = mkdtempSync(join(tmpdir(), 'dsh-command-prune-'))
    const store = new RemoteCommandReceiptStore(join(home, 'receipts.json'), 2)
    await store.init()
    await store.begin('d', 'old', 'a'.repeat(64))
    await store.settle('d', 'old', 'a'.repeat(64), { status: 200, contentType: 'text/plain', body: 'old' })
    vi.advanceTimersByTime(1)
    await store.begin('d', 'newer', 'c'.repeat(64))
    await store.settle('d', 'newer', 'c'.repeat(64), { status: 200, body: 'newer' })
    vi.advanceTimersByTime(1)
    await store.begin('d', 'active', 'b'.repeat(64))
    await expect(store.begin('d', 'old', 'a'.repeat(64))).resolves.toEqual({ kind: 'accepted' })
    await expect(store.settle('d', 'active', 'wrong', { status: 200, body: 'wrong' }))
      .rejects.toThrow('is unavailable')
  })

  it('rejects receipt journals with unsafe permissions', async () => {
    if (process.platform === 'win32') return
    const home = mkdtempSync(join(tmpdir(), 'dsh-command-mode-'))
    const filename = join(home, 'receipts.json')
    writePrivateJson(filename, { version: 1, receipts: [] })
    chmodSync(filename, 0o644)
    await expect(new RemoteCommandReceiptStore(filename).init()).rejects.toThrow('must be owner-only')
  })

  it.each([
    null,
    [],
    {},
    { version: 2, receipts: [] },
    { version: 1, receipts: 'invalid' },
    { version: 1, receipts: [null] },
    { version: 1, receipts: [[]] },
    { version: 1, receipts: [{}] },
    { version: 1, receipts: [{ deviceId: '', commandId: 'c', requestHash: 'a'.repeat(64), state: 'accepted', acceptedAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: '', requestHash: 'a'.repeat(64), state: 'accepted', acceptedAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'bad', state: 'accepted', acceptedAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'bad', acceptedAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'accepted', acceptedAt: 'invalid' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'indeterminate', acceptedAt: '2026-08-23T00:00:00Z', settledAt: 1 }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'indeterminate', acceptedAt: '2026-08-23T00:00:00Z', settledAt: 'invalid' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'accepted', acceptedAt: '2026-08-23T00:00:00Z', response: [] }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'settled', acceptedAt: '2026-08-23T00:00:00Z' }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'settled', acceptedAt: '2026-08-23T00:00:00Z', response: { status: 99, body: 'x' } }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'settled', acceptedAt: '2026-08-23T00:00:00Z', response: { status: 600, body: 'x' } }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'settled', acceptedAt: '2026-08-23T00:00:00Z', response: { status: 200, body: 1 } }] },
    { version: 1, receipts: [{ deviceId: 'd', commandId: 'c', requestHash: 'a'.repeat(64), state: 'settled', acceptedAt: '2026-08-23T00:00:00Z', response: { status: 200, body: 'x', contentType: 1 } }] },
  ])('rejects malformed receipt journal %#', async (document) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-command-document-'))
    const filename = join(home, 'receipts.json')
    writePrivateJson(filename, document)
    await expect(new RemoteCommandReceiptStore(filename).init()).rejects.toThrow('invalid command receipt journal')
  })
})
