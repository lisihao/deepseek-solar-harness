/**
 * Lane choice and handoff text for native dispatches, over synthetic session events: the lane keeps the profile the
 * daemon locked, and the handoff is a pure function of the events inside its frozen interval.
 */
import { describe, expect, it } from 'vitest'
import {
  buildSessionHandoff, chooseResidentLane, handoffInterval, residentLanes, type HandoffInterval,
} from '../src/lanes.ts'

const ev = (seq: number, type: string, data: Record<string, unknown>): never => ({ seq, type, data }) as never
const user = (seq: number, id: string, text: string, kind = 'user') =>
  ev(seq, 'user/message', { id, content: [{ type: 'text', text }], source: { kind } })
const assistant = (seq: number, provider: string, model: string, text: string) =>
  ev(seq, 'assistant/message', { message: { id: `a${String(seq)}`, content: [{ type: 'text', text }], source: { provider, model } } })
const dispatch = (seq: number, commandId: string, lane: string | undefined, model: string, effort = 'low') =>
  ev(seq, 'physical-operator/dispatch', {
    commandId, operatorId: 'codex', executionMode: 'resident', residentProfile: { model, effort },
    ...lane === undefined ? {} : { residentLaneId: lane },
  })
const summary = (seq: number, text: string, shadowedSeqs: number[]) =>
  ev(seq, 'compaction/summary', { summary: [{ type: 'text', text }], shadowedSeqs })
const none = new Set<string>()

describe('resident lanes', () => {
  it('uses the default lane first, reuses a lane with the same profile, and gives a new profile its own', () => {
    expect(chooseResidentLane([], 'agent', 'codex', { model: 'sol', effort: 'low' }, none)).toBeUndefined()
    const events = [dispatch(1, 'a', undefined, 'sol')]
    expect(chooseResidentLane(events, 'agent', 'codex', { model: 'sol', effort: 'low' }, none)).toBeUndefined()
    expect(chooseResidentLane(events, 'agent', 'codex', { model: 'gpt-6/astra', effort: 'medium' }, none)).toBe('agent~gpt-6_astra~medium')
    expect(chooseResidentLane(events, 'agent', 'codex', { model: 'sol' }, none)).toBe('agent~sol~default')
    const more = [...events, dispatch(2, 'b', 'agent~terra~high', 'terra', 'high')]
    expect(chooseResidentLane(more, 'agent', 'codex', { model: 'terra', effort: 'high' }, none)).toBe('agent~terra~high')
    expect(chooseResidentLane(more, 'agent', 'codex', { model: 'sol', effort: 'low' }, none)).toBeUndefined()
    expect(chooseResidentLane(more, 'agent', 'codex', undefined, none)).toBeUndefined()
  })

  it('lists lanes newest first and skips refused, other-operator and non-resident dispatches', () => {
    const events = [
      dispatch(1, 'a', undefined, 'sol'), dispatch(2, 'b', 'agent~terra~high', 'terra', 'high'), dispatch(3, 'c', undefined, 'sol'),
      dispatch(4, 'd', 'agent~nova~low', 'nova'),
      ev(5, 'physical-operator/dispatch', { commandId: 'e', operatorId: 'claude-code', executionMode: 'resident', residentProfile: { model: 'x' } }),
      ev(6, 'physical-operator/dispatch', { commandId: 'f', operatorId: 'codex', executionMode: 'ephemeral', residentProfile: { model: 'y' } }),
    ]
    expect(residentLanes(events, 'codex', new Set(['d'])).map(lane => [lane.laneId, lane.profile.model])).toEqual([
      [undefined, 'sol'], ['agent~terra~high', 'terra'],
    ])
  })
})

describe('handoff interval', () => {
  it('takes the confirmed position from the newest dispatch on the lane whose reply reached the session', () => {
    const events = [
      user(1, 'm1', 'one'), dispatch(2, 'a', undefined, 'sol'), assistant(3, 'router', 'codex', 'codex one'),
      user(4, 'm2', 'two'), assistant(5, 'deepseek', 'deepseek', 'deepseek two'),
      user(6, 'm3', 'three'), dispatch(7, 'b', 'agent~terra~high', 'terra', 'high'),
    ]
    expect(handoffInterval(events, 'codex', undefined, 'm3', 99, 10_000, 'router')).toEqual({ afterSeq: 3, beforeSeq: 6, maxChars: 10_000 })
    // Another lane never ran a delivered dispatch, and an undelivered one does not count.
    expect(handoffInterval(events, 'codex', 'agent~terra~high', 'm3', 99, 10_000, 'router')).toEqual({ beforeSeq: 6, maxChars: 10_000 })
    // The task message is appended after the route is chosen, so the next seq bounds the interval then.
    expect(handoffInterval(events, 'codex', undefined, 'not-logged-yet', 8, 10_000, 'router')).toEqual({ afterSeq: 3, beforeSeq: 8, maxChars: 10_000 })
  })
})

