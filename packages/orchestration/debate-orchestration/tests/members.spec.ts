/** Member binding of a Debate round: recipients derive from the roster and the registry, nothing else. */

import { describe, expect, it } from 'vitest'
import { GouziId, type GouziControl } from '@deepseek-ai/dsh-orchestration'
import type { DebateTurnRequestV1 } from '@deepseek-ai/dsh-debate-local'
import { gouziAdmission } from '../src/members.ts'

function turn(slotId: string, operatorId: string, fallbackOperatorIds?: string[]): DebateTurnRequestV1 {
  return { slotId, operatorId, ...fallbackOperatorIds === undefined ? {} : { fallbackOperatorIds } } as unknown as DebateTurnRequestV1
}

/** A registry holding the named members, each at its own generation. */
function registry(members: Record<string, number>): GouziControl {
  return {
    list: async () => ({ hosts: [], members: Object.keys(members).map(id => ({ gouziId: GouziId(id) })) }),
    executionOperators: async () => Object.entries(members).map(([id, generation]) => ({
      gouziId: GouziId(id), generation, projectScopes: [], operators: [],
    })),
  } as unknown as GouziControl
}

describe('gouziAdmission', () => {
  it('leaves a round without member slots to the ordinary operators', async () => {
    expect(await gouziAdmission([turn('a', 'codex'), turn('b', 'claude-code')], undefined)).toEqual({})
  })

  it('binds a round to the distinct members its slots name, at their current generations', async () => {
    const turns = [
      turn('proposer', 'gouzi.alpha.codex'), turn('falsifier', 'gouzi.beta.claude-code'),
      turn('auditor', 'gouzi.alpha.claude-code'), turn('judge', 'gouzi.gamma.codex'),
    ]
    expect(await gouziAdmission(turns, registry({ alpha: 2, beta: 1, gamma: 7 }))).toEqual({
      gouziRecipients: [
        { gouziId: 'alpha', generation: 2, operatorIds: ['gouzi.alpha.codex', 'gouzi.alpha.claude-code'] },
        { gouziId: 'beta', generation: 1, operatorIds: ['gouzi.beta.claude-code'] },
        { gouziId: 'gamma', generation: 7, operatorIds: ['gouzi.gamma.codex'] },
      ],
    })
  })

  it('uses the singular recipient when every slot belongs to one member', async () => {
    const turns = [turn('a', 'gouzi.solo.codex'), turn('b', 'gouzi.solo.codex'), turn('c', 'gouzi.solo.claude-code')]
    expect(await gouziAdmission(turns, registry({ solo: 3 }))).toEqual({
      gouziRecipient: { gouziId: 'solo', generation: 3, operatorIds: ['gouzi.solo.codex', 'gouzi.solo.claude-code'] },
    })
  })

  it('matches a member whose id contains a dot by the full prefix', async () => {
    expect(await gouziAdmission([turn('a', 'gouzi.my.dog.codex'), turn('b', 'gouzi.cat.codex')], registry({ 'my.dog': 1, cat: 1 })))
      .toMatchObject({ gouziRecipients: [{ gouziId: 'my.dog', operatorIds: ['gouzi.my.dog.codex'] }, { gouziId: 'cat' }] })
  })

  it('prefers the longest member id when one id prefixes another', async () => {
    expect(await gouziAdmission([turn('a', 'gouzi.my.dog.codex'), turn('b', 'gouzi.my.codex')], registry({ my: 1, 'my.dog': 2 })))
      .toEqual({ gouziRecipients: [
        { gouziId: 'my.dog', generation: 2, operatorIds: ['gouzi.my.dog.codex'] },
        { gouziId: 'my', generation: 1, operatorIds: ['gouzi.my.codex'] },
      ] })
  })

  it.each([
    ['mixes a member with an ordinary operator', [turn('a', 'gouzi.alpha.codex'), turn('b', 'codex')], { alpha: 1 }, 'does not name a registered Gouzi member'],
    ['names a member that is not registered', [turn('a', 'gouzi.alpha.codex'), turn('b', 'gouzi.ghost.codex')], { alpha: 1 }, 'does not name a registered Gouzi member'],
    ['names a fallback operator', [turn('a', 'gouzi.alpha.codex', ['codex']), turn('b', 'gouzi.beta.codex')], { alpha: 1, beta: 1 }, 'cannot name fallback operators'],
  ])('refuses a round that %s', async (_name, turns, members, message) => {
    await expect(gouziAdmission(turns, registry(members))).rejects.toMatchObject({ code: 'DEBATE_UNSUPPORTED', message: expect.stringContaining(message) as string })
  })

  it('refuses member slots when the service does not manage members or the member has no execution entry', async () => {
    await expect(gouziAdmission([turn('a', 'gouzi.alpha.codex')], undefined)).rejects.toMatchObject({ code: 'DEBATE_UNSUPPORTED' })
    const unregistered = { ...registry({ alpha: 1 }), executionOperators: async () => [] } as unknown as GouziControl
    await expect(gouziAdmission([turn('a', 'gouzi.alpha.codex'), turn('b', 'gouzi.alpha.claude-code')], unregistered))
      .rejects.toMatchObject({ code: 'DEBATE_ROSTER_INVALID' })
  })
})
