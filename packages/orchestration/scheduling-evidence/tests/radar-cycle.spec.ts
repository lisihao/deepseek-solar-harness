/**
 * The Radar cycle over a FAKE subprocess service and fake timers: which
 * collector commands run, in which order and with which limits, what the
 * gateway keeps in memory, and that nothing outlives the service.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ModelExecutionOffer } from '@deepseek-ai/dsh-model-allocation'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import SchedulingEvidenceGateway, {
  resolveConfig,
  SCHEDULING_EVIDENCE_SETTINGS_NAMESPACE,
  type Config,
  type RadarConfig,
} from '../src/index.ts'

interface Reply {
  readonly exitCode?: number
  readonly stdout?: string
}

class FakeHandle implements SubprocessHandle {
  readonly pid = 1
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  constructor(reply: Reply) {
    const reader = (text: string): { readFrom: () => { text: string; nextOffset: number; lossy: boolean } } => ({
      readFrom: () => ({ text, nextOffset: text.length, lossy: false }),
    })
    this.collected = { stdout: reader(reply.stdout ?? ''), stderr: reader('boom') }
    this.done = Promise.resolve({ exitCode: reply.exitCode ?? 0, signal: null })
  }

  terminate(): void {}
  waitForExit(): Promise<boolean> { return Promise.resolve(true) }
}

class FakeSubprocess extends SubprocessRuntime {
  spawns: SubprocessSpawnSpec[] = []
  respond: (argv: readonly string[]) => Reply = () => ({ stdout: '{"ok":true}' })

  override resolveExecutable(command: string): Promise<string> { return Promise.resolve(`/usr/bin/${command}`) }
  override spawnTerminal(): Promise<never> { throw new Error('never a terminal') }
  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.spawns.push(spec)
    return new FakeHandle(spec.argv[1] === '-c' ? { stdout: '3.12' } : this.respond(spec.argv))
  }

  /** The collector commands (not the version probe), as the words after the state directory. */
  commands(): string[][] {
    return this.spawns.filter(spec => spec.argv[1] === '-m').map(spec => spec.argv.slice(5))
  }
}

const NOW = Date.parse('2026-10-01T12:00:00Z')
const GENERATION = {
  snapshot_id: 'radar-gen-1',
  digest: 'sha256:radar1',
  fetched_at: '2026-10-01T10:00:00Z',
  cache: { stale_after_seconds: 604_800 },
  models: [{ provider: 'codex', model: 'gpt-5.6-sol', reasoning_effort: 'high', pass_rate: 0.9, sample_count: 1000 }],
}
const sol: ModelExecutionOffer = {
  offerId: 'codex:gpt-5.6-sol', operatorId: 'codex', provider: 'codex', model: 'gpt-5.6-sol', displayName: 'sol',
  source: 'native-subscription', tier: 'high', available: true, maxConcurrency: 4, activeCount: 0,
  tags: ['coding'], profile: { model: 'gpt-5.6-sol', effort: 'high' },
}

const HOUR = 60 * 60_000
let directory: string
let ctx: Context | undefined
let fake: FakeSubprocess
let warnings: string[]
let fiber: Awaited<ReturnType<Context['plugin']>>
let settingsFiber: Awaited<ReturnType<Context['plugin']>> | undefined

async function mount(
  radar: RadarConfig | undefined,
  reply?: FakeSubprocess['respond'],
  userSettings?: string,
): Promise<SchedulingEvidenceGateway> {
  const app = new Context()
  ctx = app
  warnings = []
  app.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof app.logger.warn
  await app.plugin(FakeSubprocess)
  fake = app.subprocess as FakeSubprocess
  fake.respond = reply ?? (argv => argv.includes('show') ? { stdout: JSON.stringify(GENERATION) } : { stdout: '{"ok":true}' })
  if (userSettings !== undefined) {
    const path = join(directory, 'settings.yaml')
    await writeFile(path, userSettings)
    settingsFiber = await app.plugin(FileSettingsProvider, { path, watch: false })
  }
  const config: Config = { python: 'python3', sourceRoot: '/src', stateRoot: directory, ...radar === undefined ? {} : { radar } }
  fiber = await app.plugin(SchedulingEvidenceGateway, config)
  const gateway = app.schedulingEvidence
  // The start-up cycle does file and pipe I/O that fake timers do not drive.
  await gateway.runCycle()
  return gateway
}

