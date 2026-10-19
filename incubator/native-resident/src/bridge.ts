import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { ResidentError, type NativeToolBridge, type NativeToolDefinition } from './contracts.js'

const MAX_NETWORK_JSON_BYTES = 1024 * 1024
const MAX_RENDERED_CONTENT_BYTES = MAX_NETWORK_JSON_BYTES - 1024
const MAX_IDENTIFIER_LENGTH = 512
const MAX_TOOL_NAME_LENGTH = 256
const RECURSIVE_SCHEDULER_TOOLS = new Set(['solar_delegate', 'solar_coordinate', 'solar_resident'])

export interface BridgeDescriptor {
  readonly id: string
  /** Fixed loopback call endpoint. It never includes the bearer token. */
  readonly endpoint: string
  /** In-memory bearer secret for exactly one Host binding. */
  readonly token: string
  readonly tools: readonly NativeToolDefinition[]
}

export interface RemoteToolCallRequest {
  readonly commandId: string
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly signal: AbortSignal
}

export interface BridgeToolResult {
  readonly content: string
  readonly isError: boolean
}

/**
 * The daemon supplies this wrapper so it can persist an admission and receipt
 * before allowing an HTTP call to reach the live Harness Host.
 */
export type RemoteToolReceiptExecutor = (
  request: RemoteToolCallRequest,
  action: (signal: AbortSignal) => Promise<BridgeToolResult>,
) => Promise<BridgeToolResult>

interface Binding {
  readonly id: string
  readonly token: string
  readonly descriptor: BridgeDescriptor
  readonly agent: Agent
  readonly parentToken: ToolRunContext['token']
  readonly rootCallId: ToolRunContext['rootCallId']
  readonly parentSignal: AbortSignal
  readonly toolNames: ReadonlySet<string>
  readonly catalogFingerprint: string
}

interface BridgeRequest {
  readonly commandId: string
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
}

class BridgeInputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeInputError'
  }
}

/**
 * A process-local capability bridge from a Resident-native execution back into
 * the exact live Harness Agent that authorized it. It intentionally owns no
 * durable state; the Resident daemon owns receipts and replay fencing.
 */
export class HostToolBridge {
  private readonly bindings = new Map<string, Binding>()
  private readonly activeControllers = new Set<AbortController>()
  private readonly sockets = new Set<Socket>()
  private server?: Server
  private startPromise?: Promise<void>
  private closePromise?: Promise<void>
  private runtimeError?: Error
  private closed = false

  constructor(private readonly ctx: Context) {}

