/** Reading a reviewer's conclusion and adding up several reviewers. */

import type { KennelCollaborationCandidate, KennelCollaborationResult, OrchestrationRunSnapshot } from '@deepseek-ai/dsh-orchestration'
import { describe, expect, it } from 'vitest'
import { isReview } from '../src/kinds.ts'
import { APPROVE_LINE, CHANGES_LINE, parseConclusion, previousOf, reviewNodeId, reviewOutcome } from '../src/verdict.ts'

describe('parseConclusion', () => {
  it('reads the conclusion from the first line and keeps the comments', () => {
    expect(parseConclusion(`${APPROVE_LINE}\n- 核对了 src/a.ts`)).toEqual({ verdict: 'approved', comment: '- 核对了 src/a.ts' })
    expect(parseConclusion(`${CHANGES_LINE}\n- src/a.ts:3 没处理空输入\n- 缺测试`)).toEqual({
      verdict: 'changes', comment: '- src/a.ts:3 没处理空输入\n- 缺测试',
    })
  })

  it('tolerates surrounding whitespace, blank lines before it, and an ASCII colon', () => {
    expect(parseConclusion(`\n  ${APPROVE_LINE}  \n\nok`)).toEqual({ verdict: 'approved', comment: 'ok' })
    expect(parseConclusion('结论: 需要修改\n意见')).toEqual({ verdict: 'changes', comment: '意见' })
    expect(parseConclusion(APPROVE_LINE)).toEqual({ verdict: 'approved', comment: '' })
  })

  it('does not read a conclusion that is not alone on the first line', () => {
    for (const text of ['', '通过', '我认为结论：通过', `${APPROVE_LINE}，但是有问题`, `看了一下\n${CHANGES_LINE}`, '结论：不确定']) {
      expect(parseConclusion(text)).toEqual({ verdict: 'unclear', comment: text.trim() })
    }
  })
})

const run = (state: string) => ({ runId: 'review-run', state }) as unknown as OrchestrationRunSnapshot
const candidate: KennelCollaborationCandidate = {
  kind: 'collaboration', collaboration: 'review', id: 'review', workspace: '/project',
  members: ['x', 'y'].map(id => ({ gouziId: id, generation: 1, name: id.toUpperCase(), role: 'research', operatorId: `gouzi.${id}.codex`, model: 'm' })),
  details: { target: { runId: 'task-1', title: 'Write the parser', authors: ['AUTHOR'] } },
}
const record = { collaboration: 'review', runId: 'review-run', messageId: 'm', candidate }
const reply = (index: number, text: string, accepted = true): KennelCollaborationResult => ({ nodeId: reviewNodeId(index), accepted, text })

describe('isReview', () => {
  it('counts first and repeated reviews and nothing else', () => {
    expect(['review', 'rereview'].map(isReview)).toEqual([true, true])
    expect(['rework', 'debate', ''].map(isReview)).toEqual([false, false, false])
  })
})

describe('reviewOutcome', () => {
  it('words a repeated review as a rereview', () => {
    const again = { ...record, collaboration: 'rereview' }
    expect(reviewOutcome(again, run('running'), []).label).toBe('复审中（X、Y）')
    expect(reviewOutcome(again, run('completed'), [reply(0, CHANGES_LINE), reply(1, APPROVE_LINE)]).label).toBe('复审：待修改（X）')
    expect(reviewOutcome(again, run('completed'), [reply(0, APPROVE_LINE)]).label).toBe('复审：结论不明（Y）')
    expect(reviewOutcome(again, run('completed'), [reply(0, APPROVE_LINE), reply(1, APPROVE_LINE)]).label).toBe('复审：已通过（X、Y）')
  })

  it('reads the earlier comments a repeated review checks, none for a first review', () => {
    expect(previousOf(candidate)).toEqual([])
    expect(previousOf({ ...candidate, details: { ...candidate.details, previous: [{ name: 'X', comment: 'c' }] } })).toEqual([{ name: 'X', comment: 'c' }])
  })

  it('names reviewer nodes by position', () => {
    expect([0, 1, 9].map(reviewNodeId)).toEqual(['review-1', 'review-2', 'review-10'])
  })

  it('is pending until the run settles, whatever has been said so far', () => {
    for (const state of ['running', 'paused', 'awaiting_approval', 'awaiting_clarification']) {
      expect(reviewOutcome(record, run(state), [reply(0, APPROVE_LINE)])).toMatchObject({ subjectRunId: 'task-1', state: 'pending', label: '评审中（X、Y）' })
    }
  })

  it('approves only when every reviewer approves', () => {
    const outcome = reviewOutcome(record, run('completed'), [reply(0, `${APPROVE_LINE}\n好`), reply(1, APPROVE_LINE)])
    expect(outcome).toMatchObject({ state: 'positive', label: '评审：已通过（X、Y）' })
    expect(outcome.details).toEqual({
      review: 'review-run',
      verdicts: [
        { gouziId: 'x', name: 'X', verdict: 'approved', comment: '好' },
        { gouziId: 'y', name: 'Y', verdict: 'approved', comment: '' },
      ],
    })
  })

  it('asks for changes when any reviewer does, and names who', () => {
    const outcome = reviewOutcome(record, run('completed'), [reply(0, APPROVE_LINE), reply(1, `${CHANGES_LINE}\n缺测试`)])
    expect(outcome).toMatchObject({ state: 'negative', label: '评审：待修改（Y）' })
    expect(outcome.details.verdicts).toEqual([
      expect.objectContaining({ gouziId: 'x', verdict: 'approved' }),
      { gouziId: 'y', name: 'Y', verdict: 'changes', comment: '缺测试' },
    ])
    // A request for changes outweighs a reviewer who said nothing usable.
    expect(reviewOutcome(record, run('completed'), [reply(0, '随便'), reply(1, CHANGES_LINE)]).state).toBe('negative')
  })

  it('is unclear when a reviewer gave no conclusion, failed, or never answered, or the run did not complete', () => {
    expect(reviewOutcome(record, run('completed'), [reply(0, APPROVE_LINE), reply(1, '看起来不错')])).toMatchObject({ state: 'unclear', label: '评审：结论不明（Y）' })
    expect(reviewOutcome(record, run('completed'), [reply(0, APPROVE_LINE), reply(1, APPROVE_LINE, false)])).toMatchObject({ state: 'unclear', label: '评审：结论不明（Y）' })
    expect(reviewOutcome(record, run('completed'), [reply(0, APPROVE_LINE)])).toMatchObject({ state: 'unclear', label: '评审：结论不明（Y）' })
    for (const state of ['failed', 'cancelled', 'indeterminate']) {
      expect(reviewOutcome(record, run(state), [reply(0, APPROVE_LINE), reply(1, APPROVE_LINE)])).toMatchObject({ state: 'positive' })
      expect(reviewOutcome(record, run(state), [])).toMatchObject({ state: 'unclear', label: '评审：结论不明（X、Y）' })
    }
  })
})