/** Wait, in real time, until a settings change has restarted the Radar timer. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) await new Promise(resolve => setTimeout(resolve, 5))
  expect(condition()).toBe(true)
}

/** Move the clock by `ms` and wait for the cycle the tick started. */
async function tick(gateway: SchedulingEvidenceGateway, ms: number): Promise<void> {
  vi.advanceTimersByTime(ms)
  await gateway.runCycle()
}

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['setInterval', 'clearInterval', 'Date'] })
  directory = await mkdtemp(join(tmpdir(), 'dsh-radar-cycle-'))
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  settingsFiber = undefined
  vi.useRealTimers()
  await rm(directory, { recursive: true, force: true })
})

describe('radar settings', () => {
  it('resolves each omitted setting to its documented default', () => {
    const base = { python: 'python3', sourceRoot: '/src', stateRoot: '/state' }

    expect(resolveConfig(base).radar).toBeUndefined()
    expect(resolveConfig({ ...base, radar: {} }).radar).toEqual({
      authorizationFile: undefined,
      personalUseConsent: false,
      refreshIntervalMs: 4 * HOUR,
      refreshTimeoutMs: 600_000,
      staleAfterSeconds: 604_800,
      declaration: { benchmark: 'Codex Radar community tasks', harness: 'codex-radar-community', taskType: 'coding', modelAliases: {} },
    })
    expect(resolveConfig({ ...base, radar: {
      authorizationFile: '/receipt', personalUseConsent: true, refreshIntervalMs: HOUR, refreshTimeoutMs: 5_000, staleAfterSeconds: 120,
      benchmark: 'b', harness: 'h', taskType: 'research', modelAliases: { a: 'b' },
    } }).radar).toEqual({
      authorizationFile: '/receipt', personalUseConsent: true, refreshIntervalMs: HOUR, refreshTimeoutMs: 5_000, staleAfterSeconds: 120,
      declaration: { benchmark: 'b', harness: 'h', taskType: 'research', modelAliases: { a: 'b' } },
    })
  })

  it('bounds the schedule: 30 minutes to 24 hours, never a refresh without a minimum', () => {
    const { Config } = SchedulingEvidenceGateway
    const radar = (value: object): object => ({ python: 'p', sourceRoot: 's', stateRoot: 't', radar: value })

    expect(() => Config(radar({ refreshIntervalMs: 30 * 60_000 }) as never)).not.toThrow()
    expect(() => Config(radar({ refreshIntervalMs: 30 * 60_000 - 1 }) as never)).toThrow()
    expect(() => Config(radar({ refreshIntervalMs: 24 * HOUR + 1 }) as never)).toThrow()
    expect(() => Config(radar({ refreshTimeoutMs: 999 }) as never)).toThrow()
    expect(() => Config(radar({ staleAfterSeconds: 59 }) as never)).toThrow()
  })
})

describe('without Radar settings', () => {
  it('starts nothing and offers no evidence', async () => {
    const gateway = await mount(undefined)
    vi.advanceTimersByTime(24 * HOUR)

    expect(fake.spawns).toHaveLength(0)
    expect(gateway.evidenceFor([sol], 'coding')).toBeUndefined()
  })
})

