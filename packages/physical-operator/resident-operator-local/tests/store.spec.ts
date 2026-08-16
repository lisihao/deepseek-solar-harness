import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalRequestHash, ResidentStore } from '../src/store.ts'

const roots: string[] = []
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
    const hash = canonicalRequestHash('codex', '/workspace', prompt)
    const first = store.accept('command-1', hash, 'codex', '/workspace')
    expect(store.accept('command-1', hash, 'codex', '/workspace')).toEqual(first)
    expect(() => store.accept(
      'command-1',
      canonicalRequestHash('codex', '/workspace', [{ type: 'text', text: 'different' }]),
      'codex',
      '/workspace',
    )).toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }))
    store.close()
  })

  it('holds one session lease, settles durably, and advances revisions', () => {
    const store = new ResidentStore(root())
    const first = store.accept('one', 'hash-one', 'claude-code', '/workspace')
    expect(() => store.accept('two', 'hash-two', 'claude-code', '/workspace'))
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
    expect(store.accept('two', 'hash-two', 'claude-code', '/workspace').sessionId).toBe(first.sessionId)
    store.close()
  })

  it('keeps a settled product terminal healthy and owner-only on disk', () => {
    const path = root()
    const store = new ResidentStore(path)
    const accepted = store.accept('refused', 'hash', 'claude-code', '/workspace')
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
    const accepted = first.accept('crash-command', 'hash', 'codex', '/workspace')
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
    const old = first.accept('old-command', 'old-hash', 'codex', '/workspace')
    first.markRunning('old-command', 'thread-1', 'turn-1')
    first.close()

    const recovered = new ResidentStore(path)
    const snapshot = recovered.inspectSession(old.sessionId)
    recovered.resolveIndeterminate('old-command', snapshot.stateRevision)
    const retryHash = canonicalRequestHash(
      'codex',
      '/workspace',
      [{ type: 'text', text: 'explicit retry' }],
      'old-command',
    )
    const retry = recovered.accept('retry-command', retryHash, 'codex', '/workspace', 'old-command')
    expect(recovered.inspectTurn(old.turnId)).toMatchObject({ state: 'indeterminate' })
    const retryEvent = recovered.readEvents(retry.sessionId).events
      .find(event => event.type === 'turn.accepted' && event.data.commandId === 'retry-command')
    expect(retryEvent?.data.supersedesCommandId).toBe('old-command')
    recovered.markRunning('retry-command', 'thread-1', 'turn-2')
    recovered.settle('retry-command', { output: [], stopReason: 'completed' })
    expect(() => recovered.accept('second-retry', 'another-hash', 'codex', '/workspace', 'old-command'))
      .toThrow(expect.objectContaining({ code: 'COMMAND_CONFLICT' }))
    recovered.close()
  })

  it('requires idle optimistic revision for reset', () => {
    const store = new ResidentStore(root())
    const accepted = store.accept('reset-source', 'hash', 'claude-code', '/workspace')
    store.markRunning('reset-source', 'native-session')
    store.settle('reset-source', { output: [], stopReason: 'completed' })
    const snapshot = store.inspectSession(accepted.sessionId)
    expect(() => store.reset(accepted.sessionId, snapshot.stateRevision - 1, 'stale'))
      .toThrow(expect.objectContaining({ code: 'REVISION_CONFLICT' }))
    const reset = store.reset(accepted.sessionId, snapshot.stateRevision, 'fresh context')
    expect(reset.nativeSessionId).toBeUndefined()
    expect(reset.stateRevision).toBe(snapshot.stateRevision + 1)
    store.close()
  })

  it('spills a large result to a content-addressed artifact', () => {
    const store = new ResidentStore(root())
    const accepted = store.accept('large', 'hash', 'codex', '/workspace')
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
