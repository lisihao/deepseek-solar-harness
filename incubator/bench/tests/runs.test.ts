/**
 * In-app runs: plugin candidates, the generated run profile, and the run
 * manager driving real child processes through the fake launcher.
 */

import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { BenchRegistry, BenchRunManager, BenchRuntime, listPluginCandidates, RUN_PROFILE, RUN_TEMPLATE_FILES, variantIdOf, writeRunTemplate } from '../src/index.js'
import type { BenchJobStatus, BenchSuite, BenchTask, ModelPrice } from '../src/index.js'
import { childEvents, rootEvents, writeSessions } from './sessions.js'

const fakeDsh = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))
const KEY = 'sk-test-secret-value-123'
const PRICES: ModelPrice[] = [{ model: 'deepseek-v4-flash', input: 1, output: 2, cacheRead: 0.5 }]

let root: string
let ctx: Context | undefined

async function writePlugin(profile: string, name: string, options: { version?: string; patch?: string | null; zh?: string } = {}): Promise<void> {
  const dir = join(profile, 'node_modules', name)
  await mkdir(join(dir, 'locale'), { recursive: true })
  const pkg: Record<string, unknown> = { name, version: options.version ?? '1.2.3' }
  if (options.patch !== null) pkg.dsh = { bundle: { patch: './cordis.patch.yml' } }
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg))
  await writeFile(join(dir, 'cordis.patch.yml'), options.patch ?? `- insert:\n    - id: row\n      name: '${name}'\n`)
  if (options.zh !== undefined) await writeFile(join(dir, 'locale', 'zh.json'), JSON.stringify({ meta: { title: options.zh } }))
}

async function writeSourceProfile(): Promise<string> {
  const profile = join(root, 'home', 'profiles', 'desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-cost-meter', '@acme/graph', 'no-patch', 'missing', '@lisihao/dsh-solar-bench'] } },
  }))
  await writePlugin(profile, 'dsh-cost-meter', { zh: '费用表' })
  await writePlugin(profile, '@acme/graph', { version: '0.4.0' })
  await writePlugin(profile, 'no-patch', { patch: null })
  await writePlugin(profile, '@lisihao/dsh-solar-bench')
  return profile
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-solar-bench-runs-'))
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  delete process.env.FAKE_DSH_SESSIONS
  delete process.env.FAKE_DSH_PID
  delete process.env.FAKE_DSH_INACTIVE
  await rm(root, { recursive: true, force: true })
})

describe('plugin candidates and the run profile', () => {
  it('lists enabled third-party bundles with a patch, without official bundles or this plugin', async () => {
    const profile = await writeSourceProfile()
    const candidates = await listPluginCandidates(profile, '@lisihao/dsh-solar-bench')
    expect(candidates.map(entry => [entry.name, entry.version, entry.title])).toEqual([
      ['dsh-cost-meter', '1.2.3', { zh: '费用表' }],
      ['@acme/graph', '0.4.0', {}],
    ])
    expect(candidates[0]?.patch).toBe(join(profile, 'node_modules', 'dsh-cost-meter', 'cordis.patch.yml'))
    expect(variantIdOf('@acme/graph')).toBe('acme-graph')
  })

  it('generates a profile with only dsh-base and dsh-headless and links only the selected plugins', async () => {
    const profile = await writeSourceProfile()
    const template = join(root, 'template')
    await writeRunTemplate(template, profile, ['@acme/graph', 'dsh-cost-meter'])
    await writeRunTemplate(template, profile, ['@acme/graph'])
    const dir = join(template, 'profiles', RUN_PROFILE)
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } }; dependencies?: unknown }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
    expect(manifest.dependencies).toBeUndefined()
    expect((await readdir(join(dir, 'node_modules'))).sort()).toEqual(['@acme'])
    expect(await readdir(join(dir, 'node_modules', '@acme'))).toEqual(['graph'])
    expect((await lstat(join(dir, 'node_modules', '@acme', 'graph'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(dir, 'node_modules', '@acme', 'graph'))).toBe(join(profile, 'node_modules', '@acme', 'graph'))
    expect(await readFile(join(dir, 'cordis.patch.yml'), 'utf8')).toMatch(/^# Generated[^\n]*\n\[\]\n$/)
  })
})

