/**
 * Process reclamation with real processes and injected faults: a member that never becomes ready, one that ignores
 * SIGTERM, one that survives every signal, and two requests for the same member. The success path is covered by
 * the end-to-end suite; these are the paths where a control action is issued but the process does not obey it.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalGouziOperations } from '../src/gouzi-local.ts'
import { GouziActiveLimitError, GouziSupervisor } from '../src/gouzi-supervisor.ts'

const STAND_IN = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'gouzi-worker-stand-in.mjs')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone.
    return false
  }
}

let root: string
const spawned = new Set<number>()

function supervisor(mode: string, extra: Record<string, string> = {}, options: { activeLimit?: number; readyTimeoutMs?: number } = {}) {
  return new GouziSupervisor({
    membersRoot: root,
    workerCommand: () => ({ command: process.execPath, args: [STAND_IN], env: { STAND_IN_MODE: mode, ...extra } }),
    activeLimit: options.activeLimit ?? 2,
    readyTimeoutMs: options.readyTimeoutMs ?? 600,
    stopTimeoutMs: 400,
  })
}

function home(gouziId: string): string {
  const path = join(root, gouziId)
  mkdirSync(path, { recursive: true })
  return path
}

function spawnedPids(gouziId: string): number[] {
  const file = join(root, gouziId, 'spawns.log')
  if (!existsSync(file)) return []
  const pids = readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0).map(Number)
  for (const pid of pids) spawned.add(pid)
  return pids
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dsh-gouzi-supervisor-')) })

afterEach(() => {
  vi.restoreAllMocks()
  for (const pid of spawned) {
    try { process.kill(pid, 'SIGKILL') } catch {
      // Already gone, which is what cleanup wants.
    }
  }
  spawned.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('a start that times out', () => {
  it('reports the failure only after the stubborn process is gone, so a retry cannot overlap it', async () => {
    home('a')
    const members = supervisor('silent')
    await expect(members.start('a')).rejects.toThrow(/was not ready after 600 ms/u)
    const [first] = spawnedPids('a')
    expect(first).toBeDefined()
    expect(alive(first!)).toBe(false)

    await expect(members.start('a')).rejects.toThrow(/was not ready/u)
    const pids = spawnedPids('a')
    expect(pids).toHaveLength(2)
    expect(pids.filter(alive)).toEqual([])
  }, 30_000)

  it('refuses to start another process while the old one cannot be stopped, and says why', async () => {
    home('a')
    const members = supervisor('silent')
    const kill = process.kill.bind(process)
    // Fault injection: the operating system accepts the signals but the process keeps running.
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return true
      return kill(pid, signal as number)
    }) as typeof process.kill)
    await expect(members.start('a')).rejects.toThrow(/did not exit and still holds its slot/u)
    vi.restoreAllMocks()
    // Still alive and still tracked: another start must not spawn a second process on top of it.
    const [first] = spawnedPids('a')
    expect(alive(first!)).toBe(true)
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return true
      return kill(pid, signal as number)
    }) as typeof process.kill)
    await expect(members.start('a')).rejects.toThrow(/still has a process/u)
    expect(spawnedPids('a')).toHaveLength(1)
  }, 30_000)

  it('counts a member that is still booting against the active limit', async () => {
    home('a')
    home('b')
    const members = supervisor('ready', { STAND_IN_DELAY_MS: '800' }, { activeLimit: 1, readyTimeoutMs: 5_000 })
    const booting = members.start('a')
    await new Promise(resolveWait => setTimeout(resolveWait, 200))
    await expect(members.start('b')).rejects.toBeInstanceOf(GouziActiveLimitError)
    expect(spawnedPids('b')).toEqual([])
    await booting
    await members.stop('a')
  }, 30_000)
})

describe('two starts of the same member', () => {
  it('share one process', async () => {
    home('a')
    const members = supervisor('ready', { STAND_IN_DELAY_MS: '300' }, { readyTimeoutMs: 5_000 })
    const [first, second] = await Promise.all([members.start('a'), members.start('a')])
    expect(first.pid).toBe(second.pid)
    expect(spawnedPids('a')).toHaveLength(1)
    await members.stop('a')
  }, 30_000)
})

describe('stopping a member', () => {
  it('escalates past an ignored SIGTERM and returns only after the process is gone', async () => {
    home('a')
    const members = supervisor('stubborn', {}, { readyTimeoutMs: 5_000 })
    const ready = await members.start('a')
    const outcome = await members.stop('a')
    expect(outcome).toEqual({ workerStopped: true, residentStopped: true })
    expect(alive(ready.pid)).toBe(false)
    expect(members.running('a')).toBeUndefined()
  }, 30_000)

  it('keeps the member visible as running when the process survives, so it is not reported stopped', async () => {
    home('a')
    const members = supervisor('stubborn', {}, { readyTimeoutMs: 5_000 })
    const ready = await members.start('a')
    const kill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 'SIGTERM' || signal === 'SIGKILL') return true
      return kill(pid, signal as number)
    }) as typeof process.kill)
    const outcome = await members.stop('a')
    expect(outcome.workerStopped).toBe(false)
    // The record is kept: a missing record would read as "stopped" to the caller.
    expect(members.running('a')?.pid).toBe(ready.pid)
    vi.restoreAllMocks()
    expect(await members.stop('a')).toMatchObject({ workerStopped: true })
  }, 30_000)

  it('does not report the process tree stopped to the retirement flow when an exit was not confirmed', async () => {
    const membersRoot = root
    home('a')
    const operations = new LocalGouziOperations({
      membersRoot, activeLimit: 2, readyTimeoutMs: 5_000, stopTimeoutMs: 400, gitTimeoutMs: 1_000, workerScript: STAND_IN, nodeArgs: [],
    })
    process.env.STAND_IN_MODE = 'stubborn'
    try {
      const started = await operations.start('a')
      const kill = process.kill.bind(process)
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') return true
        return kill(pid, signal as number)
      }) as typeof process.kill)
      expect(await operations.stop('a', { reclaimResident: true })).toEqual({ processTreeStopped: false })
      vi.restoreAllMocks()
      expect(await operations.stop('a', { reclaimResident: true })).toEqual({ processTreeStopped: true })
      expect(alive(started.pid)).toBe(false)
    } finally {
      delete process.env.STAND_IN_MODE
    }
  }, 30_000)
})
