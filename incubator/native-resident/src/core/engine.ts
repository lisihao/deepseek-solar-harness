import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, posix, resolve as resolvePath } from 'node:path'

import {
  type Executor,
  type GraphSnapshot,
  type GraphStatus,
  type ModelCatalog,
  type NativeDriver,
  type NativeDrivers,
  type NativeModel,
  type NativeProfile,
  type NativeToolBridge,
  type NativeToolDefinition,
  type NodeSnapshot,
  type NodeStatus,
  type ResidentApi,
  type ResidentEvent,
  ResidentError,
  type TaskGraph,
  type TaskNode,
  type TaskResult,
  type NativeAccess,
  type TaskScope,
} from '../contracts.js'

const SCHEMA_VERSION = 2
const MAX_TEXT_LENGTH = 1_000_000
const MAX_PROMPT_LENGTH = 1_000_000
const MAX_NODES = 4_096
const MAX_PARALLEL = 64
const DEPENDENCY_INPUT_START = '--- BEGIN RESIDENT DEPENDENCY INPUTS (JSON) ---'
const DEPENDENCY_INPUT_END = '--- END RESIDENT DEPENDENCY INPUTS ---'

type Row = Record<string, unknown>

type GraphRow = Row & {
  id: string
  graph_json: string
  graph_hash: string
  status: string
  cancel_requested: number
  revision: number
  created_at: number
  updated_at: number
}

type NodeRow = Row & {
  graph_id: string
  node_id: string
  node_json: string
  status: string
  attempt: number
  command_id: string | null
  output: string | null
  error_code: string | null
  error_message: string | null
  native_session_id: string | null
  available_at: number
  wait_reason: string | null
  updated_at: number
}

type SessionRow = Row & {
  executor: string
  cwd: string
  session_key: string
  native_session_id: string | null
  profile_json: string
  bridge_catalog_digest: string | null
  state: string
  owner_graph_id: string | null
  owner_node_id: string | null
}

interface Candidate {
  readonly graph: TaskGraph
  readonly graphRow: GraphRow
  readonly node: TaskNode
  readonly nodeRow: NodeRow
  readonly bridge?: NativeToolBridge
  readonly bridgeCatalogDigest: string | null
}

interface ActiveExecution {
  readonly key: string
  readonly graphId: string
  readonly nodeId: string
  readonly executor: Executor
  readonly cwd: string
  readonly prompt: string
  readonly access: NativeAccess
  readonly sessionKey?: string
  readonly profile?: NativeProfile
  readonly profileJson: string
  readonly bridge?: NativeToolBridge
  readonly bridgeCatalogDigest: string | null
  readonly commandId: string
  readonly attempt: number
  readonly driver: NativeDriver
  readonly controller: AbortController
  nativeSessionId?: string
  fenced: boolean
  started: boolean
  cancelRequested: boolean
  shutdownAbort: boolean
  promise?: Promise<void>
}

export interface ResidentEngineOptions {
  readonly maxParallel?: number
  readonly now?: () => number
  readonly tickMs?: number
  /** Resolves an in-memory bridge without persisting credentials or endpoints. */
  readonly resolveBridge?: (id: string) => NativeToolBridge | undefined
}

export interface ToolCallResult {
  readonly content: string
  readonly isError: boolean
}

export type ToolCallAction = (signal: AbortSignal) => Promise<ToolCallResult>

/**
 * The daemon-local durable TaskGraph implementation.  Database ownership is
 * intentionally external: a daemon is the only writer for its database file.
 */
export class ResidentEngine implements ResidentApi {
  readonly protocolVersion = 1 as const

  private database?: DatabaseSync
  private opened = false
  private closing = false
  private closePromise?: Promise<void>
  private timer?: NodeJS.Timeout
  private ticking = false
  private tickQueued = false
  private schedulerFailure?: ResidentError
  private readonly active = new Map<string, ActiveExecution>()
  private readonly activeToolCalls = new Map<string, { controller: AbortController; promise: Promise<ToolCallResult> }>()
  private readonly maxParallel: number
  private readonly now: () => number
  private readonly tickMs: number
  private readonly resolveBridge?: (id: string) => NativeToolBridge | undefined

  constructor(
    private readonly databasePath: string,
    private readonly drivers: NativeDrivers,
    options: ResidentEngineOptions = {},
  ) {
    this.maxParallel = positiveInteger(options.maxParallel ?? 4, 'maxParallel', MAX_PARALLEL)
    this.tickMs = positiveInteger(options.tickMs ?? 50, 'tickMs', 60_000)
    this.now = options.now ?? Date.now
    this.resolveBridge = options.resolveBridge
  }

