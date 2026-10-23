import {
  createSdkMcpServer as publicCreateSdkMcpServer,
  type McpServerConfig,
  query as publicClaudeQuery,
  tool as publicClaudeTool,
  type ModelInfo,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { resolve as resolvePath } from 'node:path'
import { z, type ZodType } from 'zod/v4'

import type {
  NativeAccess,
  DriverRequest,
  NativeDriver,
  NativeModel,
  NativeProfile,
  NativeToolBridge,
  NativeToolDefinition,
  TaskResult,
} from '../contracts.js'
import { ResidentError } from '../contracts.js'
import { DRIVER_ERROR_CODE, driverError, errorMessage } from './errors.js'

export type ClaudeQueryFunction = typeof publicClaudeQuery

export interface ClaudeMcpFactory {
  readonly createSdkMcpServer: (options: { readonly name: string; readonly version?: string; readonly tools?: readonly unknown[] }) => unknown
  readonly tool: (
    name: string,
    description: string,
    inputSchema: Record<string, ZodType>,
    handler: (arguments_: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) => unknown
}

export interface ClaudeNativeDriverOptions {
  /** Optional public Claude Code executable override. */
  readonly executable?: string
  /** Internal injection seam for deterministic SDK tests. */
  readonly query?: ClaudeQueryFunction
  /** Internal injection seam for deterministic SDK-MCP bridge tests. */
  readonly mcpFactory?: ClaudeMcpFactory
}

/** Native Claude Agent SDK adapter. Authentication and transcripts remain SDK-owned. */
export class ClaudeNativeDriver implements NativeDriver {
  readonly #executable: string | undefined
  readonly #query: ClaudeQueryFunction
  readonly #mcpFactory: ClaudeMcpFactory

  constructor(options: ClaudeNativeDriverOptions = {}) {
    this.#executable = options.executable
    this.#query = options.query ?? publicClaudeQuery
    this.#mcpFactory = options.mcpFactory ?? defaultMcpFactory
  }

  /** Reads the native SDK model catalog through an idle stream; it submits no prompt. */
  async models(cwd: string): Promise<readonly NativeModel[]> {
    return (await this.#catalog(cwd)).map((model) => toNativeModel(model))
  }

  async execute(request: DriverRequest): Promise<TaskResult> {
    if (request.signal.aborted) {
      throw driverError(DRIVER_ERROR_CODE.COMMAND_CANCELLED, 'Claude command was cancelled before native dispatch')
    }

    const abortController = new AbortController()
    let query: ClaudeQuery | undefined
    let nativeEffectDispatched = false
    let cancellationRequested = false
    let interruptRequested = false

    const interruptNative = (): void => {
      if (!query || interruptRequested) return
      interruptRequested = true
      void query.interrupt().catch(() => {
        // Iterator completion without a terminal SDK result is classified below as indeterminate.
      })
    }

    const onAbort = (): void => {
      cancellationRequested = true
      abortController.abort()
      interruptNative()
    }

    let removeBridgeFenceListener: (() => void) | undefined
    try {
      const bridgeServer = request.bridge ? prepareClaudeBridge(request.bridge, request, this.#mcpFactory) : undefined
      const profile = await this.#validateProfile(request.profile, request.cwd)
      const options: ClaudeOptions = {
        cwd: request.cwd,
        persistSession: true,
        abortController,
        permissionMode: 'dontAsk',
        ...(request.nativeSessionId ? { resume: request.nativeSessionId } : {}),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.reasoningEffort ? { effort: profile.reasoningEffort } : {}),
        ...(bridgeServer ? { mcpServers: { [CLAUDE_BRIDGE_SERVER_NAME]: bridgeServer.server as McpServerConfig } } : {}),
        ...claudeAllowedTools(request.access, bridgeServer?.allowedTools ?? []),
        ...(this.#executable ? { pathToClaudeCodeExecutable: this.#executable } : {}),
      }

      request.signal.addEventListener('abort', onAbort, { once: true })
      if (request.signal.aborted) onAbort()
      if (request.signal.aborted) {
        throw driverError(DRIVER_ERROR_CODE.COMMAND_CANCELLED, 'Claude command was cancelled before native dispatch')
      }

      nativeEffectDispatched = true
      query = this.#query({ prompt: request.prompt, options })
      removeBridgeFenceListener = bridgeServer?.fence.subscribe(() => {
        abortController.abort()
        interruptNative()
      })
      const fenceAtDispatch = bridgeServer?.fence.error()
      if (fenceAtDispatch) {
        abortController.abort()
        interruptNative()
        throw fenceAtDispatch
      }

      let nativeSessionId: string | undefined
      let sawInit = false
      let sessionWasRecorded = false
      const iterator = query[Symbol.asyncIterator]()
      for (;;) {
        const next = bridgeServer
          ? await Promise.race([iterator.next(), bridgeServer.fence.wait])
          : await iterator.next()
        if (next.done) break
        const message = next.value
        const bridgeFailure = bridgeServer?.fence.error()
        if (bridgeFailure) throw bridgeFailure
        if (isInit(message)) {
          if (normalizeCwd(message.cwd) !== normalizeCwd(request.cwd)) {
            throw driverError(
              DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
              `Claude native session cwd ${message.cwd} does not match requested cwd ${request.cwd}`,
            )
          }
          sawInit = true
          if (nativeSessionId && nativeSessionId !== message.session_id) {
            throw driverError(
              DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
              `Claude emitted conflicting native session ${message.session_id}`,
            )
          }
          nativeSessionId = message.session_id
          if (request.nativeSessionId && nativeSessionId !== request.nativeSessionId) {
            throw driverError(
              DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
              `Claude resumed unexpected native session ${nativeSessionId}`,
            )
          }
          if (!request.nativeSessionId && nativeSessionId === message.session_id && !sessionWasRecorded) {
            try {
              request.onSession(nativeSessionId)
              sessionWasRecorded = true
            } catch (error) {
              throw driverError(
                DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
                `Could not persist Claude native session after dispatch: ${errorMessage(error)}`,
              )
            }
          }
          continue
        }

        if (message.type !== 'result') continue
        if (!sawInit || !nativeSessionId) {
          throw driverError(
            DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
            'Claude returned a terminal result before a native session init event',
          )
        }
        if (message.session_id !== nativeSessionId) {
          throw driverError(
            DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
            `Claude terminal result belongs to unexpected native session ${message.session_id}`,
          )
        }

        if (message.subtype === 'success' && !message.is_error) {
          const bridgeFailure = bridgeServer?.fence.error()
          if (bridgeFailure) throw bridgeFailure
          return { output: message.result, nativeSessionId }
        }
        if (cancellationRequested) {
          throw driverError(DRIVER_ERROR_CODE.COMMAND_CANCELLED, 'Claude native turn reached a terminal result after cancellation')
        }
        const detail = message.subtype === 'success' ? message.result : message.errors.join('; ')
        throw driverError(DRIVER_ERROR_CODE.COMMAND_FAILED, `Claude native turn failed${detail ? `: ${detail}` : ''}`)
      }

      throw driverError(
        DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
        'Claude native stream ended without a terminal result',
      )
    } catch (error) {
      if (error instanceof ResidentError) throw error
      throw driverError(
        nativeEffectDispatched ? DRIVER_ERROR_CODE.COMMAND_INDETERMINATE : DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE,
        `Claude native driver failed: ${errorMessage(error)}`,
      )
    } finally {
      request.signal.removeEventListener('abort', onAbort)
      removeBridgeFenceListener?.()
      try {
        query?.close()
      } catch {
        // Close is a best-effort SDK cleanup after a settled or indeterminate command.
      }
    }
  }

  async #catalog(cwd: string): Promise<readonly ModelInfo[]> {
    let query: ClaudeQuery | undefined
    try {
      query = this.#query({
        prompt: idlePrompt(),
        options: {
          cwd,
          persistSession: false,
          permissionMode: 'dontAsk',
          ...(this.#executable ? { pathToClaudeCodeExecutable: this.#executable } : {}),
        },
      })
      return await query.supportedModels()
    } catch (error) {
      throw driverError(DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE, `Claude model catalog is unavailable: ${errorMessage(error)}`)
    } finally {
      try {
        query?.close()
      } catch {
        // Catalog cleanup has no model turn to reconcile.
      }
    }
  }

  async #validateProfile(
    profile: NativeProfile | undefined,
    cwd: string,
  ): Promise<{ readonly model?: string; readonly reasoningEffort?: ClaudeOptions['effort'] }> {
    const normalized = normalizeProfile(profile)
    if (!normalized.model && !normalized.reasoningEffort) return {}
    if (!normalized.model) {
      throw driverError(
        DRIVER_ERROR_CODE.PROFILE_INVALID,
        'Claude reasoningEffort requires an explicit model so it can be validated without selecting a default',
      )
    }
    const catalog = await this.#catalog(cwd)
    const selected = catalog.find((model) => model.value === normalized.model || model.resolvedModel === normalized.model)
    if (!selected) {
      throw driverError(DRIVER_ERROR_CODE.PROFILE_INVALID, `Claude model ${normalized.model} is not in the native catalog`)
    }
    if (normalized.reasoningEffort && !selected.supportedEffortLevels?.includes(normalized.reasoningEffort as NonNullable<ClaudeOptions['effort']>)) {
      throw driverError(
        DRIVER_ERROR_CODE.PROFILE_INVALID,
        `Claude model ${normalized.model} does not advertise reasoning effort ${normalized.reasoningEffort}`,
      )
    }
    return {
      model: normalized.model,
      ...(normalized.reasoningEffort ? { reasoningEffort: normalized.reasoningEffort as NonNullable<ClaudeOptions['effort']> } : {}),
    }
  }
}

function idlePrompt(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: () => new Promise<IteratorResult<SDKUserMessage>>(() => undefined),
      }
    },
  }
}

