/** Owner-local bridge exposing one Agent's real DSH tool surface to a Resident product. */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'

interface Binding {
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly tools: ReadonlySet<string>
  readonly receipts: Map<string, { readonly hash: string; readonly result?: Promise<unknown> }>
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function requestHash(tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson({ tool, args })).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  throw new Error('model tool request contains a non-JSON value')
}

let nextEndpointId = 0

function socketPath(): { readonly path: string; readonly directory?: string } {
  const root = resolveDshHome(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  const endpointId = `${String(process.pid)}-${String(nextEndpointId++)}`
  if (process.platform === 'win32') {
    const identity = createHash('sha256').update(root).digest('hex').slice(0, 24)
    return { path: `\\\\.\\pipe\\dsh-model-tools-${identity}-${endpointId}` }
  }
  const directory = join(root, 'physical-operator')
  return { path: join(directory, `model-tools-${endpointId}.sock`), directory }
}

/** One bridge-owned stable endpoint. Bindings exist only while their Resident turn is attached. */
export class PhysicalOperatorModelToolBridge {
  private readonly endpoint = socketPath()
  private readonly bindings = new Map<string, Binding>()
  private readonly server: Server
  private ready: Promise<void> | undefined

  constructor(private readonly ctx: Context) {
    this.server = createServer((socket) => { this.accept(socket) })
  }

  /**
   * Bind the exact model-visible schemas for one durable Resident command.
   * @param commandId - durable command identity.
   * @param agent - owning Agent whose tool surface is exposed.
   * @param schemas - exact model-visible tool schemas.
   * @param signal - owning turn cancellation signal.
   * @returns the native bridge descriptor and an idempotent release handle.
   */
  async bind(
    commandId: string,
    agent: Agent,
    schemas: readonly ToolSchema[],
    signal: AbortSignal,
  ): Promise<{ readonly descriptor?: PhysicalOperatorModelToolBridgeV1; release(): void }> {
    if (schemas.length === 0) return { release: () => {} }
    await this.start()
    const sessionId = `${String(agent.id)}:${commandId}`
    const tools = schemas.map(schema => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.parameters,
    }))
    const binding: Binding = {
      agent,
      signal,
      tools: new Set(tools.map(tool => tool.name)),
      receipts: recoverReceipts(agent.session.events),
    }
    const current = this.bindings.get(sessionId)
    if (current !== undefined) throw new Error(`model tool bridge session is already attached: ${sessionId}`)
    this.bindings.set(sessionId, binding)
    let attached = true
    return {
      descriptor: { version: 1, socketPath: this.endpoint.path, sessionId, tools },
      release: () => {
        if (!attached) return
        attached = false
        if (this.bindings.get(sessionId) === binding) this.bindings.delete(sessionId)
      },
    }
  }

  /** Close the endpoint and remove only this bridge's socket file. */
  async dispose(): Promise<void> {
    this.bindings.clear()
    if (this.ready === undefined) return
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    if (process.platform !== 'win32') rmSync(this.endpoint.path, { force: true })
  }

  private start(): Promise<void> {
    this.ready ??= new Promise<void>((resolve, reject) => {
      if (this.endpoint.directory !== undefined) {
        mkdirSync(this.endpoint.directory, { recursive: true, mode: 0o700 })
        chmodSync(this.endpoint.directory, 0o700)
      }
      if (process.platform !== 'win32') rmSync(this.endpoint.path, { force: true })
      const onError = (error: Error): void => { reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.endpoint.path, () => {
        this.server.off('error', onError)
        if (process.platform !== 'win32') chmodSync(this.endpoint.path, 0o600)
        resolve()
      })
    })
    return this.ready
  }

  private accept(socket: Socket): void {
    const transport = new JsonRpcLineTransport(socket, socket)
    transport.onRequest((method, params) => {
      if (method !== 'tool.call') throw new Error(`unsupported model tool bridge method: ${method}`)
      return this.call(params)
    })
    socket.on('close', () => { transport.close() })
    transport.start()
  }

  private call(params: unknown): Promise<unknown> {
    const input = record(params, 'model tool bridge request')
    const sessionId = nonBlank(input.session_id, 'session_id')
    const commandId = nonBlank(input.command_id, 'command_id')
    const tool = nonBlank(input.tool, 'tool')
    const args = record(input.arguments, 'arguments')
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) throw new Error(`model tool bridge session is not attached: ${sessionId}`)
    if (!binding.tools.has(tool)) throw new Error(`model tool bridge did not seal tool ${JSON.stringify(tool)}`)
    const hash = requestHash(tool, args)
    const existing = binding.receipts.get(commandId)
    if (existing !== undefined) {
      if (existing.hash !== hash) throw new Error(`model tool command conflict: ${commandId}`)
      if (existing.result === undefined) throw new Error(`model tool command is indeterminate and will not be replayed: ${commandId}`)
      return existing.result
    }
    const result = this.execute(binding, commandId, tool, args)
    binding.receipts.set(commandId, { hash, result })
    return result
  }

  private async execute(
    binding: Binding,
    commandId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { agent } = binding
    agent.session.append('physical-operator/tool-call', {
      commandId,
      tool,
      arguments: args as Record<string, import('@deepseek-ai/dsh-session').JsonValue>,
    }, { ignorable: true })
    const result = await this.ctx.tools.execute({
      callId: CallId(commandId),
      name: tool,
      arguments: args,
      agent,
      signal: binding.signal,
    })
    const envelope = {
      isError: result.isError,
      content: result.content,
      ...result.isError ? { error: result.error } : { value: result.value },
      ...result.additionalContexts === undefined ? {} : { additionalContexts: result.additionalContexts },
      ...result.concludesTurn === true ? { concludesTurn: true } : {},
    }
    agent.session.append('physical-operator/tool-result', {
      commandId,
      tool,
      result: envelope as unknown as JsonValue,
    }, { ignorable: true })
    return envelope
  }
}

function recoverReceipts(events: readonly SessionEvent[]): Binding['receipts'] {
  const calls = new Map<string, { readonly hash: string; readonly tool: string }>()
  const receipts: Binding['receipts'] = new Map()
  for (const event of events) {
    if (event.type === 'physical-operator/tool-call') {
      const call = {
        hash: requestHash(event.data.tool, event.data.arguments),
        tool: event.data.tool,
      }
      calls.set(event.data.commandId, call)
      receipts.set(event.data.commandId, { hash: call.hash })
      continue
    }
    if (event.type !== 'physical-operator/tool-result') continue
    const call = calls.get(event.data.commandId)
    if (call === undefined || call.tool !== event.data.tool) continue
    receipts.set(event.data.commandId, {
      hash: call.hash,
      result: Promise.resolve(event.data.result),
    })
  }
  return receipts
}
