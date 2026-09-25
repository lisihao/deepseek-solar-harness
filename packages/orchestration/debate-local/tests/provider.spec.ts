import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalDebateProvider } from '../src/index.ts'
import { DebateError } from '@deepseek-ai/dsh-debate'
import type {
  DebateClaimV1,
  DebatePolicyV1,
  DebateStartRequestV1,
} from '@deepseek-ai/dsh-debate'
import type {
  DebateRoundAgentProgressV1,
  DebateRoundExecutionRequestV1,
  DebateRoundExecutorPort,
  DebateTurnRequestV1,
  DebateTurnResultV1,
} from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function policy(mode: DebatePolicyV1['mode'] = 'enabled', overrides: Partial<DebatePolicyV1['budget']> = {}): DebatePolicyV1 {
  const persona = (title: string, mandate: string, stance: string) => ({
    title,
    mandate,
    stance,
    instructions: ['Name the claim IDs you evaluate.', 'Return calibrated confidence and evidence refs.'],
  })
  return {
    version: 1,
    mode,
    roster: [
      {
        version: 1, role: 'constructive-proposer', kind: 'participant', operatorId: 'fixture-proposer', model: 'fixture-a', tier: 'low', source: 'local',
        persona: persona('Proposer', 'Construct a candidate answer.', 'Constructive'), required: false,
      },
      {
        version: 1, role: 'skeptical-falsifier', kind: 'participant', operatorId: 'fixture-falsifier', model: 'fixture-b', tier: 'medium', source: 'local',
        persona: persona('Falsifier', 'Find counterexamples.', 'Skeptical'), required: false,
      },
      {
        version: 1, role: 'decision-judge', kind: 'judge', operatorId: 'fixture-judge', model: 'fixture-judge', tier: 'high', source: 'local',
        persona: persona('Judge', 'Synthesize the bounded ledger.', 'Evidence-first'), required: true,
      },
    ],
    budget: {
      version: 1,
      maxRounds: 2,
      maxTurnsPerAgent: 2,
      maxAgentsPerRound: 3,
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxTotalTokens: 30_000,
      maxCostUsd: 2,
      ...overrides,
    },
    rounds: { version: 1, firstRound: 'blind-independent', followUp: 'claim-ledger', escalation: 'high-severity-unresolved' },
    convergence: {
      version: 1,
      scoreThreshold: 0.8,
      minSettledAgents: 2,
      maxUnresolvedHighSeverity: 0,
      requireEvidenceForCritical: true,
      earlyStop: true,
    },
    preserveDissent: true,
  }
}

function request(mode: DebatePolicyV1['mode'] = 'enabled', overrides: Partial<DebateStartRequestV1> = {}): DebateStartRequestV1 {
  return {
    version: 1,
    commandId: `start-${mode}`,
    workspace: '/fixture/workspace',
    prompt: 'Compare the candidate approaches and preserve unresolved risks.',
    objective: 'Choose the most supportable candidate.',
    policy: policy(mode),
    sourceRefs: [{ version: 1, ref: 'fixture:brief', kind: 'document', digest: 'sha256:brief' }],
    execution: { version: 1, kind: 'standalone' },
    ...overrides,
  }
}

function claim(overrides: Partial<DebateClaimV1> = {}): DebateClaimV1 {
  return {
    version: 1,
    claimId: 'claim:answer',
    statement: 'The reversible candidate is the safer default.',
    status: 'supported',
    severity: 'medium',
    confidence: 0.9,
    supportingSlotIds: [],
    opposingSlotIds: [],
    evidenceRefs: [{ version: 1, ref: 'fixture:brief', kind: 'source', digest: 'sha256:brief' }],
    ...overrides,
  }
}

function resultFor(
  turn: DebateTurnRequestV1,
  options: { readonly unresolved?: boolean; readonly newClaim?: boolean } = {},
): DebateTurnResultV1 {
  const claimId = options.newClaim ? `claim:new:${turn.round}:${turn.slotId}` : 'claim:answer'
  return {
    confidence: 0.9,
    outputRef: `fixture:turn:${turn.round}:${turn.slotId}`,
    outputPreview: `${turn.phase}:${claimId}`,
    claims: [claim({ claimId, supportingSlotIds: [turn.slotId], status: options.unresolved ? 'open' : 'supported' })],
    unresolved: options.unresolved ? [{
      version: 1,
      claimId,
      description: 'The rollback evidence still needs independent confirmation.',
      severity: 'high',
      blocking: true,
      reason: 'The fixture intentionally withholds a corroborating artifact.',
      requiredEvidenceRefs: [{ version: 1, ref: 'fixture:corroboration', kind: 'artifact' }],
    }] : [],
    evidenceRefs: [{ version: 1, ref: `fixture:turn:${turn.round}:${turn.slotId}`, kind: 'observation' }],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  }
}

async function provider(
  root: string,
  executor: (turn: DebateTurnRequestV1) => Promise<DebateTurnResultV1>,
  idFactory: () => string = () => 'run-fixture',
): Promise<LocalDebateProvider> {
  const ctx = new Context()
  contexts.push(ctx)
  const roundExecutor: DebateRoundExecutorPort = {
    async executeRound(request) {
      const entries = await Promise.all(request.turns.map(async turn => [turn.slotId, await executor(turn)] as const))
      return { version: 1, resultsBySlot: Object.fromEntries(entries) }
    },
  }
  return new LocalDebateProvider(ctx, { root, executor: roundExecutor, idFactory })
}

async function expectTerminalConvergenceOrder(
  service: LocalDebateProvider,
  runId: string,
  status: 'converged' | 'budget_limited' | 'max_rounds',
  finalState: 'completed' | 'budget_limited' | 'max_rounds',
): Promise<void> {
  const events = (await service.readEvents({ runId, limit: 100 })).events
  const convergenceIndex = events.findIndex(event => event.type === 'debate.convergence.evaluated'
    && event.data.status === status)
  const synthesisStartIndex = events.findIndex((event, index) => index > convergenceIndex
    && event.type === 'debate.synthesis.started')
  const synthesisSettledIndex = events.findIndex((event, index) => index > synthesisStartIndex
    && event.type === 'debate.synthesis.settled')
  expect(convergenceIndex).toBeGreaterThanOrEqual(0)
  expect(synthesisStartIndex).toBeGreaterThan(convergenceIndex)
  expect(synthesisSettledIndex).toBeGreaterThan(synthesisStartIndex)
  expect(events[convergenceIndex]?.data.lifecycleState).toBe('synthesizing')
  expect(events[synthesisStartIndex]?.data.lifecycleState).toBe('synthesizing')
  expect(events[synthesisSettledIndex]?.data.lifecycleState).toBe(finalState)
  expect(events.slice(convergenceIndex, synthesisSettledIndex + 1).map(event => event.type)).toEqual([
    'debate.convergence.evaluated',
    'debate.cost.accounted',
    'debate.synthesis.started',
    'debate.synthesis.settled',
  ])
  const settledSequence = events[synthesisSettledIndex]?.sequence
  expect(events.filter(event => event.type === 'debate.agent.dispatched'
    && (settledSequence === undefined || event.sequence > settledSequence))).toHaveLength(0)
}

