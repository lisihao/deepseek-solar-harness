import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { LocalContinualHarness } from '../src/index.ts'

describe('local Continuous Harness', () => {
  it('persists bounded workspace outcomes and returns immutable relevant snapshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-continual-harness-'))
    const ctx = new Context()
    const service = new LocalContinualHarness(ctx, root)
    const entry = await service.recordOutcome({
      runId: 'run-1', nodeId: 'worker', workspace: '/repo', scope: 'workspace',
      role: 'implementation', task: 'implement quota allocator', outcome: 'passed', evidenceRefs: ['sha256:result'],
    })
    const snapshot = await service.snapshot({
      workspace: '/repo', scope: 'workspace', role: 'implementation', task: 'review quota allocator', limit: 8,
    })
    expect(snapshot).toMatchObject({ generation: 1, scope: 'workspace' })
    expect(snapshot.entries).toEqual([entry])
    expect(await readFile(join(root, 'state.json'), 'utf8')).not.toContain('prompt')
    await ctx.root.fiber.dispose()
  })

  it('does not duplicate the same settled outcome after daemon recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-continual-harness-dedup-'))
    const ctx = new Context()
    const service = new LocalContinualHarness(ctx, root)
    const request = {
      runId: 'run-1', nodeId: 'verify', workspace: '/repo', scope: 'workspace' as const,
      role: 'verification', task: 'verify result', outcome: 'passed' as const, evidenceRefs: ['sha256:evidence'],
    }
    const first = await service.recordOutcome(request)
    const second = await service.recordOutcome(request)
    expect(second.entryId).toBe(first.entryId)
    expect((await service.snapshot({ workspace: '/repo', scope: 'workspace', role: 'verify', task: 'verify result', limit: 8 })).entries).toHaveLength(1)
    await ctx.root.fiber.dispose()
  })
})
