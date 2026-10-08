import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import DebateService, {
  validateDebatePolicy,
  type DebateControlRequestV1,
  type DebateEventV1,
  type DebateEventPageV1,
  type DebateEventReadRequestV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateStartRequestV1,
} from '@deepseek-ai/dsh-debate'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as tool from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function snapshot(overrides: Partial<DebateRunSnapshotV1> = {}): DebateRunSnapshotV1 {
  const evidence = { version: 1 as const, ref: 'artifact:evidence', kind: 'artifact' as const }
  const ledger = { version: 1 as const, claims: [], coverage: 1, digest: 'sha256:ledger' }
  const turn = {
    version: 1 as const,
    round: 1,
    slotId: 'slot-proposer',
    role: 'constructive-proposer' as const,
    operatorId: 'codex',
    model: 'gpt-5.6-sol',
    state: 'settled' as const,
    outputRef: 'artifact:proposer-output',
    outputPreview: 'Proposal output summary',
    claimIds: [],
    evidenceRefs: [],
  }
  return {
    version: 1,
    runId: 'debate-run-1',
    revision: 4,
    state: 'completed',
    mode: 'enabled',
    promptSha256: 'sha256:prompt',
    objective: 'Reach an evidence-backed decision.',
    policy: tool.DEFAULT_DEBATE_POLICY,
    roster: tool.DEFAULT_DEBATE_POLICY.roster,
    currentRound: 1,
    rounds: [{
      version: 1,
      round: 1,
      state: 'completed',
      turns: [turn],
      claimLedger: ledger,
      dissent: [],
      unresolved: [],
      convergence: {
        version: 1,
        status: 'converged',
        score: 0.9,
        threshold: 0.82,
        disagreement: 0.1,
        coverage: 1,
        unresolvedHighSeverity: 0,
        settledAgents: 4,
        reason: 'evidence-backed convergence',
      },
    }],
    claimLedger: ledger,
    dissent: [],
    unresolved: [],
    evidence: { version: 1, refs: [evidence], coverage: 1, missingRefs: [], lineage: ['artifact:evidence'] },
    cost: {
      version: 1,
      usageStatus: 'known',
      costStatus: 'known',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsd: 0,
      unknownUsageTurns: 0,
      unknownCostTurns: 0,
      bySlot: [],
    },
    provenance: {
      version: 1,
      providerId: 'fixture',
      providerVersion: '1',
      requestSha256: 'sha256:request',
      policySha256: 'sha256:policy',
      sourceSessionId: 'session-debate',
      outputSha256: 'sha256:output',
    },
    synthesis: {
      version: 1,
      state: 'settled',
      artifactRef: 'artifact:synthesis',
      outputPreview: 'Decision summary',
      unresolvedClaimIds: [],
      dissentCount: 0,
    },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:01:00.000Z',
    ...overrides,
  }
}

function roundsWithStates(
  states: readonly DebateRunSnapshotV1['rounds'][number]['state'][],
): DebateRunSnapshotV1['rounds'] {
  const template = snapshot().rounds[0]
  if (template === undefined) throw new Error('missing Debate fixture round')
  return states.map((state, index) => ({
    ...template,
    round: index + 1,
    state,
    turns: template.turns.map(turn => ({ ...turn, round: index + 1 })),
  }))
}

class ScriptedDebates extends DebateService {
  readonly run = snapshot()
  startResult: DebateRunSnapshotV1 = this.run
  controlResult: DebateRunSnapshotV1 = this.run
  inspectFallback: DebateRunSnapshotV1 = this.run
  readonly inspectSnapshots: DebateRunSnapshotV1[] = []
  readonly events: DebateEventV1[] = []
  controlGate: Promise<DebateRunSnapshotV1> | undefined
  readonly starts: DebateStartRequestV1[] = []
  readonly controls: DebateControlRequestV1[] = []

  async start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1> {
    this.starts.push(request)
    return this.startResult
  }

