import { spawn as spawnChild } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'

import type {
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

type JsonRecord = Record<string, unknown>

export interface CodexChildProcess {
  readonly stdin: NodeJS.WritableStream | null
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr?: NodeJS.ReadableStream | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill?(signal?: NodeJS.Signals): boolean
}

export interface CodexSpawnOptions {
  readonly cwd: string
  readonly stdio: 'pipe'
}

export type CodexSpawner = (
  executable: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => CodexChildProcess

export interface CodexNativeDriverOptions {
  /** Public `codex` CLI executable. Defaults to @openai/codex's declared bin. */
  readonly executable?: string
  /** Internal injection seam for deterministic protocol tests. */
  readonly spawn?: CodexSpawner
}

class AppServerTransportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppServerTransportError'
  }
}

class AppServerProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppServerProtocolError'
  }
}

class AppServerRpcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppServerRpcError'
  }
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
}

interface AppServerInboundMessage {
  readonly method: string
  readonly params: unknown
  /** Present only when app-server is requesting a client response. */
  readonly requestId?: number | string
}

type AppServerNotificationListener = (message: AppServerInboundMessage) => void

class JsonlAppServer {
  readonly #readline: ReadLineInterface
  readonly #pending = new Map<number, PendingRequest>()
  readonly #listeners = new Set<AppServerNotificationListener>()
  readonly #terminated: Promise<never>
  readonly #rejectTerminated: (reason: Error) => void
  #nextId = 1
  #closed = false
  #closing = false

