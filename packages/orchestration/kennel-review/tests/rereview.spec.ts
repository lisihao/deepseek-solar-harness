/** Rereview: which reworked tasks go back to their first reviewers, and the review it starts. */

import { Context } from '@deepseek-ai/cordis'
import type {
  KennelCollaborationCandidate, KennelCollaborationFacts, KennelCollaborationRecord, KennelCollaborationRequest,
} from '@deepseek-ai/dsh-orchestration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kennelRereviewKind } from '../src/rereview.ts'
import { APPROVE_LINE, CHANGES_LINE } from '../src/verdict.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

const member = (id: string, generation = 1) =>
  ({ gouziId: id, generation, name: id.toUpperCase(), role: 'research', operatorId: `gouzi.${id}.codex`, model: 'm' })
const verdicts = [
  { gouziId: 'x', name: 'X', verdict: 'changes', comment: '没处理空输入' },
  { gouziId: 'y', name: 'Y', verdict: 'approved', comment: '好' },
]

/** The first review (reviewers x then y) and the rework it led to. */
function history(patch: Partial<Record<'review' | 'rework', Partial<KennelCollaborationRecord>>> = {}): KennelCollaborationRecord[] {
  const review: KennelCollaborationRecord = {
    collaboration: 'review', runId: 'review-1', messageId: 'm1',
    candidate: {
      kind: 'collaboration', collaboration: 'review', id: 'r', workspace: '/project', members: [member('x'), member('y')],
      details: { target: { runId: 'task-1', title: 'Write the parser', authors: ['AUTHOR'] } },
    },
    outcome: { subjectRunId: 'task-1', state: 'negative', label: 'l', details: { verdicts } }, ...patch.review,
  }
  const rework: KennelCollaborationRecord = {
    collaboration: 'rework', runId: 'task-2', messageId: 'm2',
    candidate: {
      kind: 'collaboration', collaboration: 'rework', id: 'w', workspace: '/project', members: [],
      details: { review: 'review-1', target: { runId: 'task-1', title: 't' }, offer: {}, comments: [] },
    }, ...patch.rework,
  }
  return [review, rework]
}

const reworkedRun = (patch: Record<string, unknown> = {}) => ({
  runId: 'task-2', title: 'Write the parser', workspace: '/project', state: 'completed', revision: 3,
  nodes: [{ id: 'work', state: 'passed' }],
  admission: { sourceSessionId: 's', gouziRecipient: { gouziId: 'author', generation: 1, operatorIds: ['gouzi.author.codex'] } }, ...patch,
})

function facts(patch: Partial<KennelCollaborationFacts> = {}, ids = ['author', 'x', 'y', 'z']): KennelCollaborationFacts {
  return {
    sessionId: 's', workOffers: [], work: [], mentioned: [], earlier: history(), runs: [reworkedRun() as never],
    members: ids.map(id => ({ gouziId: id, generation: 1, membership: 'enabled', name: id.toUpperCase(), role: 'research' })) as never,
    entries: ids.map(id => ({
      gouziId: id, generation: 1, projectScopes: ['/project'],
      operators: [{ operatorId: `gouzi.${id}.codex`, available: true, supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true, models: ['m'], defaultModel: 'm' }],
    })) as never,
    ...patch,
  }
}

const offer = (value: KennelCollaborationFacts) => kennelRereviewKind(new Context()).offer(value) as KennelCollaborationCandidate[]

