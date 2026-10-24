import { describe, expect, it, vi } from 'vitest'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_MEMORY_CONTEXT_LIMITS,
  MemoryContextDurabilityBarrier,
  applySessionProjection,
  planSessionProjection,
  type MemoryContextLimits,
} from '../src/graph-memory.js'

const limits: MemoryContextLimits = { ...DEFAULT_MEMORY_CONTEXT_LIMITS, maxFacts: 4, historyFallbackFacts: 2 }

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function graphSnapshot(id: string, text: string): UserMessage {
  const body = [
    '<memory_capsules>',
    `  <turn_memory id="${id}" outcome="completed" created_at="2026-10-24">${text}</turn_memory>`,
    '</memory_capsules>',
    '<episodic_context>',
    `  <trace source="turn-memory:${id}">[USER] ${text}</trace>`,
    '</episodic_context>',
  ].join('\n')
  return createUserMessage({
    content: [{ type: 'text', text: body }],
    source: { kind: 'plugin:graph-memory', form: 'snapshot', sections: [{ name: 'graph-memory:recall', text: body }] } as never,
  })
}

function appendUser(session: Session, text: string) {
  return session.append('user/message', user(text), { surfaceOp: 'append' })
}

function appendGraph(session: Session, id: string, text: string) {
  return session.append('user/message', graphSnapshot(id, text), { surfaceOp: 'append' })
}

describe('durable Graph Memory Session projection', () => {
  it('retires historical snapshots one node at a time while retaining raw events and literal user text', () => {
    const session = Session.create(SessionId('memory-context-history'))
    const quoted = appendUser(session, 'Literal user quote: <memory_capsules> must remain untouched.')
    const first = appendGraph(session, 'one', 'first historical fact')
    const second = appendGraph(session, 'two', 'second historical fact')
    const original = session.snapshotEvents()

    const plan = planSessionProjection(session, { turn: 3, step: 1 }, limits)
    applySessionProjection(session, { turn: 3, step: 1 }, plan)

    expect(plan.retiredSnapshotCount).toBe(2)
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(session.deriveMessages()).toEqual([quoted.data])
    const retirements = session.snapshotEvents().slice(original.length)
    expect(retirements.map(event => event.sourceEventSeqs)).toEqual([[first.seq], [second.seq]])
    expect(retirements.every(event => event.type === 'developer/message' && event.data.message.source.kind === 'solar-memory-context')).toBe(true)

    const reloaded = Session.create(SessionId('memory-context-history-reload'), session.snapshotEvents())
    expect(reloaded.deriveMessages()).toEqual([quoted.data])
    expect(planSessionProjection(reloaded, { turn: 4, step: 1 }, limits).actions).toEqual([])
  })

  it('uses a current step boundary only as an explicit compatibility fallback, then retains the same view across later steps', () => {
    const session = Session.create(SessionId('memory-context-current-step'))
    session.append('step/start', { turn: 5, step: 1 })
    const direct = appendUser(session, 'alpha current topic')
    const raw = appendGraph(session, 'alpha', 'alpha current topic evidence')
    const original = session.snapshotEvents()

    const currentPlan = planSessionProjection(session, { turn: 5, step: 1 }, limits)
    applySessionProjection(session, { turn: 5, step: 1 }, currentPlan)

    expect(currentPlan.retainedCurrentView).toBe(true)
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    const view = session.deriveMessages().find(message => message.source.kind === 'plugin:graph-memory')
    expect(view?.source).toMatchObject({ solarMemoryContext: { turn: 5, policyVersion: 1 } })
    expect(session.deriveMessages()).toContainEqual(direct.data)
    const replacement = session.snapshotEvents().at(-1)
    expect(replacement?.sourceEventSeqs).toEqual([raw.seq])

    const nextStep = planSessionProjection(session, { turn: 5, step: 2 }, limits)
    expect(nextStep.actions).toEqual([])
    expect(nextStep.retainedCurrentView).toBe(true)

    const laterTurn = planSessionProjection(session, { turn: 6, step: 1 }, limits)
    applySessionProjection(session, { turn: 6, step: 1 }, laterTurn)
    expect(session.deriveMessages().some(message => message.source.kind === 'plugin:graph-memory')).toBe(false)
  })

  it('retires a current raw snapshot without projecting facts when the complete request explicitly rejects continuing the prior task', () => {
    const session = Session.create(SessionId('memory-context-negative-history'))
    session.append('step/start', { turn: 7, step: 1 })
    appendUser(session, '本轮不继续之前的任务，不调用任何工具。只回复：BC-1024-OK')
    const raw = appendGraph(session, 'bc-1024', 'BC-1024-OK historical evidence must not be revived.')
    const original = session.snapshotEvents()

    const plan = planSessionProjection(session, { turn: 7, step: 1 }, limits)
    applySessionProjection(session, { turn: 7, step: 1 }, plan)

    expect(plan.retainedCurrentView).toBe(false)
    expect(plan.retiredSnapshotCount).toBe(1)
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(session.deriveMessages().some(message => message.source.kind === 'plugin:graph-memory')).toBe(false)
    expect(session.snapshotEvents().at(-1)?.sourceEventSeqs).toEqual([raw.seq])
  })

  it('keeps a failed flush as a barrier and retries it on a later request without replaying a model request', async () => {
    const session = Session.create(SessionId('memory-context-flush'))
    appendGraph(session, 'durable', 'durable alpha fact')
    const original = session.snapshotEvents()
    const flush = vi.fn<({ flush: (current: Session) => Promise<boolean> })['flush']>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const barrier = new MemoryContextDurabilityBarrier({ flush }, limits)
    const signal = new AbortController().signal

    await expect(barrier.beforeRequest(session, { turn: 1, step: 1 }, signal)).rejects.toThrow('MEMORY_CONTEXT_FLUSH_FAILED')
    expect(flush).toHaveBeenCalledTimes(1)
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(session.deriveMessages().some(message => message.source.kind === 'plugin:graph-memory')).toBe(false)

    await expect(barrier.beforeRequest(session, { turn: 2, step: 1 }, signal)).resolves.toMatchObject({ retiredSnapshotCount: 0 })
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('does not append or flush when the request was aborted before admission', async () => {
    const session = Session.create(SessionId('memory-context-abort'))
    appendGraph(session, 'abort', 'abort alpha fact')
    const original = session.snapshotEvents()
    const flush = vi.fn(async () => true)
    const barrier = new MemoryContextDurabilityBarrier({ flush }, limits)
    const controller = new AbortController()
    controller.abort(new Error('fixture abort'))

    await expect(barrier.beforeRequest(session, { turn: 1, step: 1 }, controller.signal)).rejects.toThrow('fixture abort')
    expect(session.snapshotEvents()).toEqual(original)
    expect(flush).not.toHaveBeenCalled()
  })

  it('validates every raw producer snapshot before the first replacement write', () => {
    const session = Session.create(SessionId('memory-context-invalid'))
    appendGraph(session, 'valid', 'valid alpha fact')
    const malformed = createUserMessage({
      content: [{ type: 'text', text: '<memory_capsules>' }],
      source: { kind: 'plugin:graph-memory', form: 'snapshot', sections: [{ name: 'graph-memory:recall', text: '<memory_capsules>' }] } as never,
    })
    session.append('user/message', malformed, { surfaceOp: 'append' })
    const original = session.snapshotEvents() as readonly SessionEvent[]

    expect(() => planSessionProjection(session, { turn: 1, step: 1 }, limits)).toThrow('MEMORY_CONTEXT_SNAPSHOT_UNSUPPORTED')
    expect(session.snapshotEvents()).toEqual(original)
  })
})
