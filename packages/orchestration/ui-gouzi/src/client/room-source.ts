/** React-free polling source owned by the plugin's per-session cache. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { GouziRoomSnapshotV1 } from '../contracts.ts'
/** Last read and freshness; stale data never authorizes addressed sends. */
export interface KennelRoomReadState {
  readonly room: GouziRoomSnapshotV1 | null
  readonly loading: boolean
  readonly stale: boolean
  readonly error: string | null
}
/** Subscriber-owned polling using the last Host-confirmed interval, with abort and late-reply fencing. */
export class KennelRoomSource implements ObservableSnapshot<KennelRoomReadState> {
  private snapshot: KennelRoomReadState = { room: null, loading: true, stale: true, error: null }
  private readonly listeners = new Set<() => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private pending: Promise<void> | undefined
  private readonly inflight = new Set<Promise<void>>()
  private epoch = 0
  private disposed = false
  /**
   * @param sessionId - exact session.
   * @param load - abortable reader.
   */
  constructor(
    readonly sessionId: string,
    private readonly load: (signal: AbortSignal) => Promise<GouziRoomSnapshotV1>,
  ) {}
  /** @returns current stable snapshot. */
  getSnapshot = (): KennelRoomReadState => this.snapshot
  /** @param fn - framework subscriber. @returns unsubscribe. */
  subscribe = (fn: () => void): (() => void) => {
    if (this.disposed) throw new Error('Kennel room source disposed')
    const first = this.listeners.size === 0
    this.listeners.add(fn)
    if (first) void this.reload()
    return () => { this.listeners.delete(fn); if (!this.listeners.size) this.stop() }
  }
  private publish(next: KennelRoomReadState): void {
    this.snapshot = next
    for (const fn of [...this.listeners]) {
      try { fn() } catch (error) { console.error('Kennel room subscriber failed:', error) }
    }
  }
  private stop(): void {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined
    this.controller?.abort(); this.controller = undefined; this.pending = undefined
    this.snapshot = { ...this.snapshot, loading: false, stale: true }
  }
  /**
   * Refresh the subscribed room source, sharing an in-flight read when one exists.
   * @returns read completion; failures remain observable in the snapshot.
   */
  reload = (): Promise<void> => {
    if (this.disposed || !this.listeners.size) return Promise.resolve()
    if (this.pending) return this.pending
    clearTimeout(this.timer)
    const epoch = ++this.epoch
    const controller = new AbortController()
    this.controller = controller
    this.publish({ ...this.snapshot, loading: true })
    const pending = Promise.resolve().then(async () => {
      try {
        const room = await this.load(controller.signal)
        if (epoch !== this.epoch || this.disposed) return
        if (room.sessionId !== this.sessionId) throw new Error('Room reply belongs to another session')
        this.publish({ room, loading: false, stale: false, error: null })
      } catch (error) {
        if (epoch !== this.epoch || this.disposed) return
        this.publish({ ...this.snapshot, loading: false, stale: true, error: error instanceof Error ? error.message : String(error) })
      } finally {
        if (epoch === this.epoch && !this.disposed) {
          this.pending = undefined; this.controller = undefined
          const interval = this.snapshot.room?.roomPollIntervalMs
          if (this.listeners.size && interval !== undefined) this.timer = setTimeout(() => { void this.reload() }, interval)
        }
      }
    })
    this.pending = pending
    this.inflight.add(pending)
    void pending.then(() => { this.inflight.delete(pending) })
    return pending
  }
  /** Abort reads, silence notifications and await all read settlement. @returns quiescence. */
  async dispose(): Promise<void> { this.disposed = true; this.listeners.clear(); this.stop(); await Promise.all([...this.inflight]) }
}