describe('rereview offers', () => {
  it('sends a reworked task back to the same reviewers, in the same order, with the comments that asked for changes', () => {
    const offered = offer(facts())
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({
      kind: 'collaboration', collaboration: 'rereview', workspace: '/project',
      details: {
        target: { runId: 'task-2', title: 'Write the parser', authors: ['AUTHOR'] },
        previous: [{ name: 'X', comment: '没处理空输入' }], review: 'review-1',
      },
    })
    expect(offered[0]?.members.map(value => value.gouziId)).toEqual(['x', 'y'])
    expect(offered[0]?.id).toBe(JSON.stringify(['rereview', 'task-2', 3, '/project', 'review-1',
      ['x', 1, 'gouzi.x.codex', 'm'], ['y', 1, 'gouzi.y.codex', 'm']]))
  })

  it('also follows a repeated review, and tolerates a first review without a recorded outcome', () => {
    const again = history({ review: { collaboration: 'rereview' } })
    expect(offer(facts({ earlier: again }))).toHaveLength(1)
    const [first, second] = history()
    const { outcome: _outcome, ...withoutOutcome } = first!
    expect(offer(facts({ earlier: [withoutOutcome, second!] }))[0]?.details.previous).toEqual([])
  })

  it('waits until the reworked task has finished', () => {
    expect(offer(facts({ runs: [reworkedRun({ state: 'running' }) as never] }))).toEqual([])
    expect(offer(facts({ runs: [reworkedRun({ nodes: [{ id: 'work', state: 'failed' }] }) as never] }))).toEqual([])
    expect(offer(facts({ runs: [] }))).toEqual([])
  })

  it('offers each reworked task once, and not when the user already had it reviewed another way', () => {
    const reviewed: KennelCollaborationRecord = {
      collaboration: 'review', runId: 'review-2', messageId: 'm3',
      candidate: { kind: 'collaboration', collaboration: 'review', id: 'again', workspace: '/project', members: [member('z')], details: { target: { runId: 'task-2', title: 't', authors: [] } } },
    }
    expect(offer(facts({ earlier: [...history(), reviewed] }))).toEqual([])
    const repeated = { ...reviewed, collaboration: 'rereview', runId: 'rereview-1' }
    expect(offer(facts({ earlier: [...history(), repeated] }))).toEqual([])
  })

  it('needs the review the rework answered, and every first reviewer still able to review', () => {
    expect(offer(facts({ earlier: history().slice(1) }))).toEqual([])
    expect(offer(facts({ earlier: [history()[0]!, { ...history()[1]!, collaboration: 'debate' }] }))).toEqual([])
    // A reviewer who is gone, changed generation, or became the author leaves nothing to offer instead of a different batch.
    expect(offer(facts({}, ['author', 'x', 'z']))).toEqual([])
    const first = history()
    const moved = [{ ...first[0]!, candidate: { ...first[0]!.candidate, members: [member('x', 9), member('y')] } }, first[1]!]
    expect(offer(facts({ earlier: moved }))).toEqual([])
    expect(offer(facts({ runs: [reworkedRun({ admission: { sourceSessionId: 's', gouziRecipient: { gouziId: 'x', generation: 1, operatorIds: [] } } }) as never] }))).toEqual([])
  })

  it('leaves a message that names reviewers or addresses a member to an ordinary review', () => {
    expect(offer(facts({ mentioned: [{ gouziId: 'z', generation: 1, name: 'Z' }] }))).toEqual([])
    expect(offer(facts({ recipient: { gouziId: 'x', generation: 1 } }))).toEqual([])
  })
})

describe('rereview start', () => {
  it('starts a read-only review of the reworked task that carries the earlier comments to each reviewer', async () => {
    const compile = vi.fn(async (_request: unknown) => ({ compilationId: 'compiled' }))
    const start = vi.fn(async (_request: unknown) => ({ runId: 'rereview-run' }))
    const readEvents = vi.fn(async (request: { afterSequence?: number }) => request.afterSequence === 0
      ? { events: [{ type: 'node.evidence.accepted', nodeId: 'work', data: { outputPreview: 'The parser now bounds oversized input.' } }], nextSequence: 1 }
      : { events: [], nextSequence: 1 })
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('orchestrations', { compile, start, readEvents } as never)
    const [candidate] = offer(facts())
    const request: KennelCollaborationRequest = {
      commandId: 'kennel:rereview:s:m', sessionId: 's', messageId: 'm', prompt: '请复审', candidate: candidate!,
      limits: {
        contextTokens: 1, taskTimeoutMs: 1, titleMaxChars: 80,
        generationLimits: { maxTokens: 1, maxOutputBytes: 1 }, workspaceToolLimits: {} as never,
      },
      workGraph: () => { throw new Error('a review gives no member work') },
    }
    const started = await kennelRereviewKind(ctx).start(request)

    expect(started).toEqual({ runId: 'rereview-run', assignments: [{ gouziId: 'x', role: 'reviewer' }, { gouziId: 'y', role: 'reviewer' }] })
    const { graph, admission } = compile.mock.calls[0]![0] as {
      graph: { title: string; nodes: { id: string; title: string; task: string; writeScopes: string[] }[] }
      admission: Record<string, unknown>
    }
    expect(graph.title).toBe('复审：Write the parser')
    expect(graph.nodes.map(node => [node.id, node.title, node.writeScopes])).toEqual([['review-1', '复审：Write the parser', []], ['review-2', '复审：Write the parser', []]])
    for (const node of graph.nodes) {
      expect(node.task).toContain('复审')
      expect(node.task).toContain('- X：\n没处理空输入')
      expect(node.task).toContain('The parser now bounds oversized input.')
      expect(node.task).toContain('逐条核对上一轮的意见')
      expect(node.task).toContain(CHANGES_LINE)
      expect(node.task).toContain(APPROVE_LINE)
    }
    expect(admission).toMatchObject({ gouziRecipients: [{ gouziId: 'x' }, { gouziId: 'y' }], sourceMessageId: 'm' })
    expect(start).toHaveBeenCalledWith({ commandId: 'kennel:rereview:s:m', compilationId: 'compiled' })
  })

  it('tells the model when to choose it', () => {
    const kind = kennelRereviewKind(new Context())
    expect(kind.kind).toBe('rereview')
    expect(kind.guidance).toContain('复审')
    expect(typeof kind.outcome).toBe('function')
  })
})
