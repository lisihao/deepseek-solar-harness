/** The review conclusion convention: what a reviewer writes, how it is read, and how several reviewers add up. */
import type {
  KennelCollaborationCandidate,
  KennelCollaborationOutcome,
  KennelCollaborationRecord,
  KennelCollaborationResult,
  OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import { KENNEL_REREVIEW_KIND } from './kinds.ts'

const APPROVE_WORD = '通过'
const CHANGES_WORD = '需要修改'
/** First line of a review that finds nothing to change. */
export const APPROVE_LINE = `结论：${APPROVE_WORD}`
/** First line of a review that asks for changes. */
export const CHANGES_LINE = `结论：${CHANGES_WORD}`
const CONCLUSION = new RegExp(`^结论\\s*[:：]\\s*(${APPROVE_WORD}|${CHANGES_WORD})$`, 'u')

/** The finished task a review candidate names. */
export interface ReviewTarget {
  readonly runId: string
  readonly title: string
  readonly authors: readonly string[]
}

/** What one reviewer concluded. */
export interface ReviewVerdict {
  readonly gouziId: string
  readonly name: string
  readonly verdict: 'approved' | 'changes' | 'unclear'
  /** The reviewer's comments, without the conclusion line. */
  readonly comment: string
}

/**
 * Id of the node that carries one reviewer's work, in candidate member order.
 * @param index - zero-based position of the reviewer in the candidate.
 * @returns the node id.
 */
export function reviewNodeId(index: number): string {
  return `review-${String(index + 1)}`
}

/**
 * Read the task a review candidate names.
 * @param candidate - a candidate this kind offered.
 * @returns the task.
 */
export function targetOf(candidate: KennelCollaborationCandidate): ReviewTarget {
  const target = candidate.details.target as Partial<ReviewTarget> | undefined
  if (typeof target?.runId !== 'string' || typeof target.title !== 'string' || !Array.isArray(target.authors)) {
    throw new Error(`review candidate ${candidate.id} does not name a finished task`)
  }
  return { runId: target.runId, title: target.title, authors: target.authors as string[] }
}

const VERDICT_LABEL: Record<ReviewVerdict['verdict'], string> = { approved: '通过', changes: '需要修改', unclear: '结论不明' }

/** Comments from an earlier review that a repeated review checks again. */
export interface PreviousComment {
  readonly name: string
  readonly comment: string
}

/**
 * Read the earlier comments a candidate asks its reviewers to check again.
 * @param candidate - a review or repeated-review candidate.
 * @returns the comments, empty for a first review.
 */
export function previousOf(candidate: KennelCollaborationCandidate): readonly PreviousComment[] {
  const previous = candidate.details.previous as readonly PreviousComment[] | undefined
  return previous ?? []
}

/**
 * Read a reviewer's conclusion from the first line of its reply.
 * @param text - the reply.
 * @returns the conclusion, `unclear` when the first line is neither conclusion line, and the rest of the reply.
 */
export function parseConclusion(text: string): { verdict: ReviewVerdict['verdict']; comment: string } {
  const [first = '', ...rest] = text.trim().split('\n')
  const word = CONCLUSION.exec(first.trim())?.[1]
  if (word === undefined) return { verdict: 'unclear', comment: text.trim() }
  return { verdict: word === APPROVE_WORD ? 'approved' : 'changes', comment: rest.join('\n').trim() }
}

/**
 * Add up the reviewers of one review. One reviewer asking for changes is enough to ask for changes; approval needs every
 * reviewer, and a reviewer who failed or did not state a conclusion leaves the review unclear.
 * @param record - the review the dispatcher started.
 * @param run - its current run.
 * @param results - final text of each node of the run.
 * @returns the outcome for the reviewed task.
 */
export function reviewOutcome(
  record: Omit<KennelCollaborationRecord, 'outcome'>,
  run: OrchestrationRunSnapshot,
  results: readonly KennelCollaborationResult[],
): KennelCollaborationOutcome {
  const target = targetOf(record.candidate)
  const names = (verdicts: readonly ReviewVerdict[]) => verdicts.map(value => value.name).join('、')
  const verdicts = record.candidate.members.map((member, index): ReviewVerdict => {
    const result = results.find(value => value.nodeId === reviewNodeId(index))
    const read = result?.accepted === true ? parseConclusion(result.text) : { verdict: 'unclear' as const, comment: '' }
    return { gouziId: member.gouziId, name: member.name, ...read }
  })
  const details = { verdicts, review: record.runId }
  // The room shows each reviewer's conclusion beside the member, and the comments under it.
  const parts = verdicts.map(value => ({ gouziId: value.gouziId, label: VERDICT_LABEL[value.verdict], text: value.comment }))
  const word = record.collaboration === KENNEL_REREVIEW_KIND ? '复审' : '评审'
  if (run.state !== 'completed' && run.state !== 'failed' && run.state !== 'cancelled' && run.state !== 'indeterminate') {
    return { subjectRunId: target.runId, state: 'pending', label: `${word}中（${names(verdicts)}）`, parts, details }
  }
  const changes = verdicts.filter(value => value.verdict === 'changes')
  if (changes.length > 0) return { subjectRunId: target.runId, state: 'negative', label: `${word}：待修改（${names(changes)}）`, parts, details }
  const unclear = verdicts.filter(value => value.verdict !== 'approved')
  if (unclear.length > 0) return { subjectRunId: target.runId, state: 'unclear', label: `${word}：结论不明（${names(unclear)}）`, parts, details }
  return { subjectRunId: target.runId, state: 'positive', label: `${word}：已通过（${names(verdicts)}）`, parts, details }
}
