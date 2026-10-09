/** Rework: which reviews with requested changes hand the task back to its author, and the task it starts. */

import { Context } from '@deepseek-ai/cordis'
import type {
  KennelCollaborationCandidate, KennelCollaborationFacts, KennelCollaborationRecord, KennelCollaborationRequest, KennelWorkOffer,
} from '@deepseek-ai/dsh-orchestration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kennelReworkKind, KENNEL_REWORK_KIND } from '../src/rework.ts'
import { CHANGES_LINE } from '../src/verdict.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

const author: KennelWorkOffer = {
  id: '["author",1,"/project","write"]', gouziId: 'author', generation: 1, name: 'Author', role: 'coder', activity: 'idle',
  workspace: '/project', mode: 'write', operatorIds: ['gouzi.author.codex'], model: 'gpt-5.6-sol',
}
const verdicts = [
  { gouziId: 'x', name: 'X', verdict: 'changes', comment: '没处理空输入' },
  { gouziId: 'y', name: 'Y', verdict: 'approved', comment: '好' },
]
const reviewCandidate: KennelCollaborationCandidate = {
  kind: 'collaboration', collaboration: 'review', id: 'review', workspace: '/project', members: [], details: {},
}

function review(patch: Partial<KennelCollaborationRecord> & { subject?: string; state?: 'negative' | 'positive' } = {}): KennelCollaborationRecord {
  const { subject = 'task-1', state = 'negative', ...rest } = patch
  return {
    collaboration: 'review', runId: 'review-1', messageId: 'm1', candidate: reviewCandidate,
    outcome: { subjectRunId: subject, state, label: 'l', details: { verdicts } }, ...rest,
  }
}

function rework(reviewRun: string, runId: string, offer = author): KennelCollaborationRecord {
  return {
    collaboration: KENNEL_REWORK_KIND, runId, messageId: 'm2',
    candidate: { ...reviewCandidate, collaboration: KENNEL_REWORK_KIND, details: { review: reviewRun, offer, target: { runId: 'task-1', title: 't' }, comments: [] } },
  }
}

function facts(patch: Partial<KennelCollaborationFacts> = {}): KennelCollaborationFacts {
  return {
    sessionId: 's', members: [], entries: [], runs: [{ runId: 'task-1', title: 'Write the parser' } as never],
    workOffers: [author], work: [{ runId: 'task-1', offer: author }], earlier: [review()], mentioned: [], ...patch,
  }
}

const offer = (value: KennelCollaborationFacts) => kennelReworkKind(new Context()).offer(value) as KennelCollaborationCandidate[]

describe('rework offers', () => {
  it('hands a reviewed task back to the member that did it, with the comments that asked for changes', () => {
    const offered = offer(facts())
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({
      kind: 'collaboration', collaboration: 'rework', workspace: '/project',
      members: [{ gouziId: 'author', generation: 1, name: 'Author', operatorId: 'gouzi.author.codex', model: 'gpt-5.6-sol' }],
      details: {
        review: 'review-1', target: { runId: 'task-1', title: 'Write the parser' }, offer: author,
        comments: [{ name: 'X', comment: '没处理空输入' }],
      },
    })
    // The id names the review and everything the member offer depends on.
    expect(offered[0]?.id).toBe(JSON.stringify(['rework', 'review-1', author.id, author.operatorIds, 'gpt-5.6-sol']))
  })

  it('marks an unpinned member as automatic', () => {
    const { model: _model, ...unpinned } = author
    const [candidate] = offer(facts({ workOffers: [unpinned], work: [{ runId: 'task-1', offer: unpinned }] }))
    expect(candidate?.members[0]?.model).toBe('auto')
    expect(candidate?.id).toContain('null')
  })

  it('offers nothing for reviews that did not ask for changes or have no outcome', () => {
    expect(offer(facts({ earlier: [review({ state: 'positive' })] }))).toEqual([])
    expect(offer(facts({ earlier: [{ ...review(), outcome: undefined } as never] }))).toEqual([])
    expect(offer(facts({ earlier: [{ ...review(), collaboration: 'debate' }] }))).toEqual([])
    expect(offer(facts({ earlier: [] }))).toEqual([])
  })

  it('offers a review once, however many times the user asks', () => {
    expect(offer(facts({ earlier: [review(), rework('review-1', 'rework-run')] }))).toEqual([])
    // Another review of the same task is a different review and is offered.
    expect(offer(facts({ earlier: [review(), review({ runId: 'review-2' }), rework('review-1', 'rework-run')] })).map(value => value.details.review)).toEqual(['review-2'])
  })

  it('needs the Host to still offer the same member on the same project in the same mode', () => {
    expect(offer(facts({ workOffers: [] }))).toEqual([])
    expect(offer(facts({ workOffers: [{ ...author, generation: 2 }] }))).toEqual([])
    expect(offer(facts({ workOffers: [{ ...author, mode: 'read' }] }))).toEqual([])
    expect(offer(facts({ workOffers: [{ ...author, workspace: '/other' }] }))).toEqual([])
    // A changed entry or model is a changed offer id, so the dispatcher refuses a stale choice.
    expect(offer(facts({ workOffers: [{ ...author, operatorIds: ['gouzi.author.claude-code'] }] }))[0]?.id).toContain('claude-code')
  })

  it('needs to know who did the task and to still see the task', () => {
    expect(offer(facts({ work: [] }))).toEqual([])
    expect(offer(facts({ runs: [] }))).toEqual([])
  })

  it('follows a task that was itself a rework back to the offer that took it', () => {
    const later = { ...author, id: '["author",1,"/project","write"]b' }
    const chain = facts({
      work: [], workOffers: [author],
      earlier: [rework('review-0', 'task-1', author), review({ runId: 'review-3' })],
    })
    const [candidate] = offer(chain)
    expect(candidate?.details.review).toBe('review-3')
    expect(later.id).not.toBe(author.id)
  })
})

