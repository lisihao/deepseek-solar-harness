import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Bench from '@deepseek-ai/dsh-bench'
import type { BenchSuiteId, BenchTaskId } from '@deepseek-ai/dsh-bench'
import * as Runner from '@deepseek-ai/dsh-bench-runner'
import { ExperimentLedger } from '@deepseek-ai/dsh-bench-runner'
import type { Experiment, ExperimentId, LedgerSnapshot, RunRecord, VariantId } from '@deepseek-ai/dsh-bench-runner'
import * as Web from '@deepseek-ai/dsh-bench-web'
import type { BenchExperimentDetail, BenchExperimentList } from '@deepseek-ai/dsh-bench-web'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'

const experiment: Experiment = {
  id: 'exp' as ExperimentId, suite: 'dsh-native' as BenchSuiteId, profile: 'headless', repetitions: 1,
  variants: [{ id: 'base' as VariantId, patches: [], env: {} }, { id: 'plus' as VariantId, patches: [], env: {} }],
}

function record(variant: string, task: string, pass: boolean, endedAt: number): RunRecord {
  return {
    formatVersion: 1, cell: { variant: variant as VariantId, task: task as BenchTaskId, rep: 0 }, status: 'graded',
    grade: { pass, score: pass ? 1 : 0, details: '' }, exitCode: 0, models: [], suiteVersion: '1', startedAt: 0, endedAt,
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition over HTTP', () => {
  it('lists ledgers and serves one experiment with its analysis', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-bench-web-'))
    const ledgerRoot = join(root, 'ledger')
    const ledger = new ExperimentLedger(ledgerRoot, experiment)
    await ledger.open()
    await ledger.append(record('base', 't1', false, 10))
    await ledger.append(record('plus', 't1', true, 20))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: web-server',
      "  name: '@deepseek-ai/dsh-host-webserver'",
      '  config: { host: 127.0.0.1, port: 0 }',
      '- id: benchmarks',
      "  name: '@deepseek-ai/dsh-bench'",
      '- id: bench-runner',
      "  name: '@deepseek-ai/dsh-bench-runner'",
      `  config: { command: [node], templateHome: ${root}, templateFiles: [], ledgerRoot: ${ledgerRoot} }`,
      '- id: bench-web',
      "  name: '@deepseek-ai/dsh-bench-web'",
      '  config: { minTasks: 3 }',
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-bench', Bench],
      ['@deepseek-ai/dsh-bench-runner', Runner],
      ['@deepseek-ai/dsh-bench-web', Web],
    ])
    context.loader.internal = {
      version: 'v2',
      import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return Promise.resolve(modules.get(specifier))
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const base = `http://127.0.0.1:${String(context.webServer.port)}${Web.BENCH_API_PATH}`

    const listed = await fetch(`${base}/experiments`)
    expect(listed.status).toBe(200)
    expect(listed.headers.get('cache-control')).toBe('no-store')
    expect(await listed.json()).toEqual({
      experiments: [{ id: 'exp', suite: 'dsh-native', variants: ['base', 'plus'], repetitions: 1, runs: 2, lastEndedAt: 20 }],
    } satisfies BenchExperimentList)

    const detail = await (await fetch(`${base}/experiments/exp`)).json() as BenchExperimentDetail
    expect(detail.records).toHaveLength(2)
    expect(detail.analysis.options.minTasks).toBe(3)
    expect(detail.analysis.comparisons[0]).toMatchObject({ variant: 'plus', verdict: 'insufficient', success: { delta: 1, tasks: 1 } })

    expect((await fetch(`${base}/experiments/missing`)).status).toBe(404)
  })
})

type Handler = (request: unknown, response: unknown) => Promise<void>

function response() {
  return {
    statusCode: 0,
    headers: new Map<string, unknown>(),
    body: '',
    setHeader(name: string, value: unknown) { this.headers.set(name, value) },
    end(value?: Uint8Array) { this.body = Buffer.from(value ?? []).toString('utf8') },
  }
}