  async open(): Promise<void> {
    if (this.opened) return
    if (this.closing) throw new ResidentError('RESIDENT_CLOSING', 'Resident engine is closing')

    let database: DatabaseSync
    try {
      database = new DatabaseSync(this.databasePath, {
        enableForeignKeyConstraints: true,
        defensive: true,
        // A second daemon must fail rather than wait long enough to race recovery.
        timeout: 0,
      })
    } catch (error) {
      throw normalizeDatabaseLockError(error)
    }

    try {
      this.database = database
      database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
      this.initializeSchema()
      this.recoverInterruptedWork()
      this.schedulerFailure = undefined
      this.opened = true
      this.timer = setInterval(() => this.requestTick(), this.tickMs)
      this.timer.unref?.()
      this.requestTick()
    } catch (error) {
      this.database = undefined
      database.close()
      throw normalizeDatabaseLockError(error)
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    if (!this.database) return

    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  async submit(request: { readonly commandId: string; readonly graph: TaskGraph }): Promise<GraphSnapshot> {
    this.requireOpen()
    this.requireSchedulerHealthy()
    const normalized = normalizeSubmit(request)
    for (const node of normalized.graph.nodes) this.requireDriver(node.executor)

    const requestHash = hashValue({ kind: 'submit', request: normalized })
    const snapshot = this.transaction(() => {
      const receipt = this.readReceipt(normalized.commandId, requestHash, 'submit')
      if (receipt) return receipt

      const existing = this.one<GraphRow>('SELECT * FROM graphs WHERE id = ?', normalized.graph.id)
      if (existing) throw new ResidentError('GRAPH_EXISTS', `Graph ${normalized.graph.id} already exists`)
      const now = this.currentTime()
      this.reserveSessionProfiles(normalized.graph, now)
      const graphHash = hashValue(normalized.graph)
      this.run(
        `INSERT INTO graphs (id, graph_json, graph_hash, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 1, ?, ?)`,
        normalized.graph.id,
        JSON.stringify(normalized.graph),
        graphHash,
        now,
        now,
      )

      for (const node of normalized.graph.nodes) {
        const availableAt = Math.max(normalized.graph.notBefore ?? 0, node.notBefore ?? 0)
        this.run(
          `INSERT INTO nodes (
             graph_id, node_id, node_json, status, attempt, command_id, output,
             error_code, error_message, native_session_id, available_at, wait_reason, updated_at
           ) VALUES (?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?, 'dependencies', ?)`,
          normalized.graph.id,
          node.id,
          JSON.stringify(node),
          availableAt,
          now,
        )
      }
      this.event(normalized.graph.id, undefined, 'graph.admitted', 'Graph admission was persisted', now)
      const admitted = this.snapshot(normalized.graph.id)
      this.writeReceipt(normalized.commandId, 'submit', requestHash, admitted, now)
      return admitted
    })

    this.requestTick()
    return snapshot
  }

  async inspect(graphId: string): Promise<GraphSnapshot> {
    this.requireOpen()
    return this.snapshot(requireOpaqueId(graphId, 'graphId'))
  }

  async list(): Promise<readonly GraphSnapshot[]> {
    this.requireOpen()
    const rows = this.all<GraphRow>('SELECT * FROM graphs ORDER BY created_at ASC, id ASC')
    return rows.map((row) => this.snapshot(row.id))
  }

  async control(request: {
    readonly commandId: string
    readonly graphId: string
    readonly action: 'pause' | 'resume' | 'cancel'
    readonly expectedRevision: number
  }): Promise<GraphSnapshot> {
    this.requireOpen()
    const normalized = normalizeControl(request)
    const requestHash = hashValue({ kind: 'control', request: normalized })
    let abort: ActiveExecution[] = []

    const snapshot = this.transaction(() => {
      const receipt = this.readReceipt(normalized.commandId, requestHash, 'control')
      if (receipt) return receipt

      const graph = this.requireGraph(normalized.graphId)
      this.assertRevision(graph, normalized.expectedRevision)
      const now = this.currentTime()

      if (normalized.action === 'pause') {
        if (graph.status !== 'queued' && graph.status !== 'running') {
          throw new ResidentError('CONTROL_INVALID', `Graph ${graph.id} cannot be paused from ${graph.status}`)
        }
        this.setGraphStatus(graph.id, 'paused', now, 'graph.paused', 'New admissions were paused')
      } else if (normalized.action === 'resume') {
        if (graph.status !== 'paused') {
          throw new ResidentError('CONTROL_INVALID', `Graph ${graph.id} is not paused`)
        }
        this.setGraphStatus(graph.id, 'queued', now, 'graph.resumed', 'New admissions were resumed')
      } else {
        if (graph.status === 'completed' || graph.status === 'failed' || graph.status === 'cancelled') {
          throw new ResidentError('CONTROL_INVALID', `Graph ${graph.id} is already terminal`)
        }
        this.markGraphCancellationRequested(graph.id, now)
        this.run(
          `UPDATE nodes
             SET status = 'cancelled', wait_reason = 'cancelled', updated_at = ?
           WHERE graph_id = ? AND status IN ('pending', 'ready')`,
          now,
          graph.id,
        )
        const activeNodes = this.all<NodeRow>(
          `SELECT * FROM nodes WHERE graph_id = ? AND status IN ('running', 'cancelling')`,
          graph.id,
        )
        if (activeNodes.length > 0 && graph.status !== 'indeterminate') {
          this.setGraphStatus(
            graph.id,
            'cancelling',
            now,
            'graph.cancelling',
            'Cancellation request was accepted; active native work is still settling',
          )
        }
        for (const node of activeNodes) {
          this.run(
            `UPDATE nodes
               SET status = 'cancelling', wait_reason = 'cancellation-requested', updated_at = ?
             WHERE graph_id = ? AND node_id = ?`,
            now,
            graph.id,
            node.node_id,
          )
          this.run(
            `UPDATE attempts SET status = 'cancel_requested'
             WHERE graph_id = ? AND node_id = ? AND attempt = ? AND status IN ('prepared', 'running', 'cancel_requested')`,
            graph.id,
            node.node_id,
            node.attempt,
          )
          const active = this.active.get(activeKey(graph.id, node.node_id))
          if (active) {
            active.cancelRequested = true
            abort.push(active)
          } else {
            this.markPersistedRunningIndeterminate(graph.id, node.node_id, now, 'CANCEL_REQUEST_UNCONFIRMED', 'Cancellation could not reach a local driver')
          }
          this.event(graph.id, node.node_id, 'node.cancel-requested', 'Cancellation was requested', now)
        }
        if (activeNodes.length === 0) {
          this.refreshGraphStatus(graph.id, now)
        }
      }

      const response = this.snapshot(graph.id)
      this.writeReceipt(normalized.commandId, 'control', requestHash, response, now)
      return response
    })

    for (const active of abort) active.controller.abort()
    this.requestTick()
    return snapshot
  }

  async resolve(request: {
    readonly commandId: string
    readonly graphId: string
    readonly nodeId: string
    readonly decision: 'retry' | 'fail'
    readonly expectedRevision: number
  }): Promise<GraphSnapshot> {
    this.requireOpen()
    const normalized = normalizeResolve(request)
    const requestHash = hashValue({ kind: 'resolve', request: normalized })

    const snapshot = this.transaction(() => {
      const receipt = this.readReceipt(normalized.commandId, requestHash, 'resolve')
      if (receipt) return receipt

      const graph = this.requireGraph(normalized.graphId)
      this.assertRevision(graph, normalized.expectedRevision)
      if ([...this.active.values()].some((active) => active.graphId === graph.id)) {
        throw new ResidentError('ACTIVE', `Graph ${graph.id} still has an active native driver`)
      }
      if (graph.status === 'cancelled' || graph.status === 'completed' || graph.status === 'failed') {
        throw new ResidentError('RESOLUTION_INVALID', `Graph ${graph.id} is terminal`)
      }
      const node = this.requireNode(graph.id, normalized.nodeId)
      if (node.status !== 'indeterminate') {
        throw new ResidentError('RESOLUTION_INVALID', `Node ${node.node_id} is not indeterminate`)
      }

      const taskNode = this.readNodeDefinition(node)
      const now = this.currentTime()
      if (normalized.decision === 'retry') {
        const retry = taskNode.retry
        if (!retry || node.attempt >= retry.maxAttempts) {
          throw new ResidentError('RETRY_EXHAUSTED', `Node ${node.node_id} has no remaining retry attempts`)
        }
        this.releaseFencedSession(graph.id, node.node_id, now)
        this.clearGraphCancellationRequested(graph.id, now)
        this.run(
          `UPDATE nodes
             SET status = 'pending', command_id = NULL, output = NULL, error_code = NULL,
                 error_message = NULL, native_session_id = NULL, available_at = ?,
                 wait_reason = 'owner-retry', updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          now,
          now,
          graph.id,
          node.node_id,
        )
        this.bumpGraph(graph.id, now)
        this.event(graph.id, node.node_id, 'node.owner-retry', 'Owner resolved an indeterminate attempt by retrying', now)
        this.setGraphStatus(graph.id, 'queued', now)
      } else {
        this.releaseFencedSession(graph.id, node.node_id, now)
        this.run(
          `UPDATE nodes
             SET status = 'failed', error_code = 'OWNER_RESOLVED_FAILED',
                 error_message = 'Owner resolved the indeterminate outcome as failed',
                 wait_reason = 'owner-failed', updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          now,
          graph.id,
          node.node_id,
        )
        this.bumpGraph(graph.id, now)
        this.event(graph.id, node.node_id, 'node.owner-failed', 'Owner resolved an indeterminate attempt as failed', now)
        this.setGraphStatus(graph.id, 'queued', now)
        this.refreshGraphStatus(graph.id, now)
      }

      const response = this.snapshot(graph.id)
      this.writeReceipt(normalized.commandId, 'resolve', requestHash, response, now)
      return response
    })

    this.requestTick()
    return snapshot
  }

  async events(graphId: string, after = 0, limit = 100): Promise<readonly ResidentEvent[]> {
    this.requireOpen()
    const normalizedGraphId = requireOpaqueId(graphId, 'graphId')
    this.requireGraph(normalizedGraphId)
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new ResidentError('REQUEST_INVALID', 'after must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ResidentError('REQUEST_INVALID', 'limit must be an integer between 1 and 1000')
    }

    const rows = this.all<Row>(
      `SELECT sequence, graph_id, node_id, type, time, detail
       FROM events WHERE graph_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT ?`,
      normalizedGraphId,
      after,
      limit,
    )
    return rows.map((row) => ({
      sequence: asNumber(row.sequence, 'event sequence'),
      graphId: asString(row.graph_id, 'event graph id'),
      ...(row.node_id === null ? {} : { nodeId: asString(row.node_id, 'event node id') }),
      type: asString(row.type, 'event type'),
      time: asNumber(row.time, 'event time'),
      detail: asString(row.detail, 'event detail'),
    }))
  }

  async models(cwd: string): Promise<readonly ModelCatalog[]> {
    this.requireOpen()
    const normalizedCwd = normalizeCwd(cwd)
    const executors: readonly Executor[] = ['codex', 'claude-code']
    return Promise.all(executors.map(async (executor) => {
      const driver = this.drivers[executor]
      if (!driver) return { executor, models: [], unavailableReason: 'DRIVER_UNAVAILABLE' }
      if (!driver.models) return { executor, models: [], unavailableReason: 'MODEL_CATALOG_UNAVAILABLE' }
      try {
        return { executor, models: normalizeModels(await driver.models(normalizedCwd)) }
      } catch (error) {
        return { executor, models: [], unavailableReason: `MODEL_CATALOG_ERROR:${normalizeDriverError(error).code}` }
      }
    }))
  }

  /** Records a credential-free bridge catalog whose digest is bound to resumed sessions. */
  async registerBridgeCatalog(bridgeId: string, tools: readonly NativeToolDefinition[]): Promise<void> {
    this.requireOpen()
    const normalizedBridgeId = requireOpaqueId(bridgeId, 'bridgeId')
    const normalizedTools = normalizeBridgeTools(tools)
    const toolsJson = stableJson(normalizedTools)
    const digest = hashValue(normalizedTools)
    this.transaction(() => {
      const now = this.currentTime()
      this.run(
        `INSERT INTO bridge_catalogs (bridge_id, digest, tools_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(bridge_id) DO UPDATE SET digest = excluded.digest, tools_json = excluded.tools_json, updated_at = excluded.updated_at`,
        normalizedBridgeId,
        digest,
        toolsJson,
        now,
      )
    })
  }

  /**
   * Persists a host-tool admission before effecting the bridge. An unfinished
   * admission is deliberately indeterminate on retry or daemon recovery.
   */
  async executeToolCall(
    commandId: string,
    callId: string,
    name: string,
    args: unknown,
    action: ToolCallAction,
  ): Promise<ToolCallResult> {
    this.requireOpen()
    if (typeof action !== 'function') throw new ResidentError('REQUEST_INVALID', 'tool call action must be a function')
    const normalizedCommandId = requireOpaqueId(commandId, 'tool commandId')
    const normalizedCallId = requireOpaqueId(callId, 'tool callId')
    const normalizedName = requireOpaqueId(name, 'tool name')
    const argsJson = stableJson(args)
    const payloadHash = hashValue({
      commandId: normalizedCommandId,
      callId: normalizedCallId,
      name: normalizedName,
      args: JSON.parse(argsJson) as unknown,
    })
    const key = toolCallKey(normalizedCommandId, normalizedCallId)

    const cached = this.transaction(() => {
      const row = this.one<Row>(
        'SELECT * FROM tool_calls WHERE command_id = ? AND call_id = ?',
        normalizedCommandId,
        normalizedCallId,
      )
      if (row) {
        if (row.payload_hash !== payloadHash || row.name !== normalizedName || row.args_json !== argsJson) {
          throw new ResidentError('COMMAND_CONFLICT', `Tool call ${normalizedCallId} was already used with different input`)
        }
        if (row.status === 'settled') return parseToolCallResult(asString(row.result_json, 'tool call result'))
        throw new ResidentError('COMMAND_INDETERMINATE', `Tool call ${normalizedCallId} was accepted without a settled receipt`)
      }
      const now = this.currentTime()
      this.run(
        `INSERT INTO tool_calls (
           command_id, call_id, name, args_json, payload_hash, status, result_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'accepted', NULL, ?, ?)`,
        normalizedCommandId,
        normalizedCallId,
        normalizedName,
        argsJson,
        payloadHash,
        now,
        now,
      )
      this.bridgeToolEvent(normalizedCommandId, normalizedCallId, normalizedName, 'bridge.call-accepted', now)
      return undefined
    })
    if (cached) return cached

    const controller = new AbortController()
    const running = this.runToolAction(key, normalizedCommandId, normalizedCallId, normalizedName, action, controller)
    this.activeToolCalls.set(key, { controller, promise: running })
    try {
      return await running
    } finally {
      this.activeToolCalls.delete(key)
    }
  }

  private async runToolAction(
    key: string,
    commandId: string,
    callId: string,
    name: string,
    action: ToolCallAction,
    controller: AbortController,
  ): Promise<ToolCallResult> {
    try {
      const result = normalizeToolCallResult(await action(controller.signal))
      this.transaction(() => {
        const row = this.one<Row>('SELECT * FROM tool_calls WHERE command_id = ? AND call_id = ?', commandId, callId)
        if (!row || row.status !== 'accepted') {
          throw new ResidentError('COMMAND_INDETERMINATE', `Tool call ${callId} lost its active receipt`)
        }
        const now = this.currentTime()
        this.run(
          `UPDATE tool_calls SET status = 'settled', result_json = ?, updated_at = ?
           WHERE command_id = ? AND call_id = ?`,
          JSON.stringify(result),
          now,
          commandId,
          callId,
        )
        this.bridgeToolEvent(commandId, callId, name, 'bridge.call-settled', now)
      })
      return result
    } catch (error) {
      if (this.database) {
        this.transaction(() => {
          const row = this.one<Row>('SELECT * FROM tool_calls WHERE command_id = ? AND call_id = ?', commandId, callId)
          if (row?.status === 'accepted') {
            const now = this.currentTime()
            this.run(
              `UPDATE tool_calls SET status = 'indeterminate', updated_at = ? WHERE command_id = ? AND call_id = ?`,
              now,
              commandId,
              callId,
            )
            this.bridgeToolEvent(commandId, callId, name, 'bridge.call-indeterminate', now)
          }
        })
      }
      const failure = normalizeDriverError(error)
      throw new ResidentError('COMMAND_INDETERMINATE', `Tool call ${callId} did not settle: ${failure.code}`)
    } finally {
      // Keep this local binding explicit: a future cancellation path must not reuse it.
      this.activeToolCalls.delete(key)
    }
  }

  private async closeInternal(): Promise<void> {
    const database = this.database
    if (!database) return
    this.closing = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined

    const active = [...this.active.values()]
    const toolCalls = [...this.activeToolCalls.values()]
    try {
      this.transaction(() => {
        const now = this.currentTime()
        const cancellingGraphs = new Set<string>()
        for (const execution of active) {
          if (execution.fenced) continue
          execution.shutdownAbort = true
          const node = this.requireNode(execution.graphId, execution.nodeId)
          if (!isActiveNodeStatus(node.status) || node.command_id !== execution.commandId) continue
          this.markGraphCancellationRequested(execution.graphId, now)
          this.run(
            `UPDATE nodes
               SET status = 'cancelling', wait_reason = 'shutdown-cancellation-requested', updated_at = ?
             WHERE graph_id = ? AND node_id = ?`,
            now,
            execution.graphId,
            execution.nodeId,
          )
          this.run(
            `UPDATE attempts SET status = 'cancel_requested'
             WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ?
               AND status IN ('prepared', 'running', 'cancel_requested')`,
            execution.graphId,
            execution.nodeId,
            execution.attempt,
            execution.commandId,
          )
          this.setGraphStatus(execution.graphId, 'cancelling', now)
          this.event(execution.graphId, execution.nodeId, 'node.cancel-requested', 'Shutdown requested native cancellation', now)
          cancellingGraphs.add(execution.graphId)
        }
        for (const graphId of cancellingGraphs) {
          this.run(
            `UPDATE nodes
               SET status = 'cancelled', wait_reason = 'cancelled', updated_at = ?
             WHERE graph_id = ? AND status IN ('pending', 'ready')`,
            now,
            graphId,
          )
        }
      })
      for (const execution of active) execution.controller.abort()
      for (const toolCall of toolCalls) toolCall.controller.abort()
      const closers = [...new Set(Object.values(this.drivers).filter((driver): driver is NativeDriver => !!driver))]
        .filter((driver) => typeof driver.close === 'function')
        .map(async (driver) => driver.close?.())
      await Promise.allSettled(closers)
      await Promise.allSettled(active.map((execution) => execution.promise ?? Promise.resolve()))
      await Promise.allSettled(toolCalls.map((toolCall) => toolCall.promise))
    } finally {
      this.active.clear()
      this.activeToolCalls.clear()
      this.opened = false
      database.close()
      this.database = undefined
      this.closing = false
      this.closePromise = undefined
    }
  }

  private initializeSchema(): void {
    const existing = this.all<Row>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).map((row) => asString(row.name, 'table name'))

    if (existing.length === 0) {
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          ) STRICT;
          CREATE TABLE graphs (
            id TEXT PRIMARY KEY,
            graph_json TEXT NOT NULL,
            graph_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE nodes (
            graph_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            node_json TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            command_id TEXT,
            output TEXT,
            error_code TEXT,
            error_message TEXT,
            native_session_id TEXT,
            available_at INTEGER NOT NULL,
            wait_reason TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (graph_id, node_id),
            FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE
          ) STRICT;
          CREATE TABLE attempts (
            graph_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            attempt INTEGER NOT NULL,
            command_id TEXT NOT NULL UNIQUE,
            command_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            native_session_id TEXT,
            created_at INTEGER NOT NULL,
            settled_at INTEGER,
            PRIMARY KEY (graph_id, node_id, attempt),
            FOREIGN KEY (graph_id, node_id) REFERENCES nodes(graph_id, node_id) ON DELETE CASCADE
          ) STRICT;
          CREATE TABLE command_receipts (
            command_id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            request_hash TEXT NOT NULL,
            response_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE native_sessions (
            executor TEXT NOT NULL,
            cwd TEXT NOT NULL,
            session_key TEXT NOT NULL,
            native_session_id TEXT,
            profile_json TEXT NOT NULL,
            bridge_catalog_digest TEXT,
            state TEXT NOT NULL,
            owner_graph_id TEXT,
            owner_node_id TEXT,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (executor, cwd, session_key)
          ) STRICT;
          CREATE TABLE tool_calls (
            command_id TEXT NOT NULL,
            call_id TEXT NOT NULL,
            name TEXT NOT NULL,
            args_json TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            result_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (command_id, call_id)
          ) STRICT;
          CREATE TABLE bridge_catalogs (
            bridge_id TEXT PRIMARY KEY,
            digest TEXT NOT NULL,
            tools_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            graph_id TEXT NOT NULL,
            node_id TEXT,
            type TEXT NOT NULL,
            time INTEGER NOT NULL,
            detail TEXT NOT NULL,
            FOREIGN KEY (graph_id) REFERENCES graphs(id) ON DELETE CASCADE
          ) STRICT;
          CREATE INDEX nodes_by_graph_status ON nodes (graph_id, status);
          CREATE INDEX events_by_graph_sequence ON events (graph_id, sequence);
          CREATE INDEX tool_calls_by_status ON tool_calls (status);
          INSERT INTO meta (key, value) VALUES ('schema_version', '2'), ('protocol_version', '1');
        `)
      })
      return
    }

    const required = new Set(['attempts', 'bridge_catalogs', 'command_receipts', 'events', 'graphs', 'meta', 'native_sessions', 'nodes', 'tool_calls'])
    if (existing.length !== required.size || existing.some((name) => !required.has(name))) {
      throw new ResidentError('DATABASE_SCHEMA_UNSUPPORTED', 'Database tables do not match the resident schema')
    }
    const schema = this.one<Row>("SELECT value FROM meta WHERE key = 'schema_version'")
    const protocol = this.one<Row>("SELECT value FROM meta WHERE key = 'protocol_version'")
    if (schema?.value !== String(SCHEMA_VERSION) || protocol?.value !== '1') {
      throw new ResidentError('DATABASE_SCHEMA_UNSUPPORTED', 'Database schema or protocol version is unsupported')
    }
    this.assertStrictSchemaColumns()
  }

  private assertStrictSchemaColumns(): void {
    const expected: Readonly<Record<string, readonly string[]>> = {
      meta: ['key', 'value'],
      graphs: ['id', 'graph_json', 'graph_hash', 'status', 'cancel_requested', 'revision', 'created_at', 'updated_at'],
      nodes: ['graph_id', 'node_id', 'node_json', 'status', 'attempt', 'command_id', 'output', 'error_code', 'error_message', 'native_session_id', 'available_at', 'wait_reason', 'updated_at'],
      attempts: ['graph_id', 'node_id', 'attempt', 'command_id', 'command_hash', 'status', 'native_session_id', 'created_at', 'settled_at'],
      command_receipts: ['command_id', 'kind', 'request_hash', 'response_json', 'created_at'],
      native_sessions: ['executor', 'cwd', 'session_key', 'native_session_id', 'profile_json', 'bridge_catalog_digest', 'state', 'owner_graph_id', 'owner_node_id', 'updated_at'],
      tool_calls: ['command_id', 'call_id', 'name', 'args_json', 'payload_hash', 'status', 'result_json', 'created_at', 'updated_at'],
      bridge_catalogs: ['bridge_id', 'digest', 'tools_json', 'updated_at'],
      events: ['sequence', 'graph_id', 'node_id', 'type', 'time', 'detail'],
    }
    for (const [table, columns] of Object.entries(expected)) {
      const actual = this.all<Row>(`PRAGMA table_info(${table})`).map((row) => asString(row.name, `${table} column`))
      if (actual.length !== columns.length || actual.some((column, index) => column !== columns[index])) {
        throw new ResidentError('DATABASE_SCHEMA_UNSUPPORTED', `Database table ${table} does not match the resident schema`)
      }
    }
  }

  private recoverInterruptedWork(): void {
    this.transaction(() => {
      const now = this.currentTime()
      const interrupted = this.all<NodeRow>("SELECT * FROM nodes WHERE status IN ('running', 'cancelling')")
      const affectedGraphs = new Set<string>()
      for (const node of interrupted) {
        this.run(
          `UPDATE nodes
             SET status = 'indeterminate', error_code = 'RECOVERY_INDETERMINATE',
                 error_message = 'The daemon restarted before the native outcome was confirmed',
                 wait_reason = 'owner-resolution-required', updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          now,
          node.graph_id,
          node.node_id,
        )
        this.run(
          `UPDATE attempts SET status = 'indeterminate', settled_at = ?
           WHERE graph_id = ? AND node_id = ? AND attempt = ? AND status IN ('prepared', 'running', 'cancel_requested')`,
          now,
          node.graph_id,
          node.node_id,
          node.attempt,
        )
        this.event(
          node.graph_id,
          node.node_id,
          'node.recovered-indeterminate',
          'Recovery fenced an unconfirmed native outcome',
          now,
        )
        affectedGraphs.add(node.graph_id)
      }
      this.run("UPDATE native_sessions SET state = 'fenced', updated_at = ? WHERE state = 'active'", now)
      this.run("UPDATE tool_calls SET status = 'indeterminate', updated_at = ? WHERE status = 'accepted'", now)
      this.run("UPDATE nodes SET status = 'pending', wait_reason = 'recovery-ready', updated_at = ? WHERE status = 'ready'", now)

      for (const graphId of affectedGraphs) {
        const graph = this.requireGraph(graphId)
        if (graph.status !== 'cancelled') {
          this.setGraphStatus(graphId, 'indeterminate', now, 'graph.recovered-indeterminate', 'Owner resolution is required after recovery')
        }
      }

      const cancellationInterrupted = this.all<GraphRow>(
        `SELECT * FROM graphs
         WHERE (status = 'cancelling' OR cancel_requested != 0)
           AND status NOT IN ('completed', 'failed', 'cancelled', 'indeterminate')`,
      )
      for (const graph of cancellationInterrupted) {
        if (affectedGraphs.has(graph.id)) continue
        this.setGraphStatus(
          graph.id,
          'indeterminate',
          now,
          'graph.recovered-indeterminate',
          'Recovery could not confirm the cancellation outcome',
        )
      }

      const restartable = this.all<GraphRow>("SELECT * FROM graphs WHERE status = 'running'")
      for (const graph of restartable) this.refreshGraphStatus(graph.id, now)
    })
  }

  private requestTick(): void {
    if (!this.opened || this.closing || this.tickQueued || this.schedulerFailure) return
    this.tickQueued = true
    queueMicrotask(() => {
      this.tickQueued = false
      void this.tick()
    })
  }

  private async tick(): Promise<void> {
    if (!this.opened || this.closing || this.ticking || this.schedulerFailure) return
    this.ticking = true
    try {
      while (this.opened && !this.closing) {
        const active = this.transaction(() => this.admitOne())
        if (!active) break
        this.active.set(active.key, active)
        active.promise = this.executeActive(active).catch((error) => this.latchSchedulerFailure(error))
      }
    } catch (error) {
      this.latchSchedulerFailure(error)
    } finally {
      this.ticking = false
    }
  }

  private admitOne(): ActiveExecution | undefined {
    const now = this.currentTime()
    const graphRows = this.all<GraphRow>(
      "SELECT * FROM graphs WHERE status IN ('queued', 'running') ORDER BY created_at ASC, id ASC",
    )
    for (const graphRow of graphRows) this.reconcileGraph(graphRow.id, now)

    if (this.active.size >= this.maxParallel) return undefined
    const graphs = this.all<GraphRow>(
      "SELECT * FROM graphs WHERE status IN ('queued', 'running') ORDER BY created_at ASC, id ASC",
    )
    for (const graphRow of graphs) {
      const graph = this.readGraphDefinition(graphRow)
      const nodeRows = this.nodesForGraph(graph.id)
      const byId = new Map(nodeRows.map((node) => [node.node_id, node]))
      const graphActive = [...this.active.values()].filter((active) => active.graphId === graph.id).length
      if (graphActive >= graph.maxParallel) continue

      for (const taskNode of graph.nodes) {
        const nodeRow = byId.get(taskNode.id)
        if (!nodeRow || nodeRow.status !== 'ready') continue
        if (nodeRow.available_at > now) continue

        const bridgeBinding = this.bridgeBinding(graph)
        if (graph.bridgeId !== undefined && !bridgeBinding) {
          this.setWaitReason(graph.id, taskNode.id, 'BRIDGE_UNAVAILABLE', now)
          continue
        }
        const candidate: Candidate = {
          graph,
          graphRow,
          node: taskNode,
          nodeRow,
          ...(bridgeBinding?.bridge ? { bridge: bridgeBinding.bridge } : {}),
          bridgeCatalogDigest: bridgeBinding?.digest ?? null,
        }
        const sessionWait = this.sessionWaitReason(candidate)
        if (sessionWait) {
          this.setWaitReason(graph.id, taskNode.id, sessionWait, now)
          continue
        }
        const scopeWait = this.scopeWaitReason(candidate)
        if (scopeWait) {
          this.setWaitReason(graph.id, taskNode.id, scopeWait, now)
          continue
        }
        try {
          return this.persistAdmission(candidate, now)
        } catch (error) {
          if (error instanceof ResidentError && isDependencyInputFailureCode(error.code)) {
            this.failDependencyInputAdmission(candidate, error, now)
            continue
          }
          if (error instanceof ResidentError && isAdmissionConflictCode(error.code)) {
            this.blockAdmissionConflict(candidate, error, now)
            continue
          }
          if (error instanceof ResidentError && error.code === 'SCHEDULER_RACE') {
            this.setWaitReason(graph.id, taskNode.id, 'session-busy', now)
            continue
          }
          throw error
        }
      }
    }
    return undefined
  }

  private reconcileGraph(graphId: string, now: number): void {
    const graphRow = this.requireGraph(graphId)
    if (graphRow.status !== 'queued' && graphRow.status !== 'running') return
    const graph = this.readGraphDefinition(graphRow)
    const nodes = this.nodesForGraph(graph.id)
    const byId = new Map(nodes.map((node) => [node.node_id, node]))

    for (const taskNode of graph.nodes) {
      const node = byId.get(taskNode.id)
      if (!node || (node.status !== 'pending' && node.status !== 'ready')) continue
      const dependencies = (taskNode.dependsOn ?? []).map((id) => byId.get(id)).filter((value): value is NodeRow => !!value)
      if (dependencies.some((dependency) => isFailedDependencyStatus(dependency.status))) {
        this.run(
          `UPDATE nodes SET status = 'blocked', wait_reason = 'failed-dependency', updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          now,
          graph.id,
          taskNode.id,
        )
        this.bumpGraph(graph.id, now)
        this.event(graph.id, taskNode.id, 'node.blocked', 'A dependency did not succeed', now)
        continue
      }
      if (dependencies.some((dependency) => dependency.status === 'indeterminate')) {
        this.setNodeStateIfChanged(graph.id, taskNode.id, node.status, 'pending', 'dependency-indeterminate', now)
        continue
      }
      if (dependencies.every((dependency) => dependency.status === 'succeeded')) {
        if (node.available_at <= now) {
          this.setNodeStateIfChanged(graph.id, taskNode.id, node.status, 'ready', null, now)
        } else {
          this.setNodeStateIfChanged(graph.id, taskNode.id, node.status, 'pending', 'not-before', now)
        }
      } else {
        this.setNodeStateIfChanged(graph.id, taskNode.id, node.status, 'pending', 'dependencies', now)
      }
    }
    this.refreshGraphStatus(graph.id, now)
  }

  private persistAdmission(candidate: Candidate, now: number): ActiveExecution {
    const current = this.requireNode(candidate.graph.id, candidate.node.id)
    if (current.status !== 'ready') throw new ResidentError('SCHEDULER_RACE', 'Node readiness changed during admission')
    const driver = this.requireDriver(candidate.node.executor)
    let prompt = candidate.node.prompt
    let renderedNodeJson: string | undefined
    if ((candidate.node.inputFrom?.length ?? 0) > 0) {
      if (current.attempt === 0) {
        prompt = this.renderDependencyInput(candidate.graph, candidate.node)
        renderedNodeJson = JSON.stringify({ ...candidate.node, prompt })
      } else {
        // The first admission writes the exact executable input atomically with
        // its attempt. Known retries and owner-authorized retries reuse it.
        prompt = this.readNodeDefinition(current).prompt
      }
    }
    const attempt = current.attempt + 1
    const commandId = `attempt:${hashValue({
      graphId: candidate.graph.id,
      nodeId: candidate.node.id,
      attempt,
    })}`
    const commandHash = hashValue({
      protocolVersion: 1,
      graphHash: candidate.graphRow.graph_hash,
      graphId: candidate.graph.id,
      nodeId: candidate.node.id,
      attempt,
      executor: candidate.node.executor,
      cwd: candidate.graph.cwd,
      prompt,
    })
    let nativeSessionId: string | undefined
    const profileJson = effectiveProfileJson(candidate.node.profile)
    const bridgeCatalogDigest = candidate.bridgeCatalogDigest

    if (candidate.node.sessionKey) {
      const session = this.one<SessionRow>(
        `SELECT * FROM native_sessions WHERE executor = ? AND cwd = ? AND session_key = ?`,
        candidate.node.executor,
        candidate.graph.cwd,
        candidate.node.sessionKey,
      )
      if (session && session.profile_json !== profileJson) {
        throw new ResidentError('PROFILE_CONFLICT', `Session key ${candidate.node.sessionKey} is already bound to a different profile`)
      }
      if (session && session.bridge_catalog_digest !== bridgeCatalogDigest) {
        throw new ResidentError('SESSION_PROFILE_CONFLICT', `Session key ${candidate.node.sessionKey} is already bound to a different bridge catalog`)
      }
      if (session && session.state !== 'settled' && session.state !== 'ready') {
        throw new ResidentError('SCHEDULER_RACE', 'Native session became unavailable during admission')
      }
      nativeSessionId = session?.state === 'settled' ? session.native_session_id ?? undefined : undefined
      if (session) {
        this.run(
          `UPDATE native_sessions
             SET state = 'active', owner_graph_id = ?, owner_node_id = ?, updated_at = ?
           WHERE executor = ? AND cwd = ? AND session_key = ?`,
          candidate.graph.id,
          candidate.node.id,
          now,
          candidate.node.executor,
          candidate.graph.cwd,
          candidate.node.sessionKey,
        )
      } else {
        this.run(
          `INSERT INTO native_sessions (
             executor, cwd, session_key, native_session_id, profile_json, bridge_catalog_digest, state, owner_graph_id, owner_node_id, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?, 'active', ?, ?, ?)`,
          candidate.node.executor,
          candidate.graph.cwd,
          candidate.node.sessionKey,
          profileJson,
          bridgeCatalogDigest,
          candidate.graph.id,
          candidate.node.id,
          now,
        )
      }
    }

    if (renderedNodeJson !== undefined) {
      this.run(
        'UPDATE nodes SET node_json = ? WHERE graph_id = ? AND node_id = ?',
        renderedNodeJson,
        candidate.graph.id,
        candidate.node.id,
      )
    }
    this.run(
      `INSERT INTO attempts (
         graph_id, node_id, attempt, command_id, command_hash, status, native_session_id, created_at, settled_at
       ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, NULL)`,
      candidate.graph.id,
      candidate.node.id,
      attempt,
      commandId,
      commandHash,
      nativeSessionId ?? null,
      now,
    )
    this.run(
      `UPDATE nodes
         SET status = 'running', attempt = ?, command_id = ?, native_session_id = ?,
             wait_reason = NULL, updated_at = ?
       WHERE graph_id = ? AND node_id = ?`,
      attempt,
      commandId,
      nativeSessionId ?? null,
      now,
      candidate.graph.id,
      candidate.node.id,
    )
    this.bumpGraph(candidate.graph.id, now)
    this.setGraphStatus(candidate.graph.id, 'running', now)
    this.event(candidate.graph.id, candidate.node.id, 'node.admitted', 'Attempt and command identity were persisted', now)

    return {
      key: activeKey(candidate.graph.id, candidate.node.id),
      graphId: candidate.graph.id,
      nodeId: candidate.node.id,
      executor: candidate.node.executor,
      cwd: candidate.graph.cwd,
      prompt,
      access: nodeAccess(candidate.node.scope),
      ...(candidate.node.sessionKey ? { sessionKey: candidate.node.sessionKey } : {}),
      ...(candidate.node.profile ? { profile: candidate.node.profile } : {}),
      profileJson,
      ...(candidate.bridge ? { bridge: candidate.bridge } : {}),
      bridgeCatalogDigest,
      commandId,
      attempt,
      driver,
      controller: new AbortController(),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      fenced: false,
      started: false,
      cancelRequested: false,
      shutdownAbort: false,
    }
  }

  private renderDependencyInput(graph: TaskGraph, node: TaskNode): string {
    const predecessors = (node.inputFrom ?? []).map((nodeId) => {
      const predecessor = this.requireNode(graph.id, nodeId)
      if (predecessor.status !== 'succeeded' || predecessor.output === null) {
        throw new ResidentError(
          'SCHEDULER_RACE',
          `Predecessor ${nodeId} is not available as a successful dependency input for node ${node.id}`,
        )
      }
      return { nodeId, output: predecessor.output }
    })
    const rendered = `${node.prompt}\n\n${DEPENDENCY_INPUT_START}\n${stableJson({ formatVersion: 1, predecessors })}\n${DEPENDENCY_INPUT_END}`
    if (rendered.length > MAX_PROMPT_LENGTH) {
      throw new ResidentError(
        'DEPENDENCY_INPUT_TOO_LARGE',
        `Rendered dependency input for node ${node.id} exceeds the existing ${MAX_PROMPT_LENGTH}-character prompt limit`,
      )
    }
    return rendered
  }

  private failDependencyInputAdmission(candidate: Candidate, error: ResidentError, now: number): void {
    const node = this.requireNode(candidate.graph.id, candidate.node.id)
    if (node.status !== 'ready') return
    this.run(
      `UPDATE nodes
         SET status = 'failed', error_code = ?, error_message = ?,
             wait_reason = 'dependency-input-too-large', updated_at = ?
       WHERE graph_id = ? AND node_id = ?`,
      error.code,
      truncate(error.message, 4_096),
      now,
      candidate.graph.id,
      candidate.node.id,
    )
    this.bumpGraph(candidate.graph.id, now)
    this.event(candidate.graph.id, candidate.node.id, 'node.failed', `Dependency input could not be rendered: ${error.code}`, now)
    this.refreshGraphStatus(candidate.graph.id, now)
  }

  private blockAdmissionConflict(candidate: Candidate, error: ResidentError, now: number): void {
    const node = this.requireNode(candidate.graph.id, candidate.node.id)
    if (node.status !== 'ready') return
    this.run(
      `UPDATE nodes
         SET status = 'blocked', error_code = ?, error_message = ?,
             wait_reason = 'admission-conflict', updated_at = ?
       WHERE graph_id = ? AND node_id = ?`,
      error.code,
      truncate(error.message, 4_096),
      now,
      candidate.graph.id,
      candidate.node.id,
    )
    this.bumpGraph(candidate.graph.id, now)
    this.event(candidate.graph.id, candidate.node.id, 'node.blocked', `Admission conflict: ${error.code}`, now)
    this.refreshGraphStatus(candidate.graph.id, now)
  }

  private async executeActive(active: ActiveExecution): Promise<void> {
    try {
      await Promise.resolve()
      if (active.fenced || !this.opened) return
      if (active.shutdownAbort || active.controller.signal.aborted) {
        this.settleCancelledBeforeStart(active)
        return
      }
      this.markAttemptRunning(active)
      active.started = true
      const result = await active.driver.execute({
        commandId: active.commandId,
        cwd: active.cwd,
        prompt: active.prompt,
        access: active.access,
        ...(active.nativeSessionId ? { nativeSessionId: active.nativeSessionId } : {}),
        ...(active.profile ? { profile: active.profile } : {}),
        ...(active.bridge ? { bridge: active.bridge } : {}),
        signal: active.controller.signal,
        onSession: (sessionId) => this.recordNativeSession(active, sessionId),
      })
      this.finishSuccess(active, result)
    } catch (error) {
      this.finishFailure(active, error)
    } finally {
      this.active.delete(active.key)
      if (this.opened && !this.closing) this.requestTick()
    }
  }

  private markAttemptRunning(active: ActiveExecution): void {
    this.transaction(() => {
      if (active.fenced || !this.opened || active.shutdownAbort || active.controller.signal.aborted) return
      const node = this.requireNode(active.graphId, active.nodeId)
      if (!isActiveNodeStatus(node.status) || node.command_id !== active.commandId) {
        active.fenced = true
        return
      }
      const now = this.currentTime()
      this.run(
        `UPDATE attempts SET status = 'running'
         WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ? AND status = 'prepared'`,
        active.graphId,
        active.nodeId,
        active.attempt,
        active.commandId,
      )
      this.event(active.graphId, active.nodeId, 'node.started', 'Native driver execution started', now)
    })
    if (active.fenced || active.shutdownAbort || active.controller.signal.aborted) {
      throw new ResidentError('SESSION_FENCED', 'The node was fenced before the driver started')
    }
  }

  private recordNativeSession(active: ActiveExecution, rawSessionId: string): void {
    const sessionId = requireText(rawSessionId, 'nativeSessionId', 512)
    if (!this.database || !this.opened || active.fenced || this.active.get(active.key) !== active) {
      throw new ResidentError('SESSION_FENCED', 'The node is no longer permitted to update its native session')
    }

    this.transaction(() => {
      const node = this.requireNode(active.graphId, active.nodeId)
      if (!isActiveNodeStatus(node.status) || node.command_id !== active.commandId) {
        active.fenced = true
        throw new ResidentError('SESSION_FENCED', 'The node is no longer active')
      }
      if (active.nativeSessionId && active.nativeSessionId !== sessionId) {
        active.fenced = true
        throw new ResidentError('NATIVE_SESSION_CONFLICT', 'A native attempt cannot change its session identity')
      }
      const now = this.currentTime()
      this.run(
        `UPDATE attempts SET native_session_id = ?
         WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ?`,
        sessionId,
        active.graphId,
        active.nodeId,
        active.attempt,
        active.commandId,
      )
      this.run(
        `UPDATE nodes SET native_session_id = ?, updated_at = ? WHERE graph_id = ? AND node_id = ?`,
        sessionId,
        now,
        active.graphId,
        active.nodeId,
      )
      if (active.sessionKey) {
        this.run(
          `UPDATE native_sessions
             SET native_session_id = ?, state = 'active', owner_graph_id = ?, owner_node_id = ?, updated_at = ?
           WHERE executor = ? AND cwd = ? AND session_key = ?`,
          sessionId,
          active.graphId,
          active.nodeId,
          now,
          active.executor,
          active.cwd,
          active.sessionKey,
        )
      }
      active.nativeSessionId = sessionId
      this.event(active.graphId, active.nodeId, 'node.session-recorded', 'Native session identity was persisted', now)
    })
  }

  private finishSuccess(active: ActiveExecution, rawResult: TaskResult): void {
    if (!this.database || !this.opened) return
    let result: TaskResult
    try {
      result = normalizeResult(rawResult)
      if (result.nativeSessionId && !active.fenced) this.recordNativeSession(active, result.nativeSessionId)
    } catch (error) {
      this.finishFailure(active, error)
      return
    }
    if (!this.opened) return

    this.transaction(() => {
      const node = this.requireNode(active.graphId, active.nodeId)
      if (!isActiveNodeStatus(node.status) || node.command_id !== active.commandId) return
      const graphRow = this.requireGraph(active.graphId)
      const now = this.currentTime()
      const cancellationRequested = active.cancelRequested
        || active.shutdownAbort
        || node.status === 'cancelling'
        || graphRow.cancel_requested !== 0
      if (cancellationRequested) {
        this.settleConfirmedCancellation(active, now, 'RESULT_AFTER_CANCEL')
        return
      }
      if (active.fenced) return
      const sessionId = result.nativeSessionId ?? active.nativeSessionId ?? null
      this.run(
        `UPDATE attempts SET status = 'succeeded', native_session_id = ?, settled_at = ?
         WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ?`,
        sessionId,
        now,
        active.graphId,
        active.nodeId,
        active.attempt,
        active.commandId,
      )
      this.run(
        `UPDATE nodes
           SET status = 'succeeded', output = ?, error_code = NULL, error_message = NULL,
               native_session_id = ?, wait_reason = NULL, updated_at = ?
         WHERE graph_id = ? AND node_id = ?`,
        result.output,
        sessionId,
        now,
        active.graphId,
        active.nodeId,
      )
      this.settleSession(active, sessionId, now)
      this.bumpGraph(active.graphId, now)
      this.event(active.graphId, active.nodeId, 'node.succeeded', 'Native driver returned a confirmed result', now)
      this.refreshGraphStatus(active.graphId, now)
    })
  }

  private finishFailure(active: ActiveExecution, error: unknown): void {
    if (!this.database || !this.opened) return
    const normalized = normalizeDriverError(error)
    this.transaction(() => {
      const node = this.requireNode(active.graphId, active.nodeId)
      const now = this.currentTime()
      if (!isActiveNodeStatus(node.status) || node.command_id !== active.commandId) return
      const graphRow = this.requireGraph(active.graphId)
      const cancellationRequested = active.cancelRequested
        || active.shutdownAbort
        || node.status === 'cancelling'
        || graphRow.cancel_requested !== 0
      const indeterminate = isIndeterminateCode(normalized.code) || (active.fenced && !cancellationRequested)
      if (indeterminate) {
        const code = isIndeterminateCode(normalized.code) ? normalized.code : 'SESSION_FENCED'
        const message = isIndeterminateCode(normalized.code)
          ? normalized.message
          : 'The native session was fenced before its outcome was confirmed'
        this.run(
          `UPDATE attempts SET status = 'indeterminate', native_session_id = ?, settled_at = ?
           WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ?`,
          active.nativeSessionId ?? null,
          now,
          active.graphId,
          active.nodeId,
          active.attempt,
          active.commandId,
        )
        this.run(
          `UPDATE nodes
             SET status = 'indeterminate', error_code = ?, error_message = ?,
                 wait_reason = 'owner-resolution-required', updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          code,
          message,
          now,
          active.graphId,
          active.nodeId,
        )
        this.fenceSession(active, now)
        this.bumpGraph(active.graphId, now)
        this.event(active.graphId, active.nodeId, 'node.indeterminate', `Native outcome is unknown: ${code}`, now)
        this.setGraphStatus(active.graphId, 'indeterminate', now, 'graph.indeterminate', 'Owner resolution is required before work can continue')
        return
      }

      if (cancellationRequested) {
        this.settleConfirmedCancellation(active, now, normalized.code)
        return
      }

      const graph = this.readGraphDefinition(graphRow)
      const taskNode = graph.nodes.find((candidate) => candidate.id === active.nodeId)
      if (!taskNode) throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Persisted node is absent from its graph')
      const retry = taskNode.retry
      const retryAllowed = !!retry
        && node.attempt < retry.maxAttempts
        && retry.codes.includes(normalized.code)
        && !isIndeterminateCode(normalized.code)
        && !cancellationRequested

      this.run(
        `UPDATE attempts SET status = 'failed', native_session_id = ?, settled_at = ?
         WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ?`,
        active.nativeSessionId ?? null,
        now,
        active.graphId,
        active.nodeId,
        active.attempt,
        active.commandId,
      )
      this.settleSession(active, active.nativeSessionId ?? null, now)
      if (retryAllowed && retry) {
        const availableAt = Math.max(now + retry.delayMs, taskNode.notBefore ?? 0, graph.notBefore ?? 0)
        this.run(
          `UPDATE nodes
             SET status = 'pending', error_code = ?, error_message = ?, wait_reason = 'retry-delay',
                 available_at = ?, updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          normalized.code,
          normalized.message,
          availableAt,
          now,
          active.graphId,
          active.nodeId,
        )
        this.bumpGraph(active.graphId, now)
        this.event(active.graphId, active.nodeId, 'node.retry-scheduled', `Retrying known error code ${normalized.code}`, now)
      } else {
        this.run(
          `UPDATE nodes
             SET status = 'failed', error_code = ?, error_message = ?, wait_reason = 'failed', updated_at = ?
           WHERE graph_id = ? AND node_id = ?`,
          normalized.code,
          normalized.message,
          now,
          active.graphId,
          active.nodeId,
        )
        this.bumpGraph(active.graphId, now)
        this.event(active.graphId, active.nodeId, 'node.failed', `Native driver failed with ${normalized.code}`, now)
      }
      this.refreshGraphStatus(active.graphId, now)
    })
  }

  private settleCancelledBeforeStart(active: ActiveExecution): void {
    if (!this.database || !this.opened || active.fenced) return
    this.transaction(() => {
      const node = this.requireNode(active.graphId, active.nodeId)
      if (!isActiveNodeStatus(node.status) || node.command_id !== active.commandId) return
      this.settleConfirmedCancellation(active, this.currentTime(), 'ENGINE_CLOSED')
    })
  }

  private settleConfirmedCancellation(active: ActiveExecution, now: number, code: string): void {
    this.markGraphCancellationRequested(active.graphId, now)
    this.run(
      `UPDATE attempts SET status = 'cancelled', native_session_id = ?, settled_at = ?
       WHERE graph_id = ? AND node_id = ? AND attempt = ? AND command_id = ? AND status IN ('prepared', 'running', 'cancel_requested')`,
      active.nativeSessionId ?? null,
      now,
      active.graphId,
      active.nodeId,
      active.attempt,
      active.commandId,
    )
    this.run(
      `UPDATE nodes
         SET status = 'cancelled', output = NULL, error_code = NULL, error_message = NULL,
             wait_reason = 'cancelled', updated_at = ?
       WHERE graph_id = ? AND node_id = ?`,
      now,
      active.graphId,
      active.nodeId,
    )
    this.run(
      `UPDATE nodes
         SET status = 'cancelled', wait_reason = 'cancelled', updated_at = ?
       WHERE graph_id = ? AND status IN ('pending', 'ready')`,
      now,
      active.graphId,
    )
    this.settleSession(active, active.nativeSessionId ?? null, now)
    this.bumpGraph(active.graphId, now)
    this.event(active.graphId, active.nodeId, 'node.cancelled', `Native execution confirmed cancellation: ${code}`, now)
    this.refreshGraphStatus(active.graphId, now)
  }

  private scopeWaitReason(candidate: Candidate): string | undefined {
    for (const active of this.active.values()) {
      const otherGraph = this.readGraphDefinition(this.requireGraph(active.graphId))
      const otherNode = otherGraph.nodes.find((node) => node.id === active.nodeId)
      if (otherNode && scopesConflict(candidate.node.scope, candidate.graph.cwd, otherNode.scope, otherGraph.cwd)) return 'scope-conflict'
    }

    const indeterminate = this.all<Row>(
      `SELECT n.graph_id, n.node_id, n.node_json, g.graph_json
       FROM nodes n JOIN graphs g ON g.id = n.graph_id
       WHERE n.status = 'indeterminate'`,
    )
    for (const row of indeterminate) {
      const graph = this.parsePersistedGraph(asString(row.graph_json, 'persisted graph'))
      const node = this.parsePersistedNode(asString(row.node_json, 'persisted node'))
      if (scopesConflict(candidate.node.scope, candidate.graph.cwd, node.scope, graph.cwd)) return 'scope-conflict-indeterminate'
    }
    return undefined
  }

  private sessionWaitReason(candidate: Candidate): string | undefined {
    if (!candidate.node.sessionKey) return undefined
    const session = this.one<SessionRow>(
      `SELECT * FROM native_sessions WHERE executor = ? AND cwd = ? AND session_key = ?`,
      candidate.node.executor,
      candidate.graph.cwd,
      candidate.node.sessionKey,
    )
    if (!session || session.state === 'settled' || session.state === 'ready') return undefined
    return session.state === 'fenced' ? 'session-fenced' : 'session-busy'
  }

  private reserveSessionProfiles(graph: TaskGraph, now: number): void {
    const seen = new Map<string, string>()
    const bridgeCatalogDigest = this.bridgeCatalogDigestForGraph(graph)
    for (const node of graph.nodes) {
      if (!node.sessionKey) continue
      const profileJson = effectiveProfileJson(node.profile)
      const key = `${node.executor}\u0000${graph.cwd}\u0000${node.sessionKey}`
      const configuration = `${profileJson}\u0000${bridgeCatalogDigest ?? ''}`
      const prior = seen.get(key)
      if (prior && prior !== configuration) {
        throw new ResidentError('PROFILE_CONFLICT', `Session key ${node.sessionKey} has conflicting profiles in one graph`)
      }
      seen.set(key, configuration)
      const session = this.one<SessionRow>(
        `SELECT * FROM native_sessions WHERE executor = ? AND cwd = ? AND session_key = ?`,
        node.executor,
        graph.cwd,
        node.sessionKey,
      )
      if (session && session.profile_json !== profileJson) {
        throw new ResidentError('PROFILE_CONFLICT', `Session key ${node.sessionKey} is already bound to a different profile`)
      }
      if (session && session.bridge_catalog_digest !== bridgeCatalogDigest) {
        throw new ResidentError('SESSION_PROFILE_CONFLICT', `Session key ${node.sessionKey} is already bound to a different bridge catalog`)
      }
      if (!session) {
        this.run(
          `INSERT INTO native_sessions (
             executor, cwd, session_key, native_session_id, profile_json, bridge_catalog_digest,
             state, owner_graph_id, owner_node_id, updated_at
           ) VALUES (?, ?, ?, NULL, ?, ?, 'ready', NULL, NULL, ?)`,
          node.executor,
          graph.cwd,
          node.sessionKey,
          profileJson,
          bridgeCatalogDigest,
          now,
        )
      } else {
        this.run(
          `UPDATE native_sessions SET updated_at = ?
           WHERE executor = ? AND cwd = ? AND session_key = ?`,
          now,
          node.executor,
          graph.cwd,
          node.sessionKey,
        )
      }
    }
  }

  private settleSession(active: ActiveExecution, sessionId: string | null, now: number): void {
    if (!active.sessionKey) return
    if (sessionId) {
      this.run(
        `UPDATE native_sessions
           SET native_session_id = ?, state = 'settled', owner_graph_id = NULL, owner_node_id = NULL, updated_at = ?
         WHERE executor = ? AND cwd = ? AND session_key = ?`,
        sessionId,
        now,
        active.executor,
        active.cwd,
        active.sessionKey,
      )
    } else {
      this.run(
        `UPDATE native_sessions
           SET native_session_id = NULL, state = 'ready', owner_graph_id = NULL, owner_node_id = NULL, updated_at = ?
         WHERE executor = ? AND cwd = ? AND session_key = ? AND owner_graph_id = ? AND owner_node_id = ?`,
        now,
        active.executor,
        active.cwd,
        active.sessionKey,
        active.graphId,
        active.nodeId,
      )
    }
  }

  private fenceSession(active: ActiveExecution, now: number): void {
    if (!active.sessionKey) return
    this.run(
      `INSERT INTO native_sessions (
         executor, cwd, session_key, native_session_id, profile_json, bridge_catalog_digest, state, owner_graph_id, owner_node_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'fenced', ?, ?, ?)
       ON CONFLICT(executor, cwd, session_key) DO UPDATE SET
         native_session_id = COALESCE(excluded.native_session_id, native_sessions.native_session_id),
         state = 'fenced', owner_graph_id = excluded.owner_graph_id,
         owner_node_id = excluded.owner_node_id, updated_at = excluded.updated_at`,
      active.executor,
      active.cwd,
      active.sessionKey,
      active.nativeSessionId ?? null,
      active.profileJson,
      active.bridgeCatalogDigest,
      active.graphId,
      active.nodeId,
      now,
    )
  }

  private fencePersistedNodeSession(graphId: string, nodeId: string, now: number): void {
    const graph = this.readGraphDefinition(this.requireGraph(graphId))
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)
    const state = this.requireNode(graphId, nodeId)
    if (!node?.sessionKey) return
    this.run(
      `INSERT INTO native_sessions (
         executor, cwd, session_key, native_session_id, profile_json, bridge_catalog_digest, state, owner_graph_id, owner_node_id, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'fenced', ?, ?, ?)
       ON CONFLICT(executor, cwd, session_key) DO UPDATE SET
         native_session_id = COALESCE(excluded.native_session_id, native_sessions.native_session_id),
         state = 'fenced', owner_graph_id = excluded.owner_graph_id,
         owner_node_id = excluded.owner_node_id, updated_at = excluded.updated_at`,
      node.executor,
      graph.cwd,
      node.sessionKey,
      state.native_session_id,
      effectiveProfileJson(node.profile),
      this.bridgeCatalogDigestForGraph(graph),
      graphId,
      nodeId,
      now,
    )
  }

  private releaseFencedSession(graphId: string, nodeId: string, now: number): void {
    const graph = this.readGraphDefinition(this.requireGraph(graphId))
    const node = graph.nodes.find((candidate) => candidate.id === nodeId)
    if (!node?.sessionKey) return
    this.run(
      `UPDATE native_sessions
         SET native_session_id = NULL, state = 'ready', owner_graph_id = NULL, owner_node_id = NULL, updated_at = ?
       WHERE executor = ? AND cwd = ? AND session_key = ?
         AND state = 'fenced' AND owner_graph_id = ? AND owner_node_id = ?`,
      now,
      node.executor,
      graph.cwd,
      node.sessionKey,
      graphId,
      nodeId,
    )
  }

  private refreshGraphStatus(graphId: string, now: number): void {
    const graph = this.requireGraph(graphId)
    if ((graph.status === 'paused' && graph.cancel_requested === 0) || graph.status === 'cancelled' || graph.status === 'indeterminate') return
    const nodes = this.nodesForGraph(graphId)
    if (nodes.some((node) => node.status === 'indeterminate')) {
      this.setGraphStatus(graphId, 'indeterminate', now, 'graph.indeterminate', 'An owner decision is required')
      return
    }
    const active = nodes.some((node) => isActiveNodeStatus(node.status))
    if (graph.cancel_requested !== 0) {
      if (active) this.setGraphStatus(graphId, 'cancelling', now)
      else this.setGraphStatus(graphId, 'cancelled', now, 'graph.cancelled', 'Every active native attempt reached a confirmed terminal outcome')
      return
    }
    const pending = nodes.some((node) => node.status === 'pending' || node.status === 'ready')
    if (active) {
      this.setGraphStatus(graphId, 'running', now)
    } else if (pending) {
      this.setGraphStatus(graphId, 'queued', now)
    } else if (nodes.every((node) => node.status === 'succeeded')) {
      this.setGraphStatus(graphId, 'completed', now, 'graph.completed', 'Every node succeeded')
    } else {
      this.setGraphStatus(graphId, 'failed', now, 'graph.failed', 'One or more nodes did not succeed')
    }
  }

  private setGraphStatus(
    graphId: string,
    status: GraphStatus,
    now: number,
    eventType?: string,
    detail?: string,
  ): void {
    const graph = this.requireGraph(graphId)
    if (graph.status === status) return
    this.run(
      'UPDATE graphs SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      status,
      now,
      graphId,
    )
    if (eventType && detail) this.event(graphId, undefined, eventType, detail, now)
  }

  private markGraphCancellationRequested(graphId: string, now: number): void {
    const graph = this.requireGraph(graphId)
    if (graph.cancel_requested !== 0) return
    this.run(
      'UPDATE graphs SET cancel_requested = 1, revision = revision + 1, updated_at = ? WHERE id = ?',
      now,
      graphId,
    )
  }

  private clearGraphCancellationRequested(graphId: string, now: number): void {
    const graph = this.requireGraph(graphId)
    if (graph.cancel_requested === 0) return
    this.run(
      'UPDATE graphs SET cancel_requested = 0, revision = revision + 1, updated_at = ? WHERE id = ?',
      now,
      graphId,
    )
  }

  private markPersistedRunningIndeterminate(
    graphId: string,
    nodeId: string,
    now: number,
    code: string,
    message: string,
  ): void {
    const node = this.requireNode(graphId, nodeId)
    if (!isActiveNodeStatus(node.status)) return
    this.run(
      `UPDATE attempts SET status = 'indeterminate', settled_at = ?
       WHERE graph_id = ? AND node_id = ? AND attempt = ? AND status IN ('prepared', 'running', 'cancel_requested')`,
      now,
      graphId,
      nodeId,
      node.attempt,
    )
    this.run(
      `UPDATE nodes
         SET status = 'indeterminate', error_code = ?, error_message = ?,
             wait_reason = 'owner-resolution-required', updated_at = ?
       WHERE graph_id = ? AND node_id = ?`,
      code,
      message,
      now,
      graphId,
      nodeId,
    )
    this.fencePersistedNodeSession(graphId, nodeId, now)
    this.bumpGraph(graphId, now)
    this.setGraphStatus(graphId, 'indeterminate', now, 'graph.indeterminate', 'Cancellation could not confirm the native outcome')
  }

  private setNodeStateIfChanged(
    graphId: string,
    nodeId: string,
    from: string,
    to: NodeStatus,
    waitReason: string | null,
    now: number,
  ): void {
    const node = this.requireNode(graphId, nodeId)
    if (from === to && node.wait_reason === waitReason) return
    this.run(
      `UPDATE nodes SET status = ?, wait_reason = ?, updated_at = ? WHERE graph_id = ? AND node_id = ?`,
      to,
      waitReason,
      now,
      graphId,
      nodeId,
    )
    if (from !== to) this.bumpGraph(graphId, now)
  }

  private setWaitReason(graphId: string, nodeId: string, waitReason: string, now: number): void {
    const node = this.requireNode(graphId, nodeId)
    if (node.wait_reason === waitReason) return
    this.run(
      'UPDATE nodes SET wait_reason = ?, updated_at = ? WHERE graph_id = ? AND node_id = ?',
      waitReason,
      now,
      graphId,
      nodeId,
    )
  }

  private bumpGraph(graphId: string, now: number): void {
    this.run('UPDATE graphs SET revision = revision + 1, updated_at = ? WHERE id = ?', now, graphId)
  }

  private snapshot(graphId: string): GraphSnapshot {
    const row = this.requireGraph(graphId)
    const graph = this.readGraphDefinition(row)
    const nodeRows = new Map(this.nodesForGraph(graph.id).map((node) => [node.node_id, node]))
    const nodes: NodeSnapshot[] = graph.nodes.map((definition) => {
      const node = nodeRows.get(definition.id)
      if (!node) throw new ResidentError('PERSISTED_FORMAT_INVALID', `Node ${definition.id} is missing`)
      return {
        id: definition.id,
        status: asNodeStatus(node.status),
        attempt: asNumber(node.attempt, 'node attempt'),
        ...(node.command_id ? { commandId: node.command_id } : {}),
        ...(node.output !== null ? { output: node.output } : {}),
        ...(node.error_code || node.error_message
          ? { error: { code: node.error_code ?? 'UNKNOWN', message: node.error_message ?? '' } }
          : {}),
        ...(node.native_session_id ? { nativeSessionId: node.native_session_id } : {}),
        ...(node.wait_reason ? { waitReason: node.wait_reason } : {}),
      }
    })
    return {
      formatVersion: 1,
      graph,
      status: asGraphStatus(row.status),
      revision: asNumber(row.revision, 'graph revision'),
      createdAt: asNumber(row.created_at, 'graph createdAt'),
      updatedAt: asNumber(row.updated_at, 'graph updatedAt'),
      nodes,
    }
  }

  private readReceipt(commandId: string, requestHash: string, kind: string): GraphSnapshot | undefined {
    const receipt = this.one<Row>('SELECT * FROM command_receipts WHERE command_id = ?', commandId)
    if (!receipt) return undefined
    if (receipt.kind !== kind || receipt.request_hash !== requestHash) {
      throw new ResidentError('COMMAND_CONFLICT', `Command ${commandId} was already used with different input`)
    }
    return parseSnapshot(asString(receipt.response_json, 'command receipt'))
  }

  private writeReceipt(commandId: string, kind: string, requestHash: string, response: GraphSnapshot, now: number): void {
    this.run(
      `INSERT INTO command_receipts (command_id, kind, request_hash, response_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      commandId,
      kind,
      requestHash,
      JSON.stringify(response),
      now,
    )
  }

  private requireGraph(graphId: string): GraphRow {
    const graph = this.one<GraphRow>('SELECT * FROM graphs WHERE id = ?', graphId)
    if (!graph) throw new ResidentError('GRAPH_NOT_FOUND', `Graph ${graphId} was not found`)
    return graph
  }

  private requireNode(graphId: string, nodeId: string): NodeRow {
    const node = this.one<NodeRow>('SELECT * FROM nodes WHERE graph_id = ? AND node_id = ?', graphId, nodeId)
    if (!node) throw new ResidentError('NODE_NOT_FOUND', `Node ${nodeId} was not found in graph ${graphId}`)
    return node
  }

  private assertRevision(graph: GraphRow, expectedRevision: number): void {
    if (graph.revision !== expectedRevision) {
      throw new ResidentError('REVISION_CONFLICT', `Expected revision ${expectedRevision}, found ${graph.revision}`)
    }
  }

  private readGraphDefinition(row: GraphRow): TaskGraph {
    return this.parsePersistedGraph(row.graph_json)
  }

  private readNodeDefinition(row: NodeRow): TaskNode {
    return this.parsePersistedNode(row.node_json)
  }

  private parsePersistedGraph(raw: string): TaskGraph {
    try {
      return normalizeGraph(JSON.parse(raw))
    } catch (error) {
      if (error instanceof ResidentError) {
        throw new ResidentError('PERSISTED_FORMAT_INVALID', `Persisted graph is invalid: ${error.message}`)
      }
      throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Persisted graph is not valid JSON')
    }
  }

  private parsePersistedNode(raw: string): TaskNode {
    try {
      return normalizeNode(JSON.parse(raw))
    } catch (error) {
      if (error instanceof ResidentError) {
        throw new ResidentError('PERSISTED_FORMAT_INVALID', `Persisted node is invalid: ${error.message}`)
      }
      throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Persisted node is not valid JSON')
    }
  }

  private nodesForGraph(graphId: string): NodeRow[] {
    return this.all<NodeRow>('SELECT * FROM nodes WHERE graph_id = ? ORDER BY rowid ASC', graphId)
  }

  private requireDriver(executor: Executor): NativeDriver {
    const driver = this.drivers[executor]
    if (!driver || typeof driver.execute !== 'function') {
      throw new ResidentError('DRIVER_UNAVAILABLE', `No native driver is available for ${executor}`)
    }
    return driver
  }

  private bridgeFor(id: string): NativeToolBridge | undefined {
    try {
      return this.resolveBridge?.(id)
    } catch {
      // Bridge lookup is runtime wiring. A transient lookup failure must not admit a graph without its bridge.
      return undefined
    }
  }

  private bridgeBinding(graph: TaskGraph): { bridge?: NativeToolBridge; digest: string | null } | undefined {
    if (!graph.bridgeId) return { digest: null }
    const catalog = this.one<Row>('SELECT * FROM bridge_catalogs WHERE bridge_id = ?', graph.bridgeId)
    const bridge = this.bridgeFor(graph.bridgeId)
    if (!catalog || !bridge) return undefined
    const digest = asString(catalog.digest, 'bridge catalog digest')
    try {
      if (digest !== hashValue(normalizeBridgeTools(bridge.tools))) return undefined
    } catch {
      return undefined
    }
    return { bridge, digest }
  }

  private bridgeCatalogDigestForGraph(graph: TaskGraph): string | null {
    if (!graph.bridgeId) return null
    const catalog = this.one<Row>('SELECT digest FROM bridge_catalogs WHERE bridge_id = ?', graph.bridgeId)
    return catalog ? asString(catalog.digest, 'bridge catalog digest') : null
  }

  private requireOpen(): void {
    if (!this.opened || !this.database || this.closing) {
      throw new ResidentError('RESIDENT_NOT_OPEN', 'Resident engine is not open')
    }
  }

  private requireSchedulerHealthy(): void {
    if (!this.schedulerFailure) return
    throw new ResidentError('SCHEDULER_FAILED', `Resident scheduler is halted: ${this.schedulerFailure.code}: ${this.schedulerFailure.message}`)
  }

  private latchSchedulerFailure(error: unknown): void {
    const failure = error instanceof ResidentError
      ? error
      : new ResidentError('SCHEDULER_FAILED', normalizeDriverError(error).message)
    this.schedulerFailure = failure.code === 'SCHEDULER_FAILED'
      ? failure
      : new ResidentError('SCHEDULER_FAILED', `${failure.code}: ${failure.message}`)
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    if (!this.database || !this.opened) return
    try {
      const now = Date.now()
      this.transaction(() => {
        const graphs = this.all<GraphRow>("SELECT * FROM graphs WHERE status IN ('queued', 'running', 'paused')")
        for (const graph of graphs) {
          this.event(graph.id, undefined, 'scheduler.failed', truncate(this.schedulerFailure?.message ?? 'scheduler failure', 4_096), now)
        }
      })
    } catch (recordError) {
      const detail = normalizeDriverError(recordError)
      this.schedulerFailure = new ResidentError(
        'SCHEDULER_FAILED',
        `${failure.code}: ${failure.message}; failure record unavailable: ${detail.code}: ${detail.message}`,
      )
    }
  }

  private currentTime(): number {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ResidentError('CLOCK_INVALID', 'Resident clock must return a non-negative safe integer')
    }
    return value
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new ResidentError('RESIDENT_NOT_OPEN', 'Resident database is not open')
    return this.database
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // The original database error is more useful than a rollback failure.
      }
      throw error
    }
  }

  private one<T extends Row>(sql: string, ...values: readonly (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...values) as T | undefined
  }

  private all<T extends Row>(sql: string, ...values: readonly (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...values) as T[]
  }

  private run(sql: string, ...values: readonly (string | number | null)[]): void {
    this.db.prepare(sql).run(...values)
  }

  private event(graphId: string, nodeId: string | undefined, type: string, detail: string, time: number): void {
    this.run(
      'INSERT INTO events (graph_id, node_id, type, time, detail) VALUES (?, ?, ?, ?, ?)',
      graphId,
      nodeId ?? null,
      type,
      time,
      detail,
    )
  }

  private bridgeToolEvent(commandId: string, callId: string, name: string, type: string, time: number): void {
    const attempt = this.one<Row>('SELECT graph_id, node_id FROM attempts WHERE command_id = ?', commandId)
    if (!attempt) return
    const graphId = asString(attempt.graph_id, 'tool event graph id')
    const nodeId = asString(attempt.node_id, 'tool event node id')
    this.event(graphId, nodeId, type, JSON.stringify({ callId, name }), time)
  }
}