  constructor(readonly child: CodexChildProcess) {
    let rejectTerminated!: (reason: Error) => void
    this.#terminated = new Promise<never>((_resolve, reject) => {
      rejectTerminated = reject
    })
    this.#rejectTerminated = rejectTerminated
    // The driver races this promise once a native turn exists. Avoid an
    // unhandled rejection if the transport dies earlier during initialization.
    void this.#terminated.catch(() => undefined)

    if (!child.stdin || !child.stdout) {
      throw new AppServerTransportError('Codex app-server did not provide piped stdin/stdout')
    }

    this.#readline = createInterface({ input: child.stdout, crlfDelay: Infinity })
    this.#readline.on('line', (line) => this.#receiveLine(line))
    this.#readline.on('close', () => {
      if (!this.#closing) this.#fail(new AppServerTransportError('Codex app-server closed stdout before a terminal result'))
    })

    child.on('error', (error) => this.#fail(new AppServerTransportError(`Codex app-server failed: ${error.message}`)))
    child.on('exit', (code, signal) => {
      if (!this.#closing) {
        const detail = signal ? `signal ${signal}` : `exit code ${String(code)}`
        this.#fail(new AppServerTransportError(`Codex app-server exited with ${detail}`))
      }
    })

    const stderr = child.stderr as (NodeJS.ReadableStream & { resume?: () => unknown }) | undefined
    stderr?.resume?.()
    const stdin = child.stdin as (NodeJS.WritableStream & { on?: (event: string, listener: (error: Error) => void) => unknown })
    stdin.on?.('error', (error) => this.#fail(new AppServerTransportError(`Codex app-server stdin failed: ${error.message}`)))
  }

  request(method: string, params: JsonRecord): Promise<unknown> {
    if (this.#closed) return Promise.reject(new AppServerTransportError('Codex app-server transport is closed'))

    const id = this.#nextId++
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      this.#pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest })
      try {
        this.#write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        rejectRequest(error instanceof Error ? error : new AppServerTransportError(errorMessage(error)))
      }
    })
  }

  notify(method: string, params: JsonRecord): void {
    this.#write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number | string, result: JsonRecord): void {
    this.#write({ jsonrpc: '2.0', id, result })
  }

  /** Declines an app-server request without fabricating an approval or input. */
  respondError(id: number | string, code: number, message: string): void {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  subscribe(listener: AppServerNotificationListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  get terminated(): Promise<never> {
    return this.#terminated
  }

  close(): void {
    if (this.#closing) return
    this.#closing = true
    this.#readline.close()
    try {
      this.child.stdin?.end()
    } catch {
      // The child is already gone; this is only cleanup after settlement.
    }
    try {
      this.child.kill?.('SIGTERM')
    } catch {
      // The child is already gone; this is only cleanup after settlement.
    }
  }

  /**
   * Fail every outstanding request before terminating the child. This is used
   * for cancellation while setup is waiting for an app-server response.
   */
  abort(reason: Error): void {
    this.#fail(reason)
    this.close()
  }

  #write(message: JsonRecord): void {
    if (this.#closed || !this.child.stdin) {
      throw new AppServerTransportError('Codex app-server stdin is unavailable')
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  #receiveLine(line: string): void {
    if (this.#closed || !line.trim()) return

    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.#fail(new AppServerProtocolError('Codex app-server emitted malformed JSONL'))
      return
    }
    if (!isRecord(message)) {
      this.#fail(new AppServerProtocolError('Codex app-server emitted a non-object JSONL message'))
      return
    }

    if (typeof message.method === 'string') {
      const inbound: AppServerInboundMessage = {
        method: message.method,
        params: message.params,
        ...(typeof message.id === 'number' || typeof message.id === 'string' ? { requestId: message.id } : {}),
      }
      for (const listener of this.#listeners) {
        try {
          listener(inbound)
        } catch (error) {
          this.#fail(
            error instanceof Error
              ? error
              : new AppServerProtocolError(`Codex notification handler failed: ${errorMessage(error)}`),
          )
          return
        }
      }
      return
    }

    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id)
      if (!pending) return
      this.#pending.delete(message.id)
      if ('error' in message) {
        pending.reject(new AppServerRpcError(readRpcError(message.error)))
      } else if ('result' in message) {
        pending.resolve(message.result)
      } else {
        pending.reject(new AppServerProtocolError(`Codex app-server response to ${pending.method} has neither result nor error`))
      }
      return
    }

    this.#fail(new AppServerProtocolError('Codex app-server emitted a message without a method or numeric response id'))
  }

  #fail(error: Error): void {
    if (this.#closed || this.#closing) return
    this.#closed = true
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
    this.#rejectTerminated(error)
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
  readonly settled: () => boolean
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason: Error) => void
  let isSettled = false
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = (value) => {
      if (!isSettled) {
        isSettled = true
        resolve(value)
      }
    }
    rejectPromise = (error) => {
      if (!isSettled) {
        isSettled = true
        reject(error)
      }
    }
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise, settled: () => isSettled }
}

function bridgeFence(): BridgeFence {
  const stopped = deferred<never>()
  let failure: ResidentError | undefined
  // A fence is raced by the active turn; keep a handler while no turn is
  // running so an early bridge failure never becomes an unhandled rejection.
  void stopped.promise.catch(() => undefined)
  return {
    wait: stopped.promise,
    error: () => failure,
    trip: (error) => {
      if (!failure) {
        failure = error
        stopped.reject(error)
      }
      return failure
    },
  }
}

function isIndeterminateBridgeError(error: unknown): error is ResidentError {
  return error instanceof ResidentError && error.code === DRIVER_ERROR_CODE.COMMAND_INDETERMINATE
}

interface TurnTerminal {
  readonly turnId: string
  readonly status: string
  readonly message?: string
}

interface OutputEvent {
  readonly turnId?: string
  readonly text: string
  readonly completed: boolean
}

interface CodexCatalogModel {
  readonly native: NativeModel
  readonly acceptedIds: readonly string[]
}

interface CodexProfile {
  /** Fields supported by thread/start and thread/resume in Codex 0.153.4. */
  readonly thread: JsonRecord
  /** Fields supported by turn/start in Codex 0.153.4. */
  readonly turn: JsonRecord
}

interface PreparedBridgeCall {
  readonly fingerprint: string
  readonly result: Promise<{ readonly content: string; readonly isError: boolean }>
}

