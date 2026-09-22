import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { taskTemplateId } from '../src/brand.ts'
import { FileTaskTemplateProvider, resolveStorePath } from '../src/local.ts'
import {
  TASK_TEMPLATE_STORE_FORMAT_VERSION,
  emptyStoreDocument,
  parseStoreDocument,
  renderStoreDocument,
} from '../src/store.ts'
import type { TaskTemplateStoreDocument } from '../src/store.ts'

const cleanups: Array<() => Promise<void>> = []
const PROCESS_WRITER = fileURLToPath(new URL('./fixtures/process-writer.ts', import.meta.url))
const ROOT_TSCONFIG = resolve(fileURLToPath(new URL('../../../..', import.meta.url)), 'tsconfig.base.json')

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-task-template-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

async function boot(config: ConstructorParameters<typeof FileTaskTemplateProvider>[1]): Promise<Context> {
  const ctx = new Context()
  const fiber = ctx.plugin(FileTaskTemplateProvider, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

class StaleOnceFileTemplates extends FileTaskTemplateProvider {
  private rivalText: string | undefined

  injectBeforeNextPersist(text: string): void {
    this.rivalText = text
  }

  protected override async persist(document: TaskTemplateStoreDocument): Promise<'committed' | 'stale'> {
    const rivalText = this.rivalText
    if (rivalText !== undefined) {
      this.rivalText = undefined
      await writeFileAtomic(this.documentPath, rivalText, { mode: 0o600, dirMode: 0o700 })
    }
    return super.persist(document)
  }
}

async function bootStale(config: ConstructorParameters<typeof FileTaskTemplateProvider>[1]): Promise<StaleOnceFileTemplates> {
  const ctx = new Context()
  const fiber = ctx.plugin(StaleOnceFileTemplates, config)
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx.get('taskTemplates') as StaleOnceFileTemplates
}

describe('storage location', () => {
  it('defaults to task-templates.json under the configured DSH private-data root', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    expect(provider.documentPath).toBe(join(home, 'task-templates.json'))
  })

  it('resolves constructor defaults for a directly composed Provider', async () => {
    const home = await tempDir()
    const ctx = new Context()
    const provider = new FileTaskTemplateProvider(ctx, { dshHome: home })
    expect(provider.documentPath).toBe(join(home, 'task-templates.json'))
    await ctx.fiber.dispose()
  })

  it('prefers an explicit path over the DSH home', async () => {
    const dir = await tempDir()
    const path = join(dir, 'fixture-store.json')
    const ctx = await boot({ path, dshHome: join(dir, 'unused-home') })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    expect(provider.documentPath).toBe(path)
  })

  it('fails loud on an unsupported extension and on blank configuration', async () => {
    const dir = await tempDir()
    await expect(boot({ path: join(dir, 'store.yaml') })).rejects.toThrow(/not supported/)
    await expect(boot({ path: '  ' })).rejects.toThrow(/"path" must be non-blank/)
    await expect(boot({ dshHome: '' })).rejects.toThrow(/"dshHome" must be non-blank/)
    await expect(boot({ path: join(dir, 'store.json'), pollIntervalMs: 0 })).rejects.toThrow()
    expect(() => resolveStorePath({ path: 'store.toml' })).toThrow(/not supported/)
  })
})

describe('persistence round trip', () => {
  it('boots empty on an absent store and persists lifecycle changes as owner-only JSON', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    expect(provider.list()).toEqual([])

    await provider.create({
      id: taskTemplateId('fixture-analysis'),
      name: 'Fictional analysis template',
      match: { domains: ['fixture-domain'], languages: ['zh'] },
      method: 'Fictional method: outline, quantify, conclude.',
    })
    await provider.personalize(taskTemplateId('fixture-analysis'), { preferences: 'Fictional preference.' })

    const written = JSON.parse(await readFile(join(home, 'task-templates.json'), 'utf8')) as Record<string, unknown>
    expect(written['formatVersion']).toBe(TASK_TEMPLATE_STORE_FORMAT_VERSION)
    expect((written['templates'] as unknown[]).length).toBe(1)

    const reloaded = await boot({ dshHome: home })
    const second = reloaded.get('taskTemplates') as FileTaskTemplateProvider
    expect(second.get(taskTemplateId('fixture-analysis'))?.method)
      .toBe('Fictional method: outline, quantify, conclude.')
    expect(second.personalization(taskTemplateId('fixture-analysis')))
      .toEqual({ preferences: 'Fictional preference.' })
  })
})

