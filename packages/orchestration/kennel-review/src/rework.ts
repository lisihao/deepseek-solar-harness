/** Rework: the author of a task takes another round with the comments of a review that asked for changes. */
import type { Context } from '@deepseek-ai/cordis'
import { PhysicalOperatorId } from '@deepseek-ai/dsh-physical-operator'
import {
  GouziId,
  type KennelCollaborationCandidate,
  type KennelCollaborationFacts,
  type KennelCollaborationOutcome,
  type KennelCollaborationKind,
  type KennelCollaborationRecord,
  type KennelCollaborationRequest,
  type KennelCollaborationStarted,
  type KennelWorkOffer,
  type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import { KENNEL_REVIEW_KIND } from './review.ts'
import type { ReviewVerdict } from './verdict.ts'

/** Name this kind registers under. */
export const KENNEL_REWORK_KIND = 'rework'
const AUTHOR_ROLE = 'author'

/** What a rework candidate keeps in its details. */
interface ReworkDetails {
  /** Run of the review whose comments the author receives. */
  readonly review: string
  readonly target: { readonly runId: string; readonly title: string }
  readonly offer: KennelWorkOffer
  readonly comments: readonly { readonly name: string; readonly comment: string }[]
}

function detailsOf(candidate: KennelCollaborationCandidate): ReworkDetails {
  const details = candidate.details as Partial<ReworkDetails>
  if (typeof details.review !== 'string' || details.offer === undefined || details.target === undefined || !Array.isArray(details.comments)) {
    throw new Error(`rework candidate ${candidate.id} does not name a review`)
  }
  return details as ReworkDetails
}

/** The offer that took a task: its own dispatch, or the rework that produced it. */
function authorOffer(facts: KennelCollaborationFacts, runId: string): KennelWorkOffer | undefined {
  const dispatched = facts.work.find(value => value.runId === runId)
  if (dispatched !== undefined) return dispatched.offer
  const rework = facts.earlier.find(value => value.collaboration === KENNEL_REWORK_KIND && value.runId === runId)
  return rework === undefined ? undefined : detailsOf(rework.candidate).offer
}

function offer(facts: KennelCollaborationFacts): KennelCollaborationCandidate[] {
  const reworked = new Set(facts.earlier.filter(value => value.collaboration === KENNEL_REWORK_KIND)
    .map(value => detailsOf(value.candidate).review))
  return facts.earlier.flatMap((record: KennelCollaborationRecord) => {
    if (record.collaboration !== KENNEL_REVIEW_KIND || record.outcome?.state !== 'negative' || reworked.has(record.runId)) return []
    const taken = authorOffer(facts, record.outcome.subjectRunId)
    // Only the member that did the task reworks it, on the same project and in the same mode, if the Host still offers that.
    const current = taken === undefined ? undefined : facts.workOffers.find(value => value.gouziId === taken.gouziId
      && value.generation === taken.generation && value.workspace === taken.workspace && value.mode === taken.mode)
    const target = facts.runs.find(run => String(run.runId) === record.outcome?.subjectRunId)
    if (current === undefined || target === undefined) return []
    const verdicts = (record.outcome.details.verdicts ?? []) as readonly ReviewVerdict[]
    const details: ReworkDetails = {
      review: record.runId, target: { runId: String(target.runId), title: target.title }, offer: current,
      comments: verdicts.filter(value => value.verdict === 'changes').map(value => ({ name: value.name, comment: value.comment })),
    }
    return [{
      kind: 'collaboration' as const,
      collaboration: KENNEL_REWORK_KIND,
      id: JSON.stringify([KENNEL_REWORK_KIND, record.runId, current.id, current.operatorIds, current.model ?? null]),
      workspace: current.workspace,
      members: [{
        gouziId: current.gouziId, generation: current.generation, name: current.name, role: current.role,
        operatorId: current.operatorIds[0] ?? '', model: current.model ?? 'auto',
      }],
      details: { ...details },
    }]
  })
}

function task(details: ReworkDetails, prompt: string): string {
  const comments = details.comments.map(value => `- ${value.name}：\n${value.comment}`).join('\n')
  return [
    `你是狗窝成员「${details.offer.name}」。你之前完成的任务：${details.target.title}`,
    `评审人要求修改，意见如下：\n${comments}`,
    '请按这些意见修改，并说明你改了什么、没有改什么以及原因。',
    `用户的要求：${prompt}`,
  ].join('\n\n')
}

async function start(ctx: Context, request: KennelCollaborationRequest): Promise<KennelCollaborationStarted> {
  const details = detailsOf(request.candidate)
  const { offer: taken } = details
  const compilation = await ctx.orchestrations.compile({
    intent: { request: request.prompt },
    graph: request.workGraph({ offer: taken, text: task(details, request.prompt) }),
    admission: {
      policy: 'auto', route: 'taskgraph', sourceSessionId: request.sessionId, sourceMessageId: request.messageId,
      ...request.runtimeContext === undefined ? {} : { runtimeContext: request.runtimeContext },
      gouziRecipient: {
        gouziId: GouziId(taken.gouziId), generation: taken.generation, operatorIds: taken.operatorIds.map(PhysicalOperatorId),
      },
      rlm: 'disabled', autonomous: 'disabled',
    },
  })
  const run = await ctx.orchestrations.start({ commandId: request.commandId, compilationId: compilation.compilationId })
  return { runId: String(run.runId), assignments: [{ gouziId: taken.gouziId, role: AUTHOR_ROLE }] }
}

/**
 * Say where a rework stands on the task it reworks, so the room does not show only the review that asked for it.
 * It states progress, not a verdict: only a new review of the reworked task can approve it.
 * @param record - the rework the dispatcher started.
 * @param run - its current run.
 * @returns the outcome for the original task.
 */
function outcome(record: Omit<KennelCollaborationRecord, 'outcome'>, run: OrchestrationRunSnapshot): KennelCollaborationOutcome {
  const { target, offer: taken } = detailsOf(record.candidate)
  const base = { subjectRunId: target.runId, details: { rework: record.runId } }
  if (run.state === 'completed') return { ...base, state: 'unclear', label: `已按评审意见返工（${taken.name}），待再次评审` }
  if (run.state === 'failed' || run.state === 'cancelled' || run.state === 'indeterminate') {
    return { ...base, state: 'unclear', label: `返工未完成（${taken.name}）` }
  }
  return { ...base, state: 'pending', label: `返工中（${taken.name}）` }
}

/**
 * Describe the rework kind for the kennel registry.
 * @param ctx - context holding the orchestration service.
 * @returns the kind to register.
 */
export function kennelReworkKind(ctx: Context): KennelCollaborationKind {
  return {
    kind: KENNEL_REWORK_KIND,
    guidance: '用户要求按评审意见修改、返工，或让做这个任务的狗子处理评审提出的问题时选它；它让原作者带着评审意见再做一轮，只在评审结论是“需要修改”之后出现',
    offer,
    start: request => start(ctx, request),
    outcome,
  }
}
