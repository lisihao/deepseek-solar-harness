import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { taskTemplateId } from '../src/brand.ts'
import type { TaskTemplateChangeKind, TaskTemplateId } from '../src/types.ts'
import type { TaskTemplateStoreDocument } from '../src/store.ts'
import { MemoryTaskTemplates } from './memory.ts'

const REVIEW = taskTemplateId('fixture-code-review')

class BlockingTaskTemplates extends MemoryTaskTemplates {
  private persistGate: Promise<void> | undefined
  private markStarted: (() => void) | undefined
  private staleDocument: TaskTemplateStoreDocument | undefined

  pauseNextPersist(staleDocument?: TaskTemplateStoreDocument): { started: Promise<void>; release: () => void } {
    let release = (): void => {}
    this.persistGate = new Promise((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { this.markStarted = resolve })
    this.staleDocument = staleDocument
    return { started, release }
  }

  refreshFrom(document: TaskTemplateStoreDocument): Promise<void> {
    return this.refresh(() => Promise.resolve(document))
  }

  protected override async persist(document: TaskTemplateStoreDocument): Promise<'committed' | 'stale'> {
    const gate = this.persistGate
    if (gate !== undefined) {
      this.persistGate = undefined
      this.markStarted?.()
      this.markStarted = undefined
      await gate
    }
    const staleDocument = this.staleDocument
    if (staleDocument !== undefined) {
      this.staleDocument = undefined
      this.doc = structuredClone(staleDocument)
      this.adoptWithinWrite(structuredClone(staleDocument))
      return 'stale'
    }
    return super.persist(document)
  }
}

async function boot(options?: ConstructorParameters<typeof MemoryTaskTemplates>[1]) {
  const ctx = new Context()
  const fiber = ctx.plugin(MemoryTaskTemplates, options)
  await fiber
  const provider = ctx.get('taskTemplates') as MemoryTaskTemplates
  const events: Array<[TaskTemplateId, TaskTemplateChangeKind, number]> = []
  ctx.on('task-template/updated', (id, kind, version) => {
    events.push([id, kind, version])
  })
  return { ctx, provider, fiber, events }
}

describe('create', () => {
  it('creates an enabled template at version 1 and emits create', async () => {
    const { provider, events } = await boot()
    const created = await provider.create({
      id: REVIEW,
      name: 'Fictional code review',
      match: { taskTypes: ['code-review'] },
      method: 'Fictional method: read the diff, list defects.',
    })
    expect(created.version).toBe(1)
    expect(created.enabled).toBe(true)
    expect(created.rank).toBe(0)
    expect(created.history).toEqual([])
    expect(provider.get(REVIEW)?.name).toBe('Fictional code review')
    expect(provider.list().map(entry => entry.id)).toEqual([REVIEW])
    expect(events).toEqual([[REVIEW, 'create', 1]])
    expect(provider.persisted).toHaveLength(1)
  })

  it('rejects a duplicate id before anything persists', async () => {
    const { provider } = await boot()
    await provider.create({ id: REVIEW, name: 'First', method: 'Fictional method.' })
    await expect(provider.create({ id: REVIEW, name: 'Second', method: 'Fictional method.' }))
      .rejects.toThrow(/already exists/)
    expect(provider.persisted).toHaveLength(1)
  })

  it('rejects blank names, blank methods, empty match lists, and non-finite ranks', async () => {
    const { provider } = await boot()
    await expect(provider.create({ id: REVIEW, name: '  ', method: 'Fictional method.' }))
      .rejects.toThrow(/name must be a non-blank string/)
    await expect(provider.create({ id: REVIEW, name: 'Fictional', method: '' }))
      .rejects.toThrow(/method must be a non-blank string/)
    await expect(provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.', match: { taskTypes: [] } }))
      .rejects.toThrow(/taskTypes must be a non-empty array/)
    await expect(provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.', rank: Number.NaN }))
      .rejects.toThrow(/rank must be a finite number/)
    await expect(provider.create({ id: REVIEW, name: 'Fictional', method: 'Use {{unknown}}.' }))
      .rejects.toThrow(/unsupported variable "unknown"/)
    await expect(provider.create({ id: REVIEW, name: 'Fictional', method: 'Use {{objective.' }))
      .rejects.toThrow(/unclosed/)
    expect(provider.persisted).toHaveLength(0)
  })

  it('rejects an id that does not match the brand pattern', () => {
    expect(() => taskTemplateId('Bad_ID')).toThrow(/must match/)
    expect(() => taskTemplateId('')).toThrow(/must match/)
  })
})

describe('update and versioning', () => {
  it('bumps the version, archives the previous revision, and keeps unpatched fields', async () => {
    const { provider, events } = await boot()
    await provider.create({
      id: REVIEW,
      name: 'Fictional code review',
      match: { taskTypes: ['code-review'] },
      method: 'Fictional method v1.',
    })
    const updated = await provider.update(REVIEW, { method: 'Fictional method v2.' })
    expect(updated.version).toBe(2)
    expect(updated.name).toBe('Fictional code review')
    expect(updated.match).toEqual({ taskTypes: ['code-review'] })
    expect(updated.method).toBe('Fictional method v2.')
    expect(updated.history).toHaveLength(1)
    expect(updated.history[0]).toMatchObject({ version: 1, method: 'Fictional method v1.' })
    expect(events.at(-1)).toEqual([REVIEW, 'update', 2])

    const versions = provider.versions(REVIEW)
    expect(versions.map(revision => revision.version)).toEqual([1, 2])
    expect(versions.at(-1)?.method).toBe('Fictional method v2.')
  })

  it('replaces every supplied method-layer field in one revision', async () => {
    const { provider } = await boot()
    await provider.create({ id: REVIEW, name: 'Old name', method: 'Old method.' })
    const updated = await provider.update(REVIEW, {
      name: 'New name',
      match: { domains: ['frontend'] },
      rank: 7,
    })
    expect(updated).toMatchObject({
      name: 'New name',
      match: { domains: ['frontend'] },
      method: 'Old method.',
      rank: 7,
    })
  })

  it('rejects an empty patch and an unknown template', async () => {
    const { provider } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.' })
    await expect(provider.update(REVIEW, {})).rejects.toThrow(/at least one field/)
    await expect(provider.update(taskTemplateId('fixture-missing'), { name: 'X' }))
      .rejects.toThrow(/does not exist/)
    await expect(provider.update(REVIEW, { method: 'Use }} without opening.' }))
      .rejects.toThrow(/unmatched/)
  })

  it('hands out frozen committed records', async () => {
    const { provider } = await boot()
    const created = await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.' })
    expect(Object.isFrozen(created)).toBe(true)
    expect(Object.isFrozen(created.match)).toBe(true)
  })
})

describe('enable and disable', () => {
  it('toggles activation without bumping the version and skips no-change calls', async () => {
    const { provider, events } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.' })
    await provider.setEnabled(REVIEW, false)
    expect(provider.get(REVIEW)?.enabled).toBe(false)
    expect(provider.get(REVIEW)?.version).toBe(1)
    expect(events.at(-1)).toEqual([REVIEW, 'disable', 1])
    const persistedBefore = provider.persisted.length

    await provider.setEnabled(REVIEW, false)
    expect(provider.persisted).toHaveLength(persistedBefore)
    expect(events).toHaveLength(2)

    await provider.setEnabled(REVIEW, true)
    expect(events.at(-1)).toEqual([REVIEW, 'enable', 1])
  })
})

describe('personalization layer', () => {
  it('stores preference/memory content separately without bumping the method version', async () => {
    const { provider, events } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method v1.' })
    await provider.personalize(REVIEW, { preferences: 'Fictional preference: concise findings.' })
    expect(provider.get(REVIEW)?.version).toBe(1)
    expect(provider.personalization(REVIEW)).toEqual({ preferences: 'Fictional preference: concise findings.' })
    expect(events.at(-1)).toEqual([REVIEW, 'personalize', 1])
  })

  it('survives method-layer edits and clears explicitly', async () => {
    const { provider } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method v1.' })
    await provider.personalize(REVIEW, { memory: 'Fictional memory: prior fixture run.' })
    await provider.update(REVIEW, { method: 'Fictional method v2.' })
    expect(provider.personalization(REVIEW)).toEqual({ memory: 'Fictional memory: prior fixture run.' })

    await provider.personalize(REVIEW)
    expect(provider.personalization(REVIEW)).toBeUndefined()
  })

  it('rejects empty layers, blank content, and unknown templates', async () => {
    const { provider } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.' })
    await expect(provider.personalize(REVIEW, {})).rejects.toThrow(/at least one of/)
    await expect(provider.personalize(REVIEW, { preferences: ' ' }))
      .rejects.toThrow(/preferences must be a non-blank string/)
    await expect(provider.personalize(taskTemplateId('fixture-missing'), { memory: 'x' }))
      .rejects.toThrow(/does not exist/)
  })

  it('clearing an absent layer neither persists nor emits', async () => {
    const { provider, events } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.' })
    const persistedBefore = provider.persisted.length
    const eventsBefore = events.length
    await provider.personalize(REVIEW)
    expect(provider.persisted).toHaveLength(persistedBefore)
    expect(events).toHaveLength(eventsBefore)
  })
})

describe('delete', () => {
  it('removes the template and its personal layer and emits delete', async () => {
    const { provider, events } = await boot()
    await provider.create({ id: REVIEW, name: 'Fictional', method: 'Fictional method.' })
    await provider.personalize(REVIEW, { preferences: 'Fictional preference.' })
    await provider.delete(REVIEW)
    expect(provider.get(REVIEW)).toBeUndefined()
    expect(provider.list()).toEqual([])
    expect(events.at(-1)).toEqual([REVIEW, 'delete', 1])
    expect(provider.persisted.at(-1)?.personalization).toEqual({})
    expect(() => provider.versions(REVIEW)).toThrow(/does not exist/)
    await expect(provider.delete(REVIEW)).rejects.toThrow(/does not exist/)
  })
})

describe('disposal', () => {
  it('drains the active write, rejects queued and later writes, and ignores a later refresh', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(BlockingTaskTemplates)
    await fiber
    const provider = ctx.get('taskTemplates') as BlockingTaskTemplates
    const gate = provider.pauseNextPersist(emptyDocument())
    const first = provider.create({
      id: REVIEW,
      name: 'Fictional active write',
      method: 'Fictional method.',
    })
    await gate.started
    const queued = provider.create({
      id: taskTemplateId('fixture-queued'),
      name: 'Fictional queued write',
      method: 'Fictional method.',
    })
    const queuedAssertion = expect(queued).rejects.toThrow(/disposed before the queued write ran/)
    const disposed = fiber.dispose()
    await new Promise(resolve => setImmediate(resolve))
    gate.release()

    await expect(first).resolves.toMatchObject({ id: REVIEW })
    await queuedAssertion
    await disposed
    await expect(provider.create({
      id: taskTemplateId('fixture-late'),
      name: 'Fictional late write',
      method: 'Fictional method.',
    })).rejects.toThrow(/service is disposed/)
    await expect(provider.refreshFrom(emptyDocument())).resolves.toBeUndefined()
  })
})

function emptyDocument(): TaskTemplateStoreDocument {
  return { formatVersion: 1, templates: [], personalization: {} }
}