interface BridgeFence {
  readonly wait: Promise<never>
  error(): ResidentError | undefined
  trip(error: ResidentError): ResidentError
}

interface PreparedBridge {
  readonly bridge: NativeToolBridge
  readonly toolsByName: ReadonlyMap<string, NativeToolDefinition>
  readonly dynamicTools: readonly JsonRecord[]
  readonly calls: Map<string, PreparedBridgeCall>
  readonly fence: BridgeFence
}

/** Native Codex app-server adapter. It only uses the public JSONL protocol. */
export class CodexNativeDriver implements NativeDriver {
  readonly #executable: string
  readonly #spawn: CodexSpawner

  constructor(options: CodexNativeDriverOptions = {}) {
    this.#executable = options.executable ?? resolvePublicCodexBin()
    this.#spawn = options.spawn ?? defaultCodexSpawn
  }

  /** Reads the public app-server catalog without creating a thread or model turn. */
  async models(cwd: string): Promise<readonly NativeModel[]> {
    let transport: JsonlAppServer | undefined
    try {
      transport = new JsonlAppServer(this.#spawn(this.#executable, ['app-server'], { cwd, stdio: 'pipe' }))
      await initializeCodex(transport, false)
      return (await readCodexCatalog(transport)).map((model) => model.native)
    } catch (error) {
      if (error instanceof ResidentError) throw error
      if (error instanceof AppServerProtocolError || error instanceof AppServerRpcError) {
        throw driverError(DRIVER_ERROR_CODE.NATIVE_PROTOCOL_ERROR, error.message)
      }
      if (error instanceof AppServerTransportError) {
        throw driverError(DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE, error.message)
      }
      throw driverError(DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE, `Codex model catalog is unavailable: ${errorMessage(error)}`)
    } finally {
      transport?.close()
    }
  }

  async execute(request: DriverRequest): Promise<TaskResult> {
    if (request.signal.aborted) {
      throw driverError(DRIVER_ERROR_CODE.COMMAND_CANCELLED, 'Codex command was cancelled before native dispatch')
    }

    const bridge = prepareBridge(request.bridge)
    let transport: JsonlAppServer | undefined
    let nativeEffectDispatched = false
    let removeAbortListener: (() => void) | undefined
    let unsubscribe: (() => void) | undefined
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined
    const startupAbort = deferred<never>()
    void startupAbort.promise.catch(() => undefined)
    let phase: 'startup' | 'session-request' | 'ready' | 'turn-request' | 'turn-active' = 'startup'
    let cancellationRequested = false
    let requestInterrupt: (() => void) | undefined

    const onAbort = (): void => {
      cancellationRequested = true
      if (phase === 'turn-active') {
        requestInterrupt?.()
        return
      }
      const error = phase === 'session-request' || phase === 'turn-request'
        ? driverError(
            DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
            'Codex cancellation arrived while a native request outcome was not confirmed',
          )
        : driverError(DRIVER_ERROR_CODE.COMMAND_CANCELLED, 'Codex command was cancelled before native turn dispatch')
      startupAbort.reject(error)
      transport?.abort(error)
    }
    const awaitSetup = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, startupAbort.promise])

