import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopDebateRound, DesktopDebateRun } from '../src/contracts.ts'
import { controlDebate, EvidenceColumn, loadDebateDashboard, RunDetail, selectedDashboardRun } from '../src/client/DebatePanel.tsx'

afterEach(() => { vi.unstubAllGlobals() })

type DebateTurn = DesktopDebateRound['turnStates'][number]

function turn(
  round: number,
  slotId: DebateTurn['slotId'],
  role: DebateTurn['role'],
  operatorId: string,
  model: string,
  outputRef: string,
  outputPreview: string,
  claimIds: string[],
  evidenceRefs: string[],
  usage: NonNullable<DebateTurn['usage']>,
  startedAt: string,
  settledAt: string,
): DebateTurn {
  return { round, slotId, role, operatorId, model, state: 'settled', outputRef, outputPreview, claimIds, evidenceRefs, usage, startedAt, settledAt }
}

function run(): DesktopDebateRun {
  return {
    version: 1,
    runId: 'debate-1',
    state: 'awaiting_approval',
    mode: 'enabled',
    currentRound: 2,
    revision: 7,
    unresolvedCount: 1,
    updatedAt: '2026-08-29T01:01:00.000Z',
    createdAt: '2026-08-29T01:00:00.000Z',
    objective: 'Choose A or B.',
    topic: { version: 1, title: 'User-selected topic: choose A or B.', source: 'user' },
    sourceSessionId: 'session-1',
    roles: [{
      role: 'constructive-proposer', kind: 'participant', title: '建设性提案者', mandate: '提出可执行方案与成功标准。', operatorId: 'codex', model: 'gpt-5.6-sol', tier: 'high', source: 'native-subscription', required: true,
      latestTurn: { round: 2, state: 'settled', outputRef: 'artifact:r2-proposer', outputPreview: 'Round two proposal: retain A with a gate.', claimIds: ['claim-1'], evidenceRefs: ['artifact:evidence'], usage: { inputTokens: 1_100, outputTokens: 450 }, startedAt: '2026-08-29T01:01:01.000Z', settledAt: '2026-08-29T01:01:11.000Z' },
    }, {
      role: 'skeptical-falsifier', kind: 'participant', title: '怀疑式证伪者', mandate: '寻找反例、风险和失败条件。', operatorId: 'claude-code', model: 'claude-fable-5', tier: 'medium', source: 'native-subscription', required: true,
      latestTurn: { round: 2, state: 'settled', outputRef: 'artifact:r2-falsifier', outputPreview: 'Round two challenge: keep the cost dissent.', claimIds: ['claim-1'], evidenceRefs: ['artifact:evidence'], usage: { inputTokens: 950, outputTokens: 380 }, startedAt: '2026-08-29T01:01:02.000Z', settledAt: '2026-08-29T01:01:12.000Z' },
    }, {
      role: 'decision-judge', kind: 'judge', title: '决策裁判（主持人）', mandate: '综合证据、裁定分歧并给出决策。', operatorId: 'claude-code', model: 'claude-opus-5', tier: 'high', source: 'native-subscription', required: true,
      latestTurn: { round: 2, state: 'settled', outputRef: 'artifact:r2-judge', outputPreview: 'Round two ruling: choose A and record dissent.', claimIds: ['claim-1'], evidenceRefs: ['artifact:evidence'], usage: { inputTokens: 850, outputTokens: 320 }, startedAt: '2026-08-29T01:01:03.000Z', settledAt: '2026-08-29T01:01:13.000Z' },
    }],
    rounds: [{
      round: 1,
      state: 'completed',
      turnStates: [
        turn(1, 'constructive-proposer', 'constructive-proposer', 'codex', 'gpt-5.6-sol', 'artifact:r1-proposer', 'Round one proposal: choose A.', ['claim-1'], ['artifact:evidence'], { inputTokens: 1_000, outputTokens: 400 }, '2026-08-29T01:00:01.000Z', '2026-08-29T01:00:11.000Z'),
        turn(1, 'skeptical-falsifier', 'skeptical-falsifier', 'claude-code', 'claude-fable-5', 'artifact:r1-falsifier', 'Round one challenge: verify rollback.', ['claim-1'], ['artifact:evidence'], { inputTokens: 900, outputTokens: 350 }, '2026-08-29T01:00:02.000Z', '2026-08-29T01:00:12.000Z'),
        turn(1, 'decision-judge', 'decision-judge', 'claude-code', 'claude-opus-5', 'artifact:r1-judge', 'Round one ruling: continue review.', ['claim-1'], ['artifact:evidence'], { inputTokens: 800, outputTokens: 300 }, '2026-08-29T01:00:03.000Z', '2026-08-29T01:00:13.000Z'),
      ],
      convergence: { status: 'continue', score: 0.6, threshold: 0.8, disagreement: 0.4, coverage: 0.6, unresolvedHighSeverity: 0, settledAgents: 3, reason: 'continue review' },
    }, {
      round: 2,
      state: 'completed',
      turnStates: [
        turn(2, 'constructive-proposer', 'constructive-proposer', 'codex', 'gpt-5.6-sol', 'artifact:r2-proposer', 'Round two proposal: retain A with a gate.', ['claim-1'], ['artifact:evidence'], { inputTokens: 1_100, outputTokens: 450 }, '2026-08-29T01:01:01.000Z', '2026-08-29T01:01:11.000Z'),
        turn(2, 'skeptical-falsifier', 'skeptical-falsifier', 'claude-code', 'claude-fable-5', 'artifact:r2-falsifier', 'Round two challenge: keep the cost dissent.', ['claim-1'], ['artifact:evidence'], { inputTokens: 950, outputTokens: 380 }, '2026-08-29T01:01:02.000Z', '2026-08-29T01:01:12.000Z'),
        turn(2, 'decision-judge', 'decision-judge', 'claude-code', 'claude-opus-5', 'artifact:r2-judge', 'Round two ruling: choose A and record dissent.', ['claim-1'], ['artifact:evidence'], { inputTokens: 850, outputTokens: 320 }, '2026-08-29T01:01:03.000Z', '2026-08-29T01:01:13.000Z'),
      ],
      convergence: { status: 'converged', score: 0.9, threshold: 0.8, disagreement: 0.1, coverage: 0.8, unresolvedHighSeverity: 0, settledAgents: 3, reason: 'supported' },
    }],
    claims: [{ claimId: 'claim-1', statement: 'Option A is safer.', status: 'supported', severity: 'high', confidence: 0.9, supportingSlotIds: ['constructive-proposer'], opposingSlotIds: [], evidenceRefs: ['artifact:evidence'], rationale: 'Rollback exists.' }],
    claimCoverage: 0.8,
    dissent: [{ slotId: 'skeptical-falsifier', claimId: 'claim-1', position: 'B may be safer.', reason: 'Benchmark missing.', confidence: 0.4, evidenceRefs: [] }],
    unresolved: [{ claimId: 'claim-2', description: 'Cost unknown.', severity: 'medium', blocking: false, reason: 'No benchmark.', requiredEvidenceRefs: [] }],
    evidence: { refs: ['artifact:evidence'], coverage: 0.8, missingRefs: ['benchmark'], lineage: ['artifact:evidence'] },
    cost: { version: 1, usageStatus: 'partial', costStatus: 'unknown', inputTokens: 1_000, outputTokens: 400, cacheReadInputTokens: 200, unknownUsageTurns: 1, unknownCostTurns: 1, bySlot: [] },
    synthesis: { state: 'settled', artifactRef: 'artifact:synthesis', outputPreview: 'Choose A.', unresolvedClaimIds: ['claim-2'], dissentCount: 1 },
  }
}

