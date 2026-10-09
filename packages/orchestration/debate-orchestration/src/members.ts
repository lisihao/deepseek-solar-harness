/** Binds a Debate round to the Gouzi members that fill its roster slots. */

import { DebateError } from '@deepseek-ai/dsh-debate'
import type { DebateTurnRequestV1 } from '@deepseek-ai/dsh-debate-local'
import {
  GouziId,
  type GouziControl,
  type OrchestrationAdmissionTraceV1,
  type OrchestrationGouziRecipientV1,
} from '@deepseek-ai/dsh-orchestration'

/** Registered execution entries of a member are addressed `gouzi.<gouziId>.<operatorId>`. */
const MEMBER_OPERATOR_PREFIX = 'gouzi.'

/**
 * Derive the recipient fields a round graph needs when its slots run on Gouzi members.
 * A round whose slots all name registered members is bound to the members' current generations and the entries
 * the slots use; the Scheduler then enforces availability, workspace, and grants. A round with no member slot is
 * left to the ordinary operators.
 * @param turns - sealed roster turns of one round.
 * @param control - member registry, when the orchestration service manages members.
 * @returns the admission recipient fields, empty for a round without member slots.
 * @throws DebateError - when member slots mix with other operators, name a fallback, or have no registration.
 */
export async function gouziAdmission(
  turns: readonly DebateTurnRequestV1[],
  control: GouziControl | undefined,
): Promise<Pick<OrchestrationAdmissionTraceV1, 'gouziRecipient' | 'gouziRecipients'>> {
  if (!turns.some(turn => turn.operatorId.startsWith(MEMBER_OPERATOR_PREFIX))) return {}
  if (control === undefined) {
    throw new DebateError('this orchestration service does not manage Gouzi members', 'DEBATE_UNSUPPORTED')
  }
  // The longest id wins, so member `my.dog` is not mistaken for member `my`.
  const known = (await control.list()).members.map(member => String(member.gouziId)).sort((left, right) => right.length - left.length)
  const members = new Map<string, string[]>()
  for (const turn of turns) {
    const member = known.find(id => turn.operatorId.startsWith(`${MEMBER_OPERATOR_PREFIX}${id}.`))
    if (member === undefined) {
      throw new DebateError(`Debate slot ${turn.slotId} does not name a registered Gouzi member`, 'DEBATE_UNSUPPORTED')
    }
    if ((turn.fallbackOperatorIds?.length ?? 0) > 0) {
      throw new DebateError(`Gouzi Debate slot ${turn.slotId} cannot name fallback operators`, 'DEBATE_UNSUPPORTED')
    }
    members.set(member, [...new Set([...members.get(member) ?? [], turn.operatorId])])
  }
  const entries = await control.executionOperators()
  const recipients = [...members].map(([id, operatorIds]): OrchestrationGouziRecipientV1 => {
    const entry = entries.find(value => String(value.gouziId) === id)
    if (entry === undefined) {
      throw new DebateError(`Gouzi member ${id} has no registered execution entry`, 'DEBATE_ROSTER_INVALID')
    }
    return {
      gouziId: GouziId(id),
      generation: entry.generation,
      operatorIds: operatorIds as unknown as OrchestrationGouziRecipientV1['operatorIds'],
    }
  })
  const [only] = recipients
  return recipients.length === 1 && only !== undefined ? { gouziRecipient: only } : { gouziRecipients: recipients }
}
