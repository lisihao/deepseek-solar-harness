import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024
const STDERR_TAIL_BYTES = 32 * 1024
const METHOD_NOT_FOUND = -32601

type Direction = 'send' | 'receive' | 'stderr'
type JsonRpcId = number | string

export interface AcpClientOptions {
  readonly record: (direction: Direction, value: unknown) => Promise<void>
  readonly onUpdate?: (params: unknown) => void
  readonly maxFrameBytes?: number
}

export interface AcpRequestOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export class AcpTransportError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options)
    this.name = 'AcpTransportError'
  }
}

export class AcpProtocolError extends AcpTransportError {
  constructor(message: string) {
    super(message)
    this.name = 'AcpProtocolError'
  }
}

export class AcpRpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data: unknown) {
    super(message)
    this.name = 'AcpRpcError'
    this.code = code
    this.data = data
  }
}

interface PendingRequest {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: Error) => void
  readonly timer?: ReturnType<typeof setTimeout>
  readonly removeAbortListener?: () => void
}

interface JsonObject {
  readonly [key: string]: unknown
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'string'
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`
}

function errorFromUnknown(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value
  if (typeof value === 'string' && value.length > 0) return new Error(value)
  try {
    return new Error(`${fallback}: ${JSON.stringify(value)}`)
  } catch {
    return new Error(fallback)
  }
}

function abortReason(signal: AbortSignal): Error {
  return errorFromUnknown(signal.reason, 'ACP request aborted')
}

/**
 * A small JSON-RPC 2.0 client for the Prime ACP stdio protocol.
 *
 * This class owns only the byte transport and request matching. The caller
 * owns process creation and process lifetime; dispose() closes stdin and
 * rejects requests, but never kills the child process.
 */
export class AcpClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #record: AcpClientOptions['record']
  readonly #onUpdate?: AcpClientOptions['onUpdate']
  readonly #maxFrameBytes: number
  readonly #pending = new Map<string, PendingRequest>()
  #nextId = 1
  #closed = false
  #disposed = false
  #stdoutBuffer = Buffer.alloc(0)
  #stderrBuffer = Buffer.alloc(0)
  #sendTail: Promise<void> = Promise.resolve()
  #receiveTail: Promise<void> = Promise.resolve()
  #stderrRecordTail: Promise<void> = Promise.resolve()

  constructor(child: ChildProcessWithoutNullStreams, options: AcpClientOptions) {
    if (options.maxFrameBytes !== undefined && (!Number.isInteger(options.maxFrameBytes) || options.maxFrameBytes <= 0)) {
      throw new RangeError('maxFrameBytes must be a positive integer')
    }
    this.#child = child
    this.#record = options.record
    this.#onUpdate = options.onUpdate
    this.#maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES

    child.stdout.on('data', (chunk: Buffer | string) => this.#receiveStdout(chunk))
    child.stdout.on('end', () => this.#finishStdout())
    child.stdout.on('error', (error: Error) => this.#fail(new AcpTransportError(`ACP stdout failed: ${error.message}`, { cause: error })))
    child.stderr.on('data', (chunk: Buffer | string) => this.#receiveStderr(chunk))
    child.stderr.on('error', (error: Error) => this.#fail(new AcpTransportError(`ACP stderr failed: ${error.message}`, { cause: error })))
    child.stdin.on('error', (error: Error) => this.#fail(new AcpTransportError(`ACP stdin failed: ${error.message}`, { cause: error })))
    child.on('error', (error) => this.#fail(new AcpTransportError(`ACP child failed: ${error.message}`, { cause: error })))
    child.on('exit', (code, signal) => {
      const detail = signal === null ? `exit code ${String(code)}` : `signal ${signal}`
      this.#failAfterReceive(new AcpTransportError(`ACP child exited with ${detail}`))
    })
  }

  request(method: string, params: unknown, options?: AcpRequestOptions): Promise<unknown> {
    if (method === 'session/cancel') {
      return Promise.reject(new AcpProtocolError('session/cancel must be sent as a notification'))
    }
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(new TypeError('ACP method must be a non-empty string'))
    }
    if (options?.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) {
      return Promise.reject(new RangeError('timeoutMs must be a finite non-negative number'))
    }
    if (options?.signal?.aborted) return Promise.reject(abortReason(options.signal))
    if (this.#closed) return Promise.reject(this.#closedError())

    const id = this.#nextId++
    const frame = this.#requestFrame(id, method, params)
    const key = idKey(id)

    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let removeAbortListener: (() => void) | undefined
      const pending: PendingRequest = {
        method,
        resolve,
        reject,
        get timer() {
          return timer
        },
        get removeAbortListener() {
          return removeAbortListener
        },
      }
      this.#pending.set(key, pending)

      if (options?.signal) {
        const onAbort = () => this.#rejectPending(key, abortReason(options.signal!))
        options.signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => options.signal?.removeEventListener('abort', onAbort)
      }
      if (options?.timeoutMs !== undefined) {
        timer = setTimeout(() => this.#rejectPending(key, new AcpTransportError(`ACP request timed out: ${method}`)), options.timeoutMs)
      }

      void this.#enqueueSend(frame, key).catch((error: unknown) => {
        this.#rejectPending(key, errorFromUnknown(error, `failed to send ACP request ${method}`))
      })
    })
  }

  notify(method: string, params: unknown): Promise<void> {
    if (typeof method !== 'string' || method.length === 0) {
      return Promise.reject(new TypeError('ACP method must be a non-empty string'))
    }
    if (this.#closed) return Promise.reject(this.#closedError())
    return this.#enqueueSend({ jsonrpc: '2.0', method, params })
  }

  get stderrTail(): string {
    return this.#stderrBuffer.toString('utf8')
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (!this.#closed) this.#fail(new AcpTransportError('ACP client disposed'))
    try {
      this.#child.stdin.end()
    } catch {
      // The parent owns the process. A closed stdin is already sufficient.
    }
  }

  #requestFrame(id: JsonRpcId, method: string, params: unknown): JsonObject {
    let requestParams = params
    if (method === 'initialize') {
      requestParams = isObject(params) ? { ...params, protocolVersion: 1 } : { protocolVersion: 1 }
    }
    return { jsonrpc: '2.0', id, method, params: requestParams }
  }

  #closedError(): AcpTransportError {
    return new AcpTransportError('ACP client transport is closed')
  }

  #enqueueSend(frame: JsonObject, pendingKey?: string): Promise<void> {
    const operation = this.#sendTail.then(() => this.#sendFrame(frame, pendingKey))
    this.#sendTail = operation.catch(() => undefined)
    return operation
  }

  async #sendFrame(frame: JsonObject, pendingKey?: string): Promise<void> {
    this.#ensureOpen()
    if (pendingKey !== undefined && !this.#pending.has(pendingKey)) return
    let serialized: string
    try {
      serialized = JSON.stringify(frame)
    } catch (error) {
      throw new AcpProtocolError(`ACP frame is not JSON serializable: ${errorFromUnknown(error, 'serialization failed').message}`)
    }
    const frameBytes = Buffer.byteLength(serialized, 'utf8')
    if (frameBytes > this.#maxFrameBytes) {
      throw new AcpProtocolError(`ACP frame exceeds maxFrameBytes (${frameBytes} > ${this.#maxFrameBytes})`)
    }
    await this.#record('send', frame)
    if (pendingKey !== undefined && !this.#pending.has(pendingKey)) return
    this.#ensureOpen()
    try {
      this.#child.stdin.write(`${serialized}\n`)
    } catch (error) {
      const failure = new AcpTransportError(`ACP stdin write failed: ${errorFromUnknown(error, 'write failed').message}`, { cause: error })
      this.#fail(failure)
      throw failure
    }
  }

  #receiveStdout(chunk: Buffer | string): void {
    if (this.#closed) return
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length === 0) return
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, bytes])

    while (!this.#closed) {
      const newline = this.#stdoutBuffer.indexOf(0x0a)
      if (newline < 0) {
        if (this.#stdoutBuffer.length > this.#maxFrameBytes) {
          this.#fail(new AcpProtocolError(`ACP frame exceeds maxFrameBytes (${this.#stdoutBuffer.length} > ${this.#maxFrameBytes})`))
        }
        return
      }
      const line = this.#stdoutBuffer.subarray(0, newline)
      this.#stdoutBuffer = Buffer.from(this.#stdoutBuffer.subarray(newline + 1))
      if (line.length > this.#maxFrameBytes) {
        this.#fail(new AcpProtocolError(`ACP frame exceeds maxFrameBytes (${line.length} > ${this.#maxFrameBytes})`))
        return
      }
      if (line.length === 0) continue
      let frame: unknown
      try {
        frame = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
      } catch (error) {
        this.#fail(new AcpProtocolError(`ACP emitted malformed JSONL: ${errorFromUnknown(error, 'parse failed').message}`))
        return
      }
      this.#enqueueReceive(frame)
    }
  }

  #finishStdout(): void {
    if (this.#closed) return
    if (this.#stdoutBuffer.length > 0) {
      this.#fail(new AcpProtocolError('ACP stdout ended with an incomplete JSONL frame'))
      return
    }
    this.#failAfterReceive(new AcpTransportError('ACP stdout closed'))
  }

  #failAfterReceive(error: Error): void {
    const operation = this.#receiveTail.then(() => {
      if (!this.#closed) this.#fail(error)
    })
    this.#receiveTail = operation.catch((failure: unknown) => {
      this.#fail(errorFromUnknown(failure, 'ACP receive failed'))
    })
  }

  #enqueueReceive(frame: unknown): void {
    const operation = this.#receiveTail.then(() => this.#processIncoming(frame))
    this.#receiveTail = operation.catch((error: unknown) => {
      this.#fail(errorFromUnknown(error, 'ACP receive failed'))
    })
  }

  async #processIncoming(frame: unknown): Promise<void> {
    if (this.#closed) return
    if (!isObject(frame) || frame.jsonrpc !== '2.0') {
      throw new AcpProtocolError('ACP emitted an invalid JSON-RPC 2.0 frame')
    }

    await this.#record('receive', frame)
    if (typeof frame.method === 'string') {
      if (isJsonRpcId(frame.id)) {
        await this.#enqueueSend({
          jsonrpc: '2.0',
          id: frame.id,
          error: { code: METHOD_NOT_FOUND, message: 'Method not found' },
        })
        return
      }
      if (frame.method === 'session/update') {
        this.#onUpdate?.(frame.params)
      }
      return
    }

    if (!isJsonRpcId(frame.id)) throw new AcpProtocolError('ACP response has no valid id')
    const pending = this.#pending.get(idKey(frame.id))
    if (!pending) return
    const hasResult = Object.prototype.hasOwnProperty.call(frame, 'result')
    const hasError = Object.prototype.hasOwnProperty.call(frame, 'error')
    if (hasResult === hasError) {
      throw new AcpProtocolError(`ACP response to ${pending.method} has neither result nor error`)
    }
    if (hasError) {
      if (!isObject(frame.error) || typeof frame.error.code !== 'number' || typeof frame.error.message !== 'string') {
        throw new AcpProtocolError(`ACP response to ${pending.method} has an invalid error object`)
      }
      this.#rejectPending(idKey(frame.id), new AcpRpcError(frame.error.code, frame.error.message, frame.error.data))
    } else {
      this.#resolvePending(idKey(frame.id), frame.result)
    }
  }

  #receiveStderr(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (bytes.length === 0) return
    this.#stderrBuffer = Buffer.concat([this.#stderrBuffer, bytes])
    if (this.#stderrBuffer.length > STDERR_TAIL_BYTES) this.#stderrBuffer = this.#stderrBuffer.subarray(-STDERR_TAIL_BYTES)
    const text = bytes.toString('utf8')
    const operation = this.#stderrRecordTail.then(() => this.#record('stderr', text))
    this.#stderrRecordTail = operation.catch((error: unknown) => {
      this.#fail(errorFromUnknown(error, 'ACP stderr record failed'))
    })
  }

  #ensureOpen(): void {
    if (this.#closed) throw this.#closedError()
  }

  #resolvePending(key: string, value: unknown): void {
    const pending = this.#pending.get(key)
    if (!pending) return
    this.#pending.delete(key)
    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    pending.resolve(value)
  }

  #rejectPending(key: string, error: Error): void {
    const pending = this.#pending.get(key)
    if (!pending) return
    this.#pending.delete(key)
    if (pending.timer) clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    pending.reject(error)
  }

  #fail(error: Error): void {
    if (this.#closed) return
    this.#closed = true
    for (const [key, pending] of this.#pending) {
      this.#pending.delete(key)
      if (pending.timer) clearTimeout(pending.timer)
      pending.removeAbortListener?.()
      pending.reject(error)
    }
  }
}
