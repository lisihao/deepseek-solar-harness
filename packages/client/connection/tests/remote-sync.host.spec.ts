/** Remote Sync host: journal, projections, transport, and source recovery. */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import {
  RpcId, type ApiProxy, type HostFrame, type MuxFrame, type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RemoteSyncHub, RemoteSyncJournal } from '../src/remote-sync-host.ts'

function hostEnvelope(rpcId: string): RpcRequest<HostFrame> {
  return {
    rpcId: RpcId(rpcId),
    payload: { type: 'host/session-status', sessionId: `session-${rpcId}` as never, running: true },
  }
}

function muxEnvelope(rpcId: string): RpcRequest<MuxFrame> {
  return {
    rpcId: RpcId(rpcId),
    payload: { type: 'session/subscribed', sessionId: `session-${rpcId}` as never, lastSeq: 0 },
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

async function * idle<T>(signal: AbortSignal): AsyncGenerator<RpcRequest<T>> {
  await waitForAbort(signal)
}

const hostValue = { version: '3.2.1', cwd: '/srv/dsh', attachedSessions: 0, canOpenPath: false }

function api(overrides: {
  describe?: ApiProxy['host']['describe']
  sessions?: ApiProxy['sessions']['list']
  workspaces?: ApiProxy['workspace']['list']
  mux?: ApiProxy['events']['mux']
  host?: ApiProxy['events']['host']
} = {}): ApiProxy {
  return {
    host: {
      describe: overrides.describe ?? (async request => ({
        rpcId: request.rpcId, result: { ok: true, value: hostValue },
      })),
    },
    sessions: {
      list: overrides.sessions ?? (async request => ({
        rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
      })),
    },
    workspace: {
      list: overrides.workspaces ?? (async request => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [], archivedSessionIds: [] } },
      })),
    },
    events: {
      mux: overrides.mux ?? ((_request, signal) => idle<MuxFrame>(signal)),
      host: overrides.host ?? ((_request, signal) => idle<HostFrame>(signal)),
    },
  } as ApiProxy
}

function failure(rpcId: string, message: string): { rpcId: ReturnType<typeof RpcId>; result: { ok: false; error: { code: 'internal'; message: string; details: {} } } } {
  return { rpcId: RpcId(rpcId), result: { ok: false, error: { code: 'internal', message, details: {} } } }
}