describe('Debate Desktop panel transport', () => {
  it('loads list or selected run from the same-origin endpoint', async () => {
    const dashboard = { version: 1, generatedAt: '2026-08-29T00:00:00.000Z', runs: [], selectedRunId: 'debate-1' }
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
      JSON.stringify(dashboard),
      { status: 200 },
    ))
    vi.stubGlobal('window', { location: { origin: 'http://127.0.0.1:3080' } })
    await expect(loadDebateDashboard('debate-1', undefined, request)).resolves.toEqual(dashboard)
    const url = request.mock.calls[0]?.[0]
    expect(url).toBeInstanceOf(URL)
    if (!(url instanceof URL)) throw new Error('Debate request must use URL')
    expect(url.href).toBe('http://127.0.0.1:3080/api/debates?run_id=debate-1')
  })

  it('sends an exact revision-fenced control through the trusted header', async () => {
    const intent = { version: 1 as const, commandId: 'pause-1', runId: 'debate-1', expectedRevision: 7, action: 'pause' as const, reason: 'review' }
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(run()), { status: 200 }))
    await expect(controlDebate(intent, request)).resolves.toMatchObject({ runId: 'debate-1' })
    expect(request.mock.calls[0]?.[0]).toBe('/api/debates')
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Debate-Control': '1' },
      body: JSON.stringify(intent),
    })
  })

  it('does not render a stale inspected Run while the user has selected the newest Run', () => {
    const stale = run()
    const newest = {
      ...stale,
      runId: 'debate-newest',
      objective: 'Stale objective.',
      topic: { version: 1 as const, title: 'Newest user topic.', source: 'user' as const },
    }
    const dashboard = {
      version: 1 as const,
      generatedAt: stale.updatedAt,
      runs: [{ ...newest }],
      selectedRunId: stale.runId,
      selectedRun: stale,
    }
    expect(selectedDashboardRun(dashboard, newest.runId)).toBeUndefined()
    expect(selectedDashboardRun({ ...dashboard, selectedRunId: newest.runId, selectedRun: newest }, newest.runId)?.topic?.title).toBe('Newest user topic.')
  })

  it('renders roles, rounds, claims, dissent, unresolved, accounting, and synthesis ref', () => {
    const fixture = run()
    const events = [
      { version: 1 as const, sequence: 1, runId: fixture.runId, revision: 1, generation: 1, type: 'debate.planned', createdAt: '2026-08-29T01:00:00.000Z', data: { mode: 'enabled', rosterSize: 3 } },
      { version: 1 as const, sequence: 2, runId: fixture.runId, revision: 2, generation: 2, round: 1, type: 'debate.round.started', createdAt: '2026-08-29T01:00:01.000Z', data: { phase: 'blind-independent', slotIds: ['constructive-proposer', 'skeptical-falsifier', 'decision-judge'] } },
      { version: 1 as const, sequence: 3, runId: fixture.runId, revision: 3, generation: 3, round: 1, slotId: 'constructive-proposer', type: 'debate.agent.settled', createdAt: '2026-08-29T01:00:11.000Z', data: { role: 'constructive-proposer', claimCount: 1, evidenceCount: 1, confidence: 0.8 } },
      { version: 1 as const, sequence: 4, runId: fixture.runId, revision: 4, generation: 4, round: 2, type: 'debate.synthesis.settled', createdAt: '2026-08-29T01:01:13.000Z', data: { unresolvedClaimIds: ['claim-2'], dissentCount: 1 } },
    ]
    const markup = renderToStaticMarkup(createElement('div', null,
      createElement(RunDetail, { run: fixture, events, pending: false, onControl: async () => {} }),
      createElement(EvidenceColumn, { run: fixture }),
    ))
    for (const expected of [
      'User-selected topic: choose A or B.', '参与 Agent 与角色职责', '参与者名册', '建设性提案者', '怀疑式证伪者', '决策裁判（主持人）',
      '提出可执行方案与成功标准。', 'GPT-5.6 Sol', '第 1 轮', '第 2 轮',
      'Round one proposal: choose A.', 'Round one challenge: verify rollback.',
      'Round two proposal: retain A with a gate.', 'Round two challenge: keep the cost dissent.',
      'Round one ruling: continue review.', 'Round two ruling: choose A and record dissent.',
      'artifact:r1-proposer', 'Evidence refs：artifact:evidence', '主张账本', 'Option A is safer.',
      '讨论动态', 'Debate 已规划', '轮次已开始', 'Agent 输出已完成', '主持人总结 / 决策裁判', 'Usage / Cost', '用量部分归集', '费用归集未知', 'artifact:synthesis',
    ]) expect(markup).toContain(expected)
    expect(markup).not.toContain('Choose A or B.')
    expect(markup).toContain('<table>')
    expect(markup).toContain('<colgroup>')
    expect(markup).toContain('<th scope="col">角色</th>')
    expect(markup).toContain('<details class="dshDesktopDebateEvents"')
    expect(markup.indexOf('dshDesktopDebateClaims')).toBeLessThan(markup.indexOf('dshDesktopDebateEvents'))
    expect(markup).toContain('本楼提交主张')
    expect(markup).not.toContain('提出最可执行的方案，明确关键主张、假设和验收标准。')
    expect(markup).not.toContain('角色技术详情')
    expect(markup).not.toContain('constructive-proposer')
    expect(markup).not.toContain('Proposer')
    expect(markup).toContain('费用 N/A')
    expect(markup).not.toContain('NaN')
    expect(markup).toContain('批准')
    expect(markup).toContain('终止')
  })

  it('renders a readable BBS thread and de-duplicates only the same durable error event', () => {
    const fixture = run()
    const duplicateError = {
      version: 1 as const,
      sequence: 1,
      runId: fixture.runId,
      revision: 8,
      generation: 1,
      round: 2,
      slotId: 'skeptical-falsifier',
      type: 'debate.agent.failed',
      createdAt: '2026-08-29T01:01:14.000Z',
      data: {
        role: 'skeptical-falsifier',
        attempt: 1,
        errorCode: 'DUPLICATE_ERROR',
        blockers: [{ code: 'DUPLICATE_ERROR', message: 'First failure.', nodeId: 'node-first' }],
      },
    }
    const secondAttempt = {
      ...duplicateError,
      sequence: 2,
      revision: 9,
      generation: 2,
      data: {
        ...duplicateError.data,
        attempt: 2,
        blockers: [{ code: 'DUPLICATE_ERROR', message: 'Second failure.', nodeId: 'node-second' }],
      },
    }
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [duplicateError, { ...duplicateError }, secondAttempt],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup).toContain('dshDesktopDebateTopic')
    expect(markup).toContain('dshDesktopDebateRoster')
    expect(markup).toContain('参与者名册')
    expect(markup).toContain('1 楼')
    expect(markup).toContain('6 楼')
    expect(markup).toContain('本楼提交主张')
    expect(markup).toContain('<li>Option A is safer.</li>')
    expect(markup).toContain('Claim Ledger 后续发言')
    expect(markup).toContain('Round one ruling: continue review.')
    expect(markup).toContain('技术详情')
    expect(markup).toContain('Agent 输出失败')
    expect(markup).not.toContain('DUPLICATE_ERROR')
    expect(markup).not.toContain('node-first')
    expect(markup).not.toContain('node-second')
    expect(markup).not.toContain('open=""')
  })

  it('orders public floors by roster order even when turns arrive out of order', () => {
    const fixture = run()
    const firstRound = fixture.rounds[0]
    if (firstRound === undefined) throw new Error('missing Debate fixture round')
    fixture.rounds[0] = { ...firstRound, turnStates: [...firstRound.turnStates].reverse() }
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup.match(/<span class="dshDesktopDebateFloor">[0-9]+ 楼<\/span>/g)?.slice(0, 3)).toEqual([
      '<span class="dshDesktopDebateFloor">1 楼</span>',
      '<span class="dshDesktopDebateFloor">2 楼</span>',
      '<span class="dshDesktopDebateFloor">3 楼</span>',
    ])
    expect(markup.indexOf('Round one proposal: choose A.')).toBeLessThan(markup.indexOf('Round one challenge: verify rollback.'))
    expect(markup.indexOf('Round one challenge: verify rollback.')).toBeLessThan(markup.indexOf('Round one ruling: continue review.'))
  })

  it('renders structured progress once with a custom public role title and no raw event fallback', () => {
    const fixture = run()
    fixture.roles = fixture.roles.map(role => role.role === 'skeptical-falsifier' ? { ...role, title: '风险证伪官' } : role)
    const progress = {
      version: 1 as const,
      sequence: 20,
      runId: fixture.runId,
      revision: 8,
      generation: 8,
      round: 1,
      slotId: 'skeptical-falsifier',
      type: 'debate.agent.progress',
      createdAt: '2026-08-29T01:00:08.000Z',
      data: {
        role: 'skeptical-falsifier',
        kind: 'phase',
        phase: 'reasoning',
        orchestrationRunId: 'taskgraph-1',
        orchestrationSequence: 4,
      },
    }
    const toolProgress = {
      ...progress,
      sequence: 21,
      data: {
        ...progress.data,
        kind: 'tool-started',
        toolName: 'Bash',
        orchestrationSequence: 5,
      },
    }
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [progress, { ...progress, revision: 9 }, toolProgress],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup).toContain('Agent 执行进展')
    expect(markup).toContain('阶段：推理中')
    expect(markup).toContain('开始调用工具：Bash')
    expect(markup).toContain('风险证伪官')
    expect(markup).not.toContain('debate.agent.progress')
    expect(markup).not.toContain('状态已记录')
    expect((markup.match(/阶段：推理中/g) ?? []).length).toBe(1)
  })

  it('renders public Markdown into separate priority sections and removes legacy raw-HTML wrappers', () => {
    const fixture = run()
    const firstRound = fixture.rounds[0]
    if (firstRound === undefined) throw new Error('missing Debate fixture round')
    const firstTurn = firstRound.turnStates[0]
    if (firstTurn === undefined) throw new Error('missing Debate fixture turn')
    firstRound.turnStates[0] = {
      ...firstTurn,
      outputPreview: '<details><summary>角色技术详情</summary>internal</details>立场：先建立可靠性基线。P0：持久化状态机。P1：隔离并行工作区。P2：扩展可替换能力。\n\n- 保留证据\n- 验证恢复',
    }
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup).toContain('<h3>P0</h3>')
    expect(markup).toContain('<h3>P1</h3>')
    expect(markup).toContain('<h3>P2</h3>')
    expect(markup).toContain('<li>保留证据</li>')
    expect(markup).toContain('<li>验证恢复</li>')
    expect(markup).not.toContain('&lt;details&gt;')
    expect(markup).not.toContain('角色技术详情')
    expect(markup).not.toContain('internal')
  })

  it('renders fully unknown optional accounting totals as N/A instead of zero or NaN', () => {
    const fixture = run()
    fixture.cost = {
      version: 1,
      usageStatus: 'unknown',
      costStatus: 'unknown',
      unknownUsageTurns: 3,
      unknownCostTurns: 3,
      bySlot: [],
    }
    const markup = renderToStaticMarkup(createElement(EvidenceColumn, { run: fixture }))
    expect(markup).toContain('输入 N/A')
    expect(markup).toContain('输出 N/A')
    expect(markup).toContain('费用 N/A')
    expect(markup).not.toContain('NaN')
    expect(markup).not.toContain('$0.0000')
  })

  it('keeps planned and dispatched lifecycle states in the roster without manufacturing discussion floors', () => {
    const fixture = run()
    fixture.rounds = [{
      ...fixture.rounds[0]!,
      state: 'running',
      turnStates: fixture.rounds[0]!.turnStates.map((entry, index) => {
        const { outputRef: _outputRef, outputPreview: _outputPreview, ...withoutOutput } = entry
        return index === 0
          ? { ...withoutOutput, state: 'planned' as const, claimIds: [], evidenceRefs: [] }
          : index === 1
            ? { ...withoutOutput, state: 'dispatched' as const, claimIds: [], evidenceRefs: [] }
            : { ...withoutOutput, state: 'planned' as const, claimIds: [], evidenceRefs: [] }
      }),
    }]
    fixture.roles = fixture.roles.map((role, index) => {
      if (index === 0) {
        const { outputRef: _outputRef, outputPreview: _outputPreview, ...withoutOutput } = role.latestTurn!
        return { ...role, latestTurn: { ...withoutOutput, state: 'planned' as const, claimIds: [], evidenceRefs: [] } }
      }
      if (index === 1) {
        const { outputRef: _outputRef, outputPreview: _outputPreview, ...withoutOutput } = role.latestTurn!
        return { ...role, latestTurn: { ...withoutOutput, state: 'dispatched' as const, claimIds: [], evidenceRefs: [] } }
      }
      const { outputRef: _outputRef, outputPreview: _outputPreview, ...withoutOutput } = role.latestTurn!
      return { ...role, latestTurn: { ...withoutOutput, state: 'planned' as const, claimIds: [], evidenceRefs: [] } }
    })
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup).toContain('待执行')
    expect(markup).toContain('运行中')
    expect(markup).toContain('参与者尚未提交公开发言。')
    expect(markup).not.toContain('Round one proposal: choose A.')
    expect(markup).not.toContain('公开发言：尚未记录公开输出。')
  })

  it('keeps stopped active terminal turns visible without treating failed turns as public floors', () => {
    const fixture = run()
    const firstRound = fixture.rounds[0]
    if (firstRound === undefined) throw new Error('missing Debate fixture round')
    const proposer = firstRound.turnStates[0]
    const falsifier = firstRound.turnStates[1]
    const judge = firstRound.turnStates[2]
    if (proposer === undefined || falsifier === undefined || judge === undefined) throw new Error('missing Debate fixture turns')
    const { outputRef: _proposerOutputRef, outputPreview: _proposerOutputPreview, ...proposerWithoutOutput } = proposer
    const plannedProposer = { ...proposerWithoutOutput, state: 'planned' as const, claimIds: [], evidenceRefs: [] }
    const settledFalsifier = { ...falsifier, state: 'settled' as const }
    const { outputRef: _judgeOutputRef, outputPreview: _judgeOutputPreview, ...judgeWithoutOutput } = judge
    const failedJudge = {
      ...judgeWithoutOutput,
      state: 'failed' as const,
      claimIds: [],
      evidenceRefs: [],
      errorCode: 'DEBATE_INTERRUPTED',
      blockers: [{ code: 'DEBATE_INTERRUPTED', message: 'judge interrupted', nodeId: 'node-judge' }],
    }
    fixture.state = 'stopped'
    fixture.currentRound = 1
    delete fixture.synthesis
    fixture.rounds = [{ ...firstRound, state: 'running', turnStates: [plannedProposer, settledFalsifier, failedJudge] }]
    fixture.roles = fixture.roles.map(role => role.role === 'constructive-proposer'
      ? { ...role, latestTurn: plannedProposer }
      : role.role === 'skeptical-falsifier'
        ? { ...role, latestTurn: settledFalsifier }
        : role.role === 'decision-judge'
          ? { ...role, latestTurn: failedJudge }
          : role)
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup.match(/<span class="dshDesktopDebateFloor">[0-9]+ 楼<\/span>/g)).toEqual([
      '<span class="dshDesktopDebateFloor">2 楼</span>',
    ])
    expect(markup).toContain('Round one challenge: verify rollback.')
    expect(markup).not.toContain('Round one proposal: choose A.')
    expect(markup).toContain('未产生公开输出：judge interrupted')
  })

  it('keeps settled roles visible when another role is blocked and shows route provenance', () => {
    const fixture = run()
    const blockedRouting = {
      version: 1 as const,
      requestedOperatorId: 'claude-code',
      requestedModel: 'claude-fable-5',
      actualOperatorId: 'codex',
      actualModel: 'gpt-5.6-luna',
      fallbackReasonCode: 'AUTHENTICATION_UNQUALIFIED',
      allocationPlanRef: 'artifact:allocation-plan',
    }
    const { outputRef: _outputRef, outputPreview: _outputPreview, ...turnWithoutOutput } = fixture.rounds[1]!.turnStates[1]!
    const blockedTurn = {
      ...turnWithoutOutput,
      state: 'blocked' as const,
      attempt: 1,
      routing: blockedRouting,
      claimIds: [],
      evidenceRefs: [],
      errorCode: 'EXPLICIT_MODEL_UNAVAILABLE',
      blockers: [{ code: 'EXPLICIT_MODEL_UNAVAILABLE', message: 'Claude Code unavailable because the VPN is blocked.', nodeId: 'debate-r1-skeptical-falsifier' }],
    }
    fixture.rounds = fixture.rounds.map((round, index) => index === 1
      ? { ...round, state: 'failed' as const, turnStates: round.turnStates.map((turn, turnIndex) => turnIndex === 1 ? blockedTurn : turn) }
      : round)
    fixture.roles = fixture.roles.map(role => role.role === 'skeptical-falsifier'
      ? { ...role, latestTurn: blockedTurn }
      : role)
    const markup = renderToStaticMarkup(createElement('div', null,
      createElement(RunDetail, { run: fixture, events: [], pending: false, onControl: async () => {} }),
    ))
    expect(markup).toContain('data-state="settled"')
    expect(markup).toContain('data-state="blocked"')
    expect(markup).toContain('请求：<span>Claude Code · Claude Fable 5</span>')
    expect(markup).toContain('实际：<span>Codex · GPT-5.6 Luna</span>')
    expect(markup).toContain('执行：Codex · GPT-5.6 Luna · Claude Fable 尚未通过订阅资格确认，已改用 Codex Luna')
    expect(markup).toContain('回退：AUTHENTICATION_UNQUALIFIED · 请求模型尚未通过订阅资格确认。')
    expect(markup).toContain('指定模型不可用')
    expect(markup).toContain('Claude Code unavailable because the VPN is blocked.')
    expect(markup).not.toContain('debate-r1-skeptical-falsifier')
    expect(markup).not.toContain('Agent 输出失败')
  })

  it('keeps a native Claude 1M model variant as a normal execution', () => {
    const fixture = run()
    const nativeTurn = {
      ...fixture.rounds[1]!.turnStates[1]!,
      operatorId: 'claude-code',
      model: 'claude-fable-5[1m]',
      routing: {
        version: 1 as const,
        requestedOperatorId: 'claude-code',
        requestedModel: 'claude-fable-5',
        actualOperatorId: 'claude-code',
        actualModel: 'claude-fable-5[1m]',
      },
    }
    fixture.rounds = fixture.rounds.map((round, index) => index === 1
      ? { ...round, turnStates: round.turnStates.map((turn, turnIndex) => turnIndex === 1 ? nativeTurn : turn) }
      : round)
    fixture.roles = fixture.roles.map(role => role.role === 'skeptical-falsifier'
      ? { ...role, latestTurn: nativeTurn }
      : role)
    const markup = renderToStaticMarkup(createElement(RunDetail, { run: fixture, events: [], pending: false, onControl: async () => {} }))
    expect(markup).toContain('Claude Fable 5 · 1M 上下文')
    expect(markup).not.toContain('claude-fable-5[1m]')
    expect(markup).not.toContain('已改用')
    expect(markup).not.toContain('已回退')
    expect(markup).not.toContain('回退：')
  })

  it('explains a true Opus-to-Codex fallback without polluting the public route with a raw code', () => {
    const fixture = run()
    const fallbackTurn = {
      ...fixture.rounds[1]!.turnStates[2]!,
      operatorId: 'codex',
      model: 'gpt-5.6-sol',
      routing: {
        version: 1 as const,
        requestedOperatorId: 'claude-code',
        requestedModel: 'claude-opus-5',
        actualOperatorId: 'codex',
        actualModel: 'gpt-5.6-sol',
        fallbackReasonCode: 'MODEL_UNAVAILABLE',
      },
    }
    fixture.rounds = fixture.rounds.map((round, index) => index === 1
      ? { ...round, turnStates: round.turnStates.map((turn, turnIndex) => turnIndex === 2 ? fallbackTurn : turn) }
      : round)
    fixture.roles = fixture.roles.map(role => role.role === 'decision-judge'
      ? { ...role, latestTurn: fallbackTurn }
      : role)
    const markup = renderToStaticMarkup(createElement(RunDetail, { run: fixture, events: [], pending: false, onControl: async () => {} }))
    expect(markup).toContain('执行：Codex · GPT-5.6 Sol · Claude Opus 当前不可用，已改用 Codex Sol')
    expect(markup).toContain('回退：MODEL_UNAVAILABLE · 请求模型当前不可用。')
    expect(markup).not.toContain('已回退')
  })

  it('deduplicates exact blockers within one turn while preserving distinct messages', () => {
    const fixture = run()
    const secondRound = fixture.rounds[1]
    if (secondRound === undefined) throw new Error('missing Debate fixture round')
    const sourceTurn = secondRound.turnStates[1]
    if (sourceTurn === undefined) throw new Error('missing Debate fixture turn')
    const firstBlocker = { code: 'DUPLICATE_ERROR', message: 'First blocker.', nodeId: 'node-first' }
    const { outputRef: _outputRef, outputPreview: _outputPreview, ...turnWithoutOutput } = sourceTurn
    const blockedTurn = {
      ...turnWithoutOutput,
      state: 'blocked' as const,
      claimIds: [],
      evidenceRefs: [],
      attempt: 1,
      errorCode: 'DUPLICATE_ERROR',
      blockers: [firstBlocker, firstBlocker, { code: 'DUPLICATE_ERROR', message: 'Second blocker.', nodeId: 'node-second' }],
    }
    fixture.rounds = fixture.rounds.map((round, index) => index === 1
      ? { ...round, turnStates: round.turnStates.map((turn, turnIndex) => turnIndex === 1 ? blockedTurn : turn) }
      : round)
    fixture.roles = fixture.roles.map(role => role.role === 'skeptical-falsifier'
      ? { ...role, latestTurn: blockedTurn }
      : role)
    const markup = renderToStaticMarkup(createElement(RunDetail, {
      run: fixture,
      events: [],
      pending: false,
      onControl: async () => {},
    }))
    expect(markup).not.toContain('node-first')
    expect(markup).not.toContain('node-second')
    expect(markup).toContain('First blocker.')
    expect(markup).toContain('Second blocker.')
  })

  it('keeps technical route labels readable without exposing internal node identifiers', () => {
    const fixture = run()
    const longModel = `claude-model-${'x'.repeat(72)}`
    const longNodeId = `debate-node-${'y'.repeat(72)}`
    const route = {
      version: 1 as const,
      requestedOperatorId: 'claude-code',
      requestedModel: longModel,
      actualOperatorId: 'codex',
      actualModel: 'gpt-5.6-luna',
      fallbackReasonCode: 'MODEL_UNAVAILABLE',
    }
    const { outputRef: _outputRef, outputPreview: _outputPreview, ...turnWithoutOutput } = fixture.rounds[1]!.turnStates[1]!
    const blockedTurn = {
      ...turnWithoutOutput,
      state: 'blocked' as const,
      routing: route,
      blockers: [{ code: 'MODEL_UNAVAILABLE', message: 'The requested model is unavailable.', nodeId: longNodeId }],
      claimIds: [],
      evidenceRefs: [],
    }
    fixture.rounds = fixture.rounds.map((round, index) => index === 1
      ? { ...round, turnStates: round.turnStates.map((turn, turnIndex) => turnIndex === 1 ? blockedTurn : turn) }
      : round)
    const markup = renderToStaticMarkup(createElement(RunDetail, { run: fixture, events: [], pending: false, onControl: async () => {} }))
    expect(markup).toContain(`Claude Code · ${longModel}`)
    expect(markup).not.toContain(longNodeId)
    expect(markup).toContain('MODEL_UNAVAILABLE · 请求模型当前不可用。')
  })

  it('offers resume only when the durable stop event proves a pause', () => {
    const stopped = { ...run(), state: 'stopped' as const }
    const withoutPause = renderToStaticMarkup(createElement(RunDetail, {
      run: stopped, events: [], pending: false, onControl: async () => {},
    }))
    const afterPause = renderToStaticMarkup(createElement(RunDetail, {
      run: stopped,
      events: [{ version: 1, sequence: 3, runId: stopped.runId, revision: stopped.revision, generation: 1, type: 'debate.stopped', createdAt: stopped.updatedAt, data: { action: 'pause' } }],
      pending: false,
      onControl: async () => {},
    }))
    expect(withoutPause).not.toContain('恢复')
    expect(afterPause).toContain('恢复')
  })
})
