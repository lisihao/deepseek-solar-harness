import { describe, expect, it } from 'vitest'
import { HANDOFF_COMPACTION_PREFIX, PreparationObserver, preparationState, type ProgressWindow } from '../src/progress.js'
const id = HANDOFF_COMPACTION_PREFIX + 'one'
const event = (type: string, compactionId = id, error?: string) => ({ type: 'event', event: { type, seq: 0, data: { compactionId, ...(error === undefined ? {} : { error }) } } })
function store<T>(initial: T) {
  let state = initial
  const listeners = new Set<() => void>()
  return { getSnapshot: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    set: (next: T) => { state = next; for (const fn of listeners) fn() }, listeners }
}
function fixture(entries: ProgressWindow['entries'] = []) {
  const source = store<ProgressWindow>({ entries, revision: 0, change: { kind: 'replace', entries } })
  const block = store<{ reason: string } | undefined>(undefined)
  const writes: unknown[] = []
  const blocks = { storeFor: () => block, set: (_id: string, value: { reason: string } | undefined) => { writes.push(value); block.set(value) } }
  const observer = new PreparationObserver('session-a', source, blocks)
  function publish(next: ProgressWindow['entries'], kind = 'append', revision = source.getSnapshot().revision + 1) {
    const old = source.getSnapshot().entries
    source.set({ entries: kind === 'replace' ? next : kind === 'prepend' ? [...next, ...old] : [...old, ...next], revision, change: { kind, entries: next } })
  }
  return { source, block, blocks, writes, observer, publish }
}
describe('native handoff preparation affordance', () => {
  it('reports a fresh context on explicit cancellation instead of asking to switch back', () => {
    const f = fixture([event('compaction/start')])
    f.publish([{ type: 'event', event: { type: 'compaction/summary', seq: 1,
      data: { compactionId: id, provider: 'solar-model-handoff', model: 'fresh-context' } } }])
    f.publish([event('compaction/end')])
    expect(f.block.getSnapshot()).toBeUndefined()
    expect(f.observer.getSnapshot()).toMatchObject({ busy: false, fresh: true })
    expect(f.observer.getSnapshot()?.message).toContain('空白任务上下文')
    expect(f.observer.getSnapshot()?.message).not.toContain('切回')
    f.observer.dispose()
  })
  it('locks before waiting, keeps the lock across intermediate events, and releases on commit', () => {
    const f = fixture()
    f.publish([event('compaction/start')])
    expect(f.block.getSnapshot()?.reason).toContain('暂不能输入或发送')
    expect(f.observer.getSnapshot()?.busy).toBe(true)
    const before = f.writes.length
    f.publish([event('request/header')])
    expect(f.writes).toHaveLength(before)
    f.publish([event('compaction/end')])
    expect(f.block.getSnapshot()).toBeUndefined()
    expect(f.observer.getSnapshot()).toBeUndefined()
    f.observer.dispose()
  })
  it('does not claim other engines or let a different transaction unlock ours', () => {
    const f = fixture([event('compaction/start', 'ordinary-pressure-compaction')])
    expect(f.block.getSnapshot()).toBeUndefined()
    f.publish([event('compaction/start')])
    f.publish([event('compaction/end', HANDOFF_COMPACTION_PREFIX + 'other')])
    expect(f.observer.getSnapshot()?.busy).toBe(true)
    f.observer.dispose()
  })
  it('restores input on cancellation/failure and exposes the limited outcome', () => {
    const f = fixture([event('compaction/start')])
    f.publish([event('compaction/end', id, 'cancelled')])
    expect(f.block.getSnapshot()).toBeUndefined()
    expect(f.observer.getSnapshot()).toMatchObject({ busy: false })
    expect(f.observer.getSnapshot()?.message).toContain('/handoff fresh')
    f.observer.dispose()
  })
  it('rebuilds on reconnect replacement, loaded prepend and revision gaps', () => {
    const f = fixture([event('compaction/start')])
    f.publish([event('compaction/start'), event('compaction/end')], 'replace')
    expect(f.block.getSnapshot()).toBeUndefined()
    f.publish([event('compaction/start', HANDOFF_COMPACTION_PREFIX + 'two')], 'replace', 20)
    expect(f.observer.getSnapshot()?.busy).toBe(true)
    f.publish([event('compaction/end', HANDOFF_COMPACTION_PREFIX + 'two')], 'append', 23)
    expect(f.block.getSnapshot()).toBeUndefined()
    f.publish([event('compaction/start')], 'prepend')
    expect(f.block.getSnapshot()).toBeUndefined()
    f.observer.dispose()
  })
  it('keeps another plugin block and never clears one installed during our wait', () => {
    const f = fixture()
    const other = { reason: 'Another plugin is waiting' }
    f.block.set(other)
    f.publish([event('compaction/start')])
    expect(f.block.getSnapshot()).toBe(other)
    f.block.set(undefined)
    expect(f.block.getSnapshot()?.reason).toContain('正在准备上下文')
    f.block.set(other)
    f.publish([event('compaction/end')])
    expect(f.block.getSnapshot()).toBe(other)
    f.observer.dispose()
    expect(f.block.getSnapshot()).toBe(other)
  })
  it('removes subscriptions and its own lock on navigation/plugin disposal', () => {
    const f = fixture([event('compaction/start')])
    f.observer.dispose()
    f.observer.dispose()
    expect(f.block.getSnapshot()).toBeUndefined()
    expect(f.source.listeners.size).toBe(0)
    expect(f.block.listeners.size).toBe(0)
    f.publish([event('compaction/start')])
    expect(f.block.getSnapshot()).toBeUndefined()
  })
  it('handles overlapping mounted occurrences without clearing the remaining owner', () => {
    const f = fixture([event('compaction/start')])
    const second = new PreparationObserver('session-a', f.source, f.blocks)
    f.observer.dispose()
    expect(f.block.getSnapshot()).toBeDefined()
    second.dispose()
    expect(f.block.getSnapshot()).toBeUndefined()
  })
  it('ignores transient frames and does not infer work from an ordinary request', () => {
    expect(preparationState({ entries: [{ ...event('compaction/start'), type: 'transient' }], revision: 0, change: { kind: 'replace' } })).toBeUndefined()
  })
})
