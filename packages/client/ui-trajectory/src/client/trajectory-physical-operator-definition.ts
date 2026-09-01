import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryPhysicalOperatorExecution, TrajectoryPhysicalOperatorTraceEntry,
} from './trajectory-contract.ts'
import { trajectoryNode } from './trajectory-definition-common.ts'

const MAX_PREVIEW_CHARACTERS = 240

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

function safePreview(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bounded = value.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*=\s*)\S+/giu, '$1[REDACTED]')
    .replace(/\b(Bearer\s+)\S+/giu, '$1[REDACTED]')
  if (bounded === '') return undefined
  return bounded.length > MAX_PREVIEW_CHARACTERS
    ? `${bounded.slice(0, MAX_PREVIEW_CHARACTERS - 1)}…`
    : bounded
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

function traceEntry(match: ConversationMatch): { readonly key: string; readonly entry: TrajectoryPhysicalOperatorTraceEntry } | undefined {
  const event = physicalEvent(match)
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
    return null
  },
  start: (_context, match) => {
    const event = physicalEvent(match)
    if (!isExecutionStart(event)) {
      throw new Error('trajectory physical-operator execution requires a dispatch start')
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
    if (trace === undefined || context.state.entries.has(trace.key)) return context.state
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