function normalizeSubmit(raw: unknown): { commandId: string; graph: TaskGraph } {
  const record = requireRecord(raw, 'submit request')
  assertOnlyKeys(record, ['commandId', 'graph'], 'submit request')
  return {
    commandId: requireOpaqueId(record.commandId, 'commandId'),
    graph: normalizeGraph(record.graph),
  }
}

function normalizeControl(raw: unknown): { commandId: string; graphId: string; action: 'pause' | 'resume' | 'cancel'; expectedRevision: number } {
  const record = requireRecord(raw, 'control request')
  assertOnlyKeys(record, ['commandId', 'graphId', 'action', 'expectedRevision'], 'control request')
  const action = record.action
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    throw new ResidentError('REQUEST_INVALID', 'action must be pause, resume, or cancel')
  }
  return {
    commandId: requireOpaqueId(record.commandId, 'commandId'),
    graphId: requireOpaqueId(record.graphId, 'graphId'),
    action,
    expectedRevision: nonNegativeInteger(record.expectedRevision, 'expectedRevision'),
  }
}

function normalizeResolve(raw: unknown): { commandId: string; graphId: string; nodeId: string; decision: 'retry' | 'fail'; expectedRevision: number } {
  const record = requireRecord(raw, 'resolve request')
  assertOnlyKeys(record, ['commandId', 'graphId', 'nodeId', 'decision', 'expectedRevision'], 'resolve request')
  const decision = record.decision
  if (decision !== 'retry' && decision !== 'fail') {
    throw new ResidentError('REQUEST_INVALID', 'decision must be retry or fail')
  }
  return {
    commandId: requireOpaqueId(record.commandId, 'commandId'),
    graphId: requireOpaqueId(record.graphId, 'graphId'),
    nodeId: requireOpaqueId(record.nodeId, 'nodeId'),
    decision,
    expectedRevision: nonNegativeInteger(record.expectedRevision, 'expectedRevision'),
  }
}

