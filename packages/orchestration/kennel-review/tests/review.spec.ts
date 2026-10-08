/** The review kind: which finished tasks and reviewers it offers, and the read-only TaskGraph it starts. */

import { Context } from '@deepseek-ai/cordis'
import type {
  KennelCollaborationCandidate, KennelCollaborationFacts, KennelCollaborationKind, KennelCollaborationRequest, KennelCollaborations,
} from '@deepseek-ai/dsh-orchestration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as plugin from '../src/index.ts'
import { Config, KENNEL_REVIEW_KIND, kennelReviewKind, resolveConfig } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

interface RunOptions {
  runId?: string
  state?: string
  nodes?: { id: string; state: string }[]
  workspace?: string
  authors?: string[]
  title?: string
  revision?: number
}

function run(options: RunOptions = {}) {
  const authors = options.authors ?? ['author']
  const recipients = authors.map(id => ({ gouziId: id, generation: 1, operatorIds: [`gouzi.${id}.codex`] }))
  return {
    runId: options.runId ?? 'run-1', title: options.title ?? 'Write the parser', workspace: options.workspace ?? '/project',
    state: options.state ?? 'completed', revision: options.revision ?? 4,
    nodes: options.nodes ?? [{ id: 'work', state: 'passed' }],
    admission: authors.length === 0 ? { sourceSessionId: 's' }
      : authors.length === 1 ? { sourceSessionId: 's', gouziRecipient: recipients[0] } : { sourceSessionId: 's', gouziRecipients: recipients },
  } as never
}

/** Members that each hold /project on a codex entry that can read files, plus extra overrides per member. */
function facts(
  ids: string[], patch: Partial<KennelCollaborationFacts> = {}, entry: Record<string, unknown> = {},
): KennelCollaborationFacts {
  return {
    sessionId: 's', runs: [run()],
    members: ids.map(id => ({ gouziId: id, generation: 1, membership: 'enabled', name: id.toUpperCase(), role: 'research' })) as never,
    entries: ids.map(id => ({
      gouziId: id, generation: 1, projectScopes: ['/project'],
      operators: [{ operatorId: `gouzi.${id}.codex`, available: true, supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true,
        models: ['gpt-5.6-luna'], defaultModel: 'gpt-5.6-luna', ...entry }],
    })) as never,
    ...patch,
  }
}

const defaults = resolveConfig({})
const offer = (value: KennelCollaborationFacts, config = defaults) =>
  kennelReviewKind(new Context(), config).offer(value) as Promise<KennelCollaborationCandidate[]> | KennelCollaborationCandidate[]

describe('review kind offers', () => {
  it('names a finished task, its authors, and up to two members who did not do it, in registry order', async () => {
    const offered = await offer(facts(['author', 'x', 'y', 'z']))
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({
      kind: 'collaboration', collaboration: KENNEL_REVIEW_KIND, workspace: '/project',
      details: { target: { runId: 'run-1', title: 'Write the parser', authors: ['AUTHOR'] } },
    })
    expect(offered[0]?.members.map(value => value.gouziId)).toEqual(['x', 'y'])
    // The id carries the run revision and each reviewer's entry and model, so a changed task or member makes a choice stale.
    expect(offered[0]?.id).toBe(JSON.stringify(['review', 'run-1', 4, '/project', ['x', 1, 'gouzi.x.codex', 'gpt-5.6-luna'], ['y', 1, 'gouzi.y.codex', 'gpt-5.6-luna']]))
  })

  it('offers only tasks that finished and have an accepted result, newest first, up to the configured count', async () => {
    const runs = [
      run({ runId: 'running', state: 'running' }),
      run({ runId: 'no-result', nodes: [{ id: 'work', state: 'failed' }] }),
      run({ runId: 'a-review', nodes: [{ id: 'review-1', state: 'passed' }] }),
      run({ runId: 'unowned', authors: [] }),
      run({ runId: 'first' }), run({ runId: 'second' }), run({ runId: 'third' }),
    ]
    const targets = async (config: Required<Config>) => (await offer(facts(['author', 'x'], { runs }), config)).map(value => (value.details.target as { runId: string }).runId)
    expect(await targets(resolveConfig({ maxTargets: 20 }))).toEqual(['first', 'second', 'third'])
    // The count bounds the offered tasks after the unfinished ones are left out.
    expect(await targets(resolveConfig({ maxTargets: 2 }))).toEqual(['first', 'second'])
  })

  it('never lets a task\'s own members review it, whether one member or a set did it', async () => {
    expect(await offer(facts(['author']))).toEqual([])
    const shared = await offer(facts(['a', 'b', 'c'], { runs: [run({ authors: ['a', 'b'] })] }))
    expect(shared[0]?.members.map(value => value.gouziId)).toEqual(['c'])
    expect((shared[0]?.details.target as { authors: string[] }).authors).toEqual(['A', 'B'])
  })

  it('needs reviewers that hold the project, can read files, and run the pinned model', async () => {
    expect(await offer(facts(['author', 'x'], {}, { supportsGovernedWorkspacePolicy: false }))).toEqual([])
    expect(await offer(facts(['author', 'x'], { runs: [run({ workspace: '/elsewhere' })] }))).toEqual([])
    const disabled = facts(['author', 'x'])
    expect(await offer({ ...disabled, members: disabled.members.map(value => ({ ...value, membership: 'disabled' })) as never })).toEqual([])
  })

  it('offers only the addressed member, and only when that member did not do the task', async () => {
    const people = ['author', 'x', 'y']
    const by = (gouziId: string, generation = 1) => offer(facts(people, { recipient: { gouziId, generation } }))
    expect((await by('y'))[0]?.members.map(value => value.gouziId)).toEqual(['y'])
    expect(await by('author')).toEqual([])
    expect(await by('y', 7)).toEqual([])
    expect(await by('ghost')).toEqual([])
  })
})