    try {
      const activeTransport = new JsonlAppServer(this.#spawn(this.#executable, ['app-server'], { cwd: request.cwd, stdio: 'pipe' }))
      transport = activeTransport
      request.signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => request.signal.removeEventListener('abort', onAbort)
      if (request.signal.aborted) onAbort()

      await awaitSetup(initializeCodex(activeTransport, bridge !== undefined))
      const profile = await awaitSetup(validateCodexProfile(activeTransport, request.profile))
      // A thread request can create or attach durable native state. If its
      // transport result is lost, do not let the scheduler replay the command.
      nativeEffectDispatched = true
      phase = 'session-request'
      const sessionResponse = request.nativeSessionId
        ? await awaitSetup(activeTransport.request('thread/resume', {
            threadId: request.nativeSessionId,
            cwd: request.cwd,
            approvalPolicy: 'never',
            sandbox: request.access,
            excludeTurns: true,
            ...profile.thread,
          }))
        : await awaitSetup(activeTransport.request('thread/start', {
            cwd: request.cwd,
            ephemeral: false,
            approvalPolicy: 'never',
            sandbox: request.access,
            ...(bridge ? { dynamicTools: bridge.dynamicTools } : {}),
            ...profile.thread,
          }))

      const nativeSessionId = readThreadId(sessionResponse)
      assertResponseCwd(sessionResponse, request.cwd)
      if (request.nativeSessionId && nativeSessionId !== request.nativeSessionId) {
        throw driverError(
          DRIVER_ERROR_CODE.NATIVE_PROTOCOL_ERROR,
          `Codex resumed unexpected native session ${nativeSessionId}`,
        )
      }
      if (!request.nativeSessionId) {
        try {
          request.onSession(nativeSessionId)
        } catch (error) {
          throw driverError(
            DRIVER_ERROR_CODE.NATIVE_SESSION_PERSISTENCE_FAILED,
            `Could not persist Codex native session before dispatch: ${errorMessage(error)}`,
          )
        }
      }

      phase = 'ready'
      if (request.signal.aborted) {
        onAbort()
        await startupAbort.promise
      }

      const terminal = deferred<TurnTerminal>()
      const fatal = deferred<never>()
      void fatal.promise.catch(() => undefined)
      const terminalsBeforeTurnId: TurnTerminal[] = []
      const outputEvents: OutputEvent[] = []
      let turnId: string | undefined
      let interruptRequested = false
      let fatalError: ResidentError | undefined

      const settleTerminal = (candidate: TurnTerminal): void => {
        if (!turnId) {
          terminalsBeforeTurnId.push(candidate)
          return
        }
        if (candidate.turnId === turnId) terminal.resolve(candidate)
      }

      const stopIndeterminate = (error: ResidentError): void => {
        if (fatalError) return
        fatalError = error
        fatal.reject(error)
        requestInterrupt?.()
      }

      requestInterrupt = (): void => {
        if (!turnId || interruptRequested || (terminal.settled() && !fatalError)) return
        interruptRequested = true
        void activeTransport.request('turn/interrupt', { threadId: nativeSessionId, turnId }).catch((error: unknown) => {
          stopIndeterminate(
            driverError(
              DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
              `Codex cancellation acknowledgement was unavailable: ${errorMessage(error)}`,
            ),
          )
        })
        if (cancellationRequested && cancellationTimer === undefined) {
          cancellationTimer = setTimeout(() => {
            stopIndeterminate(
              driverError(
                DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
                'Codex did not confirm native turn interruption before the cancellation acknowledgement deadline',
              ),
            )
          }, 5_000)
        }
      }

      const declineUnsupportedServerRequest = (message: AppServerInboundMessage): void => {
        let detail = `Codex requested unsupported interaction ${message.method}`
        if (message.requestId !== undefined) {
          try {
            activeTransport.respondError(message.requestId, -32000, `${detail}; Resident declines interactive approvals and input`)
          } catch (error) {
            detail = `${detail}; the decline response could not be delivered: ${errorMessage(error)}`
          }
        }
        stopIndeterminate(driverError(DRIVER_ERROR_CODE.COMMAND_INDETERMINATE, detail))
      }

      unsubscribe = activeTransport.subscribe((message) => {
        if (message.method === 'item/tool/call') {
          if (!bridge || message.requestId === undefined) {
            declineUnsupportedServerRequest(message)
          } else {
            void respondToCodexToolCall(activeTransport, bridge, request, message).catch((error: unknown) => {
              stopIndeterminate(
                isIndeterminateBridgeError(error)
                  ? error
                  : driverError(
                      DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
                      `Codex dynamic tool response could not be delivered: ${errorMessage(error)}`,
                    ),
              )
            })
          }
          return
        }
        if (message.requestId !== undefined) {
          declineUnsupportedServerRequest(message)
          return
        }
        const parsedTerminal = readTerminal(message.method, message.params, nativeSessionId)
        if (parsedTerminal) settleTerminal(parsedTerminal)
        const output = readOutputEvent(message.method, message.params, nativeSessionId)
        if (output) outputEvents.push(output)
      })

      phase = 'turn-request'
      const turnResponse = await Promise.race([
        activeTransport.request('turn/start', {
          threadId: nativeSessionId,
          input: [{ type: 'text', text: request.prompt }],
          ...profile.turn,
        }),
        startupAbort.promise,
        fatal.promise,
      ])
      turnId = readTurnId(turnResponse)
      phase = 'turn-active'
      for (const candidate of terminalsBeforeTurnId) settleTerminal(candidate)
      if (fatalError) {
        requestInterrupt()
        throw fatalError
      }
      if (cancellationRequested) requestInterrupt()

      const completed = await Promise.race([terminal.promise, activeTransport.terminated, fatal.promise])
      if (fatalError || bridge?.fence.error()) {
        throw fatalError ?? bridge?.fence.error()!
      }
      if (cancellationTimer !== undefined) {
        clearTimeout(cancellationTimer)
        cancellationTimer = undefined
      }
      const output = selectOutput(outputEvents, turnId)
      switch (completed.status) {
        case 'completed':
          return { output, nativeSessionId }
        case 'failed':
          throw driverError(
            DRIVER_ERROR_CODE.COMMAND_FAILED,
            `Codex native turn failed${completed.message ? `: ${completed.message}` : ''}`,
          )
        case 'interrupted':
          throw driverError(
            cancellationRequested ? DRIVER_ERROR_CODE.COMMAND_CANCELLED : DRIVER_ERROR_CODE.COMMAND_INTERRUPTED,
            `Codex native turn was interrupted${completed.message ? `: ${completed.message}` : ''}`,
          )
        default:
          throw driverError(
            DRIVER_ERROR_CODE.COMMAND_INDETERMINATE,
            `Codex reported an unknown terminal status ${completed.status}`,
          )
      }
    } catch (error) {
      if (error instanceof ResidentError) throw error
      if (error instanceof AppServerProtocolError) {
        throw driverError(
          nativeEffectDispatched ? DRIVER_ERROR_CODE.COMMAND_INDETERMINATE : DRIVER_ERROR_CODE.NATIVE_PROTOCOL_ERROR,
          error.message,
        )
      }
      if (error instanceof AppServerRpcError) {
        throw driverError(
          nativeEffectDispatched ? DRIVER_ERROR_CODE.COMMAND_FAILED : DRIVER_ERROR_CODE.NATIVE_PROTOCOL_ERROR,
          error.message,
        )
      }
      if (error instanceof AppServerTransportError) {
        throw driverError(
          nativeEffectDispatched ? DRIVER_ERROR_CODE.COMMAND_INDETERMINATE : DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE,
          error.message,
        )
      }
      throw driverError(
        nativeEffectDispatched ? DRIVER_ERROR_CODE.COMMAND_INDETERMINATE : DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE,
        `Codex native driver failed: ${errorMessage(error)}`,
      )
    } finally {
      if (cancellationTimer !== undefined) clearTimeout(cancellationTimer)
      removeAbortListener?.()
      unsubscribe?.()
      transport?.close()
    }
  }
}

