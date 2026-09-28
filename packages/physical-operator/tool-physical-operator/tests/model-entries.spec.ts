import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PhysicalOperatorId,
  type PhysicalOperatorResidentCatalog,
  type PhysicalOperatorResidentModel,
} from '@deepseek-ai/dsh-physical-operator'
import { LiveCatalogs, latestNativeModels, ModelEntries, NativeCatalogCache } from '../src/model-entries.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-native-catalogs-'))
  roots.push(root)
  return root
}

function model(id: string, displayName = id, extra: Partial<PhysicalOperatorResidentModel> = {}): PhysicalOperatorResidentModel {
  return {
    model: id,
    displayName,
    description: '',
    supportedEfforts: ['low', 'medium', 'high'],
    isDefault: false,
    supportsAdaptiveThinking: false,
    ...extra,
  }
}

function catalog(
  operatorId: string,
  models: readonly PhysicalOperatorResidentModel[],
  available = true,
): PhysicalOperatorResidentCatalog {
  return {
    operatorId: PhysicalOperatorId(operatorId),
    product: 'fixture',
    injectionBoundaries: ['pre-dispatch'],
    supportsModelToolBridge: true,
    location: 'local',
    supportsWorkspaceMutationReturn: true,
    available,
    authentication: 'native-subscription',
    productVersion: 'fixture',
    protocolHash: 'fixture',
    models,
  }
}

/** The Codex catalog order observed on 2026-09-26: strongest first per generation, proxied routes last. */
const codexToday = [
  model('gpt-6-astra', 'GPT-6-Astra', { isDefault: true, description: 'Frontier intelligence for the most demanding work.' }),
  model('gpt-6-sol', 'GPT-6-Sol'),
  model('gpt-6-luna', 'GPT-6-Luna'),
  model('gpt-5.6-sol', 'GPT-5.6-Sol'),
  model('gpt-5.6-terra', 'GPT-5.6-Terra'),
  model('gpt-5.5', 'GPT-5.5'),
  model('openrouter/claude-fable-5.1', 'Claude Fable 5.1 (OpenRouter)'),
]

describe('latestNativeModels', () => {
  it('takes the two strongest models of the newest generation in catalog order', () => {
    expect(latestNativeModels(codexToday, 2).map(entry => entry.model)).toEqual(['gpt-6-astra', 'gpt-6-sol'])
  })

  it('moves to a newer generation wherever the catalog lists it', () => {
    const upgraded = [...codexToday, model('gpt-7-nova'), model('gpt-7-sol')]
    expect(latestNativeModels(upgraded, 2).map(entry => entry.model)).toEqual(['gpt-7-nova', 'gpt-7-sol'])
  })

  it('fills a short newest generation from the next one and ranks dotted versions numerically', () => {
    const models = [model('gpt-5.10-sol'), model('gpt-5.9-sol'), model('gpt-6-astra')]
    expect(latestNativeModels(models, 3).map(entry => entry.model)).toEqual(['gpt-6-astra', 'gpt-5.10-sol', 'gpt-5.9-sol'])
  })

  it('ignores proxied routes and places unversioned models after versioned ones', () => {
    expect(latestNativeModels([model('openrouter/gpt-9'), model('default'), model('gpt-5.5')], 2).map(entry => entry.model))
      .toEqual(['gpt-5.5', 'default'])
    expect(latestNativeModels([model('openrouter/gpt-9')], 2)).toEqual([])
  })
})

describe('NativeCatalogCache', () => {
  it('keeps catalogs in memory without a state root', () => {
    const cache = new NativeCatalogCache(undefined, () => {})
    expect(cache.models('codex')).toEqual([])
    cache.replace([catalog('codex', codexToday)])
    expect(cache.models('codex')).toEqual(codexToday)
  })

  it('persists a refresh, restores it after a restart, and keeps an unavailable catalog from the last success', () => {
    const root = stateRoot()
    const first = new NativeCatalogCache(root, () => {})
    first.replace([catalog('codex', codexToday), catalog('claude-code', [model('opus')], false)])
    expect(first.models('claude-code')).toEqual([])

    const restarted = new NativeCatalogCache(root, () => {})
    expect(restarted.models('codex')).toEqual(codexToday)
    restarted.replace([catalog('codex', [model('gpt-7-nova')], false), catalog('claude-code', [model('opus')])])
    expect(restarted.models('codex')).toEqual(codexToday)
    expect(restarted.models('claude-code')).toEqual([model('opus')])
    expect(JSON.parse(readFileSync(join(root, 'native-catalogs.json'), 'utf8'))).toMatchObject({ version: 1 })
  })

  it('reads a missing, unparsable, or foreign cache file as no catalog', () => {
    const root = stateRoot()
    expect(new NativeCatalogCache(root, () => {}).models('codex')).toEqual([])
    writeFileSync(join(root, 'native-catalogs.json'), '{not json')
    expect(new NativeCatalogCache(root, () => {}).models('codex')).toEqual([])
    writeFileSync(join(root, 'native-catalogs.json'), JSON.stringify({ version: 2, catalogs: [] }))
    expect(new NativeCatalogCache(root, () => {}).models('codex')).toEqual([])
  })

  it('reports a failed write and keeps the refreshed catalog in memory', () => {
    const root = stateRoot()
    writeFileSync(join(root, 'blocker'), '')
    const warn = vi.fn()
    const cache = new NativeCatalogCache(join(root, 'blocker', 'state'), warn)
    cache.replace([catalog('codex', codexToday)])
    expect(cache.models('codex')).toEqual(codexToday)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('native catalogs were not persisted'))
  })
})

