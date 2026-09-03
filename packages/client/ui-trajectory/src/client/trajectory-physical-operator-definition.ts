import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryPhysicalOperatorExecution, TrajectoryPhysicalOperatorTraceEntry,
} from './trajectory-contract.ts'
import { trajectoryNode } from './trajectory-definition-common.ts'

const MAX_PREVIEW_CHARACTERS = 1_600
const MAX_PREVIEW_LINES = 12
const MAX_SUMMARY_DEPTH = 4
const MAX_SUMMARY_ITEMS = 24

const SENSITIVE_KEY = new RegExp([
  'api[_-]?key', 'authorization', 'password', 'access[_-]?token', 'refresh[_-]?token',
  'token', 'secret', 'credential', 'stderr', 'prompt', 'system[_-]?prompt',
  'hidden[_-]?reasoning', 'reasoning', 'transcript', 'environment', 'env',
  'chain[_-]?of[_-]?thought', 'internal',
].join('|'), 'iu')
const SENSITIVE_TEXT = new RegExp(
  String.raw`\b((?:${[
    'api[_-]?key', 'authorization', 'password', 'access[_-]?token', 'refresh[_-]?token',
    'token', 'secret', 'credential', 'prompt', 'system[_-]?prompt',
  ].join('|')})\s*[:=]\s*)` + String.raw`["']?[^\s,;}"']+`,
  'giu',
)
const BEARER_TEXT = /\b(Bearer\s+)[^\s,;}"']+/giu

interface PhysicalOperatorState {
  readonly commandId: string
  readonly operatorId: string
  readonly turn: number
  readonly step: number
  readonly dispatchSeq: number
  readonly dispatchTime: number
  readonly entries: ReadonlyMap<string, TrajectoryPhysicalOperatorTraceEntry>
}

type PhysicalObservation = NonNullable<TrajectoryPhysicalOperatorTraceEntry['observation']>

/** Local view of the registered durable event vocabulary without importing a Host package into the browser bundle. */
interface PhysicalSessionEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: Record<string, unknown>
}

function physicalEvent(match: ConversationMatch): PhysicalSessionEvent {
  return match.event as unknown as PhysicalSessionEvent
}

function isExecutionStart(event: PhysicalSessionEvent): boolean {
  return event.type === 'physical-operator/dispatch' || event.type === 'physical-operator/tool-dispatch'
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function scrubText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
    .replace(SENSITIVE_TEXT, '$1[REDACTED]')
    .replace(BEARER_TEXT, '$1[REDACTED]')
}

function boundedMultiline(value: string, limit = MAX_PREVIEW_CHARACTERS): string | undefined {
  const lines = value.replace(/\r\n?/gu, '\n').split('\n').map(scrubText)
  const hasMoreLines = lines.length > MAX_PREVIEW_LINES
  let bounded = lines.slice(0, MAX_PREVIEW_LINES).join('\n').trim()
  if (hasMoreLines) bounded = `${bounded}\n…`
  if (bounded.length > limit) bounded = `${bounded.slice(0, Math.max(0, limit - 1))}…`
  return bounded === '' ? undefined : bounded
}

function safePreview(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return boundedMultiline(value)
}

function safeSummaryValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_SUMMARY_DEPTH) return '[TRUNCATED]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return scrubText(value)
  if (Array.isArray(value)) {
    return [
      ...value.slice(0, MAX_SUMMARY_ITEMS).map(item => safeSummaryValue(item, depth + 1)),
      ...(value.length > MAX_SUMMARY_ITEMS ? ['[TRUNCATED]'] : []),
    ]
  }
  if (typeof value !== 'object') return '[UNAVAILABLE]'
  const source = value as Record<string, unknown>
  const entries = Object.entries(source).sort(([left], [right]) => left.localeCompare(right))
  const result: Record<string, unknown> = {}
  for (const [key, item] of entries.slice(0, MAX_SUMMARY_ITEMS)) {
    if (SENSITIVE_KEY.test(key)) continue
    result[key] = safeSummaryValue(item, depth + 1)
  }
  if (entries.length > MAX_SUMMARY_ITEMS) result['…'] = '[TRUNCATED]'
  return result
}

function safeJsonSummary(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(safeSummaryValue(value), null, 2)
    return typeof serialized === 'string' ? boundedMultiline(serialized) : undefined
  } catch {
    return undefined
  }
}

function usage(value: unknown): PhysicalObservation['usage'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const number = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined
  const inputTokens = number('inputTokens')
  const outputTokens = number('outputTokens')
  const cacheReadInputTokens = number('cacheReadInputTokens')
  const cacheWriteInputTokens = number('cacheWriteInputTokens')
  if (inputTokens === undefined && outputTokens === undefined
    && cacheReadInputTokens === undefined && cacheWriteInputTokens === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
  }
}

