/** Browser-safe Remote Sync contract parsing. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  parseRemoteResidentAcceptedTurn, parseRemoteResidentArtifact, parseRemoteResidentEventPage,
  parseRemoteResidentProviders, parseRemoteResidentTurn, parseRemoteSessionReplicaApplyResult, parseRemoteSessionReplicaDocument,
  parseRemoteSessionReplicaList, parseRemoteSyncCursor, parseRemoteSyncDescription, parseRemoteSyncFrame,
  parseRemoteSyncSnapshot,
} from '../src/remote-sync.ts'
import { setBrowserRemoteAccessToken } from '../src/client/browser-access-token.ts'
import { WebRemoteSyncClient } from '../src/client/remote-sync-client.ts'

const snapshot = {
  protocol: { major: 1, minor: 4 },
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
      protocol: { major: 1, minor: 4 },
      deploymentId: 'deployment-1',
      cursor: { deploymentId: 'deployment-1', sequence: 7 },
      describedAt: '2026-08-23T08:00:00.000Z',
      scope: 'cockpit',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
      host: snapshot.host,
      cluster: { nodeId: 'server-a', term: 4, role: 'leader', leaderId: 'server-a', canSchedule: true },
    }
    expect(parseRemoteSyncDescription(description)).toMatchObject({
      deploymentId: 'deployment-1', scope: 'cockpit',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
      cluster: { nodeId: 'server-a', term: 4, role: 'leader', leaderId: 'server-a', canSchedule: true },
    })
    expect(() => parseRemoteSyncDescription({
      ...description, capabilities: [...description.capabilities, 'task.write'],
    })).toThrow('capability is invalid')
  })

  it('describes the Server with a bearer header and never puts the token in its URL', async () => {
    let seenUrl = ''
    let seenAuthorization: string | null = null
    let seenPayload: unknown
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; payload: unknown }
      seenPayload = request.payload
      seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      seenAuthorization = new Headers(init.headers).get('authorization')
      return new Response(JSON.stringify({
        type: 'server-response', rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            protocol: { major: 1, minor: 4 },
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
    expect(seenPayload).toEqual({ protocol: { major: 1, minor: 4 } })
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
    const payloads = new Map<string, unknown>()
    vi.stubGlobal('fetch', vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const request = JSON.parse(init.body) as { rpcId: string; method: string; payload: unknown }
      methods.push(request.method)
      payloads.set(request.method, request.payload)
      const value = request.method === 'operator.providers' ? [provider]
        : request.method === 'operator.execute' ? accepted
          : request.method === 'operator.inspect' ? turn
            : request.method === 'operator.artifact.read'
              ? { ref: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', json: '{}' }
              : request.method === 'operator.events' ? page
                : { interrupted: true }
      return Response.json({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
    }))
    const client = new WebRemoteSyncClient('https://server.example', 'access')
    await expect(client.operatorProviders()).resolves.toMatchObject([{ operatorId: 'codex', models: [{ model: 'gpt-5.6-luna' }] }])
    await expect(client.operatorExecute({
      commandId: 'command-1', operatorId: 'codex', laneId: 'lane-1', prompt: [],
      nativeToolPolicy: 'disabled',
      workspaceIdentity: {
        version: 1, repository: 'github.com/lisihao/project', commit: 'a'.repeat(40), subdir: 'packages/core',
      },
    })).resolves.toEqual(accepted)
    await expect(client.operatorInspect(accepted.turnId)).resolves.toMatchObject({ state: 'settled', result: { stopReason: 'completed' } })
    await expect(client.operatorArtifact('sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a'))
      .resolves.toEqual({
        ref: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', json: '{}',
      })
    await expect(client.operatorEvents(accepted.sessionId, 0, 100)).resolves.toEqual(page)
    await expect(client.operatorInterrupt(accepted.sessionId, accepted.turnId)).resolves.toBeUndefined()
    expect(methods).toEqual([
      'operator.providers', 'operator.execute', 'operator.inspect', 'operator.artifact.read',
      'operator.events', 'operator.interrupt',
    ])
    expect(payloads.get('operator.execute')).toMatchObject({
      protocol: { major: 1, minor: 4 }, nativeToolPolicy: 'disabled',
    })
    expect(payloads.get('operator.artifact.read')).toMatchObject({ protocol: { major: 1, minor: 4 } })
  })

  it('validates every remote replication and Resident wire variant', () => {
    const header = { version: 0, id: 'session-replica', createdAt: 1 }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    expect(parseRemoteSessionReplicaList([{ header, revision: 'store:1' }])).toHaveLength(1)
    expect(parseRemoteSessionReplicaDocument({ meta: header, events, balanced: true })).toMatchObject({ balanced: true })
    for (const state of ['created', 'advanced', 'unchanged', 'destination-ahead'] as const) {
      expect(parseRemoteSessionReplicaApplyResult({
        sessionId: 'session-replica', state, sourceEventCount: 2, destinationEventCount: 2, appendedEventCount: 0,
      })).toMatchObject({ state })
    }
    expect(parseRemoteResidentAcceptedTurn({
      sessionId: 'resident-session', turnId: 'resident-turn', stateRevision: 0,
    })).toMatchObject({ stateRevision: 0 })

    const provider = {
      operatorId: 'claude-code', product: 'claude-code', displayName: 'Claude Code', description: '',
      tags: ['architecture'], maxConcurrency: 1,
      injectionBoundaries: ['pre-dispatch', 'next-turn', 'checkpoint'],
      available: false, unavailableReason: 'auth required', quotaUnavailableReason: 'unknown quota',
      authentication: 'unqualified', productVersion: '2.1.0', protocolHash: 'schema-2',
      models: [{
        model: 'sonnet', resolvedModel: 'claude-sonnet-4-6', displayName: 'Sonnet', description: '',
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        isDefault: false, supportsAdaptiveThinking: false,
      }],
      quotaPools: [{
        poolId: 'claude-main', displayName: 'Claude', models: ['sonnet'], meter: 'native-subscription',
        primary: { usedPercent: 25, resetsAt: 10, windowDurationMinutes: 300 },
        secondary: { usedPercent: 50 }, observedAt: '2026-08-27T12:00:00.000Z',
      }, {
        poolId: 'claude-secondary', displayName: 'Claude secondary', models: [], meter: 'native-subscription',
        observedAt: '2026-08-27T12:00:00.000Z',
      }],
    }
    expect(parseRemoteResidentProviders([provider])).toMatchObject([{
      authentication: 'unqualified', unavailableReason: 'auth required',
      models: [{ resolvedModel: 'claude-sonnet-4-6' }],
      quotaPools: [
        { primary: { resetsAt: 10, windowDurationMinutes: 300 }, secondary: { usedPercent: 50 } },
        { poolId: 'claude-secondary' },
      ],
    }])

    const baseTurn = {
      commandId: 'command-1', turnId: 'turn-1', sessionId: 'session-1',
      stateRevision: 1, updatedAt: '2026-08-27T12:00:00.000Z',
    }
    for (const state of ['accepted', 'running', 'settled', 'indeterminate'] as const) {
      expect(parseRemoteResidentTurn({ ...baseTurn, state })).toMatchObject({ state })
    }
    for (const stopReason of ['completed', 'aborted', 'error', 'max-tokens', 'refusal'] as const) {
      expect(parseRemoteResidentTurn({
        ...baseTurn, state: 'settled', stopReason, taskLabel: 'task', nativeTurnId: 'native-turn',
        resultRef: 'sha256:outer',
        result: { output: [], stopReason, resultRef: 'sha256:inner' },
        error: { code: 'PRODUCT_ERROR', message: 'stopped' },
      })).toMatchObject({ stopReason, result: { stopReason }, error: { code: 'PRODUCT_ERROR' } })
    }
    expect(parseRemoteResidentEventPage({
      events: [{
        sequence: 1, sessionId: 'session-1', type: 'turn.progress',
        time: '2026-08-27T12:00:00.000Z', data: { phase: 'running' },
      }],
      nextSequence: 1,
    })).toMatchObject({ events: [{ sequence: 1 }], nextSequence: 1 })
  })

  it('rejects malformed remote replication and Resident wire payloads', () => {
    const header = { version: 0, id: 'session-replica', createdAt: 1 }
    expect(() => parseRemoteSessionReplicaList({})).toThrow('must be an array')
    expect(() => parseRemoteSessionReplicaList([{ header: { ...header, id: '' }, revision: 'store:1' }]))
      .toThrow('must be a non-empty string')
    expect(() => parseRemoteSessionReplicaDocument({ meta: header, events: {}, balanced: true }))
      .toThrow('events must be an array')
    expect(() => parseRemoteSessionReplicaDocument({ meta: header, events: [], balanced: 'yes' }))
      .toThrow('balanced must be a boolean')
    expect(() => parseRemoteSessionReplicaApplyResult({
      sessionId: 'session-replica', state: 'merged', sourceEventCount: 0, destinationEventCount: 0, appendedEventCount: 0,
    })).toThrow('state is invalid')

    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: '', tags: [],
      maxConcurrency: 1, injectionBoundaries: ['pre-dispatch'], available: true,
      authentication: 'native-subscription', productVersion: '1', protocolHash: 'schema', models: [{
        model: 'sol', displayName: 'Sol', description: '', supportedEfforts: ['medium'],
        defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true,
      }],
    }
    expect(() => parseRemoteResidentProviders({})).toThrow('must be an array')
    expect(() => parseRemoteResidentProviders([{ ...provider, authentication: 'api-key' }]))
      .toThrow('authentication is invalid')
    expect(() => parseRemoteResidentProviders([{ ...provider, injectionBoundaries: ['live'] }]))
      .toThrow('invalid boundary')
    expect(() => parseRemoteResidentProviders([{ ...provider, description: 1 }]))
      .toThrow('must be a string')
    expect(() => parseRemoteResidentProviders([{ ...provider, available: 'yes' }]))
      .toThrow('must be a boolean')
    expect(() => parseRemoteResidentProviders([{
      ...provider, models: [{ ...provider.models[0], supportedEfforts: ['impossible'] }],
    }])).toThrow('is invalid')
    expect(() => parseRemoteResidentProviders([{
      ...provider, quotaPools: [{
        poolId: 'pool', displayName: 'Pool', models: [], meter: 'api',
        observedAt: '2026-08-27T12:00:00.000Z',
      }],
    }])).toThrow('meter is invalid')
    for (const usedPercent of ['25', Number.NaN, -1, 101]) {
      expect(() => parseRemoteResidentProviders([{
        ...provider, quotaPools: [{
          poolId: 'pool', displayName: 'Pool', models: [], meter: 'native-subscription',
          primary: { usedPercent }, observedAt: '2026-08-27T12:00:00.000Z',
        }],
      }])).toThrow('between 0 and 100')
    }

    const baseTurn = {
      commandId: 'command-1', turnId: 'turn-1', sessionId: 'session-1', state: 'running',
      stateRevision: 1, updatedAt: '2026-08-27T12:00:00.000Z',
    }
    expect(() => parseRemoteResidentTurn({ ...baseTurn, state: 'queued' })).toThrow('state is invalid')
    expect(() => parseRemoteResidentTurn({ ...baseTurn, stopReason: 'unknown' })).toThrow('stopReason is invalid')
    expect(() => parseRemoteResidentTurn({ ...baseTurn, result: { output: {}, stopReason: 'completed' } }))
      .toThrow('result.output must be an array')
    expect(() => parseRemoteResidentTurn({
      ...baseTurn, result: { output: [], stopReason: 'unknown' },
    })).toThrow('result.stopReason is invalid')
    expect(() => parseRemoteResidentEventPage({ events: {}, nextSequence: 0 })).toThrow('must be an array')
    expect(parseRemoteResidentArtifact({
      ref: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', json: '{}',
    })).toMatchObject({ json: '{}' })
    expect(() => parseRemoteResidentArtifact({ ref: 'sha256:bad', json: '{}' })).toThrow('ref is invalid')
  })

  it('accepts a complete snapshot and rejects protocol or deployment mismatch', () => {
    expect(parseRemoteSyncSnapshot(snapshot)).toMatchObject({
      deploymentId: 'deployment-1', cursor: { sequence: 7 },
      sessions: [{ sessionId: 'session-1' }],
    })
    expect(() => parseRemoteSyncSnapshot({
      ...snapshot, protocol: { major: 2, minor: 0 },
    })).toThrow('protocol mismatch')
    expect(parseRemoteSyncSnapshot({ ...snapshot, protocol: { major: 1, minor: 3 } }).protocol)
      .toEqual({ major: 1, minor: 3 })
    expect(() => parseRemoteSyncSnapshot({
      ...snapshot, cursor: { deploymentId: 'deployment-2', sequence: 7 },
    })).toThrow('another deployment')
  })

  it('rejects malformed descriptions, cursors, snapshots, and scalar fields', () => {
    const description = {
      protocol: { major: 1, minor: 4 }, deploymentId: 'deployment-1',
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
    expect(() => parseRemoteSyncDescription({
      ...description, cluster: { nodeId: 'server-a', term: 1, role: 'primary', canSchedule: true },
    })).toThrow('cluster role is invalid')
    expect(() => parseRemoteSyncDescription({
      ...description, cluster: { nodeId: 'server-a', term: -1, role: 'follower', canSchedule: false },
    })).toThrow('non-negative safe integer')
    expect(parseRemoteSyncDescription({
      ...description, cluster: { nodeId: 'server-a', term: 1, role: 'follower', canSchedule: false },
    }).cluster).toEqual({ nodeId: 'server-a', term: 1, role: 'follower', canSchedule: false })

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
