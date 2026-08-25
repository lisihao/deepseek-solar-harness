/** Desktop deployment role persistence and encrypted remote credential exchange. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopDeploymentStateStore,
  type DesktopDeploymentRequest,
  type DesktopSecretStorage,
} from '../src/deployment-state.ts'

function secretStorage(): DesktopSecretStorage {
  return {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(`sealed:${value}`),
    decryptString: value => value.toString().replace(/^sealed:/, ''),
  }
}

describe('DesktopDeploymentStateStore', () => {
  it('defaults to Server and persists only an encrypted paired Frontend credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-deployment-'))
    const calls: Array<{ url: string; payload: Record<string, unknown> }> = []
    const request: DesktopDeploymentRequest = {
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          rpcId: string; method: string; payload: Record<string, unknown>
        }
        calls.push({ url: String(url), payload: body.payload })
        const value = body.method === 'pairing.redeem'
          ? { deviceId: 'device-1', credential: 'durable-secret', scope: 'cockpit' }
          : {
              deviceId: 'device-1', deviceName: 'MacBook', scope: 'cockpit',
              accessToken: 'short-lived', expiresAt: '2026-08-23T08:15:00.000Z',
            }
        return new Response(JSON.stringify({
          type: 'server-response', rpcId: body.rpcId, result: { ok: true, value },
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      },
    }
    const store = new DesktopDeploymentStateStore(root, secretStorage(), request)
    await expect(store.load()).resolves.toEqual({ version: 2, role: 'server' })
    const state = await store.configureFrontend({
      endpoint: 'https://server.example', pairingCode: '12345678', deviceName: 'MacBook',
    })
    expect(state).toMatchObject({
      version: 2,
      role: 'frontend',
      authMode: 'paired',
      endpoint: 'https://server.example/',
    })
    const persisted = readFileSync(join(root, 'deployment', 'state.json'), 'utf8')
    expect(persisted).not.toContain('durable-secret')
    expect(persisted).toContain(Buffer.from('sealed:durable-secret').toString('base64'))
    await expect(new DesktopDeploymentStateStore(root, secretStorage(), request).load())
      .resolves.toEqual(state)
    await expect(store.exchange(state)).resolves.toMatchObject({ accessToken: 'short-lived' })
    expect(calls).toEqual([
      {
        url: 'https://server.example/remote-auth/pairing.redeem',
        payload: { code: '12345678', deviceName: 'MacBook' },
      },
      {
        url: 'https://server.example/remote-auth/session.exchange',
        payload: { credential: 'durable-secret' },
      },
    ])
  })

  it('uses the authenticated SSH tunnel for loopback Frontends without pairing or Keychain access', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-tunnel-'))
    const fetch = vi.fn(async () => { throw new Error('should not request remote auth') })
    const secrets: DesktopSecretStorage = {
      ...secretStorage(),
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('should not encrypt a tunnel credential') },
    }
    const store = new DesktopDeploymentStateStore(root, secrets, { fetch })
    const state = await store.configureFrontend({
      endpoint: 'http://127.0.0.1:13080',
      pairingCode: '',
      deviceName: 'MacBook',
    })
    expect(state).toEqual({
      version: 2,
      role: 'frontend',
      authMode: 'trusted-tunnel',
      endpoint: 'http://127.0.0.1:13080/',
      deviceName: 'MacBook',
      presentation: 'compatibility',
    })
    expect(fetch).not.toHaveBeenCalled()
    expect(readFileSync(join(root, 'deployment', 'state.json'), 'utf8')).not.toContain('encryptedCredential')
    await expect(new DesktopDeploymentStateStore(root, secrets, { fetch }).load()).resolves.toEqual(state)
  })

  it('migrates a version 1 paired Frontend state in memory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-deployment-v1-'))
    const filename = join(root, 'deployment', 'state.json')
    mkdirSync(join(root, 'deployment'), { recursive: true })
    writeFileSync(filename, JSON.stringify({
      version: 1,
      role: 'frontend',
      endpoint: 'https://server.example/',
      deviceName: 'Legacy MacBook',
      presentation: 'advanced',
      encryptedCredential: 'sealed-value',
    }))
    const store = new DesktopDeploymentStateStore(root, secretStorage(), {
      fetch: async () => { throw new Error('should not request while loading') },
    })
    await expect(store.load()).resolves.toEqual({
      version: 2,
      role: 'frontend',
      authMode: 'paired',
      endpoint: 'https://server.example/',
      deviceName: 'Legacy MacBook',
      presentation: 'advanced',
      encryptedCredential: 'sealed-value',
    })
  })

  it('rejects remote plaintext endpoints and unavailable operating-system encryption', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-deployment-reject-'))
    const request: DesktopDeploymentRequest = {
      fetch: async () => { throw new Error('should not request') },
    }
    const store = new DesktopDeploymentStateStore(root, secretStorage(), request)
    await expect(store.configureFrontend({
      endpoint: 'http://server.example', pairingCode: '12345678', deviceName: 'MacBook',
    })).rejects.toThrow('must use HTTPS')
    const unavailable = new DesktopDeploymentStateStore(root, {
      ...secretStorage(), isEncryptionAvailable: () => false,
    }, request)
    await expect(unavailable.configureFrontend({
      endpoint: 'https://server.example', pairingCode: '12345678', deviceName: 'MacBook',
    })).rejects.toThrow('credential encryption is unavailable')
  })
})