async function initializeCodex(transport: JsonlAppServer, experimentalApi: boolean): Promise<void> {
  await transport.request('initialize', {
    clientInfo: { name: 'dsh-solar-native-resident', version: '1' },
    capabilities: experimentalApi ? { experimentalApi: true } : {},
  })
  transport.notify('initialized', {})
}

async function readCodexCatalog(transport: JsonlAppServer): Promise<readonly CodexCatalogModel[]> {
  const models: CodexCatalogModel[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  do {
    const response = await transport.request('model/list', {
      limit: 100,
      includeHidden: true,
      ...(cursor ? { cursor } : {}),
    })
    const root = expectRecord(response, 'Codex model/list response')
    if (!Array.isArray(root.data)) throw new AppServerProtocolError('Codex model/list response.data is not an array')
    for (const entry of root.data) models.push(readCodexCatalogModel(entry))

    if (root.nextCursor === null || root.nextCursor === undefined) {
      cursor = undefined
    } else if (typeof root.nextCursor === 'string' && root.nextCursor) {
      if (seenCursors.has(root.nextCursor)) {
        throw new AppServerProtocolError('Codex model/list response repeated a pagination cursor')
      }
      seenCursors.add(root.nextCursor)
      cursor = root.nextCursor
    } else {
      throw new AppServerProtocolError('Codex model/list response.nextCursor is invalid')
    }
  } while (cursor)
  return models
}

function readCodexCatalogModel(value: unknown): CodexCatalogModel {
  const model = expectRecord(value, 'Codex model/list entry')
  const canonicalId = expectString(model.model, 'Codex model/list entry.model')
  const internalId = expectString(model.id, 'Codex model/list entry.id')
  const displayName = typeof model.displayName === 'string' && model.displayName ? model.displayName : undefined
  const isDefault = typeof model.isDefault === 'boolean'
    ? model.isDefault
    : typeof model.default === 'boolean'
      ? model.default
      : undefined
  if (!Array.isArray(model.supportedReasoningEfforts)) {
    throw new AppServerProtocolError('Codex model/list entry.supportedReasoningEfforts is not an array')
  }
  const reasoningEfforts = model.supportedReasoningEfforts.map((entry) => {
    const effort = expectRecord(entry, 'Codex model reasoning effort')
    return expectString(effort.reasoningEffort, 'Codex model reasoning effort.reasoningEffort')
  })
  return {
    native: {
      id: canonicalId,
      ...(displayName ? { name: displayName } : {}),
      ...(isDefault === undefined ? {} : { isDefault }),
      ...(reasoningEfforts.length > 0 ? { reasoningEfforts } : {}),
    },
    acceptedIds: [...new Set([canonicalId, internalId])],
  }
}

async function validateCodexProfile(transport: JsonlAppServer, profile: NativeProfile | undefined): Promise<CodexProfile> {
  const normalized = normalizeProfile(profile)
  if (!normalized.model && !normalized.reasoningEffort) return { thread: {}, turn: {} }
  if (!normalized.model) {
    throw driverError(
      DRIVER_ERROR_CODE.PROFILE_INVALID,
      'Codex reasoningEffort requires an explicit model so it can be validated without selecting a default',
    )
  }

  const catalog = await readCodexCatalog(transport)
  const selected = catalog.find((model) => model.acceptedIds.includes(normalized.model!))
  if (!selected) {
    throw driverError(DRIVER_ERROR_CODE.PROFILE_INVALID, `Codex model ${normalized.model} is not in the native catalog`)
  }
  if (normalized.reasoningEffort && !selected.native.reasoningEfforts?.includes(normalized.reasoningEffort)) {
    throw driverError(
      DRIVER_ERROR_CODE.PROFILE_INVALID,
      `Codex model ${normalized.model} does not advertise reasoning effort ${normalized.reasoningEffort}`,
    )
  }
  return {
    // Codex 0.153.4 accepts model on both the persistent thread request and
    // the current turn. Reasoning effort is accepted only by turn/start.
    thread: { model: normalized.model },
    turn: {
      model: normalized.model,
      ...(normalized.reasoningEffort ? { effort: normalized.reasoningEffort } : {}),
    },
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

function prepareBridge(bridge: NativeToolBridge | undefined): PreparedBridge | undefined {
  if (!bridge) return undefined
  if (!Array.isArray(bridge.tools) || bridge.tools.length === 0 || typeof bridge.call !== 'function') {
    throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, 'Native tool bridge must provide at least one callable tool')
  }

  const toolsByName = new Map<string, NativeToolDefinition>()
  const dynamicTools: JsonRecord[] = []
  for (const tool of bridge.tools) {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, 'Native tool bridge contains an invalid tool name')
    }
    if (toolsByName.has(tool.name)) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool bridge repeats ${tool.name}`)
    }
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool ${tool.name} has no description`)
    }
    const inputSchema = cloneJsonSchema(tool.inputSchema, tool.name)
    if (inputSchema.type !== 'object') {
      throw driverError(DRIVER_ERROR_CODE.BRIDGE_INVALID, `Native tool ${tool.name} inputSchema.type must be object`)
    }
    toolsByName.set(tool.name, tool)
    dynamicTools.push({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema,
    })
  }
  return { bridge, toolsByName, dynamicTools, calls: new Map(), fence: bridgeFence() }
}

