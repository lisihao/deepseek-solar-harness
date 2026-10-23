import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  executionArguments,
  loadExecution,
  nativeAutonomousSchema,
  saveExecution,
  type NativeAutonomous,
} from '../src/execution.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solar-rlm-execution-'))
  directories.push(directory)
  return directory
}

const legacyArgs = ['--mode', 'acp', '--offline', '--provider', 'solar-dsh', '--model', 'selected', '--cwd', '/tmp/work', '--daemon-socket', '/tmp/private.sock', '--thinking', 'off']

function journalLine(value: unknown): string {
  return JSON.stringify({ formatVersion: 1, time: '2026-10-20T00:00:00.000Z', value }) + '\n'
}

describe('native autonomous execution evidence', () => {
  it('round-trips a strict execution snapshot without changing gate bytes', async () => {
    const directory = await fixture()
    const autonomous: NativeAutonomous = { maxTurns: 12, maxTokens: 34_567, gate: '  原样\tgate\n', gateMaxRetries: 32, maxContinuations: 32 }

    await saveExecution(directory, autonomous)

    expect(await loadExecution(directory)).toEqual(autonomous)
    expect(JSON.parse(await readFile(join(directory, 'execution.json'), 'utf8'))).toEqual({ formatVersion: 1, autonomous })
  })

  it('loads snapshots written before gate retry support', async () => {
    const directory = await fixture()
    const autonomous = { maxTurns: 12, maxTokens: 34_567, gate: '  原样\tgate\n' }
    await writeFile(join(directory, 'execution.json'), JSON.stringify({ formatVersion: 1, autonomous }))

    await expect(loadExecution(directory)).resolves.toEqual(autonomous)
  })

  it('refuses a duplicate snapshot and leaves the first value intact', async () => {
    const directory = await fixture()
    const first: NativeAutonomous = { maxTurns: 1, maxTokens: 2 }
    const second: NativeAutonomous = { maxTurns: 3, maxTokens: 4 }

    await saveExecution(directory, first)
    await expect(saveExecution(directory, second)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_EXISTS')
    expect(await loadExecution(directory)).toEqual(first)
  })

  it('rejects malformed, unknown, and extra snapshot fields with the named format error', async () => {
    const directory = await fixture()
    const target = join(directory, 'execution.json')
    const invalidSnapshots = [
      '{',
      JSON.stringify({ formatVersion: 2, autonomous: null }),
      JSON.stringify({ formatVersion: 1, autonomous: { maxTurns: 1, maxTokens: 2 }, extra: true }),
      JSON.stringify({ formatVersion: 1, autonomous: { maxTurns: 1, maxTokens: 2, gate: '   ' } }),
    ]

    for (const invalid of invalidSnapshots) {
      await writeFile(target, invalid)
      await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_FORMAT_UNSUPPORTED')
    }
  })

  it('accepts a legacy journal only when every native launch proves Prime mode', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'journal.jsonl'), `${journalLine({ type: 'turn-intent' })}${journalLine({ type: 'native-launch', args: legacyArgs })}`)

    await expect(loadExecution(directory)).resolves.toBeNull()
  })

  it('fences missing, incomplete, and autonomous legacy evidence', async () => {
    const directory = await fixture()

    await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_MISSING')

    await writeFile(join(directory, 'journal.jsonl'), journalLine({ type: 'turn-intent' }))
    await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_MISSING')

    await writeFile(join(directory, 'journal.jsonl'), journalLine({ type: 'native-launch', args: ['--mode', 'acp', '--autonomous-max-turns', '3'] }))
    await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_MISSING')

    await writeFile(join(directory, 'journal.jsonl'), journalLine({ type: 'native-launch', args: ['--mode', 'acp', 3] }))
    await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_MISSING')
  })

  it('fences fabricated or truncated legacy argv and missing journal timestamps', async () => {
    const directory = await fixture()
    for (const args of [[], ['ordinary'], ['--mode', 'acp'], [...legacyArgs, '--autonomous=true']]) {
      await writeFile(join(directory, 'journal.jsonl'), journalLine({ type: 'native-launch', args }))
      await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_MISSING')
    }
    await writeFile(join(directory, 'journal.jsonl'), JSON.stringify({ formatVersion: 1, value: { type: 'native-launch', args: legacyArgs } }) + '\n')
    await expect(loadExecution(directory)).rejects.toThrow('RLM_EXECUTION_SNAPSHOT_MISSING')
  })

  it('builds exact native argv and leaves the default Prime argv empty', () => {
    expect(executionArguments(null, 10_000)).toEqual([])
    expect(executionArguments({ maxTurns: 7, maxTokens: 8, gate: 'gate with spaces\n' }, 9_000)).toEqual([
      '--autonomous',
      '--autonomous-max-turns',
      '7',
      '--autonomous-max-tokens',
      '8',
      '--autonomous-timeout-ms',
      '9000',
      '--autonomous-gate',
      'gate with spaces\n',
    ])
  })

  it('appends an explicitly configured positive native gate retry limit', () => {
    expect(executionArguments({ maxTurns: 7, maxTokens: 8, gateMaxRetries: 32 }, 9_000)).toEqual([
      '--autonomous',
      '--autonomous-max-turns',
      '7',
      '--autonomous-max-tokens',
      '8',
      '--autonomous-timeout-ms',
      '9000',
      '--autonomous-gate-retries',
      '32',
    ])

  })

  it('forwards an explicit continuation limit without changing omitted defaults', () => {
    const base = { maxTurns: 7, maxTokens: 8, gateMaxRetries: 32 }
    const args = executionArguments({ ...base, maxContinuations: 32 }, 9_000)
    expect(args).toEqual([...executionArguments(base, 9_000), '--autonomous-max-continuations', '32'])
    expect(executionArguments(base, 9_000)).not.toContain('--autonomous-max-continuations')
    for (const maxContinuations of [0, -1, 1.5, 1_001]) {
      expect(nativeAutonomousSchema.safeParse({ ...base, maxContinuations }).success).toBe(false)
    }
    for (const maxContinuations of [1, 1_000]) {
      expect(nativeAutonomousSchema.safeParse({ ...base, maxContinuations }).success).toBe(true)
    }
  })

  it('enforces bounds, strict fields, and non-blank gate text', () => {
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1 }).success).toBe(true)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1_000, maxTokens: 1_000_000_000, gate: 'x'.repeat(4_096), gateMaxRetries: 1_000 }).success).toBe(true)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 0, maxTokens: 1 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1_001, maxTokens: 1 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1_000_000_001 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, gate: ' '.repeat(4_096) }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, gate: 'x'.repeat(4_097) }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, gateMaxRetries: 0 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, gateMaxRetries: -1 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, gateMaxRetries: 1.5 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, gateMaxRetries: 1_001 }).success).toBe(false)
    expect(nativeAutonomousSchema.safeParse({ maxTurns: 1, maxTokens: 1, unexpected: true }).success).toBe(false)
  })
})