describe('session handoff text', () => {
  const events = [
    user(1, 'm1', 'build plan A'), assistant(2, 'router', 'codex', 'codex built A'),
    user(3, 'm2', 'change to plan B'), assistant(4, 'deepseek', 'deepseek', 'noted, plan B'),
    user(5, 'p', 'continue'),
  ]

  it('separates the user\'s words from quoted replies and leaves out everything that is not conversation', () => {
    const noisy = [...events.slice(0, 4), user(5, 'cat', 'skill list', 'skill-catalog'), assistant(6, 'x', 'y', '   '), user(7, 'p', 'continue')]
    const text = buildSessionHandoff(noisy, { afterSeq: 2, beforeSeq: 7, maxChars: 10_000 })
    expect(text).toContain('[user] change to plan B')
    expect(text).toContain('[assistant deepseek/deepseek] noted, plan B')
    expect(text).not.toContain('skill list')
    expect(text).not.toContain('build plan A')
    expect(text).toContain('quoted record')
  })

  it('is the same after later events, including a compaction, are appended', () => {
    const interval: HandoffInterval = { afterSeq: 2, beforeSeq: 5, maxChars: 10_000 }
    const before = buildSessionHandoff(events, interval)
    const later = [...events, summary(6, 'compacted', [1, 2, 3, 4]), user(7, 'm9', 'later'), assistant(8, 'router', 'codex', 'later reply')]
    expect(buildSessionHandoff(later, interval)).toBe(before)
  })

  it('has nothing to say when the lane is current', () => {
    expect(buildSessionHandoff(events, { afterSeq: 4, beforeSeq: 5, maxChars: 10_000 })).toBeUndefined()
    expect(buildSessionHandoff([], { beforeSeq: 0, maxChars: 10_000 })).toBeUndefined()
  })

  it('keeps the newest part of a gap that does not fit, also for a lane that has run before, and says how much it left out', () => {
    const gap = Array.from({ length: 12 }, (_, index) => user(index + 2, `g${String(index)}`, `gap message ${String(index)} ${'z'.repeat(60)}`))
    const text = buildSessionHandoff([...gap, user(20, 'p', 'go')], { afterSeq: 1, beforeSeq: 20, maxChars: 700 }) ?? ''
    expect(text).toMatch(/\[\d+ earlier messages omitted/u)
    expect(text).toContain('gap message 11')
    expect(text).not.toContain('gap message 0 ')
    expect(text.length).toBeLessThanOrEqual(700)
  })

  it('gives a lane that never ran the newest part, notes what was left out, and truncates one oversized message', () => {
    const many = Array.from({ length: 12 }, (_, index) => user(index + 1, `m${String(index)}`, `message number ${String(index)} ${'x'.repeat(60)}`))
    const text = buildSessionHandoff(many, { beforeSeq: 13, maxChars: 700 }) ?? ''
    expect(text).toMatch(/\[\d+ earlier messages omitted/u)
    expect(text).toContain('message number 11')
    expect(text).not.toContain('message number 0 ')
    const big = [user(1, 'big', 'y'.repeat(5_000)), user(2, 'p', 'go')]
    const truncated = buildSessionHandoff(big, { beforeSeq: 2, maxChars: 1_000 }) ?? ''
    expect(truncated).toContain('[truncated]')
    expect(truncated.length).toBeLessThanOrEqual(1_000)
  })

  it('starts a lane that never ran from the latest compaction summary and drops what it shadowed', () => {
    const compacted = [
      user(1, 'm1', 'old request'), assistant(2, 'router', 'codex', 'old reply'),
      summary(3, 'the user wants plan A', [1, 2]), user(4, 'm2', 'newer request'), user(5, 'p', 'go'),
    ]
    const text = buildSessionHandoff(compacted, { beforeSeq: 5, maxChars: 10_000 }) ?? ''
    expect(text).toContain('[summary of earlier conversation] the user wants plan A')
    expect(text).toContain('[user] newer request')
    expect(text).not.toContain('old request')
    expect(text).not.toContain('old reply')
    expect(buildSessionHandoff([ev(1, 'compaction/summary', { summary: 'not blocks' })], { beforeSeq: 2, maxChars: 10_000 })).toBeUndefined()
  })
})
