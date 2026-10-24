import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BenchRegistry } from '../src/index.js'
import type { BenchGrader, BenchSuite, BenchSuiteId, BenchTask, BenchTaskId } from '../src/index.js'
import { BenchRuntime } from '../src/index.js'
import type { RuntimeConfig as Config, Experiment, ExperimentId, RunProgress, VariantId } from '../src/index.js'
import { childEvents, rootEvents, writeSessions } from './sessions.js'

const fakeDsh = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

let root: string
let ctx: Context

function task(id: string, prompt: string, extra: Partial<BenchTask> = {}): BenchTask {
  return { id: id as BenchTaskId, prompt, grader: { kind: 'file-contains', path: 'out.txt', text: 'yes' }, tags: [], ...extra }
}

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: 'exp' as ExperimentId,
    suite: 'demo' as BenchSuiteId,
    profile: 'headless',
    repetitions: 2,
    variants: [
      { id: 'baseline' as VariantId, patches: [], env: {} },
      { id: 'plus' as VariantId, patches: ['/abs/plus.yml'], env: { FAKE_EXTRA: '{cell}/mnemon' } },
    ],
    ...overrides,
  }
}

async function mount(tasks: BenchTask[], config: Partial<Config> = {}): Promise<void> {
  ctx = new Context()
  await ctx.plugin(BenchRegistry)
  const suite: BenchSuite = { id: 'demo' as BenchSuiteId, version: '7', description: 'd', load: () => Promise.resolve(tasks) }
  ctx.solarBenchmarks.registerSuite(suite)
  await ctx.plugin(BenchRuntime, {
    command: [process.execPath, fakeDsh],
    templateHome: join(root, 'template'),
    templateFiles: ['credentials.yaml', 'absent.yaml'],
    ledgerRoot: join(root, 'ledger'),
    concurrency: 2,
    runTimeoutMs: 20_000,
    prices: [{ model: 'deepseek-v4-flash', input: 1, output: 2, cacheRead: 0.5 }],
    providerFailureCodes: ['AUTH'],
    ...config,
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-bench-runtime-'))
  await mkdir(join(root, 'template', 'profiles', 'headless'), { recursive: true })
  await writeFile(join(root, 'template', 'profiles', 'headless', 'package.json'), '{}')
  await writeFile(join(root, 'template', 'credentials.yaml'), 'secret: 1\n')
  await writeSessions(join(root, 'sessions'), [
    { id: 'root', events: rootEvents() },
    { id: 'child', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'root' as never }, events: childEvents() },
  ])
  process.env.FAKE_DSH_SESSIONS = join(root, 'sessions')
})

afterEach(async () => {
  await ctx.fiber.dispose()
  delete process.env.FAKE_DSH_SESSIONS
  await rm(root, { recursive: true, force: true })
})

