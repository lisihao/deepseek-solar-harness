/**
 * Connection plugin browser-half apply: ctx.connection handle mounting, mode
 * selection off the page URL, and the single-consumer stream-loop ownership.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, setBrowserRemoteAccessToken, type ConnectionHandle } from '../src/client/index.ts'
import type { RpcMessage } from '../src/client/api.ts'
import { RpcId } from '../src/client/api.ts'
import { FixtureApiClient } from '../src/client/fixture.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'

type Win = { location?: { hostname: string; search: string; origin?: string } }
type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const originalWebSocket = globalThis.WebSocket
const sockets: FakeWebSocket[] = []

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
    queueMicrotask(() => {
      if (this.readyState !== FakeWebSocket.CONNECTING) return
      this.readyState = FakeWebSocket.OPEN
      this.dispatchEvent(new Event('open'))
    })
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

afterEach(() => {
  setBrowserRemoteAccessToken(undefined)
  delete (globalThis as Win).location
  sockets.length = 0
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
})

async function mount(): Promise<ConnectionHandle> {
  const ctx = new Context()
  await ctx.plugin({ apply, inject: [] })
  const handle = ctx.get('connection') as ConnectionHandle | undefined
  if (handle === undefined) throw new Error('ctx.connection not provided')
  return handle
}

describe('connection client apply', () => {
  it('mounts ctx.connection with the real client when no ?fixture switch is present', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('selects the fixture client under ?fixture (and with no location at all stays real)', async () => {
    ;(globalThis as Win).location = { hostname: '127.0.0.1', search: '?fixture' }
    expect((await mount()).api).toBeInstanceOf(FixtureApiClient)
    delete (globalThis as Win).location
    const handle = await mount()
    expect(handle.api).toBeInstanceOf(WebApiClient)
    expect(handle.isLoopback).toBe(true)
  })

  it('reports non-loopback page authority through the connection handle', async () => {
    ;(globalThis as Win).location = { hostname: '192.0.2.20', search: '' }
    expect((await mount()).isLoopback).toBe(false)
  })

  it('shares the memory-only remote bearer with generic client plugin requests', async () => {
    ;(globalThis as Win).location = { hostname: 'server.example', search: '' }
    setBrowserRemoteAccessToken('surface-token')
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    try {
      const handle = await mount()
      await handle.request('/api/resident-operators', { headers: { 'x-client': 'physical-ui' } })
      expect(fetch).toHaveBeenCalledOnce()
      const init = fetch.mock.calls[0]?.[1]
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer surface-token')
      expect(new Headers(init?.headers).get('x-client')).toBe('physical-ui')
    } finally {
      fetch.mockRestore()
    }
  })

  it('uses snapshot + cursor projection in the Desktop frontend role', async () => {
    ;(globalThis as Win).location = {
      hostname: 'server.example',
      search: '?dsh-deployment-role=frontend',
      origin: 'https://server.example',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    let failNextFetch = false
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (failNextFetch) {
        failNextFetch = false
        throw new Error('temporary network failure')
      }
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string }
      const host = { version: '3.2.0', cwd: '/srv/dsh', attachedSessions: 1, canOpenPath: false }
      const value = request.method === 'describe'
        ? {
          protocol: { major: 1, minor: 2 }, deploymentId: 'deployment-frontend',
          cursor: { deploymentId: 'deployment-frontend', sequence: 7 },
          describedAt: '2026-08-24T00:00:00.000Z', scope: 'cockpit',
          capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
          host,
        }
        : {
          protocol: { major: 1, minor: 2 }, deploymentId: 'deployment-frontend',
          cursor: { deploymentId: 'deployment-frontend', sequence: 7 },
          capturedAt: '2026-08-24T00:00:00.000Z', host,
          sessions: [], workspaces: [], archivedSessionIds: [],
        }
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const handle = await mount()
    expect(handle.transport).toBe('remote-projection')
    const snapshots: number[] = []
    const hostFrames: string[] = []
    const muxFrames: string[] = []
    const states: string[] = []
    const connected = vi.fn()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stopThrowingState = handle.state.subscribe(() => { throw new Error('state listener failed') })
    const stopState = handle.state.subscribe(() => { states.push(handle.state.getSnapshot()) })
    const loop = handle.start({
      onRemoteSnapshot: (_description, snapshot) => { snapshots.push(snapshot.cursor.sequence) },
      onHostEnvelope: (envelope) => { hostFrames.push(envelope.payload.type) },
      onMuxEnvelope: (envelope) => { muxFrames.push(envelope.payload.type) },
      onStateChange: (state) => { states.push(`sink:${state}`) },
      onConnected: connected,
    }, { backoffBaseMs: 0 })
    try {
      await vi.waitFor(() => {
        expect(snapshots).toEqual([7])
        expect(sockets).toHaveLength(1)
        expect(connected).toHaveBeenCalledOnce()
      })
      expect(sockets[0]?.url).toBe(
        'wss://server.example/remote-sync/events?deploymentId=deployment-frontend&since=7',
      )
      sockets[0]?.receive(JSON.stringify({
        type: 'remote-sync/event', sequence: 8, stream: 'host',
        envelope: {
          rpcId: 'rpc-remote-8',
          payload: { type: 'host/session-status', sessionId: 'session-remote', running: true },
        },
      }))
      await vi.waitFor(() => { expect(hostFrames).toEqual(['host/session-status']) })
      sockets[0]?.receive(JSON.stringify({
        type: 'remote-sync/event', sequence: 9, stream: 'mux',
        envelope: {
          rpcId: 'rpc-remote-9',
          payload: { type: 'session/subscribed', sessionId: 'session-remote', lastSeq: 8 },
        },
      }))
      await vi.waitFor(() => { expect(muxFrames).toEqual(['session/subscribed']) })

      failNextFetch = true
      sockets[0]?.close()
      await vi.waitFor(() => {
        expect(states).toContain('reconnecting')
        expect(states).toContain('sink:reconnecting')
        expect(error).toHaveBeenCalledWith(
          '[web-runtime] remote projection sync failed:',
          expect.objectContaining({ message: 'temporary network failure' }),
        )
      })
      expect(fetch.mock.calls.map((call) => {
        const input = call[0]
        return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      })).toEqual(expect.arrayContaining([
        'https://server.example/remote-sync/describe',
        'https://server.example/remote-sync/snapshot',
      ]))
    } finally {
      loop.stop()
      stopState()
      stopThrowingState()
      expect(handle.state.getSnapshot()).toBe('connecting')
      expect(error).toHaveBeenCalledWith(
        '[web-runtime] connection-state listener threw:',
        expect.objectContaining({ message: 'state listener failed' }),
      )
      error.mockRestore()
      fetch.mockRestore()
    }
  })

  it('uses default remote projection backoff when the start config is omitted', async () => {
    ;(globalThis as Win).location = {
      hostname: 'server.example',
      search: '?dsh-deployment-role=frontend',
      origin: 'https://server.example',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string }
      const host = { version: '3.2.1', cwd: '/srv/dsh', attachedSessions: 0, canOpenPath: false }
      const value = request.method === 'describe'
        ? {
          protocol: { major: 1, minor: 2 }, deploymentId: 'deployment-default',
          cursor: { deploymentId: 'deployment-default', sequence: 0 },
          describedAt: '2026-08-24T00:00:00.000Z', scope: 'cockpit',
          capabilities: ['session.read', 'workspace.read', 'event.subscribe'], host,
        }
        : {
          protocol: { major: 1, minor: 2 }, deploymentId: 'deployment-default',
          cursor: { deploymentId: 'deployment-default', sequence: 0 },
          capturedAt: '2026-08-24T00:00:00.000Z', host,
          sessions: [], workspaces: [], archivedSessionIds: [],
        }
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const handle = await mount()
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    try {
      await vi.waitFor(() => { expect(connected).toHaveBeenCalledOnce() })
    } finally {
      loop.stop()
      fetch.mockRestore()
    }
  })

  it('start() hands out one loop, rejects a second consumer, and stop() aborts the streams', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const descriptions: Array<boolean | undefined> = []
    const stopThrowing = handle.hostDescription.subscribe(() => { throw new Error('subscriber bug') })
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    // config omitted: the `config ?? {}` default arm is part of the surface.
    let connected = 0
    const loop = handle.start({ onConnected: () => { connected++ } })
    expect(() => handle.start({})).toThrow(/already owned by another consumer/)
    await vi.waitFor(() => {
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    })
    loop.stop() // teardown must not throw; the fixture streams abort quietly
    expect(handle.hostDescription.getSnapshot()).toBeUndefined()
    expect(descriptions).toEqual([true, undefined])
    expect(connected).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(2)
    stopThrowing()
    stopDescription()
    errorSpy.mockRestore()
  })

  it('does not announce a generation synchronously stopped by a description subscriber', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const owner: { loop?: ReturnType<ConnectionHandle['start']> } = {}
    let sawDescription = false
    const stopDescription = handle.hostDescription.subscribe(() => {
      if (handle.hostDescription.getSnapshot() === undefined) return
      sawDescription = true
      owner.loop?.stop()
    })
    const connected = vi.fn()
    const loop = handle.start({ onConnected: connected })
    owner.loop = loop
    try {
      await vi.waitFor(() => { expect(sawDescription).toBe(true) })
      expect(handle.hostDescription.getSnapshot()).toBeUndefined()
      expect(connected).not.toHaveBeenCalled()
    } finally {
      stopDescription()
      loop.stop()
    }
  })

  it('retracts the host description while reconnecting and republishes the next generation', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const descriptions: Array<boolean | undefined> = []
    const reconnectSnapshots: Array<boolean | undefined> = []
    const stopDescription = handle.hostDescription.subscribe(() => {
      descriptions.push(handle.hostDescription.getSnapshot()?.canOpenPath)
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const loop = handle.start({
      onStateChange: (state) => {
        if (state === 'reconnecting') {
          reconnectSnapshots.push(handle.hostDescription.getSnapshot()?.canOpenPath)
        }
      },
    }, { backoffBaseMs: 10, backoffFactor: 1, backoffMaxMs: 10, streamOpenTimeoutMs: 500 })
    try {
      await vi.waitFor(() => {
        expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
      })
      const timing = (globalThis as Record<string, unknown>).__fxTiming as
        | { breakStreams(): void }
        | undefined
      if (timing === undefined) throw new Error('fixture timing hooks missing')
      timing.breakStreams()

      await vi.waitFor(() => { expect(reconnectSnapshots).toEqual([undefined]) })
      await vi.waitFor(() => { expect(descriptions).toEqual([true, undefined, true]) })
      expect(handle.hostDescription.getSnapshot()?.canOpenPath).toBe(true)
    } finally {
      stopDescription()
      loop.stop()
      warnSpy.mockRestore()
    }
  })

  it('WebApiClient keeps unary calls and respond on globalThis.fetch', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    const handle = await mount()
    const original = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (input: URL | RequestInfo) => {
      seen.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      return Promise.resolve(new Response('{}', { status: 200 }))
    }
    try {
      // Schema rejection is fine — the transport hop is the assertion.
      await (handle.api as WebApiClient).host.describe({}).catch(() => undefined)
      await handle.api.respond({
        type: 'client-response',
        rpcId: RpcId('response-over-http'),
        result: { ok: true, value: {} },
      }).catch(() => undefined)
    } finally {
      globalThis.fetch = original
    }
    expect(seen.some(u => u.includes('/api/host.describe'))).toBe(true)
    expect(seen.some(u => u.includes('/api/respond'))).toBe(true)
  })

  it('opens one WebSocket per downlink, parses frames, and aborts both without using fetch', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const fetch = vi.spyOn(globalThis, 'fetch')
    const client = (await mount()).api as WebApiClient
    const envelopes: RpcMessage[][] = []
    client.subscribeEnvelopes((batch) => { envelopes.push([...batch]) })
    const opened: string[] = []
    const muxAbort = new AbortController()
    const hostAbort = new AbortController()
    const mux = client.events.mux({}, muxAbort.signal, () => { opened.push('mux') })[Symbol.asyncIterator]()
    const host = client.events.host({}, hostAbort.signal, () => { opened.push('host') })[Symbol.asyncIterator]()
    const muxFrame = mux.next()
    const hostFrame = host.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(2) })
    expect(sockets.map(socket => socket.url)).toEqual([
      'ws://localhost:3080/api/events.mux',
      'ws://localhost:3080/api/events.host',
    ])
    await vi.waitFor(() => { expect(opened).toEqual(['mux', 'host']) })

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    sockets[0]!.receive(new Uint8Array([1, 2, 3]))
    sockets[1]!.receive(JSON.stringify({ type: 'server-request', rpcId: 'bad', method: 'host/session-status', payload: {} }))
    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'mux-browser',
      method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-browser', lastSeq: 8 },
    }))
    sockets[1]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'host-browser',
      method: 'host/remote-event',
      payload: { type: 'host/remote-event', event: 'commands/change', args: [] },
    }))
    expect(await muxFrame).toMatchObject({
      value: { rpcId: 'mux-browser', payload: { type: 'session/subscribed', lastSeq: 8 } },
    })
    expect(await hostFrame).toMatchObject({
      value: { rpcId: 'host-browser', payload: { type: 'host/remote-event', event: 'commands/change' } },
    })
    expect(errors).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => { expect(envelopes.flat()).toHaveLength(2) })
    expect(fetch).not.toHaveBeenCalled()

    const muxEnd = mux.next()
    const hostEnd = host.next()
    muxAbort.abort()
    hostAbort.abort()
    await expect(muxEnd).resolves.toMatchObject({ done: true })
    await expect(hostEnd).resolves.toMatchObject({ done: true })
    expect(sockets.every(socket => socket.readyState === FakeWebSocket.CLOSED)).toBe(true)
    errors.mockRestore()
    fetch.mockRestore()
  })

  it('maps an HTTPS page origin to a secure WebSocket URL', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api
    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets[0]?.url).toBe('wss://harness.example/api/events.mux') })
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
  })

  it('closes a WebSocket immediately when its signal was already aborted', async () => {
    ;(globalThis as Win).location = {
      hostname: 'localhost', search: '', origin: 'http://localhost:3080',
    }
    ;(globalThis as WebSocketGlobal).WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const client = (await mount()).api
    const abort = new AbortController()
    abort.abort()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(sockets).toHaveLength(1)
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it('carries RPC calls without requiring secure-context randomUUID', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '' }
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        return bytes.fill(0)
      },
    })
    const handle = await mount()
    const original = globalThis.fetch
    const seen: { url: string; body: unknown }[] = []
    globalThis.fetch = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (typeof init?.body !== 'string') throw new TypeError('expected a JSON string request body')
      const body = JSON.parse(init.body) as { rpcId: string }
      seen.push({ url, body })
      return Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { ref: 'goal-1' } },
      })
    }
    try {
      await expect(handle.rpc.call('/api', 'goals/create', { args: { agentId: 'agent-1' } }))
        .resolves.toEqual({ ok: true, value: { ref: 'goal-1' } })
    } finally {
      globalThis.fetch = original
      vi.unstubAllGlobals()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('http://dsh.internal/api/goals/create')
    expect(seen[0]?.body).toMatchObject({
      type: 'client-request',
      rpcId: '00000000-0000-4000-8000-000000000000',
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    })
  })

  it('validates generic RPC transport failures, correlation, and targets', async () => {
    ;(globalThis as Win).location = {
      hostname: 'harness.example', search: '', origin: 'https://harness.example',
    }
    const handle = await mount()
    const original = globalThis.fetch
    const abort = new AbortController()
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 }))
    try {
      await expect(handle.rpc.call('/api', 'goals/create', {}, abort.signal))
        .rejects.toThrow('HTTP 503')
      expect(globalThis.fetch).toHaveBeenCalledWith(
        new URL('https://harness.example/api/goals/create'),
        expect.objectContaining({ signal: abort.signal }),
      )

      ;(globalThis as Win).location = { hostname: 'localhost', search: '', origin: 'null' }
      globalThis.fetch = vi.fn().mockResolvedValue(Response.json({
        type: 'server-response',
        rpcId: 'different-rpc',
        result: { ok: true, value: null },
      }))
      await expect(handle.rpc.call('/api', 'goals/create', {})).rejects.toThrow('rpcId mismatch')
      const fetch = vi.mocked(globalThis.fetch)
      expect(fetch.mock.calls[0]?.[0]).toEqual(new URL('http://dsh.internal/api/goals/create'))
      expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('signal')
    } finally {
      globalThis.fetch = original
    }

    for (const [channel, endpoint] of [
      ['api2', 'goals/create'],
      ['/api/path', 'goals/create'],
      ['/api', ''],
      ['/api', '.'],
      ['/api', '..'],
      ['/api', 'goals//create'],
      ['/api', 'goals/create?unsafe'],
    ] as const) {
      await expect(handle.rpc.call(channel, endpoint, {})).rejects.toThrow('invalid RPC target')
    }
  })

  it('carries Goal Remotes over the same state as the client-only fixture API', async () => {
    ;(globalThis as Win).location = { hostname: 'localhost', search: '?fixture' }
    const handle = await mount()
    const created = await handle.rpc.call('/api', 'goals/create', {
      args: { agentId: 'fx-alpha', request: { objective: 'fixture remote' } },
    })
    expect(created).toMatchObject({ ok: true, value: { ref: { revision: 1 } } })
    if (!created.ok) throw new Error('fixture Goal create failed')
    const ref = (created.value as { ref: { id: string; revision: number } }).ref
    const edited = await handle.rpc.call('/api', 'goals/edit', {
      args: { agentId: 'fx-alpha', ref, request: { objective: 'edited fixture remote' } },
    })
    expect(edited).toMatchObject({ ok: true, value: { objective: 'edited fixture remote', revision: 2 } })
    const editedRef = { id: ref.id, revision: 2 }
    const paused = await handle.rpc.call('/api', 'goals/pause', {
      args: { agentId: 'fx-alpha', ref: editedRef },
    })
    expect(paused).toMatchObject({ ok: true, value: { phase: 'paused', activation: 'disarmed', revision: 3 } })
    const resumed = await handle.rpc.call('/api', 'goals/resume', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 3 } },
    })
    expect(resumed).toMatchObject({ ok: true, value: { phase: 'active', activation: 'armed', revision: 4 } })
    const completed = await handle.rpc.call('/api', 'goals/complete', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 4 } },
    })
    expect(completed).toMatchObject({ ok: true, value: { phase: 'complete', activation: 'disarmed', revision: 5 } })
    await expect(handle.rpc.call('/api', 'goals/clear', {
      args: { agentId: 'fx-alpha', ref: { id: ref.id, revision: 5 } },
    })).resolves.toEqual({ ok: true, value: { id: ref.id, revision: 6 } })
    await expect(handle.rpc.call('/other', 'goals/create', {})).rejects.toThrow(/channel.*unavailable/)
    await expect(handle.rpc.call('/api', 'unknown/read', { args: { agentId: 'fx-alpha' } }))
      .rejects.toThrow(/endpoint.*unavailable/)
  })
})