  async bind(
    bridgeId: string,
    exec: ToolRunContext,
    allowedTools?: readonly string[],
  ): Promise<BridgeDescriptor> {
    this.requireOpen()
    const id = requireText(bridgeId, 'bridge id', MAX_IDENTIFIER_LENGTH)
    const agent = exec.agent
    if (agent === undefined) {
      throw new ResidentError('BRIDGE_AGENT_REQUIRED', 'A Host tool bridge requires the live calling Agent.')
    }
    if (typeof exec.token !== 'symbol') {
      throw new ResidentError('BRIDGE_PARENT_REQUIRED', 'A Host tool bridge requires the parent Tool Runtime execution token.')
    }
    if (exec.signal.aborted) {
      throw new ResidentError('BRIDGE_PARENT_ABORTED', 'The parent Tool Runtime execution was already cancelled.')
    }
    this.requireLiveAgent(agent)
    const visibleSchemas = this.ctx.tools.schemas(agent)
    const requestedNames = allowedTools === undefined
      ? undefined
      : new Set(allowedTools.map((name) => requireText(name, 'allowed tool name', MAX_TOOL_NAME_LENGTH)))
    const visibleByName = new Map(visibleSchemas.map((schema) => [schema.name, schema] as const))

    if (requestedNames !== undefined) {
      for (const name of requestedNames) {
        if (!visibleByName.has(name)) {
          throw new ResidentError('BRIDGE_TOOL_UNAVAILABLE', `Tool ${name} is not visible to the bound Agent.`)
        }
      }
    }

    const tools = visibleSchemas
      .filter((schema) => requestedNames === undefined
        ? !RECURSIVE_SCHEDULER_TOOLS.has(schema.name)
        : requestedNames.has(schema.name))
      .map((schema) => toNativeToolDefinition(schema))
    const catalogFingerprint = JSON.stringify(tools)
    const existing = this.bindings.get(id)
    if (existing !== undefined) return this.reuseExistingBinding(existing, agent, tools, catalogFingerprint)

    await this.ensureServer()
    this.requireOpen()
    const concurrentBinding = this.bindings.get(id)
    if (concurrentBinding !== undefined) return this.reuseExistingBinding(concurrentBinding, agent, tools, catalogFingerprint)

    const token = randomBytes(32).toString('base64url')
    const descriptor = Object.freeze({
      id,
      endpoint: this.endpoint(),
      token,
      tools: freezeTools(tools),
    })
    const binding: Binding = {
      id,
      token,
      descriptor,
      agent,
      parentToken: exec.token,
      rootCallId: exec.rootCallId,
      parentSignal: exec.signal,
      toolNames: new Set(tools.map((tool) => tool.name)),
      catalogFingerprint,
    }
    this.bindings.set(id, binding)

    return descriptor
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    this.closed = true
    this.bindings.clear()
    for (const controller of this.activeControllers) controller.abort(new Error('Host tool bridge closed'))
    for (const socket of this.sockets) socket.destroy()

    const start = this.startPromise
    if (start !== undefined) {
      try {
        await start
      } catch {
        // The server never became reachable, so there is nothing to close.
      }
    }

    const server = this.server
    this.server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error)
        else resolve()
      })
    })
  }

  private async ensureServer(): Promise<void> {
    if (this.server !== undefined) return
    if (this.startPromise !== undefined) return this.startPromise

    const server = createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    server.on('connection', (socket) => {
      if (this.closed) {
        socket.destroy()
        return
      }
      this.sockets.add(socket)
      socket.once('close', () => this.sockets.delete(socket))
    })
    server.on('error', (error) => this.recordServerError(error))
    this.server = server

    this.startPromise = new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        cleanup()
        resolve()
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const cleanup = (): void => {
        server.off('listening', onListening)
        server.off('error', onError)
      }
      server.once('listening', onListening)
      server.once('error', onError)
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true })
    })

    try {
      await this.startPromise
    } catch (error) {
      this.server = undefined
      server.close()
      throw error
    } finally {
      this.startPromise = undefined
    }
  }

  private endpoint(): string {
    const address = this.server?.address()
    if (!address || typeof address === 'string' || address.port <= 0) {
      throw new ResidentError('BRIDGE_UNAVAILABLE', 'The Host tool bridge did not obtain a loopback port.')
    }
    return `http://127.0.0.1:${address.port}/call`
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.closed) return sendFailure(response, 410, 'The Host tool bridge is closed.')
      if (this.runtimeError !== undefined) return sendFailure(response, 503, 'The Host tool bridge is unavailable.')
      if (!isLoopbackRequest(request)) return sendFailure(response, 403, 'The bridge only accepts loopback requests.')
      if (request.method !== 'POST' || request.url !== '/call') {
        return sendFailure(response, 404, 'The bridge call endpoint was not found.')
      }

      const binding = this.bindingForAuthorization(request.headers.authorization)
      if (binding === undefined) return sendFailure(response, 401, 'Bridge authentication failed.')
      if (!isJsonContentType(request.headers['content-type'])) {
        return sendFailure(response, 415, 'Bridge requests must use application/json.')
      }

      const payload = parseBridgeRequest(await readJsonBody(request))
      if (this.closed || this.bindings.get(binding.id) !== binding || !this.isLive(binding)) {
        this.bindings.delete(binding.id)
        return sendFailure(response, 410, 'The bound Host Agent is no longer live.')
      }
      if (!binding.toolNames.has(payload.name)) {
        return sendFailure(response, 403, 'This tool is not available to the bridge.')
      }

      const linked = this.linkRequestCancellation(binding.parentSignal, request, response)
      try {
        const result = await this.ctx.tools.execute({
          callId: asToolCallId(namespaceToolCallId(payload.commandId, payload.callId)),
          rootCallId: binding.rootCallId,
          agent: binding.agent,
          parent: binding.parentToken,
          name: payload.name,
          arguments: payload.arguments,
          signal: linked.signal,
        })
        return sendResult(response, renderToolResult(result.content, result.isError))
      } finally {
        linked.dispose()
      }
    } catch (error) {
      if (error instanceof BridgeInputError) return sendFailure(response, error.status, error.message)
      // A thrown ToolRuntime body is normalized by ctx.tools.execute. Anything
      // reaching here is a transport/runtime fault, so avoid exposing details.
      return sendFailure(response, 500, 'The Host tool bridge could not settle the call.')
    }
  }

  private bindingForAuthorization(header: string | undefined): Binding | undefined {
    const candidate = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : ''
    let matched: Binding | undefined
    for (const binding of this.bindings.values()) {
      if (safeTokenEqual(binding.token, candidate)) matched = binding
    }
    return matched
  }

  private isLive(binding: Binding): boolean {
    if (binding.parentSignal.aborted) return false
    try {
      return this.ctx.agents.get(binding.agent.id) === binding.agent
    } catch {
      return false
    }
  }

  private requireLiveAgent(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new ResidentError('BRIDGE_AGENT_NOT_LIVE', 'The calling Agent is not the current live Agent for this bridge.')
    }
  }

  private linkRequestCancellation(parent: AbortSignal, request: IncomingMessage, response: ServerResponse): {
    readonly signal: AbortSignal
    dispose(): void
  } {
    const controller = new AbortController()
    const abort = (signal?: AbortSignal): void => {
      if (!controller.signal.aborted) controller.abort(signal?.reason)
    }
    const onParentAbort = (): void => abort(parent)
    const onRequestAbort = (): void => abort()
    if (parent.aborted) abort(parent)
    else parent.addEventListener('abort', onParentAbort, { once: true })
    request.once('aborted', onRequestAbort)
    response.once('close', onRequestAbort)
    this.activeControllers.add(controller)
    return {
      signal: controller.signal,
      dispose: () => {
        parent.removeEventListener('abort', onParentAbort)
        request.off('aborted', onRequestAbort)
        response.off('close', onRequestAbort)
        this.activeControllers.delete(controller)
      },
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new ResidentError('BRIDGE_CLOSED', 'The Host tool bridge is closed.')
    if (this.runtimeError !== undefined) {
      throw new ResidentError('BRIDGE_SERVER_ERROR', `The Host tool bridge server failed: ${this.runtimeError.message}`)
    }
  }

  private reuseExistingBinding(
    existing: Binding,
    agent: Agent,
    tools: readonly NativeToolDefinition[],
    catalogFingerprint: string,
  ): BridgeDescriptor {
    if (existing.agent !== agent || existing.catalogFingerprint !== catalogFingerprint) {
      throw new ResidentError('BRIDGE_ID_CONFLICT', `Host tool bridge ${existing.id} is already bound by another Agent or tool catalog.`)
    }
    if (!this.isLive(existing)) {
      throw new ResidentError('BRIDGE_BINDING_EXPIRED', `Host tool bridge ${existing.id} has no live parent execution.`)
    }
    // Compare the complete catalog after the digest comparison so a future
    // digest implementation cannot accidentally equate distinct schemas.
    if (JSON.stringify(existing.descriptor.tools) !== JSON.stringify(tools)) {
      throw new ResidentError('BRIDGE_ID_CONFLICT', `Host tool bridge ${existing.id} is already bound with a different tool catalog.`)
    }
    return existing.descriptor
  }

  private recordServerError(error: Error): void {
    if (this.runtimeError === undefined) this.runtimeError = error
    this.ctx.logger.error('native-resident: Host tool bridge server error: %s', error.message)
  }
}

