import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { BenchSuite, BenchSuiteId, BenchTaskId } from '@deepseek-ai/dsh-bench'
import type { AnalysisOptions, Comparison, Experiment, RunOptions, RunRecord, VariantId, VariantSummary } from '@deepseek-ai/dsh-bench-runner'
import { apply, describeComparison, EXIT_UNCONFIRMED, internals, summarize, type Config } from '../src/index.ts'

const analysis: AnalysisOptions = { confidence: 0.95, resamples: 100, seed: 1, margin: 0.05, minTasks: 3, invalidTolerance: 0.1 }
let dir: string
let out: string
let err: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-bench-cli-'))
  await writeFile(join(dir, 'exp.yml'), [
    'id: exp', 'suite: demo', 'profile: headless', 'repetitions: 1', 'tasks: [a, b]',
    'variants:', '  - id: base', '  - id: plus', '    patches: [plus.yml]', '',
  ].join('\n'))
  out = ''
  err = ''
  internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
  internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
  internals.env = { DEEPSEEK_API_KEY: 'k' }
})

afterEach(async () => {
  internals.stdout = process.stdout
  internals.stderr = process.stderr
  internals.env = process.env
  await rm(dir, { recursive: true, force: true })
})
type Loose<T> = { [K in keyof T]?: T[K] | undefined }


function record(variant: string, task: string, pass: boolean, extra: Loose<RunRecord> = {}): RunRecord {
  const full = {
    formatVersion: 1, cell: { variant: variant as VariantId, task: task as BenchTaskId, rep: 0 }, status: 'graded',
    grade: { pass, score: pass ? 1 : 0, details: '' }, exitCode: 0, models: [], suiteVersion: '1', startedAt: 0, endedAt: 1,
    metrics: {
      turns: 1, steps: 1, retries: 0, sessions: 1, tools: {}, costUsd: 0.01,
      tokens: { input: 1, output: 1, cacheRead: 0, unreportedMessages: 0 },
      timing: { wallMs: 1000, llmMs: 500, toolCriticalMs: 250, overheadMs: 250 },
    },
    ...extra,
  }
  return Object.fromEntries(Object.entries(full).filter(([, value]) => value !== undefined)) as unknown as RunRecord
}

interface Harness {
  run?: (experiment: Experiment, options: RunOptions) => Promise<RunRecord[]>
  suite?: BenchSuite | undefined
  recorded?: number
  config?: Partial<Config>
}

/** Mount the command over stand-in services and resolve with its exit code and the dispose hook. */
function mount(harness: Harness = {}): { exited: Promise<number>; dispose: () => void } {
  const suite: BenchSuite = {
    id: 'demo' as BenchSuiteId, version: '3', description: 'd',
    load: () => Promise.resolve(['a', 'b', 'c'].map(id => ({ id: id as BenchTaskId, prompt: 'p', grader: { kind: 'k' }, tags: [] }))),
  }
  let disposer: (() => void) | undefined
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => { exit = resolve })
  const services: Record<string, unknown> = {
    appExit: exit,
    benchmarks: { suite: () => 'suite' in harness ? harness.suite : suite },
    benchRuntime: {
      ledger: () => Promise.resolve(harness.recorded === undefined
        ? undefined
        : { experiment: {}, records: Array.from({ length: harness.recorded }) }),
      run: harness.run ?? (() => Promise.resolve([record('base', 'a', false), record('plus', 'a', true)])),
    },
  }
  const ctx = {
    get: (key: string) => services[key],
    effect(callback: () => () => void) { disposer = callback() },
  }
  apply(ctx as unknown as Context, {
    experiment: join(dir, 'exp.yml'), confirmed: true, credentials: { env: ['DEEPSEEK_API_KEY'], files: [join(dir, 'creds.yaml')] }, analysis,
    ...harness.config,
  })
  return { exited, dispose: () => { disposer?.() } }
}

