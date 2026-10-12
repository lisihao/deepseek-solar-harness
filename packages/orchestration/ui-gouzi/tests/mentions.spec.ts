/** Which members a message names. */

import type { GouziMemberView } from '@deepseek-ai/dsh-orchestration'
import { describe, expect, it } from 'vitest'
import { mentionedMembers } from '../src/mentions.ts'

const member = (name: string, gouziId = name.toLowerCase(), patch: Partial<GouziMemberView> = {}) =>
  ({ gouziId, generation: 2, name, membership: 'enabled', ...patch }) as unknown as GouziMemberView

const names = (text: string, members: GouziMemberView[]) => mentionedMembers(text, members).map(value => value.name)

describe('mentionedMembers', () => {
  const crew = [member('Alpha'), member('Beta'), member('Gamma')]

  it('returns the named members in the order the message names them, not the registry order', () => {
    expect(names('Ask gamma and alpha to review that', crew)).toEqual(['Gamma', 'Alpha'])
    expect(mentionedMembers('beta?', crew)).toEqual([{ gouziId: 'beta', generation: 2, name: 'Beta' }])
    expect(names('nobody is named here', crew)).toEqual([])
    expect(names('', crew)).toEqual([])
  })

  it('ignores case, and a name inside a longer ASCII word', () => {
    expect(names('ALPHA looks fine', crew)).toEqual(['Alpha'])
    expect(names('the alphabet and a gamma-ray', crew)).toEqual(['Gamma'])
    expect(names('beta_2 and xbeta', crew)).toEqual([])
    expect(names('(beta), "alpha".', crew)).toEqual(['Beta', 'Alpha'])
  })

  it('finds names in scripts that have no word boundaries', () => {
    const cjk = [member('年糕', 'a'), member('团子', 'b')]
    expect(names('让团子和年糕一起评审', cjk)).toEqual(['团子', '年糕'])
    expect(names('让年糕糕评审', cjk)).toEqual(['年糕'])
  })

  it('counts a stretch of text once and prefers the longer name', () => {
    const pets = [member('Mo'), member('Mochi'), member('Mochi Jr', 'mochijr')]
    expect(names('ask Mochi Jr please', pets)).toEqual(['Mochi Jr'])
    expect(names('ask Mochi, then mo', pets)).toEqual(['Mochi', 'Mo'])
    expect(names('Mo Mo Mo', pets)).toEqual(['Mo'])
  })

  it('takes a later occurrence when an earlier one is inside a word or already used', () => {
    expect(names('alphabet then alpha', crew)).toEqual(['Alpha'])
  })

  it('leaves out names the message cannot resolve: shared by several members, empty, or of a member that is not enabled', () => {
    const twins = [member('Twin', 'a'), member('twin', 'b'), member('Solo', 'c')]
    expect(names('twin and solo', twins)).toEqual(['Solo'])
    expect(names('anything', [member('', 'e')])).toEqual([])
    expect(names('beta', [member('Beta', 'b', { membership: 'retiring' })])).toEqual([])
  })

  it('keeps matching when folding case would move offsets', () => {
    // "İ" lowercases to two code units, so offsets in the folded text would differ from the original.
    const dotted = [member('İda', 'd'), member('Ida', 'i')]
    expect(names('ask İda now', dotted)).toEqual(['İda'])
  })
})