function observation(value: unknown): PhysicalObservation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const kind = nonEmptyString(record.kind)
  switch (kind) {
    case 'public-output': {
      const preview = safePreview(record.preview)
      return { kind, ...(preview === undefined ? {} : { preview }) }
    }
    case 'tool-started':
    case 'tool-completed': {
      const toolName = nonEmptyString(record.toolName)
      return { kind, ...(toolName === undefined ? {} : { toolName }) }
    }
    case 'approval-required': {
      const approvalKind = nonEmptyString(record.approvalKind)
      const preview = safePreview(record.preview)
      return {
        kind,
        ...(approvalKind === undefined ? {} : { approvalKind }),
        ...(preview === undefined ? {} : { preview }),
      }
    }
    case 'usage-updated': {
      const current = usage(record.usage)
      return current === undefined ? undefined : { kind, usage: current }
    }
    default: return undefined
  }
}

function toolTraceId(data: Record<string, unknown>): string | undefined {
  return nonEmptyString(data.toolCallId) ?? nonEmptyString(data.commandId)
}

function executionTraceId(data: Record<string, unknown>): string | undefined {
  return nonEmptyString(data.executionCommandId) ?? nonEmptyString(data.commandId)
}

function toolTraceEntry(event: PhysicalSessionEvent): {
  readonly key: string
  readonly entry: TrajectoryPhysicalOperatorTraceEntry
} | undefined {
  const toolCallId = toolTraceId(event.data)
  const name = nonEmptyString(event.data.tool)
  if (toolCallId === undefined || name === undefined) return undefined
  if (event.type === 'physical-operator/tool-call') {
    const argumentsSummary = safeJsonSummary(event.data.arguments)
    return {
      key: `tool:${toolCallId}`,
      entry: {
        seq: event.seq,
        time: event.time,
        type: 'tool',
        tool: {
          toolCallId,
          name,
          status: 'running',
          ...(argumentsSummary === undefined ? {} : { argumentsSummary }),
          callSeq: event.seq,
        },
      },
    }
  }
  if (event.type !== 'physical-operator/tool-result') return undefined
  const result = event.data.result
  const resultRecord = typeof result === 'object' && result !== null && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined
  const isError = resultRecord?.isError === true || resultRecord?.error !== undefined
  const error = resultRecord?.error === undefined ? undefined : safePreview(
    typeof resultRecord.error === 'string' ? resultRecord.error : safeJsonSummary(resultRecord.error),
  )
  const resultValue = resultRecord === undefined
    ? result
    : resultRecord.value === undefined ? resultRecord.content : resultRecord.value
  const resultSummary = safeJsonSummary(resultValue)
  return {
    key: `tool:${toolCallId}`,
    entry: {
      seq: event.seq,
      time: event.time,
      type: 'tool',
      tool: {
        toolCallId,
        name,
        status: isError ? 'error' : 'completed',
        ...(resultSummary === undefined ? {} : { resultSummary }),
        ...(error === undefined ? {} : { error }),
        resultSeq: event.seq,
      },
    },
  }
}

function mergeToolTraceEntries(
  previous: TrajectoryPhysicalOperatorTraceEntry,
  next: TrajectoryPhysicalOperatorTraceEntry,
): TrajectoryPhysicalOperatorTraceEntry {
  if (previous.type !== 'tool' || next.type !== 'tool' || previous.tool === undefined || next.tool === undefined) {
    return previous
  }
  // The first settled result wins. This keeps reconnect/replay events from
  // replacing a durable receipt with a later duplicate.
  if (previous.tool.status !== 'running') return previous
  const callSeq = previous.tool.callSeq ?? next.tool.callSeq
  return {
    ...previous,
    tool: {
      ...previous.tool,
      ...next.tool,
      ...(callSeq === undefined ? {} : { callSeq }),
    },
  }
}

function traceEntry(match: ConversationMatch): { readonly key: string; readonly entry: TrajectoryPhysicalOperatorTraceEntry } | undefined {
  const event = physicalEvent(match)
  if (event.type === 'physical-operator/tool-call' || event.type === 'physical-operator/tool-result') {
    return toolTraceEntry(event)
  }
  if (event.type === 'physical-operator/dispatch-terminal') {
    return {
      key: `event:${String(event.seq)}`,
      entry: { seq: event.seq, time: event.time, type: 'terminal', code: String(event.data.code) },
    }
  }
  if (event.type === 'physical-operator/trace-degraded') {
    return {
      key: `event:${String(event.seq)}`,
      entry: { seq: event.seq, time: event.time, type: 'degraded', code: String(event.data.code) },
    }
  }
  if (event.type !== 'physical-operator/progress') return undefined
  const nativeType = String(event.data.type)
  const native = event.data.data as Record<string, unknown>
  if (nativeType === 'turn.progress') {
    const phase = typeof native.phase === 'string' ? native.phase : undefined
    return {
      key: `progress:${String(event.data.sequence)}`,
      entry: { seq: event.seq, time: event.time, type: 'progress', ...(phase === undefined ? {} : { phase }) },
    }
  }
  if (nativeType === 'turn.settled') {
    const stopReason = nonEmptyString(native.stopReason) ?? 'unknown'
    return {
      key: `progress:${String(event.data.sequence)}`,
      entry: {
        seq: event.seq,
        time: event.time,
        type: 'terminal',
        code: stopReason,
        outcome: stopReason === 'completed' ? 'success' : 'error',
      },
    }
  }
  if (nativeType !== 'turn.observation') return undefined
  const current = observation(native)
  return current === undefined
    ? undefined
    : {
      key: `progress:${String(event.data.sequence)}`,
      entry: { seq: event.seq, time: event.time, type: 'observation', observation: current },
    }
}

