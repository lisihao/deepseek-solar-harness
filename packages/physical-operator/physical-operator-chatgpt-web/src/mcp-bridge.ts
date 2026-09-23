/**
 * Loopback Streamable HTTP MCP ingress for one ChatGPT Web turn.
 *
 * The public endpoint exposes only the stable bridge tools. Per-turn DSH tool
 * schemas and execution remain owner-local and require the request proof.
 *
 * @module @deepseek-ai/dsh-physical-operator-chatgpt-web/mcp-bridge
 */

import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import type { PhysicalOperatorModelToolV1 } from '@deepseek-ai/dsh-physical-operator'
import type { WebMcpCallId } from './types.ts'

const LOOPBACK_HOST = '127.0.0.1'
const MAX_REQUEST_ID_BYTES = 256
const MAX_TIMER_DELAY_MS = 2_147_483_647
const REQUEST_ID_BASE = /^[A-Za-z0-9_-]+$/u

const STATIC_TOOLS = [
  {
    name: 'dsh_tools',
    description: 'List the DSH tools available to this request.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_execute',
    description: 'Execute one DSH tool returned by dsh_tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['name', 'arguments'],
      additionalProperties: false,
    },
  },
] as const

interface ActiveRequest {
  readonly controller: AbortController
  readonly done: Promise<void>
  track(operation: Promise<unknown>): void
  retain(owner: ChatGptWebMcpBridgeOwner): void
  waitForActualOperations(): Promise<void>
  releaseOwners(): void
  settle(): void
}

class HttpRequestError extends Error {
  constructor(readonly statusCode: number) {
    super('ChatGPT web MCP request rejected')
  }
}

class RequestAbortedError extends Error {
  constructor() {
    super('ChatGPT web MCP request aborted')
  }
}

/** Exact owner-local tool surface for one request proof. */
export interface ChatGptWebMcpBridgeOwner {
  /** Exact model-visible tools sealed for the request owner. */
  readonly tools: readonly PhysicalOperatorModelToolV1[]
  /** Release this inbound request after its HTTP response and actual work settle. */
  release(): void
  /**
   * Execute one owner-allowed DSH tool with separate proof and receipt identities.
   * @param requestId - normalized request identity accepted as owner proof.
   * @param name - owner-advertised DSH tool name.
   * @param argumentsValue - validated owner-tool arguments.
   * @param signal - inbound MCP-call cancellation signal.
   * @param callId - opaque receipt identity for this exact MCP wire call.
   * @returns the owner tool result.
   */
  execute(
    requestId: string,
    name: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
    callId: WebMcpCallId,
  ): Promise<unknown>
}

/** Construction inputs for the one loopback Streamable HTTP MCP listener. */
export interface ChatGptWebMcpBridgeOptions {
  /** TCP port on the IPv4 loopback interface; zero asks the operating system for one. */
  readonly port: number
  /** Exact unguessable MCP request path, including its leading slash. */
  readonly path: string
  /** Maximum accepted UTF-8 request body size. */
  readonly maxRequestBytes: number
  /** Maximum complete HTTP request lifetime, including owner resolution and execution. */
  readonly requestTimeoutMs: number
  /** Resolve exactly one owner from an extension-observed request identity. */
  readonly resolveOwner: (requestId: string, signal: AbortSignal) => Promise<ChatGptWebMcpBridgeOwner>
}

/**
 * Serve the stable MCP bridge tools at a secret loopback path.
 *
 * Each tools/call resolves the owner from its HTTP request identity; MCP
 * transport sessions are intentionally not treated as DSH ownership.
 */
export class ChatGptWebMcpBridge {
  private readonly activeRequests = new Set<ActiveRequest>()
  private readonly path: string
  private readonly maxRequestBytes: number
  private readonly requestTimeoutMs: number
  private readonly port: number
  private readonly resolveOwner: ChatGptWebMcpBridgeOptions['resolveOwner']
  private server: HttpServer | undefined
  private started: Promise<string> | undefined
  private disposing: Promise<void> | undefined
  private disposed = false

  constructor(options: ChatGptWebMcpBridgeOptions) {
    this.port = requirePort(options.port)
    this.path = requirePath(options.path)
    this.maxRequestBytes = requirePositiveInteger(options.maxRequestBytes, 'maxRequestBytes')
    this.requestTimeoutMs = requireTimer(options.requestTimeoutMs)
    this.resolveOwner = options.resolveOwner
  }