describe('ModelEntries', () => {
  const operators = [
    { id: 'codex', displayName: 'Codex' },
    { id: 'claude-code', displayName: 'Claude Code' },
    { id: 'chatgpt-web', displayName: 'ChatGPT Web' },
  ]

  function entries(config: ConstructorParameters<typeof ModelEntries>[0]): ModelEntries {
    const cache = new NativeCatalogCache(undefined, () => {})
    cache.replace([catalog('codex', codexToday), catalog('claude-code', [model('opus', 'Opus')])])
    return new ModelEntries(config, cache, ':')
  }

  it('offers every operator and native model by default', () => {
    expect(entries({}).rows(operators).map(row => row.id)).toEqual([
      'codex', ...codexToday.map(entry => `codex:${entry.model}`), 'claude-code', 'claude-code:opus', 'chatgpt-web',
    ])
  })

  it('offers the chosen operators and the newest Codex models, with the flagship on the bare entry', () => {
    const configured = entries({ entryOperatorIds: ['chatgpt-web'], latestModelEntries: [{ operatorId: 'codex', count: 2 }] })
    expect(configured.rows(operators)).toEqual([
      { id: 'codex', name: 'Codex · GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.' },
      { id: 'codex:gpt-6-sol', name: 'Codex · GPT-6-Sol' },
      { id: 'chatgpt-web', name: 'ChatGPT Web' },
    ])
    expect(configured.flagship('codex')?.model).toBe('gpt-6-astra')
    expect(configured.flagship('claude-code')).toBeUndefined()
    expect(configured.model('codex', 'gpt-5.6-sol')?.displayName).toBe('GPT-5.6-Sol')
  })

  it('offers only bare entries for listed operators when newest-model entries are configured', () => {
    expect(entries({ latestModelEntries: [] }).rows(operators).map(row => row.id)).toEqual(['codex', 'claude-code', 'chatgpt-web'])
  })

  it('keeps the bare flagship entry before any catalog is known', () => {
    const empty = new ModelEntries({ latestModelEntries: [{ operatorId: 'codex', count: 2 }] }, new NativeCatalogCache(undefined, () => {}), ':')
    expect(empty.rows([operators[0]!])).toEqual([{ id: 'codex', name: 'Codex' }])
    expect(empty.flagship('codex')).toBeUndefined()
  })
})

describe('LiveCatalogs', () => {
  it('reuses a read younger than the maximum age, shares one concurrent read, and adopts a recorded refresh', async () => {
    let clock = 1_000
    let reads = 0
    const seen: number[] = []
    const live = new LiveCatalogs(
      async () => {
        reads += 1
        return [catalog('codex', [model(`gpt-${String(reads)}`)])]
      },
      100,
      (catalogs) => { seen.push(catalogs.length) },
      () => clock,
    )

    const [first, concurrent] = await Promise.all([live.current(), live.current()])
    expect(reads).toBe(1)
    expect(concurrent).toBe(first)
    clock += 99
    expect(await live.current()).toBe(first)
    clock += 1
    expect((await live.current())[0]?.models[0]?.model).toBe('gpt-2')
    expect(seen).toEqual([1, 1])

    const refreshed = [catalog('codex', [model('gpt-9')])]
    live.record(refreshed)
    expect(await live.current()).toBe(refreshed)
    expect(reads).toBe(2)
  })

  function deferredReads() {
    const releases: ((catalogs: readonly PhysicalOperatorResidentCatalog[]) => void)[] = []
    const seen: string[] = []
    const live = new LiveCatalogs(
      () => new Promise((resolve) => { releases.push(resolve) }),
      0,
      (catalogs) => { seen.push(catalogs[0]?.models[0]?.model ?? '') },
    )
    return { live, releases, seen }
  }

  it('prefetches in the background and reports a failed read', async () => {
    const { live, releases, seen } = deferredReads()
    live.prefetch(() => {})
    expect(releases).toHaveLength(1)
    releases[0]!([catalog('codex', [model('gpt-7-nova')])])
    await vi.waitFor(() => { expect(seen).toEqual(['gpt-7-nova']) })

    const onError = vi.fn()
    new LiveCatalogs(() => Promise.reject(new Error('qualification failed')), 0, () => {}).prefetch(onError)
    await vi.waitFor(() => { expect(onError).toHaveBeenCalledWith(new Error('qualification failed')) })
  })

  it('discards a read overtaken by a newer recorded read or finished after close', async () => {
    const { live, releases, seen } = deferredReads()
    const overtaken = live.current()
    const newer = [catalog('codex', [model('gpt-7-nova')])]
    live.record(newer)
    releases[0]!([catalog('codex', [model('gpt-6-astra')])])
    expect(await overtaken).toBe(newer)

    const late = live.current()
    live.close()
    releases[1]!([catalog('codex', [model('gpt-8')])])
    expect((await late)[0]?.models[0]?.model).toBe('gpt-7-nova')
    expect(seen).toEqual([])

    const unread = deferredReads()
    const first = unread.live.current()
    unread.live.close()
    const catalogs = [catalog('codex', [model('gpt-6-sol')])]
    unread.releases[0]!(catalogs)
    expect(await first).toBe(catalogs)
    expect(unread.seen).toEqual([])
  })
})