describe('reading what is stored, without the network', () => {
  it('loads the active generation at start and never refreshes without a receipt', async () => {
    const gateway = await mount({})

    expect(fake.commands()).toEqual([['show']])
    expect(gateway.evidenceFor([sol], 'coding')?.snapshots).toEqual([{ source: 'radar', snapshotId: 'radar-gen-1', digest: 'sha256:radar1' }])
    expect(gateway.evidenceFor([sol], 'research')).toBeUndefined()
  })

  it('offers no evidence when nothing usable is stored', async () => {
    const gateway = await mount({}, () => ({ exitCode: 1, stdout: '{"ok":false,"state":"unavailable","snapshot":null}' }))

    expect(gateway.evidenceFor([sol], 'coding')).toBeUndefined()
  })

  it('reloads on the interval and keeps no process running between cycles', async () => {
    const gateway = await mount({ refreshIntervalMs: HOUR })
    await tick(gateway, HOUR)
    await tick(gateway, HOUR)

    expect(fake.commands()).toEqual([['show'], ['show'], ['show']])
  })

  it('joins a cycle already running instead of starting another', async () => {
    const gateway = await mount({})
    const first = gateway.runCycle()
    const second = gateway.runCycle()
    await Promise.all([first, second])

    expect(second).toBe(first)
    expect(fake.commands()).toEqual([['show'], ['show']])
  })

  it('stops using a generation once it is older than its own staleness limit', async () => {
    const gateway = await mount({})
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()

    vi.setSystemTime(NOW + 8 * 24 * HOUR)
    expect(gateway.evidenceFor([sol], 'coding')).toBeUndefined()
  })
})

describe('collecting with the owner receipt', () => {
  it('refreshes before it reloads when the receipt exists', async () => {
    const receipt = join(directory, 'receipt.json')
    await writeFile(receipt, '{}')
    await mount({ authorizationFile: receipt, staleAfterSeconds: 3_600, refreshTimeoutMs: 45_000 })

    expect(fake.commands()).toEqual([['refresh', '--authorization-file', receipt, '--stale-after-seconds', '3600'], ['show']])
    expect(fake.spawns.find(spec => spec.argv.includes('refresh'))?.signal).toBeDefined()
  })

  it('does not touch the network when the receipt is missing and consent was not stated', async () => {
    await mount({ authorizationFile: join(directory, 'missing.json') })

    expect(fake.commands()).toEqual([['show']])
  })

  it('records personal-use consent once, only because the owner stated it, then refreshes', async () => {
    const receipt = join(directory, 'consent.json')
    await mount({ authorizationFile: receipt, personalUseConsent: true })

    expect(fake.commands()).toEqual([
      ['consent', '--personal-use', '--authorization-file', receipt],
      ['refresh', '--authorization-file', receipt, '--stale-after-seconds', '604800'],
      ['show'],
    ])
  })

  it('collects again on every interval', async () => {
    const receipt = join(directory, 'receipt.json')
    await writeFile(receipt, '{}')
    const gateway = await mount({ authorizationFile: receipt, refreshIntervalMs: 4 * HOUR })
    await tick(gateway, 4 * HOUR)

    expect(fake.commands().filter(words => words[0] === 'refresh')).toHaveLength(2)
  })
})

describe('failure and teardown', () => {
  it('still loads the stored generation when the collection fails or runs past its deadline', async () => {
    const receipt = join(directory, 'receipt.json')
    await writeFile(receipt, '{}')
    const gateway = await mount({ authorizationFile: receipt }, argv => argv.includes('refresh')
      ? { exitCode: 3 }
      : { stdout: JSON.stringify(GENERATION) })

    expect(fake.commands().map(words => words[0])).toEqual(['refresh', 'show'])
    expect(warnings.some(message => message.includes('radar collection failed'))).toBe(true)
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()
  })

  it('logs a failed cycle and keeps the generation it already had', async () => {
    let failing = false
    const gateway = await mount({ refreshIntervalMs: HOUR }, argv => failing
      ? { exitCode: 3 }
      : argv.includes('show') ? { stdout: JSON.stringify(GENERATION) } : { stdout: '{"ok":true}' })
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()

    failing = true
    await tick(gateway, HOUR)

    expect(warnings.some(message => message.includes('radar cycle failed'))).toBe(true)
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()
  })

  it('stops the timer when the service is disposed', async () => {
    await mount({ refreshIntervalMs: HOUR })
    const before = fake.spawns.length
    await fiber.dispose()
    vi.advanceTimersByTime(48 * HOUR)

    expect(fake.spawns).toHaveLength(before)
  })
})

