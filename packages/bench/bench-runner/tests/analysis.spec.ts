import { describe, expect, it } from 'vitest'
import type { BenchSuiteId, BenchTaskId } from '@deepseek-ai/dsh-bench'
import { analyzeExperiment } from '@deepseek-ai/dsh-bench-runner'
import type { AnalysisOptions, Experiment, ExperimentId, RunMetrics, RunRecord, RunStatus, VariantId } from '@deepseek-ai/dsh-bench-runner'

const options: AnalysisOptions = { confidence: 0.95, resamples: 2000, seed: 7, margin: 0.05, minTasks: 10, invalidTolerance: 0.1 }

function experiment(...variants: string[]): Experiment {
  return {
    id: 'exp' as ExperimentId, suite: 's' as BenchSuiteId, profile: 'headless', repetitions: 1,
    variants: variants.map(id => ({ id: id as VariantId, patches: [], env: {} })),
  }
}

function metrics(cost: number | undefined, wallMs: number, tools: RunMetrics['tools'] = {}): RunMetrics {
  return {
    turns: 1, steps: 1, retries: 0, sessions: 1, tools,
    tokens: { input: 10, output: 5, cacheRead: 5, unreportedMessages: 0 },
    timing: { wallMs, llmMs: wallMs / 2, toolCriticalMs: wallMs / 4, overheadMs: wallMs / 4 },
    ...cost === undefined ? {} : { costUsd: cost },
  }
}

function run(variant: string, task: string, rep: number, pass: boolean, extra: { status?: RunStatus; cost?: number; wallMs?: number; noMetrics?: boolean; tools?: RunMetrics['tools'] } = {}): RunRecord {
  const status = extra.status ?? 'graded'
  return {
    formatVersion: 1,
    cell: { variant: variant as VariantId, task: task as BenchTaskId, rep },
    status,
    ...status === 'graded' ? { grade: { pass, score: pass ? 1 : 0, details: '' } } : {},
    ...extra.noMetrics === true || status === 'invalid' ? {} : { metrics: metrics(extra.cost, extra.wallMs ?? 100, extra.tools) },
    exitCode: 0, models: [], suiteVersion: '1', startedAt: 0, endedAt: 1,
  }
}

/** `tasks` tasks × `reps` reps per variant; `passes(variant, task, rep)` decides each outcome. */
function grid(
  variants: string[],
  tasks: number,
  reps: number,
  passes: (variant: string, task: number, rep: number) => boolean,
): RunRecord[] {
  const records: RunRecord[] = []
  for (let rep = 0; rep < reps; rep += 1) {
    for (let task = 0; task < tasks; task += 1) {
      for (const variant of variants) records.push(run(variant, `t${String(task)}`, rep, passes(variant, task, rep)))
    }
  }
  return records
}

