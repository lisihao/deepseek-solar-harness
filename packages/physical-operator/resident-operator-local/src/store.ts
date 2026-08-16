/** SQLite single-writer state, receipts, leases, events, and artifacts. @module @deepseek-ai/dsh-resident-operator-local/store */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  ResidentOperatorError,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  RESIDENT_STATE_SCHEMA_VERSION,
  type ResidentEventPage,
  type ResidentReceiptState,
  type ResidentSessionSnapshot,
  type ResidentStopReason,
  type ResidentTurnResult,
} from '@deepseek-ai/dsh-resident-operator'

const MAX_INLINE_RESULT_BYTES = 64 * 1024

interface SessionRow {
  id: string
  operator_id: string
  workspace: string
  lifecycle: string
  health: string
  health_reason: string | null
  revision: number
  native_session_id: string | null
  active_turn_id: string | null
  updated_at: string
}

interface ReceiptRow {
  command_id: string
  supersedes_command_id: string | null
  request_hash: string
  session_id: string
  turn_id: string
  state: ResidentReceiptState
  native_turn_id: string | null
  result_json: string | null
  result_ref: string | null
  error_code: string | null
  error_message: string | null
  resolution: string | null
}

/** Durable receipt projection returned immediately after admission or replay. */
export interface AcceptedTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly stateRevision: number
  readonly state: ResidentReceiptState
}

/** Receipt projection enriched with settled result or coded failure. */
export interface TurnInspection extends AcceptedTurn {
  readonly result?: ResidentTurnResult
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * Hash the behaviorally relevant command request independently of its identity.
 * @param operatorId - selected native product Driver.
 * @param workspace - canonical realpath workspace.
 * @param prompt - validated text content blocks.
 * @param supersedesCommandId - optional explicitly abandoned receipt lineage.
 * @returns lowercase SHA-256 digest.
 */
export function canonicalRequestHash(
  operatorId: string,
  workspace: string,
  prompt: readonly ContentBlock[],
  supersedesCommandId?: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ operatorId, workspace, prompt, supersedesCommandId: supersedesCommandId ?? null }))
    .digest('hex')
}