describe('owner settings', () => {
  const NAMESPACE = SCHEDULING_EVIDENCE_SETTINGS_NAMESPACE
  const receipt = (): string => join(directory, 'radar-authorization.json')

  it('keeps Radar off until the owner turns it on, then reads stored evidence without the network', async () => {
    const gateway = await mount(undefined, undefined, '')
    expect(fake.spawns).toHaveLength(0)
    expect(gateway.evidenceFor([sol], 'coding')).toBeUndefined()

    await ctx?.settings.update(NAMESPACE, { radarEnabled: true })
    await until(() => fake.commands().length === 1)

    expect(fake.commands()).toEqual([['show']])
    await gateway.runCycle()
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()
  })

  it('records the owner consent once and collects only after the owner states it', async () => {
    const gateway = await mount(undefined, undefined, 'scheduling-evidence:\n  radarEnabled: true\n')
    expect(fake.commands()).toEqual([['show']])

    await ctx?.settings.update(NAMESPACE, { personalUseConsent: true })
    await until(() => fake.commands().length === 4)
    await gateway.runCycle()

    expect(fake.commands().slice(1, 4)).toEqual([
      ['consent', '--personal-use', '--authorization-file', receipt()],
      ['refresh', '--authorization-file', receipt(), '--stale-after-seconds', '604800'],
      ['show'],
    ])
  })

  it('stops collecting when the owner withdraws consent, even though the receipt file remains', async () => {
    await writeFile(receipt(), '{}')
    const gateway = await mount(undefined, undefined, 'scheduling-evidence:\n  radarEnabled: true\n  personalUseConsent: true\n')
    expect(fake.commands().map(words => words[0])).toEqual(['refresh', 'show'])

    await ctx?.settings.update(NAMESPACE, { personalUseConsent: false })
    await until(() => fake.commands().length === 3)
    await gateway.runCycle()
    await gateway.runCycle()

    expect(fake.commands().map(words => words[0])).toEqual(['refresh', 'show', 'show', 'show', 'show'])
  })

  it('drops its evidence and stops the timer when the owner turns Radar off', async () => {
    const gateway = await mount(undefined, undefined, 'scheduling-evidence:\n  radarEnabled: true\n')
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()
    const before = fake.spawns.length

    await ctx?.settings.update(NAMESPACE, { radarEnabled: false })
    await until(() => gateway.evidenceFor([sol], 'coding') === undefined)
    vi.advanceTimersByTime(48 * HOUR)

    expect(fake.spawns).toHaveLength(before)
  })

  it('uses the interpreter the owner names', async () => {
    await mount(undefined, undefined, 'scheduling-evidence:\n  radarEnabled: true\n  python: /opt/python3.12\n')

    expect(fake.spawns[0]?.argv[0]).toBe('/usr/bin//opt/python3.12')
  })

  it('lets the settings override the plugin config in either direction', async () => {
    await mount({}, undefined, 'scheduling-evidence:\n  radarEnabled: false\n')

    expect(fake.spawns).toHaveLength(0)
  })

  it('stops following the settings when the settings service goes away', async () => {
    const gateway = await mount(undefined, undefined, 'scheduling-evidence:\n  radarEnabled: true\n')
    expect(gateway.evidenceFor([sol], 'coding')).toBeDefined()

    await settingsFiber?.dispose()

    expect(gateway.evidenceFor([sol], 'coding')).toBeUndefined()
  })
})