describe('analyzeExperiment comparisons', () => {
  it('detects an injected improvement and a regression', () => {
    // Baseline passes 20% of 30 tasks, "plus" 80%, "minus" 0%.
    const records = grid(['base', 'plus', 'minus'], 30, 2, (variant, task) =>
      variant === 'plus' ? task % 5 !== 0 : variant === 'base' ? task % 5 === 0 : false)
    const analysis = analyzeExperiment(experiment('base', 'plus', 'minus'), records, options)
    const plus = analysis.comparisons.find(entry => entry.variant === 'plus')!
    expect(plus.verdict).toBe('improved')
    expect(plus.success.delta).toBeCloseTo(0.6, 6)
    expect(plus.success.low).toBeGreaterThan(0)
    expect(plus.success.tasks).toBe(30)
    expect(analysis.comparisons.find(entry => entry.variant === 'minus')!.verdict).toBe('regressed')
  })

  it('calls identical variants equivalent, never significant', () => {
    const records = grid(['base', 'same'], 40, 1, (_variant, task) => task % 2 === 0)
    const same = analyzeExperiment(experiment('base', 'same'), records, options).comparisons[0]!
    expect(same.success).toMatchObject({ delta: 0, low: 0, high: 0, tasks: 40 })
    expect(same.verdict).toBe('equivalent')
  })

  it('calls a tight interval inside the margin equivalent even when the MDE exceeds the margin', () => {
    // 150 tasks: the variant gains 0.5 on half and loses 0.5 on the other half, so delta is 0 and
    // the interval (about ±0.08) sits inside ±0.1 while the MDE (about 0.11) does not.
    const records = grid(['base', 'mixed'], 150, 2, (variant, task, rep) => variant === 'base' ? rep === 0 : task % 2 === 0)
    const mixed = analyzeExperiment(experiment('base', 'mixed'), records, { ...options, margin: 0.1 }).comparisons[0]!
    expect(mixed.success.delta).toBe(0)
    expect(mixed.success.mde).toBeGreaterThan(0.1)
    expect(mixed.success.high).toBeLessThan(0.1)
    expect(mixed.verdict).toBe('equivalent')
  })

  it('reports a noisy small difference as underpowered', () => {
    // 12 tasks; the variant flips half of them in each direction except one net gain.
    const records = grid(['base', 'noisy'], 12, 1, (variant, task) =>
      variant === 'base' ? task < 6 : task >= 5)
    const noisy = analyzeExperiment(experiment('base', 'noisy'), records, options).comparisons[0]!
    expect(noisy.success.low).toBeLessThan(0)
    expect(noisy.success.high).toBeGreaterThan(0)
    expect(noisy.verdict).toBe('underpowered')
    expect(noisy.success.mde).toBeGreaterThan(options.margin)
  })

  it('does not call a zero-spread result equivalent when the interval reaches past the margin', () => {
    // Every task differs by exactly +0.5: sd is 0, so the MDE is 0, yet the effect is large.
    const records = grid(['base', 'half'], 12, 2, (variant, _task, rep) => variant === 'half' ? rep === 0 : false)
    const half = analyzeExperiment(experiment('base', 'half'), records, options).comparisons[0]!
    expect(half.success.mde).toBe(0)
    expect(half.verdict).toBe('improved')
  })

  it('is insufficient below minTasks, which covers the three-task seed suite', () => {
    const records = grid(['base', 'plus'], 3, 3, variant => variant === 'plus')
    const plus = analyzeExperiment(experiment('base', 'plus'), records, options).comparisons[0]!
    expect(plus.verdict).toBe('insufficient')
  })

  it('marks a variant that invalidates its failures as unreliable instead of improved', () => {
    // The variant crashes on every task the baseline fails, so its valid runs all pass.
    const base = grid(['base'], 20, 1, (_variant, task) => task < 10)
    const crashy = Array.from({ length: 20 }, (_, task) =>
      task < 10 ? run('crashy', `t${String(task)}`, 0, true) : run('crashy', `t${String(task)}`, 0, false, { status: 'invalid' }))
    const analysis = analyzeExperiment(experiment('base', 'crashy'), [...base, ...crashy], options)
    const comparison = analysis.comparisons[0]!
    expect(comparison.verdict).toBe('unreliable')
    expect(comparison.droppedTasks).toHaveLength(10)
    expect(analysis.variants[1]).toMatchObject({ invalid: 10, invalidRate: 0.5, successRate: 1 })
  })

  it('gives the same interval for the same seed and a different one for another seed', () => {
    const records = grid(['base', 'v'], 15, 2, (variant, task, rep) => (task + rep + (variant === 'v' ? 1 : 0)) % 3 === 0)
    const a = analyzeExperiment(experiment('base', 'v'), records, options).comparisons[0]!.success
    const b = analyzeExperiment(experiment('base', 'v'), records, options).comparisons[0]!.success
    const c = analyzeExperiment(experiment('base', 'v'), records, { ...options, seed: 8 }).comparisons[0]!.success
    expect(b).toEqual(a)
    expect([c.low, c.high]).not.toEqual([a.low, a.high])
  })

  it('pairs cost, tokens, and graded wall time per task', () => {
    const records = [
      run('base', 't0', 0, true, { cost: 0.01, wallMs: 100 }),
      run('v', 't0', 0, true, { cost: 0.03, wallMs: 300 }),
      run('base', 't1', 0, true, { wallMs: 100 }),
      run('v', 't1', 0, false, { status: 'timeout', cost: 0.5, wallMs: 9999 }),
    ]
    const comparison = analyzeExperiment(experiment('base', 'v'), records, { ...options, minTasks: 3 }).comparisons[0]!
    expect(comparison.costUsd).toMatchObject({ tasks: 1 })
    expect(comparison.costUsd!.delta).toBeCloseTo(0.02, 9)
    expect(comparison.wallMs).toMatchObject({ delta: 200, tasks: 1 })
    expect(comparison.tokens).toMatchObject({ delta: 0, tasks: 2 })
    expect(comparison.success).toMatchObject({ delta: -0.5, tasks: 2, mde: expect.any(Number) as number })
  })

  it('handles a variant with no valid runs and a single paired task', () => {
    const records = [run('base', 't0', 0, true), run('v', 't0', 0, false, { status: 'invalid' }), run('w', 't0', 0, true, { noMetrics: true })]
    const analysis = analyzeExperiment(experiment('base', 'v', 'w'), records, { ...options, invalidTolerance: 1 })
    const [v, w] = analysis.comparisons
    expect(v).toMatchObject({ success: { delta: 0, tasks: 0, mde: null }, costUsd: null, tokens: null, wallMs: null, verdict: 'insufficient' })
    expect(w!.success).toMatchObject({ tasks: 1, mde: null })
    expect(analysis.variants[1]).toMatchObject({
      successRate: null, passAnyRate: null, passAllRate: null, meanTokens: null, meanWallMs: null,
    })
  })
})

