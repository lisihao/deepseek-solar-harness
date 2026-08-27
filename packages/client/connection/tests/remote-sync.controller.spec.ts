/** Frontend reconnect/resume and explicit-resync behavior. */

import { describe, expect, it, vi } from 'vitest'
import {
  RemoteSyncController, type RemoteSyncProjectionClient,
} from '../src/client/remote-sync-controller.ts'
import type {
  RemoteSyncCursor, RemoteSyncDescription, RemoteSyncEvent, RemoteSyncFrame, RemoteSyncSnapshot,
} from '../src/remote-sync.ts'

const host = { version: '3.1.3', cwd: '/srv/dsh', attachedSessions: 0, canOpenPath: false }

function description(sequence: number, deploymentId = 'deployment-1'): RemoteSyncDescription {
  return {
    protocol: { major: 1, minor: 2 }, deploymentId,
    cursor: { deploymentId, sequence },
    describedAt: '2026-08-23T08:00:00.000Z', scope: 'cockpit',
    capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'], host,
  }
}

function snapshot(sequence: number, deploymentId = 'deployment-1'): RemoteSyncSnapshot {
  return {
    protocol: { major: 1, minor: 2 }, deploymentId,
    cursor: { deploymentId, sequence },
    capturedAt: '2026-08-23T08:00:00.000Z', host,
    sessions: [], workspaces: [], archivedSessionIds: [],
  }
}

function event(sequence: number): Extract<RemoteSyncEvent, { stream: 'host' }> {
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
    const client: RemoteSyncProjectionClient = {
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
    const client: RemoteSyncProjectionClient = {
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

  it('re-snapshots when the described deployment changes or falls behind the local cursor', async () => {
    const descriptions = [
      description(0, 'deployment-1'),
      description(0, 'deployment-2'),
      description(0, 'deployment-2'),
    ]
    const snapshots = [
      snapshot(0, 'deployment-1'),
      snapshot(0, 'deployment-2'),
      snapshot(0, 'deployment-2'),
    ]
    let subscription = 0
    const client: RemoteSyncProjectionClient = {
      describe: async () => descriptions.shift() ?? description(0, 'deployment-2'),
      snapshot: async () => snapshots.shift() ?? snapshot(0, 'deployment-2'),
      events: (_cursor, signal) => (async function * (): AsyncGenerator<RemoteSyncFrame> {
        subscription += 1
        if (subscription === 1) {
          yield event(1)
          return
        }
        if (subscription === 2) {
          yield { ...event(1), envelope: { ...event(1).envelope, rpcId: 'deployment-2-rpc' as never } }
          return
        }
        handle.stop()
        await waitForAbort(signal)
      })(),
    }
    let replacements = 0
    const controller = new RemoteSyncController(client, {
      replace: () => { replacements += 1 },
      apply: () => {},
    }, { retryDelayMs: 0 })
    const handle = controller.start()
    await handle.done
    expect(replacements).toBe(3)
  })

  it('retries immediately when snapshot and description deployments disagree', async () => {
    let snapshots = 0
    const client: RemoteSyncProjectionClient = {
      describe: async () => description(0),
      snapshot: async () => snapshot(0, snapshots++ === 0 ? 'deployment-other' : 'deployment-1'),
      events: (_cursor, signal) => (async function * (): AsyncGenerator<RemoteSyncFrame> {
        handle.stop()
        await waitForAbort(signal)
      })(),
    }
    let replacements = 0
    const controller = new RemoteSyncController(client, {
      replace: () => { replacements += 1 },
      apply: () => {},
    }, { retryDelayMs: 5_000 })
    const handle = controller.start()
    await handle.done
    expect(snapshots).toBe(2)
    expect(replacements).toBe(1)
  })

  it('reports an event gap, waits abortably, publishes states, and rejects a second start', async () => {
    const states: string[] = []
    const errors: unknown[] = []
    let eventCalls = 0
    const client: RemoteSyncProjectionClient = {
      describe: async () => description(1),
      snapshot: async () => snapshot(0),
      events: (_cursor, signal, onOpen) => (async function * (): AsyncGenerator<RemoteSyncFrame> {
        eventCalls += 1
        onOpen?.()
        if (eventCalls === 1) {
          yield event(2)
          return
        }
        await waitForAbort(signal)
      })(),
    }
    const controller = new RemoteSyncController(client, {
      replace: () => {},
      apply: () => {},
      onStateChange: (state) => { states.push(state) },
      onError: (error) => { errors.push(error) },
    }, { retryDelayMs: 10 })
    const handle = controller.start()
    expect(() => controller.start()).toThrow('already started')
    await vi.waitFor(() => {
      expect(errors).toHaveLength(1)
      expect(states).toContain('reconnecting')
    })
    handle.stop()
    await handle.done
    expect(String(errors[0])).toContain('event gap')
    expect(states).toEqual(expect.arrayContaining(['connecting', 'syncing', 'connected', 'reconnecting', 'stopped']))
  })

  it('rejects an invalid retry delay after a recoverable client failure', async () => {
    const client: RemoteSyncProjectionClient = {
      describe: async () => { throw new Error('offline') },
      snapshot: async () => snapshot(0),
      events: () => (async function * (): AsyncGenerator<RemoteSyncFrame> {})(),
    }
    const controller = new RemoteSyncController(client, {
      replace: () => {},
      apply: () => {},
    }, { retryDelayMs: -1 })
    await expect(controller.start().done).rejects.toThrow('non-negative finite number')
  })

  it('stops cleanly when an in-flight client operation rejects after abort', async () => {
    const client: RemoteSyncProjectionClient = {
      describe: async (signal) => {
        if (signal === undefined) throw new Error('test client requires an abort signal')
        await waitForAbort(signal)
        throw new Error('aborted request')
      },
      snapshot: async () => snapshot(0),
      events: () => (async function * (): AsyncGenerator<RemoteSyncFrame> {})(),
    }
    const controller = new RemoteSyncController(client, {
      replace: () => {},
      apply: () => {},
    })
    const handle = controller.start()
    handle.stop()
    await expect(handle.done).resolves.toBeUndefined()
  })

  it('aborts the default reconnect delay without publishing another error', async () => {
    const errors: unknown[] = []
    const client: RemoteSyncProjectionClient = {
      describe: async () => { throw new Error('offline') },
      snapshot: async () => snapshot(0),
      events: () => (async function * (): AsyncGenerator<RemoteSyncFrame> {})(),
    }
    const controller = new RemoteSyncController(client, {
      replace: () => {},
      apply: () => {},
      onError: (error) => { errors.push(error) },
    })
    const handle = controller.start()
    await vi.waitFor(() => { expect(errors).toHaveLength(1) })
    handle.stop()
    await expect(handle.done).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