describe('BenchRunManager', () => {
  async function mount(options: { prices?: ModelPrice[]; key?: string | undefined; prompt?: string; runTimeoutMs?: number } = {}): Promise<BenchRunManager> {
    const profile = await writeSourceProfile()
    await writeSessions(join(root, 'sessions'), [
      { id: 'root', events: rootEvents() },
      { id: 'child', header: { origin: 'subagent', delegationDepth: 1, parentSession: 'root' as never }, events: childEvents() },
    ])
    process.env.FAKE_DSH_SESSIONS = join(root, 'sessions')
    const home = join(root, 'home')
    await writeFile(join(home, '.env'), 'NO_PROXY=localhost\n')
    const tasks: BenchTask[] = ['t1', 't2'].map(id => ({ id, prompt: options.prompt ?? 'write:out.txt:yes', grader: { kind: 'file-contains', path: 'out.txt', text: 'yes' }, tags: [] }))
    const suite: BenchSuite = { id: 'demo', version: '1', description: 'demo suite', load: () => Promise.resolve(tasks) }
    let manager: BenchRunManager | undefined
    ctx = new Context()
    await ctx.plugin({
      name: 'runs-probe',
      apply: (inner: Context) => {
        const registry = new BenchRegistry(inner)
        registry.registerSuite(suite)
        const runtime = new BenchRuntime(inner, {
          command: [process.execPath, fakeDsh],
          templateHome: home,
          templateFiles: [...RUN_TEMPLATE_FILES],
          ledgerRoot: join(home, 'solar', 'bench', 'ledgers'),
          concurrency: 1,
          runTimeoutMs: options.runTimeoutMs ?? 20_000,
          prices: options.prices ?? PRICES,
          providerFailureCodes: [],
        })
        manager = new BenchRunManager({
          registry,
          runtime,
          sourceProfile: profile,
          templateHome: join(home, 'solar', 'bench', 'template'),
          self: '@lisihao/dsh-solar-bench',
          minTasks: 10,
          credential: () => Promise.resolve('key' in options ? options.key : KEY),
          now: () => new Date('2026-10-23T20:00:00Z'),
        })
      },
    })
    return manager as BenchRunManager
  }

  async function settle(manager: BenchRunManager): Promise<BenchJobStatus> {
    for (let i = 0; i < 400; i += 1) {
      const status = manager.status()
      if (status.state !== 'running') return status
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('the job did not settle')
  }

  it('offers suites, tasks, plugins and the credential state', async () => {
    const manager = await mount()
    const choices = await manager.choices()
    expect(choices.suites).toEqual([{ id: 'demo', version: '1', description: 'demo suite', tasks: [{ id: 't1', tags: [] }, { id: 't2', tags: [] }] }])
    expect(choices.plugins.map(plugin => plugin.name)).toEqual(['dsh-cost-meter', '@acme/graph'])
    expect(choices).toMatchObject({ minTasks: 10, credential: true })
  })

  it('runs baseline and each plugin variant, records progress, and never shows the key', async () => {
    const manager = await mount()
    const { experimentId } = await manager.start({ suite: 'demo', tasks: ['t1', 't2'], plugins: ['@acme/graph'], repetitions: 1, maxUsd: 5 })
    expect(experimentId).toBe('20261023-200000-demo')
    const status = await settle(manager)
    expect(status).toMatchObject({ state: 'finished', total: 4, done: 4 })
    expect(status.runs.map(run => `${run.variant}/${run.task}:${run.outcome}`)).toEqual(['baseline/t1:pass', 'acme-graph/t1:pass', 'baseline/t2:pass', 'acme-graph/t2:pass'])
    expect(status.spentUsd).toBeGreaterThan(0)
    expect(status.log.join('\n')).toContain('using key [redacted]')
    const ledger = join(root, 'home', 'solar', 'bench', 'ledgers', experimentId)
    const pinned = JSON.parse(await readFile(join(ledger, 'experiment.json'), 'utf8')) as { profile: string; variants: { id: string; patches: string[]; env: Record<string, string> }[] }
    expect(pinned.profile).toBe(RUN_PROFILE)
    expect(pinned.variants[1]).toEqual({ id: 'acme-graph', patches: [join(root, 'home', 'profiles', 'desktop', 'node_modules', '@acme', 'graph', 'cordis.patch.yml')], env: { SOLAR_BENCH_PLUGIN: '@acme/graph@0.4.0' } })
    const launch = JSON.parse(await readFile(join(ledger, 'cells', 'acme-graph', 't1', '0', 'workspace', 'launch.json'), 'utf8')) as { argv: string[] }
    expect(launch.argv.slice(0, 4)).toEqual(['--profile', RUN_PROFILE, '--patch', pinned.variants[1]?.patches[0]])
    const runs = await readFile(join(ledger, 'runs.jsonl'), 'utf8')
    expect(runs).not.toContain(KEY)
    const cellHome = join(ledger, 'cells', 'acme-graph', 't1', '0', 'home')
    expect(await readdir(join(cellHome, 'profiles', RUN_PROFILE, 'node_modules', '@acme'))).toEqual(['graph'])
    await expect(readFile(join(cellHome, '.env'))).rejects.toThrow()
  })

  it('marks a run unmeasurable when the plugin under test did not activate', async () => {
    const manager = await mount()
    process.env.FAKE_DSH_INACTIVE = '@acme/graph'
    await manager.start({ suite: 'demo', tasks: ['t1'], plugins: ['@acme/graph'], repetitions: 1, maxUsd: 5 })
    const status = await settle(manager)
    expect(status.runs.map(run => `${run.variant}:${run.outcome}`)).toEqual(['baseline:pass', 'acme-graph:invalid'])
    expect(status.runs[1]?.reason).toMatch(/plugin under test did not load: row \(@acme\/graph\): pending/)
  })

  it('stops when a run has no price, so the spending limit cannot be bypassed', async () => {
    const manager = await mount({ prices: [] })
    await manager.start({ suite: 'demo', tasks: ['t1', 't2'], plugins: ['dsh-cost-meter'], repetitions: 1, maxUsd: 5 })
    const status = await settle(manager)
    expect(status.state).toBe('stopped')
    expect(status.done).toBe(1)
    expect(status.reason).toMatch(/no price is configured for deepseek-v4-flash/)
  })

  it('stops once the spending limit is exceeded', async () => {
    const manager = await mount()
    await manager.start({ suite: 'demo', tasks: ['t1', 't2'], plugins: ['dsh-cost-meter'], repetitions: 1, maxUsd: 0.000001 })
    const status = await settle(manager)
    expect(status).toMatchObject({ state: 'stopped', done: 1 })
    expect(status.reason).toMatch(/spending limit reached/)
  })

  it('refuses a second start, refuses without a key, and stop kills the running child', async () => {
    const manager = await mount({ prompt: 'hang' })
    process.env.FAKE_DSH_PID = join(root, 'child.pid')
    await manager.start({ suite: 'demo', tasks: ['t1'], plugins: ['dsh-cost-meter'], repetitions: 1, maxUsd: 5 })
    await expect(manager.start({ suite: 'demo', tasks: ['t1'], plugins: ['dsh-cost-meter'], repetitions: 1, maxUsd: 5 })).rejects.toThrow(/BENCH_JOB_RUNNING/)
    let pid: number | undefined
    for (let i = 0; i < 100 && pid === undefined; i += 1) {
      pid = Number(await readFile(process.env.FAKE_DSH_PID, 'utf8').catch(() => '')) || undefined
      if (pid === undefined) await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(manager.status().running).toHaveLength(1)
    const stopped = await manager.stop()
    expect(stopped).toMatchObject({ state: 'stopped', reason: 'stopped by the user', running: [] })
    expect(() => process.kill(pid as number, 0)).toThrow()
  })

  it('refuses to start without a key or with an unknown plugin or task', async () => {
    const manager = await mount({ key: undefined })
    await expect(manager.start({ suite: 'demo', tasks: ['t1'], plugins: ['dsh-cost-meter'], repetitions: 1, maxUsd: 5 })).rejects.toThrow(/BENCH_NO_CREDENTIAL/)
    await expect(manager.start({ suite: 'demo', tasks: ['t1'], plugins: ['no-patch'], repetitions: 1, maxUsd: 5 })).rejects.toThrow(/BENCH_PLUGIN_UNKNOWN/)
    await expect(manager.start({ suite: 'demo', tasks: ['zz'], plugins: ['dsh-cost-meter'], repetitions: 1, maxUsd: 5 })).rejects.toThrow(/BENCH_TASK_UNKNOWN/)
    expect(manager.status().state).toBe('idle')
  })
})
