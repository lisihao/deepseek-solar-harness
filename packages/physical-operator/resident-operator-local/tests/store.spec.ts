import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalCompactRequestHash, canonicalRequestHash, ResidentStore } from '../src/store.ts'

const roots: string[] = []
const PROFILE = { model: 'test-model', effort: 'high' as const }
const PROFILE_SOURCE = 'manual' as const
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-resident-store-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('ResidentStore', () => {
  it('deduplicates one command and rejects conflicting content', () => {
    const store = new ResidentStore(root())
    const prompt = [{ type: 'text' as const, text: 'remember alpha' }]
    const hash = canonicalRequestHash('codex', '/workspace', prompt, PROFILE, undefined, 'legacy', undefined, 'system one')
    const first = store.accept('command-1', hash, 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    expect(store.accept('command-1', hash, 'codex', '/workspace', PROFILE, PROFILE_SOURCE)).toEqual(first)
    expect(() => store.accept(
      'command-1',
      canonicalRequestHash('codex', '/workspace', [{ type: 'text', text: 'different' }], PROFILE, undefined, 'legacy', undefined, 'system one'),
      'codex',
      '/workspace',
      PROFILE,
      PROFILE_SOURCE,
    )).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }))
    expect(() => store.accept(
      'command-1',
      canonicalRequestHash('codex', '/workspace', prompt, PROFILE, undefined, 'legacy', undefined, 'system two'),
      'codex',
      '/workspace',
      PROFILE,
      PROFILE_SOURCE,
    )).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }))
    store.close()
  })

  it('persists only a bounded task label for user-facing reconnect projections', () => {
    const store = new ResidentStore(root())
    const accepted = store.accept(
      'labeled-command', 'hash', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE, undefined, 'Review the runtime boundary',
    )
    expect(store.inspectTurn(accepted.turnId)).toMatchObject({ taskLabel: 'Review the runtime boundary' })
    expect(store.inspectSession(accepted.sessionId).latestTurn).toMatchObject({ taskLabel: 'Review the runtime boundary' })
    const event = store.readEvents(accepted.sessionId).events.find(value => value.type === 'turn.accepted')
    expect(event?.data.taskLabel).toBe('Review the runtime boundary')
    store.close()
  })

  it('holds one session lease, settles durably, and advances revisions', () => {
    const store = new ResidentStore(root())
    const first = store.accept('one', 'hash-one', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE)
    expect(() => store.accept('two', 'hash-two', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE))
      .toThrow(expect.objectContaining({ code: 'SESSION_BUSY' }))
    store.markRunning('one', 'native-session', 'native-turn')
    const settled = store.settle('one', {
      output: [{ type: 'text', text: 'done' }],
      stopReason: 'completed',
    })
    expect(settled).toMatchObject({ state: 'settled', result: { stopReason: 'completed' } })
    const snapshot = store.inspectSession(first.sessionId)
    expect(snapshot).toMatchObject({
      lifecycle: 'idle',
      health: 'ok',
      nativeSessionId: 'native-session',
    })
    expect(snapshot.stateRevision).toBeGreaterThan(first.stateRevision)
    expect(store.accept('two', 'hash-two', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE).sessionId).toBe(first.sessionId)
    store.close()
  })

  it('preserves absent optional usage buckets in the settled event', () => {
    const store = new ResidentStore(root())
    const accepted = store.accept('usage-unknown', 'usage-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    store.settle('usage-unknown', {
      output: [],
      stopReason: 'completed',
      usage: { inputTokens: 17, outputTokens: 9, costUsd: 0.42 },
    })

    const event = store.readEvents(accepted.sessionId).events.find(value => value.type === 'turn.settled')
    expect(event?.data).toMatchObject({
      commandId: 'usage-unknown',
      stopReason: 'completed',
      inputTokens: 17,
      outputTokens: 9,
      costUsd: 0.42,
    })
    expect(event?.data).not.toHaveProperty('cacheReadInputTokens')
    expect(event?.data).not.toHaveProperty('cacheWriteInputTokens')
    store.close()
  })

  it('orders bounded scrubbed observations across a Store restart and resumes by cursor', () => {
    const path = root()
    const first = new ResidentStore(path)
    const accepted = first.accept('trace-command', 'trace-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    first.markRunning('trace-command', 'thread-1', 'turn-1')
    first.observe('trace-command', { kind: 'public-output', preview: `visible API_KEY=secret ${'x'.repeat(2_000)}` })
    first.observe('trace-command', { kind: 'tool-started', toolName: 'Bash\u0000unsafe' })
    first.observe('trace-command', { kind: 'tool-completed', toolName: 'Bash' })
    const beforeRestart = first.readEvents(accepted.sessionId)
    const observations = beforeRestart.events.filter(event => event.type === 'turn.observation')
    expect(observations).toHaveLength(3)
    expect(observations.map(event => event.sequence)).toEqual([...observations.map(event => event.sequence)].sort((a, b) => a - b))
    expect(observations[0]?.data).toMatchObject({ commandId: 'trace-command', turnId: accepted.turnId, kind: 'public-output' })
    expect(observations[0]?.data.preview).toContain('API_KEY=[REDACTED]')
    expect(String(observations[0]?.data.preview).length).toBeLessThanOrEqual(1_600)
    expect(observations[1]?.data).toMatchObject({ kind: 'tool-started', toolName: 'Bashunsafe' })
    const cursor = observations[0]!.sequence
    first.close()

    const restarted = new ResidentStore(path)
    expect(restarted.readEvents(accepted.sessionId, cursor).events
      .filter(event => event.type === 'turn.observation')
      .map(event => event.data.kind))
      .toEqual(['tool-started', 'tool-completed'])
    restarted.close()
  })

  it('admits independent lanes concurrently while keeping each lane single-flight', () => {
    const store = new ResidentStore(root())
    const first = store.accept('lane-one', 'hash-one', 'codex', '/workspace', PROFILE, PROFILE_SOURCE, undefined, undefined, 'run:A')
    const second = store.accept('lane-two', 'hash-two', 'codex', '/workspace', PROFILE, PROFILE_SOURCE, undefined, undefined, 'run:B')
    expect(first.sessionId).not.toBe(second.sessionId)
    expect(store.inspectSession(first.sessionId)).toMatchObject({ laneId: 'run:A', lifecycle: 'running' })
    expect(store.inspectSession(second.sessionId)).toMatchObject({ laneId: 'run:B', lifecycle: 'running' })
    expect(() => store.accept(
      'lane-one-conflict', 'hash-three', 'codex', '/workspace', PROFILE, PROFILE_SOURCE, undefined, undefined, 'run:A',
    )).toThrow(expect.objectContaining({ code: 'SESSION_BUSY' }))
    store.close()
  })

  it('locks one effective profile per operator/workspace Session until reset', () => {
    const store = new ResidentStore(root())
    const first = store.accept('profile-one', 'hash-one', 'codex', '/workspace', PROFILE, 'smart-auto')
    store.markRunning('profile-one', 'thread')
    store.settle('profile-one', { output: [], stopReason: 'completed' })
    expect(store.inspectSession(first.sessionId)).toMatchObject({
      executionProfile: PROFILE,
      executionProfileSource: 'smart-auto',
    })
    expect(() => store.accept(
      'profile-two', 'hash-two', 'codex', '/workspace', { model: 'other', effort: 'low' }, 'manual',
    )).toThrow(expect.objectContaining({ code: 'EXECUTION_PROFILE_CONFLICT' }))
    const snapshot = store.inspectSession(first.sessionId)
    store.reset(first.sessionId, snapshot.stateRevision, 'change model')
    expect(store.accept(
      'profile-three', 'hash-three', 'codex', '/workspace', { model: 'other', effort: 'low' }, 'manual',
    ).sessionId).toBe(first.sessionId)
    store.close()
  })

  it('migrates a schema-v1 database additively and locks the next admitted profile', () => {
    const path = root()
    const bootstrap = new ResidentStore(path)
    bootstrap.close()
    const legacy = new DatabaseSync(join(path, 'state.sqlite'))
    legacy.exec(`
      ALTER TABLE resident_sessions DROP COLUMN model_id;
      ALTER TABLE resident_sessions DROP COLUMN reasoning_effort;
      ALTER TABLE resident_sessions DROP COLUMN profile_source;
      ALTER TABLE command_receipts DROP COLUMN task_label;
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new ResidentStore(path)
    const accepted = migrated.accept(
      'migrated-command', 'migrated-hash', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE,
    )
    expect(migrated.inspectSession(accepted.sessionId)).toMatchObject({
      executionProfile: PROFILE,
      executionProfileSource: PROFILE_SOURCE,
    })
    migrated.close()
  })

  it('migrates a schema-v2 database additively and records new task labels', () => {
    const path = root()
    const bootstrap = new ResidentStore(path)
    bootstrap.close()
    const legacy = new DatabaseSync(join(path, 'state.sqlite'))
    legacy.exec(`
      ALTER TABLE command_receipts DROP COLUMN task_label;
      PRAGMA user_version = 2;
    `)
    legacy.close()

    const migrated = new ResidentStore(path)
    const accepted = migrated.accept(
      'v2-command', 'v2-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE, undefined, 'Resume repository analysis',
    )
    expect(migrated.inspectTurn(accepted.turnId).taskLabel).toBe('Resume repository analysis')
    migrated.close()
  })

  it('migrates schema v3 sessions into the legacy lane without losing settled history', () => {
    const path = root()
    const bootstrap = new ResidentStore(path)
    bootstrap.close()
    const legacy = new DatabaseSync(join(path, 'state.sqlite'))
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE resident_events;
      DROP TABLE session_leases;
      DROP TABLE command_receipts;
      DROP TABLE resident_sessions;
      CREATE TABLE resident_sessions (
        id TEXT PRIMARY KEY, operator_id TEXT NOT NULL, workspace TEXT NOT NULL,
        lifecycle TEXT NOT NULL, health TEXT NOT NULL, health_reason TEXT,
        revision INTEGER NOT NULL, native_session_id TEXT, model_id TEXT,
        reasoning_effort TEXT, profile_source TEXT, active_turn_id TEXT,
        updated_at TEXT NOT NULL, UNIQUE(operator_id, workspace)
      ) STRICT;
      CREATE TABLE command_receipts (
        command_id TEXT PRIMARY KEY, supersedes_command_id TEXT UNIQUE REFERENCES command_receipts(command_id),
        request_hash TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        turn_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, native_turn_id TEXT,
        result_json TEXT, result_ref TEXT, error_code TEXT, error_message TEXT, resolution TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, task_label TEXT
      ) STRICT;
      CREATE TABLE session_leases (
        session_id TEXT PRIMARY KEY REFERENCES resident_sessions(id), turn_id TEXT NOT NULL UNIQUE,
        acquired_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE resident_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES resident_sessions(id),
        type TEXT NOT NULL, time TEXT NOT NULL, data_json TEXT NOT NULL
      ) STRICT;
      INSERT INTO resident_sessions VALUES (
        'old-session', 'codex', '/workspace', 'idle', 'ok', NULL, 3, 'old-native',
        'test-model', 'high', 'manual', NULL, '2026-08-19T00:00:00.000Z'
      );
      INSERT INTO command_receipts VALUES (
        'old-command', NULL, 'old-hash', 'old-session', 'old-turn', 'settled',
        'old-native-turn', '{"output":[],"stopReason":"completed"}', NULL, NULL, NULL, NULL,
        '2026-08-19T00:00:00.000Z', '2026-08-19T00:01:00.000Z', 'Old task'
      );
      INSERT INTO resident_events (session_id, type, time, data_json) VALUES (
        'old-session', 'turn.settled', '2026-08-19T00:01:00.000Z', '{}'
      );
      PRAGMA user_version = 3;
    `)
    legacy.close()

    const migrated = new ResidentStore(path)
    expect(migrated.inspectSession('old-session')).toMatchObject({
      laneId: 'legacy',
      nativeSessionId: 'old-native',
      latestTurn: { turnId: 'old-turn', state: 'settled', taskLabel: 'Old task' },
    })
    expect(migrated.readEvents('old-session').events).toContainEqual(expect.objectContaining({ type: 'turn.settled' }))
    const independent = migrated.accept(
      'new-command', 'new-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE, undefined, 'New task', 'run:new',
    )
    expect(independent.sessionId).not.toBe('old-session')
    expect(migrated.inspectSession(independent.sessionId).laneId).toBe('run:new')
    migrated.close()
  })

  it('migrates schema v4 by adding the native compaction receipt table', () => {
    const path = root()
    const bootstrap = new ResidentStore(path)
    bootstrap.close()
    const legacy = new DatabaseSync(join(path, 'state.sqlite'))
    legacy.exec('DROP TABLE session_compaction_receipts; PRAGMA user_version = 4;')
    legacy.close()

    const migrated = new ResidentStore(path)
    const source = migrated.accept('v4-source', 'v4-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    migrated.markRunning('v4-source', 'v4-native')
    migrated.settle('v4-source', { output: [], stopReason: 'completed' })
    const before = migrated.inspectSession(source.sessionId)
    const hash = canonicalCompactRequestHash(source.sessionId, before.stateRevision)
    expect(migrated.acceptCompaction('v5-compact', hash, source.sessionId, before.stateRevision))
      .toMatchObject({ state: 'accepted', nativeSessionId: 'v4-native' })
    migrated.close()
  })

  it('keeps a settled product terminal healthy and owner-only on disk', () => {
    const path = root()
    const store = new ResidentStore(path)
    const accepted = store.accept('refused', 'hash', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE)
    store.markRunning('refused', 'native-session')
    store.settle('refused', { output: [], stopReason: 'refusal' })
    expect(store.inspectSession(accepted.sessionId)).toMatchObject({ lifecycle: 'idle', health: 'ok' })
    // Windows reports synthesized mode bits and uses ACLs rather than POSIX
    // permission bits; the mode contract applies only where chmod owns it.
    if (process.platform !== 'win32') {
      expect(lstatSync(path).mode & 0o777).toBe(0o700)
      for (const file of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
        expect(lstatSync(join(path, file)).mode & 0o777).toBe(0o600)
      }
    }
    store.close()
  })

  it('marks a pre-crash running receipt indeterminate and never replays it', () => {
    const path = root()
    const first = new ResidentStore(path)
    const accepted = first.accept('crash-command', 'hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    first.markRunning('crash-command', 'thread-1', 'turn-1')
    first.close()

    const recovered = new ResidentStore(path)
    expect(recovered.inspectTurn(accepted.turnId)).toMatchObject({
      state: 'indeterminate',
      error: { code: 'COMMAND_INDETERMINATE' },
    })
    const snapshot = recovered.inspectSession(accepted.sessionId)
    expect(snapshot).toMatchObject({ lifecycle: 'idle', health: 'degraded', healthReason: 'process_crashed' })
    recovered.resolveIndeterminate('crash-command', snapshot.stateRevision)
    expect(recovered.inspectSession(accepted.sessionId).health).toBe('ok')
    recovered.close()
  })

  it('records exactly one explicitly authorized retry without rewriting the old receipt', () => {
    const path = root()
    const first = new ResidentStore(path)
    const old = first.accept('old-command', 'old-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    first.markRunning('old-command', 'thread-1', 'turn-1')
    first.close()

    const recovered = new ResidentStore(path)
    const snapshot = recovered.inspectSession(old.sessionId)
    recovered.resolveIndeterminate('old-command', snapshot.stateRevision)
    const retryHash = canonicalRequestHash(
      'codex',
      '/workspace',
      [{ type: 'text', text: 'explicit retry' }],
      PROFILE,
      'old-command',
    )
    const retry = recovered.accept(
      'retry-command', retryHash, 'codex', '/workspace', PROFILE, PROFILE_SOURCE, 'old-command',
    )
    expect(recovered.inspectTurn(old.turnId)).toMatchObject({ state: 'indeterminate' })
    const retryEvent = recovered.readEvents(retry.sessionId).events
      .find(event => event.type === 'turn.accepted' && event.data.commandId === 'retry-command')
    expect(retryEvent?.data.supersedesCommandId).toBe('old-command')
    recovered.markRunning('retry-command', 'thread-1', 'turn-2')
    recovered.settle('retry-command', { output: [], stopReason: 'completed' })
    expect(() => recovered.accept(
      'second-retry', 'another-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE, 'old-command',
    ))
      .toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }))
    recovered.close()
  })

  it('requires idle optimistic revision for reset', () => {
    const store = new ResidentStore(root())
    const accepted = store.accept('reset-source', 'hash', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE)
    store.markRunning('reset-source', 'native-session')
    store.settle('reset-source', { output: [], stopReason: 'completed' })
    const snapshot = store.inspectSession(accepted.sessionId)
    expect(() => store.reset(accepted.sessionId, snapshot.stateRevision - 1, 'stale'))
      .toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    const reset = store.reset(accepted.sessionId, snapshot.stateRevision, 'fresh context')
    expect(reset.nativeSessionId).toBeUndefined()
    expect(reset.executionProfile).toBeUndefined()
    expect(reset.stateRevision).toBe(snapshot.stateRevision + 1)
    store.close()
  })

  it('recovers an interrupted native compaction as indeterminate and never replays it', () => {
    const stateRoot = root()
    const first = new ResidentStore(stateRoot)
    const source = first.accept('compact-crash-source', 'source-hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    first.markRunning('compact-crash-source', 'thread-native')
    first.settle('compact-crash-source', { output: [], stopReason: 'completed' })
    const before = first.inspectSession(source.sessionId)
    const hash = canonicalCompactRequestHash(source.sessionId, before.stateRevision, 'retain decisions')
    first.acceptCompaction('compact-crash', hash, source.sessionId, before.stateRevision)
    first.markCompactionRunning('compact-crash')
    first.close()

    const recovered = new ResidentStore(stateRoot)
    const interrupted = recovered.inspectSession(source.sessionId)
    expect(interrupted).toMatchObject({ lifecycle: 'idle', health: 'degraded', healthReason: 'process_crashed' })
    expect(() => recovered.acceptCompaction('compact-crash', hash, source.sessionId, before.stateRevision))
      .toThrow(expect.objectContaining({ code: 'COMMAND_INDETERMINATE' }))
    expect(recovered.readEvents(source.sessionId).events).toContainEqual(expect.objectContaining({
      type: 'session.compaction_indeterminate',
      data: { commandId: 'compact-crash', reason: 'daemon_recovery' },
    }))
    recovered.resolveIndeterminate('compact-crash', interrupted.stateRevision)
    const resolved = recovered.inspectSession(source.sessionId)
    expect(resolved).toMatchObject({ health: 'ok' })
    const nextHash = canonicalCompactRequestHash(source.sessionId, resolved.stateRevision)
    expect(recovered.acceptCompaction('compact-after-resolution', nextHash, source.sessionId, resolved.stateRevision))
      .toMatchObject({ state: 'accepted', nativeSessionId: 'thread-native' })
    recovered.close()
  })

  it('spills a large result to a content-addressed artifact', () => {
    const store = new ResidentStore(root())
    const accepted = store.accept('large', 'hash', 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    store.markRunning('large', 'thread')
    const settled = store.settle('large', {
      output: [{ type: 'text', text: 'x'.repeat(70 * 1024) }],
      stopReason: 'completed',
    })
    expect(settled.result?.resultRef).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(settled.result?.output[0]).toMatchObject({ type: 'text' })
    expect(store.readArtifact(settled.result!.resultRef!)).toContain('x'.repeat(100))
    expect(store.readEvents(accepted.sessionId).events.map(event => event.type)).toContain('turn.settled')
    store.close()
  })
})