function normalizeGraph(raw: unknown): TaskGraph {
  const record = requireRecord(raw, 'graph')
  assertOnlyKeys(record, ['formatVersion', 'id', 'label', 'cwd', 'maxParallel', 'notBefore', 'bridgeId', 'nodes'], 'graph')
  if (record.formatVersion !== 1) throw new ResidentError('GRAPH_INVALID', 'graph.formatVersion must be 1')
  const nodesRaw = record.nodes
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0 || nodesRaw.length > MAX_NODES) {
    throw new ResidentError('GRAPH_INVALID', `graph.nodes must contain between 1 and ${MAX_NODES} nodes`)
  }
  const nodes = nodesRaw.map((node) => normalizeNode(node))
  const ids = new Set<string>()
  for (const node of nodes) {
    if (ids.has(node.id)) throw new ResidentError('GRAPH_INVALID', `Duplicate node id ${node.id}`)
    ids.add(node.id)
  }
  for (const node of nodes) {
    for (const dependency of node.dependsOn ?? []) {
      if (!ids.has(dependency)) {
        throw new ResidentError('GRAPH_INVALID', `Node ${node.id} depends on unknown node ${dependency}`)
      }
      if (dependency === node.id) throw new ResidentError('GRAPH_INVALID', `Node ${node.id} cannot depend on itself`)
    }
    const directPredecessors = new Set(node.dependsOn ?? [])
    for (const input of node.inputFrom ?? []) {
      if (!directPredecessors.has(input)) {
        throw new ResidentError('GRAPH_INVALID', `Node ${node.id} inputFrom entry ${input} must name a direct dependency`)
      }
    }
  }
  assertAcyclic(nodes)
  const notBefore = optionalTime(record.notBefore, 'graph.notBefore')
  const bridgeId = record.bridgeId === undefined ? undefined : requireOpaqueId(record.bridgeId, 'graph.bridgeId')
  return {
    formatVersion: 1,
    id: requireOpaqueId(record.id, 'graph.id'),
    label: requireText(record.label, 'graph.label', 256),
    cwd: normalizeCwd(record.cwd),
    maxParallel: positiveInteger(record.maxParallel, 'graph.maxParallel', MAX_PARALLEL),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(bridgeId === undefined ? {} : { bridgeId }),
    nodes,
  }
}