describe('disk trust boundary', () => {
  it('surfaces a non-absence filesystem error at boot', async () => {
    const home = await tempDir()
    const occupied = join(home, 'occupied.json')
    await mkdir(occupied)
    await expect(boot({ path: occupied })).rejects.toThrow()
  })

  it('fails loud at boot on unparsable JSON', async () => {
    const home = await tempDir()
    await writeFile(join(home, 'task-templates.json'), '{ not json', 'utf8')
    await expect(boot({ dshHome: home })).rejects.toThrow(/not valid JSON/)
  })

  it('fails loud at boot on an unsupported format version', async () => {
    const home = await tempDir()
    await writeFile(
      join(home, 'task-templates.json'),
      JSON.stringify({ formatVersion: 99, templates: [], personalization: {} }),
      'utf8',
    )
    await expect(boot({ dshHome: home })).rejects.toThrow(/unsupported formatVersion 99/)
  })

  it('fails loud at boot on structurally corrupt records', async () => {
    const home = await tempDir()
    const corrupt = {
      formatVersion: 1,
      templates: [{
        id: 'fixture-broken',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 0,
        name: 'Fictional broken template',
        rank: 0,
        match: {},
        method: 'Fictional method.',
        updatedAt: '2026-01-01T00:00:00.000Z',
        history: [],
      }],
      personalization: {},
    }
    await writeFile(join(home, 'task-templates.json'), JSON.stringify(corrupt), 'utf8')
    await expect(boot({ dshHome: home })).rejects.toThrow(/version must be a positive integer/)
  })

  it('fails loud at boot on a stored method with unsupported template syntax', async () => {
    const home = await tempDir()
    const corrupt = {
      formatVersion: 1,
      templates: [{
        id: 'fixture-broken-method',
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 1,
        name: 'Fictional broken method',
        rank: 0,
        match: {},
        method: 'Use {{executableExpression}}.',
        updatedAt: '2026-01-01T00:00:00.000Z',
        history: [],
      }],
      personalization: {},
    }
    await writeFile(join(home, 'task-templates.json'), JSON.stringify(corrupt), 'utf8')
    await expect(boot({ dshHome: home })).rejects.toThrow(/unsupported variable "executableExpression"/)
  })

  it('fails loud at boot on a personalization entry naming an unknown template', async () => {
    const home = await tempDir()
    const document = emptyStoreDocument()
    document.personalization = { 'fixture-ghost': { preferences: 'Fictional preference.' } }
    await writeFile(join(home, 'task-templates.json'), renderStoreDocument(document), 'utf8')
    await expect(boot({ dshHome: home })).rejects.toThrow(/names an unknown template/)
  })

  it('fails loud at boot on an unsupported root key', async () => {
    const home = await tempDir()
    await writeFile(
      join(home, 'task-templates.json'),
      JSON.stringify({ formatVersion: 1, templates: [], personalization: {}, extras: true }),
      'utf8',
    )
    await expect(boot({ dshHome: home })).rejects.toThrow(/unsupported key "extras"/)
  })
})

