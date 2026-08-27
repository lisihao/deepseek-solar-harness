/** Desktop deployment role persistence and encrypted remote credential exchange. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  connectFrontendServer,
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
    await expect(store.load()).resolves.toEqual({
      version: 4, role: 'server', servers: [], presentation: 'compatibility',
    })
    const state = await store.configureFrontend({
      endpoint: 'https://server.example', pairingCode: '12345678', deviceName: 'MacBook',
    })
    expect(state).toMatchObject({
      version: 4,
      role: 'frontend',
      servers: [expect.objectContaining({
        authMode: 'paired',
        endpoint: 'https://server.example/',
        label: 'server.example',
      })],
    })
    const persisted = readFileSync(join(root, 'deployment', 'state.json'), 'utf8')
    expect(persisted).not.toContain('durable-secret')
    expect(persisted).toContain(Buffer.from('sealed:durable-secret').toString('base64'))
    await expect(new DesktopDeploymentStateStore(root, secretStorage(), request).load())
      .resolves.toEqual(state)
    await expect(store.exchange(state.servers[0]!)).resolves.toMatchObject({ accessToken: 'short-lived' })
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
      version: 4,
      role: 'frontend',
      activeServerId: expect.any(String),
      servers: [{
        id: expect.any(String),
        label: '127.0.0.1:13080',
        authMode: 'trusted-tunnel',
        endpoint: 'http://127.0.0.1:13080/',
        deviceName: 'MacBook',
      }],
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
      version: 4,
      role: 'frontend',
      activeServerId: 'legacy-default',
      servers: [{
        id: 'legacy-default',
        label: 'server.example',
        authMode: 'paired',
        endpoint: 'https://server.example/',
        deviceName: 'Legacy MacBook',
        encryptedCredential: 'sealed-value',
      }],
      presentation: 'advanced',
    })
  })

  it('keeps multiple Frontend Servers and switches or removes the active selection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-multi-server-'))
    const fetch = vi.fn(async () => { throw new Error('trusted tunnels do not use remote auth') })
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const first = await store.configureFrontend({
      label: 'Primary mini', endpoint: 'http://127.0.0.1:13080', deviceName: 'MacBook',
    })
    const firstId = first.activeServerId
    const second = await store.configureFrontend({
      label: 'Lab mini', endpoint: 'http://127.0.0.1:23080', deviceName: 'MacBook',
    })
    expect(second.servers.map(server => server.label)).toEqual(['Primary mini', 'Lab mini'])
    expect(second.activeServerId).not.toBe(firstId)

    const selected = await store.selectFrontend(firstId)
    expect(selected.activeServerId).toBe(firstId)
    const removed = await store.removeFrontend(firstId)
    expect(removed).toMatchObject({ role: 'frontend', activeServerId: second.activeServerId })
    if (removed.role !== 'frontend') throw new Error('expected remaining Frontend Server')
    expect(removed.servers).toHaveLength(1)
    await expect(store.removeFrontend(removed.activeServerId)).resolves.toEqual({
      version: 4, role: 'server', servers: [], presentation: 'compatibility',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('fails over to the first reachable configured Server and persists the elected ingress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-server-failover-'))
    const probes: string[] = []
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const endpoint = new URL(String(url))
      probes.push(endpoint.origin)
      if (endpoint.port === '13080') return new Response('offline', { status: 503 })
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: body.rpcId,
        result: { ok: true, value: { deploymentId: 'lab' } },
      })
    })
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const first = await store.configureFrontend({
      label: 'Primary mini', endpoint: 'http://127.0.0.1:13080', deviceName: 'MacBook',
    })
    const second = await store.configureFrontend({
      label: 'Lab mini', endpoint: 'http://127.0.0.1:23080', deviceName: 'MacBook',
    })
    const activeFirst = await store.selectFrontend(first.activeServerId)

    await expect(connectFrontendServer(store, activeFirst)).resolves.toMatchObject({
      state: { activeServerId: second.activeServerId },
      server: { id: second.activeServerId, label: 'Lab mini' },
    })
    expect(probes).toEqual(['http://127.0.0.1:13080', 'http://127.0.0.1:23080'])
    await expect(store.load()).resolves.toMatchObject({
      role: 'frontend', activeServerId: second.activeServerId,
    })
  })

  it('reports every failed configured Server without discarding the catalog', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-server-failover-none-'))
    const fetch = vi.fn(async () => new Response('offline', { status: 503 }))
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const first = await store.configureFrontend({
      label: 'Primary mini', endpoint: 'http://127.0.0.1:13080', deviceName: 'MacBook',
    })
    const second = await store.configureFrontend({
      label: 'Lab mini', endpoint: 'http://127.0.0.1:23080', deviceName: 'MacBook',
    })
    const failures: string[] = []

    await expect(connectFrontendServer(store, second, server => { failures.push(server.label) }))
      .rejects.toThrow('no configured Frontend Server is reachable')
    expect(failures).toEqual(['Lab mini', 'Primary mini'])
    await expect(store.load()).resolves.toMatchObject({
      role: 'frontend', activeServerId: second.activeServerId, servers: expect.arrayContaining([
        expect.objectContaining({ id: first.activeServerId }),
        expect.objectContaining({ id: second.activeServerId }),
      ]),
    })
  })

  it('prefers the reachable cluster leader over the persisted follower', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-server-leader-'))
    const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const endpoint = new URL(String(url))
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      const leader = endpoint.port === '23080'
      return Response.json({
        type: 'server-response', rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            deploymentId: leader ? 'leader' : 'follower',
            cluster: {
              nodeId: leader ? 'server-b' : 'server-a', term: 4,
              role: leader ? 'leader' : 'follower', leaderId: 'server-b', canSchedule: leader,
            },
          },
        },
      })
    })
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const first = await store.configureFrontend({
      label: 'Follower mini', endpoint: 'http://127.0.0.1:13080', deviceName: 'MacBook',
    })
    const second = await store.configureFrontend({
      label: 'Leader mini', endpoint: 'http://127.0.0.1:23080', deviceName: 'MacBook',
    })
    const activeFollower = await store.selectFrontend(first.activeServerId)

    await expect(connectFrontendServer(store, activeFollower)).resolves.toMatchObject({
      state: { activeServerId: second.activeServerId },
      server: { label: 'Leader mini' },
    })
  })

  it('keeps the first reachable follower for read-only access when no leader is reachable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-server-follower-only-'))
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: body.rpcId,
        result: {
          ok: true,
          value: {
            deploymentId: 'follower',
            cluster: {
              nodeId: 'server-a', term: 4, role: 'follower', leaderId: 'server-b', canSchedule: false,
            },
          },
        },
      })
    })
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const state = await store.configureFrontend({
      label: 'Follower mini', endpoint: 'http://127.0.0.1:13080', deviceName: 'MacBook',
    })

    await expect(connectFrontendServer(store, state)).resolves.toMatchObject({
      state: { activeServerId: state.activeServerId },
      server: { label: 'Follower mini' },
    })
  })

  it('retains the Server catalog while local Server mode is active and can switch back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-local-server-catalog-'))
    const fetch = vi.fn(async () => { throw new Error('trusted tunnels do not use remote auth') })
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const remote = await store.configureFrontend({
      label: 'Remote mini', endpoint: 'http://127.0.0.1:13080', deviceName: 'MacBook',
      presentation: 'advanced',
    })

    const local = await store.useServer()
    expect(local).toEqual({
      version: 4,
      role: 'server',
      activeServerId: remote.activeServerId,
      servers: remote.servers,
      presentation: 'advanced',
    })
    await expect(new DesktopDeploymentStateStore(root, secretStorage(), { fetch }).load())
      .resolves.toEqual(local)

    const selected = await store.selectFrontend(remote.activeServerId)
    expect(selected).toMatchObject({
      version: 4,
      role: 'frontend',
      activeServerId: remote.activeServerId,
      servers: remote.servers,
      presentation: 'advanced',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('updates an existing paired Server label without redeeming a second credential', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-server-update-'))
    const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return new Response(JSON.stringify({
        rpcId: body.rpcId,
        result: { ok: true, value: { credential: 'durable-secret' } },
      }))
    })
    const store = new DesktopDeploymentStateStore(root, secretStorage(), { fetch })
    const first = await store.configureFrontend({
      label: 'Before', endpoint: 'https://server.example', pairingCode: '12345678', deviceName: 'MacBook',
    })
    const updated = await store.configureFrontend({
      serverId: first.activeServerId,
      label: 'After',
      endpoint: 'https://server.example',
      pairingCode: '',
      deviceName: 'MacBook',
    })
    expect(updated.servers[0]).toMatchObject({ label: 'After', encryptedCredential: expect.any(String) })
    expect(fetch).toHaveBeenCalledOnce()
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
