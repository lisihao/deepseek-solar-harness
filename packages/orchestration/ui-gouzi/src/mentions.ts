/** Which members a user's message names, so a collaboration can run on the members the user asked for. */
import type { GouziMemberView, KennelMentionedMember } from '@deepseek-ai/dsh-orchestration'

const WORD = /[A-Za-z0-9_]/u

/** Fold case only when it keeps every character in place, so offsets in the folded text are offsets in the original. */
function fold(text: string): string {
  const folded = text.toLowerCase()
  return folded.length === text.length ? folded : text
}

/** A name made of ASCII word characters must not sit inside a longer word; other scripts have no word boundaries. */
function standsAlone(text: string, at: number, length: number): boolean {
  const before = text[at - 1]
  const after = text[at + length]
  const first = text[at]
  const last = text[at + length - 1]
  const insideBefore = before !== undefined && first !== undefined && WORD.test(first) && WORD.test(before)
  const insideAfter = after !== undefined && last !== undefined && WORD.test(last) && WORD.test(after)
  return !insideBefore && !insideAfter
}

/**
 * Find the enabled members whose name appears in a message.
 * Longer names are matched first and a matched stretch cannot match again, so a name inside a longer name does not
 * count. A name that more than one enabled member has is ambiguous and is left out, because the message cannot say
 * which member it means.
 * @param text - the user's message, without any addressing prefix.
 * @param members - every registered member.
 * @returns the named members in order of first mention.
 */
export function mentionedMembers(text: string, members: readonly GouziMemberView[]): KennelMentionedMember[] {
  const enabled = members.filter(member => member.membership === 'enabled' && member.name.length > 0)
  const unique = enabled.filter(member => enabled.filter(other => fold(other.name) === fold(member.name)).length === 1)
  const haystack = fold(text)
  const folded = text.toLowerCase().length === text.length
  const taken = new Set<number>()
  const found: { member: GouziMemberView; at: number }[] = []
  for (const member of [...unique].sort((left, right) => right.name.length - left.name.length)) {
    const needle = folded ? member.name.toLowerCase() : member.name
    for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + 1)) {
      const span = Array.from({ length: needle.length }, (_, offset) => from + offset)
      if (standsAlone(haystack, from, needle.length) && !span.some(index => taken.has(index))) {
        for (const index of span) taken.add(index)
        found.push({ member, at: from })
        break
      }
    }
  }
  return found.sort((left, right) => left.at - right.at)
    .map(({ member }) => ({ gouziId: String(member.gouziId), generation: member.generation, name: member.name }))
}
