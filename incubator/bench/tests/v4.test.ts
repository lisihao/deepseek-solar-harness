/**
 * V4-specific behavior: strict run-record reading, the explicit DSH 3.x
 * ledger import, the owner read API, the Settings page render, and the
 * command line.
 */

import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AnalysisConfig, BenchRegistry, BenchRuntime, createLedgersApi, ExperimentLedger, importLegacyLedger, RUN_TEMPLATE_FILES } from '../src/index.js'
import { prepareCell, scrubTemplateFiles } from '../src/cell.js'
import type { AnalysisOptions, Experiment, RunRecord } from '../src/index.js'
import { io, main } from '../src/cli-main.js'
import { en, zh } from '../src/locales.js'
import { Detail, ParetoChart } from '../src/view.js'
import { translator } from '../src/client.js'

const ANALYSIS: AnalysisOptions = { confidence: 0.95, resamples: 200, seed: 1, margin: 0.05, minTasks: 3, invalidTolerance: 0.1 }

/** The shape DSH 3.x pinned, including a patch path that no longer exists. */
const legacyExperiment = {
  formatVersion: 1,
  id: 'ablation-1',
  suite: 'dsh-native',
  profile: 'headless',
  repetitions: 1,
  variants: [
    { id: 'baseline', patches: [], env: {} },
    { id: 'plugin', patches: ['/private/tmp/gone/plugin.patch.yml'], env: {} },
  ],
}

function graded(variant: string, task: string, pass: boolean, cost: number): RunRecord {
  return {
    formatVersion: 1,
    cell: { variant, task, rep: 0 },
    exitCode: 0,
    suiteVersion: '2',
    startedAt: 1_000,
    status: 'graded',
    grade: { pass, score: pass ? 1 : 0, details: 'checked' },
    grader: { kind: 'command-exit', version: 1 },
    metrics: {
      turns: 1, steps: 2,
      timing: { wallMs: 9_000, llmMs: 7_000, toolCriticalMs: 1_000, overheadMs: 1_000 },
      tools: { bash: { calls: 1, errors: 0, totalMs: 900 } },
      retries: 0,
      tokens: { input: 1_000, output: 100, cacheRead: 3_000, unreportedMessages: 0 },
      sessions: 1,
      costUsd: cost,
    },
    models: ['deepseek-v4-flash'],
    endedAt: 2_000,
  }
}

const TASKS = ['t1', 't2', 't3', 't4']
const legacyRecords = TASKS.flatMap((task, index) => [graded('baseline', task, index !== 0, 0.02), graded('plugin', task, true, 0.03)])

let root: string

async function writeLedger(dir: string, pinned: unknown, records: readonly unknown[]): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'experiment.json'), `${JSON.stringify(pinned, undefined, 2)}\n`)
  await writeFile(join(dir, 'runs.jsonl'), records.map(record => `${JSON.stringify(record)}\n`).join(''))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-solar-bench-v4-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('run record schema', () => {
  const experiment = { ...legacyExperiment, formatVersion: undefined } as unknown as Experiment
  const read = async (line: unknown): Promise<RunRecord[]> => {
    const { formatVersion: _version, ...pinned } = legacyExperiment
    await writeLedger(join(root, 'ablation-1'), legacyExperiment, [graded('baseline', 't1', true, 0.01), line])
    return new ExperimentLedger(root, pinned as unknown as Experiment).records(false)
  }

  it('reads valid records, including a pinned patch path that no longer exists', async () => {
    expect(await read(graded('plugin', 't1', false, 0.02))).toHaveLength(2)
    expect(experiment.id).toBe('ablation-1')
  })

  it('refuses a malformed record with its line number instead of trusting the format version', async () => {
    const { grade: _grade, ...ungraded } = graded('plugin', 't1', true, 0.01)
    await expect(read(ungraded)).rejects.toThrow(/runs\.jsonl:2: .*graded record carries grade and grader/s)
    await expect(read({ ...graded('plugin', 't1', true, 0.01), status: 'skipped' })).rejects.toThrow(/runs\.jsonl:2:/)
    await expect(read({ ...graded('plugin', 't1', true, 0.01), extra: 1 })).rejects.toThrow(/runs\.jsonl:2:/)
    await expect(read({ ...graded('plugin', 't1', true, 0.01), formatVersion: 2 })).rejects.toThrow(/run record format 2 is not readable/)
  })
})

describe('run homes', () => {
  it('carry the Harness home .env (proxy), not the credential file, into each run and delete it after the run', async () => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'headless'), { recursive: true })
    await writeFile(join(home, '.env'), 'HTTPS_PROXY=http://127.0.0.1:7890\n')
    await writeFile(join(home, '.credentials.yaml'), 'k: v\n')
    const dirs = await prepareCell(join(root, 'cell'), undefined, { home, files: RUN_TEMPLATE_FILES }, 'headless')
    expect(await readFile(join(dirs.home, '.env'), 'utf8')).toContain('HTTPS_PROXY')
    await expect(readFile(join(dirs.home, '.credentials.yaml'))).rejects.toThrow()
    await scrubTemplateFiles(dirs.home, RUN_TEMPLATE_FILES)
    await expect(readFile(join(dirs.home, '.env'))).rejects.toThrow()
    expect(await readFile(join(home, '.env'), 'utf8')).toContain('HTTPS_PROXY')
  })
})

