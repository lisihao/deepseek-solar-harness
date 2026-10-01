/**
 * Gateway tests over a FAKE subprocess service: every spawn spec is recorded
 * and each collector outcome is scripted, so the exit, output, deadline,
 * cancellation, interpreter, and disposal branches run without Python. The
 * real-process behavior is covered by integration.spec.ts.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import SchedulingEvidenceGateway, { SchedulingEvidenceError } from '../src/index.ts'
import type { Config, SchedulingEvidenceErrorCode } from '../src/index.ts'

interface Script {
  readonly exitCode?: number | null
  readonly signal?: NodeJS.Signals | null
  readonly stdout?: string
  readonly lossy?: boolean
  readonly stderr?: string
  /** Wait for the spec's abort signal (or `terminate()`) before settling, like a hung child. */
  readonly hang?: boolean
  /** Reject `done` like a spawn-level failure. */
  readonly reject?: Error
  /** Omit the collect readers, like a provider that ignored the collect request. */
  readonly noReaders?: boolean
}

const VERSION_OK: Script = { stdout: '3.12' }

class FakeHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessCollectedOutputs
  readonly done: Promise<SubprocessOutcome>
  terminated = false
  private release: (() => void) | undefined

  constructor(spec: SubprocessSpawnSpec, script: Script) {
    const read = (text: string, lossy: boolean): { readFrom: () => SubprocessOutputRead } => ({
      readFrom: () => ({ text, nextOffset: text.length, lossy }),
    })
    this.collected = script.noReaders === true
      ? {}
      : { stdout: read(script.stdout ?? '', script.lossy ?? false), stderr: read(script.stderr ?? '', false) }
    const outcome: SubprocessOutcome = { exitCode: script.exitCode === undefined ? 0 : script.exitCode, signal: script.signal ?? null }
    if (script.reject !== undefined) {
      this.done = Promise.reject(script.reject)
    } else if (script.hang === true) {
      this.done = new Promise<SubprocessOutcome>((resolve) => {
        this.release = () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }
      })
      spec.signal?.addEventListener('abort', () => { this.terminate() }, { once: true })
    } else {
      this.done = Promise.resolve(outcome)
    }
  }

  terminate(): void {
    this.terminated = true
    this.release?.()
  }

  waitForExit(): Promise<boolean> {
    return this.done.then(() => true, () => true)
  }
}

class FakeSubprocess extends SubprocessRuntime {
  spawns: SubprocessSpawnSpec[] = []
  handles: FakeHandle[] = []
  resolved: string[] = []
  resolveError: Error | undefined
  /** Script for the interpreter version probe. */
  version: Script = VERSION_OK
  /** Script for collector commands. */
  collector: Script = { stdout: '{"ok":true}\n' }

  override resolveExecutable(command: string): Promise<string> {
    this.resolved.push(command)
    return this.resolveError === undefined ? Promise.resolve(`/usr/bin/${command}`) : Promise.reject(this.resolveError)
  }

  override spawnTerminal(): Promise<never> {
    throw new Error('the gateway spawns pipes, never terminals')
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    const handle = new FakeHandle(spec, spec.argv[1] === '-c' ? this.version : this.collector)
    this.handles.push(handle)
    return handle
  }
}

let stateRoot: string
let ctx: Context
let fake: FakeSubprocess
let fiber: Awaited<ReturnType<Context['plugin']>>

async function mount(config: Partial<Config> = {}): Promise<SchedulingEvidenceGateway> {
  ctx = new Context()
  await ctx.plugin(FakeSubprocess)
  fake = ctx.subprocess as FakeSubprocess
  fiber = await ctx.plugin(SchedulingEvidenceGateway, { python: 'python3', sourceRoot: '/src', stateRoot, ...config })
  return ctx.schedulingEvidence
}

async function codeOf(promise: Promise<unknown>): Promise<SchedulingEvidenceErrorCode> {
  const error = await promise.then(() => undefined, (cause: unknown) => cause)
  expect(error).toBeInstanceOf(SchedulingEvidenceError)
  return (error as SchedulingEvidenceError).code as SchedulingEvidenceErrorCode
}

