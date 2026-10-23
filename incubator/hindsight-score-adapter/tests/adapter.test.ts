import {describe, expect, it, vi} from 'vitest'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {dirname, join} from 'node:path'
import {parse} from 'yaml'
import type {MemoryProviderAdapter} from 'dsh-mnemon-source-memory-spaces/provider-sdk'

import {createNativeScoreAdapter, definition} from '../src/provider.js'

const body = {
  id: 'space-hindsight',
  name: 'Synthetic Hindsight space',
  description: 'Synthetic test data only',
  provider: {id: 'hindsight'},
} as never

const connection = {bankId: 'synthetic-bank', budget: 'mid'}
const searchRequest = {query: 'synthetic query', limit: 2} as never
const listRequest = {limit: 2} as never
const rememberRequest = {content: 'Synthetic memory'} as never
const signal = new AbortController().signal

function createOriginalAdapter() {
  const highScore = {
    id: 'memory-high',
    content: 'Synthetic high-score memory',
    score: 1.37,
  }
  const lowScore = {
    id: 'memory-low',
    content: 'Synthetic low-score memory',
    score: 0.08,
  }
  const results = {results: [highScore, lowScore], hint: 'synthetic'}
  const discovery = [{
    externalId: 'synthetic-bank',
    name: 'Synthetic bank',
    description: 'Synthetic discovery result',
    connection,
  }]
  const status = {healthy: true}
  const graph = {nodes: [], edges: [], generatedAt: '2026-01-01T00:00:00.000Z'}
  const list = [highScore, lowScore]
  const related = [lowScore]
  const remember = {action: 'queued', provider: 'hindsight'}
  const forget = {action: 'invalidated', provider: 'hindsight', id: lowScore.id}

  const methods = {
    discover: vi.fn(async () => discovery),
    status: vi.fn(async () => status),
    search: vi.fn(async () => results),
    graph: vi.fn(async () => graph),
    list: vi.fn(async () => list),
    related: vi.fn(async () => related),
    remember: vi.fn(async () => remember),
    forget: vi.fn(async () => forget),
  }
  const scoreSemantics = {kind: 'normalized-relevance' as const}
  const original = {
    id: 'hindsight',
    scoreSemantics,
    ...methods,
  } as unknown as MemoryProviderAdapter

  return {
    original,
    methods,
    scoreSemantics,
    values: {discovery, status, results, graph, list, related, remember, forget, highScore, lowScore},
  }
}

describe('Hindsight native score adapter', () => {
  it('delegates every read/write operation unchanged, including scores, order, and cancellation', async () => {
    const fixture = createOriginalAdapter()
    const adapter = createNativeScoreAdapter(fixture.original)

    await expect(adapter.discover?.(connection, signal)).resolves.toBe(fixture.values.discovery)
    await expect(adapter.status(body, signal)).resolves.toBe(fixture.values.status)
    await expect(adapter.search(body, searchRequest, signal)).resolves.toBe(fixture.values.results)
    await expect(adapter.graph(body, signal)).resolves.toBe(fixture.values.graph)
    await expect(adapter.list(body, listRequest, signal)).resolves.toBe(fixture.values.list)
    await expect(adapter.related?.(body, 'memory-high', 2, 'semantic', signal)).resolves.toBe(fixture.values.related)
    await expect(adapter.remember(body, rememberRequest, signal)).resolves.toBe(fixture.values.remember)
    await expect(adapter.forget?.(body, 'memory-low', signal)).resolves.toBe(fixture.values.forget)

    expect(fixture.methods.discover).toHaveBeenCalledWith(connection, signal)
    expect(fixture.methods.status).toHaveBeenCalledWith(body, signal)
    expect(fixture.methods.search).toHaveBeenCalledWith(body, searchRequest, signal)
    expect(fixture.methods.graph).toHaveBeenCalledWith(body, signal)
    expect(fixture.methods.list).toHaveBeenCalledWith(body, listRequest, signal)
    expect(fixture.methods.related).toHaveBeenCalledWith(body, 'memory-high', 2, 'semantic', signal)
    expect(fixture.methods.remember).toHaveBeenCalledWith(body, rememberRequest, signal)
    expect(fixture.methods.forget).toHaveBeenCalledWith(body, 'memory-low', signal)

    expect(fixture.values.results.results).toEqual([
      fixture.values.highScore,
      fixture.values.lowScore,
    ])
    expect(fixture.values.results.results[0]?.score).toBe(1.37)
    expect(fixture.values.results.results[1]?.score).toBe(0.08)
  })

  it('omits score semantics and leaves the original adapter object untouched', () => {
    const fixture = createOriginalAdapter()
    const originalMethods = {...fixture.methods}
    const adapter = createNativeScoreAdapter(fixture.original)

    expect(adapter).not.toBe(fixture.original)
    expect(Object.prototype.hasOwnProperty.call(adapter, 'scoreSemantics')).toBe(false)
    expect(adapter).not.toHaveProperty('scoreSemantics')
    expect(fixture.original.scoreSemantics).toBe(fixture.scoreSemantics)
    expect(fixture.original.status).toBe(originalMethods.status)
    expect(fixture.original.search).toBe(originalMethods.search)
    expect(fixture.original.graph).toBe(originalMethods.graph)
    expect(fixture.original.list).toBe(originalMethods.list)
    expect(fixture.original.remember).toBe(originalMethods.remember)
    expect(definition.manifest.scoreSemantics).toBe('provider-native')
    expect(definition.manifest.scoreSemantics).not.toBe('normalized-relevance')
  })

  it('surfaces provider errors without wrapping or swallowing them', async () => {
    const error = new Error('synthetic provider failure')
    const search = vi.fn(async () => {
      throw error
    })
    const original = {
      id: 'hindsight',
      scoreSemantics: {kind: 'normalized-relevance' as const},
      status: vi.fn(async () => ({healthy: true})),
      search,
      graph: vi.fn(async () => ({nodes: [], edges: [], generatedAt: 'synthetic'})),
      list: vi.fn(async () => []),
      remember: vi.fn(async () => ({action: 'queued'})),
    } as unknown as MemoryProviderAdapter
    const adapter = createNativeScoreAdapter(original)

    await expect(adapter.search(body, searchRequest, signal)).rejects.toBe(error)
    expect(search).toHaveBeenCalledWith(body, searchRequest, signal)
  })
})

