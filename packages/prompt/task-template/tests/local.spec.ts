import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { taskTemplateId } from '../src/brand.ts'
import { FileTaskTemplateProvider, resolveStorePath } from '../src/local.ts'
import { TASK_TEMPLATE_STORE_FORMAT_VERSION, emptyStoreDocument, renderStoreDocument } from '../src/store.ts'

const cleanups: Array<() => Promise<void>> = []

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

describe('storage location', () => {
  it('defaults to task-templates.json under the configured DSH private-data root', async () => {
    const home = await tempDir()
    const ctx = await boot({ dshHome: home })
    const provider = ctx.get('taskTemplates') as FileTaskTemplateProvider
    expect(provider.documentPath).toBe(join(home, 'task-templates.json'))
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