function normalizeNode(raw: unknown): TaskNode {
  const record = requireRecord(raw, 'node')
  assertOnlyKeys(record, ['id', 'executor', 'prompt', 'dependsOn', 'inputFrom', 'scope', 'sessionKey', 'profile', 'notBefore', 'retry'], 'node')
  const executor = record.executor
  if (executor !== 'codex' && executor !== 'claude-code') {
    throw new ResidentError('GRAPH_INVALID', 'node.executor must be codex or claude-code')
  }
  const dependsOn = normalizeDependencies(record.dependsOn)
  const inputFrom = normalizeInputFrom(record.inputFrom)
  const scope = normalizeScope(record.scope)
  const sessionKey = record.sessionKey === undefined ? undefined : requireOpaqueId(record.sessionKey, 'node.sessionKey')
  const profile = normalizeProfile(record.profile)
  const notBefore = optionalTime(record.notBefore, 'node.notBefore')
  const retry = normalizeRetry(record.retry)
  return {
    id: requireOpaqueId(record.id, 'node.id'),
    executor,
    prompt: requireText(record.prompt, 'node.prompt', MAX_PROMPT_LENGTH),
    ...(dependsOn.length === 0 ? {} : { dependsOn }),
    ...(inputFrom.length === 0 ? {} : { inputFrom }),
    ...(scope === undefined ? {} : { scope }),
    ...(sessionKey === undefined ? {} : { sessionKey }),
    ...(profile === undefined ? {} : { profile }),
    ...(notBefore === undefined ? {} : { notBefore }),
    ...(retry === undefined ? {} : { retry }),
  }
}

