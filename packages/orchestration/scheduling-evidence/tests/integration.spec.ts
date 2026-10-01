/**
 * Integration tests: the REAL local subprocess service and a REAL Python 3.11+
 * running the REAL collectors from `python/scheduling-evidence`. They verify
 * the world the fake-service suite scripts: documents parse, the state
 * directory is created, and a hung collector's process is actually gone after
 * the deadline. The suite skips, with the reason in its name, on a machine
 * without a suitable interpreter.
 */

import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import SchedulingEvidenceGateway, { SchedulingEvidenceError } from '../src/index.ts'
import type { RadarConfig } from '../src/index.ts'
import { COLLECTOR_SOURCES, findPython, seedRadarStore } from './support.ts'

const SLOW_COLLECTOR = fileURLToPath(new URL('./fixtures/slow', import.meta.url))

const python = findPython()

let stateRoot: string
let ctx: Context

interface MountOptions {
  python?: string
  sourceRoot?: string
  timeoutMs?: number
  graceMs?: number
  radar?: RadarConfig
}

async function mount(config: MountOptions): Promise<SchedulingEvidenceGateway> {
  ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SchedulingEvidenceGateway, {
    python: python ?? 'python3',
    sourceRoot: COLLECTOR_SOURCES,
    stateRoot,
    ...config,
  })
  return ctx.schedulingEvidence
}

async function processExists(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH means the pid is gone; EPERM means it is alive under another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-scheduling-evidence-it-'))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(stateRoot, { recursive: true, force: true })
})

describe.skipIf(python === undefined)(`real collectors (python: ${python ?? 'none with Python 3.11+ on PATH'})`, () => {
  it('reads an empty store from both collectors without contacting the network', async () => {
    const gateway = await mount({})

    for (const [collector, database] of [['radar', 'radar.sqlite3'], ['ai-frontier', 'ai-frontier.sqlite3']] as const) {
      const status = await gateway.status(collector)
      expect(status.exitCode).toBeLessThanOrEqual(1)
      expect(status.document).toMatchObject({ cache_status: 'unavailable', database: { backend: 'sqlite', ok: true } })
      expect(existsSync(join(stateRoot, collector, database))).toBe(true)

      const shown = await gateway.show(collector)
      expect(shown.ok).toBe(false)
    }
  })

  it('ends the process of a call that passes its deadline', async () => {
    const gateway = await mount({ sourceRoot: SLOW_COLLECTOR, timeoutMs: 1_500, graceMs: 500 })

    const error = await gateway.status('radar').then(() => undefined, (cause: unknown) => cause)

    expect(error).toBeInstanceOf(SchedulingEvidenceError)
    expect((error as SchedulingEvidenceError).code).toBe('COLLECTOR_TIMEOUT')
    const pid = Number(readFileSync(join(stateRoot, 'radar', 'pid'), 'utf8'))
    expect(pid).toBeGreaterThan(0)
    for (let attempt = 0; attempt < 60 && await processExists(pid); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(await processExists(pid)).toBe(false)
  })

  it('reports an interpreter that does not exist', async () => {
    const gateway = await mount({ python: 'definitely-not-a-python-interpreter' })

    const error = await gateway.status('radar').then(() => undefined, (cause: unknown) => cause)

    expect((error as SchedulingEvidenceError).code).toBe('INTERPRETER_UNAVAILABLE')
  })
})

describe.skipIf(python === undefined)('real Radar cycle', () => {
  const luna = (effort: 'low' | 'max'): ModelExecutionOffer => ({
    offerId: `codex:gpt-5.6-luna:${effort}`, operatorId: 'codex', provider: 'codex', model: 'gpt-5.6-luna', displayName: 'Luna',
    source: 'native-subscription', tier: 'low', available: true, maxConcurrency: 4, activeCount: 0, tags: ['coding'],
    profile: { model: 'gpt-5.6-luna', effort },
  })

  it('turns a stored generation into evidence only for the Codex rows the offers match', async () => {
    await seedRadarStore(python as string, stateRoot)
    const gateway = await mount({ radar: {} })
    await gateway.runCycle()
    const evidence = gateway.evidenceFor([luna('max'), luna('low')], 'coding')

    expect(Object.keys(evidence?.records ?? {})).toEqual(['codex:gpt-5.6-luna:max'])
    expect(evidence?.snapshots[0]).toMatchObject({ source: 'radar' })
    expect(evidence?.records['codex:gpt-5.6-luna:max']?.[0]).toMatchObject({
      canonical_model_id: 'gpt-5.6-luna', value: 0.6, sample_count: 1000, harness: 'codex-radar-community',
    })
    expect(gateway.evidenceFor([luna('max')], 'research')).toBeUndefined()
  })

  it('offers no evidence from an empty store and does not fail', async () => {
    const gateway = await mount({ radar: {} })
    await gateway.runCycle()

    expect(gateway.evidenceFor([luna('max')], 'coding')).toBeUndefined()
  })
})
