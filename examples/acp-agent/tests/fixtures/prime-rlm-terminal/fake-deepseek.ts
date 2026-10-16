/**
 * A loopback stand-in for the DeepSeek chat-completions API that answers each request from its content.
 * The production daemon, its DeepSeek model worker, and the shipping LLM adapter talk to it over real HTTP/SSE; only the
 * provider is replaced. `packages/test-support/llm-mock-server` replays a fixed behavior sequence and cannot choose a reply
 * from the request, which the concurrent root, child, and continuation calls of an RLM run need.
 */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One chat message of a request body. */
export interface FakeMessage {
  readonly role: string
  readonly content?: unknown
  readonly tool_calls?: unknown
}

/** The usage a reply reports, in the wire fields of the API: `prompt_tokens` includes the cache hits. */
export interface FakeUsage {
  readonly promptTokens: number
  readonly completionTokens: number
  readonly cacheHitTokens: number
}

/** What the fake sends back for one request; `usage` defaults to 3 prompt and 2 completion tokens and no cache hits. */
export type FakeReply =
  | { readonly kind: 'tool'; readonly name: string; readonly arguments: string; readonly usage?: FakeUsage }
  | { readonly kind: 'text'; readonly text: string; readonly finish: 'stop' | 'length'; readonly usage?: FakeUsage }

/** One chat-completions request body as the adapter sent it. */
export interface FakeBody {
  readonly model?: string
  readonly messages?: readonly FakeMessage[]
  readonly tools?: readonly unknown[]
  readonly [key: string]: unknown
}

/** Decides the reply for one request; it may wait, for example for a gate the driver opens later. */
export type FakeHandler = (messages: readonly FakeMessage[], body: FakeBody) => FakeReply | Promise<FakeReply>

/**
 * One chat-completions request exactly as it arrived: the body bytes before any parsing, their digest, the order it arrived in
 * among all requests of this fake, and the id of the tool call the fake answered it with (absent when it answered with text).
 */
export interface FakeRawRequest {
  /** 0 for the first request this fake received. */
  readonly ordinal: number
  readonly body: string
  readonly sha256: string
  /** Set once the reply has been chosen: the `id` of the tool call this request was answered with. */
  issuedToolCallId?: string
}

/** A running fake and what it was asked. */
export interface FakeDeepSeek {
  readonly baseURL: string
  readonly requests: readonly (readonly FakeMessage[])[]
  /** The whole body of every request, in arrival order: model, messages, and the tools offered. */
  readonly bodies: readonly FakeBody[]
  /** Every request as it arrived, in arrival order, with the body bytes unparsed. */
  readonly raw: readonly FakeRawRequest[]
  close(): Promise<void>
}

/** The text a message carries, whatever shape the adapter used for its content. */
export function messageText(message: FakeMessage): string {
  const { content } = message
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as readonly unknown[]).map((part) => {
      const text = typeof part === 'object' && part !== null ? (part as { readonly text?: unknown }).text : undefined
      return typeof text === 'string' ? text : ''
    }).join('\n')
  }
  return ''
}

function sse(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
}

let toolCallCounter = 0

/** Writes the reply and returns the id of the tool call it carries, when it carries one. */
function writeReply(response: ServerResponse, reply: FakeReply): string | undefined {
  const usage = reply.usage === undefined
    ? { prompt_tokens: 3, completion_tokens: 2 }
    : {
      prompt_tokens: reply.usage.promptTokens,
      completion_tokens: reply.usage.completionTokens,
      prompt_cache_hit_tokens: reply.usage.cacheHitTokens,
    }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  let issued: string | undefined
  if (reply.kind === 'tool') {
    const midpoint = Math.max(1, Math.floor(reply.arguments.length / 2))
    // Each call has its own id: the runtime treats a repeated tool call id of one session as a conflicting repeat of the first cell.
    toolCallCounter += 1
    issued = `fake-call-${String(toolCallCounter)}`
    const first = { index: 0, id: issued, type: 'function', function: { name: reply.name, arguments: reply.arguments.slice(0, midpoint) } }
    const second = { index: 0, function: { arguments: reply.arguments.slice(midpoint) } }
    sse(response, { choices: [{ index: 0, delta: { tool_calls: [first] }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { tool_calls: [second] }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }], usage })
  } else {
    sse(response, { choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: reply.finish }], usage })
  }
  sse(response, '[DONE]')
  response.end()
  return issued
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Start the fake on an OS-assigned loopback port.
 * @param handler - chooses the reply for each chat-completions request.
 * @returns the base URL to put in `DEEPSEEK_BASE_URL`, the requests seen, and a close function.
 */
export async function startFakeDeepSeek(handler: FakeHandler): Promise<FakeDeepSeek> {
  const requests: (readonly FakeMessage[])[] = []
  const bodies: FakeBody[] = []
  const raw: FakeRawRequest[] = []
  const open = new Set<ServerResponse>()
  const server: Server = createServer((request, response) => {
    open.add(response)
    response.on('close', () => { open.delete(response) })
    void (async () => {
      const url = request.url ?? ''
      if (request.method === 'GET' && /\/models(\?|$)/u.test(url)) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [] }))
        return
      }
      if (request.method === 'POST' && /\/chat\/completions$/u.test(url)) {
        const text = await body(request)
        const parsed = JSON.parse(text) as FakeBody
        const messages = parsed.messages ?? []
        const record: FakeRawRequest = { ordinal: raw.length, body: text, sha256: createHash('sha256').update(text).digest('hex') }
        raw.push(record)
        requests.push(messages)
        bodies.push(parsed)
        const issued = writeReply(response, await handler(messages, parsed))
        if (issued !== undefined) record.issuedToolCallId = issued
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `fake DeepSeek has no ${request.method ?? ''} ${url}`, type: 'not_found' } }))
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error), type: 'fake_error' } }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    baseURL: `http://127.0.0.1:${String(port)}`,
    requests,
    bodies,
    raw,
    close: async () => {
      for (const response of open) response.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