  /**
   * Start listening on IPv4 loopback and return the exact MCP endpoint URL.
   * @returns the usable loopback Streamable HTTP MCP URL.
   */
  start(): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('ChatGPT web MCP bridge is disposed'))
    this.started ??= this.listen()
    return this.started
  }

  /**
   * Abort accepted requests, close the listener, and wait until handlers release resources.
   * @returns after every accepted request and the HTTP server have stopped.
   */
  dispose(): Promise<void> {
    if (this.disposing !== undefined) return this.disposing
    this.disposed = true
    this.disposing = this.disposeActiveRequests()
    return this.disposing
  }

  private async listen(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    server.requestTimeout = this.requestTimeoutMs
    server.headersTimeout = this.requestTimeoutMs
    this.server = server
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      server.once('error', onError)
      server.listen(this.port, LOOPBACK_HOST, () => {
        server.off('error', onError)
        resolve()
      })
    })
    if (this.disposed) {
      await closeServer(server)
      throw new Error('ChatGPT web MCP bridge was disposed before it started')
    }
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await closeServer(server)
      throw new Error('ChatGPT web MCP bridge did not acquire an IPv4 port')
    }
    return `http://${LOOPBACK_HOST}:${String(address.port)}${this.path}`
  }

  private async disposeActiveRequests(): Promise<void> {
    if (this.started !== undefined) await this.started.catch(() => {})
    for (const request of this.activeRequests) request.controller.abort()
    const server = this.server
    if (server !== undefined && server.listening) {
      const closed = closeServer(server)
      server.closeAllConnections()
      await closed
      await this.waitForActiveRequests()
      return
    }
    await this.waitForActiveRequests()
  }

  private async waitForActiveRequests(): Promise<void> {
    while (this.activeRequests.size > 0) {
      await Promise.all([...this.activeRequests].map(request => request.done))
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const active = activeRequest()
    this.activeRequests.add(active)
    let responseFinished = false
    const responseSettled = Promise.withResolvers<void>()
    const timeout = setTimeout(() => { active.controller.abort() }, this.requestTimeoutMs)
    const onAborted = (): void => { active.controller.abort() }
    const onFinished = (): void => {
      responseFinished = true
      responseSettled.resolve()
    }
    const onClosed = (): void => {
      if (!responseFinished) active.controller.abort()
      responseSettled.resolve()
    }
    const onResponseError = (): void => { responseSettled.resolve() }
    request.once('aborted', onAborted)
    response.once('finish', onFinished)
    response.once('close', onClosed)
    response.once('error', onResponseError)
    let transport: StreamableHTTPServerTransport | undefined
    // oxlint-disable-next-line typescript/no-deprecated -- The low-level Server is required for dynamic owner-local schemas.
    let mcpServer: Server | undefined
    try {
      if (this.disposed) {
        rejectHttp(request, response, 503)
        return
      }
      if (request.url !== this.path) {
        rejectHttp(request, response, 404)
        return
      }
      const expectedHost = `${LOOPBACK_HOST}:${String(this.portForHost())}`
      if (!hasExpectedHost(request, expectedHost)) {
        rejectHttp(request, response, 403)
        return
      }
      if (!hasLoopbackOrigin(request)) {
        rejectHttp(request, response, 403)
        return
      }
      if (request.method !== 'POST') {
        rejectHttp(request, response, 405)
        return
      }
      if (!hasJsonContentType(request)) {
        rejectHttp(request, response, 415)
        return
      }
      const body = await readJsonBody(request, this.maxRequestBytes, active.controller.signal)
      if (active.controller.signal.aborted) throw new RequestAbortedError()
      /* oxlint-disable typescript/no-deprecated --
       * The transport's checks repeat the bridge's explicit loopback Host and Origin validation.
       */
      transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [expectedHost],
        allowedOrigins: [`http://${expectedHost}`],
      })
      /* oxlint-enable typescript/no-deprecated */
      mcpServer = this.createMcpServer(request, active)
      // The SDK constructs this transport, but its optional callback fields do
      // not include `undefined` under exactOptionalPropertyTypes.
      await mcpServer.connect(transport as Transport)
      await transport.handleRequest(request, response, body)
    } catch (error) {
      if (error instanceof HttpRequestError) {
        rejectHttp(request, response, error.statusCode)
      } else if (!response.writableEnded && !response.destroyed) {
        rejectHttp(request, response, active.controller.signal.aborted ? 408 : 500)
      }
    } finally {
      clearTimeout(timeout)
      request.removeListener('aborted', onAborted)
      await responseSettled.promise
      await Promise.allSettled([
        transport === undefined ? Promise.resolve() : transport.close(),
        mcpServer === undefined ? Promise.resolve() : mcpServer.close(),
      ])
      try {
        await active.waitForActualOperations()
        active.releaseOwners()
      } finally {
        response.removeListener('finish', onFinished)
        response.removeListener('close', onClosed)
        response.removeListener('error', onResponseError)
        this.activeRequests.delete(active)
        active.settle()
      }
    }
  }

  // oxlint-disable-next-line typescript/no-deprecated -- Dynamic owner-local schemas need the SDK's advanced low-level Server.
  private createMcpServer(request: IncomingMessage, active: ActiveRequest): Server {
    // oxlint-disable-next-line typescript/no-deprecated -- Dynamic owner-local schemas need the SDK's advanced low-level Server.
    const server = new Server(
      { name: 'dsh-chatgpt-web', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: STATIC_TOOLS }))
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      const combined = combineSignals(active.controller.signal, extra.signal)
      try {
        const requestIdentity = requestIdentityFrom(request)
        if (requestIdentity === undefined) {
          throw new McpError(ErrorCode.InvalidParams, 'DSH request identity is required')
        }
        const owner = await ownerForRequest(this.resolveOwner, requestIdentity.proofId, combined.signal, active)
        switch (call.params.name) {
          case 'dsh_tools':
            assertEmptyArguments(call.params.arguments)
            return textResult(owner.tools)
          case 'dsh_execute': {
            const input = executeInput(call.params.arguments)
            const tool = owner.tools.find(candidate => candidate.name === input.name)
            if (tool === undefined) {
              throw new McpError(ErrorCode.InvalidParams, 'DSH tool is not available to this request')
            }
            const argumentsValue = validateToolArguments(tool, input.arguments)
            const result = await executeOwnerTool(
              owner,
              requestIdentity.proofId,
              tool.name,
              argumentsValue,
              combined.signal,
              webMcpCallId(requestIdentity.fullRequestId, extra.requestId),
              active,
            )
            return textResult(result)
          }
          default:
            throw new McpError(ErrorCode.MethodNotFound, 'MCP tool is not available')
        }
      } finally {
        combined.dispose()
      }
    })
    return server
  }

  private portForHost(): number {
    const address = this.server?.address()
    if (address === null || address === undefined || typeof address === 'string') {
      throw new HttpRequestError(503)
    }
    return address.port
  }
}

