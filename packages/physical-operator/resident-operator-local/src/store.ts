/** SQLite single-writer state, receipts, leases, events, and artifacts. @module @deepseek-ai/dsh-resident-operator-local/store */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PhysicalOperatorModelToolBridgeV1,
  PhysicalOperatorNativeToolPolicy,
} from '@deepseek-ai/dsh-physical-operator'
import {
  ResidentOperatorError,
  ResidentOperatorCommandId,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  RESIDENT_STATE_SCHEMA_VERSION,
  type ResidentEventPage,
  type ResidentCompactResult,
  type ResidentExecutionProfile,
  type ResidentExecutionProfileSource,
  type ResidentObservation,
  type ResidentProgressPhase,
  type ResidentReceiptState,
  type ResidentSessionSnapshot,
  type ResidentStopReason,
  type ResidentTurnResult,
  type ResidentTurnSnapshot,
  type ResidentTurnSummary,
} from '@deepseek-ai/dsh-resident-operator'

const MAX_INLINE_RESULT_BYTES = 64 * 1024
const MAX_OBSERVATION_PREVIEW_CHARS = 1_600
const MAX_OBSERVATION_NAME_CHARS = 160

/**
 * Bound trace text and remove the small set of credential-shaped values that
 * native products can echo in an otherwise public response. This store never
 * receives prompts, stderr, environment values, or complete tool results.
 */
function scrubObservationPreview(value: string): string {
  return value
    .replace(/\b((?:api[_-]?key|authorization|password|token|secret))\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, MAX_OBSERVATION_PREVIEW_CHARS)
}

function boundedObservationName(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .slice(0, MAX_OBSERVATION_NAME_CHARS)
}

/**
 * Normalize the public Resident observation union before durable persistence.
 * @param observation - public, already validated observation emitted by a native Resident driver.
 * @returns bounded and credential-scrubbed observation safe for durable persistence.
 */
export function normalizeResidentObservation(observation: ResidentObservation): ResidentObservation {
  switch (observation.kind) {
    case 'public-output':
      return { kind: observation.kind, preview: scrubObservationPreview(observation.preview) }
    case 'tool-started':
    case 'tool-completed':
      return { kind: observation.kind, toolName: boundedObservationName(observation.toolName) }
    case 'approval-required':
      return {
        kind: observation.kind,
        approvalKind: boundedObservationName(observation.approvalKind),
        ...observation.preview === undefined ? {} : { preview: scrubObservationPreview(observation.preview) },
      }
    case 'usage-updated':
      return observation
  }
}

interface SessionRow {
  id: string
  operator_id: string
  workspace: string
  lane_id: string
  lifecycle: string
  health: string
  health_reason: string | null
  revision: number
  native_session_id: string | null
  model_id: string | null
  reasoning_effort: string | null
  profile_source: string | null
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
  task_label: string | null
  native_turn_id: string | null
  result_json: string | null
  result_ref: string | null
  error_code: string | null
  error_message: string | null
  resolution: string | null
  updated_at: string
}

interface CompactReceiptRow {
  command_id: string
  request_hash: string
  session_id: string
  state: ResidentReceiptState
  result_json: string | null
  error_code: string | null
  error_message: string | null
  resolution: string | null
  updated_at: string
}

/** Durable receipt projection returned immediately after admission or replay. */
export interface AcceptedTurn {
  readonly sessionId: string
  readonly turnId: string
  readonly stateRevision: number
  readonly state: ResidentReceiptState
}

/** Durable compaction receipt projection returned for admission or replay. */
export interface AcceptedCompaction {
  readonly state: ResidentReceiptState
  readonly session: ResidentSessionSnapshot
  readonly nativeSessionId: string
  readonly result?: ResidentCompactResult
}

/** Receipt projection enriched with settled result or coded failure. */
export type TurnInspection = ResidentTurnSnapshot