function request(method: string, url: string | undefined, options: { remoteAddress?: string; token?: string } = {}) {
  return {
    method,
    url,
    headers: { host: '127.0.0.1:3081', ...options.token === undefined ? {} : { authorization: `Bearer ${options.token}` } },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  }
}

interface FakeRuntime {
  experiments(): Promise<string[]>
  ledger(id: string): Promise<LedgerSnapshot | undefined>
}

function mount(runtime: FakeRuntime, remoteAuth?: unknown): Handler {
  let handler: Handler | undefined
  const ctx = {
    benchRuntime: runtime,
    webServer: { register(route: { handler: Handler }) { handler = route.handler; return () => {} } },
    effect(callback: () => unknown) { callback() },
    get(name: string) { return name === 'remoteAuth' ? remoteAuth : undefined },
  }
  Web.apply(ctx as unknown as Context, { confidence: 0.95, resamples: 100, seed: 1, margin: 0.05, minTasks: 3, invalidTolerance: 0.1 })
  return handler!
}

async function call(handler: Handler, req: ReturnType<typeof request>) {
  const res = response()
  await handler(req, res)
  return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, headers: res.headers }
}

describe('bench-web routes', () => {
  const snapshot: LedgerSnapshot = { experiment, records: [] }
  const runtime = { experiments: () => Promise.resolve(['exp', 'gone']), ledger: (id: string) => Promise.resolve(id === 'exp' ? snapshot : undefined) }

  it('skips a ledger that disappears between listing and reading, and reports no runs as null', async () => {
    const { body } = await call(mount(runtime), request('GET', '/api/bench/experiments'))
    expect(body).toEqual({ experiments: [{ id: 'exp', suite: 'dsh-native', variants: ['base', 'plus'], repetitions: 1, runs: 0, lastEndedAt: null }] })
  })

  it('refuses remote requests without a paired device, and without remote auth', async () => {
    const remote = request('GET', '/api/bench/experiments', { remoteAddress: '10.0.0.5', token: 'nope' })
    expect(await call(mount(runtime), remote)).toMatchObject({ status: 503, body: { error: 'REMOTE_AUTH_UNAVAILABLE' } })
    const auth = { authenticate: (token: string) => token === 'paired' ? { scope: 'cockpit' } : undefined }
    expect(await call(mount(runtime, auth), remote)).toMatchObject({ status: 401, body: { error: 'UNAUTHORIZED' } })
    const paired = request('GET', '/api/bench/experiments', { remoteAddress: '10.0.0.5', token: 'paired' })
    expect((await call(mount(runtime, auth), paired)).status).toBe(200)
  })

  it.each([
    ['/api/bench', 404],
    ['/api/bench/other', 404],
    ['/api/bench/experiments/', 404],
    ['/api/bench/experiments/a%2Fb', 404],
    [undefined, 404],
  ])('answers %s with %i', async (url, status) => {
    expect((await call(mount(runtime), request('GET', url))).status).toBe(status)
  })

  it('allows only GET', async () => {
    const result = await call(mount(runtime), request('POST', '/api/bench/experiments/exp'))
    expect(result).toMatchObject({ status: 405, body: { error: 'METHOD_NOT_ALLOWED' } })
    expect(result.headers.get('Allow')).toBe('GET')
  })

  it('reports a failing ledger read as READ_FAILED', async () => {
    const broken = { experiments: () => Promise.reject(new Error('disk gone')), ledger: () => Promise.reject(new Error('disk gone')) }
    expect(await call(mount(broken), request('GET', '/api/bench/experiments'))).toMatchObject({ status: 500, body: { error: 'READ_FAILED', message: 'disk gone' } })
    expect((await call(mount(broken), request('GET', '/api/bench/experiments/exp'))).status).toBe(500)
  })
})
