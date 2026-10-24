import { readFileSync } from 'node:fs'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { COMPACT_HINDSIGHT_GUIDE, projectHindsightMessage } from '../src/hindsight.js'
import { HindsightDurabilityBarrier, planHindsightProjection, projectCurrentHindsight } from '../src/hindsight-session.js'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/hindsight-0.8.1-guides.json', import.meta.url), 'utf8')) as Array<{ kind: string; count: number; text: string }>
const guide = fixtures.find(value => value.kind === 'knowledge' && value.count === 5)!.text
const refresh = fixtures.find(value => value.kind === 'refresh' && value.count === 5)!.text
function automatic(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:hindsight', form: 'recall' } as never })
}
function texts(session: Session): string[] {
  return session.deriveMessages().flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('Hindsight current and durable guide lifecycle', () => {
  it('compacts a new contribution, preserves factual recall and leaves no mutation in the original batch', () => {
    const input = [automatic(guide), automatic(refresh + '\n<relevant_memories>合成事实：HN-42</relevant_memories>')]
    const before = JSON.stringify(input)
    const projected = projectCurrentHindsight(input)
    expect(projected.freshGuide).toBe(true)
    expect(projected.messages[0]!.content).toEqual([{ type: 'text', text: COMPACT_HINDSIGHT_GUIDE }])
    expect(projected.messages[1]!.content).toEqual([{ type: 'text', text: '\n<relevant_memories>合成事实：HN-42</relevant_memories>' }])
    expect(JSON.stringify(input)).toBe(before)
  })

  it('keeps one latest guide, preserves facts, original logs and source event references through reload', async () => {
    const session = Session.create(SessionId('hindsight-history'))
    const first = session.append('user/message', automatic(guide + '\n<relevant_memories>synthetic fact</relevant_memories>'), { surfaceOp: 'append' })
    const second = session.append('user/message', automatic(refresh), { surfaceOp: 'append' })
    const original = session.snapshotEvents()
    const flush = vi.fn(async () => true)
    const barrier = new HindsightDurabilityBarrier({ flush })
    await barrier.beforeRequest(session, { turn: 2, step: 1 }, new AbortController().signal)
    expect(texts(session)).toEqual(['\n<relevant_memories>synthetic fact</relevant_memories>', COMPACT_HINDSIGHT_GUIDE])
    expect(session.snapshotEvents().slice(0, original.length)).toEqual(original)
    expect(session.snapshotEvents().slice(original.length).map(event => event.sourceEventSeqs)).toEqual([[first.seq], [second.seq]])
    expect(planHindsightProjection(session)).toEqual([])
    const reloaded = Session.create(SessionId('hindsight-reload'), session.snapshotEvents())
    expect(texts(reloaded)).toEqual(texts(session))
    expect(planHindsightProjection(reloaded)).toEqual([])
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('keeps the committed guide across aborted proposals and retires it only after the new guide is logged', async () => {
    const session = Session.create(SessionId('hindsight-fresh'))
    const first = session.append('user/message', projectHindsightMessage(automatic(guide))!, { surfaceOp: 'append' })
    const fact = session.append('user/message', automatic('<hindsight_memories>literal fact only</hindsight_memories>'), { surfaceOp: 'append' })
    const barrier = new HindsightDurabilityBarrier({ flush: async () => true })
    const current = projectCurrentHindsight([automatic(refresh)])
    // The host has not committed current; an abort must not remove the sole guide.
    await barrier.beforeRequest(session, { turn: 2, step: 1 }, new AbortController().signal)
    expect(texts(session).filter(text => text.includes(COMPACT_HINDSIGHT_GUIDE))).toHaveLength(1)
    session.append('user/message', current.messages[0]!, { surfaceOp: 'append' })
    await barrier.beforeRequest(session, { turn: 2, step: 2 }, new AbortController().signal)
    expect(texts(session).filter(text => text.includes(COMPACT_HINDSIGHT_GUIDE))).toHaveLength(1)
    expect(session.snapshotEvents().at(-1)).toMatchObject({ type: 'developer/message', sourceEventSeqs: [first.seq] })
    expect(session.deriveMessages()).toContainEqual(fact.data)
  })

  it('keeps a failed flush blocked until the replacement is confirmed durable; aborted requests do not write', async () => {
    const session = Session.create(SessionId('hindsight-flush'))
    session.append('user/message', automatic(guide), { surfaceOp: 'append' })
    const flush = vi.fn<() => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const barrier = new HindsightDurabilityBarrier({ flush })
    const aborted = new AbortController(); aborted.abort()
    await expect(barrier.beforeRequest(session, { turn: 1, step: 1 }, aborted.signal)).rejects.toThrow()
    expect(session.snapshotEvents()).toHaveLength(1)
    await expect(barrier.beforeRequest(session, { turn: 1, step: 1 }, new AbortController().signal)).rejects.toThrow('MEMORY_CONTEXT_FLUSH_FAILED')
    const count = session.snapshotEvents().length
    await barrier.beforeRequest(session, { turn: 1, step: 1 }, new AbortController().signal)
    expect(session.snapshotEvents()).toHaveLength(count)
    expect(flush).toHaveBeenCalledTimes(2)
  })

  it('rejects unknown Solar projection versions instead of guessing their guide semantics', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: COMPACT_HINDSIGHT_GUIDE }], source: { kind: 'plugin:hindsight', form: 'recall', solarHindsightContext: { formatVersion: 99, policyVersion: 1, includesCompactGuide: true } } as never })
    const session = Session.create(SessionId('hindsight-unknown'))
    session.append('user/message', message, { surfaceOp: 'append' })
    expect(() => planHindsightProjection(session)).toThrow('MEMORY_CONTEXT_PROJECTION_UNSUPPORTED')
    expect(() => projectCurrentHindsight([message])).toThrow('MEMORY_CONTEXT_PROJECTION_UNSUPPORTED')
  })
})