function activeRequest(): ActiveRequest {
  const done = Promise.withResolvers<void>()
  const operations = new Set<Promise<void>>()
  const owners: Array<{ readonly owner: ChatGptWebMcpBridgeOwner; released: boolean }> = []
  return {
    controller: new AbortController(),
    done: done.promise,
    track: (operation) => {
      const settled = operation.then(() => {}, () => {})
      operations.add(settled)
      void settled.finally(() => { operations.delete(settled) })
    },
    retain: (owner) => { owners.push({ owner, released: false }) },
    waitForActualOperations: async () => {
      while (operations.size > 0) await Promise.all([...operations])
    },
    releaseOwners: () => {
      for (const lease of owners) {
        if (lease.released) continue
        lease.released = true
        try {
          lease.owner.release()
        } catch (_ownerReleaseFailure) {
          // A broken lease release cannot prevent the remaining leases from reaching cleanup.
        }
      }
    },
    settle: done.resolve,
  }
}

function requirePort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new Error('ChatGPT web MCP bridge port must be an integer from 0 through 65535')
  }
  return value
}

function requirePath(value: string): string {
  if (
    value.length < 2
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || value.includes('?')
    || value.includes('#')
    || /(?:^|\/)\.\.?($|\/)/u.test(value)
  ) {
    throw new Error('ChatGPT web MCP bridge path must be one absolute request path')
  }
  return value
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`ChatGPT web MCP bridge ${label} must be a positive safe integer`)
  }
  return value
}

