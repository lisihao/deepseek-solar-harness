import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DurableAutoRefineCoordinator, type AutoRefineExecutor } from '../src/auto-refine.ts'

const settings = { enabled: true, turnInterval: 2, compact: true, cooldownMs: 1_200_000 } as const

function statePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-auto-refine-')), 'state.json')
}

function executor(review = { shouldRefine: true, rationale: 'durable lesson' }): AutoRefineExecutor<{ change: string }, { generation: number }> {
  return {
    review: vi.fn(async () => review),
    plan: vi.fn(async () => ({ change: 'retain successful evidence' })),
    apply: vi.fn(async () => ({ generation: 2 })),
  }
}

describe('DurableAutoRefineCoordinator', () => {
  const branchVersion = 'plan-sha:7'

  it('reviews only a root session after the Prime turn interval and applies at that boundary', async () => {
    const coordinator = new DurableAutoRefineCoordinator(statePath(), settings)
    const runtime = executor()
    expect(await coordinator.boundary({ sessionId: 'child', branchVersion, reason: 'turn_interval', occurredAt: '2026-08-24T00:00:00.000Z', isRoot: false }, runtime)).toEqual({ state: 'child' })
    expect(await coordinator.boundary({ sessionId: 'root', branchVersion, reason: 'turn_interval', occurredAt: '2026-08-24T00:00:00.000Z', isRoot: true }, runtime)).toEqual({ state: 'not-due' })
    const result = await coordinator.boundary({ sessionId: 'root', branchVersion, reason: 'turn_interval', occurredAt: '2026-08-24T00:01:00.000Z', isRoot: true }, runtime)
    expect(result.state).toBe('applied')
    expect(vi.mocked(runtime.review)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runtime.plan)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runtime.apply)).toHaveBeenCalledTimes(1)
  })

  it('uses compact as an independent trigger and obeys persisted cooldown', async () => {
    const path = statePath()
    const first = new DurableAutoRefineCoordinator(path, settings)
    const runtime = executor({ shouldRefine: false, rationale: 'nothing durable' })
    expect((await first.boundary({ sessionId: 'root', branchVersion, reason: 'compact', occurredAt: '2026-08-24T00:00:00.000Z', isRoot: true }, runtime)).state).toBe('reviewed')
    const recovered = new DurableAutoRefineCoordinator(path, settings)
    expect(await recovered.boundary({ sessionId: 'root', branchVersion, reason: 'compact', occurredAt: '2026-08-24T00:05:00.000Z', isRoot: true }, runtime)).toEqual({ state: 'cooldown' })
  })

  it('persists one stable native compaction command until it is settled', () => {
    const path = statePath()
    const coordinator = new DurableAutoRefineCoordinator(path, settings)
    const scheduled = coordinator.markCompact('root', 'retain the TypeScript namespace')
    expect(coordinator.markCompact('root', 'a duplicate request')).toEqual(scheduled)
    expect(scheduled).toMatchObject({ state: 'scheduled', instructions: 'retain the TypeScript namespace' })
    coordinator.markCompactRunning('root', scheduled.commandId, 'resident-root', 7)
    expect(coordinator.inspect('root').pendingCompactExecution).toMatchObject({
      commandId: scheduled.commandId,
      state: 'running',
      residentSessionId: 'resident-root',
      expectedStateRevision: 7,
    })
    const recovered = new DurableAutoRefineCoordinator(path, settings)
    expect(recovered.inspect('root').pendingCompactExecution).toMatchObject({
      commandId: scheduled.commandId,
      state: 'running',
    })
    recovered.markCompactPerformed('root', scheduled.commandId)
    expect(recovered.inspect('root')).toMatchObject({ pendingCompact: true })
    expect(recovered.inspect('root').pendingCompactExecution).toBeUndefined()
  })

  it('stamps cooldown after failure and does not create a retry loop', async () => {
    const coordinator = new DurableAutoRefineCoordinator(statePath(), { ...settings, turnInterval: 1 })
    const runtime = executor()
    vi.mocked(runtime.review).mockRejectedValueOnce(new Error('model unavailable'))
    const failed = await coordinator.boundary({ sessionId: 'root', branchVersion, reason: 'turn_interval', occurredAt: '2026-08-24T00:00:00.000Z', isRoot: true }, runtime)
    expect(failed).toMatchObject({ state: 'failed', phase: 'review', error: 'model unavailable' })
    expect(await coordinator.boundary({ sessionId: 'root', branchVersion, reason: 'turn_interval', occurredAt: '2026-08-24T00:01:00.000Z', isRoot: true }, runtime)).toEqual({ state: 'cooldown' })
    expect(vi.mocked(runtime.review)).toHaveBeenCalledTimes(1)
  })

  it('fences a crash-uncertain external phase instead of replaying it after restart', async () => {
    const path = statePath()
    writeFileSync(path, JSON.stringify({
      version: 1,
      sessions: {
        root: {
          assistantTurnsSinceReview: 25,
          pendingCompact: false,
          inFlight: { roundId: 'round-crashed', phase: 'plan', startedAt: '2026-08-24T00:00:00.000Z', branchVersion },
        },
      },
    }))
    const recovered = new DurableAutoRefineCoordinator(path, { ...settings, turnInterval: 1 })
    const runtime = executor()
    expect(await recovered.boundary({ sessionId: 'root', branchVersion, reason: 'turn_interval', occurredAt: '2026-08-24T00:01:00.000Z', isRoot: true }, runtime)).toEqual({
      state: 'indeterminate', roundId: 'round-crashed', phase: 'plan', startedAt: '2026-08-24T00:00:00.000Z', branchVersion,
    })
    expect(vi.mocked(runtime.review)).not.toHaveBeenCalled()
  })
})