describe('local Debate Provider', () => {
  it('keeps start approval-pending, persists control/event projections, and supports reject', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-control-'))
    let calls = 0
    const service = await provider(root, async () => {
      calls += 1
      return resultFor({} as DebateTurnRequestV1)
    })
    const pending = await service.start(request('enabled'))
    expect(pending).toMatchObject({
      runId: 'run-fixture',
      state: 'awaiting_approval',
      currentRound: 0,
      revision: 2,
      topic: { version: 1, title: 'Choose the most supportable candidate.', source: 'objective' },
    })
    expect(calls).toBe(0)
    const rejected = await service.control({
      version: 1, commandId: 'control-reject', runId: pending.runId, expectedRevision: pending.revision,
      action: 'reject', reason: 'fixture does not require a debate',
    })
    expect(rejected.state).toBe('stopped')
    expect((await service.list())).toMatchObject([{ runId: 'run-fixture', state: 'stopped', revision: 3 }])
    const page = await service.readEvents({ runId: pending.runId, limit: 2 })
    expect(page.events.map(event => event.type)).toEqual(['debate.planned', 'debate.roster.qualified'])
    expect(page.nextSequence).toBe(2)
    const nextPage = await service.readEvents({ runId: pending.runId, afterSequence: page.nextSequence, limit: 2 })
    expect(nextPage.events[0]?.sequence).toBe(3)
    await expect(service.inspect('missing')).rejects.toMatchObject({ code: 'DEBATE_NOT_FOUND' })
  })

  it('persists the request prompt as the public topic when no objective is supplied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-topic-prompt-'))
    const service = await provider(root, async turn => resultFor(turn))
    const { objective: _objective, ...promptOnlyRequest } = request('enabled', {
      commandId: 'start-topic-prompt',
      prompt: '用户给出的多轮 Debate 议题正文',
    })
    const pending = await service.start(promptOnlyRequest)

    expect(pending).toMatchObject({
      topic: { version: 1, title: '用户给出的多轮 Debate 议题正文', source: 'user' },
    })
    await expect(service.inspect(pending.runId)).resolves.toMatchObject({
      topic: { title: '用户给出的多轮 Debate 议题正文', source: 'user' },
    })
  })

  it('allows a pending run to pause and resume through the same revision-fenced seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-pause-'))
    let calls = 0
    const service = await provider(root, async (turn) => {
      calls += 1
      return resultFor(turn)
    })
    const pending = await service.start(request('enabled', { commandId: 'start-pause' }))
    const paused = await service.control({
      version: 1, commandId: 'control-pause', runId: pending.runId, expectedRevision: pending.revision,
      action: 'pause', reason: 'fixture pause',
    })
    expect(paused.state).toBe('stopped')
    const resumed = await service.control({
      version: 1, commandId: 'control-resume', runId: pending.runId, expectedRevision: paused.revision,
      action: 'resume', reason: 'fixture resume',
    })
    expect(resumed.state).toBe('completed')
    expect(calls).toBe(3)
  })

  it('runs independent first drafts, ledger-only follow-up, weighted convergence, and recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-rounds-'))
    const turns: DebateTurnRequestV1[] = []
    const service = await provider(root, async (turn) => {
      turns.push(turn)
      return resultFor(turn)
    })
    const start = request('enabled', { commandId: 'start-rounds', policy: policy('enabled', { maxRounds: 2 }) })
    const pending = await service.start(start)
    const completed = await service.control({
      version: 1, commandId: 'control-approve', runId: pending.runId, expectedRevision: pending.revision,
      action: 'approve', reason: 'fixture approval',
    })
    expect(completed.state).toBe('completed')
    expect(completed.currentRound).toBe(1)
    expect(turns).toHaveLength(3)
    expect(completed.cost).toMatchObject({ inputTokens: 30, outputTokens: 15, costUsd: 0.03 })
    expect(completed.rounds.flatMap(round => round.turns).every(turn => !('tier' in turn) && !('source' in turn))).toBe(true)
    expect(turns.map(turn => turn.phase)).toEqual(['blind-independent', 'blind-independent', 'blind-independent'])
    expect(turns.every(turn => turn.priorLedger.claims.length === 0)).toBe(true)
    expect(completed.rounds[0]?.convergence).toMatchObject({ status: 'converged', score: 0.9, settledAgents: 3 })
    const settledEvents = (await service.readEvents({ runId: completed.runId, limit: 100 })).events
      .filter(event => event.type === 'debate.agent.settled')
    expect(settledEvents).toHaveLength(3)
    expect(settledEvents.every(event => event.data.confidence === 0.9)).toBe(true)
    await expectTerminalConvergenceOrder(service, completed.runId, 'converged', 'completed')

    const recovered = await provider(root, async () => {
      throw new Error('recovery inspection must not execute a turn')
    })
    await expect(recovered.inspect(completed.runId)).resolves.toEqual(completed)
  })

  it('dispatches every admitted slot in a round concurrently before applying deterministic results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-parallel-'))
    let active = 0
    let peak = 0
    const gate = new Promise<void>((resolve) => { setTimeout(resolve, 25) })
    const service = await provider(root, async (turn) => {
      active += 1
      peak = Math.max(peak, active)
      await gate
      active -= 1
      return resultFor(turn)
    })
    const pending = await service.start(request('enabled', { commandId: 'start-parallel' }))
    const completed = await service.control({
      version: 1, commandId: 'control-parallel', runId: pending.runId, expectedRevision: pending.revision,
      action: 'approve', reason: 'fixture parallel round',
    })

    expect(completed.state).toBe('completed')
    expect(peak).toBe(3)
    expect(completed.rounds[0]?.turns.map(turn => turn.slotId)).toEqual([
      'constructive-proposer', 'skeptical-falsifier', 'decision-judge',
    ])
    const events = (await service.readEvents({ runId: completed.runId, limit: 100 })).events
    const dispatches = events.filter(event => event.type === 'debate.agent.dispatched')
    const settlements = events.filter(event => event.type === 'debate.agent.settled')
    expect(Math.max(...dispatches.map(event => event.sequence))).toBeLessThan(
      Math.min(...settlements.map(event => event.sequence)),
    )
  })

  it('immediately persists one safe, source-deduplicated TaskGraph operator progress fact before round settlement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-progress-'))
    const ctx = new Context()
    contexts.push(ctx)
    let persistedBeforeSettlement = false
    const executor: DebateRoundExecutorPort = {
      async executeRound(round) {
        const turn = round.turns[0]
        if (turn === undefined || round.onProgress === undefined) throw new Error('fixture requires an admitted progress callback')
        const unsafeProgress = {
          version: 1,
          runId: round.runId,
          round: round.round,
          slotId: turn.slotId,
          role: turn.role,
          progress: {
            version: 1,
            kind: 'public-output',
            source: {
              orchestrationRunId: 'taskgraph-progress-fixture',
              sequence: 42,
              time: '2026-09-03T10:00:00.000Z',
            },
            publicOutputPreview: 'Safe public operator update.',
            routing: {
              version: 1,
              requestedOperatorId: turn.operatorId,
              requestedModel: turn.model,
              actualOperatorId: 'codex',
              actualModel: 'gpt-5.6-luna',
            },
            prompt: 'must-not-copy',
            nativeSessionId: 'must-not-copy',
            commandId: 'must-not-copy',
          },
        } as DebateRoundAgentProgressV1
        await round.onProgress(unsafeProgress)
        await round.onProgress(unsafeProgress)
        const events = (await service.readEvents({ runId: round.runId, limit: 100 })).events
        persistedBeforeSettlement = events.some(event => event.type === 'debate.agent.progress')
        return {
          version: 1,
          resultsBySlot: Object.fromEntries(round.turns.map(entry => [entry.slotId, resultFor(entry)])),
        }
      },
    }
    const service = new LocalDebateProvider(ctx, { root, executor, idFactory: () => 'run-progress' })
    const pending = await service.start(request('enabled', { commandId: 'start-progress' }))
    const completed = await service.control({
      version: 1,
      commandId: 'approve-progress',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture approval',
    })

    const events = (await service.readEvents({ runId: completed.runId, limit: 100 })).events
    const progress = events.filter(event => event.type === 'debate.agent.progress')
    const settled = events.filter(event => event.type === 'debate.agent.settled')
    expect(persistedBeforeSettlement).toBe(true)
    expect(progress).toHaveLength(1)
    expect(progress[0]).toMatchObject({
      round: 1,
      slotId: 'constructive-proposer',
      data: {
        orchestrationRunId: 'taskgraph-progress-fixture',
        orchestrationSequence: 42,
        kind: 'public-output',
        publicOutputPreview: 'Safe public operator update.',
        routing: {
          requestedOperatorId: 'fixture-proposer',
          actualOperatorId: 'codex',
          actualModel: 'gpt-5.6-luna',
        },
      },
    })
    expect(progress[0]?.sequence).toBeLessThan(Math.min(...settled.map(event => event.sequence)))
    expect(JSON.stringify(progress)).not.toContain('must-not-copy')
  })

  it('preserves settled work and structured blockers when a round TaskGraph fails partially', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-partial-'))
    const ctx = new Context()
    contexts.push(ctx)
    const roundExecutor: DebateRoundExecutorPort = {
      async executeRound(round) {
        const proposer = round.turns.find(turn => turn.slotId === 'constructive-proposer')
        if (proposer === undefined) throw new Error('fixture proposer missing')
        return {
          version: 1,
          resultsBySlot: {
            'constructive-proposer': {
              ...resultFor(proposer),
              attempt: 1,
              routing: {
                version: 1,
                requestedOperatorId: proposer.operatorId,
                requestedModel: proposer.model,
                actualOperatorId: 'codex',
                actualModel: 'gpt-5.6-sol',
              },
            },
          },
          failuresBySlot: {
            'skeptical-falsifier': {
              state: 'blocked',
              attempt: 0,
              errorCode: 'EXPLICIT_MODEL_UNAVAILABLE',
              blockers: [{ code: 'EXPLICIT_MODEL_UNAVAILABLE', message: 'Claude subscription unavailable' }],
              routing: {
                version: 1,
                requestedOperatorId: 'fixture-falsifier',
                requestedModel: 'fixture-b',
              },
            },
            'decision-judge': {
              state: 'blocked',
              attempt: 0,
              errorCode: 'DEPENDENCY_FAILED',
              blockers: [{ code: 'DEPENDENCY_FAILED', message: 'A required participant did not settle' }],
              routing: {
                version: 1,
                requestedOperatorId: 'fixture-judge',
                requestedModel: 'fixture-judge',
              },
            },
          },
        }
      },
    }
    const service = new LocalDebateProvider(ctx, { root, executor: roundExecutor, idFactory: () => 'run-fixture' })

    const failed = await service.start(request('auto', { commandId: 'start-partial' }))

    expect(failed.state).toBe('failed')
    expect(failed.rounds[0]?.state).toBe('failed')
    expect(failed.rounds[0]?.turns).toMatchObject([
      { slotId: 'constructive-proposer', state: 'settled', attempt: 1, operatorId: 'codex', model: 'gpt-5.6-sol' },
      {
        slotId: 'skeptical-falsifier', state: 'blocked', attempt: 0,
        blockers: [{ code: 'EXPLICIT_MODEL_UNAVAILABLE', message: 'Claude subscription unavailable' }],
      },
      {
        slotId: 'decision-judge', state: 'blocked', attempt: 0,
        blockers: [{ code: 'DEPENDENCY_FAILED', message: 'A required participant did not settle' }],
      },
    ])
    const events = (await service.readEvents({ runId: failed.runId, limit: 100 })).events
    expect(events.filter(event => event.type === 'debate.agent.blocked')).toHaveLength(2)
    expect(events.find(event => event.type === 'debate.agent.blocked')?.data.blockerCodes)
      .toContain('EXPLICIT_MODEL_UNAVAILABLE')
  })

  it('projects missing TaskGraph usage and account cost as unknown rather than zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-unknown-usage-'))
    const service = await provider(root, async (turn) => {
      const { usage: _unknown, ...result } = resultFor(turn)
      return result
    })
    const pending = await service.start(request('enabled', { commandId: 'start-unknown-usage' }))
    const limited = await service.control({
      version: 1,
      commandId: 'control-unknown-usage',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture unknown usage',
    })

    expect(limited.state).toBe('budget_limited')
    expect(limited.cost).toMatchObject({
      usageStatus: 'unknown',
      costStatus: 'unknown',
      unknownUsageTurns: 3,
      unknownCostTurns: 3,
    })
    expect(limited.cost.inputTokens).toBeUndefined()
    expect(limited.cost.outputTokens).toBeUndefined()
    expect(limited.cost.costUsd).toBeUndefined()
    expect(limited.synthesis).toMatchObject({ state: 'settled' })
    await expectTerminalConvergenceOrder(service, limited.runId, 'budget_limited', 'budget_limited')
  })

  it('rejects a settled turn that has no public preview or artifact reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-missing-output-'))
    const service = await provider(root, async (turn) => {
      const { outputRef: _ref, outputPreview: _preview, ...result } = resultFor(turn)
      return result
    })
    const pending = await service.start(request('enabled', { commandId: 'start-missing-output' }))
    const failed = await service.control({
      version: 1,
      commandId: 'control-missing-output',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture requires a visible turn result',
    })

    expect(failed.state).toBe('failed')
    expect(failed.rounds[0]?.turns.every(turn => turn.state === 'failed')).toBe(true)
    const events = (await service.readEvents({ runId: failed.runId, limit: 100 })).events
    expect(events.some(event => event.type === 'debate.agent.failed'
      && event.data.error === 'turn result must include outputRef or outputPreview')).toBe(true)
  })

  it('keeps repeated missing account cost unknown without synthesizing a zero subtotal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-unknown-cost-'))
    const costUnboundedPolicy = policy('enabled')
    const { maxCostUsd: _costLimit, ...costUnboundedBudget } = costUnboundedPolicy.budget
    const service = await provider(root, async (turn) => {
      const result = resultFor(turn, { unresolved: turn.round === 1 })
      if (result.usage === undefined) throw new Error('fixture must include usage')
      const { costUsd: _unknown, ...usage } = result.usage
      return { ...result, usage }
    })
    const pending = await service.start(request('enabled', {
      commandId: 'start-unknown-cost',
      policy: { ...costUnboundedPolicy, budget: costUnboundedBudget },
    }))
    const completed = await service.control({
      version: 1,
      commandId: 'control-unknown-cost',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture account cost unavailable',
    })

    expect(completed.state).toBe('completed')
    expect(completed.cost).toMatchObject({
      usageStatus: 'known',
      costStatus: 'unknown',
      inputTokens: 60,
      outputTokens: 30,
      unknownUsageTurns: 0,
      unknownCostTurns: 6,
    })
    expect(completed.cost.costUsd).toBeUndefined()
    expect(completed.cost.bySlot.every(entry => entry.usage.costUsd === undefined)).toBe(true)
  })

  it('escalates unresolved claims, clears them only through known ledger IDs, and stops at max rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-unresolved-'))
    const turns: DebateTurnRequestV1[] = []
    const service = await provider(root, async (turn) => {
      turns.push(turn)
      return resultFor(turn, { unresolved: turn.round === 1 })
    })
    const pending = await service.start(request('enabled', { commandId: 'start-unresolved' }))
    const completed = await service.control({
      version: 1, commandId: 'control-unresolved', runId: pending.runId, expectedRevision: pending.revision,
      action: 'approve', reason: 'fixture approval',
    })
    expect(completed.state).toBe('completed')
    expect(completed.currentRound).toBe(2)
    expect(completed.unresolved).toEqual([])
    expect(turns).toHaveLength(6)
    expect(turns.slice(0, 3).every(turn => turn.phase === 'blind-independent')).toBe(true)
    expect(turns.slice(3).every(turn => turn.phase === 'high-severity-unresolved')).toBe(true)
    expect(turns.slice(3).every(turn => turn.priorLedger.claims.some(entry => entry.claimId === 'claim:answer'))).toBe(true)

    const rootMax = await mkdtemp(join(tmpdir(), 'dsh-debate-local-max-'))
    const maxService = await provider(rootMax, async turn => resultFor(turn))
    const maxPending = await maxService.start(request('enabled', {
      commandId: 'start-max',
      policy: { ...policy('enabled'), convergence: { ...policy('enabled').convergence, scoreThreshold: 1 } },
    }))
    const maxed = await maxService.control({
      version: 1, commandId: 'control-max', runId: maxPending.runId, expectedRevision: maxPending.revision,
      action: 'approve', reason: 'fixture max-round check',
    })
    expect(maxed.state).toBe('max_rounds')
    expect(maxed.rounds).toHaveLength(2)
    expect(maxed.synthesis).toMatchObject({ state: 'settled' })
    await expectTerminalConvergenceOrder(maxService, maxed.runId, 'max_rounds', 'max_rounds')
  })


  it('reserves observed role usage before dispatching an over-budget follow-up round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-reservation-'))
    const turns: DebateTurnRequestV1[] = []
    const cappedPolicy = policy('enabled', {
      maxInputTokens: 60,
      maxOutputTokens: 30,
      maxTotalTokens: 100,
    })
    const service = await provider(root, async (turn) => {
      turns.push(turn)
      return {
        ...resultFor(turn),
        usage: { inputTokens: 14, outputTokens: 1, costUsd: 0.01 },
      }
    })
    const pending = await service.start(request('enabled', {
      commandId: 'start-reservation',
      policy: {
        ...cappedPolicy,
        convergence: { ...cappedPolicy.convergence, scoreThreshold: 1 },
      },
    }))
    const limited = await service.control({
      version: 1,
      commandId: 'control-reservation',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture predicts the next round before dispatch',
    })

    expect(limited.state).toBe('budget_limited')
    expect(limited.currentRound).toBe(1)
    expect(limited.rounds).toHaveLength(1)
    expect(turns).toHaveLength(3)
    expect(turns.every(turn => turn.round === 1)).toBe(true)
    const events = (await service.readEvents({ runId: limited.runId, limit: 100 })).events
    expect(events.filter(event => event.type === 'debate.round.started').map(event => event.round)).toEqual([1])
    const admission = events.find(event => event.type === 'debate.convergence.evaluated'
      && event.data.status === 'budget_limited')
    expect(admission?.data).toMatchObject({
      budgetKind: 'input-tokens',
      budgetUsed: 42,
      budgetReserved: 42,
      budgetLimit: 60,
    })
    expect(admission?.data.reason).toBe('input token budget admission denied (used 42 + reserved 42 >= limit 60)')
    await expectTerminalConvergenceOrder(service, limited.runId, 'budget_limited', 'budget_limited')
  })

  it('preflights a first round before it creates a TaskGraph or dispatches a slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-preflight-'))
    const ctx = new Context()
    contexts.push(ctx)
    const preflightRequests: DebateRoundExecutionRequestV1[] = []
    let executeCalls = 0
    const executor: DebateRoundExecutorPort = {
      preflight(round) {
        preflightRequests.push(round)
        return {
          version: 1,
          status: 'budget_limited',
          estimate: { inputTokens: 73_638, outputTokens: 36_000, totalTokens: 109_638 },
          limit: {
            kind: 'input-tokens',
            used: 0,
            reserved: 73_638,
            limit: 72_000,
            reason: 'input token budget preflight denied (used 0 + reserved 73638 >= limit 72000)',
          },
        }
      },
      async executeRound() {
        executeCalls += 1
        throw new Error('budget-limited first round must not execute')
      },
    }
    const service = new LocalDebateProvider(ctx, { root, executor, idFactory: () => 'run-preflight' })
    const cappedPolicy = policy('enabled', {
      maxInputTokens: 72_000,
      maxOutputTokens: 48_000,
      maxTotalTokens: 120_000,
    })
    const pending = await service.start(request('enabled', {
      commandId: 'start-preflight',
      policy: {
        ...cappedPolicy,
        convergence: { ...cappedPolicy.convergence, scoreThreshold: 1 },
      },
    }))
    const limited = await service.control({
      version: 1,
      commandId: 'control-preflight',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture first-round budget preflight',
    })

    expect(limited.state).toBe('budget_limited')
    expect(limited.currentRound).toBe(0)
    expect(limited.rounds).toEqual([])
    expect(executeCalls).toBe(0)
    expect(preflightRequests).toHaveLength(1)
    expect(preflightRequests[0]?.budgetEnvelope).toEqual({
      version: 1,
      usedInputTokens: 0,
      usedOutputTokens: 0,
      maxInputTokens: 72_000,
      maxOutputTokens: 48_000,
      maxTotalTokens: 120_000,
    })
    const events = (await service.readEvents({ runId: limited.runId, limit: 100 })).events
    expect(events.some(event => event.type === 'debate.round.started')).toBe(false)
    expect(events.some(event => event.type === 'debate.agent.dispatched')).toBe(false)
    const admission = events.find(event => event.type === 'debate.convergence.evaluated'
      && event.data.status === 'budget_limited')
    expect(admission?.data).toMatchObject({
      budgetKind: 'input-tokens',
      budgetUsed: 0,
      budgetReserved: 73_638,
      budgetLimit: 72_000,
      reason: 'input token budget preflight denied (used 0 + reserved 73638 >= limit 72000)',
    })
    await expectTerminalConvergenceOrder(service, limited.runId, 'budget_limited', 'budget_limited')
  })

  it('labels a configured single round as max-round completion rather than budget limited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-single-round-'))
    const singleRoundPolicy = policy('enabled', { maxRounds: 1 })
    const service = await provider(root, async turn => resultFor(turn))
    const pending = await service.start(request('enabled', {
      commandId: 'start-single-round',
      policy: {
        ...singleRoundPolicy,
        convergence: { ...singleRoundPolicy.convergence, scoreThreshold: 1 },
      },
    }))
    const completed = await service.control({
      version: 1,
      commandId: 'control-single-round',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture compact debate completion',
    })

    expect(completed.state).toBe('max_rounds')
    expect(completed.rounds).toHaveLength(1)
    const events = (await service.readEvents({ runId: completed.runId, limit: 100 })).events
    const terminal = events.find(event => event.type === 'debate.convergence.evaluated'
      && event.data.status === 'max_rounds')
    expect(terminal?.data.reason).toBe('configured single-round Debate completed without convergence')
    expect(events.some(event => event.type === 'debate.convergence.evaluated'
      && event.data.status === 'budget_limited')).toBe(false)
    await expectTerminalConvergenceOrder(service, completed.runId, 'max_rounds', 'max_rounds')
  })
  it('rejects a new follow-up claim instead of expanding outside the ledger', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-ledger-'))
    const service = await provider(root, async turn => resultFor(turn, { newClaim: turn.round > 1 }))
    const pending = await service.start(request('enabled', {
      commandId: 'start-ledger',
      policy: { ...policy('enabled'), convergence: { ...policy('enabled').convergence, scoreThreshold: 1 } },
    }))
    const failed = await service.control({
      version: 1, commandId: 'control-ledger', runId: pending.runId, expectedRevision: pending.revision,
      action: 'approve', reason: 'fixture ledger check',
    })
    expect(failed.state).toBe('failed')
    expect(failed.rounds.at(-1)?.turns.at(0)?.state).toBe('failed')
    const events = (await service.readEvents({ runId: failed.runId, limit: 100 })).events
    expect(events.some((event) => {
      const error = event.data.error
      return event.type === 'debate.agent.failed' && typeof error === 'string' && error.includes('not present in the claim ledger')
    })).toBe(true)
  }, 15_000)

  it('allows bounded decision-judge reconciliation claims in a follow-up round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-judge-reconciliation-'))
    const service = await provider(root, async turn => resultFor(turn, {
      newClaim: turn.round > 1 && turn.role === 'decision-judge',
    }))
    const pending = await service.start(request('enabled', {
      commandId: 'start-judge-reconciliation',
      policy: { ...policy('enabled'), convergence: { ...policy('enabled').convergence, scoreThreshold: 1 } },
    }))
    const completed = await service.control({
      version: 1,
      commandId: 'control-judge-reconciliation',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture bounded judge reconciliation',
    })
    expect(completed.state).toBe('max_rounds')
    expect(completed.claimLedger.claims.some(claim => claim.claimId === 'claim:new:2:decision-judge')).toBe(true)
    expect(completed.synthesis).toMatchObject({ state: 'settled' })
  })

  it('rejects an unbounded number of new decision-judge follow-up claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-judge-expansion-'))
    const service = await provider(root, async (turn) => {
      const result = resultFor(turn)
      if (turn.round === 1 || turn.role !== 'decision-judge') return result
      return {
        ...result,
        claims: Array.from({ length: 5 }, (_, index) => claim({
          claimId: `claim:judge-new:${String(index)}`,
          supportingSlotIds: [turn.slotId],
        })),
      }
    })
    const pending = await service.start(request('enabled', {
      commandId: 'start-judge-expansion',
      policy: { ...policy('enabled'), convergence: { ...policy('enabled').convergence, scoreThreshold: 1 } },
    }))
    const failed = await service.control({
      version: 1,
      commandId: 'control-judge-expansion',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture rejects unbounded judge expansion',
    })
    expect(failed.state).toBe('failed')
    const events = (await service.readEvents({ runId: failed.runId, limit: 100 })).events
    expect(events.some(event => event.type === 'debate.agent.failed'
      && event.data.error === 'follow-up decision judge may add at most 4 reconciliation claims')).toBe(true)
  })

  it('supports auto and disabled modes without requiring an external model or CLI', async () => {
    const autoRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-auto-'))
    let autoCalls = 0
    const autoService = await provider(autoRoot, async (turn) => {
      autoCalls += 1
      return resultFor(turn)
    })
    const auto = await autoService.start(request('auto'))
    expect(auto.state).toBe('completed')
    expect(autoCalls).toBe(3)
    expect(await autoService.start(request('auto'))).toEqual(auto)

    const disabledRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-disabled-'))
    let disabledCalls = 0
    const disabledService = await provider(disabledRoot, async (turn) => {
      disabledCalls += 1
      return resultFor(turn)
    })
    const disabled = await disabledService.start(request('disabled'))
    expect(disabled.state).toBe('stopped')
    expect(disabledCalls).toBe(0)
  })

  it('persists a running receipt before execution and recovers an unproven command as indeterminate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-receipt-'))
    let entered!: () => void
    const executing = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const service = await provider(root, async (turn) => {
      entered()
      await gate
      return resultFor(turn)
    })
    const startRequest = request('auto', { commandId: 'start-crash-window' })
    const running = service.start(startRequest)
    await executing

    const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      commands: Array<{ commandId: string; runId: string; state: string }>
    }
    expect(persisted.commands).toContainEqual(expect.objectContaining({
      commandId: 'start-crash-window',
      runId: 'run-fixture',
      state: 'running',
    }))

    const recoveryRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-recovered-'))
    await writeFile(join(recoveryRoot, 'state.json'), `${JSON.stringify(persisted)}\n`, { mode: 0o600 })
    const recovered = await provider(recoveryRoot, async () => {
      throw new Error('recovery must not replay an unproven command')
    })
    await expect(recovered.inspect('run-fixture')).resolves.toMatchObject({ state: 'indeterminate' })
    await expect(recovered.start(startRequest)).rejects.toMatchObject({ code: 'DEBATE_INDETERMINATE' })

    release()
    await expect(running).resolves.toMatchObject({ state: 'completed' })
  })

  it('recovers a pending receipt as settled only when the terminal outcome is proven', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-proven-receipt-'))
    const source = await provider(sourceRoot, async turn => resultFor(turn))
    const startRequest = request('auto', { commandId: 'start-proven-terminal' })
    const completed = await source.start(startRequest)
    expect(completed.state).toBe('completed')

    type PersistedState = {
      commands: Array<{ commandId: string; runId: string; state: string; response?: unknown }>
      runs: Array<{ events: Array<{ type: string }> }>
      [key: string]: unknown
    }
    const persisted = JSON.parse(await readFile(join(sourceRoot, 'state.json'), 'utf8')) as PersistedState
    const command = persisted.commands.find(entry => entry.commandId === startRequest.commandId)
    if (command === undefined) throw new Error('fixture command receipt is missing')
    command.state = 'running'
    delete command.response

    const recoveryRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-proven-recovered-'))
    await writeFile(join(recoveryRoot, 'state.json'), `${JSON.stringify(persisted)}\n`, { mode: 0o600 })
    const recovered = await provider(recoveryRoot, async () => {
      throw new Error('proven recovery must not execute another turn')
    })
    await expect(recovered.start(startRequest)).resolves.toEqual(completed)
    const settledState = JSON.parse(await readFile(join(recoveryRoot, 'state.json'), 'utf8')) as PersistedState
    expect(settledState.commands.find(entry => entry.commandId === startRequest.commandId)).toMatchObject({
      state: 'settled',
      response: completed,
    })

    const unproven = JSON.parse(JSON.stringify(persisted)) as PersistedState
    const run = unproven.runs[0]
    if (run === undefined) throw new Error('fixture Debate run is missing')
    run.events = run.events.filter(event => event.type !== 'debate.synthesis.settled')
    const unprovenRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-unproven-terminal-'))
    await writeFile(join(unprovenRoot, 'state.json'), `${JSON.stringify(unproven)}\n`, { mode: 0o600 })
    const uncertain = await provider(unprovenRoot, async () => {
      throw new Error('unproven recovery must not execute another turn')
    })
    await expect(uncertain.start(startRequest)).rejects.toMatchObject({ code: 'DEBATE_INDETERMINATE' })
  })

  it.each([
    { label: 'a published settled control receipt with omitted control fields', variant: 'settled-fields' as const },
    { label: 'an unversioned settled control receipt', variant: 'unversioned' as const },
  ])('recovers and rewrites $label without redispatch', async ({ variant }) => {
    type PersistedCommand = {
      commandId: string
      version?: number
      state?: string
      action?: string
      expectedRevision?: number
    }
    type PersistedState = {
      commands: PersistedCommand[]
      [key: string]: unknown
    }

    const root = await mkdtemp(join(tmpdir(), `dsh-debate-local-${variant}-`))
    const source = await provider(root, async turn => resultFor(turn))
    const startRequest = request('enabled', {
      commandId: `start-${variant}`,
      policy: policy('enabled', { maxRounds: 1 }),
    })
    const pending = await source.start(startRequest)
    const approve = {
      version: 1 as const,
      commandId: `approve-${variant}`,
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve' as const,
      reason: `fixture ${variant} receipt`,
    }
    const completed = await source.control(approve)
    expect(completed.state).toBe('completed')
    const originalEvents = (await source.readEvents({ runId: completed.runId, limit: 100 })).events

    const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as PersistedState
    const receipt = persisted.commands.find(command => command.commandId === approve.commandId)
    if (receipt === undefined) throw new Error(`fixture ${variant} control receipt is missing`)
    delete receipt.action
    delete receipt.expectedRevision
    if (variant === 'unversioned') delete receipt.version
    await writeFile(join(root, 'state.json'), `${JSON.stringify(persisted)}\n`, { mode: 0o600 })

    let replayCalls = 0
    const restored = await provider(root, async () => {
      replayCalls += 1
      throw new Error(`${variant} receipt replay must not execute another turn`)
    })
    await expect(restored.inspect(completed.runId)).resolves.toEqual(completed)
    await expect(restored.readEvents({ runId: completed.runId, limit: 100 })).resolves.toMatchObject({ events: originalEvents })
    await expect(restored.control(approve)).resolves.toEqual(completed)
    expect(replayCalls).toBe(0)

    const nextRunId = `run-after-${variant}`
    const next = await provider(root, async turn => resultFor(turn), () => nextRunId)
    const nextResult = await next.start(request('auto', { commandId: `start-after-${variant}` }))
    expect(nextResult).toMatchObject({ runId: nextRunId, state: 'completed' })
    const normalized = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as PersistedState
    if (variant === 'unversioned') {
      expect(normalized.commands.find(command => command.commandId === approve.commandId)).toMatchObject({ version: 1, state: 'settled' })
    }

    const restarted = await provider(root, async () => {
      throw new Error(`${variant} receipt must survive the second restart`)
    }, () => 'unused-run-id')
    await expect(restarted.inspect(completed.runId)).resolves.toEqual(completed)
    await expect(restarted.inspect(nextResult.runId)).resolves.toEqual(nextResult)
    await expect(restarted.readEvents({ runId: completed.runId, limit: 100 })).resolves.toMatchObject({ events: originalEvents })
  })

  it('pauses an active run at the round boundary and resumes without replaying the settled round', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-live-pause-'))
    let entered!: () => void
    const executing = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const turns: DebateTurnRequestV1[] = []
    const service = await provider(root, async (turn) => {
      turns.push(turn)
      if (turn.round === 1) {
        entered()
        await gate
      }
      return resultFor(turn, { unresolved: turn.round === 1 })
    })
    const running = service.start(request('auto', { commandId: 'start-live-pause' }))
    await executing
    const active = await service.inspect('run-fixture')
    const pausing = service.control({
      version: 1,
      commandId: 'control-live-pause',
      runId: active.runId,
      expectedRevision: active.revision,
      action: 'pause',
      reason: 'pause after the current round',
    })
    let pausePersisted = false
    for (let attempt = 0; attempt < 50 && !pausePersisted; attempt += 1) {
      const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
        runs: Array<{ controlIntent?: { action?: string } }>
      }
      pausePersisted = persisted.runs[0]?.controlIntent?.action === 'pause'
      if (!pausePersisted) await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    }
    expect(pausePersisted).toBe(true)
    release()
    const [pausedFromStart, pausedFromControl] = await Promise.all([running, pausing])
    expect(pausedFromStart.state).toBe('stopped')
    expect(pausedFromControl).toEqual(pausedFromStart)
    expect(pausedFromStart.currentRound).toBe(1)

    const resumed = await service.control({
      version: 1,
      commandId: 'control-live-resume',
      runId: pausedFromStart.runId,
      expectedRevision: pausedFromStart.revision,
      action: 'resume',
      reason: 'continue the next round',
    })
    expect(resumed.state).toBe('completed')
    expect(turns.filter(turn => turn.round === 1)).toHaveLength(3)
    expect(turns.filter(turn => turn.round === 2)).toHaveLength(3)
  })

  it('stops an active run by interrupting its current round instead of waiting for completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-live-stop-'))
    let entered!: () => void
    const executing = new Promise<void>((resolve) => { entered = resolve })
    const ctx = new Context()
    contexts.push(ctx)
    const roundExecutor: DebateRoundExecutorPort = {
      executeRound(round) {
        entered()
        return new Promise((_resolve, reject) => {
          const interrupt = () =>{  reject(new DebateError('fixture TaskGraph cancelled', 'DEBATE_INTERRUPTED')) }
          if (round.signal?.aborted === true) interrupt()
          else round.signal?.addEventListener('abort', interrupt, { once: true })
        })
      },
    }
    const service = new LocalDebateProvider(ctx, {
      root,
      executor: roundExecutor,
      idFactory: () => 'run-fixture',
    })
    const running = service.start(request('auto', { commandId: 'start-live-stop' }))
    await executing
    const active = await service.inspect('run-fixture')
    const stopped = await service.control({
      version: 1,
      commandId: 'control-live-stop',
      runId: active.runId,
      expectedRevision: active.revision,
      action: 'stop',
      reason: 'stop the active TaskGraph',
    })
    expect(stopped.state).toBe('stopped')
    await expect(running).resolves.toEqual(stopped)
    await expect(service.control({
      version: 1,
      commandId: 'control-live-stop',
      runId: active.runId,
      expectedRevision: active.revision,
      action: 'stop',
      reason: 'stop the active TaskGraph',
    })).resolves.toEqual(stopped)
  })

  it('grants two new settled rounds at a time without redispatching sealed rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-'))
    const turns: DebateTurnRequestV1[] = []
    const initialPolicy = policy('enabled', { maxRounds: 1, maxTurnsPerAgent: 1 })
    const service = await provider(root, async (turn) => {
      turns.push(turn)
      return resultFor(turn)
    })
    const pending = await service.start(request('enabled', {
      commandId: 'start-continuation',
      policy: initialPolicy,
    }))
    const first = await service.control({
      version: 1,
      commandId: 'approve-continuation',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture initial settlement',
    })
    expect(first).toMatchObject({ state: 'completed', currentRound: 1 })
    expect(first.continuation).toMatchObject({
      effectiveBudget: { maxRounds: 1, maxTurnsPerAgent: 1, maxCostUsd: 2 },
      offeredAllowance: { additionalRounds: 2, additionalTurnsPerAgent: 2 },
      eligibility: { status: 'eligible', reason: 'eligible' },
    })

    const firstCommand = {
      version: 1 as const,
      commandId: 'continue-1',
      runId: first.runId,
      expectedRevision: first.revision,
      action: 'continue' as const,
      reason: '继续讨论 2 轮',
    }
    const afterFirstGrant = await service.control(firstCommand)
    expect(afterFirstGrant).toMatchObject({ state: 'completed', currentRound: 3 })
    expect(afterFirstGrant.policy).toEqual(initialPolicy)
    expect(afterFirstGrant.continuation).toMatchObject({
      grants: [{ commandId: 'continue-1', firstRound: 2, lastRound: 3 }],
      synthesisHistory: [{ throughRound: 1, synthesis: first.synthesis }],
      effectiveBudget: { maxRounds: 3, maxTurnsPerAgent: 3, maxCostUsd: 2 },
      eligibility: { status: 'eligible' },
    })
    await expect(service.control(firstCommand)).resolves.toEqual(afterFirstGrant)
    expect(turns.map(turn => turn.round)).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3])
    expect(turns.filter(turn => turn.round > 1).every(turn => turn.priorLedger.claims.some(entry => entry.claimId === 'claim:answer'))).toBe(true)

    const secondCommand = {
      version: 1 as const,
      commandId: 'continue-2',
      runId: afterFirstGrant.runId,
      expectedRevision: afterFirstGrant.revision,
      action: 'continue' as const,
      reason: '继续讨论 2 轮',
    }
    const afterSecondGrant = await service.control(secondCommand)
    expect(afterSecondGrant).toMatchObject({ state: 'completed', currentRound: 5 })
    expect(afterSecondGrant.continuation).toMatchObject({
      grants: [
        { commandId: 'continue-1', firstRound: 2, lastRound: 3 },
        { commandId: 'continue-2', firstRound: 4, lastRound: 5 },
      ],
      synthesisHistory: [
        { throughRound: 1, synthesis: first.synthesis },
        { throughRound: 3, synthesis: afterFirstGrant.synthesis },
      ],
      effectiveBudget: { maxRounds: 5, maxTurnsPerAgent: 5, maxCostUsd: 2 },
    })
    expect(turns.map(turn => turn.round)).toEqual([
      1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5,
    ])
    const events = (await service.readEvents({ runId: afterSecondGrant.runId, limit: 100 })).events
    expect(events.filter(event => event.type === 'debate.round.started').map(event => event.round)).toEqual([1, 2, 3, 4, 5])
    expect(events.filter(event => event.type === 'debate.continuation.granted').map(event => [event.round, event.data.lastRound]))
      .toEqual([[2, 3], [4, 5]])
    expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1))

    const reloaded = await provider(root, async () => {
      throw new Error('reloaded continuation must not redispatch settled rounds')
    })
    await expect(reloaded.inspect(afterSecondGrant.runId)).resolves.toEqual(afterSecondGrant)
  })

  it('projects continuation capacity for a released settled snapshot before its first extension', async () => {
    const sourceRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-legacy-source-'))
    const source = await provider(sourceRoot, async turn => resultFor(turn))
    const original = await source.start(request('auto', {
      commandId: 'start-continuation-legacy',
      policy: policy('auto', { maxRounds: 1, maxTurnsPerAgent: 1 }),
    }))
    type PersistedState = {
      runs: Array<{ snapshot: { continuation?: unknown; result?: unknown } }>
      commands: Array<{ response?: { continuation?: unknown; result?: unknown } }>
      [key: string]: unknown
    }
    const persisted = JSON.parse(await readFile(join(sourceRoot, 'state.json'), 'utf8')) as PersistedState
    const storedRun = persisted.runs[0]
    if (storedRun === undefined) throw new Error('fixture legacy run is missing')
    delete storedRun.snapshot.continuation
    delete storedRun.snapshot.result
    for (const command of persisted.commands) {
      if (command.response === undefined) continue
      delete command.response.continuation
      delete command.response.result
    }
    const legacyRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-legacy-'))
    await writeFile(join(legacyRoot, 'state.json'), `${JSON.stringify(persisted)}\n`, { mode: 0o600 })
    const restored = await provider(legacyRoot, async turn => resultFor(turn))
    const projected = await restored.inspect(original.runId)
    expect(projected.continuation).toMatchObject({
      effectiveBudget: { maxRounds: 1, maxTurnsPerAgent: 1 },
      offeredAllowance: { additionalRounds: 2 },
      eligibility: { status: 'eligible' },
    })
    const extended = await restored.control({
      version: 1,
      commandId: 'continue-legacy',
      runId: projected.runId,
      expectedRevision: projected.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })
    expect(extended).toMatchObject({ currentRound: 3, continuation: { grants: [{ commandId: 'continue-legacy' }] } })
  })

  it('persists a pending replacement summary and one receipt before a continuation round executes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-pending-'))
    let entered!: () => void
    const enteredRound = new Promise<void>((resolve) => { entered = resolve })
    let release!: () => void
    const releaseRound = new Promise<void>((resolve) => { release = resolve })
    let held = false
    const service = await provider(root, async (turn) => {
      if (turn.round === 2 && !held) {
        held = true
        entered()
        await releaseRound
      }
      return resultFor(turn)
    })
    const initial = await service.start(request('auto', {
      commandId: 'start-continuation-pending',
      policy: policy('auto', { maxRounds: 1, maxTurnsPerAgent: 1 }),
    }))
    const command = {
      version: 1 as const,
      commandId: 'continue-pending',
      runId: initial.runId,
      expectedRevision: initial.revision,
      action: 'continue' as const,
      reason: '继续讨论 2 轮',
    }
    const continuing = service.control(command)
    await enteredRound
    const active = await service.inspect(initial.runId)
    expect(active).toMatchObject({
      state: 'round_running',
      currentRound: 2,
      synthesis: { state: 'pending' },
      result: { outcome: 'running' },
      continuation: {
        grants: [{ commandId: 'continue-pending', firstRound: 2, lastRound: 3 }],
        synthesisHistory: [{ throughRound: 1, synthesis: initial.synthesis }],
      },
    })
    await expect(service.control({
      version: 1,
      commandId: 'continue-while-running',
      runId: active.runId,
      expectedRevision: active.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toMatchObject({ code: 'DEBATE_STATE_CONFLICT' })
    const persisted = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as {
      commands: Array<{ commandId: string; state: string; action?: string; expectedRevision?: number }>
    }
    expect(persisted.commands.find(receipt => receipt.commandId === command.commandId)).toMatchObject({
      state: 'running',
      action: 'continue',
      expectedRevision: initial.revision,
    })
    const recoveryRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-recovered-'))
    await writeFile(join(recoveryRoot, 'state.json'), `${JSON.stringify(persisted)}\n`, { mode: 0o600 })
    const recovered = await provider(recoveryRoot, async () => {
      throw new Error('continuation recovery must not replay a pending TaskGraph')
    })
    const indeterminate = await recovered.inspect(initial.runId)
    expect(indeterminate).toMatchObject({
      state: 'indeterminate',
      continuation: {
        grants: [{ commandId: 'continue-pending', firstRound: 2, lastRound: 3 }],
        effectiveBudget: { maxRounds: 3 },
      },
    })
    await expect(recovered.control(command)).rejects.toMatchObject({ code: 'DEBATE_INDETERMINATE' })
    const replay = service.control(command)
    release()
    const [settled, replayed] = await Promise.all([continuing, replay])
    expect(replayed).toEqual(settled)
    expect(settled.continuation?.grants).toHaveLength(1)
  })

  it('delivers the sealed ledger, dissent, unresolved gaps, participants, and evidence to continuation rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-context-'))
    const turns: DebateTurnRequestV1[] = []
    const service = await provider(root, async (turn) => {
      turns.push(turn)
      const result = resultFor(turn, { unresolved: turn.round === 1 })
      return turn.round !== 1 ? result : {
        ...result,
        dissent: [{
          version: 1,
          slotId: turn.slotId,
          claimId: 'claim:answer',
          position: 'The fixture keeps a material alternative visible.',
          reason: 'The first-round evidence is deliberately incomplete.',
          confidence: 0.2,
          evidenceRefs: [{ version: 1, ref: `fixture:dissent:${turn.slotId}`, kind: 'observation' }],
        }],
      }
    })
    const initialPolicy = policy('auto', { maxRounds: 1, maxTurnsPerAgent: 1 })
    const settled = await service.start(request('auto', {
      commandId: 'start-continuation-context',
      policy: initialPolicy,
    }))
    expect(settled.state).toBe('max_rounds')
    const extended = await service.control({
      version: 1,
      commandId: 'continue-context',
      runId: settled.runId,
      expectedRevision: settled.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })
    expect(extended.currentRound).toBe(3)
    const secondRound = turns.filter(turn => turn.round === 2)
    expect(secondRound).toHaveLength(3)
    expect(secondRound.every(turn => turn.phase === 'high-severity-unresolved')).toBe(true)
    expect(secondRound.every(turn => turn.priorLedger.claims.some(claim => claim.claimId === 'claim:answer'))).toBe(true)
    expect(secondRound.every(turn => turn.priorDissent.length === 3)).toBe(true)
    // All three first-round slots identify the same unresolved claim; the
    // durable ledger intentionally canonicalizes it before the next round.
    expect(secondRound.every(turn => turn.priorUnresolved.length === 1)).toBe(true)
    expect(secondRound.every(turn => turn.priorUnresolved[0]?.claimId === 'claim:answer')).toBe(true)
    expect(secondRound.every(turn => turn.sourceRefs.some(ref => ref.ref === 'fixture:brief'))).toBe(true)
    expect(secondRound.map(turn => turn.slotId)).toEqual([
      'constructive-proposer', 'skeptical-falsifier', 'decision-judge',
    ])
  })

  it('extends a known token-limited run but refuses unknown usage accounting', async () => {
    const exhaustedRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-exhausted-'))
    const rounds: number[] = []
    const exhaustedPolicy = policy('auto', {
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxInputTokens: 30,
      maxOutputTokens: 20,
      maxTotalTokens: 50,
    })
    const exhausted = await provider(exhaustedRoot, async (turn) => {
      rounds.push(turn.round)
      return resultFor(turn)
    })
    const limited = await exhausted.start(request('auto', {
      commandId: 'start-continuation-exhausted',
      policy: exhaustedPolicy,
    }))
    expect(limited).toMatchObject({
      state: 'budget_limited',
      cost: { usageStatus: 'known', inputTokens: 30 },
      continuation: {
        eligibility: { status: 'eligible', reason: 'eligible' },
        offeredAllowance: { additionalInputTokens: 61, additionalOutputTokens: 40 },
      },
    })
    const extended = await exhausted.control({
      version: 1,
      commandId: 'continue-exhausted',
      runId: limited.runId,
      expectedRevision: limited.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })
    expect(extended).toMatchObject({
      state: 'completed',
      currentRound: 3,
      continuation: { effectiveBudget: { maxInputTokens: 91, maxCostUsd: 2 } },
    })
    expect(rounds).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3])

    const unknownRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-unknown-'))
    const unknown = await provider(unknownRoot, async (turn) => {
      const { usage: _usage, ...withoutUsage } = resultFor(turn)
      return withoutUsage
    })
    const unknownRun = await unknown.start(request('auto', {
      commandId: 'start-continuation-unknown',
      policy: policy('auto', { maxRounds: 1, maxTurnsPerAgent: 1 }),
    }))
    expect(unknownRun).toMatchObject({
      state: 'budget_limited',
      continuation: { eligibility: { status: 'ineligible', reason: 'usage_accounting_unknown' } },
    })
    await expect(unknown.control({
      version: 1,
      commandId: 'continue-unknown',
      runId: unknownRun.runId,
      expectedRevision: unknownRun.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toMatchObject({ code: 'DEBATE_STATE_CONFLICT' })
  })

  it('fences competing continuation commands and rejects unsafe continuation states', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-fence-'))
    const service = await provider(root, async turn => resultFor(turn))
    const pending = await service.start(request('enabled', {
      commandId: 'start-continuation-fence',
      policy: policy('enabled', { maxRounds: 1, maxTurnsPerAgent: 1 }),
    }))
    const settled = await service.control({
      version: 1,
      commandId: 'approve-continuation-fence',
      runId: pending.runId,
      expectedRevision: pending.revision,
      action: 'approve',
      reason: 'fixture initial settlement',
    })
    const competing = await Promise.allSettled([
      service.control({
        version: 1,
        commandId: 'continue-fence-a',
        runId: settled.runId,
        expectedRevision: settled.revision,
        action: 'continue',
        reason: '继续讨论 2 轮',
      }),
      service.control({
        version: 1,
        commandId: 'continue-fence-b',
        runId: settled.runId,
        expectedRevision: settled.revision,
        action: 'continue',
        reason: '继续讨论 2 轮',
      }),
    ])
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = competing.find(result => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'DEBATE_REVISION_CONFLICT' } })
    const latest = await service.inspect(settled.runId)
    expect(latest.continuation?.grants).toHaveLength(1)

    const meteredRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-metered-'))
    const meteredBase = policy('auto', { maxRounds: 1, maxTurnsPerAgent: 1, maxCostUsd: 0.05 })
    const meteredPolicy: DebatePolicyV1 = {
      ...meteredBase,
      roster: meteredBase.roster.map(role => ({ ...role, source: 'metered-api' as const })),
    }
    const metered = await provider(meteredRoot, async turn => resultFor(turn))
    const meteredRun = await metered.start(request('auto', {
      commandId: 'start-continuation-metered',
      policy: meteredPolicy,
    }))
    expect(meteredRun.continuation).toMatchObject({
      eligibility: {
        status: 'approval_required',
        reason: 'cost_cap_requires_approval',
        costLimit: { limitUsd: 0.05, usedUsd: 0.03, reservedUsd: 0.06 },
      },
    })
    expect(meteredRun.continuation?.effectiveBudget.maxCostUsd).toBe(0.05)
    await expect(metered.control({
      version: 1,
      commandId: 'continue-metered',
      runId: meteredRun.runId,
      expectedRevision: meteredRun.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toThrow('caller cost cap')

    const rejectedRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-rejected-'))
    const rejectedProvider = await provider(rejectedRoot, async turn => resultFor(turn))
    const awaiting = await rejectedProvider.start(request('enabled', { commandId: 'start-continuation-rejected' }))
    const rejectedRun = await rejectedProvider.control({
      version: 1,
      commandId: 'reject-continuation',
      runId: awaiting.runId,
      expectedRevision: awaiting.revision,
      action: 'reject',
      reason: 'fixture rejection',
    })
    await expect(rejectedProvider.control({
      version: 1,
      commandId: 'continue-rejected',
      runId: rejectedRun.runId,
      expectedRevision: rejectedRun.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toMatchObject({ code: 'DEBATE_STATE_CONFLICT' })

    const stoppedRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-stopped-'))
    const stoppedProvider = await provider(stoppedRoot, async turn => resultFor(turn))
    const pausable = await stoppedProvider.start(request('enabled', { commandId: 'start-continuation-stopped' }))
    const stoppedRun = await stoppedProvider.control({
      version: 1,
      commandId: 'pause-continuation',
      runId: pausable.runId,
      expectedRevision: pausable.revision,
      action: 'pause',
      reason: 'fixture pause',
    })
    await expect(stoppedProvider.control({
      version: 1,
      commandId: 'continue-stopped',
      runId: stoppedRun.runId,
      expectedRevision: stoppedRun.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toMatchObject({ code: 'DEBATE_STATE_CONFLICT' })

    const failedRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-failed-'))
    const failedProvider = await provider(failedRoot, async () => {
      throw new DebateError('fixture execution failure', 'DEBATE_PROVIDER_UNAVAILABLE')
    })
    const failedRun = await failedProvider.start(request('auto', { commandId: 'start-continuation-failed' }))
    expect(failedRun.state).toBe('failed')
    await expect(failedProvider.control({
      version: 1,
      commandId: 'continue-failed',
      runId: failedRun.runId,
      expectedRevision: failedRun.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toMatchObject({ code: 'DEBATE_STATE_CONFLICT' })

    const indeterminateRoot = await mkdtemp(join(tmpdir(), 'dsh-debate-local-continuation-indeterminate-'))
    const indeterminateProvider = await provider(indeterminateRoot, async () => {
      throw new DebateError('fixture outcome is unknown', 'DEBATE_INDETERMINATE')
    })
    const indeterminateRun = await indeterminateProvider.start(request('auto', { commandId: 'start-continuation-indeterminate' }))
    expect(indeterminateRun.state).toBe('indeterminate')
    await expect(indeterminateProvider.control({
      version: 1,
      commandId: 'continue-indeterminate',
      runId: indeterminateRun.runId,
      expectedRevision: indeterminateRun.revision,
      action: 'continue',
      reason: '继续讨论 2 轮',
    })).rejects.toMatchObject({ code: 'DEBATE_STATE_CONFLICT' })
  })
})
