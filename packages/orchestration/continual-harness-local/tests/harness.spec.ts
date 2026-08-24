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

  it('provides versioned session-local and workspace-global CRUD without mutating base prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-continual-harness-crud-'))
    const ctx = new Context()
    const service = new LocalContinualHarness(ctx, root)
    const base = await service.create({
      workspace: '/repo', sessionId: 'session-1', kind: 'prompt', title: 'Base prompt',
      content: 'Immutable root instructions', provenance: 'fixture', immutableBase: true,
    })
    await expect(Promise.resolve().then(() => service.update({
      workspace: '/repo', sessionId: 'session-1', entryId: base.entryId, expectedEntryVersion: 1,
      content: 'silently replace base', provenance: 'fixture',
    }))).rejects.toMatchObject({ code: 'HARNESS_IMMUTABLE_BASE' })

    const memory = await service.create({
      workspace: '/repo', sessionId: 'session-1', kind: 'memory', title: 'Test convention',
      content: 'Use deterministic fixtures', tags: ['tests'], evidenceRefs: ['sha256:evidence'], provenance: 'turn-1',
    })
    expect(memory).toMatchObject({ version: 2, entryVersion: 1, scope: 'session', scopeId: 'session-1' })
    const updated = await service.update({
      workspace: '/repo', sessionId: 'session-1', entryId: memory.entryId, expectedEntryVersion: 1,
      content: 'Use deterministic offline fixtures', provenance: 'turn-2',
    })
    expect(updated).toMatchObject({ entryVersion: 2, content: 'Use deterministic offline fixtures' })
    const deleted = await service.delete({
      workspace: '/repo', sessionId: 'session-1', entryId: memory.entryId, expectedEntryVersion: 2, provenance: 'turn-3',
    })
    expect(deleted).toMatchObject({ entryVersion: 3 })
    expect(deleted.deletedAt).toBeDefined()
    expect(await service.list({ workspace: '/repo', sessionId: 'session-1' })).toEqual([base])
    expect(await service.list({ workspace: '/repo', sessionId: 'session-1', includeDeleted: true })).toHaveLength(2)

    const skill = await service.create({
      workspace: '/repo', scope: 'workspace', kind: 'skill', title: 'Focused verification',
      content: 'Run only the affected test', path: 'skills/focused.md',
      reference: { type: 'typescript', import: '@deepseek-ai/dsh-focused-verification', callable: 'verifyAffected' },
      arguments: { package: 'rlm-runtime' }, provenance: 'fixture',
    })
    expect(await service.list({ workspace: '/repo', scope: 'workspace' })).toEqual([skill])
    expect(await service.list({ workspace: '/repo', sessionId: 'session-1' })).not.toContainEqual(skill)
    await expect(service.snapshot({ workspace: '/repo', scope: 'workspace', role: 'verification', task: 'focused verification', limit: 8 }))
      .resolves.toMatchObject({ managedEntries: [{ entryId: skill.entryId, kind: 'skill' }] })
    await ctx.root.fiber.dispose()
  })

  it('plans without mutation, applies at a turn boundary, and rolls back as a new generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-continual-harness-refine-'))
    const ctx = new Context()
    const service = new LocalContinualHarness(ctx, root)
    const memory = await service.create({
      workspace: '/repo', sessionId: 'session-refine', kind: 'memory', title: 'Verification',
      content: 'Run all tests repeatedly', provenance: 'baseline',
    })
    const before = await service.snapshot({ workspace: '/repo', sessionId: 'session-refine', scope: 'session', role: 'test', task: 'refine', limit: 8 })
    const plan = await service.planRefinement({
      workspace: '/repo', sessionId: 'session-refine', trigger: 'turn failure',
      observation: 'Repeated full tests waste subscription quota', evidenceRefs: ['sha256:usage'],
      plannerId: 'fixture-planner', plannerVersion: '1.0.0',
      changes: [
        {
          operation: 'update',
          entry: {
            workspace: '/repo', sessionId: 'session-refine', entryId: memory.entryId, expectedEntryVersion: 1,
            content: 'Reuse unchanged evidence and run one affected test', provenance: 'refinement',
          },
        },
        {
          operation: 'create',
          entry: {
            workspace: '/repo', sessionId: 'session-refine', kind: 'subagent', title: 'Bounded verifier',
            content: 'Verify only the declared acceptance contract', provenance: 'refinement',
          },
        },
      ],
    })
    expect(plan).toMatchObject({ state: 'proposed', plannedGeneration: before.generation })
    expect((await service.get({ workspace: '/repo', sessionId: 'session-refine', entryId: memory.entryId })).content).toBe('Run all tests repeatedly')

    const queued = await service.queueRefinement({
      workspace: '/repo', sessionId: 'session-refine', refinementId: plan.refinementId,
      expectedGeneration: plan.plannedGeneration, boundary: 'before-next-turn',
    })
    expect(queued).toMatchObject({ state: 'queued', requestedBoundary: 'before-next-turn' })
    expect((await service.get({ workspace: '/repo', sessionId: 'session-refine', entryId: memory.entryId })).content).toBe('Run all tests repeatedly')
    const flushed = await service.flushRefinements({
      workspace: '/repo', sessionId: 'session-refine', scope: 'session', boundary: 'turn-end',
    })
    expect(flushed).toMatchObject([{ state: 'applied', requestedBoundary: 'before-next-turn' }])
    const applied = flushed[0]!.appliedPlan!
    expect(applied).toMatchObject({ state: 'applied' })
    expect(await service.listRefinements({
      workspace: '/repo', sessionId: 'session-refine', scope: 'session', limit: 1,
    })).toMatchObject([{ refinementId: plan.refinementId, state: 'applied' }])
    expect((await service.get({ workspace: '/repo', sessionId: 'session-refine', entryId: memory.entryId })).content).toBe('Reuse unchanged evidence and run one affected test')
    expect(await service.list({ workspace: '/repo', sessionId: 'session-refine', kind: 'subagent' })).toHaveLength(1)

    const rolledBack = await service.rollback({
      workspace: '/repo', sessionId: 'session-refine', refinementId: plan.refinementId,
      expectedGeneration: applied.appliedGeneration!,
    })
    expect(rolledBack.state).toBe('rolled-back')
    const restored = await service.get({ workspace: '/repo', sessionId: 'session-refine', entryId: memory.entryId })
    expect(restored).toMatchObject({ content: 'Run all tests repeatedly', entryVersion: 3 })
    expect(await service.list({ workspace: '/repo', sessionId: 'session-refine', kind: 'subagent' })).toEqual([])
    await ctx.root.fiber.dispose()
  })

  it('applies valid refinement edits independently and records rejected edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-continual-harness-partial-refine-'))
    const ctx = new Context()
    const service = new LocalContinualHarness(ctx, root)
    const memory = await service.create({
      workspace: '/repo', sessionId: 'session-partial', kind: 'memory', title: 'Verification',
      content: 'Run broad checks', provenance: 'baseline',
    })
    const plan = await service.planRefinement({
      workspace: '/repo', sessionId: 'session-partial', trigger: 'manual refine',
      observation: 'One valid edit must survive an unrelated conflict', evidenceRefs: [],
      plannerId: 'fixture-planner', plannerVersion: '1.0.0',
      changes: [
        {
          operation: 'update',
          entry: {
            workspace: '/repo', sessionId: 'session-partial', entryId: memory.entryId,
            expectedEntryVersion: 1, content: 'Run affected checks', provenance: 'refinement',
          },
        },
        {
          operation: 'update',
          entry: {
            workspace: '/repo', sessionId: 'session-partial', entryId: memory.entryId,
            expectedEntryVersion: 99, content: 'This edit conflicts', provenance: 'refinement',
          },
        },
      ],
    })
    await service.queueRefinement({
      workspace: '/repo', sessionId: 'session-partial', refinementId: plan.refinementId,
      expectedGeneration: plan.plannedGeneration, boundary: 'turn-end',
    })
    const [receipt] = await service.flushRefinements({
      workspace: '/repo', sessionId: 'session-partial', scope: 'session', boundary: 'turn-end',
    })
    expect(receipt).toMatchObject({
      state: 'applied',
      appliedPlan: {
        changeResults: [
          { changeIndex: 0, operation: 'update', entryId: memory.entryId, applied: true },
          { changeIndex: 1, operation: 'update', entryId: memory.entryId, applied: false },
        ],
      },
    })
    expect(receipt?.appliedPlan?.changeResults?.[1]?.error).toContain('version conflict')
    expect(await service.get({ workspace: '/repo', sessionId: 'session-partial', entryId: memory.entryId }))
      .toMatchObject({ content: 'Run affected checks', entryVersion: 2 })

    const rolledBack = await service.rollback({
      workspace: '/repo', sessionId: 'session-partial', refinementId: plan.refinementId,
      expectedGeneration: receipt!.appliedPlan!.appliedGeneration!,
    })
    expect(rolledBack.state).toBe('rolled-back')
    expect(await service.get({ workspace: '/repo', sessionId: 'session-partial', entryId: memory.entryId }))
      .toMatchObject({ content: 'Run broad checks', entryVersion: 3 })
    await ctx.root.fiber.dispose()
  })

  it('rolls back only successful creates using their planned entry ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-continual-harness-partial-create-'))
    const ctx = new Context()
    const service = new LocalContinualHarness(ctx, root)
    const plan = await service.planRefinement({
      workspace: '/repo', sessionId: 'session-partial-create', trigger: 'manual refine',
      observation: 'A valid create must survive an unrelated invalid skill', evidenceRefs: [],
      plannerId: 'fixture-planner', plannerVersion: '1.0.0',
      changes: [
        {
          operation: 'create',
          entry: {
            workspace: '/repo', sessionId: 'session-partial-create', kind: 'memory', title: 'Focused checks',
            content: 'Run the affected package tests', provenance: 'refinement',
          },
        },
        {
          operation: 'create',
          entry: {
            workspace: '/repo', sessionId: 'session-partial-create', kind: 'skill', title: 'Invalid skill',
            content: 'Missing the TypeScript argument contract', provenance: 'refinement',
          },
        },
      ],
    })
    const plannedIds = plan.changes.map(change => change.entry.entryId)
    expect(plannedIds).toHaveLength(2)
    expect(plannedIds.every(entryId => entryId?.startsWith('harness-'))).toBe(true)

    const applied = await service.applyRefinement({
      workspace: '/repo', sessionId: 'session-partial-create', refinementId: plan.refinementId,
      expectedGeneration: plan.plannedGeneration, boundary: 'turn-end',
    })
    expect(applied.changeResults).toMatchObject([
      { changeIndex: 0, operation: 'create', entryId: plannedIds[0], applied: true },
      { changeIndex: 1, operation: 'create', entryId: plannedIds[1], applied: false },
    ])
    expect(applied.changeResults?.[1]?.error).toContain('requires arguments')
    expect(await service.list({ workspace: '/repo', sessionId: 'session-partial-create' }))
      .toMatchObject([{ entryId: plannedIds[0], content: 'Run the affected package tests' }])
    await ctx.root.fiber.dispose()

    const recoveredCtx = new Context()
    const recoveredService = new LocalContinualHarness(recoveredCtx, root)
    await recoveredService.rollback({
      workspace: '/repo', sessionId: 'session-partial-create', refinementId: plan.refinementId,
      expectedGeneration: applied.appliedGeneration!,
    })
    expect(await recoveredService.list({ workspace: '/repo', sessionId: 'session-partial-create' })).toEqual([])
    const history = await recoveredService.list({ workspace: '/repo', sessionId: 'session-partial-create', includeDeleted: true })
    expect(history).toMatchObject([{ entryId: plannedIds[0] }])
    expect(history.some(entry => entry.entryId === plannedIds[1])).toBe(false)
    await recoveredCtx.root.fiber.dispose()
  })
})
