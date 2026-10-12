import { describe, expect, it } from 'vitest'
import {
  GOUZI_AVATAR_IDS,
  GOUZI_EVENT_TYPES,
  GOUZI_MEMBER_LIMIT,
  GOUZI_ROLES,
  GouziAuthorityEpoch,
  GouziHostId,
  GouziId,
  GouziOwnerId,
  countsTowardGouziLimit,
  type GouziMembership,
} from '../src/index.ts'

describe('Gouzi contract', () => {
  it('limits a management domain to ten members', () => {
    expect(GOUZI_MEMBER_LIMIT).toBe(10)
  })

  it('counts every membership except archived, so a stopped or unreachable member keeps its slot', () => {
    const memberships: Record<GouziMembership, boolean> = {
      provisioning: true,
      enabled: true,
      retiring: true,
      archived: false,
    }

    for (const [membership, counts] of Object.entries(memberships)) {
      expect(countsTowardGouziLimit(membership as GouziMembership)).toBe(counts)
    }
  })

  it('brands identities without changing their value', () => {
    expect(GouziId('gouzi-1')).toBe('gouzi-1')
    expect(GouziHostId('mini')).toBe('mini')
    expect(GouziOwnerId('macbook')).toBe('macbook')
    expect(GouziAuthorityEpoch('epoch-1')).toBe('epoch-1')
  })

  it('names six avatars, six roles, and event types in the gouzi namespace', () => {
    expect(new Set(GOUZI_AVATAR_IDS).size).toBe(6)
    expect(GOUZI_ROLES).toEqual(['research', 'development', 'testing', 'curation', 'daily', 'custom'])
    expect(GOUZI_EVENT_TYPES.every(type => type.startsWith('gouzi.'))).toBe(true)
    expect(new Set(GOUZI_EVENT_TYPES).size).toBe(GOUZI_EVENT_TYPES.length)
  })
})
