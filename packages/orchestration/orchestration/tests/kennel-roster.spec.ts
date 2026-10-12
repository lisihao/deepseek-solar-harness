/** Choosing the members of a collaboration when the user's message may name some. */

import { describe, expect, it } from 'vitest'
import { kennelRoster, type KennelCollaborationMember, type KennelMentionedMember } from '../src/index.ts'

const member = (id: string, generation = 1): KennelCollaborationMember =>
  ({ gouziId: id, generation, name: id.toUpperCase(), role: 'research', operatorId: `gouzi.${id}.codex`, model: 'm' })
const named = (id: string, generation = 1): KennelMentionedMember => ({ gouziId: id, generation, name: id.toUpperCase() })
const ids = (value: readonly KennelCollaborationMember[] | undefined) => value?.map(item => item.gouziId)

const qualified = ['a', 'b', 'c', 'd', 'e'].map(id => member(id))
const bounds = { min: 3, max: 4 }

describe('kennelRoster', () => {
  it('takes the first members in registry order when the message names nobody', () => {
    expect(ids(kennelRoster(qualified, [], bounds))).toEqual(['a', 'b', 'c', 'd'])
    expect(kennelRoster(qualified.slice(0, 2), [], bounds)).toBeUndefined()
    expect(ids(kennelRoster(qualified.slice(0, 3), [], bounds))).toEqual(['a', 'b', 'c'])
  })

  it('uses the named members in the order named, even when they are not first in the registry', () => {
    expect(ids(kennelRoster(qualified, [named('e'), named('b'), named('d')], bounds))).toEqual(['e', 'b', 'd'])
    expect(ids(kennelRoster(qualified, [named('e'), named('b'), named('d'), named('a')], bounds))).toEqual(['e', 'b', 'd', 'a'])
  })

  it('completes too few names from the other qualified members, after the named ones', () => {
    expect(ids(kennelRoster(qualified, [named('d')], bounds))).toEqual(['d', 'a', 'b'])
    expect(ids(kennelRoster(qualified, [named('c'), named('a')], bounds))).toEqual(['c', 'a', 'b'])
    expect(ids(kennelRoster(qualified, [named('d')], { min: 1, max: 2 }))).toEqual(['d'])
    expect(kennelRoster(qualified.slice(0, 2), [named('b')], bounds)).toBeUndefined()
  })

  it('offers nothing rather than replace a named member that cannot take part or name more than it takes', () => {
    expect(kennelRoster(qualified, [named('a'), named('ghost'), named('c')], bounds)).toBeUndefined()
    expect(kennelRoster(qualified, [named('a', 9), named('b'), named('c')], bounds)).toBeUndefined()
    expect(kennelRoster(qualified, ['a', 'b', 'c', 'd', 'e'].map(id => named(id)), bounds)).toBeUndefined()
  })

  it('drops excluded members from the names, and falls back to the default roster when none is left', () => {
    const excluded = new Set(['a'])
    const others = qualified.filter(value => value.gouziId !== 'a')
    expect(ids(kennelRoster(others, [named('a'), named('c')], { min: 1, max: 2 }, excluded))).toEqual(['c'])
    expect(ids(kennelRoster(others, [named('a')], { min: 1, max: 2 }, excluded))).toEqual(['b', 'c'])
    expect(kennelRoster([], [named('a')], { min: 1, max: 2 }, excluded)).toBeUndefined()
  })
})
