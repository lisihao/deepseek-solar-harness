/** The kennel seam's Provider: role assignment, policy, and approval over a scripted Debate service. */

import { Context } from '@deepseek-ai/cordis'
import { validateDebatePolicy, type DebateControlRequestV1, type DebateStartRequestV1 } from '@deepseek-ai/dsh-debate'
import { GouziId, type KennelDebateMember, type KennelDebateRequest } from '@deepseek-ai/dsh-orchestration'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KennelDebateProvider } from '../src/kennel.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function member(id: string, model = 'gpt-5.6-luna'): KennelDebateMember {
  return { gouziId: GouziId(id), name: id, operatorId: `gouzi.${id}.codex`, model }
}

function request(members: KennelDebateMember[], patch: Partial<KennelDebateRequest> = {}): KennelDebateRequest {
  return { commandId: 'kennel:debate:s:m', sessionId: 's', workspace: '/project', prompt: 'Which option?', members, ...patch }
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
  await ctx.plugin(KennelDebateProvider).await()
  return { ctx, starts, controls, provider: ctx.kennelDebates }
}

describe('KennelDebateProvider', () => {
  it('declares the member counts a Debate with an independent judge allows', async () => {
    const { provider } = await setup()
    expect([provider.minMembers, provider.maxMembers]).toEqual([3, 4])
  })

  it('gives three members the proposer, falsifier, and judge roles and starts a valid Debate for them', async () => {
    const { starts, controls, provider } = await setup()
    const run = await provider.start(request([member('alpha'), member('beta'), member('gamma', 'gpt-5.6-sol')]))

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
    const { starts, provider } = await setup()
    const run = await provider.start(request([member('a'), member('b'), member('c'), member('d')]))
    expect(run.assignments.map(value => value.role)).toEqual([
      'constructive-proposer', 'skeptical-falsifier', 'evidence-auditor', 'decision-judge',
    ])
    expect(starts[0]?.policy.budget).toMatchObject({ maxRounds: 3, maxAgentsPerRound: 4 })
    expect(validateDebatePolicy(starts[0]?.policy)).toEqual(starts[0]?.policy)
  })

  it('passes the captured runtime context through and does not approve a run that needs none', async () => {
    const { starts, controls, provider } = await setup({ state: 'completed' })
    const runtimeContext = { version: 1 as const, sourceSessionId: 's', contextSnapshotMessageId: 'm', sections: [] }
    await provider.start(request([member('a'), member('b'), member('c')], { runtimeContext }))
    expect(starts[0]?.runtimeContext).toEqual(runtimeContext)
    expect(controls).toEqual([])
  })

  it.each([
    ['too few members', [member('a'), member('b')], 'needs 3 to 4 members'],
    ['too many members', ['a', 'b', 'c', 'd', 'e'].map(id => member(id)), 'needs 3 to 4 members'],
    ['a repeated member', [member('a'), member('b'), member('a')], 'distinct members'],
    ['another member\'s entry', [member('a'), member('b'), { ...member('c'), operatorId: 'gouzi.a.codex' }], 'does not belong to member c'],
  ])('refuses %s before touching the Debate service', async (_name, members, message) => {
    const { starts, provider } = await setup()
    await expect(provider.start(request(members))).rejects.toMatchObject({ code: 'DEBATE_ROSTER_INVALID', message: expect.stringContaining(message) as string })
    expect(starts).toEqual([])
  })

  it('reports a missing Debate service and survives a failed background approval', async () => {
    const bare = new Context()
    contexts.push(bare)
    await bare.plugin(KennelDebateProvider).await()
    await expect(bare.kennelDebates.start(request([member('a'), member('b'), member('c')])))
      .rejects.toMatchObject({ code: 'DEBATE_PROVIDER_UNAVAILABLE' })

    const { ctx, provider } = await setup({ approve: () => Promise.reject(new Error('approval refused')) })
    const warn = vi.spyOn(ctx.logger, 'warn')
    await expect(provider.start(request([member('a'), member('b'), member('c')]))).resolves.toMatchObject({ runId: 'debate-1' })
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('approval refused')) })
  })
})