beforeEach(async () => {
  stateRoot = await mkdtemp(join(tmpdir(), 'dsh-scheduling-evidence-'))
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(stateRoot, { recursive: true, force: true })
})

describe('collector commands', () => {
  it('runs status with an explicit argv, environment, limits, and a private state directory', async () => {
    const gateway = await mount({ maxOutputBytes: 4_096 })
    fake.collector = { stdout: '{"ok":true,"state":"fresh"}\n' }

    const result = await gateway.status('radar')

    expect(result).toEqual({ ok: true, exitCode: 0, document: { ok: true, state: 'fresh' } })
    expect(fake.resolved).toEqual(['python3'])
    const [probe, run] = fake.spawns
    expect(probe?.argv.slice(0, 2)).toEqual(['/usr/bin/python3', '-c'])
    expect(run).toMatchObject({
      argv: ['/usr/bin/python3', '-m', 'codex_radar_provider.cli', '--state-root', join(stateRoot, 'radar'), 'status'],
      cwd: stateRoot,
      graceMs: 2_000,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4_096 }, stderr: { maxBytes: 4_096 } },
      env: { PYTHONPATH: '/src', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1', PYTHONUTF8: '1' },
    })
    expect(existsSync(join(stateRoot, 'radar'))).toBe(true)
  })

  it('addresses each collector by its module and state directory and passes a snapshot id to show', async () => {
    const gateway = await mount()

    await gateway.show('ai-frontier')
    await gateway.show('ai-frontier', { snapshotId: 'gen-7' })

    const argvs = fake.spawns.filter(spec => spec.argv[1] === '-m').map(spec => spec.argv.slice(2))
    const directory = join(stateRoot, 'ai-frontier')
    expect(argvs).toEqual([
      ['ai_frontier_provider.cli', '--state-root', directory, 'show'],
      ['ai_frontier_provider.cli', '--state-root', directory, 'show', '--snapshot-id', 'gen-7'],
    ])
  })

  it('verifies the interpreter once and reuses it', async () => {
    const gateway = await mount()

    await gateway.status('radar')
    await gateway.status('ai-frontier')

    expect(fake.spawns.filter(spec => spec.argv[1] === '-c')).toHaveLength(1)
    expect(fake.resolved).toHaveLength(1)
  })

  it('returns a not-ok document as data for exit status 1 and 2', async () => {
    const gateway = await mount()

    fake.collector = { exitCode: 1, stdout: '{"ok":false,"state":"unavailable"}\n' }
    expect(await gateway.status('radar')).toEqual({ ok: false, exitCode: 1, document: { ok: false, state: 'unavailable' } })

    fake.collector = { exitCode: 2, stdout: '{"ok":false,"error":"bad state"}\n' }
    expect(await gateway.show('radar')).toMatchObject({ ok: false, exitCode: 2, document: { error: 'bad state' } })

    fake.collector = { stdout: '{"state":"fresh"}\n' }
    expect((await gateway.status('radar')).ok).toBe(false)
  })
})

