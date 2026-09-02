/** Owner-local model tool bridge for the provider-neutral `ctx.browser` seam. */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  BrowserOperationId,
  BrowserPageKey,
  BrowserWorkspaceId,
  type BrowserCapabilityV1,
  type BrowserLocatorV1,
  type BrowserOperationV1,
  type BrowserPageMatchV1,
  type BrowserReadTargetV1,
  type BrowserRunPlanV1,
  type BrowserRunResultV1,
  type BrowserWaitConditionV1,
  type BrowserWorkspaceSelectorV1,
} from '@deepseek-ai/dsh-browser'
import type { PhysicalOperatorModelToolBridgeV1 } from '@deepseek-ai/dsh-physical-operator'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

/** Graph capability tag resolved by the built-in browser Capsule. */
export const BROWSER_CAPABILITY = 'browser'

/** Model-facing browser tool schema. The plan vocabulary is intentionally closed. */
export const BROWSER_MODEL_TOOL_SCHEMA = Object.freeze({
  name: 'browser',
  description: 'Run one ordered, typed browser plan through the configured DSH browser Provider.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        description: 'BrowserRunPlanV1. Operations execute in order; use semantic locators and verify resulting state.',
        required: ['version', 'workspace', 'operations'],
        properties: {
          version: { type: 'integer', const: 1 },
          workspace: { type: 'object' },
          requiredCapabilities: { type: 'array', items: { type: 'string' } },
          operations: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'object' } },
        },
        additionalProperties: false,
      },
    },
    required: ['plan'],
    additionalProperties: false,
  },
}) satisfies PhysicalOperatorModelToolBridgeV1['tools'][number]

const MODEL_CAPABILITIES: readonly BrowserCapabilityV1[] = [
  'authenticated-profile-reuse', 'named-workspace', 'page-evaluate', 'semantic-snapshot',
]
const MODEL_OPERATION_KINDS = new Set([
  'open', 'select-page', 'close-page', 'navigate', 'reload', 'pages', 'page-info', 'snapshot',
  'click', 'fill', 'clear', 'press', 'check', 'select', 'read', 'count', 'wait', 'complete',
])

interface Binding {
  readonly signal: AbortSignal
  readonly receipts: Map<string, { readonly hash: string; readonly result: Promise<unknown> }>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`)
  return value
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  return value
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`)
  return Number(value)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

