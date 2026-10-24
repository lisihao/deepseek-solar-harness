import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { foldRunMetrics } from '../src/metrics.js'
import { childEvents, rootEvents } from './sessions.js'

const sequence = (drafts: readonly Omit<SessionEvent, 'seq'>[]): SessionEvent[] => drafts.map((event, seq) => ({ ...event, seq }) as SessionEvent)

describe('foldRunMetrics', () => {
  it('splits time into LLM, the slowest parallel tool per step, and overhead', () => {
    const { metrics, models } = foldRunMetrics(sequence(rootEvents()), [], [])
    expect(metrics.timing).toEqual({ wallMs: 1000, llmMs: 400, toolCriticalMs: 300, overheadMs: 300 })
    expect(metrics.tools).toEqual({ bash: { calls: 1, errors: 0, totalMs: 100 }, read: { calls: 1, errors: 1, totalMs: 300 } })
    expect(models).toEqual(['deepseek-v4-flash'])
    expect(metrics.costUsd).toBeUndefined()
  })

  it('sums tokens and cost over child sessions with cache reads at the cache rate', () => {
    const { metrics } = foldRunMetrics(sequence(rootEvents()), [sequence(childEvents())], [{ model: 'deepseek-v4-flash', input: 2, output: 4 }])
    expect(metrics.tokens).toEqual({ input: 1100, output: 210, cacheRead: 500, unreportedMessages: 0 })
    expect(metrics.sessions).toBe(2)
    expect(metrics.costUsd! * 1_000_000).toBeCloseTo(1100 * 2 + 500 * 2 + 210 * 4, 6)
  })

  it('counts unreported usage, retries, an orphan result, and an empty log', () => {
    const events = sequence([
      { type: 'turn/start', time: 0, data: { turn: 1 } },
      { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
      { type: 'llm/retry', time: 5, data: {} },
      {
        type: 'assistant/message', time: 10, data: {
          turn: 1, step: 1,
          message: { id: 'm', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'x' } },
        },
      },
      {
        type: 'assistant/message', time: 20, data: {
          turn: 1, step: 2,
          message: { id: 'n', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'x' } },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      },
      { type: 'tool/result', time: 30, data: { turn: 1, step: 1, message: { id: 'r', role: 'tool', toolCallId: 'ghost', content: [], source: { kind: 'tool', callId: 'ghost' } } } },
      { type: 'tool/call', time: 30, data: { turn: 9, step: 9, callId: 'z', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: 40, data: { turn: 9, step: 9, message: { id: 's', role: 'tool', toolCallId: 'z', content: [], isError: true, source: { kind: 'tool', callId: 'z' } } } },
      { type: 'step/end', time: 40, data: { turn: 1, step: 1 } },
      { type: 'step/end', time: 40, data: { turn: 2, step: 7 } },
    ] as Omit<SessionEvent, 'seq'>[])
    const { metrics } = foldRunMetrics(events, [], [{ model: 'other', input: 1, output: 1 }])
    expect(metrics).toMatchObject({ retries: 1, steps: 2, turns: 1, tokens: { unreportedMessages: 1, input: 1 } })
    expect(metrics.timing).toEqual({ wallMs: 40, llmMs: 10, toolCriticalMs: 0, overheadMs: 30 })
    // rc.2 flags a failed result on the tool message itself, without an `error` field.
    expect(metrics.tools.bash).toEqual({ calls: 1, errors: 1, totalMs: 10 })
    expect(metrics.costUsd).toBeUndefined()
    expect(foldRunMetrics([], [], []).metrics.timing).toEqual({ wallMs: 0, llmMs: 0, toolCriticalMs: 0, overheadMs: 0 })
  })

  it('keeps the first message per step as the LLM end and floors overhead at zero', () => {
    const events = sequence([
      { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
      { type: 'assistant/message', time: 50, data: { turn: 1, step: 1, message: { id: 'a', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'x' } } } },
      { type: 'assistant/message', time: 60, data: { turn: 1, step: 1, message: { id: 'b', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'x' } } } },
      { type: 'tool/call', time: 0, data: { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: 60, data: { turn: 1, step: 1, message: { id: 'r', role: 'tool', toolCallId: 'c', content: [], source: { kind: 'tool', callId: 'c' } } } },
      { type: 'step/end', time: 60, data: { turn: 1, step: 1 } },
    ] as Omit<SessionEvent, 'seq'>[])
    expect(foldRunMetrics(events, [], []).metrics.timing).toEqual({ wallMs: 60, llmMs: 50, toolCriticalMs: 60, overheadMs: 0 })
  })
})