type YamlRecord = Record<string, unknown>

function isYamlRecord(value: unknown): value is YamlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceEntries(value: unknown, matches: YamlRecord[] = []): YamlRecord[] {
  if (Array.isArray(value)) {
    for (const child of value) sourceEntries(child, matches)
  } else if (isYamlRecord(value)) {
    if (value.id === 'mnemon-source-memory-spaces') matches.push(value)
    for (const child of Object.values(value)) sourceEntries(child, matches)
  }
  return matches
}

function sourceEntry(patch: unknown, label: string): YamlRecord {
  const matches = sourceEntries(patch)
  if (matches.length !== 1) throw new Error(`${label} must contain exactly one Memory Spaces Source entry`)
  const match = matches[0]
  if (match === undefined) throw new Error(`${label} Source entry is missing`)
  return match
}

function providerRows(patch: unknown, label: string): YamlRecord[] {
  const source = sourceEntry(patch, label)
  const config = source.config
  if (!isYamlRecord(config) || !Array.isArray(config.providers)) {
    throw new Error(`${label} Source entry must define config.providers`)
  }
  if (!config.providers.every(isYamlRecord)) throw new Error(`${label} config.providers must contain mappings`)
  return config.providers
}

function parsePatch(text: string): unknown {
  return parse(text, {
    customTags: [{
      tag: 'tag:yaml.org,2002:js',
      resolve: (value: string) => value,
    }],
  })
}

describe('Hindsight Source patch contract', () => {
  it('keeps the fixed Mnemon 0.5.32 nine-provider order and changes only Hindsight use', () => {
    const require = createRequire(import.meta.url)
    const mnemonPackage = dirname(require.resolve('dsh-mnemon/package.json'))
    const upstreamPatch = parsePatch(readFileSync(join(mnemonPackage, 'cordis.patch.yml'), 'utf8'))
    const localPatch = parsePatch(readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8'))
    const upstreamSource = sourceEntry(upstreamPatch, 'dsh-mnemon/cordis.patch.yml')
    const localSource = sourceEntry(localPatch, 'hindsight-score-adapter/cordis.patch.yml')
    const upstreamProviders = providerRows(upstreamPatch, 'dsh-mnemon/cordis.patch.yml')
    const localProviders = providerRows(localPatch, 'hindsight-score-adapter/cordis.patch.yml')

    expect(upstreamSource.name).toBe('dsh-mnemon-source-memory-spaces')
    expect(localSource.name).toBe(upstreamSource.name)
    expect(upstreamProviders).toHaveLength(9)
    expect(localProviders).toHaveLength(9)
    expect(localProviders.map(provider => provider.instanceId)).toEqual(
      upstreamProviders.map(provider => provider.instanceId),
    )

    for (const [index, upstreamProvider] of upstreamProviders.entries()) {
      const localProvider = localProviders[index]
      if (localProvider === undefined) throw new Error(`local provider row ${index} is missing`)
      if (upstreamProvider.instanceId === 'hindsight') {
        expect(localProvider).toEqual({
          ...upstreamProvider,
          use: '@lisihao/dsh-solar-hindsight-score-adapter',
        })
      } else {
        expect(localProvider).toEqual(upstreamProvider)
      }
    }
  })
})