/**
 * Build the daemon-facing bridge. The optional receipt executor must be the
 * daemon's durable receipt owner; this module never creates a database.
 */
export function createRemoteToolBridge(
  descriptor: BridgeDescriptor,
  receiptExecutor?: RemoteToolReceiptExecutor,
): NativeToolBridge {
  requireText(descriptor.id, 'bridge id', MAX_IDENTIFIER_LENGTH)
  const endpoint = validateLoopbackEndpoint(descriptor.endpoint)
  const token = requireText(descriptor.token, 'bridge token', MAX_IDENTIFIER_LENGTH)
  const tools = freezeTools(normalizeNativeTools(descriptor.tools))

  return Object.freeze({
    tools,
    async call(request: RemoteToolCallRequest): Promise<BridgeToolResult> {
      const normalized = normalizeRemoteRequest(request)
      const action = async (receiptSignal: AbortSignal): Promise<BridgeToolResult> => {
        const linked = linkSignals([normalized.signal, receiptSignal])
        try {
          return await callLoopbackEndpoint(endpoint, token, normalized, linked.signal)
        } finally {
          linked.dispose()
        }
      }
      try {
        return receiptExecutor === undefined
          ? await action(normalized.signal)
          : await receiptExecutor(normalized, action)
      } catch (error) {
        if (error instanceof ResidentError) throw error
        throw new ResidentError('COMMAND_INDETERMINATE', 'The Host tool bridge transport did not settle.')
      }
    },
  })
}

