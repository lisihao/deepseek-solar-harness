import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, userAgent } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { assemble } from './assemble.ts'
import { textEvents } from './mock-server.ts'

/** Selector note the adapter attaches to endpoint-only model IDs. */
const DISCOVERED = '服务商 /models 新列出的模型；服务商未提供名称或版本说明'

const servers: Server[] = []
let testHome: string

interface RecordedRequest {
  readonly method: string | undefined
  readonly path: string
  readonly headers: IncomingMessage['headers']
  readonly body: string
}

interface ListingResponse {
  readonly status?: number
  readonly body: string
}

interface ListingServer {
  readonly url: string
  readonly requests: RecordedRequest[]
}

interface MutableDiscoveryConfig {
  baseURL: string
  apiKeyEnv: string
  streamIdleTimeoutMs?: number
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), 'dsh-llm-deepseek-discovery-'))
  vi.stubEnv('DSH_HOME', testHome)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(testHome, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

/** Local provider that distinguishes the listing read from a chat completion. */
async function listingServer(listings: ListingResponse[]): Promise<ListingServer> {
  const requests: RecordedRequest[] = []
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const path = request.url ?? ''
      requests.push({
        method: request.method,
        path,
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (path.endsWith('/models')) {
        const next = listings.shift()
        if (next === undefined) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end('{"error":{"message":"listing script exhausted"}}')
          return
        }
        response.writeHead(next.status ?? 200, { 'content-type': 'application/json' })
        response.end(next.body)
        return
      }
      if (path.endsWith('/chat/completions')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textEvents.map(event => `data: ${event}\n\n`).join(''))
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"unexpected path"}}')
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server port')
  return { url: `http://127.0.0.1:${address.port}`, requests }
}

async function harness(baseURL: string, config: object = {}): Promise<Context> {
  vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmDeepSeek, { baseURL, ...config })
  return ctx
}

function directAdapter(
  config: MutableDiscoveryConfig,
  keys: ReadonlyMap<string, string>,
): LlmDeepSeek.DeepSeekAdapter {
  return new LlmDeepSeek.DeepSeekAdapter({
    options: () => LlmDeepSeek.resolveAdapterOptions({
      baseURL: config.baseURL,
      apiKeyEnv: config.apiKeyEnv,
      models: [],
      ...config.streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs: config.streamIdleTimeoutMs },
    }),
    resolveApiKey: async connection => keys.get(String(connection.apiKeyEnv)) ?? '',
    resolveUserId: () => 'test-discovery-user' as AnonymousUserId,
  })
}

function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

