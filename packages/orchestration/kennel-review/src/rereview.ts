/** Rereview: the reviewers of a task check it again after its author reworked it from their comments. */
import type { Context } from '@deepseek-ai/cordis'
import {
  admissionGouziRecipients,
  qualifiedKennelMembers,
  type KennelCollaborationCandidate,
  type KennelCollaborationFacts,
  type KennelCollaborationKind,
} from '@deepseek-ai/dsh-orchestration'
import { isReview, KENNEL_REREVIEW_KIND, KENNEL_REWORK_KIND } from './kinds.ts'
import { reviewable, startReview } from './review.ts'
import { reworkDetails } from './rework.ts'
import { reviewOutcome, targetOf, type PreviousComment, type ReviewTarget, type ReviewVerdict } from './verdict.ts'

function offer(facts: KennelCollaborationFacts): KennelCollaborationCandidate[] {
  // Naming reviewers, or addressing one member, is an ordinary review of the reworked task.
  if (facts.recipient !== undefined || facts.mentioned.length > 0) return []
  const reviewed = new Set(facts.earlier.filter(value => isReview(value.collaboration)).map(value => targetOf(value.candidate).runId))
  return facts.earlier.flatMap((rework) => {
    if (rework.collaboration !== KENNEL_REWORK_KIND || reviewed.has(rework.runId)) return []
    const run = facts.runs.find(value => String(value.runId) === rework.runId)
    const original = facts.earlier.find(value => isReview(value.collaboration) && value.runId === reworkDetails(rework.candidate).review)
    if (run === undefined || original === undefined || !reviewable(run)) return []
    const authorIds = new Set(admissionGouziRecipients(run.admission).map(author => String(author.gouziId)))
    const qualified = qualifiedKennelMembers(facts, run.workspace, { workspacePolicy: true })
      .filter(member => !authorIds.has(member.gouziId))
    // The same reviewers, in the same order; one who can no longer review leaves nothing to offer rather than a different batch.
    const members = original.candidate.members.map(member =>
      qualified.find(value => value.gouziId === member.gouziId && value.generation === member.generation))
    if (members.some(member => member === undefined)) return []
    const verdicts = (original.outcome?.details.verdicts ?? []) as readonly ReviewVerdict[]
    const previous: PreviousComment[] = verdicts.filter(value => value.verdict === 'changes')
      .map(value => ({ name: value.name, comment: value.comment }))
    const names = facts.members.filter(member => authorIds.has(String(member.gouziId))).map(member => member.name)
    return [{
      kind: 'collaboration' as const,
      collaboration: KENNEL_REREVIEW_KIND,
      id: JSON.stringify([KENNEL_REREVIEW_KIND, String(run.runId), run.revision, run.workspace, original.runId,
        ...members.map(member => [member?.gouziId, member?.generation, member?.operatorId, member?.model])]),
      workspace: run.workspace,
      members: members.flatMap(member => member === undefined ? [] : [member]),
      details: {
        target: { runId: String(run.runId), title: run.title, authors: names } satisfies ReviewTarget,
        previous,
        review: original.runId,
      },
    }]
  })
}

/**
 * Describe the rereview kind for the kennel registry.
 * @param ctx - context holding the orchestration service.
 * @returns the kind to register.
 */
export function kennelRereviewKind(ctx: Context): KennelCollaborationKind {
  return {
    kind: KENNEL_REREVIEW_KIND,
    label: '复审',
    roleLabels: { reviewer: '评审人' },
    guidance: '用户要求让原来的评审人复审返工后的结果、再看一遍修改有没有解决意见时选它；评审人就是上一轮评审的那些狗子，候选里就是他们；它只读不改文件，只在返工完成之后出现；用户点了别的评审人时选评审而不是复审',
    offer,
    start: request => startReview(ctx, request),
    outcome: reviewOutcome,
  }
}