/** A scripted orchestration service: a task's events arrive in two pages, then an empty one. */
function service(events: unknown[][]) {
  const compile = vi.fn(async (_request: unknown) => ({ compilationId: 'compiled' }))
  const start = vi.fn(async (_request: unknown) => ({ runId: 'review-run' }))
  const readEvents = vi.fn(async (request: { afterSequence?: number }) => {
    const page = events[request.afterSequence ?? 0] ?? []
    return { events: page, nextSequence: (request.afterSequence ?? 0) + 1 }
  })
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('orchestrations', { compile, start, readEvents } as never)
  return { ctx, compile, start, readEvents }
}

const accepted = (preview: string, nodeId = 'work') => ({ type: 'node.evidence.accepted', nodeId, data: { outputPreview: preview } })

function chosen(reviewers: string[]): KennelCollaborationRequest {
  return {
    commandId: 'kennel:review:s:m', sessionId: 's', messageId: 'm', prompt: 'review it, please',
    candidate: {
      kind: 'collaboration', collaboration: 'review', id: 'review', workspace: '/project',
      members: reviewers.map(id => ({ gouziId: id, generation: 1, name: id.toUpperCase(), role: 'research', operatorId: `gouzi.${id}.codex`, model: 'gpt-5.6-luna' })),
      details: { target: { runId: 'run-1', title: 'Write the parser', authors: ['AUTHOR', 'AIDE'] } },
    },
    limits: {
      contextTokens: 8192, taskTimeoutMs: 600_000, titleMaxChars: 80,
      generationLimits: { maxTokens: 4096, maxOutputBytes: 262_144 }, workspaceToolLimits: { maxReadBytes: 1 } as never,
    },
    runtimeContext: { version: 1, sourceSessionId: 's', contextSnapshotMessageId: 'ctx', sections: [] },
  }
}

