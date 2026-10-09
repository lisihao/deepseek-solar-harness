/** The Debate kind of the kennel registry: candidates over members, role assignment, policy, and approval. */

import { Context } from '@deepseek-ai/cordis'
import { validateDebatePolicy, type DebateControlRequestV1, type DebateStartRequestV1 } from '@deepseek-ai/dsh-debate'
import type {
  KennelCollaborationCandidate, KennelCollaborationFacts, KennelCollaborationKind, KennelCollaborationMember,
  KennelCollaborationRequest, KennelCollaborations,
} from '@deepseek-ai/dsh-orchestration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { kennelDebateKind, kennelDebatePlugin, KENNEL_DEBATE_KIND } from '../src/kennel.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function member(id: string, model = 'gpt-5.6-luna'): KennelCollaborationMember {
  return { gouziId: id, generation: 1, name: id, role: 'research', operatorId: `gouzi.${id}.codex`, model }
}

function candidate(members: KennelCollaborationMember[]): KennelCollaborationCandidate {
  return { kind: 'collaboration', collaboration: KENNEL_DEBATE_KIND, id: 'debate', workspace: '/project', members, details: {} }
}

function request(members: KennelCollaborationMember[], patch: Partial<KennelCollaborationRequest> = {}): KennelCollaborationRequest {
  return {
    commandId: 'kennel:debate:s:m', sessionId: 's', messageId: 'm', prompt: 'Which option?', candidate: candidate(members),
    limits: {
      contextTokens: 1, taskTimeoutMs: 1, titleMaxChars: 1,
      generationLimits: { maxTokens: 1, maxOutputBytes: 1 }, workspaceToolLimits: {} as never,
    },
    workGraph: () => { throw new Error('a Debate gives no member work') },
    ...patch,
  }
}

async function setup(options: { state?: string; approve?: () => Promise<unknown> } = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  const starts: DebateStartRequestV1[] = []
  const controls: DebateControlRequestV1[] = []
  ctx.provide('debates', {
    start: async (value: DebateStartRequestV1) => {
      starts.push(value)
      return { runId: 'debate-1', revision: 2, state: options.state ?? 'awaiting_approval' }
    },
    control: async (value: DebateControlRequestV1) => {
      controls.push(value)
      return options.approve === undefined ? { runId: value.runId } : options.approve()
    },
  } as never)
  return { ctx, starts, controls, kind: kennelDebateKind(ctx) }
}

/** Facts for members that each hold the given projects, on one codex entry with two models. */
function facts(ids: string[], patch: Partial<KennelCollaborationFacts> = {}, scopes: string[] = ['/project']): KennelCollaborationFacts {
  return {
    sessionId: 's', runs: [], workOffers: [], work: [], earlier: [], mentioned: [],
    members: ids.map(id => ({ gouziId: id, generation: 1, membership: 'enabled', name: id, role: 'research' })) as never,
    entries: ids.map(id => ({
      gouziId: id, generation: 1, projectScopes: scopes,
      operators: [{ operatorId: `gouzi.${id}.codex`, available: true, supportsGenerationLimits: true, models: ['gpt-5.6-luna'], defaultModel: 'gpt-5.6-luna' }],
    })) as never,
    ...patch,
  }
}