function optionalTimeout(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`)
  return Number(value)
}

function pageMatch(value: unknown): BrowserPageMatchV1 {
  const match = object(value, 'page match')
  const kind = oneOf(match.kind, ['exact-url', 'url-prefix'] as const, 'page match kind')
  return kind === 'exact-url'
    ? { kind, url: text(match.url, 'page match url') }
    : { kind, prefix: text(match.prefix, 'page match prefix') }
}

function locator(value: unknown): BrowserLocatorV1 {
  const raw = object(value, 'locator')
  const kind = oneOf(raw.kind, ['css', 'role', 'text', 'label', 'placeholder', 'test-id'] as const, 'locator kind')
  const index = raw.index === undefined ? undefined : integer(raw.index, 'locator index')
  switch (kind) {
    case 'css': return { kind, selector: text(raw.selector, 'locator selector'), ...index === undefined ? {} : { index } }
    case 'role': return {
      kind, role: text(raw.role, 'locator role'),
      ...raw.name === undefined ? {} : { name: text(raw.name, 'locator name') },
      ...raw.exact === undefined ? {} : { exact: Boolean(raw.exact) },
      ...index === undefined ? {} : { index },
    }
    case 'text': return {
      kind, text: text(raw.text, 'locator text'),
      ...raw.exact === undefined ? {} : { exact: Boolean(raw.exact) },
      ...index === undefined ? {} : { index },
    }
    case 'label': return {
      kind, label: text(raw.label, 'locator label'),
      ...raw.exact === undefined ? {} : { exact: Boolean(raw.exact) },
      ...index === undefined ? {} : { index },
    }
    case 'placeholder': return {
      kind, placeholder: text(raw.placeholder, 'locator placeholder'),
      ...raw.exact === undefined ? {} : { exact: Boolean(raw.exact) },
      ...index === undefined ? {} : { index },
    }
    case 'test-id': return { kind, testId: text(raw.testId, 'locator testId'), ...index === undefined ? {} : { index } }
  }
  throw new Error(`unsupported locator kind: ${String(kind)}`)
}

function readTarget(value: unknown): BrowserReadTargetV1 {
  const raw = object(value, 'read target')
  const kind = oneOf(raw.kind, ['text', 'value', 'html', 'attribute'] as const, 'read target kind')
  return kind === 'attribute' ? { kind, name: text(raw.name, 'read target name') } : { kind }
}

function waitCondition(value: unknown): BrowserWaitConditionV1 {
  const raw = object(value, 'wait condition')
  const kind = oneOf(raw.kind, ['load', 'url', 'locator', 'control'] as const, 'wait condition kind')
  if (kind === 'control') return { kind, control: oneOf(raw.control, ['agent', 'user'] as const, 'wait control') }
  const page = BrowserPageKey(text(raw.page, 'wait page'))
  if (kind === 'load') return {
    kind, page,
    state: oneOf(raw.state, ['dom-content-loaded', 'load', 'network-idle'] as const, 'wait load state'),
  }
  if (kind === 'url') return { kind, page, match: pageMatch(raw.match) }
  return {
    kind, page,
    locator: locator(raw.locator),
    state: oneOf(raw.state, ['attached', 'detached', 'visible', 'hidden'] as const, 'wait locator state'),
  }
}

function operation(value: unknown): BrowserOperationV1 {
  const raw = object(value, 'browser operation')
  const kind = text(raw.kind, 'browser operation kind')
  if (!MODEL_OPERATION_KINDS.has(kind)) throw new Error(`browser operation kind is not model-accessible: ${kind}`)
  const id = BrowserOperationId(text(raw.id, 'browser operation id'))
  const timeoutMs = optionalTimeout(raw.timeoutMs, 'browser operation timeoutMs')
  const envelope = { id, ...timeoutMs === undefined ? {} : { timeoutMs } }
  switch (kind) {
    case 'open': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'open page')), url: text(raw.url, 'open url'),
      reuse: oneOf(raw.reuse, ['never', 'exact-url'] as const, 'open reuse'),
      waitUntil: oneOf(raw.waitUntil, ['dom-content-loaded', 'load', 'network-idle'] as const, 'open waitUntil'),
    }
    case 'select-page': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'select page')), match: pageMatch(raw.match) }
    case 'close-page': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'close page')) }
    case 'navigate': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'navigate page')), url: text(raw.url, 'navigate url'),
      waitUntil: oneOf(raw.waitUntil, ['dom-content-loaded', 'load', 'network-idle'] as const, 'navigate waitUntil'),
    }
    case 'reload': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'reload page')),
      waitUntil: oneOf(raw.waitUntil, ['dom-content-loaded', 'load', 'network-idle'] as const, 'reload waitUntil'),
    }
    case 'pages': return { ...envelope, kind }
    case 'page-info': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'page-info page')) }
    case 'snapshot': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'snapshot page')) }
    case 'click': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'click page')), locator: locator(raw.locator) }
    case 'fill': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'fill page')), locator: locator(raw.locator), value: stringValue(raw.value, 'fill value'),
    }
    case 'clear': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'clear page')), locator: locator(raw.locator) }
    case 'press': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'press page')), locator: locator(raw.locator), key: text(raw.key, 'press key'),
    }
    case 'check': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'check page')), locator: locator(raw.locator),
      checked: typeof raw.checked === 'boolean' ? raw.checked : (() => { throw new Error('check checked must be boolean') })(),
    }
    case 'select': {
      if (!Array.isArray(raw.values) || raw.values.length < 1 || !raw.values.every(value => typeof value === 'string')) {
        throw new Error('select values must be a non-empty string array')
      }
      return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'select page')), locator: locator(raw.locator), values: raw.values }
    }
    case 'read': return {
      ...envelope, kind, page: BrowserPageKey(text(raw.page, 'read page')), locator: locator(raw.locator), target: readTarget(raw.target),
    }
    case 'count': return { ...envelope, kind, page: BrowserPageKey(text(raw.page, 'count page')), locator: locator(raw.locator) }
    case 'wait': return { ...envelope, kind, condition: waitCondition(raw.condition) }
    case 'complete': return {
      ...envelope, kind,
      keep: typeof raw.keep === 'boolean' ? raw.keep : (() => { throw new Error('complete keep must be boolean') })(),
    }
  }
  throw new Error(`unsupported browser operation kind: ${kind}`)
}

/**
 * Validate and brand the model's closed browser plan before it crosses the bridge.
 * @param input - untrusted Resident model-tool plan.
 * @returns the validated portable plan with branded local identifiers.
 */
export function parseBrowserModelPlan(input: unknown): BrowserRunPlanV1 {
  const raw = object(input, 'browser plan')
  if (raw.version !== 1) throw new Error('browser plan version must be 1')
  const workspaceRaw = object(raw.workspace, 'browser workspace')
  const workspaceKind = oneOf(workspaceRaw.kind, ['current', 'existing', 'named'] as const, 'browser workspace kind')
  const workspace: BrowserWorkspaceSelectorV1 = workspaceKind === 'current'
    ? { kind: workspaceKind }
    : workspaceKind === 'existing'
      ? { kind: workspaceKind, id: BrowserWorkspaceId(text(workspaceRaw.id, 'browser workspace id')) }
      : {
        kind: workspaceKind,
        name: text(workspaceRaw.name, 'browser workspace name'),
        createIfMissing: typeof workspaceRaw.createIfMissing === 'boolean'
          ? workspaceRaw.createIfMissing
          : (() => { throw new Error('browser workspace createIfMissing must be boolean') })(),
      }
  const requiredCapabilities = raw.requiredCapabilities === undefined ? [] : (() => {
    if (!Array.isArray(raw.requiredCapabilities)) throw new Error('browser requiredCapabilities must be an array')
    return raw.requiredCapabilities.map(value => oneOf(value, MODEL_CAPABILITIES, 'browser required capability'))
  })()
  if (!Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > 64) {
    throw new Error('browser operations must contain 1 to 64 operations')
  }
  return { version: 1, workspace, requiredCapabilities, operations: raw.operations.map(operation) }
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  throw new Error('browser model tool request contains a non-JSON value')
}

function requestHash(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(args)).digest('hex')
}

function jsonResult(result: BrowserRunResultV1): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(result)) as Record<string, unknown>
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(value) }],
    value,
  }
}

function errorResult(error: unknown): Record<string, unknown> {
  const code = error instanceof Error && 'code' in error ? String(error.code) : 'BROWSER_INVALID'
  const message = error instanceof Error ? error.message : String(error)
  return { isError: true, content: [{ type: 'text', text: message }], error: { code, message } }
}

/** One daemon-owned endpoint; bindings are scoped to a single Resident command. */
export class BrowserModelToolBridge {
  private readonly endpoint: { readonly path: string; readonly directory?: string }
  private readonly bindings = new Map<string, Binding>()
  private readonly server: Server
  private ready: Promise<void> | undefined

  constructor(private readonly ctx: Context, root: string) {
    const directory = join(root, 'model-tools')
    // The descriptor is persisted by the orchestration daemon's execution
    // record and consumed by the independently durable Resident daemon.  It
    // therefore must survive an orchestration process restart; a PID-scoped
    // endpoint would leave the native turn pointing at a dead socket.  The
    // daemon lock serializes owners of this root, so one stable endpoint is
    // safe and lets a recovered daemon recreate the binding under the same
    // path and session identity.
    const path = localIpcAddress(directory, 'browser')
    this.endpoint = { path, ...localIpcUsesFilesystem() ? { directory: dirname(path) } : {} }
    this.server = createServer((socket) => { this.accept(socket) })
  }

  /**
   * Bind the browser tool to one Resident execution and return its bridge descriptor.
   * @param commandId - Resident command identifier that scopes the bridge session.
   * @param signal - cancellation signal for browser calls in this binding.
   * @returns the Resident bridge descriptor and an idempotent release operation.
   */
  async bind(commandId: string, signal: AbortSignal): Promise<{
    readonly descriptor: PhysicalOperatorModelToolBridgeV1
    release(): void
  }> {
    await this.start()
    const sessionId = `browser:${commandId}`
    const binding: Binding = { signal, receipts: new Map() }
    if (this.bindings.has(sessionId)) throw new Error(`browser model tool session is already attached: ${sessionId}`)
    this.bindings.set(sessionId, binding)
    let attached = true
    return {
      descriptor: { version: 1, socketPath: this.endpoint.path, sessionId, tools: [BROWSER_MODEL_TOOL_SCHEMA] },
      release: () => {
        if (!attached) return
        attached = false
        if (this.bindings.get(sessionId) === binding) this.bindings.delete(sessionId)
      },
    }
  }

  /** Close this endpoint and remove only the bridge-owned socket. */
  async dispose(): Promise<void> {
    this.bindings.clear()
    if (this.ready === undefined) return
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    if (process.platform !== 'win32') rmSync(this.endpoint.path, { force: true })
    this.ready = undefined
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
      if (method !== 'tool.call') throw new Error(`unsupported browser model tool method: ${method}`)
      return this.call(params)
    })
    socket.on('close', () => { transport.close() })
    transport.start()
  }

  private call(params: unknown): Promise<unknown> {
    const raw = object(params, 'browser model tool request')
    const sessionId = text(raw.session_id, 'session_id')
    const commandId = text(raw.command_id, 'command_id')
    if (raw.tool !== 'browser') throw new Error('browser model tool request must select browser')
    const argumentsValue = object(raw.arguments, 'browser model tool arguments')
    const binding = this.bindings.get(sessionId)
    if (binding === undefined) throw new Error(`browser model tool session is not attached: ${sessionId}`)
    const hash = requestHash(argumentsValue)
    const existing = binding.receipts.get(commandId)
    if (existing !== undefined) {
      if (existing.hash !== hash) throw new Error(`browser model tool command conflict: ${commandId}`)
      return existing.result
    }
    const result = this.execute(binding, argumentsValue)
    binding.receipts.set(commandId, { hash, result })
    return result
  }

  private async execute(binding: Binding, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (binding.signal.aborted) return errorResult(binding.signal.reason ?? new Error('browser execution was aborted'))
    try {
      const plan = parseBrowserModelPlan(args.plan)
      const result = await this.ctx.browser.runPlan(plan, binding.signal)
      return jsonResult(result)
    } catch (error) {
      return errorResult(error)
    }
  }
}