/** Create a collision-free Host Tool Runtime call id without exposing a token. */
export function namespaceToolCallId(commandId: string, callId: string): string {
  return `solar-native:${commandId.length}:${commandId}:${callId.length}:${callId}`
}

function toNativeToolDefinition(schema: { readonly name: string; readonly description: string; readonly parameters: unknown }): NativeToolDefinition {
  const name = requireText(schema.name, 'tool name', MAX_TOOL_NAME_LENGTH)
  if (typeof schema.description !== 'string') {
    throw new ResidentError('BRIDGE_SCHEMA_INVALID', `Tool ${name} has no serializable description.`)
  }
  const inputSchema = cloneJson(schema.parameters, `tool ${name} input schema`)
  if (!isPlainRecord(inputSchema)) {
    throw new ResidentError('BRIDGE_SCHEMA_INVALID', `Tool ${name} input schema must be an object.`)
  }
  return Object.freeze({ name, description: schema.description, inputSchema: freezeJson(inputSchema) as Record<string, unknown> })
}

function normalizeNativeTools(tools: readonly NativeToolDefinition[]): NativeToolDefinition[] {
  if (!Array.isArray(tools)) throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', 'Bridge tools must be an array.')
  const names = new Set<string>()
  return tools.map((tool) => {
    if (!isPlainRecord(tool)) throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', 'Bridge tool definitions must be objects.')
    const name = requireText(tool.name, 'bridge tool name', MAX_TOOL_NAME_LENGTH)
    if (names.has(name)) throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', `Bridge tool ${name} is duplicated.`)
    names.add(name)
    if (typeof tool.description !== 'string') {
      throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', `Bridge tool ${name} has no description.`)
    }
    const inputSchema = cloneJson(tool.inputSchema, `bridge tool ${name} input schema`)
    if (!isPlainRecord(inputSchema)) {
      throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', `Bridge tool ${name} input schema must be an object.`)
    }
    return Object.freeze({ name, description: tool.description, inputSchema: freezeJson(inputSchema) as Record<string, unknown> })
  })
}

function normalizeRemoteRequest(request: RemoteToolCallRequest): RemoteToolCallRequest {
  if (!isPlainRecord(request)) throw new ResidentError('BRIDGE_REQUEST_INVALID', 'Bridge tool request must be an object.')
  if (!isAbortSignal(request.signal)) throw new ResidentError('BRIDGE_REQUEST_INVALID', 'Bridge tool request requires an AbortSignal.')
  return Object.freeze({
    commandId: requireText(request.commandId, 'commandId', MAX_IDENTIFIER_LENGTH),
    callId: requireText(request.callId, 'callId', MAX_IDENTIFIER_LENGTH),
    name: requireText(request.name, 'tool name', MAX_TOOL_NAME_LENGTH),
    arguments: freezeJson(cloneJson(request.arguments, 'tool arguments')),
    signal: request.signal,
  })
}