describe('RemoteSyncJournal', () => {
  it('rejects invalid capacities and publishes both source kinds', () => {
    expect(() => new RemoteSyncJournal(0)).toThrow('positive safe integer')
    expect(() => new RemoteSyncJournal(1.5)).toThrow('positive safe integer')
    const journal = new RemoteSyncJournal(2)
    expect(journal.publish('mux', muxEnvelope('mux-1'))).toMatchObject({ stream: 'mux', sequence: 1 })
    expect(journal.publish('host', hostEnvelope('host-1'))).toMatchObject({ stream: 'host', sequence: 2 })
  })

  it('hands off snapshot cursor to replay and then the same live queue without a gap', async () => {
    const journal = new RemoteSyncJournal(8)
    const cursor = journal.cursor()
    journal.publish('host', hostEnvelope('before-subscribe'))

    const abort = new AbortController()
    const stream = journal.subscribe(cursor, abort.signal)[Symbol.asyncIterator]()
    const replay = await stream.next()
    expect(replay.value).toMatchObject({
      type: 'remote-sync/event', sequence: 1, stream: 'host',
      envelope: { rpcId: 'before-subscribe' },
    })

    journal.publish('host', hostEnvelope('after-subscribe'))
    const live = await stream.next()
    expect(live.value).toMatchObject({
      type: 'remote-sync/event', sequence: 2, stream: 'host',
      envelope: { rpcId: 'after-subscribe' },
    })
    abort.abort()
    await expect(stream.next()).resolves.toMatchObject({ done: true })
  })

  it('expires a cursor only after its next required event leaves the bounded journal', async () => {
    const journal = new RemoteSyncJournal(2)
    const initial = journal.cursor()
    journal.publish('host', hostEnvelope('one'))
    journal.publish('host', hostEnvelope('two'))
    journal.publish('host', hostEnvelope('three'))

    const expired = journal.subscribe(initial, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(expired.next()).resolves.toMatchObject({
      value: {
        type: 'remote-sync/resync-required', reason: 'cursor-expired',
        earliestSequence: 2, latestSequence: 3,
      },
    })
    await expect(expired.next()).resolves.toMatchObject({ done: true })

    const stillReplayable = journal.subscribe({
      deploymentId: journal.cursor().deploymentId,
      sequence: 1,
    }, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(stillReplayable.next()).resolves.toMatchObject({ value: { sequence: 2 } })
    await expect(stillReplayable.next()).resolves.toMatchObject({ value: { sequence: 3 } })
    await stillReplayable.return?.(undefined)
  })

  it('fences old deployment and ahead cursors with explicit resync frames', async () => {
    const journal = new RemoteSyncJournal(4)
    const prior = journal.cursor()
    journal.publish('host', hostEnvelope('one'))

    const ahead = journal.subscribe({ ...prior, sequence: 2 }, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(ahead.next()).resolves.toMatchObject({
      value: { type: 'remote-sync/resync-required', reason: 'cursor-ahead' },
    })

    journal.rotateDeployment()
    const stale = journal.subscribe(prior, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(stale.next()).resolves.toMatchObject({
      value: { type: 'remote-sync/resync-required', reason: 'deployment-mismatch' },
    })
    expect(journal.cursor()).toMatchObject({ sequence: 0 })
    expect(journal.cursor().deploymentId).not.toBe(prior.deploymentId)
  })

  it('closes a slow subscriber with resync instead of growing its queue', async () => {
    const journal = new RemoteSyncJournal(1)
    const stream = journal.subscribe(journal.cursor(), new AbortController().signal)[Symbol.asyncIterator]()
    const first = stream.next()
    journal.publish('host', hostEnvelope('one'))
    await expect(first).resolves.toMatchObject({ value: { sequence: 1 } })
    journal.publish('host', hostEnvelope('two'))
    journal.publish('host', hostEnvelope('three'))
    journal.publish('host', hostEnvelope('ignored-while-draining'))
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: 'remote-sync/resync-required', reason: 'cursor-expired' },
    })
    await expect(stream.next()).resolves.toMatchObject({ done: true })
    journal.publish('host', hostEnvelope('after-subscriber-closed'))
  })

  it('wakes waiting subscribers on abort and deployment rotation', async () => {
    const journal = new RemoteSyncJournal(2)
    const abort = new AbortController()
    const waiting = journal.subscribe(journal.cursor(), abort.signal)[Symbol.asyncIterator]()
    const pending = waiting.next()
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })

    const rotating = journal.subscribe(journal.cursor(), new AbortController().signal)[Symbol.asyncIterator]()
    const rotated = rotating.next()
    journal.rotateDeployment()
    await expect(rotated).resolves.toMatchObject({
      value: { type: 'remote-sync/resync-required', reason: 'deployment-mismatch' },
    })
    await expect(rotating.next()).resolves.toMatchObject({ done: true })
  })
})