/** Single-writer SQLite state, receipt, lease, event, and artifact authority. */
export class ResidentStore {
  private readonly db: DatabaseSync
  private readonly artifactRoot: string

  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    chmodSync(root, 0o700)
    this.artifactRoot = join(root, 'artifacts', 'sha256')
    mkdirSync(this.artifactRoot, { recursive: true, mode: 0o700 })
    chmodSync(join(root, 'artifacts'), 0o700)
    chmodSync(this.artifactRoot, 0o700)
    const path = join(root, 'state.sqlite')
    if (!existsSync(path)) {
      const descriptor = openSync(path, 'wx', 0o600)
      closeSync(descriptor)
    }
    this.db = new DatabaseSync(path)
    this.configure()
    this.recoverInterrupted()
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) chmodSync(file, 0o600)
    }
  }

  /** Close the SQLite connection after daemon quiescence. */
  close(): void {
    this.db.close()
  }

  private configure(): void {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 0 && version !== RESIDENT_STATE_SCHEMA_VERSION) {
      throw new ResidentOperatorError(
        `resident state schema ${version} is incompatible with ${RESIDENT_STATE_SCHEMA_VERSION}`,
        'PROTOCOL_MISMATCH',
      )
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS resident_sessions (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        health TEXT NOT NULL,
        health_reason TEXT,
        revision INTEGER NOT NULL,
        native_session_id TEXT,
        active_turn_id TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(operator_id, workspace)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        supersedes_command_id TEXT UNIQUE REFERENCES command_receipts(command_id),
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        turn_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        native_turn_id TEXT,
        result_json TEXT,
        result_ref TEXT,
        error_code TEXT,
        error_message TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS session_leases (
        session_id TEXT PRIMARY KEY REFERENCES resident_sessions(id),
        turn_id TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS resident_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        type TEXT NOT NULL,
        time TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS artifact_refs (
        digest TEXT PRIMARY KEY,
        byte_length INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      PRAGMA user_version = ${RESIDENT_STATE_SCHEMA_VERSION};
    `)
  }

  /** Any pre-crash accepted/running command is unsafe to replay automatically. */
  private recoverInterrupted(): void {
    const now = new Date().toISOString()
    this.transaction(() => {
      const interrupted = this.db.prepare(
        "SELECT command_id, session_id, turn_id FROM command_receipts WHERE state IN ('accepted', 'running')",
      ).all() as unknown as Array<{ command_id: string; session_id: string; turn_id: string }>
      for (const row of interrupted) {
        this.db.prepare(
          "UPDATE command_receipts SET state = 'indeterminate', error_code = 'COMMAND_INDETERMINATE', error_message = ?, updated_at = ? WHERE command_id = ?",
        ).run('daemon stopped before durable settlement; automatic replay is forbidden', now, row.command_id)
        this.db.prepare('DELETE FROM session_leases WHERE session_id = ?').run(row.session_id)
        this.db.prepare(
          "UPDATE resident_sessions SET lifecycle = 'idle', health = 'degraded', health_reason = 'process_crashed', active_turn_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?",
        ).run(now, row.session_id)
        this.appendEvent(row.session_id, 'turn.indeterminate', {
          commandId: row.command_id,
          turnId: row.turn_id,
          reason: 'daemon_recovery',
        }, now)
      }
    })
  }

  /**
   * Atomically create or replay one command receipt and acquire its Session lease.
   * @param commandId - caller-owned idempotency identity.
   * @param requestHash - canonical request conflict detector.
   * @param operatorId - selected native product Driver.
   * @param workspace - canonical realpath workspace.
   * @param supersedesCommandId - optional uniquely linked abandoned indeterminate command.
   * @returns accepted or existing receipt projection.
   */
  accept(
    commandId: string,
    requestHash: string,
    operatorId: string,
    workspace: string,
    supersedesCommandId?: string,
  ): AcceptedTurn {
    return this.transaction(() => {
      const existing = this.receiptByCommand(commandId)
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          throw new ResidentOperatorError(
            `command ${commandId} was already accepted with different content`,
            'COMMAND_CONFLICT',
          )
        }
        return this.acceptedFrom(existing)
      }

      const now = new Date().toISOString()
      let superseded: ReceiptRow | undefined
      if (supersedesCommandId !== undefined) {
        if (supersedesCommandId === commandId) {
          throw new ResidentOperatorError('a resident command cannot supersede itself', 'COMMAND_CONFLICT')
        }
        superseded = this.requireReceipt(supersedesCommandId)
        if (superseded.state !== 'indeterminate' || superseded.resolution !== 'abandon') {
          throw new ResidentOperatorError(
            `command ${supersedesCommandId} is not an explicitly abandoned indeterminate command`,
            'COMMAND_INDETERMINATE',
          )
        }
        const priorSession = this.sessionRow(superseded.session_id)
        if (priorSession.operator_id !== operatorId || priorSession.workspace !== workspace) {
          throw new ResidentOperatorError(
            `command ${supersedesCommandId} belongs to a different resident session`,
            'COMMAND_CONFLICT',
          )
        }
        const existingRetry = this.db.prepare(
          'SELECT command_id FROM command_receipts WHERE supersedes_command_id = ?',
        ).get(supersedesCommandId) as { command_id: string } | undefined
        if (existingRetry !== undefined) {
          throw new ResidentOperatorError(
            `command ${supersedesCommandId} was already retried as ${existingRetry.command_id}`,
            'COMMAND_CONFLICT',
          )
        }
      }
      let session = this.db.prepare(
        'SELECT * FROM resident_sessions WHERE operator_id = ? AND workspace = ?',
      ).get(operatorId, workspace) as unknown as SessionRow | undefined
      if (session === undefined) {
        const id = randomUUID()
        this.db.prepare(`
          INSERT INTO resident_sessions
            (id, operator_id, workspace, lifecycle, health, health_reason, revision, native_session_id, active_turn_id, updated_at)
          VALUES (?, ?, ?, 'idle', 'ok', NULL, 0, NULL, NULL, ?)
        `).run(id, operatorId, workspace, now)
        session = this.sessionRow(id)
        this.appendEvent(id, 'session.created', { operatorId }, now)
      }
      if (session.active_turn_id !== null) {
        throw new ResidentOperatorError(
          `resident session ${session.id} already has active turn ${session.active_turn_id}`,
          'SESSION_BUSY',
        )
      }

      const turnId = randomUUID()
      this.db.prepare(`
        INSERT INTO command_receipts
          (command_id, supersedes_command_id, request_hash, session_id, turn_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?)
      `).run(commandId, supersedesCommandId ?? null, requestHash, session.id, turnId, now, now)
      this.db.prepare(
        'INSERT INTO session_leases (session_id, turn_id, acquired_at, heartbeat_at) VALUES (?, ?, ?, ?)',
      ).run(session.id, turnId, now, now)
      this.db.prepare(`
        UPDATE resident_sessions
        SET lifecycle = 'running', health = 'ok', health_reason = NULL,
            active_turn_id = ?, revision = revision + 1, updated_at = ?
        WHERE id = ?
      `).run(turnId, now, session.id)
      this.appendEvent(session.id, 'turn.accepted', {
        commandId,
        turnId,
        supersedesCommandId: superseded?.command_id ?? null,
      }, now)
      return {
        sessionId: session.id,
        turnId,
        stateRevision: this.sessionRow(session.id).revision,
        state: 'accepted',
      }
    })
  }

  /**
   * Persist product-native identities before or during execution.
   * @param commandId - admitted durable command identity.
   * @param nativeSessionId - authoritative product Session or thread identity.
   * @param nativeTurnId - optional product turn identity.
   * @returns updated receipt projection.
   */
  markRunning(commandId: string, nativeSessionId?: string, nativeTurnId?: string): AcceptedTurn {
    return this.transaction(() => {
      const receipt = this.requireReceipt(commandId)
      if (receipt.state !== 'accepted' && receipt.state !== 'running') return this.acceptedFrom(receipt)
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE command_receipts SET state = 'running', native_turn_id = COALESCE(?, native_turn_id), updated_at = ?
        WHERE command_id = ?
      `).run(nativeTurnId ?? null, now, commandId)
      if (nativeSessionId !== undefined) {
        this.db.prepare(`
          UPDATE resident_sessions SET native_session_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(nativeSessionId, now, receipt.session_id)
      }
      this.db.prepare('UPDATE session_leases SET heartbeat_at = ? WHERE session_id = ?').run(now, receipt.session_id)
      this.appendEvent(receipt.session_id, 'turn.running', {
        commandId,
        turnId: receipt.turn_id,
        nativeTurnId: nativeTurnId ?? null,
      }, now)
      return this.acceptedFrom(this.requireReceipt(commandId))
    })
  }

  /**
   * Refresh one accepted/running Session lease without appending an event.
   * @param commandId - admitted durable command identity.
   */
  heartbeat(commandId: string): void {
    const receipt = this.requireReceipt(commandId)
    if (receipt.state !== 'accepted' && receipt.state !== 'running') return
    this.db.prepare('UPDATE session_leases SET heartbeat_at = ? WHERE session_id = ?')
      .run(new Date().toISOString(), receipt.session_id)
  }

  /**
   * Atomically settle one receipt and release its Session lease.
   * @param commandId - admitted durable command identity.
   * @param result - bounded product outcome, spilled when necessary.
   * @returns durable settled receipt projection.
   */
  settle(commandId: string, result: ResidentTurnResult): TurnInspection {
    return this.transaction(() => {
      const receipt = this.requireReceipt(commandId)
      if (receipt.state === 'settled') return this.inspectTurn(receipt.turn_id)
      if (receipt.state === 'indeterminate') {
        throw new ResidentOperatorError(`command ${commandId} is indeterminate`, 'COMMAND_INDETERMINATE')
      }
      const now = new Date().toISOString()
      const encoded = JSON.stringify(result)
      let storedResult: ResidentTurnResult = result
      let resultRef: string | null = null
      if (Buffer.byteLength(encoded) > MAX_INLINE_RESULT_BYTES) {
        resultRef = this.writeArtifact(encoded, now)
        storedResult = {
          output: [{ type: 'text', text: `Resident result stored at ${resultRef}.` }],
          stopReason: result.stopReason,
          resultRef,
        }
      }
      this.db.prepare(`
        UPDATE command_receipts
        SET state = 'settled', result_json = ?, result_ref = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE command_id = ?
      `).run(JSON.stringify(storedResult), resultRef, now, commandId)
      this.releaseSession(receipt.session_id, now, true)
      this.appendEvent(receipt.session_id, 'turn.settled', {
        commandId,
        turnId: receipt.turn_id,
        stopReason: result.stopReason,
        resultRef,
      }, now)
      return this.inspectTurn(receipt.turn_id)
    })
  }

  /**
   * Settle one product or infrastructure failure after caller-side diagnostic redaction.
   * @param commandId - admitted durable command identity.
   * @param code - stable failure code.
   * @param message - bounded redacted diagnostic.
   * @param stopReason - provider-neutral terminal reason.
   * @returns durable failed receipt projection.
   */
  fail(commandId: string, code: string, message: string, stopReason: ResidentStopReason = 'error'): TurnInspection {
    return this.transaction(() => {
      const receipt = this.requireReceipt(commandId)
      if (receipt.state === 'settled') return this.inspectTurn(receipt.turn_id)
      const now = new Date().toISOString()
      const result: ResidentTurnResult = { output: [], stopReason }
      this.db.prepare(`
        UPDATE command_receipts
        SET state = 'settled', result_json = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE command_id = ?
      `).run(JSON.stringify(result), code, message, now, commandId)
      // A caller-requested interrupt is a settled turn outcome, not evidence
      // that the native runtime crashed or became unavailable.
      this.releaseSession(receipt.session_id, now, stopReason === 'aborted')
      this.appendEvent(receipt.session_id, 'turn.failed', {
        commandId,
        turnId: receipt.turn_id,
        code,
        message,
      }, now)
      return this.inspectTurn(receipt.turn_id)
    })
  }

  /**
   * Read one receipt by turn identity.
   * @param turnId - daemon-generated turn identity.
   * @returns current receipt projection.
   */
  inspectTurn(turnId: string): TurnInspection {
    const receipt = this.db.prepare('SELECT * FROM command_receipts WHERE turn_id = ?')
      .get(turnId) as unknown as ReceiptRow | undefined
    if (receipt === undefined) {
      throw new ResidentOperatorError(`unknown resident turn ${turnId}`, 'SESSION_UNAVAILABLE')
    }
    const accepted = this.acceptedFrom(receipt)
    const result = receipt.result_json === null
      ? undefined
      : JSON.parse(receipt.result_json) as ResidentTurnResult
    const error = receipt.error_code === null
      ? undefined
      : { code: receipt.error_code, message: receipt.error_message ?? receipt.error_code }
    return { ...accepted, ...result === undefined ? {} : { result }, ...error === undefined ? {} : { error } }
  }

  /**
   * Reject an interrupt whose turn does not belong to the claimed Session.
   * @param turnId - turn identity to validate.
   * @param sessionId - claimed owning Session identity.
   */
  assertTurnSession(turnId: string, sessionId: string): void {
    const turn = this.inspectTurn(turnId)
    if (turn.sessionId !== sessionId) {
      throw new ResidentOperatorError(
        `resident turn ${turnId} does not belong to session ${sessionId}`,
        'SESSION_UNAVAILABLE',
      )
    }
  }

  /**
   * List all current Resident Sessions.
   * @returns Session snapshots ordered by recency.
   */
  list(): ResidentSessionSnapshot[] {
    const rows = this.db.prepare('SELECT * FROM resident_sessions ORDER BY updated_at DESC, id').all() as unknown as SessionRow[]
    return rows.map(row => this.snapshot(row))
  }

  /**
   * Read one Session projection.
   * @param id - opaque Session identity.
   * @returns current lifecycle, health, revision, and native association.
   */
  inspectSession(id: string): ResidentSessionSnapshot {
    return this.snapshot(this.sessionRow(id))
  }

  /**
   * Read a bounded event page for read-only observation.
   * @param sessionId - owning Session identity.
   * @param afterSequence - exclusive sequence cursor.
   * @param limit - maximum event count from one through one thousand.
   * @returns ordered events and next cursor.
   */
  readEvents(sessionId: string, afterSequence = 0, limit = 100): ResidentEventPage {
    this.sessionRow(sessionId)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new ResidentOperatorError('event cursor must be a non-negative safe integer', 'INVALID_RESULT')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new ResidentOperatorError('event limit must be between 1 and 1000', 'INVALID_RESULT')
    }
    const rows = this.db.prepare(`
      SELECT sequence, session_id, type, time, data_json FROM resident_events
      WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
    `).all(sessionId, afterSequence, limit) as unknown as Array<{
      sequence: number
      session_id: string
      type: string
      time: string
      data_json: string
    }>
    return {
      events: rows.map(row => ({
        sequence: row.sequence,
        sessionId: ResidentOperatorSessionId(row.session_id),
        type: row.type,
        time: row.time,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
      })),
      nextSequence: rows.at(-1)?.sequence ?? afterSequence,
    }
  }

  /**
   * Replace an idle Session's native association under optimistic concurrency.
   * @param sessionId - Session to reset.
   * @param expectedRevision - exact inspected revision.
   * @param reason - bounded audit reason.
   * @returns revised Session projection.
   */
  reset(sessionId: string, expectedRevision: number, reason: string): ResidentSessionSnapshot {
    return this.transaction(() => {
      const row = this.sessionRow(sessionId)
      if (row.revision !== expectedRevision) {
        throw new ResidentOperatorError(
          `resident session revision is ${row.revision}, not ${expectedRevision}`,
          'REVISION_CONFLICT',
        )
      }
      if (row.active_turn_id !== null || row.lifecycle !== 'idle') {
        throw new ResidentOperatorError(`resident session ${sessionId} is not idle`, 'SESSION_BUSY')
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE resident_sessions SET native_session_id = NULL, health = 'ok', health_reason = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, sessionId)
      this.appendEvent(sessionId, 'session.reset', { reason }, now)
      return this.inspectSession(sessionId)
    })
  }

  /**
   * Explicitly abandon one indeterminate command under optimistic concurrency.
   * @param commandId - indeterminate command identity.
   * @param expectedRevision - exact owning Session revision.
   */
  resolveIndeterminate(commandId: string, expectedRevision: number): void {
    this.transaction(() => {
      const receipt = this.requireReceipt(commandId)
      if (receipt.state !== 'indeterminate') {
        throw new ResidentOperatorError(`command ${commandId} is not indeterminate`, 'COMMAND_CONFLICT')
      }
      const session = this.sessionRow(receipt.session_id)
      if (session.revision !== expectedRevision) {
        throw new ResidentOperatorError(
          `resident session revision is ${session.revision}, not ${expectedRevision}`,
          'REVISION_CONFLICT',
        )
      }
      const now = new Date().toISOString()
      this.db.prepare(
        "UPDATE command_receipts SET resolution = 'abandon', updated_at = ? WHERE command_id = ?",
      ).run(now, commandId)
      this.db.prepare(`
        UPDATE resident_sessions SET health = 'ok', health_reason = NULL, revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, receipt.session_id)
      this.appendEvent(receipt.session_id, 'turn.indeterminate_resolved', {
        commandId,
        decision: 'abandon',
      }, now)
    })
  }

  /**
   * Resolve the product-native continuation identity for one Session.
   * @param sessionId - daemon Session identity.
   * @returns native product identity when a turn has established one.
   */
  nativeSessionId(sessionId: string): string | undefined {
    return this.sessionRow(sessionId).native_session_id ?? undefined
  }

  private releaseSession(sessionId: string, now: string, runtimeHealthy: boolean): void {
    this.db.prepare('DELETE FROM session_leases WHERE session_id = ?').run(sessionId)
    this.db.prepare(`
      UPDATE resident_sessions
      SET lifecycle = 'idle', health = ?, health_reason = ?, active_turn_id = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?
    `).run(runtimeHealthy ? 'ok' : 'degraded', runtimeHealthy ? null : 'process_crashed', now, sessionId)
  }

  private acceptedFrom(receipt: ReceiptRow): AcceptedTurn {
    return {
      sessionId: receipt.session_id,
      turnId: receipt.turn_id,
      stateRevision: this.sessionRow(receipt.session_id).revision,
      state: receipt.state,
    }
  }

  private receiptByCommand(commandId: string): ReceiptRow | undefined {
    return this.db.prepare('SELECT * FROM command_receipts WHERE command_id = ?')
      .get(commandId) as unknown as ReceiptRow | undefined
  }

  private requireReceipt(commandId: string): ReceiptRow {
    const row = this.receiptByCommand(commandId)
    if (row === undefined) {
      throw new ResidentOperatorError(`unknown resident command ${commandId}`, 'SESSION_UNAVAILABLE')
    }
    return row
  }

  private sessionRow(id: string): SessionRow {
    const row = this.db.prepare('SELECT * FROM resident_sessions WHERE id = ?').get(id) as unknown as SessionRow | undefined
    if (row === undefined) {
      throw new ResidentOperatorError(`unknown resident session ${id}`, 'SESSION_UNAVAILABLE')
    }
    return row
  }

  private snapshot(row: SessionRow): ResidentSessionSnapshot {
    return {
      sessionId: ResidentOperatorSessionId(row.id),
      operatorId: row.operator_id,
      workspace: row.workspace,
      lifecycle: row.lifecycle as ResidentSessionSnapshot['lifecycle'],
      health: row.health as ResidentSessionSnapshot['health'],
      ...row.health_reason === null ? {} : { healthReason: row.health_reason as NonNullable<ResidentSessionSnapshot['healthReason']> },
      control: 'automation',
      stateRevision: row.revision,
      ...row.native_session_id === null ? {} : { nativeSessionId: row.native_session_id },
      ...row.active_turn_id === null ? {} : { activeTurnId: ResidentOperatorTurnId(row.active_turn_id) },
      updatedAt: row.updated_at,
    }
  }

  private appendEvent(sessionId: string, type: string, data: Record<string, unknown>, time: string): void {
    this.db.prepare(
      'INSERT INTO resident_events (session_id, type, time, data_json) VALUES (?, ?, ?, ?)',
    ).run(sessionId, type, time, JSON.stringify(data))
  }

  private writeArtifact(encoded: string, now: string): string {
    const digest = createHash('sha256').update(encoded).digest('hex')
    const target = join(this.artifactRoot, digest)
    if (!existsSync(target)) {
      const temporary = `${target}.${randomUUID()}.tmp`
      writeFileSync(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        renameSync(temporary, target)
      } catch (error) {
        if (!existsSync(target)) throw error
      }
    }
    this.db.prepare('INSERT OR IGNORE INTO artifact_refs (digest, byte_length, created_at) VALUES (?, ?, ?)')
      .run(digest, Buffer.byteLength(encoded), now)
    return `sha256:${digest}`
  }

  /**
   * Test-only read proving content addressing without exposing it on the control API.
   * @param ref - validated `sha256:` artifact reference.
   * @returns exact stored UTF-8 result bytes.
   */
  readArtifact(ref: string): string {
    const digest = ref.startsWith('sha256:') ? ref.slice(7) : ''
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new ResidentOperatorError('invalid resident artifact reference', 'INVALID_RESULT')
    }
    return readFileSync(join(this.artifactRoot, digest), 'utf8')
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = operation()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
