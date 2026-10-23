// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BenchSuiteId, BenchTaskId } from '@deepseek-ai/dsh-bench'
import { analyzeExperiment } from '@deepseek-ai/dsh-bench-runner'
import type { AnalysisOptions, Comparison, Experiment, ExperimentAnalysis, ExperimentId, RunRecord, VariantId } from '@deepseek-ai/dsh-bench-runner'
import type { BenchExperimentDetail, BenchExperimentList } from '../src/contracts.ts'
import { BenchSection } from '../src/client/BenchSection.tsx'
import { ParetoChart, TimeBars } from '../src/client/charts.tsx'
import { describeComparison, fill } from '../src/client/format.ts'
import { en, type BenchLocaleKey } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t = (key: BenchLocaleKey): string => en[key]
const options: AnalysisOptions = { confidence: 0.95, resamples: 200, seed: 1, margin: 0.05, minTasks: 3, invalidTolerance: 0.1 }

function experiment(id: string, ...variants: string[]): Experiment {
  return { id: id as ExperimentId, suite: 'dsh-native' as BenchSuiteId, profile: 'headless', repetitions: 2, variants: variants.map(v => ({ id: v as VariantId, patches: [], env: {} })) }
}

function run(variant: string, task: string, rep: number, pass: boolean, cost?: number): RunRecord {
  return {
    formatVersion: 1, cell: { variant: variant as VariantId, task: task as BenchTaskId, rep }, status: 'graded',
    grade: { pass, score: pass ? 1 : 0, details: '' }, exitCode: 0, models: [], suiteVersion: '2', startedAt: 0, endedAt: 1,
    metrics: {
      turns: 1, steps: 2, retries: 0, sessions: 1, tools: {},
      tokens: { input: 10, output: 5, cacheRead: 0, unreportedMessages: 0 },
      timing: { wallMs: 4000, llmMs: 2000, toolCriticalMs: 1000, overheadMs: 1000 },
      ...cost === undefined ? {} : { costUsd: cost },
    },
  }
}

/** Baseline passes tasks t0..t3 on rep 0 only; "memory" passes every task, flaky on none; prices on both. */
function detail(): BenchExperimentDetail {
  const exp = experiment('mnemon', 'baseline', 'memory')
  const records: RunRecord[] = []
  for (let task = 0; task < 6; task += 1) {
    for (let rep = 0; rep < 2; rep += 1) {
      records.push(run('baseline', `t${String(task)}`, rep, rep === 0 && task < 4, 0.01))
      records.push(run('memory', `t${String(task)}`, rep, true, 0.02))
    }
  }
  return { experiment: exp, records, analysis: analyzeExperiment(exp, records, options) }
}

function list(ids: string[], unreadable: BenchExperimentList['unreadable'] = []): BenchExperimentList {
  // The first experiment has no finished run yet; later ones finished later, so the last is the newest.
  const experiments = ids.map((id, index) => ({ id, suite: 'dsh-native', variants: ['baseline', 'memory'], repetitions: 2, runs: 24, lastEndedAt: index === 0 ? null : index }))
  return { experiments, unreadable }
}

function connection(routes: Record<string, unknown>) {
  const request = vi.fn((input: RequestInfo | URL) => {
    const path = input instanceof Request ? input.url : input.toString()
    if (!(path in routes)) return Promise.resolve(new Response('{}', { status: 404 }))
    const value = routes[path]
    if (value instanceof Error) return Promise.reject(value)
    return Promise.resolve(new Response(JSON.stringify(value), { status: 200 }))
  })
  return { handle: { request }, request }
}