  async list(): Promise<readonly DebateRunSummaryV1[]> {
    return Array.from({ length: 22 }, (_, index) => ({
      version: 1,
      runId: `run-${index}`,
      state: 'completed',
      mode: 'enabled',
      currentRound: 1,
      revision: index,
      unresolvedCount: 0,
      cost: this.run.cost,
      updatedAt: this.run.updatedAt,
    }))
  }

  async inspect(_runId: string): Promise<DebateRunSnapshotV1> {
    return this.inspectSnapshots.shift() ?? this.inspectFallback
  }
  async readEvents(request: DebateEventReadRequestV1): Promise<DebateEventPageV1> {
    const afterSequence = request.afterSequence ?? 0
    const events = this.events.filter(event => event.sequence > afterSequence).slice(0, request.limit ?? 20)
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence }
  }

  async control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1> {
    this.controls.push(request)
    return this.controlGate ?? this.controlResult
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptedDebates)
  await ctx.plugin(tool)
  const session = ctx.sessions.create(SessionId('session-debate'), { meta: { cwd: '/workspace' } })
  const agent = { id: session.id, session } as Agent
  return { ctx, agent, provider: ctx.debates as ScriptedDebates }
}

/** Write an event whose type this build no longer declares, as an older build did. */
function appendRetiredEvent(agent: Agent, type: string, data: unknown): void {
  (agent.session as unknown as { append(type: string, data: unknown, options: object): void })
    .append(type, data, { ignorable: true })
}

/** Make the Session a kennel Session, the only place a Debate may start. */
function markKennel(agent: Agent): void {
  agent.session.append('agent-preset/selected', { agentPreset: 'kennel' })
}

let calls = 0
function call(ctx: Context, agent: Agent | undefined, argumentsValue: unknown, callId?: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId ?? `debate-${++calls}`),
    name: 'debate',
    arguments: argumentsValue,
    ...agent === undefined ? {} : { agent },
  })
}

function resultValue(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  expect(result.isError).toBe(false)
  return result.isError ? {} : result.value as Record<string, unknown>
}