function listingResponse(ids: readonly string[]): Response {
  return new Response(JSON.stringify({ data: ids.map(id => ({ id })) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('DeepSeek model catalog refresh', () => {
  it('isolates cached ids when the endpoint or credential reference changes', async () => {
    const serverA = await listingServer([
      { body: JSON.stringify({ data: [{ id: 'account-a-model' }] }) },
    ])
    const serverB = await listingServer([
      { body: JSON.stringify({ data: [{ id: 'account-b-model' }] }) },
      { body: JSON.stringify({ data: [{ id: 'account-b-other-key-model' }] }) },
    ])
    const apiKeyA = String(credentialRef('DEEPSEEK_ACCOUNT_A'))
    const apiKeyB = String(credentialRef('DEEPSEEK_ACCOUNT_B'))
    const config: MutableDiscoveryConfig = { baseURL: serverA.url, apiKeyEnv: apiKeyA }
    const adapter = directAdapter(config, new Map([
      [apiKeyA, 'account-a-key'],
      [apiKeyB, 'account-b-key'],
    ]))

    const fromA = await adapter.listModels('deepseek-official', { refresh: true })
    expect(fromA.map(model => model.id)).toEqual(['account-a-model'])

    config.baseURL = serverB.url
    config.apiKeyEnv = apiKeyB
    await expect(adapter.listModels('deepseek-official')).resolves.toEqual([])
    const fromB = await adapter.listModels('deepseek-official', { refresh: true })
    expect(fromB.map(model => model.id)).toEqual(['account-b-model'])

    config.apiKeyEnv = apiKeyA
    await expect(adapter.listModels('deepseek-official')).resolves.toEqual([])
    const fromBWithOtherKey = await adapter.listModels('deepseek-official', { refresh: true })
    expect(fromBWithOtherKey.map(model => model.id)).toEqual(['account-b-other-key-model'])

    config.baseURL = serverA.url
    config.apiKeyEnv = apiKeyA
    await expect(adapter.listModels('deepseek-official')).resolves.toEqual(fromA)
  })

  it('does not let an older concurrent refresh overwrite the newer result', async () => {
    const config: MutableDiscoveryConfig = {
      baseURL: 'https://discovery.example.test/openai/v1',
      apiKeyEnv: String(credentialRef('DEEPSEEK_CONCURRENT')),
    }
    const adapter = directAdapter(config, new Map([[config.apiKeyEnv, 'concurrent-key']]))
    const first = deferred<Response>()
    const second = deferred<Response>()
    let calls = 0
    vi.stubGlobal('fetch', (_input: RequestInfo | URL, _init?: RequestInit) => {
      calls += 1
      return (calls === 1 ? first : second).promise
    })

    const older = adapter.listModels('deepseek-official', { refresh: true })
    await Promise.resolve()
    const newer = adapter.listModels('deepseek-official', { refresh: true })
    await Promise.resolve()
    expect(calls).toBe(2)

    second.resolve(listingResponse(['newer-model']))
    await expect(newer).resolves.toEqual([
      { provider: 'deepseek-official', id: 'newer-model', name: 'newer-model', description: DISCOVERED, inputModalities: ['text'] },
    ])
    first.resolve(listingResponse(['older-model']))
    await expect(older).resolves.toEqual([
      { provider: 'deepseek-official', id: 'newer-model', name: 'newer-model', description: DISCOVERED, inputModalities: ['text'] },
    ])
    await expect(adapter.listModels('deepseek-official')).resolves.toEqual([
      { provider: 'deepseek-official', id: 'newer-model', name: 'newer-model', description: DISCOVERED, inputModalities: ['text'] },
    ])
  })

  it('aborts stalled directory fetches and body reads while retaining the last good catalog', async () => {
    vi.useFakeTimers()
    try {
      const config: MutableDiscoveryConfig = {
        baseURL: 'https://discovery-timeout.example.test/openai/v1',
        apiKeyEnv: String(credentialRef('DEEPSEEK_TIMEOUT')),
        streamIdleTimeoutMs: 25,
      }
      const adapter = directAdapter(config, new Map([[config.apiKeyEnv, 'timeout-key']]))
      let mode: 'good' | 'fetch-stalled' | 'body-stalled' = 'good'
      let fetchAborted = false
      let bodyAborted = false
      vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) => {
        if (mode === 'good') return Promise.resolve(listingResponse(['last-good-model']))
        if (mode === 'fetch-stalled') {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal
            signal?.addEventListener('abort', () => {
              fetchAborted = true
              reject(new Error('fetch aborted'))
            }, { once: true })
          })
        }
        const signal = init?.signal
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener('abort', () => {
              bodyAborted = true
              controller.error(signal.reason)
            }, { once: true })
          },
        })
        return Promise.resolve(new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }))
      })

      const expected = [{
        provider: 'deepseek-official',
        id: 'last-good-model',
        name: 'last-good-model',
        description: DISCOVERED,
        inputModalities: ['text'],
      }]
      await expect(adapter.listModels('deepseek-official', { refresh: true })).resolves.toEqual(expected)

      mode = 'fetch-stalled'
      const stalledFetch = adapter.listModels('deepseek-official', { refresh: true })
      const stalledFetchError = expect(stalledFetch).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(25)
      await stalledFetchError
      expect(fetchAborted).toBe(true)
      await expect(adapter.listModels('deepseek-official')).resolves.toEqual(expected)

      mode = 'body-stalled'
      const stalledBody = adapter.listModels('deepseek-official', { refresh: true })
      const stalledBodyError = expect(stalledBody).rejects.toMatchObject({ code: 'TIMEOUT' })
      await vi.advanceTimersByTimeAsync(25)
      await stalledBodyError
      expect(bodyAborted).toBe(true)
      await expect(adapter.listModels('deepseek-official')).resolves.toEqual(expected)
    } finally {
      vi.useRealTimers()
    }
  })

  it('adds endpoint ids without replacing configured metadata or changing the streamed id', async () => {
    const server = await listingServer([{
      body: JSON.stringify({
        data: [
          { id: 'configured' },
          { id: 'live-unknown' },
          { id: 'live-unknown' },
          { id: '' },
          { id: 7 },
          {},
          null,
          7,
        ],
      }),
    }])
    const ctx = await harness(`${server.url}/openai/v1`, {
      models: [{
        id: 'configured',
        name: 'Configured label',
        description: 'Configured description',
        inputModalities: ['text', 'image'],
      }],
    })

    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([{
      provider: 'deepseek-official',
      id: 'configured',
      name: 'Configured label',
      description: 'Configured description',
      inputModalities: ['text', 'image'],
    }])
    expect(server.requests).toEqual([])

    const refreshed = await ctx.llm.listModels('deepseek-official', { refresh: true })
    expect(refreshed).toEqual([
      {
        provider: 'deepseek-official',
        id: 'configured',
        name: 'Configured label',
        description: 'Configured description',
        inputModalities: ['text', 'image'],
      },
      {
        provider: 'deepseek-official',
        id: 'live-unknown',
        name: 'live-unknown',
        description: DISCOVERED,
        inputModalities: ['text'],
      },
    ])
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/openai/v1/models' })
    expect(server.requests[0]?.headers.authorization).toBe('Bearer test-key')
    expect(server.requests[0]?.headers['user-agent']).toBe(userAgent())
    expect(server.requests[0]?.headers['x-deepseek-harness-user-id']).toEqual(expect.any(String))

    await expect(ctx.llm.listModels('deepseek-official', { refresh: false })).resolves.toEqual(refreshed)
    expect(server.requests).toHaveLength(1)

    const result = await assemble(ctx, {
      model: 'live-unknown',
      messages: [createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.requests[1]).toMatchObject({ method: 'POST', path: '/openai/v1/chat/completions' })
    expect(JSON.parse(server.requests[1]?.body ?? '{}')).toMatchObject({ model: 'live-unknown' })
  })

  it('keeps the last good catalog when a provider error rejects a later refresh', async () => {
    const server = await listingServer([
      { body: JSON.stringify({ data: [{ id: 'live-model' }] }) },
      { status: 503, body: JSON.stringify({ error: { message: 'listing unavailable' } }) },
    ])
    const ctx = await harness(server.url, { models: [] })

    const initial = await ctx.llm.listModels('deepseek-official', { refresh: true })
    await expect(ctx.llm.listModels('deepseek-official', { refresh: true })).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: 'listing unavailable',
    })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual(initial)
    expect(server.requests.map(request => request.path)).toEqual(['/models', '/models'])
  })

  it.each([
    JSON.stringify({}),
    'null',
    JSON.stringify({ error: { message: '' } }),
  ])('surfaces a provider error when its response supplies no usable message', async (body) => {
    const server = await listingServer([{ status: 503, body }])
    const ctx = await harness(server.url)

    await expect(ctx.llm.listModels('deepseek-official', { refresh: true })).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: 'DeepSeek model directory request failed with HTTP 503',
    })
  })

  it('surfaces an HTTP error when its body is not JSON', async () => {
    const server = await listingServer([{ status: 503, body: 'not JSON' }])
    const ctx = await harness(server.url)

    await expect(ctx.llm.listModels('deepseek-official', { refresh: true })).rejects.toMatchObject({
      code: 'DISCOVERY_FAILED',
      message: 'DeepSeek model directory request failed with HTTP 503',
    })
  })

  it.each([
    'not JSON',
    JSON.stringify({ data: {} }),
    'null',
  ])('rejects invalid listing JSON while retaining the prior catalog', async (body) => {
    const server = await listingServer([
      { body: JSON.stringify({ data: [{ id: 'live-model' }] }) },
      { body },
    ])
    const ctx = await harness(server.url, { models: [] })

    const initial = await ctx.llm.listModels('deepseek-official', { refresh: true })
    await expect(ctx.llm.listModels('deepseek-official', { refresh: true }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual(initial)
  })

  it('surfaces a transport error from the configured endpoint', async () => {
    const server = await listingServer([])
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const ctx = await harness(server.url)

    await expect(ctx.llm.listModels('deepseek-official', { refresh: true }))
      .rejects.toMatchObject({ code: 'TRANSPORT' })
    expect(server.requests).toEqual([])
  })

  it('requires an API key only for refresh and never starts a chat completion when it is absent', async () => {
    const server = await listingServer([{ body: JSON.stringify({ data: [{ id: 'live-model' }] }) }])
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmDeepSeek, { baseURL: server.url })

    await expect(ctx.llm.listModels('deepseek-official')).resolves.toHaveLength(3)
    await expect(ctx.llm.listModels('deepseek-official', { refresh: true }))
      .rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(server.requests).toEqual([])
  })
})
