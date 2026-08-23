/** Frontend reconnect/resume and explicit-resync behavior. */

import { describe, expect, it } from 'vitest'
import { RemoteSyncController } from '../src/client/remote-sync-controller.ts'
import type { RemoteSyncClient } from '../src/client/remote-sync-client.ts'
import type {
  RemoteSyncCursor, RemoteSyncDescription, RemoteSyncEvent, RemoteSyncFrame, RemoteSyncSnapshot,
} from '../src/remote-sync.ts'

const host = { version: '3.1.3', cwd: '/srv/dsh', attachedSessions: 0, canOpenPath: false }

function description(sequence: number): RemoteSyncDescription {
  return {
    protocol: { major: 1, minor: 1 }, deploymentId: 'deployment-1',
    cursor: { deploymentId: 'deployment-1', sequence },
    describedAt: '2026-08-23T08:00:00.000Z', scope: 'cockpit',
    capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'], host,
  }
}

function snapshot(sequence: number): RemoteSyncSnapshot {
  return {
    protocol: { major: 1, minor: 1 }, deploymentId: 'deployment-1',
    cursor: { deploymentId: 'deployment-1', sequence },
    capturedAt: '2026-08-23T08:00:00.000Z', host,
    sessions: [], workspaces: [], archivedSessionIds: [],
  }
}

function event(sequence: number): RemoteSyncEvent {
  return {
    type: 'remote-sync/event', sequence, stream: 'host',
    envelope: {
      rpcId: `rpc-${String(sequence)}` as never,
      payload: { type: 'host/session-status', sessionId: 'session-1' as never, running: true },
    },
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

describe('RemoteSyncController', () => {
  it('reconnects from the latest cursor without repeating the snapshot', async () => {
    let snapshots = 0
    let subscriptions = 0
    const requested: RemoteSyncCursor[] = []
    const client: RemoteSyncClient = {
      describe: async () => description(subscriptions === 0 ? 1 : 2),
      snapshot: async () => { snapshots += 1; return snapshot(0) },
      events: (cursor, signal, onOpen) => (async function * (): AsyncGenerator<RemoteSyncFrame> {
        requested.push(cursor)
        subscriptions += 1
        onOpen?.()
        if (subscriptions === 1) {
          yield event(1)
          return
        }
        yield event(2)
        await waitForAbort(signal)
      })(),
    }
    const applied: number[] = []
    const controller = new RemoteSyncController(client, {
      replace: () => {},
      apply: (value) => {
        applied.push(value.sequence)
        if (value.sequence === 2) handle.stop()
      },
    }, { retryDelayMs: 0 })
    const handle = controller.start()
    await handle.done
    expect(snapshots).toBe(1)
    expect(requested).toEqual([
      { deploymentId: 'deployment-1', sequence: 0 },
      { deploymentId: 'deployment-1', sequence: 1 },
    ])
    expect(applied).toEqual([1, 2])
  })

  it('replaces the projection only after an explicit resync instruction', async () => {
    let snapshotCalls = 0
    let subscriptionCalls = 0
    let replacements = 0
    const client: RemoteSyncClient = {
      describe: async () => description(snapshotCalls === 0 ? 0 : 5),
      snapshot: async () => snapshot(snapshotCalls++ === 0 ? 0 : 5),
      events: (_cursor, signal, onOpen) => (async function * (): AsyncGenerator<RemoteSyncFrame> {
        subscriptionCalls += 1
        onOpen?.()
        if (subscriptionCalls === 1) {
          yield {
            type: 'remote-sync/resync-required', deploymentId: 'deployment-1',
            earliestSequence: 5, latestSequence: 5, reason: 'cursor-expired',
          }
          return
        }
        handle.stop()
        await waitForAbort(signal)
      })(),
    }
    const controller = new RemoteSyncController(client, {
      replace: () => { replacements += 1 },
      apply: () => {},
    }, { retryDelayMs: 0 })
    const handle = controller.start()
    await handle.done
    expect(snapshotCalls).toBe(2)
    expect(replacements).toBe(2)
  })
})
