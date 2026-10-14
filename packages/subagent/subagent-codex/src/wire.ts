/**
 * Minimal Codex app-server protocol adapter. The shared JSON-RPC
 * transport owns framing and request correlation; this module owns only the
 * product methods, current thread/turn association, unattended approval
 * responses, and terminal-answer selection.
 *
 * @module @deepseek-ai/dsh-subagent-codex/wire
 */

import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentUsage } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

/**
 * Every app-server method this adapter sends or handles, keyed by the
 * protocol union that declares it. A Codex build qualifies only when its
 * generated protocol schema declares each method.
 */
export const CODEX_APP_SERVER_METHODS = {
  ClientRequest: [
    'initialize',
    'model/list',
    'account/rateLimits/read',
    'thread/start',
    'thread/resume',
    'thread/compact/start',
    'turn/start',
    'turn/interrupt',
  ],
  ClientNotification: ['initialized'],
  ServerRequest: [
    'item/tool/call',
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval',
    'item/permissions/requestApproval',
    'item/tool/requestUserInput',
    'mcpServer/elicitation/request',
  ],
  ServerNotification: [
    'turn/started',
    'thread/tokenUsage/updated',
    'item/started',
    'item/completed',
    'turn/completed',
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** The statuses a Codex turn ends in; any other status is not evidence that its execution stopped. */
export const CODEX_TERMINAL_TURN_STATUSES = ['completed', 'interrupted', 'failed'] as const

/**
 * Whether a turn status proves the turn ended.
 * @param status - status as the app-server reported it.
 * @returns true only for `completed`, `interrupted` and `failed`.
 */
export function isCodexTerminalTurnStatus(status: string): boolean {
  return (CODEX_TERMINAL_TURN_STATUSES as readonly string[]).includes(status)
}

/**
 * Methods the wire uses when a build offers them and goes without when it does not: a build that lacks one still
 * qualifies, and the feature that uses it is skipped.
 */
export const CODEX_APP_SERVER_OPTIONAL_METHODS = {
  /** Lists a thread's turns, which a start of unknown outcome uses to find the turn it may have created. */
  ClientRequest: ['thread/turns/list'],
} as const satisfies Readonly<Record<string, readonly string[]>>

/** Model catalog row returned by the qualified app-server. */
export interface CodexAppServerModel {
  readonly id: string
  readonly model: string
  readonly displayName: string
  readonly description: string
  readonly hidden: boolean
  readonly isDefault: boolean
  readonly defaultReasoningEffort: string
  readonly supportedReasoningEfforts: readonly {
    readonly reasoningEffort: string
    readonly description: string
  }[]
}

/** Explicit model and reasoning overrides accepted by one Codex Resident turn. */
export interface CodexAppServerExecutionProfile {
  readonly model: string
  readonly effort?: string
}

/** Logical app-server boundary that keeps native execution read-only while DSH owns writable effects. */
export interface CodexAppServerExecutionBoundary {
  readonly approval: 'never'
  readonly nativeEffects: 'read-only'
  readonly environmentAccess: 'disabled'
}

function threadStartBoundary(boundary?: CodexAppServerExecutionBoundary): JsonObject {
  return boundary === undefined ? {} : {
    approvalPolicy: boundary.approval,
    sandbox: boundary.nativeEffects,
    environments: [],
  }
}

function threadResumeBoundary(boundary?: CodexAppServerExecutionBoundary): JsonObject {
  return boundary === undefined ? {} : {
    approvalPolicy: boundary.approval,
    sandbox: boundary.nativeEffects,
  }
}

function turnStartBoundary(boundary?: CodexAppServerExecutionBoundary): JsonObject {
  return boundary === undefined ? {} : {
    approvalPolicy: boundary.approval,
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    environments: [],
  }
}

/** Experimental app-server function tool declared at persistent thread start. */
export interface CodexDynamicToolSpec {
  readonly type: 'function'
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly deferLoading?: boolean
}

/** One app-server dynamic tool invocation owned by the host. */
export interface CodexDynamicToolCall {
  readonly threadId: string
  readonly turnId: string
  readonly callId: string
  readonly namespace?: string
  readonly tool: string
  readonly arguments: Readonly<Record<string, unknown>>
}

/** Host response rendered back into the native Codex turn. */
export interface CodexDynamicToolResult {
  readonly success: boolean
  readonly text: string
}

/** One Codex account rate-limit window returned by app-server. */
export interface CodexAppServerRateLimitWindow {
  readonly usedPercent: number
  readonly resetsAt?: number
  readonly windowDurationMins?: number
}

/** One independently metered Codex subscription pool. */
export interface CodexAppServerRateLimit {
  readonly limitId: string
  readonly limitName?: string
  readonly primary?: CodexAppServerRateLimitWindow
  readonly secondary?: CodexAppServerRateLimitWindow
}

/** Trace-safe event surfaced by the Codex app-server wire to a Resident Driver. */
export type CodexAppServerObservation =
  | { readonly kind: 'public-output'; readonly preview: string }
  | { readonly kind: 'tool-started'; readonly toolName: string }
  | { readonly kind: 'tool-completed'; readonly toolName: string }
  | { readonly kind: 'approval-required'; readonly approvalKind: string; readonly preview?: string }
  | { readonly kind: 'usage-updated'; readonly usage: SubagentUsage }

/** Optional one-way observer for trace-safe Codex app-server activity. */
export type CodexAppServerObserver = (observation: CodexAppServerObservation) => void

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return value as JsonObject
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return value
}

function tokenCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`subagent-codex: app-server returned invalid ${label}`)
  }
  return Number(value)
}

