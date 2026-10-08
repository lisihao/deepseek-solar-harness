/** Host-owned candidates for a kennel Debate: which members argue the same question in one project. */
import type { GouziControl, GouziMemberView } from '@deepseek-ai/dsh-orchestration'

/** One member of a Debate candidate, with the execution entry and model the Host confirmed for it. */
export interface KennelDebateCandidateMember {
  readonly gouziId: string
  readonly generation: number
  readonly name: string
  readonly role: string
  /** Full registered execution entry the member runs on. */
  readonly operatorId: string
  /** Native model of that entry for this Debate: the member's pinned model or the entry's default. */
  readonly model: string
}

/** One Host-qualified Debate option; the model returns its identity only. */
export interface KennelDebateCandidate {
  readonly kind: 'debate'
  readonly id: string
  readonly workspace: string
  /** Distinct members in the order the Provider assigns roles. */
  readonly members: readonly KennelDebateCandidateMember[]
}

type ExecutionEntry = Awaited<ReturnType<GouziControl['executionOperators']>>[number]

/**
 * Pick the execution entry and model a member would run a Debate on.
 * @param member - enabled member being considered.
 * @param entry - the member's current registered execution entries.
 * @returns the entry and model, or undefined when no available entry can run the member's pinned model.
 */
function binding(member: GouziMemberView, entry: ExecutionEntry): { operatorId: string; model: string } | undefined {
  for (const operator of entry.operators) {
    if (!operator.available || operator.supportsGenerationLimits !== true) continue
    if (member.model !== undefined && !operator.models.includes(member.model)) continue
    const model = member.model ?? operator.defaultModel ?? operator.models[0]
    if (model !== undefined) return { operatorId: operator.operatorId, model }
  }
  return undefined
}

/**
 * Offer one Debate per project that enough members can argue.
 * Members are taken in registry order and the first `maxMembers` of them argue; the Provider assigns roles in that
 * order, so the judge is never a member who also argued.
 * @param members - every registered member.
 * @param entries - current registered execution entries.
 * @param bounds - fewest and most members a Debate takes.
 * @returns one candidate per project with at least `bounds.min` qualified members.
 */
export function kennelDebateCandidates(
  members: readonly GouziMemberView[],
  entries: readonly ExecutionEntry[],
  bounds: { readonly min: number; readonly max: number },
): KennelDebateCandidate[] {
  const byWorkspace = new Map<string, KennelDebateCandidateMember[]>()
  for (const member of members) {
    if (member.membership !== 'enabled') continue
    const entry = entries.find(value => value.gouziId === member.gouziId && value.generation === member.generation)
    const chosen = entry === undefined ? undefined : binding(member, entry)
    if (entry === undefined || chosen === undefined) continue
    for (const workspace of entry.projectScopes) {
      byWorkspace.set(workspace, [...byWorkspace.get(workspace) ?? [], {
        gouziId: String(member.gouziId), generation: member.generation, name: member.name, role: member.role, ...chosen,
      }])
    }
  }
  return [...byWorkspace].flatMap(([workspace, qualified]) => {
    if (qualified.length < bounds.min) return []
    const chosen = qualified.slice(0, bounds.max)
    return [{
      kind: 'debate' as const,
      id: JSON.stringify(['debate', workspace, ...chosen.map(value => [value.gouziId, value.generation])]),
      workspace,
      members: chosen,
    }]
  })
}
