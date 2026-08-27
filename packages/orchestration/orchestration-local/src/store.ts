/** SQLite single-writer store and content-addressed artifact repository. */
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  OrchestrationArtifactRef,
  OrchestrationError,
  OrchestrationRunId,
  type LogicalTaskGraphV1,
  type OrchestrationCompilationV1,
  type OrchestrationEvent,
  type OrchestrationEventPage,
  type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import type { IntentIRV1 } from '@deepseek-ai/dsh-intent-compiler'
import { canonicalJson, canonicalSha256 } from './canonical.ts'
import type { AutonomousRuntimeStateV1 } from './autonomous.ts'

/** Forward-only SQLite schema version used by the strict daemon handshake. */
export const ORCHESTRATION_STATE_SCHEMA_VERSION = 3

/** Daemon-private state required to continue one public run projection. */
export interface RuntimeRunRecord {
  readonly snapshot: OrchestrationRunSnapshot
  readonly graph: LogicalTaskGraphV1
  readonly intent: IntentIRV1
  readonly intentRef: OrchestrationArtifactRef
  readonly requirementRef?: OrchestrationArtifactRef
  readonly graphRef: OrchestrationArtifactRef
  readonly approvalRef?: string
  readonly retryAfter: Readonly<Record<string, string>>
}

/** Durable physical attempt reconciliation record. */
export interface AttemptRecord {
  readonly runId: string
  readonly nodeId: string
  readonly attempt: number
  readonly generation: number
  readonly executionId: string
  readonly state: 'accepted' | 'running' | 'settled' | 'failed' | 'indeterminate'
  readonly executionPlanRef: string
  readonly turnId?: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** Durable capability update queued for a later binding generation. */
export interface CapabilityUpdateRecord {
  readonly updateId: string
  readonly runId: string
  readonly nodeId: string
  readonly generation: number
  readonly state: 'queued' | 'awaiting_approval' | 'rejected' | 'applied'
  readonly updateSha256: string
  readonly payload: {
    readonly requestedCapabilities: readonly string[]
    readonly applyAt: 'next-turn' | 'immediate'
  }
}

/** Durable idempotency receipt for one remotely retryable control command. */
export interface OrchestrationCommandReceipt {
  readonly commandId: string
  readonly method: string
  readonly requestSha256: string
  readonly state: 'accepted' | 'settled' | 'failed' | 'indeterminate'
  readonly response?: unknown
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly createdAt: string
  readonly updatedAt: string
}

function makePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  chmodSync(path, 0o700)
}

function optionalDatabaseString(value: unknown, column: string): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new OrchestrationError(`invalid ${column} value in orchestration state`, 'ORCHESTRATION_UNAVAILABLE')
  }
  return value
}

/** Local orchestration state and artifacts, written only by the daemon. */
export class OrchestrationStore {
  /** Sole-writer SQLite connection. */
  readonly db: DatabaseSync
  /** Owner-private content-addressed artifact directory. */
  readonly artifactRoot: string

