/** Remote Sync journal: replay, expiry, generation fencing, and no-gap handoff. */

import { describe, expect, it } from 'vitest'
import { RpcId, type HostFrame, type RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RemoteSyncJournal } from '../src/remote-sync-host.ts'

function hostEnvelope(rpcId: string): RpcRequest<HostFrame> {
  return {
    rpcId: RpcId(rpcId),
    payload: { type: 'host/session-status', sessionId: `session-${rpcId}` as never, running: true },
  }
}

describe('RemoteSyncJournal', () => {
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
})
