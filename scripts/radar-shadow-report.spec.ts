import { describe, expect, it } from 'vitest'
import { renderReport, summarize, type AllocationFacts, type ReportEvent } from './radar-shadow-report.ts'

const DAY = Date.UTC(2026, 9, 2)
const stats = (passRate: number, usd: number, seconds: number) => ({
  passRate, avgCostUsd: usd, avgRuntimeSeconds: seconds, sampleCount: 100,
})

function decision(id: string, time: number, allocation?: AllocationFacts, route = 'resident'): ReportEvent[] {
  return [{
    type: 'physical-operator/routing-decision', time,
    data: { policy: 'auto', route, requestedByMessageId: id, reason: 'x', ...allocation === undefined ? {} : { allocation } },
  }]
}

describe('summarize', () => {
  it('counts routes, difficulty, and differing selections, and prices only the choices that have both measurements', () => {
    const events: ReportEvent[] = [
      ...decision('old', DAY - 5 * 86_400_000, { difficulty: 'easy', chosenOfferId: 'codex:a' }),
      ...decision('m1', DAY, undefined, 'primary-model'),
      ...decision('m2', DAY + 1, {
        difficulty: 'easy', chosenOfferId: 'codex:a',
        selection: {
          mode: 'shadow', status: 'used', objective: 'economy', applied: false, baselineOfferId: 'codex:a', selectedOfferId: 'codex:b',
          selected: stats(0.65, 0.76, 660), baseline: stats(0.74, 2.5, 780),
        },
        evidence: { mode: 'shadow', status: 'used', applied: false },
      }),
      ...decision('m3', DAY + 2, {
        difficulty: 'normal', chosenOfferId: 'codex:c',
        selection: {
          mode: 'apply', status: 'used', objective: 'balanced', applied: true, baselineOfferId: 'codex:a', selectedOfferId: 'codex:c',
          selected: stats(0.7, 1.8, 540),
        },
      }),
      ...decision('m4', DAY + 3, {
        difficulty: 'normal', chosenOfferId: 'codex:a',
        selection: { mode: 'shadow', status: 'abstained', objective: 'balanced', applied: false, baselineOfferId: 'codex:a', selectedOfferId: 'codex:a' },
      }),
      ...decision('m5', DAY + 4, {
        difficulty: 'hard', chosenOfferId: 'codex:a',
        selection: { mode: 'shadow', status: 'used', objective: 'balanced', applied: false, baselineOfferId: 'codex:a', selectedOfferId: 'codex:a' },
      }),
      { type: 'physical-operator/dispatch', time: DAY + 5, data: { requestedByMessageId: 'm3', commandId: 'c3' } },
      { type: 'physical-operator/dispatch', time: DAY + 5, data: { requestedByMessageId: 'm2', commandId: 'c2' } },
      { type: 'physical-operator/dispatch-terminal', time: DAY + 6, data: { commandId: 'c3', code: 'X' } },
      { type: 'physical-operator/routing-decision', data: { policy: 'auto', route: 'resident', requestedByMessageId: 'untimed' } },
    ]

    const report = summarize(events, DAY)

    expect(report.decisions).toBe(5)
    expect(report.byRoute).toEqual({ 'auto/primary-model': 1, 'auto/resident': 4 })
    expect(report.allocated).toBe(4)
    expect(report.byDifficulty).toEqual({ easy: 1, normal: 2, hard: 1 })
    expect(report.selection).toMatchObject({ ran: 4, abstained: 1, differs: 2, applied: 1, comparable: 1 })
    expect(report.selection.avgCostDeltaUsd).toBeCloseTo(-1.74, 2)
    expect(report.selection.avgRuntimeDeltaSeconds).toBe(-120)
    expect(report.selection.avgPassRateDelta).toBeCloseTo(-0.09, 2)
    expect(report.evidence).toEqual({ ran: 1, used: 1, applied: 0 })
    expect(report.failures).toEqual({
      easy: { allocated: 1, failed: 0 }, normal: { allocated: 2, failed: 1 }, hard: { allocated: 1, failed: 0 },
    })
    expect(report.rows).toHaveLength(4)
    expect(report.rows[0]).toContain('shadow prefers codex:b')
    expect(report.rows[1]).toContain('run failed')
  })

  it('reports no comparable difference when no differing choice has both measurements', () => {
    const report = summarize(decision('a', DAY, {
      difficulty: 'normal', chosenOfferId: 'codex:c',
      selection: { mode: 'apply', status: 'used', objective: 'balanced', applied: true, baselineOfferId: 'codex:a', selectedOfferId: 'codex:c', selected: stats(0.7, 1.8, 540) },
    }), DAY)

    expect(report.selection.comparable).toBe(0)
    expect(renderReport(report, '2026-10-02')).toContain('no differing choice has measurements for both')
  })
})

describe('renderReport', () => {
  it('says there is nothing to evaluate yet when no request reached the allocator', () => {
    const text = renderReport(summarize(decision('a', DAY, undefined, 'primary-model'), DAY), '2026-10-02')

    expect(text).toContain('No allocator decision in this window yet')
    expect(text).not.toContain('## Cost-aware selection')
  })

  it('prints the cost, time, and pass-rate difference with its caveat', () => {
    const text = renderReport(summarize(decision('a', DAY, {
      difficulty: 'easy', chosenOfferId: 'codex:a',
      selection: {
        mode: 'shadow', status: 'used', objective: 'economy', applied: false, baselineOfferId: 'codex:a', selectedOfferId: 'codex:b',
        selected: stats(0.65, 0.76, 660), baseline: stats(0.74, 2.5, 780),
      },
    }), DAY), '2026-10-02')

    expect(text).toContain('cost -1.74 USD, runtime -2.00 min, pass rate -9.00 points per task')
    expect(text).toContain('not your bill')
    expect(text).toContain('does not measure whether finished work was correct')
  })
})
