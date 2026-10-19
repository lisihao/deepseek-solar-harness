/** Persistent QuickJS guest with a host deadline and cell-specific capabilities. */
import { Buffer } from 'node:buffer'
import { Worker } from 'node:worker_threads'
import type { RlmJsonValue } from '@deepseek-ai/dsh-rlm-runtime'
import type { KernelCellResult, KernelHooks, KernelSnapshotLimits, PersistedVariable } from './kernel.ts'
import { QUICKJS_ANALYZE_SOURCE } from './quickjs-namespace.ts'
import { QUICKJS_GUEST_SOURCE } from './quickjs-guest.ts'
import { QUICKJS_WORKER_SOURCE } from './quickjs-worker.ts'

/** Explicit limits for the guest and its JSON-only host transport. */
export interface QuickJSKernelLimits {
  readonly memoryLimitBytes: number
  readonly maxStackBytes: number
  readonly maxInterruptChecks: number
  readonly maxBridgeBytes: number
  readonly maxLogBytes: number
  readonly maxCellSourceBytes: number
  readonly maxHostCalls: number
  readonly maxPendingHostCalls: number
  readonly jobBatchSize: number
}

interface ActiveCell {
  readonly id: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly resolve: (value: KernelCellResult) => void
  readonly reject: (error: Error) => void
  hostCalls: number
}

function failure(message: string, code = 'RLM_GUEST_ERROR'): Error {
  return Object.assign(new Error(message), { code })
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function json(value: unknown): value is RlmJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(json)
  return record(value) && Object.values(value).every(json)
}

function cellResult(raw: string): KernelCellResult {
  const value: unknown = JSON.parse(raw)
  if (!record(value) || typeof value.display !== 'string'
    || !Array.isArray(value.logs) || !value.logs.every(item => typeof item === 'string')
    || !Array.isArray(value.variables) || !Array.isArray(value.degradedVariables)
    || !value.degradedVariables.every(item => typeof item === 'string')
    || !record(value.context) || !json(value.context)
    || (value.value !== undefined && !json(value.value))) throw failure('invalid QuickJS result protocol')
  const variables: PersistedVariable[] = value.variables.map((item: unknown) => {
    if (!record(item) || typeof item.name !== 'string'
      || !['let', 'const', 'var', 'function', 'class'].includes(String(item.declaration))
      || (typeof item.error !== 'string' && (typeof item.valueBase64 !== 'string' || !item.valueBase64.startsWith('qjs-json-v1:')))) {
      throw failure('invalid QuickJS variable protocol')
    }
    return {
      name: item.name,
      declaration: item.declaration as PersistedVariable['declaration'],
      ...typeof item.error === 'string' ? { error: item.error } : { valueBase64: item.valueBase64 as string },
    }
  })
  return { logs: value.logs, display: value.display, variables, degradedVariables: value.degradedVariables,
    context: value.context, ...value.value === undefined ? {} : { value: value.value } }
}

/**
 * Validate explicit limits before starting a Worker.
 * @param limits - Deployment-selected guest and transport ceilings.
 */
export function validateQuickJSKernelLimits(limits: QuickJSKernelLimits): void {
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) throw failure('invalid QuickJS limit', 'RLM_INVALID')
  if (limits.maxPendingHostCalls > limits.maxHostCalls || limits.maxStackBytes > limits.memoryLimitBytes
    || limits.maxLogBytes > limits.maxBridgeBytes) throw failure('inconsistent QuickJS limits', 'RLM_INVALID')
}

/** One session namespace; a failed cell closes the Worker instead of retaining uncertain guest state. */
export class PersistentQuickJSKernel {
  private worker: Worker | undefined
  private active: ActiveCell | undefined
  private ordinal = 0
  private disposed = false
  private closing: Promise<void> | undefined
  private readonly initial: string

  constructor(
    context: Readonly<Record<string, RlmJsonValue>>,
    private readonly hooks: KernelHooks,
    variables: readonly PersistedVariable[],
    private readonly limits: QuickJSKernelLimits,
    private readonly snapshotLimits: KernelSnapshotLimits,
  ) {
    validateQuickJSKernelLimits(limits)
    if (!Number.isSafeInteger(snapshotLimits.maxBytes) || !Number.isSafeInteger(snapshotLimits.maxVariableBytes)
      || snapshotLimits.maxVariableBytes < 1 || snapshotLimits.maxVariableBytes > snapshotLimits.maxBytes) throw failure('invalid QuickJS snapshot limits', 'RLM_INVALID')
    this.initial = JSON.stringify({ context, variables: variables.map((variable) => {
      if (variable.error !== undefined) return { name: variable.name, kind: variable.declaration, error: variable.error }
      if (variable.valueBase64 === undefined || !variable.valueBase64.startsWith('qjs-json-v1:')) throw failure('QuickJS snapshot codec mismatch', 'RLM_INVALID')
      const restored: unknown = JSON.parse(Buffer.from(variable.valueBase64.slice('qjs-json-v1:'.length), 'base64').toString('utf8'))
      if (!record(restored) || typeof restored.defined !== 'boolean' || (restored.defined && !json(restored.value))) throw failure('invalid QuickJS snapshot data', 'RLM_INVALID')
      return { name: variable.name, kind: variable.declaration, ...restored }
    }) })
    if (Buffer.byteLength(this.initial) > limits.maxBridgeBytes) throw failure('initial QuickJS namespace exceeds byte limit', 'RLM_OUTPUT_LIMIT')
  }