function requireTimer(value: number): number {
  const timeout = requirePositiveInteger(value, 'requestTimeoutMs')
  if (timeout > MAX_TIMER_DELAY_MS) {
    throw new Error(`ChatGPT web MCP bridge requestTimeoutMs must not exceed ${String(MAX_TIMER_DELAY_MS)}`)
  }
  return timeout
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name) values.push(request.rawHeaders[index + 1] ?? '')
  }
  return values.length === 1 ? values[0] : undefined
}

function hasExpectedHost(request: IncomingMessage, expectedHost: string): boolean {
  return singleHeader(request, 'host') === expectedHost
}

function hasLoopbackOrigin(request: IncomingMessage): boolean {
  const origin = singleHeader(request, 'origin')
  if (origin === undefined) return !request.rawHeaders.some((value, index) => index % 2 === 0 && value.toLowerCase() === 'origin')
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === '/'
      && parsed.search.length === 0
      && parsed.hash.length === 0
      && isLoopbackHostname(parsed.hostname)
  } catch {
    return false
  }
}

function isLoopbackHostname(value: string): boolean {
  return value === LOOPBACK_HOST || value === 'localhost' || value === '::1'
}

function hasJsonContentType(request: IncomingMessage): boolean {
  const contentType = singleHeader(request, 'content-type')
  return contentType !== undefined && /^application\/json(?:\s*;|\s*$)/iu.test(contentType)
}

function rejectHttp(request: IncomingMessage, response: ServerResponse, statusCode: number): void {
  if (!response.headersSent && !response.writableEnded && !response.destroyed) {
    response.writeHead(statusCode, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    })
    response.end(JSON.stringify({ error: 'ChatGPT web MCP request rejected' }))
  }
  request.resume()
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const declaredLength = singleHeader(request, 'content-length')
  if (declaredLength !== undefined) {
    if (!/^[0-9]+$/u.test(declaredLength)) throw new HttpRequestError(400)
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length > maxBytes) throw new HttpRequestError(413)
  }
  const chunks: Buffer[] = []
  let bytes = 0
  const body = await new Promise<Buffer>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        cleanup()
        request.resume()
        reject(new HttpRequestError(413))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (): void => {
      cleanup()
      reject(new HttpRequestError(400))
    }
    const onAborted = (): void => {
      cleanup()
      reject(new RequestAbortedError())
    }
    const onSignalAbort = (): void => {
      cleanup()
      reject(new RequestAbortedError())
    }
    const cleanup = (): void => {
      request.removeListener('data', onData)
      request.removeListener('end', onEnd)
      request.removeListener('error', onError)
      request.removeListener('aborted', onAborted)
      signal.removeEventListener('abort', onSignalAbort)
    }
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
    signal.addEventListener('abort', onSignalAbort, { once: true })
    if (signal.aborted) onSignalAbort()
  })
  if (body.length === 0) throw new HttpRequestError(400)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    throw new HttpRequestError(400)
  }
}

function requestIdentityFrom(request: IncomingMessage): { readonly proofId: string; readonly fullRequestId: string } | undefined {
  const value = singleHeader(request, 'x-request-id')
  if (value === undefined || Buffer.byteLength(value, 'utf8') > MAX_REQUEST_ID_BYTES) return undefined
  const separator = value.indexOf('/')
  const base = separator === -1 ? value : value.slice(0, separator)
  if (base.length === 0 || base.length > MAX_REQUEST_ID_BYTES || !REQUEST_ID_BASE.test(base)) return undefined
  return { proofId: base, fullRequestId: value }
}

function webMcpCallId(fullRequestId: string, jsonRpcRequestId: string | number): WebMcpCallId {
  return createHash('sha256').update(JSON.stringify([fullRequestId, jsonRpcRequestId])).digest('hex') as WebMcpCallId
}

function assertEmptyArguments(value: unknown): void {
  if (value === undefined) return
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    throw new McpError(ErrorCode.InvalidParams, 'dsh_tools accepts no arguments')
  }
}

