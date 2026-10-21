/**
 * Fold one run's session logs into {@link RunMetrics}.
 * @module @deepseek-ai/dsh-bench-runner/metrics
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { RunMetrics, ToolStats } from './types.ts'

/** USD per million tokens for one model; `cacheRead` defaults to `input`. */
export interface ModelPrice {
  /** Provider model id as logged on assistant messages. */
  model: string
  /** Prompt tokens not served from cache. */
  input: number
  /** Completion tokens. */
  output: number
  /** Prompt tokens served from cache. */
  cacheRead?: number
}

/** Event type logged by dsh-llm-retry; absent from the core event map. */
const RETRY_EVENT = 'llm/retry'

/** Per-step interval bookkeeping. */
interface StepClock {
  start: number
  llmEnd?: number
  longestToolMs: number
}

/**
 * Fold the root session's timing, turn, step, tool, and retry figures.
 * @param events - root session events in seq order.
 * @returns the root-only part of the metrics.
 */
function foldRoot(events: readonly SessionEvent[]): Omit<RunMetrics, 'tokens' | 'sessions' | 'costUsd'> {
  const turns = new Set<number>()
  const steps = new Map<string, StepClock>()
  const openCalls = new Map<string, { name: string; time: number; step: string }>()
  const tools: Record<string, ToolStats> = {}
  let stepCount = 0
  let retries = 0
  let llmMs = 0
  let toolCriticalMs = 0
  for (const event of events) {
    if (event.type === 'turn/start') turns.add(event.data.turn)
    else if (event.type === 'step/start') steps.set(`${String(event.data.turn)}:${String(event.data.step)}`, { start: event.time, longestToolMs: 0 })
    else if (event.type === 'assistant/message') {
      const clock = steps.get(`${String(event.data.turn)}:${String(event.data.step)}`)
      if (clock !== undefined && clock.llmEnd === undefined) {
        clock.llmEnd = event.time
        llmMs += event.time - clock.start
      }
    } else if (event.type === 'tool/call') {
      openCalls.set(event.data.callId, { name: event.data.name, time: event.time, step: `${String(event.data.turn)}:${String(event.data.step)}` })
      const stats = tools[event.data.name] ??= { calls: 0, errors: 0, totalMs: 0 }
      stats.calls += 1
    } else if (event.type === 'tool/result') {
      const callId = event.data.message.content[0].toolCallId
      const call = openCalls.get(callId)
      if (call === undefined) continue
      openCalls.delete(callId)
      const elapsed = event.time - call.time
      const stats = tools[call.name] as ToolStats
      stats.totalMs += elapsed
      if (event.data.error !== undefined || event.data.message.content[0].isError === true) stats.errors += 1
      const clock = steps.get(call.step)
      if (clock !== undefined && elapsed > clock.longestToolMs) clock.longestToolMs = elapsed
    } else if (event.type === 'step/end') {
      stepCount += 1
      const clock = steps.get(`${String(event.data.turn)}:${String(event.data.step)}`)
      if (clock !== undefined) toolCriticalMs += clock.longestToolMs
    } else if ((event.type as string) === RETRY_EVENT) retries += 1
  }
  const wallMs = events.length === 0 ? 0 : (events.at(-1) as SessionEvent).time - (events[0] as SessionEvent).time
  return {
    turns: turns.size,
    steps: stepCount,
    timing: { wallMs, llmMs, toolCriticalMs, overheadMs: Math.max(0, wallMs - llmMs - toolCriticalMs) },
    tools,
    retries,
  }
}

/**
 * Fold every session of one run into metrics. Tokens and cost cover all
 * sessions, so subagent work is paid for; timing, steps, and tools describe
 * the root session.
 * @param root - root session events in seq order.
 * @param children - subagent session event lists.
 * @param prices - price table; cost is omitted when any used model lacks a row.
 * @returns the metrics and the sorted models named by assistant messages.
 */
export function foldRunMetrics(
  root: readonly SessionEvent[],
  children: readonly (readonly SessionEvent[])[],
  prices: readonly ModelPrice[],
): { metrics: RunMetrics; models: string[] } {
  const priceByModel = new Map(prices.map(price => [price.model, price]))
  const models = new Set<string>()
  const tokens = { input: 0, output: 0, cacheRead: 0, unreportedMessages: 0 }
  let cost = 0
  let priced = true
  for (const events of [root, ...children]) {
    for (const event of events) {
      if (event.type !== 'assistant/message') continue
      const model = event.data.message.source.model
      models.add(model)
      const usage = event.data.usage
      if (usage === undefined) {
        tokens.unreportedMessages += 1
        continue
      }
      const cacheRead = usage.cacheReadTokens ?? 0
      tokens.input += usage.inputTokens
      tokens.output += usage.outputTokens
      tokens.cacheRead += cacheRead
      const price = priceByModel.get(model)
      if (price === undefined) {
        priced = false
        continue
      }
      // TokenUsage counts are disjoint: inputTokens excludes cache hits.
      const cacheRate = price.cacheRead ?? price.input
      cost += (usage.inputTokens * price.input + cacheRead * cacheRate + usage.outputTokens * price.output) / 1_000_000
    }
  }
  const metrics: RunMetrics = { ...foldRoot(root), tokens, sessions: 1 + children.length }
  if (priced) metrics.costUsd = cost
  return { metrics, models: [...models].sort() }
}
