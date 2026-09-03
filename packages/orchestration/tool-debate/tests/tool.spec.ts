import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CommandRuntime from '@deepseek-ai/dsh-commands'
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
import LlmRuntime, { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
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

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function textDeltas(agent: Agent): string[] {
  return agent.session.events
    .filter((event): event is Extract<typeof event, { type: 'assistant/chunk' }> => event.type === 'assistant/chunk')
    .map(event => event.data.chunk)
    .filter((chunk): chunk is Extract<typeof chunk, { type: 'text-delta' }> => chunk.type === 'text-delta')
    .map(chunk => chunk.text)
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Debate stream progress')
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptedDebates)
  await ctx.plugin(tool)
  const session = ctx.sessions.create(SessionId('session-debate'), { meta: { cwd: '/workspace' } })
  const agent = { id: session.id, session } as Agent
  return { ctx, agent, provider: ctx.debates as ScriptedDebates }
}

async function setupAutomatic(
  route: { readonly provider: string; readonly model: string } = {
    provider: 'unavailable-primary',
    model: 'unavailable-primary',
  },
) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ScriptedDebates)
  const toolFiber = ctx.plugin(tool)
  await toolFiber.await()
  const agent = ctx.agentLoop.create(
    SessionId('session-debate-automatic'),
    route,
    { cwd: '/workspace' },
  )
  return { ctx, agent, provider: ctx.debates as ScriptedDebates, toolFiber }
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
  it('uses a one-round three-role budget when the user explicitly asks for a concise result', () => {
    const policy = tool.debatePolicyForPrompt('请简洁讨论并给出三条结论')
    expect(policy.roster.map(role => role.role)).toEqual([
      'constructive-proposer',
      'skeptical-falsifier',
      'decision-judge',
    ])
    expect(policy.budget).toMatchObject({
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxAgentsPerRound: 3,
      maxTotalTokens: 80_000,
      maxCostUsd: 2,
    })
    expect(policy.convergence.minSettledAgents).toBe(3)
    expect(policy.roster.map(role => [role.role, role.fallbackOperatorIds])).toEqual([
      ['constructive-proposer', undefined],
      ['skeptical-falsifier', ['codex']],
      ['decision-judge', ['codex']],
    ])
    expect(tool.debatePolicyForPrompt('Evaluate this contested architecture.')).toMatchObject({
      budget: { maxRounds: 3 },
      roster: { length: 4 },
    })
  })

  it('lets an explicitly enabled Debate own the user turn without calling a primary model', async () => {
    const { ctx, agent, provider } = await setupAutomatic()
    provider.startResult = snapshot({ state: 'awaiting_approval', revision: 2, currentRound: 0, rounds: [] })
    provider.controlResult = snapshot({ revision: 3 })
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Should DSH adopt this architecture?' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(provider.starts, JSON.stringify(agent.session.events, null, 2)).toHaveLength(1)
    expect(provider.starts[0]).toMatchObject({
      prompt: 'Should DSH adopt this architecture?',
      objective: 'Should DSH adopt this architecture?',
      workspace: '/workspace',
      sourceSessionId: 'session-debate-automatic',
      execution: { version: 1, kind: 'standalone' },
      policy: { mode: 'enabled' },
    })
    const dispatch = agent.session.events.find(event => event.type === 'debate/dispatch')
    if (dispatch?.type !== 'debate/dispatch') throw new Error('missing debate dispatch')
    expect(provider.starts[0]?.commandId).toBe(
      `debate-host:session-debate-automatic:${dispatch.data.promptMessageId}`,
    )
    expect(provider.controls).toHaveLength(1)
    expect(provider.controls[0]).toMatchObject({
      runId: 'debate-run-1',
      expectedRevision: 2,
      action: 'approve',
      reason: 'The user explicitly selected Debate for this Session and submitted this request.',
    })
    expect(provider.controls[0]?.commandId).toMatch(/^debate-approval-[a-f0-9]{32}$/u)
    expect(dispatch.ignorable).toBe(true)
    expect(typeof dispatch.data.promptMessageId).toBe('string')
    expect(dispatch.data.turn).toBe(1)
    expect(dispatch.data.step).toBe(1)
    expect(agent.session.events.find(event => event.type === 'debate/admission')).toMatchObject({
      ignorable: true,
      data: { runId: 'debate-run-1', state: 'completed' },
    })
    const assistant = [...agent.session.events].reverse().find(event => event.type === 'assistant/message')
    if (assistant?.type !== 'assistant/message') throw new Error('missing assistant response')
    const response = assistant.data.message.content[0]
    expect(response?.type).toBe('text')
    expect(response?.type === 'text' ? response.text : '').toContain('Decision summary')
  })

  it('durably admits a turn when a legacy Session selected the internal Debate route as its primary model', async () => {
    const { ctx, agent, provider } = await setupAutomatic({
      provider: 'dsh-debate-host',
      model: 'debate',
    })

    const message = createUserMessage({
      content: [{ type: 'text', text: 'Debate this decision.' }],
      source: { kind: 'user' },
    })
    agent.followup(message)
    await agent.whenIdle()

    expect(provider.starts).toHaveLength(1)
    expect(provider.starts[0]?.commandId).toBe(
      `debate-host:session-debate-automatic:${message.id}`,
    )
    expect(agent.session.events.find(event => event.type === 'debate/dispatch')).toMatchObject({
      ignorable: true,
      data: {
        commandId: `debate-host:session-debate-automatic:${message.id}`,
        promptMessageId: message.id,
        turn: 1,
        step: 1,
      },
    })
    expect(agent.session.events.find(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'completed' } },
    })
    await expect(ctx.llm.listModels('dsh-debate-host')).resolves.toEqual([])
  })

  it('streams durable roster, agent output previews, convergence, and the final host summary', async () => {
    const { ctx, agent, provider } = await setupAutomatic()
    const template = snapshot()
    const round = template.rounds[0]
    if (round === undefined) throw new Error('missing Debate fixture round')
    const turn = round.turns[0]
    if (turn === undefined) throw new Error('missing Debate fixture turn')
    const { convergence: _convergence, ...roundWithoutConvergence } = round
    const { outputRef: _outputRef, outputPreview: _outputPreview, ...turnWithoutOutput } = turn
    const secondTurn = {
      ...turn,
      round: 2,
      slotId: 'slot-falsifier',
      role: 'skeptical-falsifier' as const,
      operatorId: 'codex',
      model: 'gpt-5.6-sol',
      attempt: 1,
      routing: {
        version: 1 as const,
        requestedOperatorId: 'claude-code',
        requestedModel: 'claude-fable-5',
        actualOperatorId: 'codex',
        actualModel: 'gpt-5.6-sol',
        fallbackReasonCode: 'provider-unavailable',
        allocationPlanRef: 'artifact:allocation-falsifier',
      },
      outputRef: 'artifact:falsifier-output',
      outputPreview: 'Falsifier output summary',
    }
    const running = snapshot({
      state: 'round_running',
      revision: 5,
      currentRound: 1,
      rounds: [{
        ...roundWithoutConvergence,
        state: 'running',
        turns: [{
          ...turnWithoutOutput,
          state: 'planned',
        }],
      }],
    })
    const dispatched = snapshot({
      state: 'round_running',
      revision: 6,
      currentRound: 1,
      rounds: [{
        ...roundWithoutConvergence,
        state: 'running',
        turns: [{
          ...turnWithoutOutput,
          state: 'dispatched',
        }],
      }],
    })
    const firstCompleted = snapshot({
      state: 'reviewing',
      revision: 7,
      currentRound: 1,
      rounds: [{ ...round, state: 'completed', turns: [turn] }],
    })
    const secondRound = snapshot({
      state: 'reviewing',
      revision: 8,
      currentRound: 2,
      rounds: [
        { ...round, state: 'completed', turns: [turn] },
        { ...roundWithoutConvergence, round: 2, state: 'completed', turns: [secondTurn] },
      ],
    })
    const completed = snapshot({
      revision: 10,
      state: 'completed',
      currentRound: 2,
      rounds: [
        { ...round, state: 'completed', turns: [turn] },
        { ...round, round: 2, state: 'completed', turns: [secondTurn] },
      ],
      synthesis: {
        ...template.synthesis!,
        artifactRef: 'artifact:judge-output',
        outputPreview: 'Final host decision summary',
      },
    })
    provider.startResult = snapshot({ state: 'awaiting_approval', revision: 2, currentRound: 0, rounds: [] })
    const approval = deferred<DebateRunSnapshotV1>()
    provider.controlGate = approval.promise
    provider.inspectFallback = firstCompleted
    provider.inspectSnapshots.push(running, dispatched, firstCompleted)
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Should DSH adopt this architecture?' }],
      source: { kind: 'user' },
    }))
    const idle = agent.whenIdle()
    await waitFor(() => textDeltas(agent).some(text => text.includes('# 主题帖')))
    expect(agent.session.events.some(event => event.type === 'assistant/message')).toBe(false)

    await waitFor(() => {
      const text = textDeltas(agent).join('')
      return text.includes('公开发言')
        && text.includes('Proposal output summary')
    })
    provider.inspectFallback = secondRound
    await waitFor(() => {
      const text = textDeltas(agent).join('')
      return text.includes('第 2 轮')
        && text.includes('Falsifier output summary')
    })
    provider.inspectFallback = completed
    approval.resolve(completed)
    await idle

    const streamText = textDeltas(agent).join('')
    expect(streamText).toContain('建设性提案者')
    expect(streamText).toContain('主题帖状态更新')
    expect(streamText.indexOf('# 主题帖')).toBeLessThan(streamText.indexOf('第 1 轮'))
    expect(streamText.indexOf('Proposal output summary')).toBeLessThan(streamText.indexOf('第 2 轮'))
    expect(streamText.indexOf('第 2 轮')).toBeLessThan(streamText.indexOf('Falsifier output summary'))
    expect(streamText.indexOf('本轮收敛判断')).toBeLessThan(streamText.lastIndexOf('本轮收敛判断'))
    expect(streamText.indexOf('本轮收敛判断')).toBeLessThan(streamText.indexOf('Final host decision summary'))
    expect(streamText).toContain('### 2 楼 · 怀疑式证伪者')
    expect(streamText.match(/### 1 楼/g)).toHaveLength(1)
    expect(streamText.match(/Proposal output summary/g)).toHaveLength(1)
    expect(streamText.match(/Final host decision summary/g)).toHaveLength(1)
    expect(streamText).toContain('**执行者：** Codex · GPT-5.6 Sol（已从 Claude Code · Claude Fable 5 自动回退）')
    expect(streamText).toContain('## 置顶 · 主持人总结')
    expect(streamText).toContain('Final host decision summary')
    expect(streamText).toContain('| 角色 | 职责 | 执行算子 | 模型 | 当前状态 |')
    expect(streamText).not.toContain('<details>')
    expect(streamText).not.toContain('<summary>')
    expect(streamText).not.toContain('角色 ID')
    expect(streamText).not.toContain('Slot：')
    expect(streamText).not.toContain('sha256:')
    expect(streamText).not.toContain('reasoning')

    const chunks = agent.session.events
      .filter((event): event is Extract<typeof event, { type: 'assistant/chunk' }> => event.type === 'assistant/chunk')
      .map(event => event.data.chunk)
    const blockEnd = chunks.find(chunk => chunk.type === 'block-end')
    if (blockEnd?.type !== 'block-end' || blockEnd.block.type !== 'text') {
      throw new Error('missing Debate text block-end')
    }
    expect(blockEnd.block.text).toBe(streamText)
  })

  it('renders the current user topic and structured public posts without internal identifiers', async () => {
    const { ctx, agent, provider } = await setupAutomatic()
    const template = snapshot()
    const round = template.rounds[0]
    const turn = round?.turns[0]
    if (round === undefined || turn === undefined) throw new Error('missing Debate fixture turn')
    const claim = {
      version: 1 as const,
      claimId: 'claim-verify',
      statement: 'P0：未通过证据校验的节点不得进入完成状态。',
      status: 'supported' as const,
      severity: 'high' as const,
      confidence: 0.9,
      supportingSlotIds: [turn.slotId],
      opposingSlotIds: [],
      evidenceRefs: [],
    }
    const ledger = { ...template.claimLedger, claims: [claim] }
    const { objective: _objective, ...templateWithoutObjective } = template
    const budgetLimited: DebateRunSnapshotV1 = {
      ...templateWithoutObjective,
      state: 'budget_limited',
      rounds: [{
        ...round,
        claimLedger: ledger,
        turns: [{
          ...turn,
          outputPreview: '立场：先补可靠性。 P0：证据校验必须阻断未验证完成。 P1：使用租约隔离并发写入。 P2：再扩展新的执行入口。',
          claimIds: [claim.claimId],
        }],
        convergence: { ...round.convergence!, status: 'budget_limited' as const },
      }],
      claimLedger: ledger,
      synthesis: {
        ...template.synthesis!,
        outputPreview: '结论：先补可靠性。 P0：完成证据门禁。 P1：验证恢复。',
      },
    }
    provider.startResult = budgetLimited
    provider.controlResult = budgetLimited
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '本轮真正的用户议题是什么？' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const streamText = textDeltas(agent).join('')
    expect(streamText).toContain('## 本轮真正的用户议题是什么？')
    expect(streamText).toContain('| 角色 | 职责 | 执行算子 | 模型 | 当前状态 |')
    expect(streamText).toContain('**立场**：先补可靠性。')
    expect(streamText).toContain('**P0**：证据校验必须阻断未验证完成。')
    expect(streamText).toContain('**P1**：使用租约隔离并发写入。')
    expect(streamText).toContain('**P2**：再扩展新的执行入口。')
    expect(streamText).toContain('**本楼主张：**')
    expect(streamText).toContain('1. P0：未通过证据校验的节点不得进入完成状态。')
    expect(streamText).toContain('预算已达上限，主持人总结已完成')
    expect(streamText).not.toContain('预算停止')
    expect(streamText).not.toContain('<details>')
    expect(streamText).not.toContain('<summary>')
    expect(streamText).not.toContain('constructive-proposer')
    expect(streamText).not.toContain('slot-proposer')
    expect(streamText).not.toContain('sha256:')
  })

  it('projects every durable public Debate event into separately replayable Session trace facts', async () => {
    const { ctx, agent, provider } = await setupAutomatic()
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
    provider.startResult = traced
    provider.controlResult = traced
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
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Trace every Debate participant.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

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
    expect(agent.session.events.filter(event => event.type === 'assistant/message')).toHaveLength(1)
    expect(JSON.stringify(traces)).not.toContain('slot-proposer')
  })

  it('streams the durable blocker when a roster slot was never dispatched', async () => {
    const { ctx, agent, provider } = await setupAutomatic()
    const template = snapshot()
    const round = template.rounds[0]
    if (round === undefined) throw new Error('missing Debate fixture round')
    const { synthesis: _synthesis, ...withoutSynthesis } = template
    const { convergence: _convergence, ...withoutConvergence } = round
    provider.startResult = {
      ...withoutSynthesis,
      state: 'failed',
      rounds: [{
        ...withoutConvergence,
        state: 'failed',
        turns: [{
          version: 1,
          round: 1,
          slotId: 'decision-judge',
          role: 'decision-judge',
          operatorId: 'claude-code',
          model: 'claude-opus-5',
          state: 'blocked',
          attempt: 0,
          routing: {
            version: 1,
            requestedOperatorId: 'claude-code',
            requestedModel: 'claude-opus-5',
          },
          blockers: [{
            code: 'DEPENDENCY_FAILED',
            message: 'participant execution did not complete',
            nodeId: 'debate-r1-decision-judge',
          }, {
            code: 'DEPENDENCY_FAILED',
            message: 'evidence audit execution did not complete',
            nodeId: 'debate-r1-evidence-auditor',
          }, {
            code: 'DEPENDENCY_FAILED',
            message: 'participant execution did not complete',
            nodeId: 'debate-r1-decision-judge',
          }],
          claimIds: [],
          evidenceRefs: [],
        }],
      }],
    }
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Debate this blocked decision.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const streamText = textDeltas(agent).join('')
    expect(streamText).not.toContain('楼 · 决策裁判（主持人）')
    expect(streamText).toContain('主持人状态')
    expect(streamText).toContain('已阻断：participant execution did not complete')
    expect(streamText).toContain('evidence audit execution did not complete')
    expect(streamText.match(/participant execution did not complete/g)).toHaveLength(1)
  })

  it('renders terminal participant turns from a stopped active round with contiguous floors', async () => {
    const { ctx, agent, provider } = await setupAutomatic()
    const template = snapshot()
    const round = template.rounds[0]
    const proposer = round?.turns[0]
    if (round === undefined || proposer === undefined) throw new Error('missing Debate fixture turn')
    const { synthesis: _synthesis, ...withoutSynthesis } = template
    const { convergence: _convergence, ...withoutConvergence } = round
    const { outputRef: _outputRef, outputPreview: _outputPreview, ...proposerWithoutOutput } = proposer
    const proposerBlocker = { code: 'DEBATE_INTERRUPTED', message: 'active stop', nodeId: 'node-stop' }
    const proposerTurn = {
      ...proposerWithoutOutput,
      state: 'failed' as const,
      attempt: 1,
      errorCode: 'DEBATE_INTERRUPTED',
      blockers: [proposerBlocker, proposerBlocker, { ...proposerBlocker, message: 'second active failure', nodeId: 'node-second' }],
    }
    const falsifierTurn = {
      ...proposer,
      slotId: 'slot-falsifier',
      role: 'skeptical-falsifier' as const,
      model: 'claude-fable-5',
      state: 'settled' as const,
      outputRef: 'artifact:falsifier-stop',
      outputPreview: 'Falsifier output after stop.',
    }
    const judgeTurn = {
      ...proposerWithoutOutput,
      slotId: 'slot-judge',
      role: 'decision-judge' as const,
      state: 'failed' as const,
      errorCode: 'DEBATE_INTERRUPTED',
      blockers: [{ code: 'DEBATE_INTERRUPTED', message: 'judge interrupted', nodeId: 'node-judge' }],
    }
    provider.startResult = {
      ...withoutSynthesis,
      state: 'stopped',
      currentRound: 1,
      rounds: [{
        ...withoutConvergence,
        state: 'running',
        turns: [proposerTurn, falsifierTurn, judgeTurn],
      }],
    }
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Stop this active Debate.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    const streamText = textDeltas(agent).join('')
    expect(streamText).toContain('### 1 楼 · 建设性提案者')
    expect(streamText).toContain('### 2 楼 · 怀疑式证伪者')
    expect(streamText).not.toContain('### 3 楼')
    expect(streamText).not.toContain('楼 · 决策裁判（主持人）')
    expect(streamText.match(/未完成：active stop/g)).toHaveLength(1)
    expect(streamText.match(/未完成：second active failure/g)).toHaveLength(1)
    expect(streamText).not.toContain('未完成：DEBATE_INTERRUPTED')
    expect(streamText).toContain('主持人状态')
  })

  it('uses configured personas and renders each terminal lifecycle deterministically without a judge floor', async () => {
    const states = ['completed', 'budget_limited', 'max_rounds', 'stopped', 'failed', 'indeterminate'] as const
    for (const state of states) {
      const execute = async (): Promise<string> => {
        const { ctx, agent, provider } = await setupAutomatic()
        const template = snapshot()
        provider.startResult = {
          ...template,
          state,
          roster: template.roster.map(role => role.role === 'constructive-proposer'
            ? { ...role, persona: { ...role.persona, title: 'Fixture Architect', mandate: 'Audit exactly the configured fixture boundary.' } }
            : role),
        }
        await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: `Replay ${state} Debate state.` }],
          source: { kind: 'user' },
        }))
        await agent.whenIdle()
        return textDeltas(agent).join('')
      }
      const first = await execute()
      const replay = await execute()
      expect(first).toBe(replay)
      expect(first).toContain('Fixture Architect')
      expect(first).toContain('Audit exactly the configured fixture boundary.')
      expect(first).not.toContain('楼 · 决策裁判（主持人）')
      expect(first.match(/置顶 · 主持人总结/g)).toHaveLength(1)
    }
  })

  it('re-registers after HMR without duplicating durable dispatch, floors, or moderator output', async () => {
    const { ctx, agent, provider, toolFiber } = await setupAutomatic()
    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Debate before HMR.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    expect(provider.starts).toHaveLength(1)

    await toolFiber.dispose()
    const reloadedToolFiber = ctx.plugin(tool)
    await reloadedToolFiber.await()

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Debate after HMR.' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(provider.starts).toHaveLength(2)
    expect(provider.starts[1]).toMatchObject({
      prompt: 'Debate after HMR.',
      objective: 'Debate after HMR.',
    })
    expect(new Set(provider.starts.map(start => start.commandId))).toHaveLength(2)
    const latestAssistant = [...agent.session.events].reverse()
      .find(event => event.type === 'assistant/message')
    if (latestAssistant?.type !== 'assistant/message') throw new Error('missing assistant response after HMR')
    const content = latestAssistant.data.message.content[0]
    if (content?.type !== 'text') throw new Error('missing Debate text response after HMR')
    expect(content.text.match(/### 1 楼/g)).toHaveLength(1)
    expect(content.text.match(/Proposal output summary/g)).toHaveLength(1)
    expect(content.text.match(/置顶 · 主持人总结/g)).toHaveLength(1)
    expect(content.text.match(/Decision summary/g)).toHaveLength(1)
  })

  it('keeps legacy Sessions disabled and persists an ignorable whole-value mode', async () => {
    const { ctx, agent } = await setup()
    expect(tool.foldDebatePreferences([])).toEqual({ mode: 'disabled' })
    expect(tool.foldDebatePreferences([{ type: 'debate/preferences', data: { mode: 'future-mode' } }]))
      .toEqual({ mode: 'disabled' })
    expect(ctx.sessionProjections.snapshot(agent.session).values.debateExecutionPreferences).toEqual({
      mode: 'disabled',
      options: ['auto', 'enabled', 'disabled'],
    })

    const changed = await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    expect(changed?.result).toEqual({ kind: 'success', text: 'debate mode enabled' })
    expect(agent.session.events.find(event => event.type === 'debate/preferences')).toMatchObject({
      data: { mode: 'enabled' },
      ignorable: true,
    })
    expect(ctx.sessionProjections.snapshot(agent.session).values.debateExecutionPreferences?.mode).toBe('enabled')

    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    expect(agent.session.events.filter(event => event.type === 'debate/preferences')).toHaveLength(1)
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

  it('fails closed while disabled, then starts with stable identity, workspace, and Session lineage', async () => {
    const { ctx, agent, provider } = await setup()
    const disabled = await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.' }, 'same-call')
    expect(disabled.isError).toBe(true)
    expect(disabled.content.some(block => block.type === 'text'
      && block.text.includes('Debate is disabled'))).toBe(true)

    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    provider.startResult = snapshot({ state: 'awaiting_approval', revision: 2, currentRound: 0, rounds: [] })
    provider.controlResult = snapshot({ revision: 3 })
    const started = await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.', objective: 'Choose safely.' }, 'same-call')
    expect(resultValue(started)).toMatchObject({ kind: 'start', run: { runId: 'debate-run-1', state: 'completed' } })
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

  it('lists, inspects, and revision-fences controls with bounded projections', async () => {
    const { ctx, agent, provider } = await setup()
    const listed = resultValue(await call(ctx, agent, { action: 'list' }))
    expect((listed.runs as unknown[])).toHaveLength(20)
    expect(listed.truncated).toBe(true)

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