describe('review kind start', () => {
  it('starts one read-only node per reviewer on that reviewer\'s pinned entry and model, from the task\'s accepted result', async () => {
    const { ctx, compile, start, readEvents } = service([[{ type: 'run.started', data: {} }, accepted('old')], [accepted('the parser is in src/parse.ts')], []])
    const kind = kennelReviewKind(ctx, defaults)
    const started = await kind.start(chosen(['x', 'y']))

    expect(started).toEqual({ runId: 'review-run', assignments: [{ gouziId: 'x', role: 'reviewer' }, { gouziId: 'y', role: 'reviewer' }] })
    // The newest accepted result of the work node is what reviewers read, across event pages.
    expect(readEvents).toHaveBeenCalledTimes(3)
    const { graph, admission, intent } = compile.mock.calls[0]![0] as {
      graph: { title: string; workspace: string; maxParallel: number; risk: string; nodes: Record<string, unknown>[] }
      admission: Record<string, unknown>
      intent: unknown
    }
    expect(intent).toEqual({ request: 'review it, please' })
    expect(graph).toMatchObject({ title: '评审：Write the parser', workspace: '/project', maxParallel: 2, risk: 'low' })
    expect(graph.nodes.map(node => node.id)).toEqual(['review-1', 'review-2'])
    expect(graph.nodes[0]).toMatchObject({
      dependsOn: [], requiredForCompletion: true, readScopes: ['**'], writeScopes: [],
      effectBudget: { read: ['**'], write: [], execute: [], network: [], cost: [], risk: [] },
      operator: { preferredIds: ['gouzi.x.codex'], fallbackIds: [], profile: { model: 'gpt-5.6-luna' } },
      generationLimits: { maxTokens: 4096, maxOutputBytes: 262_144 }, workspaceToolLimits: { maxReadBytes: 1 }, timeoutMs: 600_000,
      acceptance: [{ id: 'review', kind: 'operator-completed' }],
    })
    expect(graph.nodes[1]).toMatchObject({ operator: { preferredIds: ['gouzi.y.codex'] } })
    const task = String(graph.nodes[0]?.task)
    expect(task).toContain('「X」')
    expect(task).toContain('「AUTHOR、AIDE」')
    expect(task).toContain('任务：Write the parser')
    expect(task).toContain('the parser is in src/parse.ts')
    expect(task).not.toContain('old')
    expect(task).toContain('review it, please')
    expect(task).toContain('结论：通过')
    expect(admission).toMatchObject({
      policy: 'auto', route: 'taskgraph', sourceSessionId: 's', sourceMessageId: 'm', rlm: 'disabled', autonomous: 'disabled',
      runtimeContext: { sourceSessionId: 's' },
      gouziRecipients: [{ gouziId: 'x', generation: 1, operatorIds: ['gouzi.x.codex'] }, { gouziId: 'y', generation: 1, operatorIds: ['gouzi.y.codex'] }],
    })
    expect(admission.gouziRecipient).toBeUndefined()
    expect(start).toHaveBeenCalledWith({ commandId: 'kennel:review:s:m', compilationId: 'compiled' })
  })

  it('binds one reviewer as the single recipient and omits an absent runtime context', async () => {
    const { ctx, compile } = service([[accepted('done')], []])
    const request = chosen(['x'])
    const { runtimeContext: _runtimeContext, ...bare } = request
    await kennelReviewKind(ctx, defaults).start(bare)
    const { admission, graph } = compile.mock.calls[0]![0] as {
      admission: Record<string, unknown>
      graph: { title: string; maxParallel: number }
    }
    expect(admission).toMatchObject({ gouziRecipient: { gouziId: 'x', generation: 1, operatorIds: ['gouzi.x.codex'] } })
    expect(admission.gouziRecipients).toBeUndefined()
    expect(admission.runtimeContext).toBeUndefined()
    expect(graph.maxParallel).toBe(1)
  })

  it('keeps titles inside the Host limit', async () => {
    const { ctx, compile } = service([[accepted('done')], []])
    const request = chosen(['x'])
    await kennelReviewKind(ctx, defaults).start({ ...request, limits: { ...request.limits, titleMaxChars: 6 } })
    const { graph } = compile.mock.calls[0]![0] as { graph: { title: string; nodes: { title: string }[] } }
    expect(graph.title).toBe('评审：Wri')
    expect(graph.nodes[0]?.title).toBe('评审：Wri')
  })

  it('refuses a task without an accepted result and a candidate that does not name a task', async () => {
    const empty = service([[accepted('other node', 'verify'), { type: 'node.evidence.accepted', nodeId: 'work', data: {} }], []])
    await expect(kennelReviewKind(empty.ctx, defaults).start(chosen(['x']))).rejects.toThrow('has no accepted result to review')
    expect(empty.compile).not.toHaveBeenCalled()
    const request = chosen(['x'])
    for (const details of [{}, { target: { runId: 1, title: 't', authors: [] } }, { target: { runId: 'r', title: 't', authors: 'x' } }]) {
      await expect(kennelReviewKind(empty.ctx, defaults).start({ ...request, candidate: { ...request.candidate, details } })).rejects.toThrow('does not name a finished task')
    }
  })
})

describe('review plugin', () => {
  it('registers the kind for the plugin lifetime with guidance for the selection model, and bounds its configuration', async () => {
    expect(defaults).toEqual({ maxReviewers: 2, maxTargets: 5 })
    expect(() => Config({ maxReviewers: 0 })).toThrow()
    expect(() => Config({ maxReviewers: 5 })).toThrow()
    expect(() => Config({ maxTargets: 0 })).toThrow()
    expect(plugin.inject).toEqual(['kennelCollaborations', 'orchestrations'])
    const ctx = new Context()
    contexts.push(ctx)
    const registered: KennelCollaborationKind[] = []
    const dispose = vi.fn()
    ctx.provide('kennelCollaborations', {
      register: (kind: KennelCollaborationKind) => { registered.push(kind); return dispose },
      kinds: () => registered,
    } satisfies KennelCollaborations as never)
    ctx.provide('orchestrations', {} as never)
    const fiber = ctx.plugin(plugin, defaults)
    await fiber.await()
    expect(registered.map(value => value.kind)).toEqual(['review'])
    expect(registered[0]?.guidance).toContain('评审')
    await fiber.dispose()
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
  })
})