function normalizeProfile(raw: unknown): NativeProfile | undefined {
  if (raw === undefined) return undefined
  const record = requireRecord(raw, 'node.profile')
  assertOnlyKeys(record, ['model', 'reasoningEffort'], 'node.profile')
  const model = record.model === undefined ? undefined : requireOpaqueId(record.model, 'node.profile.model')
  const reasoningEffort = record.reasoningEffort === undefined
    ? undefined
    : requireOpaqueId(record.reasoningEffort, 'node.profile.reasoningEffort')
  if (model === undefined && reasoningEffort === undefined) return undefined
  return {
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function normalizeDependencies(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new ResidentError('GRAPH_INVALID', 'node.dependsOn must be an array')
  const dependencies = raw.map((value) => requireOpaqueId(value, 'node dependency'))
  if (new Set(dependencies).size !== dependencies.length) {
    throw new ResidentError('GRAPH_INVALID', 'node.dependsOn cannot contain duplicates')
  }
  return dependencies
}

function normalizeInputFrom(raw: unknown): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new ResidentError('GRAPH_INVALID', 'node.inputFrom must be an array')
  const inputs = raw.map((value) => requireOpaqueId(value, 'node.inputFrom entry'))
  if (new Set(inputs).size !== inputs.length) {
    throw new ResidentError('GRAPH_INVALID', 'node.inputFrom cannot contain duplicates')
  }
  return inputs
}

function normalizeScope(raw: unknown): TaskScope | undefined {
  if (raw === undefined) return undefined
  const record = requireRecord(raw, 'node.scope')
  assertOnlyKeys(record, ['read', 'write'], 'node.scope')
  const read = normalizeScopePaths(record.read, 'node.scope.read')
  const write = normalizeScopePaths(record.write, 'node.scope.write')
  const writeSet = new Set(write)
  const effectiveRead = read.filter((entry) => !writeSet.has(entry))
  if (effectiveRead.length === 0 && write.length === 0) return undefined
  return {
    ...(effectiveRead.length === 0 ? {} : { read: effectiveRead }),
    ...(write.length === 0 ? {} : { write }),
  }
}

function normalizeScopePaths(raw: unknown, label: string): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 512) throw new ResidentError('GRAPH_INVALID', `${label} must be an array with at most 512 paths`)
  const paths = raw.map((value) => normalizeRelativePath(value, label))
  return [...new Set(paths)].sort()
}