describe('bench-cli', () => {
  it('prints the plan and runs nothing without confirmation', async () => {
    let ran = false
    const code = await mount({ run: () => { ran = true; return Promise.resolve([]) }, recorded: 2, config: { confirmed: false } }).exited
    expect(code).toBe(EXIT_UNCONFIRMED)
    expect(ran).toBe(false)
    expect(out).toContain('Experiment exp: suite demo v3, 2 tasks × 2 variants × 1 repetitions = 4 runs (2 already recorded)')
    expect(out).toContain('  baseline base\n  variant  plus: ')
    expect(out).toContain('No spending limit.')
    expect(out).toContain('re-run with --yes to start')
  })

  it('refuses to start without any model credential', async () => {
    internals.env = {}
    expect(await mount().exited).toBe(1)
    expect(err).toContain(`no model credential: set DEEPSEEK_API_KEY, or create ${join(dir, 'creds.yaml')}`)
    await writeFile(join(dir, 'creds.yaml'), 'x')
    out = ''
    expect(await mount().exited).toBe(0)
  })

  it('reports progress, spending, and the summary', async () => {
    const run = (_experiment: Experiment, options: RunOptions) => {
      const records = [
        record('base', 'a', false),
        record('plus', 'a', true, { metrics: undefined }),
        record('plus', 'b', false, { status: 'timeout', grade: undefined }),
        record('base', 'b', false, { status: 'invalid', grade: undefined, metrics: undefined, error: 'model unavailable: AUTH: bad key\nmore' }),
      ]
      records.forEach((entry, index) => { options.onProgress?.({ record: entry, done: index + 1, total: 4 }) })
      return Promise.resolve(records)
    }
    expect(await mount({ run, config: { maxUsd: 5 } }).exited).toBe(0)
    expect(out).toContain('Stops once priced runs cost more than $5.00.')
    expect(out).toContain('[1/4] base a #1: fail\n[2/4] plus a #1: pass\n[3/4] plus b #1: timeout\n[4/4] base b #1: unmeasurable (model unavailable: AUTH: bad key)\n')
    expect(out).toContain('Spent $0.0200 on priced runs; 2 runs had no price.')
    expect(out).toContain('Results for exp (suite demo)')
    expect(out).toContain('Compared with base:')
  })

  it('stops at the spending limit and keeps the recorded runs', async () => {
    const run = async (_experiment: Experiment, options: RunOptions) => {
      options.onProgress?.({ record: record('base', 'a', true, { metrics: { ...record('base', 'a', true).metrics!, costUsd: 2 } }), done: 1, total: 4 })
      options.signal?.throwIfAborted()
      return Promise.resolve([])
    }
    expect(await mount({ run, config: { maxUsd: 1 } }).exited).toBe(1)
    expect(err).toContain('Stopped: spending limit reached: $2.0000 > $1.00. Recorded runs are kept')
  })

  it('stops when the tree is disposed mid-run', async () => {
    let release!: () => void
    const run = (_experiment: Experiment, options: RunOptions) => new Promise<RunRecord[]>((_resolve, reject) => {
      release = () => { reject(options.signal?.reason as Error) }
      options.signal?.addEventListener('abort', () => { release() })
    })
    const mounted = mount({ run })
    await new Promise(resolve => setTimeout(resolve, 20))
    mounted.dispose()
    expect(await mounted.exited).toBe(1)
    expect(err).toContain('Stopped: interrupted.')
  })

  it('reports a non-Error rejection', async () => {
    // A runtime rejection need not be an Error; the command still exits 1 with its text.
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the case under test is a non-Error rejection
    expect(await mount({ run: () => Promise.reject('plain') }).exited).toBe(1)
    expect(err).toContain('dsh: plain')
  })

  it('reports a run failure and an unknown suite', async () => {
    expect(await mount({ run: () => Promise.reject(new Error('ledger pins a different definition')) }).exited).toBe(1)
    expect(err).toContain('dsh: ledger pins a different definition')
    err = ''
    expect(await mount({ suite: undefined }).exited).toBe(1)
    expect(err).toContain('benchmark suite "demo" is not registered')
    err = ''
    expect(await mount({ config: { experiment: join(dir, 'missing.yml') } }).exited).toBe(1)
    expect(err).toMatch(/ENOENT/)
  })

  it('reads an experiment without a task subset', async () => {
    await writeFile(join(dir, 'all.yml'), 'id: all\nsuite: demo\nprofile: headless\nrepetitions: 2\nvariants: [{ id: base }]\n')
    expect(await mount({ config: { experiment: join(dir, 'all.yml'), confirmed: false } }).exited).toBe(EXIT_UNCONFIRMED)
    expect(out).toContain('3 tasks × 1 variants × 2 repetitions = 6 runs (0 already recorded)')
  })

  it('fails loud without an exit hook', () => {
    expect(() => { apply({ get: () => undefined } as unknown as Context, {} as Config) }).toThrow(/must provide ctx.appExit/)
  })

  it('returns quietly when the tree was disposed before services settled', async () => {
    let exit!: (code: number) => void
    const exited = new Promise<number>((resolve) => { exit = resolve })
    apply({ get: (key: string) => key === 'appExit' ? exit : undefined, effect: () => {} } as unknown as Context, {} as Config)
    expect(await exited).toBe(1)
  })
})

