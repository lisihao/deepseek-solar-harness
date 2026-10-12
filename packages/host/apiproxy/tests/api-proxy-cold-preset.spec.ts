/**
 * The cold session list recovers a preset selected after creation. The session header keeps only the creation-time
 * preset and the selection lives in the log, so the list reads it from the `sessionListMetadata` projection. The
 * upgrade case runs two hosts over one storage pool: the first checkpoints a version 1 row without the preset, the
 * second (the shipped unit, version 2) must refold that session instead of trusting the old row.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { RpcId, type RpcRequest } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const REVISION = SessionPersistenceRevision('jsonl:r1')

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`cold-preset-${String(nextRpc++)}`), payload }
}

/** A host with storage on `pool`, the projection registry and cache, and a persistence double over `logs`. */
async function host(pool: MemoryMediaPool, logs: Map<string, SessionEvent[]>, known: { header?: SessionHeader } = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(SessionProjectionRegistry)
  const readFrom = vi.fn(async (id: SessionId, fromSeq: number) => {
    const events = logs.get(String(id))
    const { header } = known
    if (events === undefined || header === undefined) throw new Error(`session "${id}" not found`)
    return { meta: header, events: events.filter(event => event.seq >= fromSeq) }
  })
  ctx.provide('sessionPersistence', {
    readFrom,
    locate: () => undefined,
    listSnapshots: () => Promise.resolve(known.header === undefined ? [] : [{ header: known.header, revision: REVISION }]),
  } as never)
  return { ctx, readFrom }
}

describe('sessions.list cold preset', () => {
  it.each([
    ['a live checkpoint', false],
    ['a cold-read row bound to the persistence revision, which the 3.42 list writes back for every cold session', true],
  ])('refolds a version 1 cache row (%s) once, then serves the logged preset from the cache and matches the attached row', async (_name, revisionBound) => {
    const pool = new MemoryMediaPool()
    const logs = new Map<string, SessionEvent[]>()
    const known: { header?: SessionHeader } = {}

    // Host A: the 3.42 unit (version 1, no preset) checkpoints the session at detach.
    const old = await host(pool, logs, known)
    await old.ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    old.ctx.sessionProjections.register({
      key: 'sessionListMetadata',
      schema: z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() }),
      init: () => ({ blank: true, lastPromptAt: null }),
      apply: (state: { blank: boolean; lastPromptAt: number | null }, event: SessionEvent) =>
        ({ blank: state.blank && event.type !== 'turn/start', lastPromptAt: state.lastPromptAt }),
      view: (state: { blank: boolean; lastPromptAt: number | null }) => state,
      stateVersion: 1,
    } as never)
    const session: Session = old.ctx.sessions.create(SessionId('cold-kennel'), { meta: { cwd: '/proj', agentPreset: 'standard' } })
    session.append('agent-preset/selected', { agentPreset: 'kennel' })
    logs.set(String(session.id), [...session.events])
    const header = session.header
    known.header = header
    await old.ctx.sessionProjectionCache.write(session)
    // The 3.42 cold list then rewrote the row bound to the persistence revision, which later lists serve with no I/O.
    if (revisionBound) await old.ctx.sessionProjectionCache.coldSnapshot(header.id, undefined, REVISION)
    const stored = pool.media.get('session_projcache')?.tables.get('sessions')?.get(String(header.id)) as
      { sourceRevision?: string; rows: Record<string, { ver: number }> } | undefined
    expect(stored?.rows.sessionListMetadata?.ver).toBe(1)
    expect(stored?.sourceRevision).toBe(revisionBound ? String(REVISION) : undefined)

    // Host B: the shipped unit (version 2) lists the now-cold session.
    const upgraded = await host(pool, logs, { header })
    await upgraded.ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const api = createApiProxy(upgraded.ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

    const first = await api.sessions.list(request({}))
    if (!first.result.ok) throw new Error('list failed')
    expect(first.result.value.items.find(item => item.sessionId === header.id)).toMatchObject({ agentPreset: 'kennel' })
    const readsAfterFirst = upgraded.readFrom.mock.calls.length
    expect(readsAfterFirst).toBeGreaterThan(0)

    const second = await api.sessions.list(request({}))
    if (!second.result.ok) throw new Error('list failed')
    expect(second.result.value.items.find(item => item.sessionId === header.id)).toMatchObject({ agentPreset: 'kennel' })
    expect(upgraded.readFrom.mock.calls.length).toBe(readsAfterFirst)

    // The attached row resolves the same preset from the events.
    expect(resolveSessionPreset({ header, events: logs.get(String(header.id))! })).toBe('kennel')
  })

  it('falls back to the header preset when no selection was logged', async () => {
    const pool = new MemoryMediaPool()
    const logs = new Map<string, SessionEvent[]>()
    const writer = await host(pool, logs)
    const session: Session = writer.ctx.sessions.create(SessionId('cold-standard'), { meta: { cwd: '/proj', agentPreset: 'standard' } })
    logs.set(String(session.id), [...session.events])
    const reader = await host(pool, logs, { header: session.header })
    await reader.ctx.plugin(SessionProjectionCache, { writeEveryEvents: 100, writeIntervalMs: 60_000 })
    const api = createApiProxy(reader.ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const listed = await api.sessions.list(request({}))
    if (!listed.result.ok) throw new Error('list failed')
    expect(listed.result.value.items.find(item => item.sessionId === session.header.id)).toMatchObject({ agentPreset: 'standard' })
  })
})