function executeInput(value: unknown): { readonly name: string; readonly arguments: Record<string, unknown> } {
  if (!isRecord(value) || Object.keys(value).length !== 2 || !('name' in value) || !('arguments' in value)) {
    throw new McpError(ErrorCode.InvalidParams, 'dsh_execute arguments are invalid')
  }
  if (typeof value.name !== 'string' || value.name.trim().length === 0 || !isRecord(value.arguments)) {
    throw new McpError(ErrorCode.InvalidParams, 'dsh_execute arguments are invalid')
  }
  return { name: value.name, arguments: value.arguments }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateToolArguments(
  tool: PhysicalOperatorModelToolV1,
  argumentsValue: Record<string, unknown>,
): Record<string, unknown> {
  let validation
  try {
    validation = new AjvJsonSchemaValidator().getValidator<Record<string, unknown>>(
      tool.inputSchema,
    )(argumentsValue)
  } catch {
    throw new McpError(ErrorCode.InternalError, 'DSH tool schema is unavailable')
  }
  if (!validation.valid) {
    throw new McpError(ErrorCode.InvalidParams, 'DSH tool arguments are invalid')
  }
  return validation.data
}

function textResult(value: unknown): { readonly content: readonly [{ readonly type: 'text'; readonly text: string }] } {
  let text: unknown
  try {
    text = JSON.stringify(value)
  } catch {
    throw new McpError(ErrorCode.InternalError, 'DSH tool result is unavailable')
  }
  if (typeof text !== 'string') throw new McpError(ErrorCode.InternalError, 'DSH tool result is unavailable')
  return { content: [{ type: 'text', text }] }
}

async function ownerForRequest(
  resolveOwner: ChatGptWebMcpBridgeOptions['resolveOwner'],
  requestId: string,
  signal: AbortSignal,
  active: ActiveRequest,
): Promise<ChatGptWebMcpBridgeOwner> {
  try {
    const owner = await awaitWithSignal(resolveOwnerForRequest(resolveOwner, requestId, signal, active), signal)
    if (!isOwner(owner)) throw new Error('DSH request has no owner')
    return owner
  } catch {
    if (signal.aborted) throw new McpError(ErrorCode.RequestTimeout, 'DSH request was cancelled')
    throw new McpError(ErrorCode.InvalidParams, 'DSH request is not authorized')
  }
}

function isOwner(value: unknown): value is ChatGptWebMcpBridgeOwner {
  return isRecord(value)
    && Array.isArray(value.tools)
    && typeof value.release === 'function'
    && typeof value.execute === 'function'
}

function resolveOwnerForRequest(
  resolveOwner: ChatGptWebMcpBridgeOptions['resolveOwner'],
  requestId: string,
  signal: AbortSignal,
  active: ActiveRequest,
): Promise<ChatGptWebMcpBridgeOwner> {
  let operation: Promise<ChatGptWebMcpBridgeOwner>
  try {
    operation = resolveOwner(requestId, signal)
  } catch (error) {
    operation = Promise.reject(error instanceof Error ? error : new Error('DSH owner resolution failed'))
  }
  const observed = operation.then((owner) => {
    if (isOwner(owner)) active.retain(owner)
    return owner
  })
  active.track(observed)
  return observed
}

async function executeOwnerTool(
  owner: ChatGptWebMcpBridgeOwner,
  requestId: string,
  name: string,
  argumentsValue: Record<string, unknown>,
  signal: AbortSignal,
  callId: WebMcpCallId,
  active: ActiveRequest,
): Promise<unknown> {
  try {
    if (signal.aborted) throw new RequestAbortedError()
    let operation: Promise<unknown>
    try {
      operation = owner.execute(requestId, name, argumentsValue, signal, callId)
    } catch (error) {
      operation = Promise.reject(error instanceof Error ? error : new Error('DSH tool execution failed'))
    }
    active.track(operation)
    return await awaitWithSignal(operation, signal)
  } catch {
    if (signal.aborted) throw new McpError(ErrorCode.RequestTimeout, 'DSH request was cancelled')
    throw new McpError(ErrorCode.InternalError, 'DSH tool execution failed')
  }
}

function combineSignals(left: AbortSignal, right: AbortSignal): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  left.addEventListener('abort', abort, { once: true })
  right.addEventListener('abort', abort, { once: true })
  if (left.aborted || right.aborted) controller.abort()
  return {
    signal: controller.signal,
    dispose: () => {
      left.removeEventListener('abort', abort)
      right.removeEventListener('abort', abort)
    },
  }
}

function awaitWithSignal<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  if (signal.aborted) return Promise.reject(new RequestAbortedError())
  return new Promise<Value>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(new RequestAbortedError())
    }
    const onResolved = (value: Value): void => {
      cleanup()
      resolve(value)
    }
    const onRejected = (error: unknown): void => {
      cleanup()
      reject(error instanceof Error ? error : new Error('ChatGPT web MCP operation failed'))
    }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(onResolved, onRejected)
  })
}