async function respondToCodexToolCall(
  transport: JsonlAppServer,
  bridge: PreparedBridge,
  request: DriverRequest,
  message: AppServerInboundMessage,
): Promise<void> {
  const requestId = message.requestId
  if (requestId === undefined) throw new AppServerProtocolError('Codex dynamic tool request has no JSON-RPC id')
  const fenced = bridge.fence.error()
  if (fenced) throw fenced

  const parsed = parseCodexToolCall(message.params)
  let result: { readonly content: string; readonly isError: boolean }
  if (!parsed.ok) {
    result = { content: parsed.message, isError: true }
  } else if (!bridge.toolsByName.has(parsed.name)) {
    result = { content: `Tool ${parsed.name} is not allowed by this Resident bridge`, isError: true }
  } else {
    const fingerprint = `${parsed.name}:${stableJson(parsed.arguments)}`
    const existing = bridge.calls.get(parsed.callId)
    if (existing && existing.fingerprint !== fingerprint) {
      result = { content: `Tool call id ${parsed.callId} conflicts with an earlier request`, isError: true }
    } else {
      const resultPromise = existing?.result ?? Promise.resolve().then(() => bridge.bridge.call({
        commandId: request.commandId,
        callId: parsed.callId,
        name: parsed.name,
        arguments: parsed.arguments,
        signal: request.signal,
      }))
      if (!existing) bridge.calls.set(parsed.callId, { fingerprint, result: resultPromise })
      try {
        result = normalizeBridgeResult(await resultPromise)
      } catch (error) {
        if (isIndeterminateBridgeError(error)) throw bridge.fence.trip(error)
        result = { content: `Bridge tool ${parsed.name} failed: ${errorMessage(error)}`, isError: true }
      }
    }
  }
  transport.respond(requestId, {
    contentItems: [{ type: 'inputText', text: result.content }],
    success: !result.isError,
  })
}

