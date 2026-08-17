import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalRequestHash, ResidentStore } from '../src/store.ts'

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
    const hash = canonicalRequestHash('codex', '/workspace', prompt, PROFILE)
    const first = store.accept('command-1', hash, 'codex', '/workspace', PROFILE, PROFILE_SOURCE)
    expect(store.accept('command-1', hash, 'codex', '/workspace', PROFILE, PROFILE_SOURCE)).toEqual(first)
    expect(() => store.accept(
      'command-1',
      canonicalRequestHash('codex', '/workspace', [{ type: 'text', text: 'different' }], PROFILE),
      'codex',
      '/workspace',
      PROFILE,
      PROFILE_SOURCE,
    )).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }))
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

  it('keeps a settled product terminal healthy and owner-only on disk', () => {
    const path = root()
    const store = new ResidentStore(path)
    const accepted = store.accept('refused', 'hash', 'claude-code', '/workspace', PROFILE, PROFILE_SOURCE)
    store.markRunning('refused', 'native-session')
    store.settle('refused', { output: [], stopReason: 'refusal' })
    expect(store.inspectSession(accepted.sessionId)).toMatchObject({ lifecycle: 'idle', health: 'ok' })
    expect(lstatSync(path).mode & 0o777).toBe(0o700)
    for (const file of ['state.sqlite', 'state.sqlite-wal', 'state.sqlite-shm']) {
      expect(lstatSync(join(path, file)).mode & 0o777).toBe(0o600)
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
