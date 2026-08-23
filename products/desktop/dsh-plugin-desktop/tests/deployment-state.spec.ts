/** Desktop deployment role persistence and encrypted remote credential exchange. */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
  it('defaults to Server and persists only an encrypted Frontend credential', async () => {
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
    await expect(store.load()).resolves.toEqual({ version: 1, role: 'server' })
    const state = await store.configureFrontend({
      endpoint: 'https://server.example', pairingCode: '12345678', deviceName: 'MacBook',
    })
    expect(state).toMatchObject({ role: 'frontend', endpoint: 'https://server.example/' })
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