describe('importLegacyLedger', () => {
  it('validates and copies the two ledger files, leaves the source alone, and is idempotent', async () => {
    const source = join(root, 'legacy', 'ablation-1')
    await writeLedger(source, legacyExperiment, legacyRecords)
    await mkdir(join(source, 'cells', 'baseline'), { recursive: true })
    const before = await readFile(join(source, 'runs.jsonl'), 'utf8')
    const target = join(root, 'solar', 'bench', 'ledgers')
    expect(await importLegacyLedger(source, target)).toMatchObject({ id: 'ablation-1', records: 8, outcome: 'copied', formatVersion: 1 })
    expect(await readFile(join(target, 'ablation-1', 'runs.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(join(source, 'runs.jsonl'), 'utf8')).toBe(before)
    await expect(readFile(join(target, 'ablation-1', 'cells'))).rejects.toThrow()
    expect((await importLegacyLedger(source, target)).outcome).toBe('unchanged')
  })

  it('refuses a torn final record, an invalid record, and a different ledger already at the target', async () => {
    const source = join(root, 'legacy', 'ablation-1')
    const target = join(root, 'ledgers')
    await writeLedger(source, legacyExperiment, legacyRecords)
    await appendFile(join(source, 'runs.jsonl'), '{"formatVersion":1')
    await expect(importLegacyLedger(source, target)).rejects.toThrow(/torn record/)
    await writeLedger(source, legacyExperiment, [...legacyRecords, { formatVersion: 1 }])
    await expect(importLegacyLedger(source, target)).rejects.toThrow(/runs\.jsonl:9:/)
    await writeLedger(source, legacyExperiment, legacyRecords)
    await writeLedger(join(target, 'ablation-1'), legacyExperiment, legacyRecords.slice(1))
    await expect(importLegacyLedger(source, target)).rejects.toThrow(/already holds a different ledger/)
  })
})

describe('ledger read API', () => {
  it('lists readable ledgers, reports unreadable ones, and serves one with its analysis', async () => {
    const ledgers = join(root, 'ledgers')
    await writeLedger(join(ledgers, 'ablation-1'), legacyExperiment, legacyRecords)
    await writeLedger(join(ledgers, 'broken'), { ...legacyExperiment, id: 'broken', formatVersion: 7 }, [])
    const ctx = new Context()
    try {
      let runtime: BenchRuntime | undefined
      await ctx.plugin({
        name: 'probe',
        apply: (inner: Context) => {
          new BenchRegistry(inner)
          runtime = new BenchRuntime(inner, { command: [], templateHome: root, templateFiles: [], ledgerRoot: ledgers, concurrency: 1, runTimeoutMs: 1_000, prices: [], providerFailureCodes: [] })
        },
      })
      const api = createLedgersApi(runtime as BenchRuntime, ANALYSIS)
      const list = await api.list()
      expect(list.root).toBe(ledgers)
      expect(list.experiments).toEqual([{ id: 'ablation-1', suite: 'dsh-native', variants: ['baseline', 'plugin'], repetitions: 1, runs: 8, lastEndedAt: 2_000 }])
      expect(list.unreadable).toEqual([{ id: 'broken', message: expect.stringMatching(/ledger format 7 is not readable/) }])
      const detail = await api.detail({ id: 'ablation-1' })
      expect(detail.records).toHaveLength(8)
      expect(detail.analysis.variants.map(entry => entry.successRate)).toEqual([0.75, 1])
      expect(detail.analysis.comparisons[0]?.success.delta).toBeCloseTo(0.25)
      await expect(api.detail({ id: '../etc' })).rejects.toThrow()
      await expect(api.detail({ id: 'missing' })).rejects.toThrow(/BENCH_EXPERIMENT_NOT_FOUND/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('ships analysis defaults matching the command line', () => {
    expect(AnalysisConfig({} as AnalysisOptions)).toEqual({ confidence: 0.95, resamples: 2000, seed: 1, margin: 0.05, minTasks: 10, invalidTolerance: 0.1 })
  })
})

describe('results view', () => {
  it('renders one experiment in both languages with display names instead of variant ids', async () => {
    const ledgers = join(root, 'ledgers')
    await writeLedger(join(ledgers, 'ablation-1'), legacyExperiment, legacyRecords)
    const { formatVersion: _version, ...pinned } = legacyExperiment
    const records = await new ExperimentLedger(ledgers, pinned as unknown as Experiment).records(false)
    const { analyzeExperiment } = await import('../src/index.js')
    const titles = { baseline: { baseline: true as const }, plugin: { zh: '示例插件', en: 'Sample plugin' } }
    const detail = { experiment: pinned as unknown as Experiment, records, analysis: analyzeExperiment(pinned as unknown as Experiment, records, ANALYSIS), titles }
    for (const [dictionary, lang, plugin] of [[en, 'en', 'Sample plugin'], [zh, 'zh-CN', '示例插件']] as const) {
      const holder = globalThis as { document?: unknown }
      holder.document = { documentElement: { lang } }
      let html: string
      try {
        html = renderToStaticMarkup(createElement(Detail, { detail, t: key => dictionary[key] }))
      } finally {
        delete holder.document
      }
      expect(html).toContain(dictionary.comparisonsTitle)
      expect(html).toContain(dictionary.matrixTitle)
      expect(html).toContain('ablation-1')
      expect(html).toContain('75.0%')
      expect(html).toContain(dictionary.baselineName)
      expect(html).toContain(plugin)
      expect(html).not.toMatch(/>(baseline|plugin)</)
      expect(html).not.toMatch(/verdict[A-Z]|explain[A-Z]|\{(delta|tasks|variant)\}/)
    }
  })
})

describe('success versus cost chart', () => {
  it('keeps the labels of coinciding variants apart', async () => {
    const { formatVersion: _version, ...pinned } = legacyExperiment
    const records = TASKS.flatMap(task => [graded('baseline', task, true, 0.02), graded('plugin', task, true, 0.0201)])
    const { analyzeExperiment } = await import('../src/index.js')
    const analysis = analyzeExperiment(pinned as unknown as Experiment, records, ANALYSIS)
    const html = renderToStaticMarkup(createElement(ParetoChart, { analysis, t: key => en[key] }))
    const labels = [...html.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>(baseline|plugin)<\/text>/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
    expect(labels).toHaveLength(2)
    const [a, b] = labels as [{ x: number; y: number }, { x: number; y: number }]
    expect(Math.abs(a.x - b.x) >= 60 || Math.abs(a.y - b.y) >= 12).toBe(true)
  })
})

describe('page language', () => {
  it('follows the document language at render time, not at registration', () => {
    const t = translator()
    const root = globalThis as { document?: unknown }
    try {
      root.document = { documentElement: { lang: '' } }
      expect(t('nav')).toBe(en.nav)
      root.document = { documentElement: { lang: 'zh-CN' } }
      expect(t('nav')).toBe('基准测试')
    } finally {
      delete root.document
    }
  })
})

describe('command line', () => {
  const capture = (): { out: string[]; err: string[] } => {
    const out: string[] = []
    const err: string[] = []
    io.stdout = { write: (chunk: string) => out.push(chunk) }
    io.stderr = { write: (chunk: string) => err.push(chunk) }
    return { out, err }
  }

  it('imports, lists, and prints a plan without running anything unless confirmed', async () => {
    const home = join(root, 'home')
    io.env = { DSH_HOME: home, DEEPSEEK_API_KEY: 'test-key' }
    const source = join(root, 'legacy', 'ablation-1')
    await writeLedger(source, legacyExperiment, legacyRecords)
    let streams = capture()
    expect(await main(['import', source])).toBe(0)
    expect(streams.out.join('')).toContain(`Imported ablation-1: 8 runs (ledger format 1) at ${join(home, 'solar', 'bench', 'ledgers', 'ablation-1')}`)
    streams = capture()
    expect(await main(['list'])).toBe(0)
    expect(streams.out.join('')).toBe('ablation-1\n')
    const file = join(root, 'plan.yml')
    await writeFile(file, 'id: plan\nsuite: dsh-native\nprofile: headless\nrepetitions: 1\ntasks: [fix-sum-bug]\nvariants: [{ id: baseline }]\n')
    streams = capture()
    expect(await main(['run', file, '--launcher', '/bin/false'])).toBe(2)
    const plan = streams.out.join('')
    expect(plan).toContain('1 tasks × 1 variants × 1 repetitions = 1 runs')
    expect(plan).toContain('Children run: /bin/false --profile headless')
    expect(plan).toContain('Nothing ran.')
    await expect(readFile(join(home, 'solar', 'bench', 'ledgers', 'plan', 'experiment.json'))).rejects.toThrow()
    streams = capture()
    expect(await main(['run', file, '--max-usd=0'])).toBe(1)
    expect(streams.err.join('')).toContain('--max-usd expects a positive number')
    await writeFile(join(root, 'prices.json'), '[{ "model": "m", "input": -1, "output": 1 }]')
    streams = capture()
    expect(await main(['run', file, '--prices', join(root, 'prices.json')])).toBe(1)
    expect(streams.err.join('')).toMatch(/prices\.json: .*input/s)
    await writeFile(join(root, 'prices.json'), '[{ "model": "deepseek-v4-flash", "input": 0.14, "output": 0.28, "cacheRead": 0.028 }]')
    expect(await main(['run', file, '--prices', join(root, 'prices.json')])).toBe(2)
    streams = capture()
    expect(await main(['bogus'])).toBe(1)
  })
})