function toNativeModel(model: ModelInfo): NativeModel {
  return {
    id: model.value,
    name: model.displayName,
    ...(model.supportedEffortLevels?.length ? { reasoningEfforts: model.supportedEffortLevels } : {}),
  }
}

function normalizeProfile(profile: NativeProfile | undefined): { readonly model?: string; readonly reasoningEffort?: string } {
  if (!profile) return {}
  const model = profile.model
  const reasoningEffort = profile.reasoningEffort
  if (model !== undefined && (typeof model !== 'string' || !model.trim())) {
    throw driverError(DRIVER_ERROR_CODE.PROFILE_INVALID, 'Native profile model must be a non-empty string')
  }
  if (reasoningEffort !== undefined && (typeof reasoningEffort !== 'string' || !reasoningEffort.trim())) {
    throw driverError(DRIVER_ERROR_CODE.PROFILE_INVALID, 'Native profile reasoningEffort must be a non-empty string')
  }
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  }
}

const defaultMcpFactory: ClaudeMcpFactory = {
  createSdkMcpServer: publicCreateSdkMcpServer as unknown as ClaudeMcpFactory['createSdkMcpServer'],
  tool: publicClaudeTool as unknown as ClaudeMcpFactory['tool'],
}

const CLAUDE_BRIDGE_SERVER_NAME = 'dsh-native-resident'