describe('BenchRuntime.run', () => {
  it('runs every cell in an isolated home, grades it, folds metrics, and records it', async () => {
    const fixture = join(root, 'fixture')
    await mkdir(fixture)
    await writeFile(join(fixture, 'seed.txt'), 'seed')
    await mount([task('t1', 'write:out.txt:yes', { fixture }), task('t2', 'write:out.txt:no')])
    const progress: RunProgress[] = []
    const records = await ctx.solarBenchRuntime.run(experiment(), { onProgress: entry => progress.push(entry) })
    expect(records).toHaveLength(8)
    expect(progress.map(entry => entry.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(progress.every(entry => entry.total === 8)).toBe(true)
    const byTask = (id: string) => records.filter(record => record.cell.task === id)
    expect(byTask('t1').every(record => record.status === 'graded' && record.grade?.pass === true)).toBe(true)
    expect(byTask('t2').every(record => record.status === 'graded' && record.grade?.pass === false)).toBe(true)
    const first = records[0]!
    expect(first).toMatchObject({ formatVersion: 1, exitCode: 0, suiteVersion: '7', models: ['deepseek-v4-flash'], grader: { kind: 'file-contains', version: 1 } })
    expect(first.metrics).toMatchObject({
      turns: 1, steps: 1, sessions: 2,
      tokens: { input: 1100, output: 210, cacheRead: 500, unreportedMessages: 0 },
      timing: { wallMs: 1000, llmMs: 400, toolCriticalMs: 300, overheadMs: 300 },
      tools: { bash: { calls: 1, errors: 0, totalMs: 100 }, read: { calls: 1, errors: 1, totalMs: 300 } },
    })
    expect(first.metrics!.costUsd! * 1_000_000).toBeCloseTo(1100 * 1 + 500 * 0.5 + 210 * 2, 6)

    const cell = (variant: string, id: string, rep: number) => join(root, 'ledger', 'exp', 'cells', variant, id, String(rep))
    const plus = JSON.parse(await readFile(join(cell('plus', 't1', 1), 'workspace', 'launch.json'), 'utf8')) as Record<string, unknown>
    expect(plus).toEqual({
      argv: ['--profile', 'headless', '--patch', '/abs/plus.yml', 'write:out.txt:yes'],
      cwd: await realpathOf(join(cell('plus', 't1', 1), 'workspace')),
      home: join(cell('plus', 't1', 1), 'home'),
      extra: join(cell('plus', 't1', 1), 'state', 'mnemon'),
      credentials: true,
    })
    const baseline = JSON.parse(await readFile(join(cell('baseline', 't1', 0), 'workspace', 'launch.json'), 'utf8')) as Record<string, unknown>
    expect(baseline.argv).toEqual(['--profile', 'headless', 'write:out.txt:yes'])
    expect(baseline.extra).toBeUndefined()
    expect(await readFile(join(cell('baseline', 't1', 0), 'workspace', 'seed.txt'), 'utf8')).toBe('seed')
    await expect(readFile(join(cell('baseline', 't1', 0), 'home', 'credentials.yaml'), 'utf8')).rejects.toThrow(/ENOENT/)
    const ledger = (await readFile(join(root, 'ledger', 'exp', 'runs.jsonl'), 'utf8')).trim().split('\n')
    expect(ledger).toHaveLength(8)
  })

  it('replaces the directory a crashed run left behind', async () => {
    await mount([task('t1', 'write:out.txt:yes')])
    const stale = join(root, 'ledger', 'exp', 'cells', 'baseline', 't1', '0', 'workspace')
    await mkdir(stale, { recursive: true })
    await writeFile(join(stale, 'out.txt'), 'yes')
    await writeFile(join(stale, 'leftover.txt'), 'x')
    await ctx.solarBenchRuntime.run(experiment({ repetitions: 1, variants: [experiment().variants[0]!] }))
    await expect(readFile(join(stale, 'leftover.txt'), 'utf8')).rejects.toThrow(/ENOENT/)
  })

  it('lists ledgers and reads one back without modifying it', async () => {
    await mount([task('t1', 'write:out.txt:yes')])
    expect(await ctx.solarBenchRuntime.experiments()).toEqual([])
    await ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }))
    expect(await ctx.solarBenchRuntime.experiments()).toEqual(['exp'])
    const snapshot = await ctx.solarBenchRuntime.ledger('exp')
    expect(snapshot?.experiment).toEqual(experiment({ repetitions: 1 }))
    expect(snapshot?.records).toHaveLength(2)
    expect(await ctx.solarBenchRuntime.ledger('missing')).toBeUndefined()
  })

  it('skips recorded cells when the same experiment runs again', async () => {
    await mount([task('t1', 'write:out.txt:yes')])
    await ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }))
    const again = await ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }))
    expect(again).toHaveLength(2)
    await expect(ctx.solarBenchRuntime.run(experiment({ repetitions: 3 }))).rejects.toThrow(/different definition/)
  })

  it('records a timed-out run as timeout and a run without a session log as invalid', async () => {
    await mount([task('hang', 'hang'), task('slow', 'persist-hang'), task('none', 'nosession')], { runTimeoutMs: 500 })
    const records = await ctx.solarBenchRuntime.run(experiment({ repetitions: 1, variants: [experiment().variants[0]!] }))
    const hang = records.find(record => record.cell.task === 'hang')!
    const none = records.find(record => record.cell.task === 'none')!
    expect(hang).toMatchObject({ status: 'timeout', exitCode: null, models: [] })
    expect(hang.grade).toBeUndefined()
    expect(hang.metrics).toBeUndefined()
    const slow = records.find(record => record.cell.task === 'slow')!
    expect(slow).toMatchObject({ status: 'timeout', models: ['deepseek-v4-flash'], metrics: { steps: 1 } })
    expect(none).toMatchObject({ status: 'invalid', exitCode: 1 })
    expect(none.error).toMatch(/session log unreadable: expected one top-level session, found 0/)
  })

  it('records a run whose model was unavailable as invalid, not as a task failure', async () => {
    const authSessions = join(root, 'auth-sessions')
    await writeSessions(authSessions, [{
      id: 'root',
      events: [
        { type: 'turn/start', time: 1, data: { turn: 1 } },
        { type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'bad key' } } } },
      ] as never,
    }])
    const ratelimited = join(root, 'rate-sessions')
    await writeSessions(ratelimited, [{
      id: 'root',
      events: [
        { type: 'turn/start', time: 1, data: { turn: 1 } },
        { type: 'turn/end', time: 2, data: { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: 'slow down' } } } },
      ] as never,
    }])
    await mount([task('t1', 'write:out.txt:yes')])
    const records = await ctx.solarBenchRuntime.run(experiment({
      repetitions: 1,
      variants: [
        { id: 'auth' as VariantId, patches: [], env: { FAKE_DSH_SESSIONS: authSessions } },
        { id: 'rate' as VariantId, patches: [], env: { FAKE_DSH_SESSIONS: ratelimited } },
      ],
    }))
    expect(records.find(record => record.cell.variant === 'auth')).toMatchObject({ status: 'invalid', error: 'model unavailable: AUTH: bad key' })
    expect(records.find(record => record.cell.variant === 'rate')).toMatchObject({ status: 'graded' })
  })

  it('records a grader failure as invalid', async () => {
    const throwing: BenchGrader = { kind: 'throws', version: 1, validate: () => {}, grade: () => Promise.reject(new Error('kaboom')) }
    await mount([task('t1', 'write:out.txt:yes', { grader: { kind: 'throws' } })])
    ctx.solarBenchmarks.registerGrader(throwing)
    const records = await ctx.solarBenchRuntime.run(experiment({ repetitions: 1, variants: [experiment().variants[0]!] }))
    expect(records[0]).toMatchObject({ status: 'invalid', error: 'grader failed: kaboom' })
  })

  it('records a grader unregistered mid-experiment as invalid', async () => {
    const vanishing: BenchGrader = { kind: 'vanishing', version: 1, validate: () => {}, grade: () => Promise.resolve({ pass: true, score: 1, details: '' }) }
    await mount([task('t1', 'write:out.txt:yes', { grader: { kind: 'vanishing' } })], { concurrency: 1 })
    const dispose = ctx.solarBenchmarks.registerGrader(vanishing)
    const records = await ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }), { onProgress: () =>{  dispose() } })
    expect(records[1]).toMatchObject({ status: 'invalid', error: 'grader "vanishing" was unregistered during the experiment' })
  })

  it('runs only the named task subset', async () => {
    await mount([task('t1', 'write:out.txt:yes'), task('t2', 'write:out.txt:yes')])
    const records = await ctx.solarBenchRuntime.run(experiment({ repetitions: 1, tasks: ['t2' as BenchTaskId] }), { signal: new AbortController().signal })
    expect(new Set(records.map(record => record.cell.task))).toEqual(new Set(['t2']))
  })

  it('refuses an unknown suite, task, grader, or grader spec before running anything', async () => {
    await mount([task('t1', 'write:out.txt:yes'), task('bad', 'x', { grader: { kind: 'nope' } })])
    await expect(ctx.solarBenchRuntime.run(experiment({ suite: 'missing' as BenchSuiteId }))).rejects.toThrow(/benchmark suite "missing" is not registered/)
    await expect(ctx.solarBenchRuntime.run(experiment({ tasks: ['zzz' as BenchTaskId] }))).rejects.toThrow(/has no task "zzz"/)
    await expect(ctx.solarBenchRuntime.run(experiment())).rejects.toThrow(/task "bad" names unregistered grader "nope"/)
    await expect(ctx.solarBenchRuntime.run(experiment({ tasks: ['t1' as BenchTaskId] }))).resolves.toHaveLength(4)
    await ctx.fiber.dispose()
    await mount([task('t1', 'x', { grader: { kind: 'file-contains', path: '../x', text: 'a' } })])
    await expect(ctx.solarBenchRuntime.run(experiment({ id: 'other' as ExperimentId }))).rejects.toThrow(/leaves the workspace/)
  })

  it('stops on abort and leaves unfinished cells unrecorded', async () => {
    await mount([task('hang', 'hang')], { concurrency: 1 })
    const controller = new AbortController()
    const pending = ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }), { signal: controller.signal })
    setTimeout(() =>{  controller.abort(new Error('stop')) }, 300)
    await expect(pending).rejects.toThrow()
    const runs = await readFile(join(root, 'ledger', 'exp', 'runs.jsonl'), 'utf8').catch(() => '')
    expect(runs).toBe('')
  })

  it('fails a run whose launcher cannot start', async () => {
    await mount([task('t1', 'write:out.txt:yes')], { command: [join(root, 'missing-launcher')] })
    await expect(ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }))).rejects.toThrow(/ENOENT/)
  })

  it('reads ledgers without a command and refuses to run', async () => {
    await mount([task('t1', 'write:out.txt:yes')])
    await ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }))
    await ctx.fiber.dispose()
    // Overriding with undefined leaves the key unset, so the schema applies its default.
    await mount([task('t1', 'write:out.txt:yes')], { command: undefined } as unknown as Partial<Config>)
    expect(await ctx.solarBenchRuntime.experiments()).toEqual(['exp'])
    expect((await ctx.solarBenchRuntime.ledger('exp'))?.records).toHaveLength(2)
    await expect(ctx.solarBenchRuntime.run(experiment({ id: 'other' as ExperimentId, repetitions: 1 }))).rejects.toThrow(/only reads ledgers/)
    expect(await ctx.solarBenchRuntime.experiments()).toEqual(['exp'])
  })

  it('treats an explicit empty command as read-only', async () => {
    await mount([task('t1', 'write:out.txt:yes')], { command: [] })
    await expect(ctx.solarBenchRuntime.run(experiment({ repetitions: 1 }))).rejects.toThrow(/only reads ledgers/)
    expect(await ctx.solarBenchRuntime.experiments()).toEqual([])
  })
})

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import('node:fs/promises')
  return realpath(path)
}