describe('plain-language results', () => {
  const variants = [
    { variant: 'base', invalidRate: 0 },
    { variant: 'v', invalidRate: 0.4 },
  ] as unknown as VariantSummary[]
  const success: Comparison['success'] = { delta: 0.12, low: 0.02, high: 0.2, mde: 0.3, tasks: 12 }
  const of = (verdict: Comparison['verdict'], estimate = success) =>
    describeComparison({ variant: 'v' as VariantId, verdict, success: estimate, costUsd: null, tokens: null, wallMs: null, droppedTasks: [] }, variants, analysis)

  it('explains every verdict without internal words', () => {
    expect(of('improved')).toBe('better: success +12.0 pts (95% interval +2.0 pts to +20.0 pts, 12 tasks)')
    expect(of('regressed', { ...success, delta: -0.12, low: -0.2, high: -0.02 })).toBe('worse: success −12.0 pts (95% interval −20.0 pts to −2.0 pts, 12 tasks)')
    expect(of('equivalent', { ...success, delta: 0, low: -0.01, high: 0.01 })).toBe('no meaningful difference: success +0.0 pts, within ±5.0 pts (95% interval −1.0 pts to +1.0 pts)')
    expect(of('underpowered')).toBe('not enough evidence either way: success +12.0 pts (95% interval +2.0 pts to +20.0 pts); differences under about 30.0 pts cannot be detected. Add tasks or repetitions.')
    expect(of('underpowered', { ...success, mde: null })).toBe('not enough evidence either way: success +12.0 pts (95% interval +2.0 pts to +20.0 pts). Add tasks or repetitions.')
    expect(of('insufficient')).toBe('too few tasks to judge: 12 paired, at least 3 needed')
    expect(of('unreliable')).toBe('not comparable: unmeasurable runs differ (40.0% here, 0.0% in the baseline); check the run errors')
    expect(describeComparison({ variant: 'x' as VariantId, verdict: 'unreliable', success, costUsd: null, tokens: null, wallMs: null, droppedTasks: [] }, [], analysis))
      .toBe('not comparable: unmeasurable runs differ (— here, — in the baseline); check the run errors')
  })

  it('summarizes variants, comparisons, and flaky tasks', () => {
    const experiment = { id: 'exp', suite: 'demo' } as unknown as Experiment
    const text = summarize(experiment, {
      baseline: 'base' as VariantId,
      variants: [
        { variant: 'base', runs: 2, successRate: 0.5, passAnyRate: 1, passAllRate: 0, invalidRate: 0, meanCostUsd: 0.01, meanWallMs: 1500, flakyTasks: ['a'] },
        { variant: 'v', runs: 2, successRate: null, passAnyRate: null, passAllRate: null, invalidRate: 1, meanCostUsd: null, meanWallMs: null, flakyTasks: [] },
      ] as unknown as VariantSummary[],
      comparisons: [],
      matrix: [],
      pareto: [],
      options: analysis,
    })
    expect(text).toBe([
      'Results for exp (suite demo)',
      '',
      'variant  runs  success  any rep  every rep  unmeasurable  cost/run  time/run',
      'base     2     50.0%    100.0%   0.0%       0.0%          $0.0100   1.5s',
      'v        2     —        —        —          100.0%        —         —',
      '',
      'base: results differ between repetitions on a',
      '',
    ].join('\n'))
  })
})