interface ClaudeBridgeCall {
  readonly fingerprint: string
  readonly result: Promise<{ readonly content: string; readonly isError: boolean }>
}

interface ClaudeBridgeFence {
  readonly wait: Promise<never>
  error(): ResidentError | undefined
  trip(error: ResidentError): ResidentError
  subscribe(listener: () => void): () => void
}

interface PreparedClaudeBridge {
  readonly server: unknown
  /** Exact public Claude MCP wire names, and no native tool names. */
  readonly allowedTools: readonly string[]
  readonly fence: ClaudeBridgeFence
}

function prepareClaudeBridge(
  bridge: NativeToolBridge,
  request: DriverRequest,
  factory: ClaudeMcpFactory,
): PreparedClaudeBridge {
  const tools = validateClaudeBridge(bridge)
  const calls = new Map<string, ClaudeBridgeCall>()
  const fence = claudeBridgeFence()
  const sdkTools = tools.map((definition) => factory.tool(
    definition.name,
    definition.description,
    zodShape(definition),
    async (arguments_, extra) => {
      const alreadyFenced = fence.error()
      if (alreadyFenced) throw alreadyFenced
      const callId = readClaudeToolCallId(extra)
      if (!callId) return bridgeFailure('Claude SDK did not provide a tool call identity')

      const fingerprint = `${definition.name}:${stableJson(arguments_)}`
      const existing = calls.get(callId)
      if (existing && existing.fingerprint !== fingerprint) {
        return bridgeFailure(`Tool call id ${callId} conflicts with an earlier request`)
      }
      const pending = existing?.result ?? Promise.resolve().then(() => bridge.call({
        commandId: request.commandId,
        callId,
        name: definition.name,
        arguments: arguments_,
        signal: request.signal,
      }))
      if (!existing) calls.set(callId, { fingerprint, result: pending })
      try {
        const result = normalizeBridgeResult(await pending)
        return {
          content: [{ type: 'text', text: result.content }],
          isError: result.isError,
        }
      } catch (error) {
        if (isIndeterminateBridgeError(error)) throw fence.trip(error)
        return bridgeFailure(`Bridge tool ${definition.name} failed: ${errorMessage(error)}`)
      }
    },
  ))
  return {
    server: factory.createSdkMcpServer({ name: CLAUDE_BRIDGE_SERVER_NAME, version: '1', tools: sdkTools }),
    allowedTools: tools.map((definition) => `mcp__${CLAUDE_BRIDGE_SERVER_NAME}__${definition.name}`),
    fence,
  }
}