function execution(state: PhysicalOperatorState): TrajectoryPhysicalOperatorExecution {
  return {
    commandId: state.commandId,
    operatorId: state.operatorId,
    turn: state.turn,
    step: state.step,
    dispatchSeq: state.dispatchSeq,
    dispatchTime: state.dispatchTime,
    entries: [...state.entries.values()].sort((left, right) => left.seq - right.seq),
  }
}

/** Command-scoped, trace-safe Physical Operator execution projection. */
const trajectoryPhysicalOperatorDefinition: ConversationNodeDefinition<PhysicalOperatorState> = {
  kind: 'trajectory-physical-operator-execution',
  target: 'trajectory',
  match: (raw) => {
    const event = raw as unknown as PhysicalSessionEvent
    if (isExecutionStart(event)) return { id: String(event.data.commandId), role: 'start' }
    if (event.type === 'physical-operator/progress'
      || event.type === 'physical-operator/dispatch-terminal'
      || event.type === 'physical-operator/trace-degraded') return { id: String(event.data.commandId), role: 'update' }
    if (event.type === 'physical-operator/tool-call' || event.type === 'physical-operator/tool-result') {
      const id = executionTraceId(event.data)
      if (id === undefined) return null
      // New events carry the parent execution id. Legacy events without it
      // remain visible as a synthetic command keyed by their receipt id.
      return {
        id,
        role: event.data.executionCommandId === undefined && event.type === 'physical-operator/tool-call'
          ? 'start'
          : 'update',
      }
    }
    return null
  },
  start: (_context, match) => {
    const event = physicalEvent(match)
    const legacyTool = event.type === 'physical-operator/tool-call' && event.data.executionCommandId === undefined
      ? toolTraceEntry(event)
      : undefined
    if (!isExecutionStart(event) && legacyTool === undefined) {
      throw new Error('trajectory physical-operator execution requires a dispatch start')
    }
    if (legacyTool !== undefined) {
      return {
        commandId: String(event.data.commandId),
        operatorId: nonEmptyString(event.data.operatorId) ?? 'physical-operator',
        turn: 0,
        step: 0,
        dispatchSeq: event.seq,
        dispatchTime: event.time,
        entries: new Map([
          ['dispatch', { seq: event.seq, time: event.time, type: 'dispatch' }],
          [legacyTool.key, legacyTool.entry],
        ]),
      }
    }
    // Tool dispatches are not agent-loop events and intentionally carry no turn/step.
    // `0/0` is the stable prelude location; layout folds it into the first displayed turn.
    const turn = typeof event.data.turn === 'number' ? event.data.turn : 0
    const step = typeof event.data.step === 'number' ? event.data.step : 0
    return {
      commandId: String(event.data.commandId),
      operatorId: String(event.data.operatorId),
      turn,
      step,
      dispatchSeq: event.seq,
      dispatchTime: event.time,
      entries: new Map([['dispatch', { seq: event.seq, time: event.time, type: 'dispatch' }]]),
    }
  },
  update: (context, match) => {
    const trace = traceEntry(match)
    if (trace === undefined) return context.state
    const existing = context.state.entries.get(trace.key)
    if (existing !== undefined) {
      if (trace.entry.type !== 'tool') return context.state
      const merged = mergeToolTraceEntries(existing, trace.entry)
      if (merged === existing) return context.state
      const entries = new Map(context.state.entries)
      entries.set(trace.key, merged)
      return { ...context.state, entries }
    }
    const entries = new Map(context.state.entries)
    entries.set(trace.key, trace.entry)
    return { ...context.state, entries }
  },
  publication: match => physicalEvent(match).type === 'physical-operator/progress' ? 'animation-frame' : 'immediate',
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.dispatchSeq, {
      kind: 'physical-operator',
      execution: execution(context.state),
    }),
}

/**
 * Register the command-scoped Resident trace projection.
 * @param ctx - Plugin context receiving the Definition.
 */
export function registerTrajectoryPhysicalOperatorDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryPhysicalOperatorDefinition)
}
