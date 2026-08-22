import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { MemoryBodyRegistry } from '../src/memory-bodies.ts'
import type { ProcessRunner } from '../src/process.ts'
import { HindsightProvider } from '../src/providers/hindsight.ts'
import { HonchoProvider } from '../src/providers/honcho.ts'
import { Mem0Provider } from '../src/providers/mem0.ts'
import { RetainDbProvider } from '../src/providers/retaindb.ts'
import { SupermemoryProvider } from '../src/providers/supermemory.ts'
import { createRunner } from '../src/runner.ts'
import type { MemoryProviderConnection, MemoryProviderId } from '../src/shared/contracts.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function providerBody(providerId: MemoryProviderId, connection: MemoryProviderConnection) {
  const dataDir = mkdtempSync(join(tmpdir(), `dsh-mnemon-${providerId}-`))
  temporaryDirectories.push(dataDir)
  const runner = createRunner(resolveConfig({ cliPath: '/fake/mnemon', dataDir }), vi.fn<ProcessRunner>())
  const registry = new MemoryBodyRegistry(runner, true)
  const body = await registry.create({
    name: `${providerId} memory`,
    description: `External memory backed by ${providerId}.`,
    active: true,
    providerId,
    connection,
  })
  return { registry, body }
}

function response(payload: unknown, status = 200): Response {
  return new Response(payload === undefined ? null : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('third-party remote memory providers', () => {
  it('does not start generic Provider HTTP requests after cancellation', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    const controller = new AbortController()
    controller.abort(new Error('navigation cancelled'))
    const honcho = await providerBody('honcho', { endpoint: 'https://honcho.example', workspace: 'old', userId: 'user', agentId: 'agent' })

    await expect(new HonchoProvider(honcho.registry, { fetch: fetchMock }).discover({ endpoint: 'https://honcho.example' }, controller.signal)).rejects.toThrow('navigation cancelled')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discovers provider-native namespaces and maps their upstream titles and descriptions', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname
      if (path === '/v3/workspaces/list') return response({ items: [{ id: 'workspace-1', metadata: { title: 'Product workspace', description: 'Honcho source metadata.' } }] })
      if (path === '/entities') return response([{ id: 'alice', name: 'Alice', type: 'user', total_memories: 4 }])
      if (path === '/v1/default/banks') return response({ banks: [{ bank_id: 'bank-1', name: 'Product bank', mission: 'Hindsight source metadata.' }] })
      if (path === '/v1/projects') return response({ projects: [{ id: 'project-1', name: 'Launch', slug: 'launch', description: 'RetainDB source metadata.' }] })
      if (path === '/v3/container-tags/list') return response([{ id: 'space-1', name: 'Team space', containerTag: 'team', description: 'Supermemory source metadata.' }])
      throw new Error(`unexpected discovery path ${path}`)
    })

    const honcho = await providerBody('honcho', { endpoint: 'https://honcho.example', workspace: 'old', userId: 'user', agentId: 'agent' })
    const mem0 = await providerBody('mem0', { endpoint: 'https://mem0.example', mode: 'self-hosted', userId: 'user', agentId: 'agent' })
    const hindsight = await providerBody('hindsight', { endpoint: 'https://hindsight.example', bankId: 'old', budget: 'mid' })
    const retain = await providerBody('retaindb', { endpoint: 'https://retain.example', apiKey: 'key', project: 'old', userId: 'user' })
    const supermemory = await providerBody('supermemory', { endpoint: 'https://supermemory.example', apiKey: 'key', containerTag: 'old', searchMode: 'hybrid' })

    await expect(new HonchoProvider(honcho.registry, { fetch: fetchMock }).discover({ endpoint: 'https://honcho.example' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'workspace-1', name: 'Product workspace', description: 'Honcho source metadata.', connection: { workspace: 'workspace-1', userId: '*', agentId: '*' } }),
    ])
    await expect(new Mem0Provider(mem0.registry, { fetch: fetchMock }).discover({ endpoint: 'https://mem0.example', mode: 'self-hosted' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'user:alice', name: 'Alice', connection: { userId: 'alice', agentId: '*', rerank: false } }),
    ])
    await expect(new HindsightProvider(hindsight.registry, { fetch: fetchMock }).discover({ endpoint: 'https://hindsight.example' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'bank-1', name: 'Product bank', description: 'Hindsight source metadata.' }),
    ])
    await expect(new RetainDbProvider(retain.registry, { fetch: fetchMock }).discover({ endpoint: 'https://retain.example', apiKey: 'key' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'project-1', name: 'Launch', description: 'RetainDB source metadata.', connection: { project: 'launch', userId: '*' } }),
    ])
    await expect(new SupermemoryProvider(supermemory.registry, { fetch: fetchMock }).discover({ endpoint: 'https://supermemory.example', apiKey: 'key' })).resolves.toEqual([
      expect.objectContaining({ externalId: 'space-1', name: 'Team space', description: 'Supermemory source metadata.' }),
    ])
  })

  it('uses Honcho v3 conclusion scope for recall, explicit writes, and deletion', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path.endsWith('/conclusions/query')) return response([{ id: 'hon-1', content: 'Alice prefers short answers.', level: 'peer', observer_id: 'dsh', observed_id: 'alice' }])
      if (path.endsWith('/conclusions/list')) return response({ items: [{ id: 'hon-1', content: 'Alice prefers short answers.', created_at: '2026-08-16T00:00:00Z' }] })
      if (path.endsWith('/conclusions') && init?.method === 'POST') return response({ conclusions: [{ id: 'hon-2', content: 'Alice is testing memory.' }] })
      if (path.endsWith('/conclusions/hon-1') && init?.method === 'DELETE') return response(undefined, 204)
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('honcho', {
      endpoint: 'https://api.honcho.dev', apiKey: 'honcho-secret', workspace: 'product team', userId: 'alice', agentId: 'dsh',
    })
    const provider = new HonchoProvider(registry, { fetch: fetchMock })

    await expect(provider.search(body, { query: 'answer style', limit: 7 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'hon-1', content: 'Alice prefers short answers.', entities: ['dsh', 'alice'] })],
    })
    await expect(provider.list(body, { limit: 20 })).resolves.toEqual([expect.objectContaining({ id: 'hon-1' })])
    await expect(provider.remember(body, { content: 'Alice is testing memory.' })).resolves.toMatchObject({ action: 'stored', provider: 'honcho' })
    await expect(provider.forget(body, 'hon-1')).resolves.toMatchObject({ action: 'deleted', id: 'hon-1' })

    expect(new URL(requests[0]!.url).pathname).toBe('/v3/workspaces/product%20team/conclusions/query')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer honcho-secret')
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      query: 'answer style', top_k: 7, filters: { observer_id: 'dsh', observed_id: 'alice' },
    })
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      conclusions: [{ content: 'Alice is testing memory.', observer_id: 'dsh', observed_id: 'alice', session_id: null }],
    })
  })

  it('supplies stable Honcho peers when a discovered workspace uses wildcard scope', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      return response([])
    })
    const { registry, body } = await providerBody('honcho', {
      endpoint: 'https://api.honcho.dev', workspace: 'dsh-lab', userId: '*', agentId: '*',
    })

    await new HonchoProvider(registry, { fetch: fetchMock }).search(body, { query: 'provider routing', limit: 5 })

    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      query: 'provider routing', top_k: 5, filters: { observer_id: 'dsh', observed_id: 'dsh-user' },
    })
  })

  it('maps Hindsight recall, graph traversal, asynchronous retain, and soft forget', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path === '/health/live') return response({ status: 'alive', version: '0.9.1' })
      if (path.endsWith('/stats')) return response({ total_nodes: 3, total_links: 2, nodes_by_fact_type: { world: 2, observation: 1 }, operations_by_status: { completed: 4 } })
      if (path.endsWith('/entities')) return response({ items: [{ canonical_name: 'Alice', mention_count: 3 }], total: 1 })
      if (path.endsWith('/memories/recall')) return response({ results: [{ id: 'hs-1', text: 'Alice uses TypeScript.', type: 'world', entities: ['Alice'], scores: { final: 0.93 } }] })
      if (path.endsWith('/memories/list')) return response({ items: [{ id: 'hs-1', text: 'Alice uses TypeScript.', type: 'world' }], total: 1 })
      if (path.endsWith('/graph')) return response({
        nodes: [
          { data: { id: 'hs-1', text: 'Alice', entities: 'Alice' } },
          { data: { id: 'hs-2', text: 'TypeScript', color: '#42a5f5' } },
          { data: { id: 'hs-3', text: 'Node.js' } },
        ],
        edges: [
          { data: { source: 'hs-1', target: 'hs-2', linkType: 'entity' } },
          { data: { source: 'hs-2', target: 'hs-3', linkType: 'semantic' } },
        ],
      })
      if (path.endsWith('/memories') && init?.method === 'POST') return response({ operation_id: 'op-1', items_count: 1 })
      if (path.endsWith('/memories/hs-1') && init?.method === 'PATCH') return response({ state: 'invalidated' })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('hindsight', {
      endpoint: 'https://api.hindsight.vectorize.io', apiKey: 'hs-secret', bankId: 'alice/profile', budget: 'high',
    })
    const provider = new HindsightProvider(registry, { fetch: fetchMock })

    await expect(provider.search(body, { query: 'language', limit: 3 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'hs-1', category: 'world', score: 0.93, entities: ['Alice'] })],
    })
    await expect(provider.list(body, { limit: 25 })).resolves.toEqual([expect.objectContaining({ id: 'hs-1' })])
    await expect(provider.related(body, 'hs-1', 2)).resolves.toEqual([
      expect.objectContaining({ id: 'hs-2' }), expect.objectContaining({ id: 'hs-3' }),
    ])
    await expect(provider.status(body)).resolves.toEqual({
      healthy: true,
      stats: expect.objectContaining({ totalInsights: 3, edgeCount: 2, oplogCount: 4, byCategory: { world: 2, observation: 1 }, topEntities: [{ entity: 'Alice', count: 3 }] }),
    })
    await expect(provider.remember(body, { content: 'Alice ships TypeScript.', category: 'decision', tags: ['dsh'], entities: ['Alice'] })).resolves.toMatchObject({ operationId: 'op-1', itemsCount: 1 })
    await expect(provider.forget(body, 'hs-1')).resolves.toMatchObject({ action: 'invalidated', id: 'hs-1' })

    expect(new URL(requests[0]!.url).pathname).toBe('/v1/default/banks/alice%2Fprofile/memories/recall')
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer hs-secret')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ query: 'language', budget: 'high', types: ['world', 'experience', 'observation'] })
    expect(JSON.parse(String(requests[6]?.init?.body))).toMatchObject({
      items: [{ content: 'Alice ships TypeScript.', context: 'decision', tags: ['dsh'], entities: [{ text: 'Alice' }] }],
      async: true,
    })
    expect(JSON.parse(String(requests[7]?.init?.body))).toEqual({ state: 'invalidated', reason: 'Forgotten from dsh-mnemon' })
  })

  it('uses Mem0 Platform v3 scoping and keeps the token out of result projections', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path === '/v3/memories/search/') return response({ results: [{ id: 'mem-1', memory: 'Alice prefers concise replies.', score: 0.91, categories: ['preference'] }] })
      if (path === '/v3/memories/add/') return response({ status: 'PENDING', event_id: 'event-1' })
      if (path === '/v1/memories/mem-1') return response({ message: 'deleted' })
      throw new Error(`unexpected path ${path}`)
    })
    const { registry, body } = await providerBody('mem0', {
      endpoint: 'https://api.mem0.ai', apiKey: 'mem0-secret', mode: 'platform', userId: 'alice', agentId: 'dsh', rerank: true,
    })
    const provider = new Mem0Provider(registry, { fetch: fetchMock })

    await expect(provider.search(body, { query: 'reply style', limit: 5 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'mem-1', content: 'Alice prefers concise replies.', category: 'preference', score: 0.91 })],
    })
    await expect(provider.remember(body, { content: 'Alice likes TypeScript.', category: 'preference' })).resolves.toMatchObject({ eventId: 'event-1', status: 'PENDING' })
    await expect(provider.forget(body, 'mem-1')).resolves.toMatchObject({ action: 'deleted', id: 'mem-1' })

    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Token mem0-secret')
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ filters: { user_id: 'alice', agent_id: 'dsh' }, rerank: true })
    expect(JSON.stringify((await provider.search(body, { query: 'reply style' })).results)).not.toContain('mem0-secret')
  })

  it('preserves RetainDB project/user/session scope and current-to-legacy fallbacks', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path === '/v1/memory/search') return response({ memories: [{ id: 'ret-1', content: 'Use staged rollout.', score: 0.8, memory_type: 'decision' }] })
      if (path === '/v1/memory') return response({ message: 'missing' }, 404)
      if (path === '/v1/memories' && init?.method === 'POST') return response({ id: 'ret-2' })
      if (path === '/v1/memory/ret-1') return response({ message: 'missing' }, 404)
      if (path === '/v1/memories/ret-1') return response({ deleted: true })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('retaindb', {
      endpoint: 'https://api.retaindb.com', apiKey: 'retain-secret', project: 'launch', userId: 'alice',
    })
    const provider = new RetainDbProvider(registry, { fetch: fetchMock })

    await expect(provider.search(body, { query: 'rollout', limit: 4 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'ret-1', category: 'decision', score: 0.8 })],
    })
    await expect(provider.remember(body, { content: 'Canary before production.', category: 'decision' })).resolves.toMatchObject({ id: 'ret-2' })
    await expect(provider.forget(body, 'ret-1')).resolves.toMatchObject({ action: 'deleted' })

    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ project: 'launch', user_id: 'alice', top_k: 4 })
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer retain-secret')
    expect(new Headers(requests[0]?.init?.headers).get('X-API-Key')).toBe('retain-secret')
    expect(requests.map(request => new URL(request.url).pathname)).toContain('/v1/memories/ret-1')
  })

  it('maps Supermemory v4 recall/list/forget and v3 document ingestion', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      requests.push({ url: String(url), ...(init === undefined ? {} : { init }) })
      const path = new URL(String(url)).pathname
      if (path === '/v4/search') return response({ results: [{ id: 'sm-1', memory: 'Alice uses dark mode.', similarity: 0.88, metadata: { category: 'preference' } }] })
      if (path === '/v4/memories/list') return response({ memoryEntries: [{ id: 'sm-1', memory: 'Alice uses dark mode.', createdAt: '2026-08-16T00:00:00Z' }] })
      if (path === '/v3/documents/documents') return response({ documents: [] })
      if (path === '/v3/documents') return response({ id: 'doc-1', status: 'queued' })
      if (path === '/v4/memories' && init?.method === 'DELETE') return response({ id: 'sm-1', forgotten: true })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('supermemory', {
      endpoint: 'https://api.supermemory.ai', apiKey: 'sm-secret', containerTag: 'alice', searchMode: 'hybrid',
    })
    const provider = new SupermemoryProvider(registry, { fetch: fetchMock })

    await expect(provider.search(body, { query: 'theme', limit: 6 })).resolves.toEqual({
      results: [expect.objectContaining({ id: 'sm-1', category: 'preference', score: 0.88 })],
    })
    await expect(provider.list(body, { limit: 10 })).resolves.toEqual([expect.objectContaining({ id: 'sm-1' })])
    await expect(provider.remember(body, { content: 'Alice prefers dark mode.', category: 'preference' })).resolves.toMatchObject({ id: 'doc-1', status: 'queued' })
    await expect(provider.forget(body, 'sm-1')).resolves.toMatchObject({ forgotten: true })

    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({ q: 'theme', containerTag: 'alice', searchMode: 'hybrid', limit: 6 })
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer sm-secret')
    expect(new Headers(requests[0]?.init?.headers).get('x-sm-source')).toBe('dsh-mnemon')
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({ id: 'sm-1', containerTag: 'alice', reason: 'Deleted from dsh-mnemon' })
  })

  it('merges Supermemory documents with extracted entries and falls back for document deletion', async () => {
    const requests: string[] = []
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname
      requests.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/v4/memories/list') return response({ memoryEntries: [{ id: 'memory-1', memory: 'An extracted memory is browseable.' }] })
      if (path === '/v3/documents/documents') {
        return response({ documents: [{
          id: 'doc-1',
          content: 'A retained document is still browseable.',
          createdAt: '2026-08-16T00:00:00Z',
          metadata: { category: 'context' },
        }] })
      }
      if (path === '/v4/memories' && init?.method === 'DELETE') return response({ message: 'memory not found' }, 404)
      if (path === '/v3/documents/doc-1' && init?.method === 'DELETE') return response({ deleted: true })
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${path}`)
    })
    const { registry, body } = await providerBody('supermemory', {
      endpoint: 'https://api.supermemory.ai', apiKey: 'sm-secret', containerTag: 'alice', searchMode: 'hybrid',
    })
    const provider = new SupermemoryProvider(registry, { fetch: fetchMock })

    await expect(provider.list(body, { limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: 'memory-1', content: 'An extracted memory is browseable.' }),
      expect.objectContaining({ id: 'doc-1', content: 'A retained document is still browseable.', category: 'context' }),
    ])
    await expect(provider.forget(body, 'doc-1')).resolves.toMatchObject({ action: 'deleted', document: true })
    expect(requests).toEqual([
      'POST /v4/memories/list',
      'POST /v3/documents/documents',
      'DELETE /v4/memories',
      'DELETE /v3/documents/doc-1',
    ])
  })
})