describe('RemoteSyncHub', () => {
  it('describes pocket/admin capabilities and creates a complete snapshot', async () => {
    const hub = new RemoteSyncHub(api(), 4)
    const signal = new AbortController().signal
    await expect(hub.describe(signal, 'pocket')).resolves.toMatchObject({
      scope: 'pocket', capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'approval.respond'],
    })
    await expect(hub.describe(signal, 'admin')).resolves.toMatchObject({
      scope: 'admin',
      capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
    })
    await expect(hub.snapshot(signal)).resolves.toMatchObject({
      host: hostValue, sessions: [], workspaces: [], archivedSessionIds: [],
    })
    const clients = (hub as unknown as { sockets: { clients: Set<WebSocket> } }).sockets.clients
    const terminate = vi.fn(() => { clients.delete(connected) })
    const connected = { terminate } as unknown as WebSocket
    clients.add(connected)
    await hub.close()
    expect(terminate).toHaveBeenCalled()
    await expect(hub.close()).rejects.toThrow()
  })

  it('advertises and serves prefix-compatible Session replication only when persistence is mounted', async () => {
    const header = { version: 0, id: 'session-replica', createdAt: 1 }
    const events = [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const replicate = vi.fn(async () => ({
      sessionId: 'session-replica', state: 'created' as const,
      sourceEventCount: 2, destinationEventCount: 2, appendedEventCount: 2,
    }))
    const persistence = {
      listSnapshots: async () => [{ header, revision: 'store:1' }],
      inspect: async () => ({ meta: header, events }),
      replicate,
    }
    const hub = new RemoteSyncHub(api(), 4, persistence as never)
    const adminDescription = await hub.describe(new AbortController().signal, 'admin')
    expect(adminDescription.capabilities).toEqual(expect.arrayContaining([
      'session.replicate.read', 'session.replicate.write',
    ]))
    const pocketDescription = await hub.describe(new AbortController().signal, 'pocket')
    expect(pocketDescription.capabilities).not.toContain('session.replicate.read')
    await expect(hub.replicaList()).resolves.toEqual([{ header, revision: 'store:1' }])
    await expect(hub.replicaRead('session-replica')).resolves.toEqual({ meta: header, events, balanced: true })
    await expect(hub.replicaApply({ meta: header, events } as never)).resolves.toMatchObject({
      sessionId: 'session-replica', state: 'created', appendedEventCount: 2,
    })
    expect(replicate).toHaveBeenCalledOnce()
    await hub.close()
  })

  it('never advertises or reads a Session whose current turn is still open', async () => {
    const header = { version: 0, id: 'session-open', createdAt: 1 }
    const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
    const persistence = {
      listSnapshots: async () => [{ header, revision: 'store:open' }],
      inspect: async () => ({ meta: header, events }),
      replicate: vi.fn(),
    }
    const hub = new RemoteSyncHub(api(), 4, persistence as never)
    await expect(hub.replicaList()).resolves.toEqual([])
    await expect(hub.replicaRead('session-open')).rejects.toThrow('open turn')
    await hub.close()
  })

  it('exposes durable Resident admission and observation only when the control seam is mounted', async () => {
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'Code operator',
      tags: ['code'], maxConcurrency: 2, injectionBoundaries: ['pre-dispatch', 'next-turn'],
      available: true, authentication: 'native-subscription', productVersion: '0.200.0', protocolHash: 'schema-1',
      models: [],
    }
    const dispose = vi.fn(async () => undefined)
    const execute = vi.fn(async () => ({
      sessionId: 'resident-session', turnId: 'resident-turn', stateRevision: 2,
      result: new Promise(() => {}), dispose,
    }))
    const inspectTurn = vi.fn(async () => ({
      commandId: 'command-1', sessionId: 'resident-session', turnId: 'resident-turn',
      state: 'running', stateRevision: 2, updatedAt: '2026-08-27T12:00:00.000Z',
    }))
    const readEvents = vi.fn(async () => ({ events: [], nextSequence: 0 }))
    const interrupt = vi.fn(async () => undefined)
    const resident = {
      providers: async () => [provider], execute, inspectTurn, readEvents, interrupt,
    }
    const hub = new RemoteSyncHub(api(), 4, undefined, resident as never)
    const adminDescription = await hub.describe(new AbortController().signal, 'admin')
    expect(adminDescription.capabilities).toEqual(expect.arrayContaining([
      'operator.read', 'operator.execute', 'operator.interrupt',
    ]))
    const pocketDescription = await hub.describe(new AbortController().signal, 'pocket')
    expect(pocketDescription.capabilities).not.toContain('operator.execute')
    await expect(hub.operatorProviders()).resolves.toEqual([provider])
    await expect(hub.operatorExecute({
      commandId: 'command-1', operatorId: 'codex', workspace: '/repo', laneId: 'lane-1', prompt: [],
    } as never)).resolves.toEqual({ sessionId: 'resident-session', turnId: 'resident-turn', stateRevision: 2 })
    expect(dispose).toHaveBeenCalledOnce()
    await expect(hub.operatorInspectTurn('resident-turn')).resolves.toMatchObject({ state: 'running' })
    const signal = new AbortController().signal
    await expect(hub.operatorReadEvents('resident-session', 0, 100, signal)).resolves.toEqual({ events: [], nextSequence: 0 })
    await expect(hub.operatorReadEvents('resident-session', 1, 10)).resolves.toEqual({ events: [], nextSequence: 0 })
    await expect(hub.operatorInterrupt('resident-session', 'resident-turn')).resolves.toBeUndefined()
    expect(readEvents).toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 0, limit: 100, signal }))
    expect(readEvents).toHaveBeenCalledWith(expect.objectContaining({ afterSequence: 1, limit: 10 }))
    expect(interrupt).toHaveBeenCalledOnce()
    await hub.close()
  })

  it('advertises orchestration election control only to admin peers', async () => {
    const clusterStatus = vi.fn(async () => ({
      nodeId: 'a', memberIds: ['a', 'b', 'c'], term: 2, role: 'leader' as const,
      leaderId: 'a', leaseUntil: 10_000, commitIndex: 7, quorum: 2, canSchedule: true,
    }))
    const clusterRequestVote = vi.fn(async () => ({ term: 3, voterId: 'a', granted: true, commitIndex: 7 }))
    const clusterHeartbeat = vi.fn(async () => ({ term: 3, followerId: 'a', accepted: true, commitIndex: 7 }))
    const clusterExportReplica = vi.fn(async () => ({
      version: 1 as const, stateSchemaVersion: 4, commitIndex: 7,
      capturedAt: '2026-08-27T12:00:00.000Z', tables: {}, artifacts: [],
    }))
    const clusterInstallReplica = vi.fn(async () => ({ nodeId: 'a', commitIndex: 7, state: 'applied' as const }))
    const hub = new RemoteSyncHub(api(), 4, undefined, undefined, () => ({
      clusterStatus, clusterRequestVote, clusterHeartbeat, clusterExportReplica, clusterInstallReplica,
    }))
    const adminDescription = await hub.describe(new AbortController().signal, 'admin')
    expect(adminDescription.capabilities).toContain('orchestration.cluster')
    expect(adminDescription.cluster).toMatchObject({
      nodeId: 'a', term: 2, role: 'leader', leaderId: 'a', canSchedule: true,
    })
    const cockpitDescription = await hub.describe(new AbortController().signal, 'cockpit')
    expect(cockpitDescription.capabilities).not.toContain('orchestration.cluster')
    expect(cockpitDescription.cluster).toMatchObject({
      nodeId: 'a', term: 2, role: 'leader', leaderId: 'a', canSchedule: true,
    })
    await expect(hub.clusterStatus()).resolves.toMatchObject({ leaderId: 'a', commitIndex: 7 })
    await expect(hub.clusterRequestVote({ term: 3, candidateId: 'b', commitIndex: 7 }))
      .resolves.toMatchObject({ granted: true })
    await expect(hub.clusterHeartbeat({ term: 3, leaderId: 'b', commitIndex: 7, leaseUntil: 12_000 }))
      .resolves.toMatchObject({ accepted: true })
    await expect(hub.clusterExportReplica()).resolves.toMatchObject({ commitIndex: 7 })
    await expect(hub.clusterInstallReplica({ term: 3, leaderId: 'b', replica: {} as never }))
      .resolves.toMatchObject({ state: 'applied' })
    expect(clusterRequestVote).toHaveBeenCalledOnce()
    expect(clusterHeartbeat).toHaveBeenCalledOnce()
    await hub.close()
  })

  it('omits an unknown cluster leader and fails loud when optional authority seams are absent', async () => {
    const clusterStatus = vi.fn(async () => ({
      nodeId: 'a', memberIds: ['a'], term: 1, role: 'candidate' as const,
      leaseUntil: 0, commitIndex: 0, quorum: 1, canSchedule: false,
    }))
    const hub = new RemoteSyncHub(api(), 4, undefined, undefined, () => ({
      clusterStatus,
      clusterRequestVote: vi.fn(), clusterHeartbeat: vi.fn(), clusterExportReplica: vi.fn(), clusterInstallReplica: vi.fn(),
    }) as never)
    await expect(hub.describe(new AbortController().signal, 'admin')).resolves.toMatchObject({
      cluster: { nodeId: 'a', role: 'candidate', canSchedule: false },
    })
    await hub.close()

    const standalone = new RemoteSyncHub(api(), 4)
    await expect(standalone.replicaList()).rejects.toThrow('replication is unavailable')
    expect(() => standalone.operatorProviders()).toThrow('Resident execution is unavailable')
    expect(() => standalone.clusterStatus()).toThrow('cluster control is unavailable')
    await standalone.close()
  })

  it('retries projections if deployment changes during reads and supports cancellation', async () => {
    let describes = 0
    let snapshots = 0
    const hub = new RemoteSyncHub(api({
      describe: async (request) => {
        if (describes++ === 0) hub.journal.rotateDeployment()
        return { rpcId: request.rpcId, result: { ok: true, value: hostValue } }
      },
      sessions: async (request) => {
        if (snapshots++ === 0) hub.journal.rotateDeployment()
        return { rpcId: request.rpcId, result: { ok: true, value: { items: [] } } }
      },
    }), 4)
    await expect(hub.describe(new AbortController().signal, 'admin')).resolves.toMatchObject({ scope: 'admin' })
    await expect(hub.snapshot(new AbortController().signal)).resolves.toMatchObject({ sessions: [] })
    expect(describes).toBeGreaterThan(1)
    expect(snapshots).toBeGreaterThan(1)

    const cancelled = new AbortController()
    cancelled.abort()
    await expect(hub.describe(cancelled.signal, 'admin')).rejects.toThrow('describe cancelled')
    await expect(hub.snapshot(cancelled.signal)).rejects.toThrow('snapshot cancelled')
    await hub.close()
  })

  it.each([
    ['describe host', api({ describe: async request => failure(String(request.rpcId), 'host down') }), 'host.describe failed'],
    ['snapshot host', api({ describe: async request => failure(String(request.rpcId), 'host down') }), 'host.describe failed'],
    ['snapshot sessions', api({ sessions: async request => failure(String(request.rpcId), 'sessions down') }), 'session.list failed'],
    ['snapshot workspaces', api({ workspaces: async request => failure(String(request.rpcId), 'workspaces down') }), 'workspace.list failed'],
  ])('reports %s failures', async (kind, fakeApi, expected) => {
    const hub = new RemoteSyncHub(fakeApi, 4)
    const operation = kind === 'describe host'
      ? hub.describe(new AbortController().signal, 'admin')
      : hub.snapshot(new AbortController().signal)
    await expect(operation).rejects.toThrow(expected)
    await hub.close()
  })

  it('rejects invalid upgrades and sanitizes non-Error failures', async () => {
    const hub = new RemoteSyncHub(api(), 4)
    const invalid = new PassThrough()
    let response = ''
    invalid.on('data', (chunk) => { response += String(chunk) })
    hub.handleEvents({ url: '/api/remote-sync/events?deploymentId=x&since=NaN' } as never, invalid, Buffer.alloc(0))
    await new Promise(resolve => invalid.once('finish', resolve))
    expect(response).toContain('400 Bad Request')

    const missingUrl = new PassThrough()
    hub.handleEvents({} as never, missingUrl, Buffer.alloc(0))
    await new Promise(resolve => missingUrl.once('finish', resolve))

    const thrown = new PassThrough()
    let stringFailure = ''
    thrown.on('data', (chunk) => { stringFailure += String(chunk) })
    const request = { get url(): string { throw 'bad\r\nrequest' } }
    hub.handleEvents(request as never, thrown, Buffer.alloc(0))
    await new Promise(resolve => thrown.once('finish', resolve))
    expect(stringFailure).toContain('bad  request')
    await hub.close()
  })

  it('accepts a downlink, delivers events, and rejects upstream messages', async () => {
    const hub = new RemoteSyncHub(api(), 4)
    const sent: string[] = []
    const close = vi.fn(function (this: { readyState: number }): void {
      this.readyState = WebSocket.CLOSED
      socket.emit('close')
    })
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send(data: string, callback: (error?: Error) => void): void { sent.push(data); callback() },
      close,
    }) as unknown as WebSocket
    const internals = hub as unknown as {
      sockets: { handleUpgrade: (_request: unknown, _socket: unknown, _head: Buffer, accept: (websocket: WebSocket) => void) => void }
    }
    internals.sockets.handleUpgrade = (_request, _raw, _head, accept) => { accept(socket) }
    const cursor = hub.journal.cursor()
    hub.handleEvents({ url: `/events?deploymentId=${cursor.deploymentId}&since=0` } as never, new PassThrough(), Buffer.alloc(0))
    hub.journal.publish('host', hostEnvelope('delivered'))
    await vi.waitFor(() => { expect(sent).toHaveLength(1) })
    socket.emit('error', new Error('transport failure'))
    socket.emit('message', Buffer.from('upstream'))
    await vi.waitFor(() => { expect(close).toHaveBeenCalledWith(1008, 'downlink only') })
    await hub.close()
  })

  it('contains socket closure and callback failures while pumping', async () => {
    const hub = new RemoteSyncHub(api(), 4)
    const stale = { deploymentId: 'stale', sequence: 0 }
    const pump = (hub as unknown as {
      pumpSocket: (socket: WebSocket, cursor: typeof stale, abort: AbortController) => Promise<void>
    }).pumpSocket.bind(hub)

    const closed = { readyState: WebSocket.CLOSED, close: vi.fn(), send: vi.fn() } as unknown as WebSocket
    await expect(pump(closed, stale, new AbortController())).rejects.toThrow('closed before frame delivery')

    const failingClose = vi.fn()
    const failing = {
      readyState: WebSocket.OPEN,
      close: failingClose,
      send: (_data: string, callback: (error?: Error) => void): void => { callback(new Error('send failed')) },
    } as unknown as WebSocket
    await expect(pump(failing, stale, new AbortController())).rejects.toThrow('send failed')
    expect(failingClose).toHaveBeenCalled()
    await hub.close()
  })

  it('contains a downlink send failure at the accepted socket boundary', async () => {
    const hub = new RemoteSyncHub(api(), 4)
    const close = vi.fn(function (this: { readyState: number }): void {
      this.readyState = WebSocket.CLOSED
      socket.emit('close')
    })
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      send(_data: string, callback: (error?: Error) => void): void {
        callback(new Error('client disconnected'))
      },
      close,
    }) as unknown as WebSocket
    const internals = hub as unknown as {
      sockets: { handleUpgrade: (_request: unknown, _socket: unknown, _head: Buffer, accept: (websocket: WebSocket) => void) => void }
      socketPumps: Set<Promise<void>>
    }
    internals.sockets.handleUpgrade = (_request, _raw, _head, accept) => { accept(socket) }
    const cursor = hub.journal.cursor()

    hub.handleEvents({ url: `/events?deploymentId=${cursor.deploymentId}&since=0` } as never, new PassThrough(), Buffer.alloc(0))
    hub.journal.publish('host', hostEnvelope('disconnect'))

    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledOnce()
      expect(internals.socketPumps).toHaveLength(0)
    })
    await hub.close()
  })

  it('publishes both source streams and contains a source crash', async () => {
    const hub = new RemoteSyncHub(api(), 4)
    const internals = hub as unknown as {
      pumpSource: (stream: 'mux' | 'host', frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>) => Promise<void>
    }
    await internals.pumpSource('mux', (async function * () { yield muxEnvelope('mux-source') })())
    await internals.pumpSource('host', (async function * () { yield hostEnvelope('host-source') })())
    await expect(internals.pumpSource('host', (async function * () { throw new Error('source failed') })())).resolves.toBeUndefined()
    expect(hub.journal.cursor().sequence).toBe(2)
    await hub.close()
  })

  it('rotates the deployment before retrying a completed source generation', async () => {
    const hub = new RemoteSyncHub(api({
      mux: () => (async function * (): AsyncGenerator<RpcRequest<MuxFrame>> {})(),
    }), 4)
    const initial = hub.journal.cursor().deploymentId
    await vi.waitFor(() => {
      expect(hub.journal.cursor().deploymentId).not.toBe(initial)
    }, { timeout: 500 })
    await hub.close()
  })
})