describe('analyzeExperiment summaries', () => {
  it('summarizes rates, flaky tasks, time, and tools', () => {
    const records = [
      run('base', 'a', 0, true, { tools: { bash: { calls: 2, errors: 1, totalMs: 50 }, read: { calls: 1, errors: 0, totalMs: 50 } } }),
      run('base', 'a', 1, false, { tools: { bash: { calls: 1, errors: 0, totalMs: 10 } } }),
      run('base', 'b', 0, true),
      run('base', 'b', 1, true),
      run('base', 'c', 0, false, { status: 'timeout' }),
    ]
    const summary = analyzeExperiment(experiment('base'), records, options).variants[0]!
    expect(summary).toMatchObject({
      runs: 5, graded: 4, timeouts: 1, invalid: 0, invalidRate: 0,
      successRate: 3 / 5, passAnyRate: 2 / 3, passAllRate: 1 / 3,
      meanCostUsd: null, pricedRuns: 0, meanTokens: 20, meanWallMs: 100,
      time: { llmMs: 200, toolCriticalMs: 100, overheadMs: 100 },
      flakyTasks: ['a'],
    })
    expect(summary.tools).toEqual([
      { name: 'bash', calls: 3, errors: 1, totalMs: 60 },
      { name: 'read', calls: 1, errors: 0, totalMs: 50 },
    ])
    expect(analyzeExperiment(experiment('base'), [], options).variants[0]).toMatchObject({ runs: 0, invalidRate: 0 })
  })

  it('orders tools with equal time by name', () => {
    const records = [run('base', 'a', 0, true, { tools: { zz: { calls: 1, errors: 0, totalMs: 5 }, aa: { calls: 1, errors: 0, totalMs: 5 } } })]
    expect(analyzeExperiment(experiment('base'), records, options).variants[0]!.tools.map(tool => tool.name)).toEqual(['aa', 'zz'])
  })

  it('builds the pass-rate matrix and the success-versus-cost Pareto set', () => {
    const records = [
      run('base', 'a', 0, false, { cost: 1 }),
      run('cheap', 'a', 0, false, { cost: 0.5 }),
      run('good', 'a', 0, true, { cost: 2 }),
      run('worse', 'a', 0, false, { cost: 3 }),
      run('unpriced', 'b', 0, true),
    ]
    const analysis = analyzeExperiment(experiment('base', 'cheap', 'good', 'worse', 'unpriced'), records, options)
    expect(analysis.baseline).toBe('base')
    expect(analysis.pareto).toEqual(['cheap', 'good'])
    expect(analysis.matrix).toEqual([
      { task: 'a', rates: { base: 0, cheap: 0, good: 1, worse: 0, unpriced: null } },
      { task: 'b', rates: { base: null, cheap: null, good: null, worse: null, unpriced: 1 } },
    ])
    expect(analysis.options).toBe(options)
  })

  it('keeps tied Pareto points', () => {
    const records = [run('base', 'a', 0, true, { cost: 1 }), run('twin', 'a', 0, true, { cost: 1 })]
    expect(analyzeExperiment(experiment('base', 'twin'), records, options).pareto).toEqual(['base', 'twin'])
  })

  it.each([
    [{ resamples: 50 }, /resamples/],
    [{ resamples: 100.5 }, /resamples/],
    [{ minTasks: 2 }, /minTasks/],
    [{ minTasks: 3.5 }, /minTasks/],
    [{ margin: 1 }, /margin/],
    [{ margin: Number.NaN }, /margin/],
    [{ invalidTolerance: -0.1 }, /invalidTolerance/],
    [{ seed: 1.5 }, /seed/],
  ])('rejects invalid settings %o', (override, error) => {
    expect(() => analyzeExperiment(experiment('base'), [], { ...options, ...override })).toThrow(error)
  })
})