async function callLoopbackEndpoint(
  endpoint: URL,
  token: string,
  request: RemoteToolCallRequest,
  signal: AbortSignal,
): Promise<BridgeToolResult> {
  const body = JSON.stringify({
    commandId: request.commandId,
    callId: request.callId,
    name: request.name,
    arguments: request.arguments,
  })
  if (Buffer.byteLength(body) > MAX_NETWORK_JSON_BYTES) {
    throw new ResidentError('BRIDGE_REQUEST_INVALID', 'Bridge request exceeds the 1 MiB JSON limit.')
  }

  let response: Response
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body,
      signal,
    })
  } catch {
    throw new ResidentError('COMMAND_INDETERMINATE', 'The Host tool bridge transport did not return a response.')
  }

  if (response.status >= 500 || response.status < 200) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResidentError('COMMAND_INDETERMINATE', 'The Host tool bridge did not confirm whether the call settled.')
  }
  if (!isJsonContentType(response.headers.get('content-type') ?? undefined)) {
    await response.body?.cancel().catch(() => undefined)
    throw new ResidentError('COMMAND_INDETERMINATE', 'The Host tool bridge returned a non-JSON response.')
  }

  let text: string
  try {
    text = await readResponseText(response)
  } catch {
    throw new ResidentError('COMMAND_INDETERMINATE', 'The Host tool bridge response could not be read safely.')
  }
  try {
    return parseBridgeResult(JSON.parse(text) as unknown)
  } catch {
    throw new ResidentError('COMMAND_INDETERMINATE', 'The Host tool bridge response was not a valid settled result.')
  }
}

function parseBridgeRequest(value: unknown): BridgeRequest {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['commandId', 'callId', 'name', 'arguments'])) {
    throw new BridgeInputError(400, 'Bridge request has an invalid shape.')
  }
  if (!Object.hasOwn(value, 'arguments')) throw new BridgeInputError(400, 'Bridge request is missing arguments.')
  return Object.freeze({
    commandId: requireBridgeText(value.commandId, 'commandId', MAX_IDENTIFIER_LENGTH),
    callId: requireBridgeText(value.callId, 'callId', MAX_IDENTIFIER_LENGTH),
    name: requireBridgeText(value.name, 'tool name', MAX_TOOL_NAME_LENGTH),
    arguments: freezeJson(cloneJson(value.arguments, 'bridge arguments')),
  })
}

function parseBridgeResult(value: unknown): BridgeToolResult {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['content', 'isError']) || typeof value.content !== 'string' || typeof value.isError !== 'boolean') {
    throw new Error('invalid bridge result')
  }
  return Object.freeze({ content: value.content, isError: value.isError })
}

function renderToolResult(content: readonly unknown[], isError: boolean): BridgeToolResult {
  const rendered = content.map((block) => {
    if (isPlainRecord(block) && block.type === 'text' && typeof block.text === 'string') return block.text
    return JSON.stringify(block)
  }).join('\n')
  if (Buffer.byteLength(rendered) > MAX_RENDERED_CONTENT_BYTES) {
    return Object.freeze({
      content: 'Error: Host tool result exceeds the bridge response size limit.',
      isError: true,
    })
  }
  return Object.freeze({ content: rendered, isError })
}

function sendResult(response: ServerResponse, result: BridgeToolResult): void {
  sendJson(response, 200, result)
}

function sendFailure(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { content: `Error: ${message}`, isError: true })
}