function tokenUsage(value: unknown): SubagentUsage {
  const usage = object(value, 'turn token usage')
  const totalInputTokens = tokenCount(usage.inputTokens, 'turn inputTokens')
  const cacheReadInputTokens = tokenCount(usage.cachedInputTokens, 'turn cachedInputTokens')
  const cacheWriteInputTokens = usage.cacheWriteInputTokens === undefined
    ? 0
    : tokenCount(usage.cacheWriteInputTokens, 'turn cacheWriteInputTokens')
  return {
    inputTokens: Math.max(0, totalInputTokens - cacheReadInputTokens),
    outputTokens: tokenCount(usage.outputTokens, 'turn outputTokens'),
    cacheReadInputTokens,
    cacheWriteInputTokens,
  }
}

function rateLimitWindow(value: unknown, label: string): CodexAppServerRateLimitWindow {
  const window = object(value, `rate limit ${label} window`)
  if (!Number.isInteger(window.usedPercent) || Number(window.usedPercent) < 0 || Number(window.usedPercent) > 100) {
    throw new Error(`subagent-codex: app-server returned invalid rate limit ${label} usedPercent`)
  }
  if (window.resetsAt !== undefined && window.resetsAt !== null && !Number.isSafeInteger(window.resetsAt)) {
    throw new Error(`subagent-codex: app-server returned invalid rate limit ${label} resetsAt`)
  }
  if (window.windowDurationMins !== undefined && window.windowDurationMins !== null
    && (!Number.isSafeInteger(window.windowDurationMins) || Number(window.windowDurationMins) <= 0)) {
    throw new Error(`subagent-codex: app-server returned invalid rate limit ${label} windowDurationMins`)
  }
  return {
    usedPercent: Number(window.usedPercent),
    ...window.resetsAt === undefined || window.resetsAt === null ? {} : { resetsAt: Number(window.resetsAt) },
    ...window.windowDurationMins === undefined || window.windowDurationMins === null
      ? {}
      : { windowDurationMins: Number(window.windowDurationMins) },
  }
}

function rateLimitSnapshot(value: unknown, fallbackId: string): CodexAppServerRateLimit {
  const limit = object(value, `rate limit ${fallbackId}`)
  const limitId = typeof limit.limitId === 'string' && limit.limitId.length > 0 ? limit.limitId : fallbackId
  return {
    limitId,
    ...typeof limit.limitName === 'string' && limit.limitName.length > 0 ? { limitName: limit.limitName } : {},
    ...limit.primary === undefined || limit.primary === null ? {} : { primary: rateLimitWindow(limit.primary, 'primary') },
    ...limit.secondary === undefined || limit.secondary === null ? {} : { secondary: rateLimitWindow(limit.secondary, 'secondary') },
  }
}

function unattendedDecision(params: JsonObject): 'cancel' | 'decline' {
  const available = params.availableDecisions
  if (available === undefined || available === null) return 'decline'
  if (Array.isArray(available)) {
    if (available.includes('cancel')) return 'cancel'
    if (available.includes('decline')) return 'decline'
  }
  throw new Error('subagent-codex: app-server offered no unattended approval decision')
}