/**
 * Hash the behaviorally relevant command request independently of its identity.
 * @param operatorId - selected native product Driver.
 * @param workspace - canonical realpath workspace.
 * @param prompt - validated text content blocks.
 * @param profile - daemon-resolved model and reasoning profile.
 * @param supersedesCommandId - optional explicitly abandoned receipt lineage.
 * @param laneId - caller-owned native-context isolation lane.
 * @param modelToolBridge - optional sealed RLM model-tool bridge.
 * @param systemPrompt - optional DSH-owned system instructions.
 * @param nativeToolPolicy - sealed native product tool authority.
 * @returns lowercase SHA-256 digest.
 */
export function canonicalRequestHash(
  operatorId: string,
  workspace: string,
  prompt: readonly ContentBlock[],
  profile: ResidentExecutionProfile,
  supersedesCommandId?: string,
  laneId = 'legacy',
  modelToolBridge?: PhysicalOperatorModelToolBridgeV1,
  systemPrompt?: string,
  nativeToolPolicy: PhysicalOperatorNativeToolPolicy = 'inherit',
): string {
  return createHash('sha256')
    .update(JSON.stringify({
      operatorId,
      workspace,
      laneId,
      prompt,
      systemPrompt: systemPrompt ?? null,
      profile,
      supersedesCommandId: supersedesCommandId ?? null,
      modelToolBridge: modelToolBridge === undefined ? null : {
        version: modelToolBridge.version,
        sessionId: modelToolBridge.sessionId,
        tools: modelToolBridge.tools,
      },
      nativeToolPolicy,
    }))
    .digest('hex')
}

/**
 * Hash one native compaction request independently of its durable command identity.
 * @param sessionId - Resident Session whose native history will be compacted.
 * @param expectedStateRevision - exact revision inspected by the caller.
 * @param instructions - optional native compaction guidance.
 * @returns lowercase SHA-256 digest.
 */