describe('failures', () => {
  it('rejects an unexpected exit status or a signal death with the stderr tail', async () => {
    const gateway = await mount()

    fake.collector = { exitCode: 3, stderr: `${'x'.repeat(500)}Traceback: boom\n` }
    const failed = await gateway.status('radar').then(() => undefined, (cause: unknown) => cause as SchedulingEvidenceError)
    expect(failed?.code).toBe('COLLECTOR_FAILED')
    expect(failed?.message).toContain('exited with status 3')
    expect(failed?.message).toContain('Traceback: boom')
    expect(failed?.message).not.toContain('x'.repeat(450))

    fake.collector = { exitCode: null, signal: 'SIGKILL' }
    const killed = await gateway.status('radar').then(() => undefined, (cause: unknown) => cause as SchedulingEvidenceError)
    expect(killed?.code).toBe('COLLECTOR_FAILED')
    expect(killed?.message).toContain('was killed by SIGKILL')
  })

  it('rejects output that is truncated, not JSON, not an object, or missing', async () => {
    const gateway = await mount()

    fake.collector = { stdout: '{"ok":true', lossy: true }
    expect(await codeOf(gateway.status('radar'))).toBe('COLLECTOR_OUTPUT_INVALID')
    fake.collector = { stdout: 'Traceback (most recent call last)' }
    expect(await codeOf(gateway.status('radar'))).toBe('COLLECTOR_OUTPUT_INVALID')
    fake.collector = { stdout: '[1,2]\n' }
    expect(await codeOf(gateway.status('radar'))).toBe('COLLECTOR_OUTPUT_INVALID')
    fake.collector = { noReaders: true }
    expect(await codeOf(gateway.status('radar'))).toBe('COLLECTOR_OUTPUT_INVALID')
  })

  it('reports a spawn-level failure', async () => {
    const gateway = await mount()
    fake.collector = { reject: new Error('ENOENT') }

    expect(await codeOf(gateway.status('radar'))).toBe('COLLECTOR_SPAWN_FAILED')
  })

  it('stops a call that passes its deadline and reports the timeout', async () => {
    const gateway = await mount({ timeoutMs: 30 })
    fake.collector = { hang: true }

    expect(await codeOf(gateway.status('radar'))).toBe('COLLECTOR_TIMEOUT')
    expect(fake.handles.at(-1)?.terminated).toBe(true)
  })

  it('stops a call the caller cancels and reports the cancellation', async () => {
    const gateway = await mount()
    fake.collector = { hang: true }
    const controller = new AbortController()

    const call = gateway.status('radar', controller.signal)
    await waitForSpawns(2)
    controller.abort()

    expect(await codeOf(call)).toBe('COLLECTOR_ABORTED')
    expect(fake.handles.at(-1)?.terminated).toBe(true)
  })
})

describe('interpreter', () => {
  it('reports a missing interpreter and retries on the next call', async () => {
    const gateway = await mount()
    fake.resolveError = new Error('not found')

    expect(await codeOf(gateway.status('radar'))).toBe('INTERPRETER_UNAVAILABLE')

    fake.resolveError = undefined
    expect((await gateway.status('radar')).ok).toBe(true)
  })

  it('rejects an interpreter that does not report a version', async () => {
    const gateway = await mount()

    fake.version = { stdout: 'not a version' }
    expect(await codeOf(gateway.status('radar'))).toBe('INTERPRETER_UNAVAILABLE')
    fake.version = { exitCode: 1, stdout: '3.12' }
    expect(await codeOf(gateway.status('radar'))).toBe('INTERPRETER_UNAVAILABLE')
  })

  it('requires Python 3.11 or newer', async () => {
    const gateway = await mount()

    for (const old of ['2.7', '3.10']) {
      fake.version = { stdout: old }
      const error = await gateway.status('radar').then(() => undefined, (cause: unknown) => cause as SchedulingEvidenceError)
      expect(error?.code).toBe('INTERPRETER_UNSUPPORTED')
      expect(error?.message).toContain(`Python ${old} is too old`)
    }
    for (const accepted of ['3.11', '3.14', '4.0']) {
      fake.version = { stdout: accepted }
      expect((await gateway.status('radar')).ok).toBe(true)
    }
  })
})

describe('disposal', () => {
  it('stops running calls, waits for their process trees, and refuses new calls', async () => {
    const gateway = await mount()
    fake.collector = { hang: true }

    const call = gateway.status('radar')
    await waitForSpawns(2)
    const running = fake.handles.at(-1)
    await fiber.dispose()

    expect(running?.terminated).toBe(true)
    expect(await codeOf(call)).toBe('COLLECTOR_FAILED')
    expect(await codeOf(gateway.status('radar'))).toBe('GATEWAY_DISPOSED')
  })
})

/** Wait until the fake has recorded `count` spawns (the probe plus a collector command). */
async function waitForSpawns(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200 && fake.spawns.length < count; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  expect(fake.spawns.length).toBeGreaterThanOrEqual(count)
}
