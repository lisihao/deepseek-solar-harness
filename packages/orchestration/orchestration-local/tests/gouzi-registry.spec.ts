/** Durable Gouzi host and member registry over a real SQLite store. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GOUZI_MEMBER_LIMIT, GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId,
} from '@deepseek-ai/dsh-orchestration'
import { OrchestrationStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function open(root?: string): Promise<{ store: OrchestrationStore; root: string }> {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'dsh-gouzi-registry-'))
  if (root === undefined) roots.push(directory)
  return { store: new OrchestrationStore(directory), root: directory }
}

const HOST = {
  hostId: GouziHostId('host-1'), label: 'Mac mini', endpoint: 'http://127.0.0.1:4100',
  authorityEpoch: GouziAuthorityEpoch('epoch-1'), credentialRef: 'gouzi-host-1',
}

function member(index: number, patch: Record<string, unknown> = {}) {
  return {
    gouziId: GouziId(`gouzi-${String(index)}`), ownerId: GouziOwnerId('owner-1'), hostId: HOST.hostId,
    name: `Dog ${String(index)}`, avatarId: 'shiba' as const, role: 'research' as const, ...patch,
  }
}

describe('GouziRegistry hosts', () => {
  it('stores a paired host, lists it, and refuses to pair the same id twice', async () => {
    const { store } = await open()
    const paired = store.gouzi.pairHost(HOST)
    expect(paired).toMatchObject(HOST)
    expect(store.gouzi.getHost(HOST.hostId)).toEqual(paired)
    expect(store.gouzi.getHost(GouziHostId('other'))).toBeUndefined()
    expect(store.gouzi.listHosts()).toEqual([paired])
    expect(() => store.gouzi.pairHost(HOST)).toThrow('already paired')
    store.close()
  })
})

describe('GouziRegistry members', () => {
  it('creates a provisioning member that survives reopening the store and keeps its identity', async () => {
    const first = await open()
    first.store.gouzi.pairHost(HOST)
    const created = first.store.gouzi.create(member(1, { name: '  Mochi  ' }))
    expect(created).toMatchObject({
      gouziId: 'gouzi-1', name: 'Mochi', generation: 1, membership: 'provisioning',
      connection: 'unreachable', activity: 'resting', roleVersion: 1, policyVersion: 1,
    })
    first.store.close()

    const second = await open(first.root)
    expect(second.store.gouzi.read(GouziId('gouzi-1'))).toEqual(created)
    expect(second.store.gouzi.read(GouziId('missing'))).toBeUndefined()
    second.store.close()
  })

  it('rejects an unpaired host, a duplicate id, and an invalid name, avatar, or role', async () => {
    const { store } = await open()
    expect(() => store.gouzi.create(member(1))).toThrow('is not paired')
    store.gouzi.pairHost(HOST)
    store.gouzi.create(member(1))
    expect(() => store.gouzi.create(member(1))).toThrow('already exists')
    expect(() => store.gouzi.create(member(2, { name: '   ' }))).toThrow('1 to 40 characters')
    expect(() => store.gouzi.create(member(2, { name: 'x'.repeat(41) }))).toThrow('1 to 40 characters')
    expect(() => store.gouzi.create(member(2, { avatarId: 'cat' }))).toThrow('unknown gouzi avatar')
    expect(() => store.gouzi.create(member(2, { role: 'boss' }))).toThrow('unknown gouzi role')
    expect(store.gouzi.list()).toHaveLength(1)
    store.close()
  })

  it('refuses the eleventh member, counts sleeping and unreachable ones, and frees a slot only on archive', async () => {
    const { store } = await open()
    store.gouzi.pairHost(HOST)
    for (let index = 1; index <= GOUZI_MEMBER_LIMIT; index++) store.gouzi.create(member(index))
    expect(() => store.gouzi.create(member(11))).toThrow(expect.objectContaining({ code: 'GOUZI_LIMIT_REACHED' }))

    // Provisioning, enabled-but-resting, and unreachable members all keep their slot.
    store.gouzi.setMembership(GouziId('gouzi-1'), 'enabled')
    store.gouzi.observe(GouziId('gouzi-1'), { connection: 'unreachable', activity: 'resting' })
    expect(() => store.gouzi.create(member(11))).toThrow('at most 10')

    // Retiring still counts; archiving without evidence is refused.
    store.gouzi.setMembership(GouziId('gouzi-1'), 'retiring')
    expect(() => store.gouzi.create(member(11))).toThrow('at most 10')
    expect(() => store.gouzi.archive(GouziId('gouzi-1'), {
      credentialsRevoked: true, workSettled: true, processTreeStopped: false,
    })).toThrow('stopped process tree')
    expect(store.gouzi.list().filter(entry => entry.membership !== 'archived')).toHaveLength(GOUZI_MEMBER_LIMIT)

    const archived = store.gouzi.archive(GouziId('gouzi-1'), {
      credentialsRevoked: true, workSettled: true, processTreeStopped: true,
    })
    expect(archived.membership).toBe('archived')
    expect(store.gouzi.create(member(11)).gouziId).toBe('gouzi-11')
    expect(() => store.gouzi.create(member(12))).toThrow('at most 10')
    store.close()
  })

  it('enforces the limit across two connections to the same database', async () => {
    const { store, root } = await open()
    store.gouzi.pairHost(HOST)
    for (let index = 1; index < GOUZI_MEMBER_LIMIT; index++) store.gouzi.create(member(index))
    const other = new OrchestrationStore(root)
    const results = [
      () => store.gouzi.create(member(10)),
      () => other.gouzi.create(member(11)),
    ].map((create) => {
      try { return create().gouziId } catch (error) { return (error as { code?: string }).code }
    })
    expect(results.filter(value => value === 'GOUZI_LIMIT_REACHED')).toHaveLength(1)
    expect(store.gouzi.list()).toHaveLength(GOUZI_MEMBER_LIMIT)
    other.close()
    store.close()
  })

  it('edits name, avatar, and role without changing identity, and bumps roleVersion only on a role change', async () => {
    const { store } = await open()
    store.gouzi.pairHost(HOST)
    store.gouzi.create(member(1))
    const renamed = store.gouzi.edit(GouziId('gouzi-1'), { name: 'Pixel', avatarId: 'corgi' })
    expect(renamed).toMatchObject({ gouziId: 'gouzi-1', name: 'Pixel', avatarId: 'corgi', roleVersion: 1, generation: 1 })
    const rerolled = store.gouzi.edit(GouziId('gouzi-1'), { role: 'testing' })
    expect(rerolled).toMatchObject({ role: 'testing', roleVersion: 2 })
    expect(store.gouzi.edit(GouziId('gouzi-1'), { role: 'testing' }).roleVersion).toBe(2)
    expect(() => store.gouzi.edit(GouziId('missing'), { name: 'x' })).toThrow('does not exist')
    store.close()
  })

  it('follows provisioning, enabled and retiring only, and treats archived as terminal', async () => {
    const { store } = await open()
    store.gouzi.pairHost(HOST)
    store.gouzi.create(member(1))
    const id = GouziId('gouzi-1')
    expect(() => store.gouzi.archive(id, { credentialsRevoked: true, workSettled: true, processTreeStopped: true }))
      .toThrow('must be retiring')
    expect(store.gouzi.setMembership(id, 'enabled').membership).toBe('enabled')
    expect(() => store.gouzi.setMembership(id, 'provisioning')).toThrow('cannot move from enabled to provisioning')
    expect(store.gouzi.setMembership(id, 'retiring').membership).toBe('retiring')
    expect(store.gouzi.setMembership(id, 'enabled').membership).toBe('enabled')
    store.gouzi.setMembership(id, 'retiring')
    store.gouzi.archive(id, { credentialsRevoked: true, workSettled: true, processTreeStopped: true })
    expect(() => store.gouzi.setMembership(id, 'enabled')).toThrow('cannot move from archived to enabled')
    expect(() => store.gouzi.edit(id, { name: 'late' })).toThrow('is archived')
    store.close()
  })

  it('records observed connection and activity independently of membership', async () => {
    const { store } = await open()
    store.gouzi.pairHost(HOST)
    store.gouzi.create(member(1))
    const id = GouziId('gouzi-1')
    expect(store.gouzi.observe(id, { connection: 'online' })).toMatchObject({ connection: 'online', activity: 'resting', membership: 'provisioning' })
    expect(store.gouzi.observe(id, { activity: 'working' })).toMatchObject({ connection: 'online', activity: 'working' })
    store.close()
  })
})
