/** Request hashing and grant parsing shared by the main instance and a Gouzi member host. */

import { describe, expect, it } from 'vitest'
import { gouziRequestHash, parseGouziGrant } from '../src/index.ts'
import type { RemoteResidentExecuteRequest } from '../src/remote-sync.ts'

const REQUEST = {
  commandId: 'exec-1', operatorId: 'codex', laneId: 'lane-1', prompt: [{ type: 'text', text: 'hi' }],
  workspaceIdentity: { version: 1, repository: 'github.com/lisihao/project', commit: 'a'.repeat(40) },
} as unknown as RemoteResidentExecuteRequest

const GRANT = {
  runId: 'run-1', nodeId: 'node-1', attempt: 1, executionId: 'exec-1', gouziId: 'gouzi-1', generation: 1,
  authorityEpoch: 'epoch-1', planHash: 'a'.repeat(64),
  scopes: { read: ['src'], write: ['out'], effects: [] }, credentialRefs: ['ref-1'],
  deadline: '2026-10-03T13:00:00.000Z', offlineUntil: '2026-10-03T14:00:00.000Z',
}

describe('gouziRequestHash', () => {
  it('ignores the command id, key order, and undefined fields but not the plan content', () => {
    const base = gouziRequestHash(REQUEST)
    expect(base).toMatch(/^[0-9a-f]{64}$/u)
    expect(gouziRequestHash({ ...REQUEST, commandId: 'exec-2' })).toBe(base)
    const reordered = {
      workspaceIdentity: { commit: 'a'.repeat(40), repository: 'github.com/lisihao/project', version: 1 },
      prompt: REQUEST.prompt, laneId: 'lane-1', operatorId: 'codex', taskLabel: undefined, commandId: 'x',
    } as unknown as RemoteResidentExecuteRequest
    expect(gouziRequestHash(reordered)).toBe(base)
    expect(gouziRequestHash({ ...REQUEST, laneId: 'lane-2' })).not.toBe(base)
    expect(gouziRequestHash({ ...REQUEST, prompt: [] })).not.toBe(base)
  })
})

describe('parseGouziGrant', () => {
  it('parses a complete grant and keeps an optional reservation id', () => {
    expect(parseGouziGrant(GRANT)).toEqual(GRANT)
    expect(parseGouziGrant({ ...GRANT, resourceReservationId: 'res-1' })).toMatchObject({ resourceReservationId: 'res-1' })
  })

  it.each([
    ['a non-object', null, 'gouziGrant must be an object'],
    ['an array', [], 'gouziGrant must be an object'],
    ['a missing text field', { ...GRANT, gouziId: '' }, 'gouziGrant.gouziId'],
    ['a fractional integer', { ...GRANT, generation: 1.5 }, 'gouziGrant.generation'],
    ['a negative integer', { ...GRANT, attempt: -1 }, 'gouziGrant.attempt'],
    ['missing scopes', { ...GRANT, scopes: undefined }, 'gouziGrant.scopes must be an object'],
    ['a non-array scope list', { ...GRANT, scopes: { ...GRANT.scopes, read: 'src' } }, 'gouziGrant.scopes.read'],
    ['a non-string credential ref', { ...GRANT, credentialRefs: [1] }, 'gouziGrant.credentialRefs'],
  ])('rejects %s', (_label, value, message) => {
    expect(() => parseGouziGrant(value)).toThrow(message)
  })
})