function isContextWindowExceeded(turn: JsonObject): boolean {
  if (turn.status !== 'failed') return false
  const error = turn.error
  return error !== null
    && typeof error === 'object'
    && !Array.isArray(error)
    && (error as JsonObject).codexErrorInfo === 'contextWindowExceeded'
}

/** Most protocol frames kept for the diagnostic of a start whose outcome is unknown. */
const FRAME_DIAGNOSTIC_LIMIT = 64

/** Most notifications held before the `turn/start` response; a server that sends more is not answering. */
const EARLY_NOTIFICATION_LIMIT = 512

/** Server requests that belong to one turn and so wait for the `turn/start` response before they are answered. */
const TURN_SCOPED_REQUESTS: ReadonlySet<string> = new Set([
  'item/tool/call',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
])

/**
 * One protocol frame as the diagnostic keeps it: the receive order, the kind of frame, the method, and the thread and
 * turn ids it names. Task text, tool arguments, and output are never kept.
 */
export interface CodexWireFrame {
  readonly order: number
  readonly kind: 'notification' | 'request' | 'response'
  readonly method: string
  readonly threadId?: string
  readonly turnId?: string
}

/**
 * `turn/start` was sent, but the run could not take its turn from it. The native turn may be running, so the caller must
 * not treat the command as not started: it has to inspect the thread before it releases anything.
 *
 * Two cases differ in what is known. Without a valid response no turn id is known (`startedTurnId` is undefined) and
 * the turn can only be inferred. When a valid response did name the turn but reading the notifications that arrived
 * before it failed, `startedTurnId` is that turn, confirmed by the server, and it is kept on the error.
 */
export class CodexTurnStartUncertainError extends Error {
  constructor(
    message: string,
    /** The thread the turn was started on. */
    readonly threadId: string,
    /** Id of the newest turn the thread had before `turn/start`, when the caller captured it. */
    readonly baselineTurnId: string | undefined,
    /** The most recent frames in receive order, without any task content. */
    readonly frames: readonly CodexWireFrame[],
    /** The turn the `turn/start` response named, when it did. */
    readonly startedTurnId?: string,
    options?: { cause: unknown },
  ) {
    super(message, options)
    this.name = 'CodexTurnStartUncertainError'
  }
}

/** A request named a turn other than the run's: it is rejected, and the run it does not belong to continues. */
class CodexForeignTurnError extends Error {}

function describeFrames(frames: readonly CodexWireFrame[]): string {
  return frames.map(frame =>
    `#${String(frame.order)} ${frame.kind} ${frame.method}${frame.turnId === undefined ? '' : ` turn=${frame.turnId}`}`).join('; ')
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed protocol and stream failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(`subagent-codex: app-server request aborted: ${String(signal.reason)}`)
}