function parseCodexToolCall(params: unknown):
  | { readonly ok: true; readonly callId: string; readonly name: string; readonly arguments: unknown }
  | { readonly ok: false; readonly message: string } {
  const record = asRecord(params)
  if (!record) return { ok: false, message: 'Codex dynamic tool request is not an object' }
  if (typeof record.callId !== 'string' || !record.callId) return { ok: false, message: 'Codex dynamic tool request has no callId' }
  if (typeof record.tool !== 'string' || !record.tool) return { ok: false, message: 'Codex dynamic tool request has no tool name' }
  if (!('arguments' in record)) return { ok: false, message: 'Codex dynamic tool request has no arguments' }
  return { ok: true, callId: record.callId, name: record.tool, arguments: record.arguments }
}

function normalizeBridgeResult(value: unknown): { readonly content: string; readonly isError: boolean } {
  const result = asRecord(value)
  if (!result || typeof result.content !== 'string' || typeof result.isError !== 'boolean') {
    throw new Error('bridge returned an invalid result')
  }
  return { content: result.content, isError: result.isError }
}

function cloneJsonSchema(schema: Record<string, unknown>, toolName: string): JsonRecord {
  try {
    const cloned: unknown = JSON.parse(JSON.stringify(schema))
    if (!isRecord(cloned)) throw new Error('schema is not an object')
    return cloned
  } catch (error) {
    throw driverError(
      DRIVER_ERROR_CODE.BRIDGE_INVALID,
      `Native tool ${toolName} inputSchema is not JSON-serializable: ${errorMessage(error)}`,
    )
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '<undefined>'
  } catch {
    return '<non-json>'
  }
}

