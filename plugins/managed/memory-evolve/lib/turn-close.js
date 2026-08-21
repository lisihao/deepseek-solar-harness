/**
 * Durable end-of-turn memory closure.
 *
 * The model may write the daily and project tracks itself. When it does not,
 * the host writes a concise entry after a completed user-message turn and
 * records one idempotent receipt. The same state also persists the memory
 * review cadence, so reload and resume cannot lose or double-count turns.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SCHEMA_VERSION = 1
const SUMMARY_LIMIT = 400

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, sessions: {} }
}

function loadState(path) {
  if (!existsSync(path)) return emptyState()
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value?.schemaVersion !== SCHEMA_VERSION || value.sessions === null || typeof value.sessions !== 'object') {
      throw new Error('unsupported state schema')
    }
    return value
  } catch (cause) {
    throw new Error(`dsh-memory-evolve: cannot load durable turn state ${path}`, { cause })
  }
}

function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp.${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`)
  renameSync(tmp, path)
}

function sessionKey(agent) {
  return agent?.session?.id ?? agent?.id
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function messageText(event) {
  return contentText(event?.data?.message?.content ?? event?.data?.content)
}

function concise(text) {
  const normalized = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= SUMMARY_LIMIT) return normalized
  return `${normalized.slice(0, SUMMARY_LIMIT - 1)}…`
}

/** A real user-message turn, compatible with logs that omit turn/start.trigger. */
export function isMessageTurn(events, turn) {
  if (events.some((event) => event?.type === 'user/message'
    && event.data?.turn === turn
    && (event.data?.message?.source?.kind === 'user'
      || event.data?.source?.kind === 'user'
      || event.data?.message?.role === 'user'
      || event.data?.role === 'user'))) return true

  const start = events.findIndex((event) => event?.type === 'turn/start' && event.data?.turn === turn)
  if (start < 0) return false
  if (events[start]?.data?.trigger?.kind === 'message') return true
  const end = events.findIndex((event, index) => index > start
    && event?.type === 'turn/end'
    && event.data?.turn === turn)
  const limit = end < 0 ? events.length : end
  return events.slice(start + 1, limit).some((event) => event?.type === 'user/message'
    && (event.data?.message?.source?.kind === 'user'
      || event.data?.source?.kind === 'user'
      || event.data?.message?.role === 'user'
      || event.data?.role === 'user'))
}

/** Last model-visible assistant text for one turn, excluding reasoning. */
export function finalTurnText(events, turn) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message' || event.data?.turn !== turn) continue
    const text = concise(messageText(event))
    if (text) return text
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message' || event.data?.turn !== turn) continue
    const text = concise(messageText(event))
    if (text) return `已处理用户请求：${text}`
  }
  return ''
}

/** Resolve the durable turn that owns one executing tool call. */
export function toolCallTurn(agent, callId) {
  const events = agent?.session?.events ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'tool/call' && event.data?.callId === callId) return event.data?.turn
  }
  return undefined
}

/** Persistent per-session turn receipts and review counters. */
export class DurableTurnState {
  constructor(path) {
    this.path = path
    this.state = loadState(path)
  }

  session(agent) {
    const key = sessionKey(agent)
    if (!key) return undefined
    return this.state.sessions[key]
  }

  mutate(agent, change) {
    const key = sessionKey(agent)
    if (!key) return undefined
    const current = this.state.sessions[key] ?? { turnsSinceReview: 0, lastCountedTurn: 0, lastClosedTurn: 0 }
    const next = change({ ...current })
    if (next === undefined) return current
    this.state.sessions[key] = next
    saveState(this.path, this.state)
    return next
  }

  count(agent, turn) {
    return this.mutate(agent, (entry) => {
      if (!Number.isSafeInteger(turn) || turn <= entry.lastCountedTurn) return undefined
      return { ...entry, turnsSinceReview: entry.turnsSinceReview + 1, lastCountedTurn: turn }
    })
  }

  turnsOf(agent) {
    return this.session(agent)?.turnsSinceReview ?? 0
  }

  completeReview(agent) {
    this.mutate(agent, (entry) => ({ ...entry, turnsSinceReview: 0 }))
  }

  recordModelWrite(agent, turn, target) {
    this.mutate(agent, (entry) => {
      const previous = entry.modelWriteTurn === turn ? entry.modelWrittenTargets ?? [] : []
      return {
        ...entry,
        modelWriteTurn: turn,
        modelWrittenTargets: [...new Set([...previous, target])],
      }
    })
  }

  modelWritesOf(agent, turn) {
    const entry = this.session(agent)
    return new Set(entry?.modelWriteTurn === turn ? entry.modelWrittenTargets ?? [] : [])
  }

  isClosed(agent, turn) {
    return turn <= (this.session(agent)?.lastClosedTurn ?? 0)
  }

  close(agent, turn, receipt) {
    return this.mutate(agent, (entry) => ({
      ...entry,
      lastClosedTurn: Math.max(entry.lastClosedTurn, turn),
      lastReceipt: receipt,
    }))
  }

  receiptOf(agent) {
    return this.session(agent)?.lastReceipt ?? null
  }
}

/** Observe authoritative completed turn boundaries from the durable session feed. */
export function observeCompletedTurns(ctx, listener) {
  const onEvent = (session, event) => {
    if (event?.type !== 'turn/end') return
    const agent = ctx.get('agents')?.get?.(session.id) ?? { id: session.id, session }
    listener(agent, event.data?.turn, event.data?.reason)
  }
  ctx.effect(() => ctx.on('session/event', onEvent, { global: true }))
}

/** Install the host-owned, idempotent end-of-turn memory write loop. */
export function installTurnClosure(ctx, getRuntime, store, turnState) {
  const onSettled = (agent, turn, reason) => {
    if (agent?.session?.header?.origin === 'subagent') return
    if (reason?.kind !== 'completed') return
    const events = agent?.session?.events ?? []
    if (!isMessageTurn(events, turn) || turnState.isClosed(agent, turn)) return

    const runtime = getRuntime()
    const required = []
    if (runtime.perTurnDailyWrites !== false) required.push('daily')
    if (runtime.perTurnProjectWrites !== false) required.push('project')
    const written = turnState.modelWritesOf(agent, turn)
    const summary = finalTurnText(events, turn)
    const targets = []

    for (const target of required) {
      if (written.has(target)) {
        targets.push({ target, source: 'model', status: 'ok' })
        continue
      }
      if (target === 'project' && !agent?.session?.header?.cwd) {
        targets.push({ target, source: 'host', status: 'unavailable' })
        continue
      }
      if (!summary) {
        targets.push({ target, source: 'host', status: 'error', message: 'completed turn has no assistant or user text' })
        continue
      }
      const result = store.add(target, `本回合完成：${summary}`, agent)
      targets.push({ target, source: 'host', status: result.ok ? 'ok' : 'error', message: result.message })
    }

    const status = targets.some((target) => target.status === 'error') ? 'error' : 'ok'
    const receipt = { turn, status, targets, closedAt: new Date().toISOString() }
    if (status === 'ok') turnState.close(agent, turn, receipt)
    else ctx.logger.error(`dsh-memory-evolve: turn ${turn} memory closure failed: ${JSON.stringify(receipt)}`)
  }

  // Turn and step boundaries are durable session/event facts. DSH deliberately
  // does not mirror them as agent lifecycle events, so observe turn/end from
  // the Host scope and resolve the owning Agent by session id.
  observeCompletedTurns(ctx, onSettled)
}

/** Default location for the durable turn state. */
export function turnStatePath(memoryDir) {
  return join(memoryDir, 'turn-state.json')
}
