/**
 * A loopback stand-in for the DeepSeek chat-completions endpoint. The shipping adapter and worker talk to it over real HTTP/SSE.
 * It keeps the raw body of every request it receives, so a test can join each received request to the ledger by its sha256 and
 * count what actually left the process. No test that uses it may reach a real provider: `refuseNonLoopbackFetch` makes any
 * `fetch` to another host throw.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One chat message of a received body. */
interface FakeWireMessage {
  readonly role: string
  readonly content?: unknown
}

/** One request the endpoint received. */
interface ReceivedRequest {
  /** The exact bytes of the body, as sent. */
  readonly body: string
  readonly sha256: string
  readonly parsed: {
    readonly model: string
    readonly messages: readonly FakeWireMessage[]
    readonly max_tokens?: number
    readonly thinking?: { readonly type: string }
    readonly reasoning_effort?: string
    readonly tools?: readonly unknown[]
  }
}

/** Usage the endpoint reports at the end of a response. `promptTokens` includes `cacheHit`, as the real API does. */
interface FakeUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheHit?: number
}

/** What the endpoint answers for one request. */
export type FakeAnswer =
  | { readonly kind: 'tool'; readonly code: string; readonly usage?: FakeUsage | null }
  | { readonly kind: 'text'; readonly text: string; readonly usage?: FakeUsage | null }
  /** Send the first bytes of a response and then wait, as a response that has not finished does. Released by `release()`. */
  | { readonly kind: 'hold' }
  /** Answer with a non-2xx status and an empty error body, as a failing endpoint does. */
  | { readonly kind: 'http-error'; readonly status: number }

/** Decides the answer to one request. */
export type FakeHandler = (request: ReceivedRequest, index: number) => FakeAnswer | Promise<FakeAnswer>

/** A running endpoint. */
export interface FakeDeepSeekHttp {
  readonly baseURL: string
  readonly received: readonly ReceivedRequest[]
  /** Finish every held response. */
  release(): void
  close(): Promise<void>
}

const DEFAULT_USAGE: FakeUsage = { promptTokens: 40, completionTokens: 12 }

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

function wireUsage(usage: FakeUsage): Record<string, number> {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    ...usage.cacheHit === undefined ? {} : { prompt_cache_hit_tokens: usage.cacheHit },
  }
}

function writeAnswer(response: ServerResponse, answer: Exclude<FakeAnswer, { kind: 'hold' } | { kind: 'http-error' }>): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  const usage = answer.usage === null ? undefined : wireUsage(answer.usage ?? DEFAULT_USAGE)
  if (answer.kind === 'tool') {
    const args = JSON.stringify({ code: answer.code })
    const call = { index: 0, id: 'fake-call', type: 'function', function: { name: 'typescript_repl', arguments: args } }
    sse(response, { choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }], ...usage === undefined ? {} : { usage } })
  } else {
    sse(response, { choices: [{ index: 0, delta: { content: answer.text }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }], ...usage === undefined ? {} : { usage } })
  }
  sse(response, '[DONE]')
  response.end()
}

/**
 * Start the endpoint on an OS-assigned loopback port.
 * @param handler - chooses the answer for each request.
 * @returns the base URL for `DEEPSEEK_BASE_URL`, the requests received, and controls.
 */
export async function startFakeDeepSeekHttp(handler: FakeHandler): Promise<FakeDeepSeekHttp> {
  const received: ReceivedRequest[] = []
  const open = new Set<ServerResponse>()
  const held: ServerResponse[] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    open.add(response)
    response.on('close', () => { open.delete(response) })
    void (async () => {
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(chunk as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      const entry: ReceivedRequest = {
        body, sha256: createHash('sha256').update(body).digest('hex'), parsed: JSON.parse(body) as ReceivedRequest['parsed'],
      }
      received.push(entry)
      const answer = await handler(entry, received.length - 1)
      if (answer.kind === 'hold') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: null }] })
        held.push(response)
        return
      }
      if (answer.kind === 'http-error') {
        response.writeHead(answer.status, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: `fake endpoint failure ${String(answer.status)}` } }))
        return
      }
      writeAnswer(response, answer)
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    received,
    release: () => {
      for (const response of held.splice(0)) {
        sse(response, { choices: [{ index: 0, delta: { content: 'released' }, finish_reason: 'stop' }], usage: wireUsage(DEFAULT_USAGE) })
        sse(response, '[DONE]')
        response.end()
      }
    },
    close: async () => {
      for (const response of open) response.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}

/**
 * Make any `fetch` to a host other than loopback throw, so a test that forgot its fake endpoint fails instead of reaching a
 * provider, and count what was fetched.
 * @returns the origins fetched so far, the number of refused non-loopback fetches, and the function that restores the real `fetch`.
 */
export function refuseNonLoopbackFetch(): { readonly origins: string[]; refused: number; restore(): void } {
  const original = globalThis.fetch
  const guard = { origins: [] as string[], refused: 0, restore: () => { globalThis.fetch = original } }
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    guard.origins.push(url.origin)
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
      guard.refused += 1
      throw new Error(`test refused a non-loopback request to ${url.origin}`)
    }
    return original(input, init)
  })
  return guard
}