export function canonicalCompactRequestHash(
  sessionId: string,
  expectedStateRevision: number,
  instructions?: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ sessionId, expectedStateRevision, instructions: instructions ?? null }))
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

  /**
   * Read an existing Session's locked profile without creating or mutating state.
   * @param operatorId - stable native product identity.
   * @param workspace - canonical realpath workspace.
   * @param laneId - caller-owned native-context isolation lane.
   * @returns the locked profile and provenance, or undefined before first admission.
   */
  lockedProfile(operatorId: string, workspace: string, laneId = 'legacy'): {
    readonly profile: ResidentExecutionProfile
    readonly source: ResidentExecutionProfileSource
  } | undefined {
    const row = this.db.prepare(
      'SELECT * FROM resident_sessions WHERE operator_id = ? AND workspace = ? AND lane_id = ?',
    ).get(operatorId, workspace, laneId) as unknown as SessionRow | undefined
    if (row?.model_id === null || row?.model_id === undefined) return undefined
    return {
      profile: {
        model: row.model_id,
        ...row.reasoning_effort === null ? {} : {
          effort: row.reasoning_effort as NonNullable<ResidentExecutionProfile['effort']>,
        },
      },
      source: (row.profile_source ?? 'smart-auto') as ResidentExecutionProfileSource,
    }
  }

  private configure(): void {
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== RESIDENT_STATE_SCHEMA_VERSION) {
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
        lane_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        health TEXT NOT NULL,
        health_reason TEXT,
        revision INTEGER NOT NULL,
        native_session_id TEXT,
        model_id TEXT,
        reasoning_effort TEXT,
        profile_source TEXT,
        active_turn_id TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(operator_id, workspace, lane_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS command_receipts (
        command_id TEXT PRIMARY KEY,
        supersedes_command_id TEXT UNIQUE REFERENCES command_receipts(command_id),
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        turn_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        task_label TEXT,
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
    `)
    if (version === 1) {
      this.db.exec(`
        ALTER TABLE resident_sessions ADD COLUMN model_id TEXT;
        ALTER TABLE resident_sessions ADD COLUMN reasoning_effort TEXT;
        ALTER TABLE resident_sessions ADD COLUMN profile_source TEXT;
      `)
    }
    if (version === 1 || version === 2) {
      this.db.exec('ALTER TABLE command_receipts ADD COLUMN task_label TEXT;')
    }
    if (version >= 1 && version <= 3) this.migrateLaneSchema()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_compaction_receipts (
        command_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        state TEXT NOT NULL,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `)
    this.db.exec(`PRAGMA user_version = ${RESIDENT_STATE_SCHEMA_VERSION};`)
  }

  /** Rebuild Session-owned tables so one workspace can host independent concurrent lanes. */
  private migrateLaneSchema(): void {
    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN IMMEDIATE;
      ALTER TABLE command_receipts RENAME TO command_receipts_v3;
      ALTER TABLE session_leases RENAME TO session_leases_v3;
      ALTER TABLE resident_events RENAME TO resident_events_v3;
      ALTER TABLE resident_sessions RENAME TO resident_sessions_v3;
      CREATE TABLE resident_sessions (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        health TEXT NOT NULL,
        health_reason TEXT,
        revision INTEGER NOT NULL,
        native_session_id TEXT,
        model_id TEXT,
        reasoning_effort TEXT,
        profile_source TEXT,
        active_turn_id TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(operator_id, workspace, lane_id)
      ) STRICT;
      INSERT INTO resident_sessions
        (id, operator_id, workspace, lane_id, lifecycle, health, health_reason, revision,
         native_session_id, model_id, reasoning_effort, profile_source, active_turn_id, updated_at)
      SELECT id, operator_id, workspace, 'legacy', lifecycle, health, health_reason, revision,
        native_session_id, model_id, reasoning_effort, profile_source, active_turn_id, updated_at
      FROM resident_sessions_v3;
      CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY,
        supersedes_command_id TEXT UNIQUE REFERENCES command_receipts(command_id),
        request_hash TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        turn_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        task_label TEXT,
        native_turn_id TEXT,
        result_json TEXT,
        result_ref TEXT,
        error_code TEXT,
        error_message TEXT,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO command_receipts
        (command_id, supersedes_command_id, request_hash, session_id, turn_id, state, task_label,
         native_turn_id, result_json, result_ref, error_code, error_message, resolution, created_at, updated_at)
      SELECT command_id, supersedes_command_id, request_hash, session_id, turn_id, state, task_label,
        native_turn_id, result_json, result_ref, error_code, error_message, resolution, created_at, updated_at
      FROM command_receipts_v3;
      CREATE TABLE session_leases (
        session_id TEXT PRIMARY KEY REFERENCES resident_sessions(id),
        turn_id TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL,
        heartbeat_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO session_leases SELECT * FROM session_leases_v3;
      CREATE TABLE resident_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        type TEXT NOT NULL,
        time TEXT NOT NULL,
        data_json TEXT NOT NULL
      ) STRICT;
      INSERT INTO resident_events SELECT * FROM resident_events_v3;
      DROP TABLE resident_events_v3;
      DROP TABLE session_leases_v3;
      DROP TABLE command_receipts_v3;
      DROP TABLE resident_sessions_v3;
      COMMIT;
      PRAGMA foreign_keys = ON;
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
      const interruptedCompactions = this.db.prepare(
        "SELECT command_id, session_id FROM session_compaction_receipts WHERE state IN ('accepted', 'running')",
      ).all() as unknown as Array<{ command_id: string; session_id: string }>
      for (const row of interruptedCompactions) {
        this.db.prepare(`
          UPDATE session_compaction_receipts
          SET state = 'indeterminate', error_code = 'COMMAND_INDETERMINATE', error_message = ?, updated_at = ?
          WHERE command_id = ?
        `).run('daemon stopped before native compaction settlement; automatic replay is forbidden', now, row.command_id)
        this.db.prepare(`
          UPDATE resident_sessions SET lifecycle = 'idle', health = 'degraded', health_reason = 'process_crashed',
            revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(now, row.session_id)
        this.appendEvent(row.session_id, 'session.compaction_indeterminate', {
          commandId: row.command_id,
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
 * @param profile - fully resolved execution profile to lock or validate.
   * @param profileSource - whether automatic or explicit selection produced the profile.
 * @param supersedesCommandId - optional uniquely linked abandoned indeterminate command.
 * @param taskLabel - bounded display-only summary, never the raw prompt.
 * @param laneId - caller-owned native-context isolation lane.
   * @returns accepted or existing receipt projection.
   */
  accept(
    commandId: string,
    requestHash: string,
    operatorId: string,
    workspace: string,
    profile: ResidentExecutionProfile,
    profileSource: ResidentExecutionProfileSource,
    supersedesCommandId?: string,
    taskLabel?: string,
    laneId = 'legacy',
  ): AcceptedTurn {
    return this.transaction(() => {
      if (this.compactReceiptByCommand(commandId) !== undefined) {
        throw new ResidentOperatorError(`command ${commandId} belongs to a Session compaction`, 'COMMAND_CONFLICT')
      }
      const existing = this.receiptByCommand(commandId)
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          throw new ResidentOperatorError(
            `command ${commandId} was already accepted with different content`,
            'COMMAND_CONFLICT',
          )
        }
        if (existing.task_label === null && taskLabel !== undefined) {
          this.db.prepare('UPDATE command_receipts SET task_label = ? WHERE command_id = ?').run(taskLabel, commandId)
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
        if (priorSession.operator_id !== operatorId || priorSession.workspace !== workspace || priorSession.lane_id !== laneId) {
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
        'SELECT * FROM resident_sessions WHERE operator_id = ? AND workspace = ? AND lane_id = ?',
      ).get(operatorId, workspace, laneId) as unknown as SessionRow | undefined
      if (session === undefined) {
        const id = randomUUID()
        this.db.prepare(`
          INSERT INTO resident_sessions
            (id, operator_id, workspace, lane_id, lifecycle, health, health_reason, revision, native_session_id,
             model_id, reasoning_effort, profile_source, active_turn_id, updated_at)
          VALUES (?, ?, ?, ?, 'idle', 'ok', NULL, 0, NULL, ?, ?, ?, NULL, ?)
        `).run(id, operatorId, workspace, laneId, profile.model, profile.effort ?? null, profileSource, now)
        session = this.sessionRow(id)
        this.appendEvent(id, 'session.created', { operatorId, laneId, profile, profileSource }, now)
      } else if (session.model_id === null) {
        this.db.prepare(`
          UPDATE resident_sessions SET model_id = ?, reasoning_effort = ?, profile_source = ?,
            revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(profile.model, profile.effort ?? null, profileSource, now, session.id)
        this.appendEvent(session.id, 'session.profile_locked', { profile, profileSource }, now)
        session = this.sessionRow(session.id)
      } else if (session.model_id !== profile.model || (session.reasoning_effort ?? undefined) !== profile.effort) {
        throw new ResidentOperatorError(
          `resident session ${session.id} is locked to ${session.model_id}/${session.reasoning_effort ?? 'default'}`,
          'EXECUTION_PROFILE_CONFLICT',
        )
      }
      if (session.active_turn_id !== null || session.lifecycle !== 'idle') {
        throw new ResidentOperatorError(
          session.active_turn_id === null
            ? `resident session ${session.id} is ${session.lifecycle}`
            : `resident session ${session.id} already has active turn ${session.active_turn_id}`,
          'SESSION_BUSY',
        )
      }

      const turnId = randomUUID()
      this.db.prepare(`
        INSERT INTO command_receipts
          (command_id, supersedes_command_id, request_hash, session_id, turn_id, state, task_label, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'accepted', ?, ?, ?)
      `).run(commandId, supersedesCommandId ?? null, requestHash, session.id, turnId, taskLabel ?? null, now, now)
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
        taskLabel: taskLabel ?? null,
        profile,
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
   * Append one bounded product-neutral progress event for reconnecting observers.
   * @param commandId - admitted durable command identity.
   * @param phase - stable progress phase with no prompt or transcript content.
   */
  progress(commandId: string, phase: ResidentProgressPhase): void {
    const receipt = this.requireReceipt(commandId)
    if (receipt.state !== 'accepted' && receipt.state !== 'running') return
    const now = new Date().toISOString()
    this.db.prepare('UPDATE session_leases SET heartbeat_at = ? WHERE session_id = ?').run(now, receipt.session_id)
    this.appendEvent(receipt.session_id, 'turn.progress', {
      commandId,
      turnId: receipt.turn_id,
      phase,
    }, now)
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
          ...result.usage === undefined ? {} : { usage: result.usage },
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
        ...result.usage === undefined ? {} : {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          ...result.usage.cacheReadInputTokens === undefined
            ? {}
            : { cacheReadInputTokens: result.usage.cacheReadInputTokens },
          ...result.usage.cacheWriteInputTokens === undefined
            ? {}
            : { cacheWriteInputTokens: result.usage.cacheWriteInputTokens },
          ...result.usage.costUsd === undefined ? {} : { costUsd: result.usage.costUsd },
        },
        resultRef,
      }, now)
      return this.inspectTurn(receipt.turn_id)
    })
  }

  /**
   * Append one trace-safe native product observation to the existing durable
   * event stream. Sequence and time are assigned by this single writer so a
   * reconnecting client can resume with its existing event cursor.
   * @param commandId - admitted durable command identity.
   * @param observation - provider-neutral, bounded observation payload.
   */
  observe(commandId: string, observation: ResidentObservation): void {
    const receipt = this.requireReceipt(commandId)
    if (receipt.state !== 'accepted' && receipt.state !== 'running') return
    const now = new Date().toISOString()
    const normalized = normalizeResidentObservation(observation)
    this.db.prepare('UPDATE session_leases SET heartbeat_at = ? WHERE session_id = ?').run(now, receipt.session_id)
    this.appendEvent(receipt.session_id, 'turn.observation', {
      commandId,
      turnId: receipt.turn_id,
      ...normalized,
    }, now)
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
  inspectTurn(turnId: string): ResidentTurnSnapshot {
    const receipt = this.db.prepare('SELECT * FROM command_receipts WHERE turn_id = ?')
      .get(turnId) as unknown as ReceiptRow | undefined
    if (receipt === undefined) {
      throw new ResidentOperatorError(`unknown resident turn ${turnId}`, 'SESSION_UNAVAILABLE')
    }
    const session = this.sessionRow(receipt.session_id)
    const result = receipt.result_json === null
      ? undefined
      : JSON.parse(receipt.result_json) as ResidentTurnResult
    const error = receipt.error_code === null
      ? undefined
      : { code: receipt.error_code, message: receipt.error_message ?? receipt.error_code }
    const parsedStopReason = result?.stopReason
    return {
      commandId: ResidentOperatorCommandId(receipt.command_id),
      turnId: ResidentOperatorTurnId(receipt.turn_id),
      sessionId: ResidentOperatorSessionId(receipt.session_id),
      stateRevision: session.revision,
      state: receipt.state,
      ...receipt.task_label === null ? {} : { taskLabel: receipt.task_label },
      ...receipt.native_turn_id === null ? {} : { nativeTurnId: receipt.native_turn_id },
      ...parsedStopReason === undefined ? {} : { stopReason: parsedStopReason },
      ...receipt.result_ref === null ? {} : { resultRef: receipt.result_ref },
      updatedAt: receipt.updated_at,
      ...result === undefined ? {} : { result },
      ...error === undefined ? {} : { error },
    }
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
      this.requireIdleRevision(sessionId, expectedRevision)
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE resident_sessions SET native_session_id = NULL, model_id = NULL, reasoning_effort = NULL,
          profile_source = NULL, health = 'ok', health_reason = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, sessionId)
      this.appendEvent(sessionId, 'session.reset', { reason }, now)
      return this.inspectSession(sessionId)
    })
  }

  /**
   * Fence one idle Session while its native product compacts history.
   * @param commandId - durable compaction command identity.
   * @param requestHash - canonical hash used for conflict detection.
   * @param sessionId - Session whose native history will be compacted.
   * @param expectedRevision - exact inspected revision.
   * @returns the fenced draining Session snapshot.
   */
  acceptCompaction(
    commandId: string,
    requestHash: string,
    sessionId: string,
    expectedRevision: number,
  ): AcceptedCompaction {
    return this.transaction(() => {
      if (this.receiptByCommand(commandId) !== undefined) {
        throw new ResidentOperatorError(`command ${commandId} belongs to a Resident turn`, 'COMMAND_CONFLICT')
      }
      const existing = this.compactReceiptByCommand(commandId)
      if (existing !== undefined) {
        if (existing.request_hash !== requestHash) {
          throw new ResidentOperatorError(
            `command ${commandId} was already accepted with different compaction content`,
            'COMMAND_CONFLICT',
          )
        }
        if (existing.state === 'indeterminate') {
          throw new ResidentOperatorError(
            existing.error_message ?? `Session compaction ${commandId} is indeterminate`,
            'COMMAND_INDETERMINATE',
          )
        }
        if (existing.state === 'settled' && existing.error_code !== null) {
          throw new ResidentOperatorError(existing.error_message ?? existing.error_code, existing.error_code)
        }
        const session = this.inspectSession(existing.session_id)
        const nativeSessionId = session.nativeSessionId
        if (nativeSessionId === undefined) {
          throw new ResidentOperatorError(`resident session ${existing.session_id} lost its native identity`, 'SESSION_UNAVAILABLE')
        }
        return {
          state: existing.state,
          session,
          nativeSessionId,
          ...existing.result_json === null ? {} : {
            result: JSON.parse(existing.result_json) as ResidentCompactResult,
          },
        }
      }
      const row = this.requireIdleRevision(sessionId, expectedRevision)
      if (row.native_session_id === null) {
        throw new ResidentOperatorError(`resident session ${sessionId} has no native history to compact`, 'SESSION_UNAVAILABLE')
      }
      const unresolved = this.db.prepare(`
        SELECT command_id FROM session_compaction_receipts
        WHERE session_id = ? AND state = 'indeterminate' AND resolution IS NULL LIMIT 1
      `).get(sessionId) as { command_id: string } | undefined
      if (unresolved !== undefined) {
        throw new ResidentOperatorError(
          `Session compaction ${unresolved.command_id} is indeterminate and requires explicit resolution`,
          'COMMAND_INDETERMINATE',
        )
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        INSERT INTO session_compaction_receipts
          (command_id, request_hash, session_id, state, created_at, updated_at)
        VALUES (?, ?, ?, 'accepted', ?, ?)
      `).run(commandId, requestHash, sessionId, now, now)
      this.db.prepare(`
        UPDATE resident_sessions SET lifecycle = 'draining', revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, sessionId)
      const session = this.inspectSession(sessionId)
      return { state: 'accepted', session, nativeSessionId: row.native_session_id }
    })
  }

  /**
   * Mark a durably accepted native compaction immediately before product dispatch.
   * @param commandId - durable compaction command identity.
   */
  markCompactionRunning(commandId: string): void {
    const receipt = this.requireCompactReceipt(commandId)
    if (receipt.state !== 'accepted' && receipt.state !== 'running') return
    this.db.prepare(`
      UPDATE session_compaction_receipts SET state = 'running', updated_at = ? WHERE command_id = ?
    `).run(new Date().toISOString(), commandId)
  }

  /**
   * Commit successful native compaction while retaining the same native identity.
   * @param commandId - durable compaction command identity.
   * @param sessionId - fenced Session identity.
   * @param nativeSessionId - native identity returned by the product Driver.
   * @param instructionsProvided - whether product-native guidance was supplied, without persisting its text.
   * @returns the revised idle Session snapshot.
   */
  completeCompaction(
    commandId: string,
    sessionId: string,
    nativeSessionId: string,
    instructionsProvided: boolean,
  ): ResidentCompactResult {
    return this.transaction(() => {
      const row = this.sessionRow(sessionId)
      const receipt = this.requireCompactReceipt(commandId)
      if (receipt.session_id !== sessionId) {
        throw new ResidentOperatorError(`compaction ${commandId} belongs to another Session`, 'COMMAND_CONFLICT')
      }
      if (row.lifecycle !== 'draining' || row.active_turn_id !== null) {
        throw new ResidentOperatorError(`resident session ${sessionId} is not compacting`, 'SESSION_BUSY')
      }
      if (row.native_session_id !== nativeSessionId) {
        throw new ResidentOperatorError('native compaction replaced the Resident Session identity', 'INVALID_RESULT')
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE resident_sessions SET lifecycle = 'idle', health = 'ok', health_reason = NULL,
          revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, sessionId)
      const result = { session: this.inspectSession(sessionId), nativeSessionId, compactedAt: now }
      this.db.prepare(`
        UPDATE session_compaction_receipts
        SET state = 'settled', result_json = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE command_id = ?
      `).run(JSON.stringify(result), now, commandId)
      this.appendEvent(sessionId, 'session.compacted', { commandId, instructionsProvided }, now)
      return result
    })
  }

  /**
   * Release a failed native compaction fence without replacing Session history.
   * @param commandId - durable compaction command identity.
   * @param code - stable native failure code.
   * @param message - bounded native failure explanation.
   * @returns the revised idle Session snapshot.
   */
  failCompaction(commandId: string, code: string, message: string): ResidentSessionSnapshot {
    return this.transaction(() => {
      const receipt = this.requireCompactReceipt(commandId)
      const sessionId = receipt.session_id
      const row = this.sessionRow(sessionId)
      if (row.lifecycle !== 'draining' || row.active_turn_id !== null) {
        throw new ResidentOperatorError(`resident session ${sessionId} is not compacting`, 'SESSION_BUSY')
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE resident_sessions SET lifecycle = 'idle', revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, sessionId)
      this.db.prepare(`
        UPDATE session_compaction_receipts
        SET state = 'settled', error_code = ?, error_message = ?, updated_at = ? WHERE command_id = ?
      `).run(code, message, now, commandId)
      this.appendEvent(sessionId, 'session.compaction_failed', { commandId, code }, now)
      return this.inspectSession(sessionId)
    })
  }

  /**
   * Fence an externally ambiguous native compaction outcome against automatic replay.
   * @param commandId - durable compaction command identity.
   * @param message - bounded diagnostic that does not contain compaction instructions.
   * @returns the degraded idle Session awaiting explicit resolution.
   */
  markCompactionIndeterminate(commandId: string, message: string): ResidentSessionSnapshot {
    return this.transaction(() => {
      const receipt = this.requireCompactReceipt(commandId)
      if (receipt.state === 'indeterminate') return this.inspectSession(receipt.session_id)
      if (receipt.state === 'settled') {
        throw new ResidentOperatorError(`Session compaction ${commandId} is already settled`, 'COMMAND_CONFLICT')
      }
      const now = new Date().toISOString()
      this.db.prepare(`
        UPDATE session_compaction_receipts
        SET state = 'indeterminate', error_code = 'COMMAND_INDETERMINATE', error_message = ?, updated_at = ?
        WHERE command_id = ?
      `).run(message, now, commandId)
      this.db.prepare(`
        UPDATE resident_sessions SET lifecycle = 'idle', health = 'degraded', health_reason = 'process_crashed',
          revision = revision + 1, updated_at = ? WHERE id = ?
      `).run(now, receipt.session_id)
      this.appendEvent(receipt.session_id, 'session.compaction_indeterminate', {
        commandId,
        reason: 'native_outcome_unproven',
      }, now)
      return this.inspectSession(receipt.session_id)
    })
  }

  /**
   * Explicitly abandon one indeterminate command under optimistic concurrency.
   * @param commandId - indeterminate command identity.
   * @param expectedRevision - exact owning Session revision.
   */
  resolveIndeterminate(commandId: string, expectedRevision: number): void {
    this.transaction(() => {
      const compact = this.compactReceiptByCommand(commandId)
      if (compact !== undefined) {
        if (compact.state !== 'indeterminate') {
          throw new ResidentOperatorError(`command ${commandId} is not indeterminate`, 'COMMAND_CONFLICT')
        }
        const session = this.sessionRow(compact.session_id)
        if (session.revision !== expectedRevision) {
          throw new ResidentOperatorError(
            `resident session revision is ${session.revision}, not ${expectedRevision}`,
            'REVISION_CONFLICT',
          )
        }
        const now = new Date().toISOString()
        this.db.prepare(`
          UPDATE session_compaction_receipts SET resolution = 'abandon', updated_at = ? WHERE command_id = ?
        `).run(now, commandId)
        this.db.prepare(`
          UPDATE resident_sessions SET health = 'ok', health_reason = NULL, revision = revision + 1, updated_at = ? WHERE id = ?
        `).run(now, compact.session_id)
        this.appendEvent(compact.session_id, 'session.compaction_indeterminate_resolved', {
          commandId,
          decision: 'abandon',
        }, now)
        return
      }
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
      ...receipt.task_label === null ? {} : { taskLabel: receipt.task_label },
    }
  }

  private receiptByCommand(commandId: string): ReceiptRow | undefined {
    return this.db.prepare('SELECT * FROM command_receipts WHERE command_id = ?')
      .get(commandId) as unknown as ReceiptRow | undefined
  }

  private compactReceiptByCommand(commandId: string): CompactReceiptRow | undefined {
    return this.db.prepare('SELECT * FROM session_compaction_receipts WHERE command_id = ?')
      .get(commandId) as unknown as CompactReceiptRow | undefined
  }

  private requireCompactReceipt(commandId: string): CompactReceiptRow {
    const receipt = this.compactReceiptByCommand(commandId)
    if (receipt === undefined) {
      throw new ResidentOperatorError(`unknown Session compaction ${commandId}`, 'SESSION_UNAVAILABLE')
    }
    return receipt
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

  private requireIdleRevision(sessionId: string, expectedRevision: number): SessionRow {
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
    return row
  }

  private snapshot(row: SessionRow): ResidentSessionSnapshot {
    const latestTurn = this.latestTurn(row.id)
    const latestEvent = this.latestEvent(row.id)
    return {
      sessionId: ResidentOperatorSessionId(row.id),
      operatorId: row.operator_id,
      workspace: row.workspace,
      laneId: row.lane_id,
      lifecycle: row.lifecycle as ResidentSessionSnapshot['lifecycle'],
      health: row.health as ResidentSessionSnapshot['health'],
      ...row.health_reason === null ? {} : { healthReason: row.health_reason as NonNullable<ResidentSessionSnapshot['healthReason']> },
      control: 'automation',
      stateRevision: row.revision,
      ...row.native_session_id === null ? {} : { nativeSessionId: row.native_session_id },
      ...row.model_id === null ? {} : {
        executionProfile: {
          model: row.model_id,
          ...row.reasoning_effort === null ? {} : {
            effort: row.reasoning_effort as NonNullable<ResidentExecutionProfile['effort']>,
          },
        },
        executionProfileSource: (row.profile_source ?? 'smart-auto') as ResidentExecutionProfileSource,
      },
      ...row.active_turn_id === null ? {} : { activeTurnId: ResidentOperatorTurnId(row.active_turn_id) },
      ...latestTurn === undefined ? {} : { latestTurn },
      ...latestEvent === undefined ? {} : { latestEvent },
      updatedAt: row.updated_at,
    }
  }

  private latestTurn(sessionId: string): ResidentTurnSummary | undefined {
    const receipt = this.db.prepare(`
      SELECT * FROM command_receipts
      WHERE session_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(sessionId) as unknown as ReceiptRow | undefined
    if (receipt === undefined) return undefined
    const result = receipt.result_json === null
      ? undefined
      : JSON.parse(receipt.result_json) as ResidentTurnResult
    return {
      commandId: ResidentOperatorCommandId(receipt.command_id),
      turnId: ResidentOperatorTurnId(receipt.turn_id),
      state: receipt.state,
      ...receipt.task_label === null ? {} : { taskLabel: receipt.task_label },
      ...receipt.native_turn_id === null ? {} : { nativeTurnId: receipt.native_turn_id },
      ...result?.stopReason === undefined ? {} : { stopReason: result.stopReason },
      ...receipt.result_ref === null ? {} : { resultRef: receipt.result_ref },
      updatedAt: receipt.updated_at,
    }
  }

  private latestEvent(sessionId: string) {
    const row = this.db.prepare(`
      SELECT sequence, session_id, type, time, data_json FROM resident_events
      WHERE session_id = ? ORDER BY sequence DESC LIMIT 1
    `).get(sessionId) as {
      sequence: number
      session_id: string
      type: string
      time: string
      data_json: string
    } | undefined
    if (row === undefined) return undefined
    return {
      sequence: row.sequence,
      sessionId: ResidentOperatorSessionId(row.session_id),
      type: row.type,
      time: row.time,
      data: JSON.parse(row.data_json) as Record<string, unknown>,
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
