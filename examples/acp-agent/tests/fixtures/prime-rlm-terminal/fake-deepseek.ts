/**
 * A loopback stand-in for the DeepSeek chat-completions API that answers each request from its content.
 * The production daemon, its DeepSeek model worker, and the shipping LLM adapter talk to it over real HTTP/SSE; only the
 * provider is replaced. `packages/test-support/llm-mock-server` replays a fixed behavior sequence and cannot choose a reply
 * from the request, which the concurrent root, child, and continuation calls of an RLM run need.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** One chat message of a request body. */
export interface FakeMessage {
  readonly role: string
  readonly content?: unknown
  readonly tool_calls?: unknown
}

/** What the fake sends back for one request. */
export type FakeReply =
  | { readonly kind: 'tool'; readonly name: string; readonly arguments: string }
  | { readonly kind: 'text'; readonly text: string; readonly finish: 'stop' | 'length' }

/** Decides the reply for one request; it may wait, for example for a gate the driver opens later. */
export type FakeHandler = (messages: readonly FakeMessage[]) => FakeReply | Promise<FakeReply>

/** A running fake and what it was asked. */
export interface FakeDeepSeek {
  readonly baseURL: string
  readonly requests: readonly (readonly FakeMessage[])[]
  /** The exact bytes of every chat-completions body received, in order, so a test can join each to one admitted request. */
  readonly bodies: readonly string[]
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

function writeReply(response: ServerResponse, reply: FakeReply): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  if (reply.kind === 'tool') {
    const midpoint = Math.max(1, Math.floor(reply.arguments.length / 2))
    const first = { index: 0, id: 'fake-call', type: 'function', function: { name: reply.name, arguments: reply.arguments.slice(0, midpoint) } }
    const second = { index: 0, function: { arguments: reply.arguments.slice(midpoint) } }
    sse(response, { choices: [{ index: 0, delta: { tool_calls: [first] }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { tool_calls: [second] }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
  } else {
    sse(response, { choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] })
    sse(response, { choices: [{ index: 0, delta: { content: '' }, finish_reason: reply.finish }], usage: { prompt_tokens: 3, completion_tokens: 2 } })
  }
  sse(response, '[DONE]')
  response.end()
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
  const bodies: string[] = []
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
        const raw = await body(request)
        bodies.push(raw)
        const parsed = JSON.parse(raw) as { messages?: FakeMessage[] }
        const messages = parsed.messages ?? []
        requests.push(messages)
        writeReply(response, await handler(messages))
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
    close: async () => {
      for (const response of open) response.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
  }
}
