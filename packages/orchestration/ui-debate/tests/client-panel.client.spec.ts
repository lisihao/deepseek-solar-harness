import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopDebateRun } from '../src/contracts.ts'
import { controlDebate, EvidenceColumn, loadDebateDashboard, RunDetail } from '../src/client/DebatePanel.tsx'

afterEach(() => { vi.unstubAllGlobals() })

function run(): DesktopDebateRun {
  return {
    version: 1,
    runId: 'debate-1',
    state: 'awaiting_approval',
    mode: 'enabled',
    currentRound: 1,
    revision: 7,
    unresolvedCount: 1,
    updatedAt: '2026-08-29T01:01:00.000Z',
    createdAt: '2026-08-29T01:00:00.000Z',
    objective: 'Choose A or B.',
    sourceSessionId: 'session-1',
    roles: [{
      role: 'constructive-proposer', kind: 'participant', title: 'Proposer', operatorId: 'codex', model: 'gpt-5.6-sol', tier: 'high', source: 'native-subscription', required: true,
      latestTurn: { round: 1, state: 'settled', outputRef: 'artifact:turn-1', claimIds: ['claim-1'], evidenceRefs: ['artifact:evidence'], usage: { inputTokens: 1_000, outputTokens: 400 } },
    }],
    rounds: [{ round: 1, state: 'completed', turnStates: [{ slotId: 'constructive-proposer', state: 'settled', outputRef: 'artifact:turn-1' }], convergence: { status: 'converged', score: 0.9, threshold: 0.8, disagreement: 0.1, coverage: 0.8, unresolvedHighSeverity: 0, settledAgents: 3, reason: 'supported' } }],
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

  it('renders roles, rounds, claims, dissent, unresolved, accounting, and synthesis ref', () => {
    const fixture = run()
    const markup = renderToStaticMarkup(createElement('div', null,
      createElement(RunDetail, { run: fixture, pending: false, onControl: async () => {} }),
      createElement(EvidenceColumn, { run: fixture }),
    ))
    for (const expected of [
      'Choose A or B.', 'Proposer', 'gpt-5.6-sol', '第 1 轮', 'Claim Ledger', 'Option A is safer.',
      'Usage / Cost', '用量部分归集', '费用归集未知', 'artifact:synthesis',
    ]) expect(markup).toContain(expected)
    expect(markup).toContain('费用 N/A')
    expect(markup).not.toContain('NaN')
    expect(markup).toContain('批准')
    expect(markup).toContain('终止')
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