describe('Debate kennel kind', () => {
  it('offers one Debate per project that three members hold, in registry order, up to four members', async () => {
    const { kind } = await setup()
    const offered = await kind.offer(facts(['a', 'b', 'c', 'd', 'e']))
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ kind: 'collaboration', collaboration: 'debate', workspace: '/project', details: {} })
    expect(offered[0]?.members.map(value => value.gouziId)).toEqual(['a', 'b', 'c', 'd'])
    // Everything the offer depends on is in the id, so a changed model or entry makes the choice stale.
    expect(offered[0]?.id).toBe(JSON.stringify(['debate', '/project', ['a', 1, 'gouzi.a.codex', 'gpt-5.6-luna'], ['b', 1, 'gouzi.b.codex', 'gpt-5.6-luna'],
      ['c', 1, 'gouzi.c.codex', 'gpt-5.6-luna'], ['d', 1, 'gouzi.d.codex', 'gpt-5.6-luna']]))
    expect(await kind.offer(facts(['a', 'b'], {}))).toEqual([])
    expect(await kind.offer(facts(['a', 'b', 'c'], { recipient: { gouziId: 'a', generation: 1 } }))).toEqual([])
    // Each project is offered on its own members.
    expect((await kind.offer(facts(['a', 'b', 'c'], {}, ['/one', '/two']))).map(value => value.workspace)).toEqual(['/one', '/two'])
  })

  it('runs the Debate on the members the message names, in the order it names them, and fills a short list', async () => {
    const { kind } = await setup()
    const named = (...ids: string[]) => ids.map(id => ({ gouziId: id, generation: 1, name: id }))
    const ids = async (mentioned: ReturnType<typeof named>) =>
      (await kind.offer(facts(['a', 'b', 'c', 'd', 'e'], { mentioned })))[0]?.members.map(value => value.gouziId)
    expect(await ids(named('e', 'c', 'a'))).toEqual(['e', 'c', 'a'])
    expect(await ids(named('d', 'b', 'e', 'a'))).toEqual(['d', 'b', 'e', 'a'])
    // Two names get a third member from the registry to judge.
    expect(await ids(named('e', 'b'))).toEqual(['e', 'b', 'a'])
    // A named member that cannot take part, or too many names, leaves no Debate rather than a different roster.
    expect(await ids(named('ghost', 'b'))).toBeUndefined()
    expect(await ids(named('a', 'b', 'c', 'd', 'e'))).toBeUndefined()
  })

  it('gives three members the proposer, falsifier, and judge roles and starts a valid Debate for them', async () => {
    const { starts, controls, kind } = await setup()
    const run = await kind.start(request([member('alpha'), member('beta'), member('gamma', 'gpt-5.6-sol')]))

    expect(run).toEqual({
      runId: 'debate-1',
      assignments: [
        { gouziId: 'alpha', role: 'constructive-proposer' },
        { gouziId: 'beta', role: 'skeptical-falsifier' },
        { gouziId: 'gamma', role: 'decision-judge' },
      ],
    })
    const [start] = starts
    expect(start).toMatchObject({
      commandId: 'kennel:debate:s:m', workspace: '/project', prompt: 'Which option?', sourceSessionId: 's',
      execution: { version: 1, kind: 'standalone' },
      policy: { mode: 'enabled', budget: { maxRounds: 3, maxAgentsPerRound: 3 }, preserveDissent: true },
    })
    expect(start?.policy.roster.map(role => [role.role, role.kind, role.operatorId, role.model, role.source]))
      .toEqual([
        ['constructive-proposer', 'participant', 'gouzi.alpha.codex', 'gpt-5.6-luna', 'native-subscription'],
        ['skeptical-falsifier', 'participant', 'gouzi.beta.codex', 'gpt-5.6-luna', 'native-subscription'],
        ['decision-judge', 'judge', 'gouzi.gamma.codex', 'gpt-5.6-sol', 'native-subscription'],
      ])
    expect(validateDebatePolicy(start?.policy)).toEqual(start?.policy)
    // The user's request is the approval: the run is approved against the revision the start returned.
    await vi.waitFor(() => { expect(controls).toHaveLength(1) })
    expect(controls[0]).toMatchObject({ runId: 'debate-1', expectedRevision: 2, action: 'approve', commandId: 'kennel:debate:s:m:approve' })
  })

  it('adds the evidence auditor for a fourth member and keeps the judge last', async () => {
    const { starts, kind } = await setup()
    const run = await kind.start(request([member('a'), member('b'), member('c'), member('d')]))
    expect(run.assignments.map(value => value.role)).toEqual([
      'constructive-proposer', 'skeptical-falsifier', 'evidence-auditor', 'decision-judge',
    ])
    expect(starts[0]?.policy.budget).toMatchObject({ maxRounds: 3, maxAgentsPerRound: 4 })
    expect(validateDebatePolicy(starts[0]?.policy)).toEqual(starts[0]?.policy)
  })

  it('passes the captured runtime context through and does not approve a run that needs none', async () => {
    const { starts, controls, kind } = await setup({ state: 'completed' })
    const runtimeContext = { version: 1 as const, sourceSessionId: 's', contextSnapshotMessageId: 'm', sections: [] }
    await kind.start(request([member('a'), member('b'), member('c')], { runtimeContext }))
    expect(starts[0]?.runtimeContext).toEqual(runtimeContext)
    expect(controls).toEqual([])
  })

  it.each([
    ['too few members', [member('a'), member('b')], 'needs 3 to 4 members'],
    ['too many members', ['a', 'b', 'c', 'd', 'e'].map(id => member(id)), 'needs 3 to 4 members'],
    ['a repeated member', [member('a'), member('b'), member('a')], 'distinct members'],
    ['another member\'s entry', [member('a'), member('b'), { ...member('c'), operatorId: 'gouzi.a.codex' }], 'does not belong to member c'],
  ])('refuses %s before touching the Debate service', async (_name, members, message) => {
    const { starts, kind } = await setup()
    await expect(kind.start(request(members))).rejects.toMatchObject({ code: 'DEBATE_ROSTER_INVALID', message: expect.stringContaining(message) as string })
    expect(starts).toEqual([])
  })

  it('reports a missing Debate service and survives a failed background approval', async () => {
    const bare = new Context()
    contexts.push(bare)
    await expect(kennelDebateKind(bare).start(request([member('a'), member('b'), member('c')])))
      .rejects.toMatchObject({ code: 'DEBATE_PROVIDER_UNAVAILABLE' })

    const { ctx, kind } = await setup({ approve: () => Promise.reject(new Error('approval refused')) })
    const warn = vi.spyOn(ctx.logger, 'warn')
    await expect(kind.start(request([member('a'), member('b'), member('c')]))).resolves.toMatchObject({ runId: 'debate-1' })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('approval refused')) })
  })

  it('registers with the kennel registry for the lifetime of its plugin and tells the model when to choose it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registered: KennelCollaborationKind[] = []
    const dispose = vi.fn()
    ctx.provide('kennelCollaborations', {
      register: (kind: KennelCollaborationKind) => { registered.push(kind); return dispose },
      kinds: () => registered,
    } satisfies KennelCollaborations as never)
    const fiber = ctx.plugin(kennelDebatePlugin)
    await fiber.await()
    expect(registered.map(value => value.kind)).toEqual(['debate'])
    expect(registered[0]?.guidance).toContain('辩论')
    await fiber.dispose()
    await vi.waitFor(() => { expect(dispose).toHaveBeenCalledOnce() })
  })
})