function normalizeRelativePath(raw: unknown, label: string): string {
  const value = requireText(raw, label, 1_024)
  if (value.includes('\\')) throw new ResidentError('GRAPH_INVALID', `${label} must use POSIX relative paths`)
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new ResidentError('GRAPH_INVALID', `${label} must not escape the workspace`)
  }
  const normalized = posix.normalize(value)
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new ResidentError('GRAPH_INVALID', `${label} must not escape the workspace`)
  }
  return normalized
}

function normalizeRetry(raw: unknown): TaskNode['retry'] | undefined {
  if (raw === undefined) return undefined
  const record = requireRecord(raw, 'node.retry')
  assertOnlyKeys(record, ['maxAttempts', 'delayMs', 'codes'], 'node.retry')
  if (!Array.isArray(record.codes) || record.codes.length === 0 || record.codes.length > 64) {
    throw new ResidentError('GRAPH_INVALID', 'node.retry.codes must be a non-empty array')
  }
  const codes = record.codes.map((code) => requireOpaqueId(code, 'node.retry code'))
  if (new Set(codes).size !== codes.length) {
    throw new ResidentError('GRAPH_INVALID', 'node.retry.codes cannot contain duplicates')
  }
  return {
    maxAttempts: positiveInteger(record.maxAttempts, 'node.retry.maxAttempts', 100),
    delayMs: nonNegativeInteger(record.delayMs, 'node.retry.delayMs'),
    codes,
  }
}

function assertAcyclic(nodes: readonly TaskNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): void => {
    const current = state.get(id)
    if (current === 'visiting') throw new ResidentError('GRAPH_INVALID', `Graph contains a dependency cycle at ${id}`)
    if (current === 'done') return
    state.set(id, 'visiting')
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency)
    state.set(id, 'done')
  }
  for (const node of nodes) visit(node.id)
}

function normalizeCwd(raw: unknown): string {
  const cwd = requireText(raw, 'graph.cwd', 4_096)
  if (!isAbsolute(cwd)) throw new ResidentError('GRAPH_INVALID', 'graph.cwd must be an absolute path')
  const resolved = resolvePath(cwd)
  try {
    return realpathSync.native(resolved)
  } catch {
    throw new ResidentError('GRAPH_INVALID', 'graph.cwd must reference an existing workspace directory')
  }
}

function normalizeResult(raw: unknown): TaskResult {
  const record = requireRecord(raw, 'driver result')
  assertOnlyKeys(record, ['output', 'nativeSessionId'], 'driver result')
  const nativeSessionId = record.nativeSessionId === undefined
    ? undefined
    : requireText(record.nativeSessionId, 'driver result nativeSessionId', 512)
  return {
    output: requireText(record.output, 'driver result output', MAX_TEXT_LENGTH, true),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
  }
}