function sendJson(response: ServerResponse, status: number, payload: BridgeToolResult): void {
  if (response.writableEnded) return
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const declaredLength = request.headers['content-length']
  if (declaredLength !== undefined) {
    const value = Array.isArray(declaredLength) ? declaredLength[0] : declaredLength
    if (value === undefined || !/^\d+$/.test(value) || Number(value) > MAX_NETWORK_JSON_BYTES) {
      throw new BridgeInputError(413, 'Bridge request exceeds the 1 MiB JSON limit.')
    }
  }
  const chunks: Buffer[] = []
  let bytes = 0
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('error', onError)
      request.off('aborted', onAborted)
      if (error === undefined) resolve()
      else reject(error)
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.byteLength
      if (bytes > MAX_NETWORK_JSON_BYTES) {
        request.resume()
        finish(new BridgeInputError(413, 'Bridge request exceeds the 1 MiB JSON limit.'))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = (): void => finish()
    const onError = (): void => finish(new BridgeInputError(400, 'Bridge request could not be read.'))
    const onAborted = (): void => finish(new BridgeInputError(400, 'Bridge request was aborted.'))
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('error', onError)
    request.once('aborted', onAborted)
  })
  if (bytes === 0) throw new BridgeInputError(400, 'Bridge request body is required.')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new BridgeInputError(400, 'Bridge request body is not valid JSON.')
  }
}

async function readResponseText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_NETWORK_JSON_BYTES)) {
    throw new Error('oversized bridge response')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_NETWORK_JSON_BYTES) {
        await reader.cancel()
        throw new Error('oversized bridge response')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

function validateLoopbackEndpoint(raw: string): URL {
  const endpoint = requireText(raw, 'bridge endpoint', MAX_IDENTIFIER_LENGTH)
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', 'Bridge endpoint is not a valid URL.')
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/call'
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', 'Bridge endpoint must be an exact loopback /call URL.')
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ResidentError('BRIDGE_DESCRIPTOR_INVALID', 'Bridge endpoint has an invalid loopback port.')
  }
  return url
}

function linkSignals(signals: readonly AbortSignal[]): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const listeners = new Map<AbortSignal, () => void>()
  const abort = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason)
  }
  for (const signal of signals) {
    if (signal.aborted) abort(signal)
    else {
      const listener = (): void => abort(signal)
      listeners.set(signal, listener)
      signal.addEventListener('abort', listener, { once: true })
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener('abort', listener)
    },
  }
}

function freezeTools(tools: readonly NativeToolDefinition[]): readonly NativeToolDefinition[] {
  return Object.freeze([...tools])
}

function cloneJson(value: unknown, label: string): unknown {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new ResidentError('BRIDGE_REQUEST_INVALID', `${label} must be JSON-serializable.`)
  }
  if (serialized === undefined) throw new ResidentError('BRIDGE_REQUEST_INVALID', `${label} must be JSON-serializable.`)
  try {
    return JSON.parse(serialized) as unknown
  } catch {
    throw new ResidentError('BRIDGE_REQUEST_INVALID', `${label} must be JSON-serializable.`)
  }
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) freezeJson(entry)
  } else if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) freezeJson(entry)
  }
  return Object.freeze(value)
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0 || Buffer.byteLength(value) > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ResidentError('BRIDGE_REQUEST_INVALID', `${label} must be non-empty text within ${maxLength} bytes.`)
  }
  return value
}

function requireBridgeText(value: unknown, label: string, maxLength: number): string {
  try {
    return requireText(value, label, maxLength)
  } catch {
    throw new BridgeInputError(400, `Bridge ${label} is invalid.`)
  }
}

function safeTokenEqual(expected: string, candidate: string): boolean {
  const expectedBuffer = Buffer.from(expected)
  const candidateBuffer = Buffer.from(candidate)
  const sameLength = candidateBuffer.byteLength === expectedBuffer.byteLength
  const compared = sameLength ? candidateBuffer : Buffer.alloc(expectedBuffer.byteLength)
  return timingSafeEqual(expectedBuffer, compared) && sameLength
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1'
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value[0] : value
  return typeof header === 'string' && header.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object' && value !== null
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every((key) => allowed.has(key))
}

function asToolCallId(value: string): ToolRunContext['callId'] {
  // ToolCallId is a runtime string brand; the public Tool Runtime receives the
  // opaque namespaced value and validates/owns the rest of the execution.
  return value as ToolRunContext['callId']
}