function claudeBridgeFence(): ClaudeBridgeFence {
  let failure: ResidentError | undefined
  let rejectWait!: (reason: Error) => void
  const wait = new Promise<never>((_resolve, reject) => {
    rejectWait = reject
  })
  const listeners = new Set<() => void>()
  void wait.catch(() => undefined)
  return {
    wait,
    error: () => failure,
    trip: (error) => {
      if (!failure) {
        failure = error
        rejectWait(error)
        for (const listener of listeners) {
          try {
            listener()
          } catch {
            // A listener only stops a local native process; the fence remains authoritative.
          }
        }
        listeners.clear()
      }
      return failure
    },
    subscribe: (listener) => {
      if (failure) listener()
      else listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

function isIndeterminateBridgeError(error: unknown): error is ResidentError {
  return error instanceof ResidentError && error.code === DRIVER_ERROR_CODE.COMMAND_INDETERMINATE
}

function validateClaudeBridge(bridge: NativeToolBridge): readonly NativeToolDefinition[] {
  if (!Array.isArray(bridge.tools) || bridge.tools.length === 0 || typeof bridge.call !== 'function') {
    throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, 'Native tool bridge must provide at least one callable tool')
  }
  const names = new Set<string>()
  for (const definition of bridge.tools) {
    if (!definition || typeof definition.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(definition.name)) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, 'Native tool bridge contains an invalid tool name')
    }
    if (names.has(definition.name)) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool bridge repeats ${definition.name}`)
    }
    names.add(definition.name)
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool ${definition.name} has no description`)
    }
    assertObjectSchema(definition.inputSchema, definition.name)
  }
  return bridge.tools
}