describe('debate model Consumer', () => {
  it('separates presentation brevity from deterministic initial debate depth and per-round capacity', () => {
    const cases = [{
      prompt: '请简洁讨论并给出三条结论',
      plan: { plannedRounds: 3, reason: 'ordinary' },
      budget: { maxRounds: 3, maxInputTokens: 1_200_000, maxOutputTokens: 180_000, maxTotalTokens: 1_380_000 },
    }, {
      prompt: '只讨论一轮，即使这是架构问题。',
      plan: { plannedRounds: 1, reason: 'explicit-one-round' },
      budget: { maxRounds: 1, maxInputTokens: 400_000, maxOutputTokens: 60_000, maxTotalTokens: 460_000 },
    }, {
      prompt: 'Give a quick basic comparison.',
      plan: { plannedRounds: 2, reason: 'quick-or-basic' },
      budget: { maxRounds: 2, maxInputTokens: 800_000, maxOutputTokens: 120_000, maxTotalTokens: 920_000 },
    }, {
      prompt: 'Evaluate this contested choice.',
      plan: { plannedRounds: 3, reason: 'ordinary' },
      budget: { maxRounds: 3, maxInputTokens: 1_200_000, maxOutputTokens: 180_000, maxTotalTokens: 1_380_000 },
    }, {
      prompt: 'Design a deep system architecture with multi-constraint tradeoffs.',
      plan: { plannedRounds: 4, reason: 'deep-or-system-design' },
      budget: { maxRounds: 4, maxInputTokens: 1_600_000, maxOutputTokens: 240_000, maxTotalTokens: 1_840_000 },
    }]

    for (const fixture of cases) {
      const plan = tool.debateInitialPlanForPrompt(fixture.prompt)
      const policy = tool.debatePolicyForPrompt(fixture.prompt)
      expect(plan).toMatchObject(fixture.plan)
      expect(policy.roster).toHaveLength(4)
      expect(policy.budget).toMatchObject({
        ...fixture.budget,
        maxTurnsPerAgent: fixture.plan.plannedRounds,
        maxAgentsPerRound: 4,
      })
    }

    expect(tool.debateInitialPlanForPrompt('请输出三条 concise 结论。')).toMatchObject({
      plannedRounds: 3,
      reason: 'ordinary',
    })
    expect(tool.DEFAULT_DEBATE_POLICY.budget).toMatchObject({
      maxRounds: 3,
      maxInputTokens: 1_200_000,
      maxOutputTokens: 180_000,
      maxTotalTokens: 1_380_000,
    })
  })

  it('preserves an explicit caller policy and its monetary cap without prompt rewriting', () => {
    const explicitPolicy = {
      ...tool.DEFAULT_DEBATE_POLICY,
      budget: {
        ...tool.DEFAULT_DEBATE_POLICY.budget,
        maxRounds: 1,
        maxTurnsPerAgent: 1,
        maxCostUsd: 7,
      },
    }
    expect(tool.debatePolicyForPrompt('Perform a deep architecture review.', 'enabled', explicitPolicy)).toBe(explicitPolicy)
    expect(validateDebatePolicy(explicitPolicy).budget).toMatchObject({ maxRounds: 1, maxCostUsd: 7 })
  })

  it('projects every durable public Debate event into separately replayable Session trace facts', async () => {
    const { ctx, agent, provider } = await setup()
    const template = snapshot()
    const round = template.rounds[0]
    const turn = round?.turns[0]
    if (round === undefined || turn === undefined) throw new Error('missing Debate fixture turn')
    const claim = {
      version: 1 as const,
      claimId: 'claim-trace',
      statement: 'Evidence verification must block an unsupported completion.',
      status: 'supported' as const,
      severity: 'high' as const,
      confidence: 0.95,
      supportingSlotIds: [turn.slotId],
      opposingSlotIds: [],
      evidenceRefs: [],
    }
    const ledger = { ...template.claimLedger, claims: [claim] }
    const { outputRef: _failedOutputRef, outputPreview: _failedOutputPreview, ...failedTurnBase } = turn
    const failedTurn = {
      ...failedTurnBase,
      slotId: 'slot-falsifier',
      role: 'skeptical-falsifier' as const,
      operatorId: 'claude-code',
      model: 'claude-fable-5',
      state: 'failed' as const,
      claimIds: [],
      evidenceRefs: [],
      errorCode: 'AUTH_MODE_MISMATCH',
      blockers: [{ code: 'AUTH_MODE_MISMATCH', message: 'Claude Code subscription is unavailable.' }],
    }
    const traced = snapshot({
      topic: { version: 1, title: 'Trace every Debate participant.', source: 'user' },
      rounds: [{
        ...round,
        claimLedger: ledger,
        turns: [{
          ...turn,
          claimIds: [claim.claimId],
          evidenceRefs: [{ version: 1, ref: 'artifact:trace-evidence', kind: 'artifact' }],
          routing: {
            version: 1,
            requestedOperatorId: 'claude-code',
            requestedModel: 'claude-fable-5',
            actualOperatorId: 'codex',
            actualModel: 'gpt-5.6-sol',
            fallbackReasonCode: 'MODEL_UNAVAILABLE',
          },
          usage: { inputTokens: 11, outputTokens: 7 },
        }, failedTurn],
      }],
      claimLedger: ledger,
    })
    provider.inspectFallback = traced
    provider.events.push(
      { version: 1, sequence: 1, runId: traced.runId, revision: 1, generation: 1, type: 'debate.planned', createdAt: traced.createdAt, data: {} },
      { version: 1, sequence: 2, runId: traced.runId, revision: 2, generation: 2, type: 'debate.round.started', createdAt: traced.updatedAt, round: 1, data: {} },
      { version: 1, sequence: 3, runId: traced.runId, revision: 3, generation: 3, type: 'debate.agent.dispatched', createdAt: traced.updatedAt, round: 1, slotId: turn.slotId, data: {} },
      { version: 1, sequence: 4, runId: traced.runId, revision: 4, generation: 4, type: 'debate.agent.settled', createdAt: traced.updatedAt, round: 1, slotId: turn.slotId, data: {} },
      { version: 1, sequence: 5, runId: traced.runId, revision: 5, generation: 5, type: 'debate.agent.failed', createdAt: traced.updatedAt, round: 1, slotId: failedTurn.slotId, data: {} },
      { version: 1, sequence: 6, runId: traced.runId, revision: 6, generation: 6, type: 'debate.convergence.evaluated', createdAt: traced.updatedAt, round: 1, data: { status: 'converged' } },
      { version: 1, sequence: 7, runId: traced.runId, revision: 7, generation: 7, type: 'debate.synthesis.started', createdAt: traced.updatedAt, round: 1, data: {} },
      { version: 1, sequence: 8, runId: traced.runId, revision: 8, generation: 8, type: 'debate.synthesis.settled', createdAt: traced.updatedAt, round: 1, data: {} },
    )
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('trace-inspect'), name: 'debate', arguments: '{}',
    })
    await call(ctx, agent, { action: 'inspect', run_id: traced.runId }, 'trace-inspect')

    const traces = agent.session.events.filter((event): event is Extract<typeof event, { type: 'debate/trace' }> => event.type === 'debate/trace')
    expect(traces.map(event => event.data.sourceSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(traces.map(event => event.data.state)).toEqual([
      'planned', 'running', 'dispatched', 'settled', 'failed', 'round-completed', 'synthesis-running', 'synthesis-settled',
    ])
    expect(traces[0]?.data).toMatchObject({
      topic: { title: 'Trace every Debate participant.', source: 'user' },
      sessionTurn: 1,
      sessionStep: 1,
    })
    expect(traces[3]?.data).toMatchObject({
      role: {
        title: '建设性提案者',
        requested: { operatorId: 'claude-code', model: 'claude-fable-5' },
        actual: { operatorId: 'codex', model: 'gpt-5.6-sol' },
        fallbackReasonCode: 'MODEL_UNAVAILABLE',
      },
      publicOutput: { preview: 'Proposal output summary', ref: 'artifact:proposer-output' },
      claims: [{ statement: 'Evidence verification must block an unsupported completion.' }],
      evidenceRefs: [{ ref: 'artifact:trace-evidence' }],
      usage: { inputTokens: 11, outputTokens: 7 },
    })
    expect(traces[2]?.data.role).toMatchObject({ requested: { operatorId: 'claude-code', model: 'claude-fable-5' } })
    expect(traces[2]?.data.role?.actual).toBeUndefined()
    expect(traces[4]?.data).toMatchObject({
      role: { title: '怀疑式证伪者', requested: { operatorId: 'claude-code', model: 'claude-fable-5' } },
    })
    expect(traces[4]?.data.publicOutput).toBeUndefined()
    expect(traces[5]?.data.convergence).toMatchObject({ status: 'converged' })
    expect(traces[6]?.data.synthesis).toMatchObject({ state: 'running', unresolvedCount: 0, dissentCount: 0 })
    expect(traces[6]?.data.synthesis?.outputPreview).toBeUndefined()
    expect(traces[6]?.data.synthesis?.artifactRef).toBeUndefined()
    expect(traces[7]?.data.synthesis).toMatchObject({ state: 'settled', outputPreview: 'Decision summary' })
    expect(new Set(traces.map(event => event.data.sourceSequence)).size).toBe(traces.length)
    expect(JSON.stringify(traces)).not.toContain('slot-proposer')
  })

  it('advertises a provider-neutral tool and a bounded subscription-first roster', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'debate')
    expect(schema).toBeDefined()
    expect(Object.keys(schema!.parameters.properties as object).sort()).toEqual([
      'action', 'control_action', 'expected_revision', 'objective', 'prompt', 'reason', 'run_id',
    ])
    expect(tool.DEFAULT_DEBATE_POLICY.roster.map(role => [role.role, role.operatorId, role.model])).toEqual([
      ['constructive-proposer', 'codex', 'gpt-5.6-sol'],
      ['skeptical-falsifier', 'claude-code', 'claude-fable-5'],
      ['evidence-auditor', 'codex', 'gpt-5.6-sol'],
      ['decision-judge', 'claude-code', 'claude-opus-5'],
    ])
    expect(tool.DEFAULT_DEBATE_POLICY.roster.map(role => [role.role, role.fallbackOperatorIds])).toEqual([
      ['constructive-proposer', undefined],
      ['skeptical-falsifier', ['codex']],
      ['evidence-auditor', undefined],
      ['decision-judge', ['codex']],
    ])
    expect(tool.DEFAULT_DEBATE_POLICY.roster.every(role => role.source === 'native-subscription')).toBe(true)
    expect(validateDebatePolicy(tool.DEFAULT_DEBATE_POLICY).roster).toEqual(tool.DEFAULT_DEBATE_POLICY.roster)
    expect(tool.DEFAULT_DEBATE_POLICY.budget).toMatchObject({ maxRounds: 3, maxAgentsPerRound: 4 })
    expect(tool.DEFAULT_DEBATE_POLICY.preserveDissent).toBe(true)
    expect(tool.debateGuidance).toContain('does not replace the DSH TaskGraph Scheduler')
  })

  it('refuses to start outside a kennel Session, then starts with stable identity, workspace, and Session lineage', async () => {
    const { ctx, agent, provider } = await setup()
    const refused = await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.' }, 'same-call')
    expect(refused.isError).toBe(true)
    expect(refused.content.some(block => block.type === 'text'
      && block.text.includes('only from a kennel Session'))).toBe(true)
    expect(provider.starts).toHaveLength(0)
    // A legacy preference event no longer opens the tool outside the kennel.
    appendRetiredEvent(agent, 'debate/preferences', { mode: 'enabled' })
    expect((await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.' }, 'same-call')).isError).toBe(true)

    markKennel(agent)
    provider.startResult = snapshot({ state: 'awaiting_approval', revision: 2, currentRound: 0, rounds: [] })
    provider.controlResult = snapshot({ revision: 3 })
    const started = await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.', objective: 'Choose safely.' }, 'same-call')
    expect(resultValue(started)).toMatchObject({
      kind: 'start',
      initialPlan: { plannedRounds: 3, reason: 'ordinary', explanation: '普通讨论采用默认深度。' },
      run: { runId: 'debate-run-1', state: 'completed' },
    })
    expect(provider.starts).toHaveLength(1)
    expect(provider.starts[0]).toMatchObject({
      workspace: '/workspace',
      prompt: 'Choose A or B.',
      objective: 'Choose safely.',
      sourceSessionId: 'session-debate',
      execution: { version: 1, kind: 'standalone' },
      policy: { mode: 'enabled', preserveDissent: true, budget: { maxRounds: 3, maxAgentsPerRound: 4 } },
    })
    expect(provider.starts[0]?.commandId).toMatch(/^debate-tool-[a-f0-9]{32}$/u)
    expect(provider.controls).toHaveLength(1)
    expect(provider.controls[0]).toMatchObject({
      runId: 'debate-run-1', expectedRevision: 2, action: 'approve',
    })
    expect(provider.controls[0]?.commandId).toMatch(/^debate-approval-[a-f0-9]{32}$/u)
    expect(agent.session.events.find(event => event.type === 'debate/admission')).toMatchObject({
      data: { runId: 'debate-run-1', mode: 'enabled' },
      ignorable: true,
    })

    const commandId = provider.starts[0]?.commandId
    await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.' }, 'same-call')
    expect(provider.starts[1]?.commandId).toBe(commandId)
  })

  it('projects ordinary Debate tool start, control, and inspect calls into deduplicated Session trace facts', async () => {
    const { ctx, agent, provider } = await setup()
    const completed = snapshot()
    provider.startResult = snapshot({ state: 'awaiting_approval', revision: 2, currentRound: 0, rounds: [] })
    provider.controlResult = completed
    provider.inspectFallback = completed
    provider.events.push(
      { version: 1, sequence: 1, runId: completed.runId, revision: 1, generation: 1, type: 'debate.planned', createdAt: completed.createdAt, data: {} },
      { version: 1, sequence: 2, runId: completed.runId, revision: 2, generation: 2, type: 'debate.agent.dispatched', createdAt: completed.updatedAt, round: 1, slotId: 'slot-proposer', data: {} },
      {
        version: 1,
        sequence: 3,
        runId: completed.runId,
        revision: 3,
        generation: 3,
        type: 'debate.agent.progress',
        createdAt: completed.updatedAt,
        round: 1,
        slotId: 'slot-proposer',
        data: {
          orchestrationRunId: 'must-not-copy',
          orchestrationSequence: 7,
          orchestrationTime: '2026-09-03T10:00:00.000Z',
          kind: 'tool-started',
          toolName: 'Read',
          routing: { version: 1, requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol' },
          prompt: 'must-not-copy',
          nativeSessionId: 'must-not-copy',
        },
      },
      { version: 1, sequence: 4, runId: completed.runId, revision: 4, generation: 4, type: 'debate.agent.settled', createdAt: completed.updatedAt, round: 1, slotId: 'slot-proposer', data: {} },
    )
    markKennel(agent)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })

    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('ordinary-start'), name: 'debate', arguments: '{}',
    })
    await call(ctx, agent, { action: 'start', prompt: 'Trace this ordinary Debate call.' }, 'ordinary-start')

    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('ordinary-control'), name: 'debate', arguments: '{}',
    })
    await call(ctx, agent, {
      action: 'control', run_id: completed.runId, expected_revision: completed.revision,
      control_action: 'resume', reason: 'fixture replay check',
    }, 'ordinary-control')

    agent.session.append('tool/call', {
      turn: 1, step: 1, callId: CallId('ordinary-inspect'), name: 'debate', arguments: '{}',
    })
    await call(ctx, agent, { action: 'inspect', run_id: completed.runId }, 'ordinary-inspect')

    const traces = agent.session.events.filter((event): event is Extract<typeof event, { type: 'debate/trace' }> => event.type === 'debate/trace')
    expect(traces.map(event => event.data.sourceSequence)).toEqual([1, 2, 3, 4])
    expect(traces[2]?.data).toMatchObject({
      state: 'progress',
      sessionTurn: 1,
      sessionStep: 1,
      role: { title: '建设性提案者', requested: { operatorId: 'codex', model: 'gpt-5.6-sol' } },
      progress: { kind: 'tool-started', toolName: 'Read', sourceTime: '2026-09-03T10:00:00.000Z' },
    })
    expect(new Set(traces.map(event => `${event.data.runId}:${String(event.data.sourceSequence)}`)).size).toBe(traces.length)
    expect(JSON.stringify(traces)).not.toContain('must-not-copy')
  })

  it('lists, inspects, and revision-fences controls with bounded projections', async () => {
    const { ctx, agent, provider } = await setup()
    provider.inspectFallback = snapshot({
      currentRound: 1,
      rounds: roundsWithStates(['running']),
    })
    const listed = resultValue(await call(ctx, agent, { action: 'list' }))
    expect((listed.runs as unknown[])).toHaveLength(20)
    expect(listed.truncated).toBe(true)
    expect(listed.runs).toEqual(expect.arrayContaining([expect.objectContaining({ currentRound: 0 })]))

    provider.inspectFallback = snapshot()
    const inspected = resultValue(await call(ctx, agent, { action: 'inspect', run_id: 'debate-run-1' }))
    expect(inspected).toMatchObject({
      kind: 'inspect',
      run: {
        runId: 'debate-run-1',
        rounds: [{
          turns: [{
            role: 'constructive-proposer',
            slotId: 'slot-proposer',
            outputRef: 'artifact:proposer-output',
            outputPreview: 'Proposal output summary',
          }],
        }],
        synthesis: { artifactRef: 'artifact:synthesis', outputPreview: 'Decision summary' },
      },
    })
    const inspectedRun = inspected.run as Record<string, unknown>
    expect(inspectedRun.roster).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'constructive-proposer',
      title: 'Constructive Proposer',
      mandate: 'Build the strongest practical answer to the user objective.',
      operatorId: 'codex',
      model: 'gpt-5.6-sol',
    })]))
    expect(JSON.stringify(inspected)).not.toContain('stance')
    expect(JSON.stringify(inspected)).not.toContain('instructions')

    const controlled = resultValue(await call(ctx, agent, {
      action: 'control',
      run_id: 'debate-run-1',
      expected_revision: 4,
      control_action: 'pause',
      reason: 'Review the evidence.',
    }))
    expect(controlled).toMatchObject({ kind: 'control', run: { runId: 'debate-run-1' } })
    expect(provider.controls[0]).toMatchObject({
      runId: 'debate-run-1', expectedRevision: 4, action: 'pause', reason: 'Review the evidence.',
    })
  })

  it('reports only persisted completed rounds in model-visible run projections', async () => {
    const { ctx, agent, provider } = await setup()
    provider.inspectFallback = snapshot({
      currentRound: 6,
      rounds: roundsWithStates(['completed', 'planned', 'running', 'reviewing', 'failed', 'indeterminate']),
    })

    const inspected = resultValue(await call(ctx, agent, { action: 'inspect', run_id: 'debate-run-1' }))

    expect(inspected).toMatchObject({ kind: 'inspect', run: { currentRound: 1 } })
  })

  it('projects bounded requested and actual routing with blockers', async () => {
    const { ctx, agent, provider } = await setup()
    const template = snapshot()
    const round = template.rounds[0]
    if (round === undefined) throw new Error('missing Debate fixture round')
    provider.inspectFallback = snapshot({
      rounds: [{
        ...round,
        turns: [{
          version: 1,
          round: 1,
          slotId: 'skeptical-falsifier',
          role: 'skeptical-falsifier',
          operatorId: 'codex',
          model: 'gpt-5.6-sol',
          state: 'blocked',
          attempt: 2,
          routing: {
            version: 1,
            requestedOperatorId: 'claude-code',
            requestedModel: 'claude-fable-5',
            actualOperatorId: 'codex',
            actualModel: 'gpt-5.6-sol',
            fallbackReasonCode: 'provider-unavailable',
            allocationPlanRef: 'artifact:allocation-falsifier',
          },
          blockers: [{
            code: 'DEPENDENCY_FAILED',
            message: 'x'.repeat(800),
            nodeId: 'debate-r1-skeptical-falsifier',
          }],
          claimIds: [],
          evidenceRefs: [],
        }],
      }],
    })

    const inspected = resultValue(await call(ctx, agent, { action: 'inspect', run_id: 'debate-run-1' }))
    expect(inspected).toMatchObject({
      run: {
        rounds: [{
          turns: [{
            role: 'skeptical-falsifier',
            operatorId: 'codex',
            model: 'gpt-5.6-sol',
            state: 'blocked',
            attempt: 2,
            routing: {
              requestedOperatorId: 'claude-code',
              requestedModel: 'claude-fable-5',
              actualOperatorId: 'codex',
              actualModel: 'gpt-5.6-sol',
              fallbackReasonCode: 'provider-unavailable',
              allocationPlanRef: 'artifact:allocation-falsifier',
            },
            blockers: [{
              code: 'DEPENDENCY_FAILED',
              nodeId: 'debate-r1-skeptical-falsifier',
            }],
          }],
        }],
      },
    })
    const inspectedRun = inspected.run as {
      roster: unknown[]
      rounds: Array<{ turns: Array<{ blockers: Array<{ message: string }> }> }>
    }
    expect(inspectedRun.roster).toEqual(expect.arrayContaining([expect.objectContaining({
      role: 'skeptical-falsifier',
      fallbackOperatorIds: ['codex'],
    })]))
    const turn = inspectedRun.rounds[0]?.turns[0]
    expect(turn?.blockers[0]?.message).toHaveLength(600)
    expect(turn?.blockers[0]?.message.endsWith('…')).toBe(true)
  })
})