describe('BenchSection', () => {
  it('loads the newest experiment and explains each comparison in words', async () => {
    const { handle, request } = connection({ '/api/bench/experiments': list(['older', 'mnemon']), '/api/bench/experiments/mnemon': detail() })
    render(<BenchSection connection={handle} t={t} />)
    expect(screen.getByRole('status').textContent).toBe('Loading…')
    await screen.findByText('Experiment mnemon · suite dsh-native')
    expect(request).toHaveBeenCalledWith('/api/bench/experiments/mnemon')
    expect(screen.getByText('Baseline: baseline')).toBeTruthy()
    expect(screen.getByText('Better than the baseline')).toBeTruthy()
    expect(screen.getByText(/Success rate \+66\.7 pts across 6 tasks \(95% interval/)).toBeTruthy()
    expect(screen.getByText('Cost per task +$0.0100 · Time per task +0.0 s')).toBeTruthy()
    const variants = within(screen.getByRole('region', { name: 'Variants' }))
    expect(variants.getByText('33.3%')).toBeTruthy()
    expect(variants.getAllByText('100.0%').length).toBeGreaterThan(0)
    expect(screen.getByRole('img', { name: 'Success versus cost' })).toBeTruthy()
    expect(screen.getByRole('img', { name: /baseline: Model 50\.0%, Tools 25\.0%, Harness and plugins 25\.0%/ })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Pass rate by task' })).getAllByText('50.0%')).toHaveLength(4)
    expect(screen.getByText('baseline: t0, t1, t2, t3')).toBeTruthy()
    expect(screen.getByRole('button', { name: /mnemon · 24 runs/ })).toBeTruthy()
  })

  it('switches experiments and refreshes the selected one', async () => {
    const other = { ...detail(), experiment: experiment('older', 'baseline', 'memory') }
    // Listed newest first, so the default must not simply take the last entry.
    const newestFirst = list(['older', 'mnemon'])
    newestFirst.experiments.reverse()
    const { handle, request } = connection({
      '/api/bench/experiments': newestFirst,
      '/api/bench/experiments/mnemon': detail(),
      '/api/bench/experiments/older': other,
    })
    render(<BenchSection connection={handle} t={t} />)
    await screen.findByText('Experiment mnemon · suite dsh-native')
    fireEvent.click(screen.getByRole('button', { name: /older · 24 runs/ }))
    await screen.findByText('Experiment older · suite dsh-native')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(request).toHaveBeenLastCalledWith('/api/bench/experiments/older') })
  })

  it('shows an empty state, unreadable ledgers, and a lone baseline', async () => {
    const empty = connection({ '/api/bench/experiments': list([], [{ id: 'broken', message: 'ledger format 2 is not readable' }]) })
    render(<BenchSection connection={empty.handle} t={t} />)
    await screen.findByText(/No experiments yet/)
    expect(screen.getByRole('note').textContent).toContain('broken — ledger format 2 is not readable')
    expect(empty.request).toHaveBeenCalledTimes(1)
    cleanup()
    const solo = experiment('solo', 'baseline')
    const records = [run('baseline', 't0', 0, true), run('baseline', 't0', 1, true)]
    const lone = connection({
      '/api/bench/experiments': list(['solo']),
      '/api/bench/experiments/solo': { experiment: solo, records, analysis: analyzeExperiment(solo, records, options) },
    })
    render(<BenchSection connection={lone.handle} t={t} />)
    await screen.findByText('This experiment has only a baseline, so there is nothing to compare.')
    expect(screen.getByText(/No variant has priced runs yet/)).toBeTruthy()
  })

  it('shows unpriced, timed-out, and missing runs without inventing numbers', async () => {
    const exp = experiment('rough', 'baseline', 'slow')
    const timeout = (variant: string, task: string): RunRecord => ({ ...run(variant, task, 0, false), status: 'timeout', grade: undefined } as unknown as RunRecord)
    const records = [run('baseline', 't0', 0, true), run('baseline', 'only-base', 0, true), timeout('slow', 't0')]
    const rough = connection({
      '/api/bench/experiments': list(['rough']),
      '/api/bench/experiments/rough': { experiment: exp, records, analysis: analyzeExperiment(exp, records, options) },
    })
    render(<BenchSection connection={rough.handle} t={t} />)
    await screen.findByText('Too few tasks to judge')
    expect(screen.queryByText(/Cost per task|Time per task/)).toBeNull()
    expect(screen.getByText('not run')).toBeTruthy()
    const row = within(screen.getByRole('region', { name: 'Variants' })).getByText('slow').closest('tr')!
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('reports HTTP failures and rejected requests', async () => {
    const failing = connection({})
    render(<BenchSection connection={failing.handle} t={t} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the benchmark records: HTTP 404')
    cleanup()
    const rejected = connection({ '/api/bench/experiments': new Error('offline') })
    render(<BenchSection connection={rejected.handle} t={t} />)
    expect((await screen.findByRole('alert')).textContent).toBe('Could not read the benchmark records: offline')
    cleanup()
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the case under test is a non-Error rejection
    const odd = { request: vi.fn(() => Promise.reject('plain')) }
    render(<BenchSection connection={odd} t={t} />)
    expect((await screen.findByRole('alert')).textContent).toContain('plain')
  })

  it('ignores answers that arrive after unmounting', async () => {
    let resolveList!: (response: Response) => void
    let rejectList!: (error: Error) => void
    const late = { request: vi.fn(() => new Promise<Response>((resolve) => { resolveList = resolve })) }
    const first = render(<BenchSection connection={late} t={t} />)
    first.unmount()
    resolveList(new Response(JSON.stringify(list([])), { status: 200 }))
    const failing = { request: vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectList = reject })) }
    const second = render(<BenchSection connection={failing} t={t} />)
    second.unmount()
    rejectList(new Error('late'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('charts and words', () => {
  it('draws a Pareto chart at zero cost and leaves time bars empty without measured runs', () => {
    const exp = experiment('e', 'a', 'b')
    const records = [run('a', 't0', 0, true, 0), run('b', 't0', 0, false, 0)]
    const analysis = analyzeExperiment(exp, records, options)
    const { container } = render(<ParetoChart analysis={analysis} t={t} />)
    expect(screen.getByText('$1.0000')).toBeTruthy()
    // "b" is dominated by "a" at equal cost, so only "a" is drawn as a front point.
    const dots = [...container.querySelectorAll('circle')].map(dot => [dot.getAttribute('r'), dot.textContent])
    expect(dots).toEqual([['6', 'a: 100.0%, $0.0000 · On the front'], ['4', 'b: 0.0%, $0.0000']])
    cleanup()
    const zero = { llmMs: 0, toolCriticalMs: 0, overheadMs: 0 }
    const silent = { ...analysis, variants: analysis.variants.map(entry => ({ ...entry, time: zero })) }
    render(<TimeBars analysis={silent} t={t} />)
    expect(screen.getByText('No measured runs yet.')).toBeTruthy()
  })

  it('fills placeholders and words every verdict', () => {
    expect(fill('{a} and {b}', { a: 1 })).toBe('1 and {b}')
    const analysis = { baseline: 'base', options, variants: [{ variant: 'base', invalidRate: 0 }, { variant: 'v', invalidRate: 0.3 }] } as unknown as ExperimentAnalysis
    const of = (verdict: Comparison['verdict'], mde: number | null = 0.25, extra: Partial<Comparison> = {}) => describeComparison({
      variant: 'v' as VariantId, verdict, success: { delta: -0.1, low: -0.2, high: 0.05, mde, tasks: 12 },
      costUsd: null, tokens: null, wallMs: null, droppedTasks: [], ...extra,
    }, analysis, t)
    expect(of('regressed').headline).toBe('Worse than the baseline')
    expect(of('equivalent').detail).toBe('Success rate −10.0 pts, within ±5.0 pts (95% interval −20.0 pts to +5.0 pts).')
    expect(of('underpowered').detail).toContain('Differences under about 25.0 pts cannot be detected yet')
    expect(of('underpowered', null).detail).toContain('about — cannot')
    expect(of('insufficient').detail).toBe('12 tasks could be compared; at least 3 are needed.')
    expect(of('unreliable').detail).toBe('Unmeasurable runs differ: v 30.0%, baseline 0.0%. Check the run errors before reading the result.')
    expect(of('unreliable', 0.1, { variant: 'gone' as VariantId }).detail).toContain('gone —')
    const timed = of('improved', 0.1, { wallMs: { delta: -1500, low: 0, high: 0, mde: null, tasks: 1 } })
    expect(timed.extras).toEqual(['Time per task −1.5 s'])
  })
})