function normalizeModels(raw: unknown): readonly NativeModel[] {
  if (!Array.isArray(raw)) throw new ResidentError('DRIVER_PROTOCOL_INVALID', 'Driver model catalog must be an array')
  const seen = new Set<string>()
  return raw.map((entry) => {
    const record = requireRecord(entry, 'driver model')
    assertOnlyKeys(record, ['id', 'name', 'reasoningEfforts'], 'driver model')
    const id = requireOpaqueId(record.id, 'driver model id')
    if (seen.has(id)) throw new ResidentError('DRIVER_PROTOCOL_INVALID', `Duplicate driver model ${id}`)
    seen.add(id)
    const name = record.name === undefined ? undefined : requireText(record.name, 'driver model name', 512, true)
    let reasoningEfforts: readonly string[] | undefined
    if (record.reasoningEfforts !== undefined) {
      if (!Array.isArray(record.reasoningEfforts)) {
        throw new ResidentError('DRIVER_PROTOCOL_INVALID', 'driver reasoningEfforts must be an array')
      }
      reasoningEfforts = [...new Set(record.reasoningEfforts.map((value) => requireOpaqueId(value, 'driver reasoning effort')))]
    }
    return {
      id,
      ...(name === undefined ? {} : { name }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    }
  })
}

function normalizeBridgeTools(raw: unknown): readonly NativeToolDefinition[] {
  if (!Array.isArray(raw) || raw.length > 1_024) {
    throw new ResidentError('REQUEST_INVALID', 'bridge tools must be an array with at most 1024 entries')
  }
  const seen = new Set<string>()
  const tools = raw.map((entry) => {
    const record = requireRecord(entry, 'bridge tool')
    assertOnlyKeys(record, ['name', 'description', 'inputSchema'], 'bridge tool')
    const name = requireOpaqueId(record.name, 'bridge tool name')
    if (seen.has(name)) throw new ResidentError('REQUEST_INVALID', `Duplicate bridge tool ${name}`)
    seen.add(name)
    const description = requireText(record.description, 'bridge tool description', 4_096, true)
    const inputSchema = requireRecord(record.inputSchema, 'bridge tool inputSchema')
    // Round-trip through canonical JSON to prevent prototype-bearing values entering durable state.
    const canonicalSchema = JSON.parse(stableJson(inputSchema)) as Record<string, unknown>
    return { name, description, inputSchema: canonicalSchema }
  })
  return tools.sort((left, right) => left.name.localeCompare(right.name))
}

function normalizeToolCallResult(raw: unknown): ToolCallResult {
  const record = requireRecord(raw, 'tool call result')
  assertOnlyKeys(record, ['content', 'isError'], 'tool call result')
  if (typeof record.isError !== 'boolean') throw new ResidentError('DRIVER_PROTOCOL_INVALID', 'tool call result isError must be boolean')
  return {
    content: requireText(record.content, 'tool call result content', MAX_TEXT_LENGTH, true),
    isError: record.isError,
  }
}

function parseToolCallResult(raw: string): ToolCallResult {
  try {
    return normalizeToolCallResult(JSON.parse(raw))
  } catch (error) {
    if (error instanceof ResidentError) throw new ResidentError('PERSISTED_FORMAT_INVALID', `Persisted tool call result is invalid: ${error.message}`)
    throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Persisted tool call result is not valid JSON')
  }
}

function normalizeDriverError(error: unknown): { code: string; message: string } {
  if (error instanceof ResidentError) return { code: error.code, message: truncate(error.message, 4_096) }
  if (error instanceof Error) {
    const code = typeof (error as Error & { code?: unknown }).code === 'string'
      && (error as Error & { code: string }).code.length > 0
      && (error as Error & { code: string }).code.length <= 128
      ? (error as Error & { code: string }).code
      : 'DRIVER_ERROR'
    return { code, message: error.message.length > 0 ? truncate(error.message, 4_096) : 'Native driver rejected without a message' }
  }
  if (isRecord(error)) {
    const code = typeof error.code === 'string' && error.code.length > 0 && error.code.length <= 128
      ? error.code
      : 'DRIVER_ERROR'
    const message = typeof error.message === 'string' && error.message.length > 0
      ? truncate(error.message, 4_096)
      : 'Native driver rejected without a message'
    return { code, message }
  }
  return { code: 'DRIVER_ERROR', message: 'Native driver failed' }
}

/** Only a declared write scope grants write access; see NativeAccess. */
export function nodeAccess(scope: TaskScope | undefined): NativeAccess {
  return (scope?.write?.length ?? 0) > 0 ? 'workspace-write' : 'read-only'
}

function scopesConflict(left: TaskScope | undefined, leftCwd: string, right: TaskScope | undefined, rightCwd: string): boolean {
  const leftAccess = scopeAccess(left, leftCwd)
  const rightAccess = scopeAccess(right, rightCwd)
  return leftAccess.some((a) => rightAccess.some((b) => (a.write || b.write) && pathsOverlap(a.path, b.path)))
}

function scopeAccess(scope: TaskScope | undefined, cwd: string): Array<{ path: string; write: boolean }> {
  if (!scope) return [{ path: cwd, write: true }]
  const read = (scope.read ?? []).map((path) => ({ path: resolvePath(cwd, scopeComparablePath(path)), write: false }))
  const write = (scope.write ?? []).map((path) => ({ path: resolvePath(cwd, scopeComparablePath(path)), write: true }))
  return [...read, ...write]
}

function scopeComparablePath(path: string): string {
  return path === '.' ? '' : path
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathPrefix(left, right) || isPathPrefix(right, left)
}

function isPathPrefix(path: string, prefix: string): boolean {
  return prefix === '/' ? path.startsWith('/') : path === prefix || path.startsWith(`${prefix}/`)
}

function isFailedDependencyStatus(status: string): boolean {
  return status === 'failed' || status === 'blocked' || status === 'cancelled'
}

function isActiveNodeStatus(status: string): boolean {
  return status === 'running' || status === 'cancelling'
}

function isTerminalGraphStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'indeterminate'
}

function isIndeterminateCode(code: string): boolean {
  return code === 'INDETERMINATE' || code === 'COMMAND_INDETERMINATE' || code === 'SESSION_FENCED'
}

function isAdmissionConflictCode(code: string): boolean {
  return code === 'PROFILE_CONFLICT' || code === 'SESSION_PROFILE_CONFLICT'
}

function isDependencyInputFailureCode(code: string): boolean {
  return code === 'DEPENDENCY_INPUT_TOO_LARGE'
}

function asGraphStatus(value: unknown): GraphStatus {
  if (value === 'queued' || value === 'running' || value === 'paused' || value === 'cancelling' || value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'indeterminate') return value
  throw new ResidentError('PERSISTED_FORMAT_INVALID', `Unknown graph status ${String(value)}`)
}

function asNodeStatus(value: unknown): NodeStatus {
  if (value === 'pending' || value === 'ready' || value === 'running' || value === 'cancelling' || value === 'succeeded' || value === 'failed' || value === 'blocked' || value === 'cancelled' || value === 'indeterminate') return value
  throw new ResidentError('PERSISTED_FORMAT_INVALID', `Unknown node status ${String(value)}`)
}

function parseSnapshot(raw: string): GraphSnapshot {
  try {
    const value = JSON.parse(raw) as unknown
    const record = requireRecord(value, 'command receipt')
    if (record.formatVersion !== 1) throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Command receipt format is unsupported')
    // Revalidate the graph instead of trusting a receipt recovered from disk.
    const graph = normalizeGraph(record.graph)
    const status = asGraphStatus(record.status)
    const revision = nonNegativeInteger(record.revision, 'receipt revision')
    const createdAt = nonNegativeInteger(record.createdAt, 'receipt createdAt')
    const updatedAt = nonNegativeInteger(record.updatedAt, 'receipt updatedAt')
    if (!Array.isArray(record.nodes)) throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Receipt nodes are invalid')
    const nodes = record.nodes.map((node) => normalizeSnapshotNode(node))
    return { formatVersion: 1, graph, status, revision, createdAt, updatedAt, nodes }
  } catch (error) {
    if (error instanceof ResidentError) throw error
    throw new ResidentError('PERSISTED_FORMAT_INVALID', 'Command receipt is not valid JSON')
  }
}

function normalizeSnapshotNode(raw: unknown): NodeSnapshot {
  const record = requireRecord(raw, 'receipt node')
  const id = requireOpaqueId(record.id, 'receipt node id')
  const status = asNodeStatus(record.status)
  const attempt = nonNegativeInteger(record.attempt, 'receipt node attempt')
  const commandId = record.commandId === undefined ? undefined : requireOpaqueId(record.commandId, 'receipt commandId')
  const output = record.output === undefined ? undefined : requireText(record.output, 'receipt output', MAX_TEXT_LENGTH, true)
  let error: NodeSnapshot['error']
  if (record.error !== undefined) {
    const errorRecord = requireRecord(record.error, 'receipt error')
    error = {
      code: requireOpaqueId(errorRecord.code, 'receipt error code'),
      message: requireText(errorRecord.message, 'receipt error message', 4_096, true),
    }
  }
  const nativeSessionId = record.nativeSessionId === undefined ? undefined : requireText(record.nativeSessionId, 'receipt nativeSessionId', 512)
  const waitReason = record.waitReason === undefined ? undefined : requireText(record.waitReason, 'receipt waitReason', 512, true)
  return {
    id,
    status,
    attempt,
    ...(commandId === undefined ? {} : { commandId }),
    ...(output === undefined ? {} : { output }),
    ...(error === undefined ? {} : { error }),
    ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
    ...(waitReason === undefined ? {} : { waitReason }),
  }
}

function requireRecord(raw: unknown, label: string): Record<string, unknown> {
  if (!isRecord(raw)) throw new ResidentError('REQUEST_INVALID', `${label} must be an object`)
  return raw
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false
  const prototype = Object.getPrototypeOf(raw)
  return prototype === Object.prototype || prototype === null
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new ResidentError('REQUEST_INVALID', `${label} contains unknown field ${key}`)
  }
}

function requireOpaqueId(raw: unknown, label: string): string {
  const value = requireText(raw, label, 256)
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ResidentError('REQUEST_INVALID', `${label} contains unsupported whitespace or control characters`)
  }
  return value
}

function requireText(raw: unknown, label: string, maxLength: number, allowEmpty = false): string {
  if (typeof raw !== 'string' || (!allowEmpty && raw.length === 0) || raw.length > maxLength || raw.includes('\u0000')) {
    throw new ResidentError('REQUEST_INVALID', `${label} must be a ${allowEmpty ? 'string' : 'non-empty string'} no longer than ${maxLength} characters`)
  }
  return raw
}

function positiveInteger(raw: unknown, label: string, max: number): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1 || (raw as number) > max) {
    throw new ResidentError('REQUEST_INVALID', `${label} must be an integer between 1 and ${max}`)
  }
  return raw as number
}

function nonNegativeInteger(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    throw new ResidentError('REQUEST_INVALID', `${label} must be a non-negative safe integer`)
  }
  return raw as number
}

function optionalTime(raw: unknown, label: string): number | undefined {
  return raw === undefined ? undefined : nonNegativeInteger(raw, label)
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function effectiveProfileJson(profile: NativeProfile | undefined): string {
  return stableJson(profile ?? {})
}

function stableJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ResidentError('REQUEST_INVALID', 'Non-finite values cannot be persisted')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (!isRecord(value)) throw new ResidentError('REQUEST_INVALID', 'Only plain JSON values can be hashed')
  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
}

function activeKey(graphId: string, nodeId: string): string {
  return `${graphId}\u0000${nodeId}`
}

function toolCallKey(commandId: string, callId: string): string {
  return `${commandId}\u0000${callId}`
}

function normalizeDatabaseLockError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/database is (?:locked|busy)|SQLITE_BUSY|SQLITE_LOCKED/i.test(message)) {
    return new ResidentError('ENGINE_ALREADY_RUNNING', 'Another Resident daemon already owns this database')
  }
  return error instanceof Error ? error : new Error(message)
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ResidentError('PERSISTED_FORMAT_INVALID', `${label} must be text`)
  return value
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ResidentError('PERSISTED_FORMAT_INVALID', `${label} must be an integer`)
  }
  return value
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength)
}