function service() {
  const compile = vi.fn(async (_request: unknown) => ({ compilationId: 'compiled' }))
  const start = vi.fn(async (_request: unknown) => ({ runId: 'rework-run' }))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('orchestrations', { compile, start } as never)
  const workGraph = vi.fn((input: { offer: KennelWorkOffer; text: string }) => ({ version: 1, title: 'graph', workspace: input.offer.workspace }) as never)
  return { ctx, compile, start, workGraph }
}

function chosen(workGraph: KennelCollaborationRequest['workGraph'], patch: Partial<KennelCollaborationRequest> = {}): KennelCollaborationRequest {
  const [candidate] = offer(facts())
  return {
    commandId: 'kennel:rework:s:m', sessionId: 's', messageId: 'm', prompt: '按评审意见改一下', candidate: candidate!,
    limits: {
      contextTokens: 1, taskTimeoutMs: 1, titleMaxChars: 1,
      generationLimits: { maxTokens: 1, maxOutputBytes: 1 }, workspaceToolLimits: {} as never,
    },
    workGraph, ...patch,
  }
}

describe('rework start', () => {
  it('has the author take the task again through the Host\'s own graph, admitted to that one member', async () => {
    const { ctx, compile, start, workGraph } = service()
    const runtimeContext = { version: 1 as const, sourceSessionId: 's', contextSnapshotMessageId: 'ctx', sections: [] }
    const started = await kennelReworkKind(ctx).start(chosen(workGraph, { runtimeContext }))

    expect(started).toEqual({ runId: 'rework-run', assignments: [{ gouziId: 'author', role: 'author' }] })
    const [{ offer: given, text }] = workGraph.mock.calls[0]!
    expect(given).toEqual(author)
    expect(text).toContain('「Author」')
    expect(text).toContain('任务：Write the parser'.replace('任务：', ''))
    expect(text).toContain('- X：\n没处理空输入')
    expect(text).not.toContain('好')
    expect(text).toContain('按评审意见改一下')
    expect(compile).toHaveBeenCalledWith({
      intent: { request: '按评审意见改一下' },
      graph: { version: 1, title: 'graph', workspace: '/project' },
      admission: {
        policy: 'auto', route: 'taskgraph', sourceSessionId: 's', sourceMessageId: 'm', runtimeContext,
        gouziRecipient: { gouziId: 'author', generation: 1, operatorIds: ['gouzi.author.codex'] },
        rlm: 'disabled', autonomous: 'disabled',
      },
    })
    expect(start).toHaveBeenCalledWith({ commandId: 'kennel:rework:s:m', compilationId: 'compiled' })
  })

  it('omits an absent runtime context and refuses a candidate that names no review', async () => {
    const { ctx, compile, workGraph } = service()
    await kennelReworkKind(ctx).start(chosen(workGraph))
    expect((compile.mock.calls[0]![0] as { admission: Record<string, unknown> }).admission.runtimeContext).toBeUndefined()
    const request = chosen(workGraph)
    for (const details of [{}, { review: 'r' }, { review: 'r', offer: author, target: { runId: 't', title: 't' }, comments: 'x' }]) {
      await expect(kennelReworkKind(ctx).start({ ...request, candidate: { ...request.candidate, details } })).rejects.toThrow('does not name a review')
    }
  })

  it('reports where the rework stands on the task it reworks, without approving it', () => {
    const kind = kennelReworkKind(new Context())
    const [candidate] = offer(facts())
    const record = { collaboration: 'rework', runId: 'rework-run', messageId: 'm', candidate: candidate! }
    const outcome = (state: string) => kind.outcome!(record, { runId: 'rework-run', state } as never, [])
    for (const state of ['running', 'paused', 'awaiting_approval']) {
      expect(outcome(state)).toEqual({ subjectRunId: 'task-1', state: 'pending', label: '返工中（Author）', details: { rework: 'rework-run' } })
    }
    expect(outcome('completed')).toMatchObject({ subjectRunId: 'task-1', state: 'unclear', label: '已按评审意见返工（Author），待再次评审' })
    for (const state of ['failed', 'cancelled', 'indeterminate']) expect(outcome(state)).toMatchObject({ state: 'unclear', label: '返工未完成（Author）' })
  })

  it('tells the model when to choose it', () => {
    const kind = kennelReworkKind(new Context())
    expect(kind.kind).toBe('rework')
    expect(kind.guidance).toContain('评审意见')
    expect(CHANGES_LINE).toContain('需要修改')
  })
})
