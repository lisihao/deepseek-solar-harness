/** Identity, grant admission, and idempotency ledger of one Gouzi execution member. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import type { RemoteResidentAcceptedTurn } from '@deepseek-ai/dsh-client-connection'
import type { GouziExecutionGrant } from '@deepseek-ai/dsh-orchestration'
import GouziMemberHost, { provisionGouziIdentity } from '../src/index.ts'

const fibers: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => {
  for (const fiber of fibers.splice(0)) await fiber.dispose()
})

const IDENTITY = {
  gouziId: 'gouzi-1', ownerId: 'owner-1', hostId: 'host-1', generation: 1, authorityEpoch: 'epoch-1',
}
const HASH = 'a'.repeat(64)
const NOW = Date.parse('2026-10-03T12:00:00.000Z')

function grant(patch: Partial<Record<keyof GouziExecutionGrant, unknown>> = {}): GouziExecutionGrant {
  return {
    runId: 'run-1', nodeId: 'node-1', attempt: 1, executionId: 'exec-1', gouziId: 'gouzi-1', generation: 1,
    authorityEpoch: 'epoch-1', planHash: HASH,
    scopes: { read: [], write: [], effects: [] }, credentialRefs: [],
    deadline: '2026-10-03T13:00:00.000Z', offlineUntil: '2026-10-03T13:00:00.000Z',
    ...patch,
  } as unknown as GouziExecutionGrant
}

const ACCEPTED: RemoteResidentAcceptedTurn = { sessionId: 'session-1', turnId: 'turn-1', stateRevision: 3 }

async function start(stateRoot: string): Promise<GouziMemberHost> {
  const ctx = new Context()
  const fiber = ctx.plugin(GouziMemberHost, { stateRoot })
  await fiber.await()
  fibers.push(fiber)
  return ctx.gouziMember as GouziMemberHost
}

async function provisioned(): Promise<{ root: string; member: GouziMemberHost }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gouzi-member-'))
  await provisionGouziIdentity(root, IDENTITY)
  return { root, member: await start(root) }
}

describe('unreadable state', () => {
  it('propagates a read failure that is not a missing file instead of treating it as empty', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-gouzi-member-'))
    mkdirSync(join(root, 'gouzi', 'identity.json'), { recursive: true })
    await expect(provisionGouziIdentity(root, IDENTITY)).rejects.toThrow('EISDIR')

    rmSync(join(root, 'gouzi', 'identity.json'), { recursive: true })
    await provisionGouziIdentity(root, IDENTITY)
    mkdirSync(join(root, 'gouzi', 'ledger.json'))
    const fiber = new Context().plugin(GouziMemberHost, { stateRoot: root })
    await expect(fiber.await()).rejects.toThrow('EISDIR')
  })
})

describe('provisionGouziIdentity', () => {
  it('stores the identity once and refuses to replace it with a different one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-gouzi-member-'))
    await provisionGouziIdentity(root, IDENTITY)
    await provisionGouziIdentity(root, IDENTITY)
    await expect(provisionGouziIdentity(root, { ...IDENTITY, authorityEpoch: 'epoch-2' }))
      .rejects.toThrow('already holds a different identity')
    expect(JSON.parse(readFileSync(join(root, 'gouzi', 'identity.json'), 'utf8'))).toMatchObject(IDENTITY)
  })

  it('rejects a malformed stored identity document', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-gouzi-member-'))
    await provisionGouziIdentity(root, IDENTITY)
    writeFileSync(join(root, 'gouzi', 'identity.json'), '{"version":1}')
    await expect(provisionGouziIdentity(root, IDENTITY)).rejects.toThrow('not a version 1 identity document')
  })
})

describe('GouziMemberHost', () => {
  it('refuses to start without a provisioned identity', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(GouziMemberHost, { stateRoot: mkdtempSync(join(tmpdir(), 'dsh-gouzi-member-')) })
    await expect(fiber.await()).rejects.toThrow('must provision this member first')
  })

  it('keeps its identity across a restart and counts incarnations', async () => {
    const { root, member } = await provisioned()
    expect(member.hello()).toEqual({ ...IDENTITY, incarnation: 1 })
    await fibers.shift()!.dispose()
    const resumed = await start(root)
    expect(resumed.hello()).toEqual({ ...IDENTITY, incarnation: 2 })
  })

  it('refuses a wrong member, generation, epoch, or plan hash before recording anything', async () => {
    const { root, member } = await provisioned()
    await expect(member.admit(grant({ gouziId: 'gouzi-2' }), HASH, NOW)).rejects.toMatchObject({ code: 'GOUZI_IDENTITY_MISMATCH' })
    await expect(member.admit(grant({ generation: 2 }), HASH, NOW)).rejects.toMatchObject({ code: 'GOUZI_GENERATION_MISMATCH' })
    await expect(member.admit(grant({ authorityEpoch: 'epoch-0' }), HASH, NOW)).rejects.toMatchObject({ code: 'GOUZI_EPOCH_MISMATCH' })
    await expect(member.admit(grant(), 'b'.repeat(64), NOW)).rejects.toMatchObject({ code: 'GOUZI_PLAN_MISMATCH' })
    expect((JSON.parse(readFileSync(join(root, 'gouzi', 'ledger.json'), 'utf8')) as { executions: unknown }).executions).toEqual({})
  })

  it('refuses an expired grant but still answers a repeat of an accepted execution', async () => {
    const { member } = await provisioned()
    const late = Date.parse('2026-10-03T14:00:00.000Z')
    await expect(member.admit(grant(), HASH, late)).rejects.toMatchObject({ code: 'GOUZI_GRANT_EXPIRED' })
    await expect(member.admit(grant(), HASH, NOW)).resolves.toEqual({ kind: 'new' })
    await member.recordAccepted('exec-1', ACCEPTED)
    await expect(member.admit(grant(), HASH, late)).resolves.toEqual({ kind: 'replay', accepted: ACCEPTED })
  })

  it('returns the stored receipt for the same id and hash, also after a restart, and conflicts on another hash', async () => {
    const { root, member } = await provisioned()
    await expect(member.admit(grant(), HASH, NOW)).resolves.toEqual({ kind: 'new' })
    await expect(member.admit(grant(), HASH, NOW)).resolves.toEqual({ kind: 'new' })
    await member.recordAccepted('exec-1', ACCEPTED)
    await expect(member.admit(grant(), HASH, NOW)).resolves.toEqual({ kind: 'replay', accepted: ACCEPTED })

    await fibers.shift()!.dispose()
    const resumed = await start(root)
    await expect(resumed.admit(grant(), HASH, NOW)).resolves.toEqual({ kind: 'replay', accepted: ACCEPTED })
    const other = 'c'.repeat(64)
    await expect(resumed.admit(grant({ planHash: other }), other, NOW))
      .rejects.toMatchObject({ code: 'GOUZI_EXECUTION_CONFLICT' })
  })

  it('rejects a receipt for an execution that was never admitted and a malformed ledger', async () => {
    const { root, member } = await provisioned()
    await expect(member.recordAccepted('exec-9', ACCEPTED)).rejects.toThrow('was never admitted')
    await fibers.shift()!.dispose()
    for (const malformed of ['{"version":2}', '{"version":1,"incarnation":0,"executions":null}']) {
      writeFileSync(join(root, 'gouzi', 'ledger.json'), malformed)
      const fiber = new Context().plugin(GouziMemberHost, { stateRoot: root })
      await expect(fiber.await()).rejects.toThrow('is not a version 1 ledger')
    }
  })
})