describe('cross-process refresh', () => {
  it('stops an in-flight poll without scheduling another one during disposal', async () => {
    vi.useFakeTimers()
    const home = await tempDir()
    const ctx = new Context()
    const fiber = ctx.plugin(FileTaskTemplateProvider, { dshHome: home, pollIntervalMs: 20 })
    let disposed = false
    try {
      await fiber
      vi.advanceTimersByTime(20)
      await fiber.dispose()
      disposed = true
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      if (!disposed) await fiber.dispose()
      vi.useRealTimers()
    }
  })

  it('hot-publishes a sibling process\'s write to an already-running provider holding the same document', async () => {
    const home = await tempDir()
    const reader = await boot({ dshHome: home, pollIntervalMs: 20 })
    const readerProvider = reader.get('taskTemplates') as FileTaskTemplateProvider
    await readerProvider.create({
      id: taskTemplateId('fixture-shared'),
      name: 'Fictional shared template',
      method: 'Fictional method v1.',
    })
    const events: Array<[string, string]> = []
    reader.on('task-template/updated', (id, kind) => { events.push([id, kind]) })
    expect(readerProvider.get(taskTemplateId('fixture-shared'))?.method).toBe('Fictional method v1.')

    const stdout = execFileSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), PROCESS_WRITER, home, 'fixture-shared', 'Fictional method v2.',
    ], {
      encoding: 'utf8',
      env: { ...process.env, TSX_TSCONFIG_PATH: ROOT_TSCONFIG },
      timeout: 10_000,
    })
    const child = JSON.parse(stdout) as { pid: number; version: number }
    expect(child.version).toBe(2)
    expect(child.pid).not.toBe(process.pid)

    await vi.waitFor(() => {
      expect(readerProvider.get(taskTemplateId('fixture-shared'))?.method).toBe('Fictional method v2.')
    })
    expect(events).toContainEqual([taskTemplateId('fixture-shared'), 'update'])
    expect((await stat(join(home, 'task-templates.json'))).mode & 0o777).toBe(0o600)
  })

  it('logs a corrupt external replacement, keeps watching, and adopts the next valid replacement', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home, pollIntervalMs: 10 })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    await provider.create({
      id: taskTemplateId('fixture-recovery'),
      name: 'Fictional recovery template',
      method: 'Fictional method v1.',
    })
    const path = join(home, 'task-templates.json')
    const logger = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await writeFileAtomic(path, '{ invalid', { mode: 0o600, dirMode: 0o700 })
    await vi.waitFor(() => {
      expect(logger).toHaveBeenCalledWith('task-template: reload commit failed at %s', path)
    })

    const next = parseStoreDocument(renderStoreDocument({
      formatVersion: 1,
      templates: [{
        id: taskTemplateId('fixture-recovery'),
        enabled: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        version: 2,
        name: 'Fictional recovery template',
        rank: 0,
        match: {},
        method: 'Fictional method v2.',
        updatedAt: '2026-01-01T00:00:01.000Z',
        history: [{
          version: 1,
          name: 'Fictional recovery template',
          rank: 0,
          match: {},
          method: 'Fictional method v1.',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
      }],
      personalization: {},
    }), path)
    await writeFileAtomic(path, renderStoreDocument(next), { mode: 0o600, dirMode: 0o700 })
    await vi.waitFor(() => {
      expect(provider.get(taskTemplateId('fixture-recovery'))?.method).toBe('Fictional method v2.')
    })
  })

  it('surfaces an external read error without dropping the watcher', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home, pollIntervalMs: 10 })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    await provider.create({
      id: taskTemplateId('fixture-read-error'),
      name: 'Fictional read-error template',
      method: 'Fictional method.',
    })
    const path = join(home, 'task-templates.json')
    const backup = join(home, 'task-templates.backup')
    const logger = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
    await rename(path, backup)
    await mkdir(path)
    await vi.waitFor(() => {
      expect(logger).toHaveBeenCalledWith('task-template: reload commit failed at %s', path)
    })
  })

  it('hot-publishes external deletion as an empty document', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home, pollIntervalMs: 10 })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    await provider.create({
      id: taskTemplateId('fixture-deleted'),
      name: 'Fictional deleted template',
      method: 'Fictional method.',
    })
    const events: string[] = []
    ctx.on('task-template/updated', (_id, kind) => { events.push(kind) })
    await rm(join(home, 'task-templates.json'))
    await vi.waitFor(() => {
      expect(provider.list()).toEqual([])
    })
    expect(events).toContain('delete')
  })

  it('retries when the locked persist sees a newer document than its preceding reconcile', async () => {
    const home = await tempDir()
    const provider = await bootStale({ dshHome: home, watch: false })
    await provider.create({
      id: taskTemplateId('fixture-race-primary'),
      name: 'Fictional race primary',
      method: 'Fictional method v1.',
    })
    const path = join(home, 'task-templates.json')
    const rival = parseStoreDocument(await readFile(path, 'utf8'), path)
    rival.templates.push({
      id: taskTemplateId('fixture-race-rival'),
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      version: 1,
      name: 'Fictional race rival',
      rank: 0,
      match: {},
      method: 'Fictional rival method.',
      updatedAt: '2026-01-01T00:00:00.000Z',
      history: [],
    })
    provider.injectBeforeNextPersist(renderStoreDocument(rival))

    await provider.update(taskTemplateId('fixture-race-primary'), { method: 'Fictional method v2.' })

    expect(provider.get(taskTemplateId('fixture-race-primary'))?.method).toBe('Fictional method v2.')
    expect(provider.get(taskTemplateId('fixture-race-rival'))?.name).toBe('Fictional race rival')
  })

  it('never resurrects a document an external edit already replaced: a write folds in the concurrent change first', async () => {
    const home = await tempDir()
    const first = await boot({ dshHome: home, watch: false })
    const firstProvider = first.get('taskTemplates') as FileTaskTemplateProvider
    await firstProvider.create({
      id: taskTemplateId('fixture-race-a'),
      name: 'Fictional race template A',
      method: 'Fictional method A.',
    })

    // A second Provider instance stands in for an external writer while the
    // first provider has not yet observed its change.
    const second = await boot({ dshHome: home, watch: false })
    const secondProvider = second.get('taskTemplates') as FileTaskTemplateProvider
    await secondProvider.create({
      id: taskTemplateId('fixture-race-b'),
      name: 'Fictional race template B',
      method: 'Fictional method B.',
    })

    // The first provider's next write reconciles against the current on-disk
    // document before it derives its patch, so template B survives even
    // though the first provider never watched for it.
    await firstProvider.personalize(taskTemplateId('fixture-race-a'), { preferences: 'Fictional preference.' })

    const documentPath = join(home, 'task-templates.json')
    const onDisk = JSON.parse(await readFile(documentPath, 'utf8')) as { templates: Array<{ id: string }> }
    expect(onDisk.templates.map(template => template.id).sort()).toEqual(['fixture-race-a', 'fixture-race-b'])
    expect(firstProvider.get(taskTemplateId('fixture-race-b'))?.name).toBe('Fictional race template B')
  })

  it('disables the watcher and never hot-publishes an external edit when configured off', async () => {
    const home = await tempDir()
    const writer = await boot({ dshHome: home, watch: false })
    const writerProvider = writer.get('taskTemplates') as FileTaskTemplateProvider
    await writerProvider.create({
      id: taskTemplateId('fixture-unwatched'),
      name: 'Fictional unwatched template',
      method: 'Fictional method v1.',
    })

    const reader = await boot({ dshHome: home, watch: false, pollIntervalMs: 20 })
    const readerProvider = reader.get('taskTemplates') as FileTaskTemplateProvider
    await writerProvider.update(taskTemplateId('fixture-unwatched'), { method: 'Fictional method v2.' })

    await new Promise(resolve => setTimeout(resolve, 60))
    expect(readerProvider.get(taskTemplateId('fixture-unwatched'))?.method).toBe('Fictional method v1.')
  })
})