function zodShape(definition: NativeToolDefinition): Record<string, ZodType> {
  const schema = assertObjectSchema(definition.inputSchema, definition.name)
  const properties = schema.properties === undefined ? {} : requireRecord(schema.properties, `${definition.name}.inputSchema.properties`)
  const required = schema.required === undefined ? new Set<string>() : readRequired(schema.required, definition.name)
  const shape: Record<string, ZodType> = {}
  for (const [name, property] of Object.entries(properties)) {
    let value = zodFromSchema(property, `${definition.name}.inputSchema.properties.${name}`)
    if (!required.has(name)) value = value.optional()
    shape[name] = value
  }
  for (const name of required) {
    if (!(name in properties)) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool ${definition.name} requires undeclared property ${name}`)
    }
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw driverError(
      DRIVER_ERROR_CODE.BRIDGE_INVALID,
      `Native tool ${definition.name} inputSchema must set additionalProperties to false for the SDK bridge`,
    )
  }
  return shape
}

function zodFromSchema(value: unknown, label: string): ZodType {
  const schema = requireRecord(value, label)
  const type = schema.type
  if (type === 'string') {
    const enumValues = schema.enum
    if (enumValues !== undefined) {
      if (!Array.isArray(enumValues) || enumValues.length === 0 || !enumValues.every((entry) => typeof entry === 'string')) {
        throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label}.enum must be a non-empty string array`)
      }
      return z.enum(enumValues as [string, ...string[]])
    }
    return z.string()
  }
  if (type === 'number') return z.number()
  if (type === 'integer') return z.number().int()
  if (type === 'boolean') return z.boolean()
  if (type === 'array') {
    if (schema.items === undefined) throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label}.items is required`)
    return z.array(zodFromSchema(schema.items, `${label}.items`))
  }
  if (type === 'object') {
    const properties = schema.properties === undefined ? {} : requireRecord(schema.properties, `${label}.properties`)
    const required = schema.required === undefined ? new Set<string>() : readRequired(schema.required, label)
    const shape: Record<string, ZodType> = {}
    for (const [name, property] of Object.entries(properties)) {
      let child = zodFromSchema(property, `${label}.properties.${name}`)
      if (!required.has(name)) child = child.optional()
      shape[name] = child
    }
    for (const name of required) {
      if (!(name in properties)) throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label} requires undeclared property ${name}`)
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label} must set additionalProperties to false`)
    }
    return z.object(shape).strict()
  }
  throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label}.type is unsupported by the Claude SDK bridge`)
}

function assertObjectSchema(value: unknown, toolName: string): Record<string, unknown> {
  const schema = requireRecord(value, `${toolName}.inputSchema`)
  if (schema.type !== 'object') {
    throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool ${toolName} inputSchema.type must be object`)
  }
  return schema
}

function readRequired(value: unknown, label: string): Set<string> {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label}.required must be a string array`)
  }
  return new Set(value)
}

function readClaudeToolCallId(extra: unknown): string | undefined {
  const record = asRecord(extra)
  // Public MCP RequestHandlerExtra supplies the JSON-RPC requestId. Prefer it:
  // it identifies the actual MCP invocation even when no Claude tool-use id is
  // present. NativeToolBridge uses strings, so numeric JSON-RPC ids are encoded.
  const direct = firstCallId(
    record?.requestId,
    record?.request_id,
    record?.toolUseId,
    record?.toolUseID,
    record?.tool_use_id,
    record?.callId,
    record?.call_id,
  )
  if (direct) return direct
  const toolUse = asRecord(record?.toolUse) ?? asRecord(record?.toolUseBlock)
  return firstCallId(toolUse?.id, toolUse?.toolUseId, toolUse?.tool_use_id)
}

function bridgeFailure(text: string): { readonly content: readonly [{ readonly type: 'text'; readonly text: string }]; readonly isError: true } {
  return { content: [{ type: 'text', text }], isError: true }
}

function normalizeBridgeResult(value: unknown): { readonly content: string; readonly isError: boolean } {
  const result = asRecord(value)
  if (!result || typeof result.content !== 'string' || typeof result.isError !== 'boolean') {
    throw new Error('bridge returned an invalid result')
  }
  return { content: result.content, isError: result.isError }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '<undefined>'
  } catch {
    return '<non-json>'
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value)
  if (!record) throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `${label} must be an object`)
  return record
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function firstCallId(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}

function isInit(message: SDKMessage): message is Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
  return message.type === 'system' && message.subtype === 'init' && typeof message.session_id === 'string' && message.session_id.length > 0
}

function normalizeCwd(cwd: string): string {
  return resolvePath(cwd)
}

/** Claude Code file-editing tools auto-allowed for a workspace-write node. */
export const CLAUDE_EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const

/**
 * Tools auto-allowed under permissionMode 'dontAsk': the bridged DSH tools,
 * plus the editing tools when the node may write. allowedTools only adds
 * approvals; it does not restrict the read tools.
 * @param access - the node's file access.
 * @param bridged - bridged MCP tool names.
 * @returns an options fragment, empty when nothing is auto-allowed.
 */
export function claudeAllowedTools(access: NativeAccess, bridged: readonly string[]): { allowedTools?: string[] } {
  const tools = [...bridged, ...(access === 'workspace-write' ? CLAUDE_EDIT_TOOLS : [])]
  return tools.length === 0 ? {} : { allowedTools: tools }
}
