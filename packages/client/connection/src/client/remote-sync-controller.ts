/** Reconnecting read-only projection loop for the DSH Frontend deployment role. */

import type {
  RemoteSyncDescription,
  RemoteSyncEvent,
  RemoteSyncSnapshot,
} from '../remote-sync.ts'
import type { RemoteSyncClient } from './remote-sync-client.ts'

/** Frontend projection convergence state. */
export type RemoteSyncState = 'connecting' | 'syncing' | 'connected' | 'reconnecting' | 'stopped'

/** Projection mutations and lifecycle notifications owned by the client runtime. */
export interface RemoteSyncSinks {
  replace(description: RemoteSyncDescription, snapshot: RemoteSyncSnapshot): void
  apply(event: RemoteSyncEvent): void
  onStateChange?(state: RemoteSyncState): void
  onError?(error: unknown): void
}

/** Reconnect timing for the remote projection loop. */
export interface RemoteSyncControllerConfig {
  retryDelayMs?: number
}

/** Stop handle and terminal promise for one projection loop. */
export interface RemoteSyncControllerHandle {
  stop(): void
  readonly done: Promise<void>
}

/** One owner of describe → snapshot → cursor replay/live convergence. */
export class RemoteSyncController {
  private started = false

  constructor(
    private readonly client: RemoteSyncClient,
    private readonly sinks: RemoteSyncSinks,
    private readonly config: RemoteSyncControllerConfig = {},
  ) {}

  /**
   * Start the single projection loop owned by this controller.
   * @returns a stop handle and promise settled when the loop exits.
   */
  start(): RemoteSyncControllerHandle {
    if (this.started) throw new Error('remote sync controller already started')
    this.started = true
    const abort = new AbortController()
    const done = this.run(abort.signal).finally(() => {
      this.sinks.onStateChange?.('stopped')
    })
    return { stop: () => { abort.abort() }, done }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let cursor: RemoteSyncSnapshot['cursor'] | undefined
    let reconnecting = false
    while (!signal.aborted) {
      this.sinks.onStateChange?.(reconnecting ? 'reconnecting' : 'connecting')
      let immediateResync = false
      try {
        const description = await this.client.describe(signal)
        if (cursor !== undefined && (
          cursor.deploymentId !== description.deploymentId
          || cursor.sequence > description.cursor.sequence
        )) cursor = undefined
        if (cursor === undefined) {
          this.sinks.onStateChange?.('syncing')
          const snapshot = await this.client.snapshot(signal)
          if (snapshot.deploymentId !== description.deploymentId) {
            immediateResync = true
            continue
          }
          this.sinks.replace(description, snapshot)
          cursor = snapshot.cursor
        }

        for await (const frame of this.client.events(cursor, signal, () => {
          this.sinks.onStateChange?.('connected')
        })) {
          if (frame.type === 'remote-sync/resync-required') {
            cursor = undefined
            immediateResync = true
            break
          }
          if (frame.sequence !== cursor.sequence + 1) {
            throw new Error(
              `remote sync event gap: expected ${String(cursor.sequence + 1)}, received ${String(frame.sequence)}`,
            )
          }
          this.sinks.apply(frame)
          cursor = { deploymentId: cursor.deploymentId, sequence: frame.sequence }
        }
      } catch (error) {
        if (isAborted(signal)) return
        this.sinks.onError?.(error)
      }
      if (isAborted(signal)) return
      reconnecting = true
      if (!immediateResync) await abortableDelay(this.config.retryDelayMs ?? 1_000, signal)
    }
  }
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return Promise.reject(new Error('remote sync retryDelayMs must be a non-negative finite number'))
  }
  if (signal.aborted || milliseconds === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds)
    const onAbort = (): void => { clearTimeout(timer); finish() }
    function finish(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