  constructor(readonly root: string) {
    makePrivateDirectory(root)
    this.artifactRoot = join(root, 'artifacts', 'sha256')
    makePrivateDirectory(this.artifactRoot)
    const path = join(root, 'state.sqlite')
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;')
    const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version > ORCHESTRATION_STATE_SCHEMA_VERSION) {
      throw new OrchestrationError(
        `orchestration state schema ${String(version)} is newer than supported ${String(ORCHESTRATION_STATE_SCHEMA_VERSION)}`,
        'ORCHESTRATION_UNAVAILABLE',
      )
    }
    if (version === 0) this.createSchema()
    else if (version === 1) {
      this.migrateSchema1To2()
      this.migrateSchema2To3()
    } else if (version === 2) this.migrateSchema2To3()
  }

  /** Close the SQLite writer connection. */
  close(): void {
    this.db.close()
  }

  /**
   * Persist one immutable content-addressed artifact.
   * @param value - immutable JSON-compatible artifact.
   * @returns its content-addressed reference.
   */
  putArtifact(value: unknown): OrchestrationArtifactRef {
    const encoded = canonicalJson(value)
    const digest = canonicalSha256(value)
    const bucket = join(this.artifactRoot, digest.slice(0, 2))
    makePrivateDirectory(bucket)
    const target = join(bucket, digest)
    if (!existsSync(target)) {
      const temporary = join(bucket, `.${digest}.${randomUUID()}.tmp`)
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, encoded, 'utf8')
      } finally {
        closeSync(descriptor)
      }
      try {
        renameSync(temporary, target)
      } catch (error) {
        try { unlinkSync(temporary) } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup
        }
        if (!existsSync(target)) throw error
      }
      chmodSync(target, 0o600)
    }
    return OrchestrationArtifactRef(`sha256:${digest}`)
  }

  /**
   * Read and digest-verify one artifact.
   * @param ref - content-addressed artifact identity.
   * @returns the digest-verified decoded value.
   */
  readArtifact(ref: OrchestrationArtifactRef): unknown {
    const value = String(ref)
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
      throw new OrchestrationError(`invalid orchestration artifact ref: ${value}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    const digest = value.slice(7)
    const encoded = readFileSync(join(this.artifactRoot, digest.slice(0, 2), digest), 'utf8')
    if (canonicalSha256(JSON.parse(encoded)) !== digest) {
      throw new OrchestrationError(`orchestration artifact digest mismatch: ${value}`, 'ORCHESTRATION_UNAVAILABLE')
    }
    return JSON.parse(encoded) as unknown
  }

  /**
   * Persist one immutable certified compilation.
   * @param compilation - immutable certified compilation to persist.
   */
  saveCompilation(compilation: OrchestrationCompilationV1): void {
    this.db.prepare(`
      INSERT INTO compilations (compilation_id, payload_json, created_at)
      VALUES (?, ?, ?)
    `).run(compilation.compilationId, canonicalJson(compilation), new Date().toISOString())
  }

  /**
   * Read one certified compilation.
   * @param compilationId - deterministic compilation identity.
   * @returns the stored compilation.
   */
  getCompilation(compilationId: string): OrchestrationCompilationV1 {
    const row = this.db.prepare('SELECT payload_json FROM compilations WHERE compilation_id = ?').get(compilationId) as { payload_json: string } | undefined
    if (row === undefined) throw new OrchestrationError(`compilation not found: ${compilationId}`, 'COMPILATION_NOT_FOUND')
    return JSON.parse(row.payload_json) as OrchestrationCompilationV1
  }

  /**
   * Create a run and its initial event sequence atomically.
   * @param record - initial durable run record.
   * @param events - initial append-only events.
   */
  createRun(record: RuntimeRunRecord, events: readonly Omit<OrchestrationEvent, 'sequence'>[]): void {
    this.transaction(() => {
      this.db.prepare('INSERT INTO runs (run_id, payload_json, state, revision, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(
          String(record.snapshot.runId), canonicalJson(record), record.snapshot.state,
          record.snapshot.revision, record.snapshot.updatedAt,
        )
      for (const event of events) this.insertEvent(event)
    })
  }

  /**
   * Save a revised run projection with paired events.
   * @param record - revised durable run record.
   * @param events - events committed with the projection.
   */
  saveRun(record: RuntimeRunRecord, events: readonly Omit<OrchestrationEvent, 'sequence'>[] = []): void {
    this.transaction(() => {
      const result = this.db.prepare('UPDATE runs SET payload_json = ?, state = ?, revision = ?, updated_at = ? WHERE run_id = ?')
        .run(
          canonicalJson(record), record.snapshot.state, record.snapshot.revision,
          record.snapshot.updatedAt, String(record.snapshot.runId),
        )
      if (Number(result.changes) !== 1) throw new OrchestrationError(`run not found: ${String(record.snapshot.runId)}`, 'RUN_NOT_FOUND')
      for (const event of events) this.insertEvent(event)
    })
  }

  /**
   * Append observation-only events without rewriting a concurrently advancing Run snapshot.
   * @param events - observation events to append.
   */
  appendEvents(events: readonly Omit<OrchestrationEvent, 'sequence'>[]): void {
    if (events.length === 0) return
    this.transaction(() => {
      for (const event of events) this.insertEvent(event)
    })
  }

  /**
   * Read daemon-private continuation state.
   * @param runId - durable run identity.
   * @returns daemon-private continuation state.
   */
  getRun(runId: string): RuntimeRunRecord {
    const row = this.db.prepare('SELECT payload_json FROM runs WHERE run_id = ?').get(runId) as { payload_json: string } | undefined
    if (row === undefined) throw new OrchestrationError(`run not found: ${runId}`, 'RUN_NOT_FOUND')
    return JSON.parse(row.payload_json) as RuntimeRunRecord
  }

  /**
   * List daemon-private continuation records.
   * @returns run records ordered by most recent update.
   */
  listRuns(): RuntimeRunRecord[] {
    return (this.db.prepare('SELECT payload_json FROM runs ORDER BY updated_at DESC').all() as { payload_json: string }[])
      .map(row => JSON.parse(row.payload_json) as RuntimeRunRecord)
  }

  /**
   * Index a content-addressed artifact by pipeline stage.
   * @param kind - owning artifact index.
   * @param value - artifact lineage coordinates.
   */
  recordArtifact(kind: 'compilation_artifacts' | 'capability_bindings' | 'context_packets' | 'node_execution_plans', value: {
    readonly ref: string
    readonly runId?: string
    readonly nodeId?: string
    readonly attempt?: number
    readonly generation?: number
  }): void {
    this.db.prepare(`INSERT OR IGNORE INTO ${kind} (artifact_ref, run_id, node_id, attempt, generation, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(value.ref, value.runId ?? null, value.nodeId ?? null, value.attempt ?? null, value.generation ?? null, new Date().toISOString())
  }

  /**
   * Persist an accepted or reconciled physical attempt.
   * @param attempt - physical-attempt receipt state.
   */
  saveAttempt(attempt: AttemptRecord): void {
    this.db.prepare(`
      INSERT INTO attempts (run_id, node_id, attempt, generation, execution_id, state, execution_plan_ref, turn_id, error_code, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
        generation = excluded.generation,
        state = excluded.state,
        turn_id = excluded.turn_id,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
    `).run(
      attempt.runId, attempt.nodeId, attempt.attempt, attempt.generation, attempt.executionId,
      attempt.state, attempt.executionPlanRef, attempt.turnId ?? null, attempt.errorCode ?? null,
      attempt.errorMessage ?? null, attempt.createdAt, attempt.updatedAt,
    )
  }

  /**
   * Persist the host-side Autonomous state after each usage, gate, and continuation transition.
   * @param runId - owning orchestration run.
   * @param nodeId - owning logical node.
   * @param attempt - physical attempt generation.
   * @param state - exact host-side state to restore after restart.
   */
  saveAutonomousState(
    runId: string,
    nodeId: string,
    attempt: number,
    state: AutonomousRuntimeStateV1,
  ): void {
    this.db.prepare(`
      INSERT INTO autonomous_states (run_id, node_id, attempt, payload_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(runId, nodeId, attempt, canonicalJson(state), new Date().toISOString())
  }

  /**
   * Restore one attempt's exact host-side Autonomous counters after daemon restart.
   * @param runId - owning orchestration run.
   * @param nodeId - owning logical node.
   * @param attempt - physical attempt generation.
   * @returns the persisted state, or undefined before the first transition.
   */
  autonomousState(runId: string, nodeId: string, attempt: number): AutonomousRuntimeStateV1 | undefined {
    const row = this.db.prepare(`
      SELECT payload_json FROM autonomous_states WHERE run_id = ? AND node_id = ? AND attempt = ?
    `).get(runId, nodeId, attempt) as { payload_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.payload_json) as AutonomousRuntimeStateV1
  }

  /**
   * List physical attempt receipts.
   * @param states - optional lifecycle filter.
   * @returns matching attempt receipts in creation order.
   */
  attempts(states?: readonly AttemptRecord['state'][]): AttemptRecord[] {
    const rows = states === undefined || states.length === 0
      ? this.db.prepare('SELECT * FROM attempts ORDER BY created_at').all()
      : this.db.prepare(`SELECT * FROM attempts WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at`).all(...states)
    return (rows as Record<string, unknown>[]).map((row) => {
      const turnId = optionalDatabaseString(row.turn_id, 'turn_id')
      const errorCode = optionalDatabaseString(row.error_code, 'error_code')
      const errorMessage = optionalDatabaseString(row.error_message, 'error_message')
      return {
        runId: String(row.run_id), nodeId: String(row.node_id), attempt: Number(row.attempt),
        generation: Number(row.generation), executionId: String(row.execution_id),
        state: String(row.state) as AttemptRecord['state'], executionPlanRef: String(row.execution_plan_ref),
        ...turnId === undefined ? {} : { turnId },
        ...errorCode === undefined ? {} : { errorCode },
        ...errorMessage === undefined ? {} : { errorMessage },
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      }
    })
  }

  /**
   * Persist one capability-update admission receipt.
   * @param value - durable admission receipt and payload.
   */
  saveCapabilityUpdate(value: {
    readonly updateId: string
    readonly runId: string
    readonly nodeId: string
    readonly generation: number
    readonly state: string
    readonly updateSha256: string
    readonly payload: unknown
  }): void {
    this.db.prepare(`
      INSERT INTO capability_updates
        (update_id, run_id, node_id, generation, state, update_sha256, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      value.updateId, value.runId, value.nodeId, value.generation, value.state,
      value.updateSha256, canonicalJson(value.payload), new Date().toISOString(),
    )
  }

  /**
   * List capability updates for one node.
   * @param runId - durable run identity.
   * @param nodeId - target node.
   * @returns ordered update records.
   */
  capabilityUpdates(runId: string, nodeId: string): CapabilityUpdateRecord[] {
    const rows = this.db.prepare(`
      SELECT update_id, run_id, node_id, generation, state, update_sha256, payload_json
      FROM capability_updates WHERE run_id = ? AND node_id = ? ORDER BY generation, created_at
    `).all(runId, nodeId) as Record<string, unknown>[]
    return rows.map(row => ({
      updateId: String(row.update_id), runId: String(row.run_id), nodeId: String(row.node_id),
      generation: Number(row.generation), state: String(row.state) as CapabilityUpdateRecord['state'],
      updateSha256: String(row.update_sha256), payload: JSON.parse(String(row.payload_json)) as CapabilityUpdateRecord['payload'],
    }))
  }

  /**
   * Mark capability updates with a newly proven lifecycle state.
   * @param updateIds - exact update identities.
   * @param state - newly proven lifecycle state.
   */
  markCapabilityUpdates(updateIds: readonly string[], state: CapabilityUpdateRecord['state']): void {
    if (updateIds.length === 0) return
    this.db.prepare(`UPDATE capability_updates SET state = ? WHERE update_id IN (${updateIds.map(() => '?').join(',')})`)
      .run(state, ...updateIds)
  }

  /**
   * Read one durable remote-control command receipt.
   * @param commandId - caller-stable command identity.
   * @returns the receipt when it exists.
   */
  commandReceipt(commandId: string): OrchestrationCommandReceipt | undefined {
    const row = this.db.prepare('SELECT * FROM command_receipts WHERE command_id = ?').get(commandId) as Record<string, unknown> | undefined
    if (row === undefined) return undefined
    const response = optionalDatabaseString(row.response_json, 'response_json')
    const errorCode = optionalDatabaseString(row.error_code, 'error_code')
    const errorMessage = optionalDatabaseString(row.error_message, 'error_message')
    return {
      commandId: String(row.command_id), method: String(row.method), requestSha256: String(row.request_sha256),
      state: String(row.state) as OrchestrationCommandReceipt['state'],
      ...response === undefined ? {} : { response: JSON.parse(response) as unknown },
      ...errorCode === undefined ? {} : { errorCode },
      ...errorMessage === undefined ? {} : { errorMessage },
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }
  }

  /**
   * Persist acceptance before any control mutation is attempted.
   * @param commandId - caller-stable command identity.
   * @param method - requested orchestration control method.
   * @param requestSha256 - canonical request digest.
   */
  acceptCommand(commandId: string, method: string, requestSha256: string): void {
    const time = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO command_receipts
        (command_id, method, request_sha256, state, created_at, updated_at)
      VALUES (?, ?, ?, 'accepted', ?, ?)
    `).run(commandId, method, requestSha256, time, time)
  }

  /**
   * Cache one successful command result for identical transport retries.
   * @param commandId - accepted command identity.
   * @param response - bounded control response.
   */
  settleCommand(commandId: string, response: unknown): void {
    this.db.prepare(`
      UPDATE command_receipts
      SET state = 'settled', response_json = ?, updated_at = ?
      WHERE command_id = ? AND state = 'accepted'
    `).run(canonicalJson(response), new Date().toISOString(), commandId)
  }

  /**
   * Cache one deterministic command rejection.
   * @param commandId - accepted command identity.
   * @param errorCode - stable failure code.
   * @param errorMessage - bounded diagnostic message.
   */
  failCommand(commandId: string, errorCode: string, errorMessage: string): void {
    this.db.prepare(`
      UPDATE command_receipts
      SET state = 'failed', error_code = ?, error_message = ?, updated_at = ?
      WHERE command_id = ? AND state = 'accepted'
    `).run(errorCode, errorMessage, new Date().toISOString(), commandId)
  }

  /**
   * Fence one command whose outcome cannot be proven after daemon recovery.
   * @param commandId - accepted command identity.
   */
  markCommandIndeterminate(commandId: string): void {
    this.db.prepare(`
      UPDATE command_receipts
      SET state = 'indeterminate', updated_at = ?
      WHERE command_id = ? AND state = 'accepted'
    `).run(new Date().toISOString(), commandId)
  }

  /**
   * Read a bounded ordered event page.
   * @param runId - durable run identity.
   * @param afterSequence - exclusive cursor.
   * @param limit - bounded page size.
   * @returns ordered event page.
   */
  readEvents(runId: string, afterSequence = 0, limit = 100): OrchestrationEventPage {
    const bounded = Math.min(Math.max(limit, 1), 500)
    const rows = this.db.prepare('SELECT * FROM orchestration_events WHERE run_id = ? AND sequence > ? ORDER BY sequence LIMIT ?')
      .all(runId, afterSequence, bounded) as Record<string, unknown>[]
    const events = rows.map((row) => {
      const nodeId = optionalDatabaseString(row.node_id, 'node_id')
      return {
        sequence: Number(row.sequence),
        runId: OrchestrationRunId(String(row.run_id)),
        ...nodeId === undefined ? {} : { nodeId },
        ...row.attempt === null ? {} : { attempt: Number(row.attempt) },
        ...row.generation === null ? {} : { generation: Number(row.generation) },
        type: String(row.type),
        time: String(row.time),
        data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
      }
    })
    return { events, nextSequence: events.at(-1)?.sequence ?? afterSequence }
  }

  private insertEvent(event: Omit<OrchestrationEvent, 'sequence'>): void {
    this.db.prepare(`
      INSERT INTO orchestration_events
        (run_id, node_id, attempt, generation, type, time, data_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(event.runId), event.nodeId ?? null, event.attempt ?? null,
      event.generation ?? null, event.type, event.time, canonicalJson(event.data),
    )
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE compilations (
        compilation_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        run_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE attempts (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        execution_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        execution_plan_ref TEXT NOT NULL,
        turn_id TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id, attempt),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      CREATE TABLE orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        node_id TEXT,
        attempt INTEGER,
        generation INTEGER,
        type TEXT NOT NULL,
        time TEXT NOT NULL,
        data_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      CREATE TABLE compilation_artifacts (artifact_ref TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, attempt INTEGER, generation INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE capability_bindings (artifact_ref TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, attempt INTEGER, generation INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE context_packets (artifact_ref TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, attempt INTEGER, generation INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE node_execution_plans (artifact_ref TEXT PRIMARY KEY, run_id TEXT, node_id TEXT, attempt INTEGER, generation INTEGER, created_at TEXT NOT NULL);
      CREATE TABLE capability_updates (
        update_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        state TEXT NOT NULL,
        update_sha256 TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        request_sha256 TEXT NOT NULL,
        state TEXT NOT NULL,
        response_json TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE autonomous_states (
        run_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (run_id, node_id, attempt),
        FOREIGN KEY (run_id) REFERENCES runs(run_id)
      );
      PRAGMA user_version = ${String(ORCHESTRATION_STATE_SCHEMA_VERSION)};
    `)
  }

  private migrateSchema1To2(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE command_receipts (
          command_id TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          request_sha256 TEXT NOT NULL,
          state TEXT NOT NULL,
          response_json TEXT,
          error_code TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        PRAGMA user_version = 2;
      `)
    })
  }

  private migrateSchema2To3(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE autonomous_states (
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (run_id, node_id, attempt),
          FOREIGN KEY (run_id) REFERENCES runs(run_id)
        );
        PRAGMA user_version = 3;
      `)
    })
  }
}
