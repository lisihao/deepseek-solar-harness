import { describe, expect, it } from 'vitest'
import { RlmCancellationScope } from '../src/rlm-cancellation.ts'

describe('RLM cancellation scope', () => {
  it('aborts one execution without touching its parent or a sibling', () => {
    const attempt = new AbortController()
    const scope = new RlmCancellationScope(attempt.signal, 'root')
    const a = scope.begin('a', 'root')
    const b = scope.begin('b', 'root')
    a.abort()
    expect([a.signal.aborted, b.signal.aborted, attempt.signal.aborted]).toEqual([true, false, false])
  })

  it('aborts what a child spawned together with the child, and nothing above it', () => {
    const attempt = new AbortController()
    const scope = new RlmCancellationScope(attempt.signal, 'root')
    const a = scope.begin('a', 'root')
    const grandchild = scope.begin('a1', 'a')
    const sibling = scope.begin('b', 'root')
    a.abort()
    expect([grandchild.signal.aborted, sibling.signal.aborted, attempt.signal.aborted]).toEqual([true, false, false])
  })

  it('does not abort a later turn of a session because its earlier turn was interrupted', () => {
    const attempt = new AbortController()
    const scope = new RlmCancellationScope(attempt.signal, 'root')
    const first = scope.begin('a', 'root')
    first.abort()
    const next = scope.begin('a')
    expect(next.signal.aborted).toBe(false)
    attempt.abort()
    expect(next.signal.aborted).toBe(true)
  })

  it('does not abort the later turn of a child because the turn of its parent was interrupted', () => {
    const attempt = new AbortController()
    const scope = new RlmCancellationScope(attempt.signal, 'root')
    const rootTurn = scope.begin('root')
    const spawned = scope.begin('a', 'root')
    rootTurn.abort()
    expect(spawned.signal.aborted).toBe(true)
    // A message to the child arrives after the parent's interrupted turn; its continuation starts alive.
    expect(scope.begin('a').signal.aborted).toBe(false)
  })

  it('aborts every execution once when the attempt is cancelled, including one started afterwards', () => {
    const attempt = new AbortController()
    const scope = new RlmCancellationScope(attempt.signal, 'root')
    const a = scope.begin('a', 'root')
    const counts = { a: 0, late: 0 }
    a.signal.addEventListener('abort', () => { counts.a += 1 })
    attempt.abort(new Error('cancelled'))
    const late = scope.begin('b', 'root')
    late.signal.addEventListener('abort', () => { counts.late += 1 })
    expect(a.signal.aborted).toBe(true)
    expect(late.signal.aborted).toBe(true)
    expect(counts).toEqual({ a: 1, late: 0 })
  })

  it('follows the attempt for a session whose parent is unknown, such as a later root turn', () => {
    const attempt = new AbortController()
    const scope = new RlmCancellationScope(attempt.signal, 'root')
    const rootTurn = scope.begin('root')
    const child = scope.begin('a', 'root')
    expect([rootTurn.signal.aborted, child.signal.aborted]).toEqual([false, false])
    rootTurn.abort()
    expect([rootTurn.signal.aborted, child.signal.aborted, attempt.signal.aborted]).toEqual([true, true, false])
  })
})
