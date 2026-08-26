/** Host owner of the snapshot + cursor remote projection protocol. */

import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import {
  RpcId,
  type ApiProxy, type HostFrame, type MuxFrame, type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_PROTOCOL,
  parseRemoteSyncCursor,
  type RemoteSyncCursor, type RemoteSyncEvent, type RemoteSyncFrame,
  type RemoteSyncDescription, type RemoteSyncResyncRequired, type RemoteSyncSnapshot,
} from './remote-sync.ts'
import type { RemoteDeviceScope } from './remote-auth-wire.ts'

type SourceStream = 'mux' | 'host'

interface Subscriber {
  readonly queue: RemoteSyncFrame[]
  wake: (() => void) | undefined
  closeAfterDrain: boolean
}

/** Bounded process-generation journal with atomic replay/live subscription. */
export class RemoteSyncJournal {
  private deploymentId = randomUUID()
  private sequence = 0
  private readonly frames: RemoteSyncEvent[] = []
  private readonly subscribers = new Set<Subscriber>()

  /** @param capacity - retained events and maximum per-client unsent backlog. */
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error('remote sync journal capacity must be a positive safe integer')
    }
  }

  /**
   * Current generation watermark, safe to sample before building a snapshot.
   * @returns the current deployment identity and sequence.
   */
  cursor(): RemoteSyncCursor {
    return { deploymentId: this.deploymentId, sequence: this.sequence }
  }

  /**
   * Assign and broadcast one global sequence to a mux envelope.
   * @param stream - mux source discriminator.
   * @param envelope - existing validated mux envelope.
   * @returns the sequenced projection event.
   */
  publish(stream: 'mux', envelope: RpcRequest<MuxFrame>): RemoteSyncEvent
  /**
   * Assign and broadcast one global sequence to a Host envelope.
   * @param stream - Host source discriminator.
   * @param envelope - existing validated Host envelope.
   * @returns the sequenced projection event.
   */
  publish(stream: 'host', envelope: RpcRequest<HostFrame>): RemoteSyncEvent
  publish(stream: SourceStream, envelope: RpcRequest<MuxFrame | HostFrame>): RemoteSyncEvent {
    const sequence = ++this.sequence
    const event = stream === 'mux'
      ? { type: 'remote-sync/event' as const, sequence, stream, envelope: envelope as RpcRequest<MuxFrame> }
      : { type: 'remote-sync/event' as const, sequence, stream, envelope: envelope as RpcRequest<HostFrame> }
    this.frames.push(event)
    if (this.frames.length > this.capacity) this.frames.splice(0, this.frames.length - this.capacity)
    for (const subscriber of this.subscribers) {
      if (subscriber.closeAfterDrain) continue
      if (subscriber.queue.length >= this.capacity) {
        subscriber.queue.splice(0, subscriber.queue.length, this.resync('cursor-expired'))
        subscriber.closeAfterDrain = true
      } else {
        subscriber.queue.push(event)
      }
      subscriber.wake?.()
      subscriber.wake = undefined
    }
    return event
  }

  /**
   * Subscribe atomically from a cursor: replay is enqueued before the caller
   * can await, and new publications append to the same queue.
   * @param cursor - exclusive replay watermark.
   * @param signal - cancellation for the subscription.
   * @returns an async sequence of ordered frames.
   */
  async *subscribe(cursor: RemoteSyncCursor, signal: AbortSignal): AsyncGenerator<RemoteSyncFrame> {
    const subscriber: Subscriber = { queue: [], wake: undefined, closeAfterDrain: false }
    const invalid = this.invalidCursor(cursor)
    if (invalid !== undefined) {
      yield invalid
      return
    }
    subscriber.queue.push(...this.frames.filter(frame => frame.sequence > cursor.sequence))
    this.subscribers.add(subscriber)
    const wakeForAbort = (): void => {
      subscriber.closeAfterDrain = true
      subscriber.wake?.()
      subscriber.wake = undefined
    }
    signal.addEventListener('abort', wakeForAbort, { once: true })
    try {
      while (!signal.aborted) {
        const frame = subscriber.queue.shift()
        if (frame !== undefined) {
          yield frame
          if (subscriber.closeAfterDrain && subscriber.queue.length === 0) return
          continue
        }
        /* v8 ignore next -- closeAfterDrain is paired with either an abort (which exits the loop)
         * or an enqueued resync frame (which returns from the frame branch above). */
        if (subscriber.closeAfterDrain) return
        await new Promise<void>((resolve) => { subscriber.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', wakeForAbort)
      this.subscribers.delete(subscriber)
    }
  }

  /** Invalidate every cursor after a source-stream gap and start a new generation. */
  rotateDeployment(): void {
    const prior = this.resync('deployment-mismatch')
    for (const subscriber of this.subscribers) {
      subscriber.queue.splice(0, subscriber.queue.length, prior)
      subscriber.closeAfterDrain = true
      subscriber.wake?.()
      subscriber.wake = undefined
    }
    this.deploymentId = randomUUID()
    this.sequence = 0
    this.frames.splice(0)
  }

  private invalidCursor(cursor: RemoteSyncCursor): RemoteSyncResyncRequired | undefined {
    if (cursor.deploymentId !== this.deploymentId) return this.resync('deployment-mismatch')
    if (cursor.sequence > this.sequence) return this.resync('cursor-ahead')
    const earliest = this.frames[0]?.sequence ?? this.sequence + 1
    return cursor.sequence < earliest - 1 ? this.resync('cursor-expired') : undefined
  }

  private resync(reason: RemoteSyncResyncRequired['reason']): RemoteSyncResyncRequired {
    return {
      type: 'remote-sync/resync-required',
      deploymentId: this.deploymentId,
      earliestSequence: this.frames[0]?.sequence ?? this.sequence + 1,
      latestSequence: this.sequence,
      reason,
    }
  }
}

/** One process-local owner of the read-only remote projection protocol. */
export class RemoteSyncHub {
  /** Deployment-global event journal shared by snapshot and stream endpoints. */
  readonly journal: RemoteSyncJournal
  private readonly sockets = new WebSocketServer({ noServer: true })
  private readonly stopSources = new AbortController()
  private readonly sourceLoop: Promise<void>
  private readonly socketPumps = new Set<Promise<void>>()

  constructor(private readonly api: ApiProxy, capacity: number) {
    this.journal = new RemoteSyncJournal(capacity)
    this.sourceLoop = this.runSources()
  }

  /**
   * Identify the authenticated Server generation before transferring its projections.
   * @param signal - request cancellation.
   * @param scope - authenticated device scope used to derive capabilities.
   * @returns the stable Server description for the sampled generation.
   */
  async describe(signal: AbortSignal, scope: RemoteDeviceScope): Promise<RemoteSyncDescription> {
    while (!signal.aborted) {
      const cursor = this.journal.cursor()
      const host = await this.api.host.describe({ rpcId: RpcId(randomUUID()), payload: {} })
      if (!host.result.ok) throw new Error(`host.describe failed: ${host.result.error.message}`)
      if (this.journal.cursor().deploymentId !== cursor.deploymentId) continue
      return {
        protocol: REMOTE_SYNC_PROTOCOL,
        deploymentId: cursor.deploymentId,
        cursor,
        describedAt: new Date().toISOString(),
        scope,
        capabilities: scope === 'pocket'
          ? ['session.read', 'workspace.read', 'event.subscribe', 'approval.respond']
          : ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
        host: host.result.value,
      }
    }
    throw new Error('remote sync describe cancelled')
  }

  /**
   * Build a gap-free snapshot: the cursor is sampled before projection reads.
   * @param signal - request cancellation.
   * @returns the Server-owned projection snapshot.
   */
  async snapshot(signal: AbortSignal): Promise<RemoteSyncSnapshot> {
    while (!signal.aborted) {
      const cursor = this.journal.cursor()
      const [host, sessions, workspaces] = await Promise.all([
        this.api.host.describe({ rpcId: RpcId(randomUUID()), payload: {} }),
        this.api.sessions.list({ rpcId: RpcId(randomUUID()), payload: {} }),
        this.api.workspace.list({ rpcId: RpcId(randomUUID()), payload: {} }),
      ])
      if (!host.result.ok) throw new Error(`host.describe failed: ${host.result.error.message}`)
      if (!sessions.result.ok) throw new Error(`session.list failed: ${sessions.result.error.message}`)
      if (!workspaces.result.ok) throw new Error(`workspace.list failed: ${workspaces.result.error.message}`)
      if (this.journal.cursor().deploymentId !== cursor.deploymentId) continue
      return {
        protocol: REMOTE_SYNC_PROTOCOL,
        deploymentId: cursor.deploymentId,
        cursor,
        capturedAt: new Date().toISOString(),
        host: host.result.value,
        sessions: sessions.result.value.items,
        workspaces: workspaces.result.value.items,
        archivedSessionIds: workspaces.result.value.archivedSessionIds,
      }
    }
    throw new Error('remote sync snapshot cancelled')
  }

  /**
   * Accept a downlink-only WebSocket whose query names the snapshot cursor.
   * @param req - authenticated HTTP upgrade request.
   * @param socket - raw upgraded socket.
   * @param head - bytes already read after the HTTP headers.
   */
  handleEvents(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let cursor: RemoteSyncCursor
    try {
      const url = new URL(req.url ?? REMOTE_SYNC_EVENTS_PATH, 'http://dsh.internal')
      cursor = parseRemoteSyncCursor({
        deploymentId: url.searchParams.get('deploymentId'),
        sequence: Number(url.searchParams.get('since')),
      })
    } catch (error) {
      rejectUpgrade(socket, 400, error instanceof Error ? error.message : String(error))
      return
    }
    this.sockets.handleUpgrade(req, socket, head, (websocket) => {
      const abort = new AbortController()
      websocket.once('close', () => { abort.abort() })
      websocket.once('error', () => { abort.abort() })
      websocket.once('message', () => { websocket.close(1008, 'downlink only') })
      const pump = this.pumpSocket(websocket, cursor, abort)
      this.socketPumps.add(pump)
      const release = (): void => { this.socketPumps.delete(pump) }
      // A browser disappearing is a transport outcome, not a Host failure.
      // Consume both settlements here while retaining the original promise in
      // socketPumps so close() can still await every in-flight pump.
      void pump.then(release, release)
    })
  }

  /** Stop sources and sockets without touching the underlying Host authorities. */
  async close(): Promise<void> {
    this.stopSources.abort()
    for (const socket of this.sockets.clients) socket.terminate()
    await Promise.allSettled([this.sourceLoop, ...this.socketPumps])
    await new Promise<void>((resolve, reject) => {
      this.sockets.close((error) => { if (error === undefined) resolve(); else reject(error) })
    })
  }

  private async runSources(): Promise<void> {
    while (!this.stopSources.signal.aborted) {
      const generation = new AbortController()
      const stopGeneration = (): void => { generation.abort() }
      this.stopSources.signal.addEventListener('abort', stopGeneration, { once: true })
      const pumps = [
        this.pumpSource('mux', this.api.events.mux({ rpcId: RpcId(randomUUID()), payload: {} }, generation.signal)),
        this.pumpSource('host', this.api.events.host({ rpcId: RpcId(randomUUID()), payload: {} }, generation.signal)),
      ] as const
      await Promise.race(pumps)
      generation.abort()
      await Promise.allSettled(pumps)
      this.stopSources.signal.removeEventListener('abort', stopGeneration)
      if (signalAborted(this.stopSources.signal)) return
      this.journal.rotateDeployment()
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  private async pumpSource(
    stream: 'mux', frames: AsyncIterable<RpcRequest<MuxFrame>>,
  ): Promise<void>
  private async pumpSource(
    stream: 'host', frames: AsyncIterable<RpcRequest<HostFrame>>,
  ): Promise<void>
  private async pumpSource(
    stream: SourceStream,
    frames: AsyncIterable<RpcRequest<MuxFrame | HostFrame>>,
  ): Promise<void> {
    try {
      for await (const envelope of frames) {
        if (stream === 'mux') this.journal.publish('mux', envelope as RpcRequest<MuxFrame>)
        else this.journal.publish('host', envelope as RpcRequest<HostFrame>)
      }
    } catch {
      // The generation loop rotates deployment identity before resubscribing.
    }
  }

  private async pumpSocket(
    socket: WebSocket,
    cursor: RemoteSyncCursor,
    abort: AbortController,
  ): Promise<void> {
    try {
      for await (const frame of this.journal.subscribe(cursor, abort.signal)) {
        await send(socket, frame)
      }
    } finally {
      abort.abort()
      if (socket.readyState === WebSocket.OPEN) socket.close()
    }
  }
}

function signalAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function send(socket: WebSocket, frame: RemoteSyncFrame): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error('remote sync WebSocket closed before frame delivery'))
      return
    }
    socket.send(JSON.stringify(frame), (error) => { if (error === undefined) resolve(); else reject(error) })
  })
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = message.replace(/[\r\n]/g, ' ')
  socket.end([
    `HTTP/1.1 ${String(status)} Bad Request`,
    'Connection: close',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}