  /**
   * Execute and drain one cell within a single deadline, including first initialization and restore.
   * @param code - TypeScript cell; modules and cross-cell redeclarations are rejected.
   * @param timeoutMs - One deadline for initialization, analysis, execution, bridges and snapshot.
   * @returns Complete cell output and explicitly degradable JSON snapshots.
   */
  execute(code: string, timeoutMs: number): Promise<KernelCellResult> {
    if (this.disposed) return Promise.reject(failure('QuickJS kernel is closed', 'RLM_UNAVAILABLE'))
    if (this.active !== undefined) return Promise.reject(failure('QuickJS cell already active', 'RLM_BUSY'))
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(failure('invalid QuickJS deadline', 'RLM_INVALID'))
    if (Buffer.byteLength(code) > this.limits.maxCellSourceBytes) return Promise.reject(failure('QuickJS source exceeds byte limit', 'RLM_OUTPUT_LIMIT'))
    const deadline = Date.now() + timeoutMs
    const id = ++this.ordinal
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.close(failure('QuickJS cell deadline exceeded', 'RLM_CELL_TIMEOUT')) }, timeoutMs)
      this.active = { id, timer, resolve, reject, hostCalls: 0 }
      try {
        if (this.worker === undefined) {
          this.worker = new Worker(QUICKJS_WORKER_SOURCE, { eval: true, env: {}, workerData: {
            core: import.meta.resolve('quickjs-emscripten-core'),
            variant: import.meta.resolve('@jitl/quickjs-wasmfile-release-sync'),
            typescript: import.meta.resolve('typescript'),
            guest: QUICKJS_GUEST_SOURCE, analyzer: QUICKJS_ANALYZE_SOURCE,
            limits: this.limits, snapshotLimits: this.snapshotLimits, initial: this.initial,
          } })
          this.worker.on('message', (message: unknown) => { void this.onMessage(message).catch((error: unknown) => this.close(error instanceof Error ? error : failure(String(error)))) })
          this.worker.on('error', (error) => { void this.close(error) })
          this.worker.on('exit', () => { if (!this.disposed) void this.close(failure('QuickJS Worker exited', 'RLM_UNAVAILABLE')) })
        }
        this.worker.postMessage({ type: 'execute', executionId: id, deadline, code })
      } catch (error) { void this.close(error instanceof Error ? error : failure(String(error))) }
    })
  }

  /**
   * Reject pending work and wait until the Worker terminates; accepted host facts remain host-owned.
   * @returns After Worker termination.
   */
  dispose(): Promise<void> { return this.close(failure('QuickJS kernel disposed', 'RLM_UNAVAILABLE')) }

  private async close(error: Error): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.disposed = true
    const active = this.active
    this.active = undefined
    if (active !== undefined) { clearTimeout(active.timer); active.reject(error) }
    this.closing = this.worker === undefined ? Promise.resolve() : this.worker.terminate().then(() => undefined)
    await this.closing
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!record(message) || this.active === undefined || this.disposed || message.executionId !== this.active.id) return
    const active = this.active
    if (message.type === 'error') {
      await this.close(failure(typeof message.message === 'string' ? message.message : 'QuickJS execution failed',
        typeof message.code === 'string' ? message.code : 'RLM_GUEST_ERROR'))
      return
    }
    if (message.type === 'result') {
      if (typeof message.result !== 'string' || Buffer.byteLength(message.result) > this.limits.maxBridgeBytes) throw failure('invalid QuickJS result size')
      const result = cellResult(message.result)
      clearTimeout(active.timer)
      this.active = undefined
      active.resolve(result)
      return
    }
    if (message.type !== 'host-call' || !Number.isSafeInteger(message.callId)
      || typeof message.args !== 'string' || Buffer.byteLength(message.args) > this.limits.maxBridgeBytes) throw failure('invalid QuickJS host protocol')
    if (++active.hostCalls > this.limits.maxHostCalls) throw failure('QuickJS host-call limit exceeded', 'RLM_HOST_CALL_LIMIT')
    try {
      const args: unknown = JSON.parse(message.args)
      if (!Array.isArray(args)) throw failure('QuickJS host arguments must be an array')
      const value = await this.callHost(message.method, args)
      const wire = JSON.stringify({ value })
      if (Buffer.byteLength(wire) > this.limits.maxBridgeBytes) throw failure('host result exceeds byte limit', 'RLM_OUTPUT_LIMIT')
      if (this.active !== active) return
      this.worker?.postMessage({ type: 'host-result', executionId: active.id, callId: message.callId, ok: true, value: wire })
    } catch (error) {
      if (this.active !== active || this.disposed) return
      const description = error instanceof Error ? error.message : String(error)
      this.worker?.postMessage({ type: 'host-result', executionId: active.id, callId: message.callId, ok: false,
        message: description.slice(0, this.limits.maxBridgeBytes),
        code: record(error) && typeof error.code === 'string' ? error.code : 'RLM_GUEST_ERROR' })
    }
  }

  private callHost(method: unknown, args: unknown[]): Promise<unknown> {
    switch (method) {
      case 'spawn':
        if (typeof args[0] !== 'string' || args.length > 2) throw failure('invalid child request', 'RLM_INVALID')
        return this.hooks.spawn(args[0], args[1])
      case 'listChildren': return this.hooks.listChildren()
      case 'childSummaries': return this.hooks.childSummaries()
      case 'readChildResult': return this.hooks.readChildResult(args[0], args[1])
      case 'deleteChild': return this.hooks.deleteChild(args[0])
      default: return Promise.reject(failure('QuickJS host method unavailable', 'RLM_INVALID'))
    }
  }
}
