/** Browser-safe Remote Sync contract parsing. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseRemoteSyncCursor, parseRemoteSyncDescription, parseRemoteSyncFrame, parseRemoteSyncSnapshot,
} from '../src/remote-sync.ts'
import { setBrowserRemoteAccessToken } from '../src/client/browser-access-token.ts'
import { WebRemoteSyncClient } from '../src/client/remote-sync-client.ts'

const snapshot = {
  protocol: { major: 1, minor: 3 },
  deploymentId: 'deployment-1',
  cursor: { deploymentId: 'deployment-1', sequence: 7 },
  capturedAt: '2026-08-23T08:00:00.000Z',
  host: {
    version: '3.1.3', cwd: '/srv/dsh', attachedSessions: 1, canOpenPath: false,
  },
  sessions: [{
    sessionId: 'session-1', updatedAt: 1, running: true, blank: false, cwd: '/srv/dsh',
  }],
  workspaces: [{
    workspaceId: 'workspace-1', path: '/srv/dsh', title: 'dsh',
    sessionIds: ['session-1'], createdAt: '2026-08-23T07:00:00.000Z',
    updatedAt: '2026-08-23T08:00:00.000Z',
  }],
  archivedSessionIds: [],
}

interface SocketRecord {
  readonly socket: FakeWebSocket
  readonly protocols: string[]
}

const sockets: SocketRecord[] = []

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING

  constructor(url: string | URL, protocols: string[] = []) {
    super()
    this.url = String(url)
    sockets.push({ socket: this, protocols })
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

afterEach(() => {
  sockets.length = 0
  setBrowserRemoteAccessToken(undefined)
  vi.unstubAllGlobals()
})

describe('Remote Sync wire parsing', () => {
  it('accepts an authenticated Server description and rejects unknown capabilities', () => {
    const description = {
      protocol: { major: 1, minor: 3 },
      deploymentId: 'deployment-1',
      cursor: { deploymentId: 'deployment-1', sequence: 7 },
      describedAt: '2026-08-23T08:00:00.000Z',
      scope: 'cockpit',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
      host: snapshot.host,
    }
    expect(parseRemoteSyncDescription(description)).toMatchObject({
      deploymentId: 'deployment-1', scope: 'cockpit',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
    })
    expect(() => parseRemoteSyncDescription({
      ...description, capabilities: [...description.capabilities, 'task.write'],
    })).toThrow('capability is invalid')
  })

  it('describes the Server with a bearer header and never puts the token in its URL', async () => {
    let seenUrl = ''
    let seenAuthorization: string | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seenAuthorization = new Headers(init.headers).get('authorization')
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            protocol: { major: 1, minor: 3 },
            deploymentId: 'deployment-1',
            cursor: { deploymentId: 'deployment-1', sequence: 7 },
            describedAt: '2026-08-23T08:00:00.000Z',
            scope: 'cockpit',
            capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
            host: snapshot.host,
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))

    await expect(new WebRemoteSyncClient('https://server.example', 'short-lived').describe())
      .resolves.toMatchObject({ deploymentId: 'deployment-1', scope: 'cockpit' })
    expect(seenUrl).toBe('https://server.example/remote-sync/describe')
    expect(seenUrl).not.toContain('short-lived')
    expect(seenAuthorization).toBe('Bearer short-lived')
  })

  it('lists, reads, and applies complete Session replicas over the same authenticated channel', async () => {
    const header = { version: 0, id: 'session-replica', createdAt: 1 }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string; payload: unknown }
      methods.push(request.method)
      const value = request.method === 'replica.list'
        ? [{ header, revision: 'store:1' }]
        : request.method === 'replica.read'
          ? { meta: header, events, balanced: true }
          : {
            sessionId: 'session-replica', state: 'created', sourceEventCount: 2,
            destinationEventCount: 2, appendedEventCount: 2,
          }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value },
      })
    }))
    const client = new WebRemoteSyncClient('https://server.example', 'access')
    await expect(client.replicaList()).resolves.toEqual([{ header, revision: 'store:1' }])
    await expect(client.replicaRead('session-replica')).resolves.toMatchObject({ balanced: true, events })
    await expect(client.replicaApply({ meta: header as never, events: events as never })).resolves.toMatchObject({
      state: 'created', appendedEventCount: 2,
    })
    expect(methods).toEqual(['replica.list', 'replica.read', 'replica.apply'])
  })

  it('admits, reattaches, observes, and interrupts a durable remote Resident turn', async () => {
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [{
        model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Fast worker', supportedEfforts: ['medium'],
        defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true,
      }],
    }
    const accepted = { sessionId: 'resident-session', turnId: 'resident-turn', stateRevision: 2 }
    const turn = {
      commandId: 'command-1', sessionId: accepted.sessionId, turnId: accepted.turnId,
      state: 'settled', stateRevision: 3, stopReason: 'completed', updatedAt: '2026-08-27T12:00:00.000Z',
      result: { output: [{ type: 'text', text: 'done' }], stopReason: 'completed' },
    }
    const page = {
      events: [{
        sequence: 1, sessionId: accepted.sessionId, type: 'turn.progress',
        time: '2026-08-27T12:00:00.000Z', data: { phase: 'reasoning' },
      }],
      nextSequence: 1,
    }
    const methods: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string }
      methods.push(request.method)
      const value = request.method === 'operator.providers' ? [provider]
        : request.method === 'operator.execute' ? accepted
          : request.method === 'operator.inspect' ? turn
            : request.method === 'operator.events' ? page
              : { interrupted: true }
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
    }))
    const client = new WebRemoteSyncClient('https://server.example', 'access')
    await expect(client.operatorProviders()).resolves.toMatchObject([{ operatorId: 'codex', models: [{ model: 'gpt-5.6-luna' }] }])
    await expect(client.operatorExecute({
      commandId: 'command-1', operatorId: 'codex', workspace: '/repo', laneId: 'lane-1', prompt: [],
    } as never)).resolves.toEqual(accepted)
    await expect(client.operatorInspect(accepted.turnId)).resolves.toMatchObject({ state: 'settled', result: { stopReason: 'completed' } })
    await expect(client.operatorEvents(accepted.sessionId, 0, 100)).resolves.toEqual(page)
    await expect(client.operatorInterrupt(accepted.sessionId, accepted.turnId)).resolves.toBeUndefined()
    expect(methods).toEqual([
      'operator.providers', 'operator.execute', 'operator.inspect', 'operator.events', 'operator.interrupt',
    ])
  })

  it('accepts a complete snapshot and rejects protocol or deployment mismatch', () => {
    expect(parseRemoteSyncSnapshot(snapshot)).toMatchObject({
      deploymentId: 'deployment-1', cursor: { sequence: 7 },
      sessions: [{ sessionId: 'session-1' }],
    })
    expect(() => parseRemoteSyncSnapshot({
      ...snapshot, protocol: { major: 2, minor: 0 },
    })).toThrow('protocol mismatch')
    expect(() => parseRemoteSyncSnapshot({
      ...snapshot, cursor: { deploymentId: 'deployment-2', sequence: 7 },
    })).toThrow('another deployment')
  })

  it('rejects malformed descriptions, cursors, snapshots, and scalar fields', () => {
    const description = {
      protocol: { major: 1, minor: 3 }, deploymentId: 'deployment-1',
      cursor: { deploymentId: 'deployment-1', sequence: 7 }, describedAt: snapshot.capturedAt,
      scope: 'cockpit', capabilities: ['session.read'], host: snapshot.host,
    }
    expect(() => parseRemoteSyncDescription({
      ...description, cursor: { deploymentId: 'deployment-2', sequence: 7 },
    })).toThrow('another deployment')
    expect(() => parseRemoteSyncDescription({ ...description, capabilities: {} }))
      .toThrow('capabilities must be an array')
    expect(() => parseRemoteSyncDescription({ ...description, scope: 'operator' }))
      .toThrow('scope is invalid')
    expect(() => parseRemoteSyncDescription({ ...description, describedAt: 'never' }))
      .toThrow('not an ISO instant')
    expect(() => parseRemoteSyncDescription({ ...description, protocol: { major: 1, minor: 1 } }))
      .toThrow('protocol mismatch')

    for (const value of [undefined, null, []]) {
      expect(() => parseRemoteSyncCursor(value)).toThrow('must be an object')
    }
    expect(() => parseRemoteSyncCursor({ deploymentId: 1, sequence: 0 }))
      .toThrow('must be a non-empty string')
    expect(() => parseRemoteSyncCursor({ deploymentId: '', sequence: 0 }))
      .toThrow('must be a non-empty string')
    for (const sequence of ['1', Number.MAX_SAFE_INTEGER + 1, -1]) {
      expect(() => parseRemoteSyncCursor({ deploymentId: 'deployment-1', sequence }))
        .toThrow('non-negative safe integer')
    }
    expect(() => parseRemoteSyncSnapshot({ ...snapshot, capturedAt: 'never' }))
      .toThrow('not an ISO instant')
  })

  it('validates nested mux/host envelopes and structured resync frames', () => {
    expect(parseRemoteSyncFrame({
      type: 'remote-sync/event', sequence: 8, stream: 'host',
      envelope: {
        rpcId: 'rpc-1',
        payload: { type: 'host/session-status', sessionId: 'session-1', running: false },
      },
    })).toMatchObject({ sequence: 8, stream: 'host', envelope: { rpcId: 'rpc-1' } })
    expect(parseRemoteSyncFrame({
      type: 'remote-sync/resync-required', deploymentId: 'deployment-1',
      earliestSequence: 3, latestSequence: 10, reason: 'cursor-expired',
    })).toMatchObject({ reason: 'cursor-expired' })
    expect(() => parseRemoteSyncFrame({
      type: 'remote-sync/event', sequence: 0, stream: 'host', envelope: {},
    })).toThrow('must be positive')
    expect(parseRemoteSyncFrame({
      type: 'remote-sync/event', sequence: 9, stream: 'mux',
      envelope: {
        rpcId: 'rpc-2',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 8 },
      },
    })).toMatchObject({ sequence: 9, stream: 'mux' })
    for (const reason of ['deployment-mismatch', 'cursor-ahead'] as const) {
      expect(parseRemoteSyncFrame({
        type: 'remote-sync/resync-required', deploymentId: 'deployment-1',
        earliestSequence: 0, latestSequence: 10, reason,
      })).toMatchObject({ reason })
    }
    expect(() => parseRemoteSyncFrame({
      type: 'remote-sync/resync-required', deploymentId: 'deployment-1',
      earliestSequence: 0, latestSequence: 10, reason: 'unknown',
    })).toThrow('resync reason is invalid')
    expect(() => parseRemoteSyncFrame({ type: 'unknown' })).toThrow('frame type is invalid')
    expect(() => parseRemoteSyncFrame({
      type: 'remote-sync/event', sequence: 1, stream: 'unknown', envelope: { rpcId: 'rpc', payload: {} },
    })).toThrow('stream is invalid')
  })
})

describe('WebRemoteSyncClient failures and WebSocket downlink', () => {
  it('loads snapshots from the current page and rejects transport, correlation, and remote failures', async () => {
    vi.stubGlobal('location', { origin: 'https://page.example' })
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: snapshot },
      })
    }))
    const signal = new AbortController().signal
    await expect(new WebRemoteSyncClient().snapshot(signal)).resolves.toMatchObject({ deploymentId: 'deployment-1' })
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toEqual(new URL('https://page.example/remote-sync/snapshot'))
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toHaveProperty('signal', signal)
    vi.stubGlobal('location', { origin: 'null' })
    await expect(new WebRemoteSyncClient().snapshot()).resolves.toMatchObject({ deploymentId: 'deployment-1' })
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toEqual(new URL('http://dsh.internal/remote-sync/snapshot'))

    const client = new WebRemoteSyncClient('https://server.example')
    vi.mocked(fetch).mockResolvedValueOnce(new Response('offline', { status: 503 }))
    await expect(client.snapshot()).rejects.toThrow('HTTP 503')
    expect(vi.mocked(fetch).mock.calls[2]?.[1]).not.toHaveProperty('signal')

    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      type: 'server-response', rpcId: 'different', result: { ok: true, value: snapshot },
    }))
    await expect(client.snapshot()).rejects.toThrow('rpcId mismatch')

    vi.mocked(fetch).mockImplementationOnce(async (_input, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string }
      return Response.json({
        type: 'server-response', rpcId: request.rpcId,
        result: { ok: false, error: { code: 'internal', message: 'closed', details: {} } },
      })
    })
    await expect(client.snapshot()).rejects.toThrow('internal: closed')
  })

  it('streams valid frames, drops malformed frames, and closes on server end', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    setBrowserRemoteAccessToken('memory-token')
    const opened = vi.fn()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const iterator = new WebRemoteSyncClient('https://server.example')
      .events({ deploymentId: 'deployment-1', sequence: 7 }, new AbortController().signal, opened)
      [Symbol.asyncIterator]()
    const first = iterator.next()
    expect(sockets).toHaveLength(1)
    expect(sockets[0]).toMatchObject({
      protocols: ['dsh-remote-sync-v1', 'dsh-bearer.memory-token'],
    })
    expect(sockets[0]!.socket.url).toBe(
      'wss://server.example/remote-sync/events?deploymentId=deployment-1&since=7',
    )
    sockets[0]!.socket.open()
    expect(opened).toHaveBeenCalledOnce()
    sockets[0]!.socket.receive(new Uint8Array([1]))
    sockets[0]!.socket.receive('{')
    sockets[0]!.socket.receive(JSON.stringify({
      type: 'remote-sync/event', sequence: 8, stream: 'host',
      envelope: {
        rpcId: 'rpc-8',
        payload: { type: 'host/session-status', sessionId: 'session-1', running: true },
      },
    }))
    await expect(first).resolves.toMatchObject({ value: { sequence: 8 } })
    expect(errors).toHaveBeenCalledTimes(2)
    const end = iterator.next()
    sockets[0]!.socket.close()
    await expect(end).resolves.toMatchObject({ done: true })
    errors.mockRestore()
  })

  it('uses an explicit bearer and closes an already-aborted insecure downlink', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket)
    const abort = new AbortController()
    abort.abort()
    const iterator = new WebRemoteSyncClient('http://server.example', 'explicit-token')
      .events({ deploymentId: 'deployment-1', sequence: 0 }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    expect(sockets[0]).toMatchObject({
      protocols: ['dsh-remote-sync-v1', 'dsh-bearer.explicit-token'],
    })
    expect(sockets[0]!.socket.url).toBe(
      'ws://server.example/remote-sync/events?deploymentId=deployment-1&since=0',
    )
    expect(sockets[0]!.socket.readyState).toBe(FakeWebSocket.CLOSED)

    sockets.length = 0
    const noToken = new WebRemoteSyncClient('http://server.example')
      .events({ deploymentId: 'deployment-1', sequence: 0 }, abort.signal)
      [Symbol.asyncIterator]()
    await expect(noToken.next()).resolves.toMatchObject({ done: true })
    expect(sockets[0]?.protocols).toEqual(['dsh-remote-sync-v1'])
  })
})
