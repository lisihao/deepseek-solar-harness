/**
 * Keyless end-to-end run through the built `dsh` CLI: the runtime launches a
 * real `dsh --profile headless` child against the scripted mock model, reads
 * the child's persisted session back, and grades the run.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BenchRegistry from '@deepseek-ai/dsh-bench'
import type { BenchSuiteId, BenchTaskId } from '@deepseek-ai/dsh-bench'
import BenchRuntime from '@deepseek-ai/dsh-bench-runner'
import type { ExperimentId, VariantId } from '@deepseek-ai/dsh-bench-runner'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import type { MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')

let root: string
let server: MockLlmServer
let ctx: Context
const saved = { url: process.env.DEEPSEEK_BASE_URL, key: process.env.DEEPSEEK_API_KEY }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-bench-real-child-'))
  const profile = join(root, 'template', 'profiles', 'headless')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-headless',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }))
  server = await startMockLlmServer({ apiKey: 'mock-key', sequence: ['success'], repeatLast: true })
  process.env.DEEPSEEK_BASE_URL = server.baseURL
  process.env.DEEPSEEK_API_KEY = 'mock-key'
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await server.close()
  if (saved.url === undefined) delete process.env.DEEPSEEK_BASE_URL
  else process.env.DEEPSEEK_BASE_URL = saved.url
  if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY
  else process.env.DEEPSEEK_API_KEY = saved.key
  await rm(root, { recursive: true, force: true })
})

describe('BenchRuntime with a real dsh child', () => {
  it.skipIf(!existsSync(dshBin))('grades a run whose session the built CLI persisted', async () => {
    ctx = new Context()
    await ctx.plugin(BenchRegistry)
    ctx.benchmarks.registerSuite({
      id: 'e2e' as BenchSuiteId,
      version: '1',
      description: 'one trivially passing task',
      load: () => Promise.resolve([{
        id: 'reply' as BenchTaskId,
        prompt: 'Reply with one word.',
        grader: { kind: 'command-exit', command: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 10_000 },
        tags: [],
      }]),
    })
    await ctx.plugin(BenchRuntime, {
      command: [process.execPath, dshBin],
      templateHome: join(root, 'template'),
      templateFiles: [],
      ledgerRoot: join(root, 'ledger'),
      concurrency: 1,
      runTimeoutMs: 120_000,
      prices: [],
      providerFailureCodes: ['AUTH'],
    })
    const records = await ctx.benchRuntime.run({
      id: 'e2e' as ExperimentId,
      suite: 'e2e' as BenchSuiteId,
      profile: 'headless',
      repetitions: 1,
      variants: [{ id: 'baseline' as VariantId, patches: [], env: {} }],
    })
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record.error).toBeUndefined()
    expect(record).toMatchObject({ status: 'graded', exitCode: 0, grade: { pass: true } })
    expect(record.models).toContain('deepseek-v4-flash')
    expect(record.metrics!.steps).toBeGreaterThanOrEqual(1)
    expect(record.metrics!.tokens.output).toBeGreaterThan(0)
  }, 180_000)
})