function productToolName(item: JsonObject): string | undefined {
  const type = item.type
  if (typeof type !== 'string') return undefined
  switch (type) {
    case 'commandExecution':
    case 'fileChange':
    case 'mcpToolCall':
    case 'webSearch':
    case 'functionCall':
    case 'dynamicToolCall':
      return type
    default:
      return undefined
  }
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw abortError(signal)
  }
  let rejectAbort!: (error: Error) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => { rejectAbort(abortError(signal)) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One app-server connection and its single ephemeral thread/turn.
 *
 * The class deliberately exposes no generic request surface. Supporting
 * another product method must first become part of the provider contract.
 */
export class CodexAppServerWire {
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private threadId: string | undefined
  private turnId: string | undefined
  private turnCommit: PromiseWithResolvers<string> | undefined
  private baselineTurnId: string | undefined
  private frameOrder = 0
  private readonly frames: CodexWireFrame[] = []
  private turnCompleted: PromiseWithResolvers<JsonObject> | undefined
  private readonly earlyTurnNotifications: Array<{
    readonly method: string
    readonly params: JsonObject
  }> = []
  private lastFinalAnswer: string | undefined
  private lastUnphasedAnswer: string | undefined
  private lastUsage: SubagentUsage | undefined
  private closed = false

  constructor(
    private readonly input: Readable,
    output: Writable,
    private readonly approvalBehavior: 'decline' | 'require' = 'decline',
    private readonly dynamicTools: readonly CodexDynamicToolSpec[] = [],
    private readonly dynamicToolHandler?: (call: CodexDynamicToolCall) => Promise<CodexDynamicToolResult>,
    private readonly observer?: CodexAppServerObserver,
  ) {
    this.transport = new JsonRpcLineTransport(input, output)
    // Fatal protocol state can arrive after the current guarded operation has
    // already settled. Keep the shared rejection observed without inserting
    // another promise-adoption hop into active races.
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleServerRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.recordFrame('notification', method, params)
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.fail(thrown(error))
      }
    })
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    // Pipe errors can race protocol closure and process teardown. Retain both
    // error listeners for the lifetime of their per-run streams so no late
    // EPIPE or read failure becomes an unhandled EventEmitter error.
    output.on('error', this.onOutputError)
  }

  /** Start reading app-server frames. */
  start(): void {
    this.transport.start()
  }

  /**
   * Perform the required app-server initialize/initialized handshake.
   * @param signal - unpublished-start cancellation.
   */
  async initialize(signal: AbortSignal): Promise<void> {
    object(await this.guarded(this.transport.request('initialize', {
      clientInfo: {
        name: 'deepseek-harness',
        title: 'DeepSeek Harness',
        version: '0.0.1',
      },
      capabilities: {
        experimentalApi: this.dynamicTools.length > 0,
        requestAttestation: false,
      },
    }, signal), signal), 'initialize response')
    this.transport.notify('initialized')
    await this.guarded(this.transport.flush(), signal)
  }

  /**
   * Read the current subscription-visible model catalog without starting a turn.
   * @param signal - cancellation for the catalog control request.
   * @returns the validated app-server model rows.
   */
  async listModels(signal: AbortSignal): Promise<CodexAppServerModel[]> {
    const response = object(await this.guarded(this.transport.request('model/list', {
      limit: 100,
      includeHidden: false,
    }, signal), signal), 'model/list response')
    if (!Array.isArray(response.data)) {
      throw new Error('subagent-codex: app-server returned invalid model/list data')
    }
    return response.data.map((value, index) => {
      const model = object(value, `model/list model ${String(index)}`)
      if (!Array.isArray(model.supportedReasoningEfforts)) {
        throw new Error(`subagent-codex: app-server returned invalid model/list efforts ${String(index)}`)
      }
      return {
        id: string(model.id, 'model/list id'),
        model: string(model.model, 'model/list model'),
        displayName: string(model.displayName, 'model/list displayName'),
        description: string(model.description, 'model/list description'),
        hidden: model.hidden === true,
        isDefault: model.isDefault === true,
        defaultReasoningEffort: string(model.defaultReasoningEffort, 'model/list default effort'),
        supportedReasoningEfforts: model.supportedReasoningEfforts.map((entry, effortIndex) => {
          const effort = object(entry, `model/list effort ${String(effortIndex)}`)
          return {
            reasoningEffort: string(effort.reasoningEffort, 'model/list reasoning effort'),
            description: string(effort.description, 'model/list effort description'),
          }
        }),
      }
    })
  }

  /**
   * Read the native account's independently metered allowance pools.
   * @param signal - cancellation for this subscription control request.
   * @returns validated standard and model-specific pools as reported by Codex.
   */
  async readRateLimits(signal: AbortSignal): Promise<CodexAppServerRateLimit[]> {
    const response = object(await this.guarded(this.transport.request('account/rateLimits/read', {}, signal), signal), 'account/rateLimits/read response')
    if (response.rateLimitsByLimitId === null || response.rateLimitsByLimitId === undefined) {
      return [rateLimitSnapshot(response.rateLimits, 'codex')]
    }
    const buckets = object(response.rateLimitsByLimitId, 'account/rateLimits/read buckets')
    return Object.entries(buckets).map(([limitId, value]) => rateLimitSnapshot(value, limitId))
  }

  /**
   * Create the requested private thread and retain its identity.
   * @param cwd - parent Session workspace.
   * @param signal - unpublished-start cancellation.
   * @param ephemeral - whether product history may discard the thread after this run.
   * @param profile - optional native model override for the new thread.
   * @param developerInstructions - optional DSH-owned system instructions for this thread.
   * @param executionBoundary - optional sealed no-approval, read-only native execution boundary.
   */
  async startThread(
    cwd: string,
    signal: AbortSignal,
    ephemeral = true,
    profile?: CodexAppServerExecutionProfile,
    developerInstructions?: string,
    executionBoundary?: CodexAppServerExecutionBoundary,
  ): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/start', {
      cwd,
      ephemeral,
      ...profile === undefined ? {} : { model: profile.model },
      ...developerInstructions === undefined ? {} : { developerInstructions },
      ...this.dynamicTools.length === 0 ? {} : { dynamicTools: this.dynamicTools },
      ...threadStartBoundary(executionBoundary),
    }, signal), signal), 'thread/start response')
    const thread = object(response.thread, 'thread/start thread')
    const id = string(thread.id, 'thread/start thread id')
    if (thread.ephemeral !== ephemeral) {
      throw new Error(ephemeral
        ? 'subagent-codex: app-server did not create an ephemeral thread'
        : 'subagent-codex: app-server did not create the requested persistent thread')
    }
    this.threadId = id
  }

  /**
   * Resume one persisted app-server thread for a new turn.
   * @param threadId - authoritative non-ephemeral product thread identity.
   * @param cwd - canonical workspace for the resumed turn.
   * @param signal - unpublished-start cancellation.
   * @param profile - optional native model override for the resumed thread.
   * @param developerInstructions - optional DSH-owned system instructions for the resumed thread.
   * @param executionBoundary - optional sealed no-approval, read-only native execution boundary.
   */
  async resumeThread(
    threadId: string,
    cwd: string,
    signal: AbortSignal,
    profile?: CodexAppServerExecutionProfile,
    developerInstructions?: string,
    executionBoundary?: CodexAppServerExecutionBoundary,
  ): Promise<void> {
    const response = object(await this.guarded(this.transport.request('thread/resume', {
      threadId,
      cwd,
      ...profile === undefined ? {} : { model: profile.model },
      ...developerInstructions === undefined ? {} : { developerInstructions },
      ...threadResumeBoundary(executionBoundary),
    }, signal), signal), 'thread/resume response')
    const thread = object(response.thread, 'thread/resume thread')
    const id = string(thread.id, 'thread/resume thread id')
    if (id !== threadId) {
      throw new Error('subagent-codex: app-server resumed a different thread')
    }
    if (thread.ephemeral === true) {
      throw new Error('subagent-codex: app-server resumed an ephemeral thread for resident execution')
    }
    this.threadId = id
  }

  /**
   * Ask app-server to compact the current persistent thread in place.
   * @param signal - cancellation for the native compaction request.
   */
  async compactThread(signal: AbortSignal): Promise<void> {
    if (this.threadId === undefined) {
      throw new Error('subagent-codex: cannot compact before a thread is started or resumed')
    }
    object(await this.guarded(this.transport.request('thread/compact/start', {
      threadId: this.threadId,
    }, signal), signal), 'thread/compact/start response')
  }

  /** Native thread identity after start or resume. */
  get currentThreadId(): string | undefined {
    return this.threadId
  }

  /** Native active turn identity after turn/start. */
  get currentTurnId(): string | undefined {
    return this.turnId
  }

  /**
   * Submit the one text-only task and wait for this thread/turn's authoritative
   * terminal notification.
   * @param texts - already validated task text blocks.
   * @param signal - local cancellation for the published run.
   * @param onStarted - optional callback receiving the authoritative native turn identity.
   * @param profile - optional model and reasoning override for this turn.
   * @param executionBoundary - optional sealed no-approval, read-only native execution boundary.
   * @returns the shared subagent result.
   */
  async runTurn(
    texts: readonly string[],
    signal: AbortSignal,
    onStarted?: (turnId: string) => void,
    profile?: CodexAppServerExecutionProfile,
    executionBoundary?: CodexAppServerExecutionBoundary,
  ): Promise<SubagentResult> {
    if (signal.aborted) throw abortError(signal)
    this.resetTurnState()
    const completion = Promise.withResolvers<JsonObject>()
    this.turnCompleted = completion
    const commit = Promise.withResolvers<string>()
    void commit.promise.catch(() => {})
    this.turnCommit = commit
    const threadId = this.threadId as string
    let startedTurnId: string | undefined
    try {
      const response = object(await this.guarded(this.transport.request('turn/start', {
        threadId,
        input: texts.map(text => ({ type: 'text', text, text_elements: [] })),
        ...profile === undefined ? {} : {
          model: profile.model,
          ...profile.effort === undefined ? {} : { effort: profile.effort },
        },
        ...turnStartBoundary(executionBoundary),
      }, signal), signal), 'turn/start response')
      const turn = object(response.turn, 'turn/start turn')
      startedTurnId = string(turn.id, 'turn/start turn id')
      this.recordFrame('response', 'turn/start', { threadId, turnId: startedTurnId })
      this.commitTurnId(startedTurnId)
    } catch (error: unknown) {
      commit.reject(error)
      // A refusal from the server means nothing started. Any other failure leaves the native turn possibly running.
      if (error instanceof JsonRpcResponseError) throw error
      const cause = thrown(error)
      const known = startedTurnId === undefined ? '' : ` (the response named turn ${startedTurnId})`
      throw new CodexTurnStartUncertainError(
        `subagent-codex: turn/start outcome is unknown${known} (${cause.message}); frames: ${describeFrames(this.frames)}`,
        threadId,
        this.baselineTurnId,
        [...this.frames],
        startedTurnId,
        { cause: error },
      )
    }
    onStarted?.(startedTurnId)

    const completed = await this.guarded(completion.promise, signal)
    const terminal = object(completed.turn, 'turn/completed turn')
    const status = terminal.status
    if (isContextWindowExceeded(terminal)) {
      return {
        output: this.collectOutput(),
        stopReason: 'max-tokens',
        ...this.lastUsage === undefined ? {} : { usage: this.lastUsage },
      }
    }
    if (status !== 'completed') {
      const detail = status === 'failed'
        ? `: ${JSON.stringify(terminal.error)}`
        : ''
      throw new Error(`subagent-codex: Codex turn ended with status ${String(status)}${detail}`)
    }
    const output = this.collectOutput()
    if (output.length === 0) {
      throw new Error('subagent-codex: Codex completed without a final answer')
    }
    return {
      output,
      stopReason: 'completed',
      ...this.lastUsage === undefined ? {} : { usage: this.lastUsage },
    }
  }

  /**
   * Record the newest turn the thread has, so a start whose outcome is unknown can tell the turn it may have created
   * from the ones that were already there. A failure leaves the baseline unknown and is not reported.
   * @param signal - cancellation for the control request.
   */
  async captureBaseline(signal: AbortSignal): Promise<void> {
    try {
      this.baselineTurnId = (await this.latestTurn(signal))?.id
    } catch {
      // A thread whose turns cannot be listed has no baseline; the start itself is still attempted.
      this.baselineTurnId = undefined
    }
  }

  private async listTurns(limit: number, signal: AbortSignal): Promise<Array<{ readonly id: string; readonly status: string }>> {
    const response = object(await this.guarded(this.transport.request('thread/turns/list', {
      threadId: this.threadId,
      limit,
      sortDirection: 'desc',
    }, signal), signal), 'thread/turns/list response')
    if (!Array.isArray(response.data)) throw new Error('subagent-codex: app-server returned invalid thread/turns/list data')
    return (response.data as unknown[]).map((value) => {
      const turn = object(value, 'thread/turns/list turn')
      const status = string(turn.status, 'thread/turns/list turn status')
      if (status !== 'inProgress' && !isCodexTerminalTurnStatus(status)) {
        throw new Error(`subagent-codex: app-server returned invalid thread/turns/list turn status ${status}`)
      }
      return { id: string(turn.id, 'thread/turns/list turn id'), status }
    })
  }

  /**
   * Read the newest turn of the current thread.
   * @param signal - cancellation for the control request.
   * @returns its id and status as the app-server reports them, or undefined when the thread has no turn.
   */
  async latestTurn(signal: AbortSignal): Promise<{ readonly id: string; readonly status: string } | undefined> {
    return (await this.listTurns(1, signal))[0]
  }

  /**
   * Read the status of one native turn of the current thread by its id.
   * @param turnId - the turn to look up, such as the one a `turn/start` response named.
   * @param signal - cancellation for the control request.
   * @returns its status as the app-server reports it, or undefined when it is not among the thread's newest turns.
   */
  async turnStatus(turnId: string, signal: AbortSignal): Promise<string | undefined> {
    return (await this.listTurns(20, signal)).find(turn => turn.id === turnId)?.status
  }

  /**
   * Best-effort interruption of one native turn this connection did not start.
   * @param turnId - the native turn to interrupt.
   */
  interruptTurn(turnId: string): void {
    if (this.threadId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => {})
  }

  /**
   * Best-effort remote cancellation. Local settlement and process teardown
   * remain authoritative when the child no longer accepts protocol requests.
   */
  interrupt(): void {
    if (this.threadId === undefined || this.turnId === undefined || this.closed) return
    void this.transport.request('turn/interrupt', {
      threadId: this.threadId,
      turnId: this.turnId,
    }).catch(() => {})
  }

  /**
   * The best non-commentary answer observed so far, preserving exact bytes.
   * @returns the selected final or nullable-phase text block, if any.
   */
  collectOutput(): ContentBlock[] {
    const selected = this.lastFinalAnswer ?? this.lastUnphasedAnswer
    return selected !== undefined && selected.trim().length > 0
      ? [{ type: 'text', text: selected }]
      : []
  }

  /** Detach JSON-RPC listeners and reject outstanding requests. Idempotent. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    const withFatal = Promise.race([this.fatal.promise, pending])
    return raceAbort(withFatal, signal)
  }

  private fail(error: Error): void {
    this.fatal.reject(error)
  }

  private resetTurnState(): void {
    this.turnId = undefined
    this.earlyTurnNotifications.length = 0
    this.lastFinalAnswer = undefined
    this.lastUnphasedAnswer = undefined
    this.lastUsage = undefined
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onOutputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    this.fail(new Error('subagent-codex: app-server protocol stream closed'))
  }

  /**
   * Keep a notification that arrived before the `turn/start` response. The response names this turn; a notification
   * can belong to another turn the app-server runs on the same thread, such as an unfinished turn of an earlier
   * process or one it starts itself, so the id it carries is not a conflict. After the response only the notifications
   * of the responded turn are read again.
   */
  private holdEarlyNotification(method: string, params: JsonObject): void {
    if (this.turnCompleted === undefined) return
    if (this.earlyTurnNotifications.length >= EARLY_NOTIFICATION_LIMIT) {
      throw new Error('subagent-codex: app-server sent too many notifications before the turn/start response')
    }
    this.earlyTurnNotifications.push({ method, params })
  }

  private recordFrame(kind: CodexWireFrame['kind'], method: string, params: JsonObject): void {
    const turn = params.turn
    const turnId = typeof params.turnId === 'string'
      ? params.turnId
      : typeof turn === 'object' && turn !== null && typeof (turn as JsonObject).id === 'string' ? (turn as JsonObject).id as string : undefined
    this.frameOrder += 1
    this.frames.push({
      order: this.frameOrder,
      kind,
      method,
      ...typeof params.threadId === 'string' ? { threadId: params.threadId } : {},
      ...turnId === undefined ? {} : { turnId },
    })
    if (this.frames.length > FRAME_DIAGNOSTIC_LIMIT) this.frames.shift()
  }

  private commitTurnId(id: string): void {
    this.turnId = id
    this.turnCommit?.resolve(id)
    const notifications = this.earlyTurnNotifications.splice(0)
    for (const notification of notifications) {
      this.handleNotification(notification.method, notification.params)
    }
  }

  private validateRunIds(params: JsonObject, nullableTurn = false): void {
    if (params.threadId !== this.threadId) {
      throw new Error('subagent-codex: app-server request referenced another thread')
    }
    if (nullableTurn && params.turnId === null) return
    const id = string(params.turnId, 'server request turn id')
    if (this.turnId === undefined) {
      throw new Error('subagent-codex: app-server referenced a turn before turn/start')
    }
    if (id !== this.turnId) {
      throw new CodexForeignTurnError('subagent-codex: app-server request referenced another turn')
    }
  }

  private handleServerRequest(method: string, params: JsonObject): Promise<unknown> {
    this.recordFrame('request', method, params)
    const commit = this.turnCommit
    if (commit !== undefined && this.turnCompleted !== undefined && this.turnId === undefined && TURN_SCOPED_REQUESTS.has(method)) {
      // The turn the request names is checked against the responded turn, so a stale or foreign turn's tool call or
      // approval is never answered before the run knows its own turn.
      return commit.promise.then(() => this.answerServerRequest(method, params))
    }
    return this.answerServerRequest(method, params)
  }

  private answerServerRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      switch (method) {
        case 'item/tool/call': {
          this.validateRunIds(params)
          if (this.dynamicToolHandler === undefined) throw new Error('subagent-codex: dynamic tool handler is unavailable')
          const tool = string(params.tool, 'dynamic tool name')
          const callId = string(params.callId, 'dynamic tool call id')
          const argumentsValue = object(params.arguments, 'dynamic tool arguments')
          return this.dynamicToolHandler({
            threadId: string(params.threadId, 'dynamic tool thread id'),
            turnId: string(params.turnId, 'dynamic tool turn id'),
            callId,
            ...typeof params.namespace === 'string' ? { namespace: params.namespace } : {},
            tool,
            arguments: argumentsValue,
          }).then(result => ({
            success: result.success,
            contentItems: [{ type: 'inputText', text: result.text }],
          }))
        }
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval': {
          this.validateRunIds(params)
          const response = { decision: unattendedDecision(params) }
          this.requireApproval(method)
          return Promise.resolve(response)
        }
        case 'item/permissions/requestApproval': {
          this.validateRunIds(params)
          const response = { permissions: {}, scope: 'turn' }
          this.requireApproval(method)
          return Promise.resolve(response)
        }
        case 'item/tool/requestUserInput': {
          this.validateRunIds(params)
          const response = { answers: {} }
          this.requireApproval(method)
          return Promise.resolve(response)
        }
        case 'mcpServer/elicitation/request': {
          this.validateRunIds(params, true)
          const response = { action: 'decline', content: null, _meta: null }
          this.requireApproval(method)
          return Promise.resolve(response)
        }
        default:
          throw new Error(`subagent-codex: unsupported app-server request ${JSON.stringify(method)}`)
      }
    } catch (error: unknown) {
      const normalized = thrown(error)
      if (!(normalized instanceof CodexForeignTurnError)) this.fail(normalized)
      return Promise.reject(normalized)
    }
  }

  private requireApproval(method: string): void {
    this.observer?.({ kind: 'approval-required', approvalKind: method })
    if (this.approvalBehavior === 'require') {
      this.fail(new CodexApprovalRequiredError(method))
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (method === 'turn/started') {
      const threadId = string(params.threadId, 'turn/started thread id')
      if (threadId !== this.threadId) return
      string(object(params.turn, 'turn/started turn').id, 'turn/started turn id')
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const threadId = string(params.threadId, 'thread/tokenUsage/updated thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'thread/tokenUsage/updated turn id')
      if (this.turnId === undefined) {
        this.holdEarlyNotification(method, params)
        return
      }
      if (id !== this.turnId) return
      const usage = object(params.tokenUsage, 'thread/tokenUsage/updated tokenUsage')
      this.lastUsage = tokenUsage(usage.last)
      this.observer?.({ kind: 'usage-updated', usage: this.lastUsage })
      return
    }
    if (method === 'item/started') {
      const threadId = string(params.threadId, 'item/started thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/started turn id')
      if (this.turnId === undefined) {
        this.holdEarlyNotification(method, params)
        return
      }
      if (id !== this.turnId) return
      const toolName = productToolName(object(params.item, 'item/started item'))
      if (toolName !== undefined) this.observer?.({ kind: 'tool-started', toolName })
      return
    }
    if (method === 'item/completed') {
      const threadId = string(params.threadId, 'item/completed thread id')
      if (threadId !== this.threadId) return
      const id = string(params.turnId, 'item/completed turn id')
      if (this.turnId === undefined) {
        this.holdEarlyNotification(method, params)
        return
      }
      if (id !== this.turnId) return
      const item = object(params.item, 'item/completed item')
      if (item.type !== 'agentMessage') {
        const toolName = productToolName(item)
        if (toolName !== undefined) this.observer?.({ kind: 'tool-completed', toolName })
        return
      }
      const text = typeof item.text === 'string'
        ? item.text
        : (() => { throw new Error('subagent-codex: app-server returned an invalid agent message') })()
      if (item.phase === 'final_answer') {
        this.lastFinalAnswer = text
      } else if (item.phase === null) {
        this.lastUnphasedAnswer = text
      } else if (item.phase !== 'commentary') {
        throw new Error(`subagent-codex: app-server returned an unknown agent message phase ${JSON.stringify(item.phase)}`)
      }
      this.observer?.({ kind: 'public-output', preview: text })
      return
    }
    if (method !== 'turn/completed') return
    const threadId = string(params.threadId, 'turn/completed thread id')
    if (threadId !== this.threadId) return
    const turn = object(params.turn, 'turn/completed turn')
    const id = string(turn.id, 'turn/completed turn id')
    const turnCompleted = this.turnCompleted
    if (turnCompleted === undefined) return
    if (this.turnId === undefined) {
      this.holdEarlyNotification(method, params)
      return
    }
    if (id !== this.turnId) return
    if (!isCodexTerminalTurnStatus(String(turn.status))) {
      throw new Error(`subagent-codex: app-server returned invalid terminal turn status ${String(turn.status)}`)
    }
    turnCompleted.resolve(params)
  }
}

/** Product-native request that a headless Resident caller must resolve out of band. */
export class CodexApprovalRequiredError extends Error {
  constructor(readonly method: string) {
    super(`Codex requires interactive approval for ${method}`)
    this.name = 'CodexApprovalRequiredError'
  }
}