function defaultCodexSpawn(executable: string, args: readonly string[], options: CodexSpawnOptions): CodexChildProcess {
  return spawnChild(executable, [...args], options) as unknown as CodexChildProcess
}

function resolvePublicCodexBin(): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@openai/codex/package.json')
  const manifest = require(manifestPath) as { readonly bin?: string | Record<string, string> }
  const declaredBin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.codex
  if (!declaredBin) {
    throw driverError(DRIVER_ERROR_CODE.NATIVE_UNAVAILABLE, '@openai/codex does not declare a codex CLI bin')
  }
  return resolve(dirname(manifestPath), declaredBin)
}

function readThreadId(response: unknown): string {
  const root = expectRecord(response, 'Codex thread response')
  const thread = expectRecord(root.thread, 'Codex thread response.thread')
  return expectString(thread.id, 'Codex thread id')
}

function readTurnId(response: unknown): string {
  const root = expectRecord(response, 'Codex turn response')
  const turn = expectRecord(root.turn, 'Codex turn response.turn')
  return expectString(turn.id, 'Codex turn id')
}

function assertResponseCwd(response: unknown, expectedCwd: string): void {
  const root = expectRecord(response, 'Codex thread response')
  const actualCwd = expectString(root.cwd, 'Codex thread cwd')
  if (normalizeCwd(actualCwd) !== normalizeCwd(expectedCwd)) {
    throw driverError(
      DRIVER_ERROR_CODE.NATIVE_PROTOCOL_ERROR,
      `Codex thread cwd ${actualCwd} does not match requested cwd ${expectedCwd}`,
    )
  }
}

function normalizeCwd(cwd: string): string {
  if (cwd.startsWith('file:')) {
    try {
      return resolve(fileURLToPath(cwd))
    } catch {
      return cwd
    }
  }
  return resolve(cwd)
}

function readTerminal(method: string, params: unknown, expectedThreadId: string): TurnTerminal | undefined {
  if (method !== 'turn/completed') return undefined
  const root = asRecord(params)
  if (!root || root.threadId !== expectedThreadId) return undefined
  const turn = asRecord(root.turn)
  if (!turn || typeof turn.id !== 'string' || typeof turn.status !== 'string') {
    throw new AppServerProtocolError('Codex turn/completed notification is malformed')
  }
  const error = asRecord(turn.error)
  return {
    turnId: turn.id,
    status: turn.status,
    message: typeof error?.message === 'string' ? error.message : undefined,
  }
}

function readOutputEvent(method: string, params: unknown, expectedThreadId: string): OutputEvent | undefined {
  const root = asRecord(params)
  if (!root || root.threadId !== expectedThreadId) return undefined
  const turnId = typeof root.turnId === 'string' ? root.turnId : undefined
  if (method === 'item/agentMessage/delta' && typeof root.delta === 'string') {
    return { turnId, text: root.delta, completed: false }
  }
  if (method !== 'item/completed') return undefined
  const item = asRecord(root.item)
  if (!item || item.type !== 'agentMessage' || typeof item.text !== 'string') return undefined
  return { turnId, text: item.text, completed: true }
}

function selectOutput(events: readonly OutputEvent[], turnId: string): string {
  const relevant = events.filter((event) => event.turnId === undefined || event.turnId === turnId)
  const completed = relevant.filter((event) => event.completed).at(-1)
  return completed?.text ?? relevant.filter((event) => !event.completed).map((event) => event.text).join('')
}

function readRpcError(value: unknown): string {
  const error = asRecord(value)
  if (typeof error?.message === 'string') return `Codex app-server rejected request: ${error.message}`
  return 'Codex app-server rejected request'
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined
}

function expectRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new AppServerProtocolError(`${label} is not an object`)
  return value
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new AppServerProtocolError(`${label} is missing`)
  return value
}
