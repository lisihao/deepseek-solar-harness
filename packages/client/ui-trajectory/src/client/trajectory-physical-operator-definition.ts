import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryPhysicalOperatorExecution, TrajectoryPhysicalOperatorTraceEntry,
} from './trajectory-contract.ts'
import { trajectoryNode } from './trajectory-definition-common.ts'

interface PhysicalOperatorState {
  readonly commandId: string
  readonly operatorId: string
  readonly turn: number
  readonly step: number
  readonly dispatchSeq: number
  readonly dispatchTime: number
  readonly entries: ReadonlyMap<string, TrajectoryPhysicalOperatorTraceEntry>
}

type PhysicalTrace = NonNullable<ConversationMatch['physicalOperatorTrace']>
type ToolTrace = Extract<PhysicalTrace, { kind: 'tool' }>

interface PhysicalSessionEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
}

function physicalEvent(match: ConversationMatch): PhysicalSessionEvent {
  return match.event
}

function eventTypeIs(event: PhysicalSessionEvent, type: string): boolean {
  return event.type === type
}

function traceEntry(match: ConversationMatch): {
  readonly key: string
  readonly entry: TrajectoryPhysicalOperatorTraceEntry
} | undefined {
  const trace = match.physicalOperatorTrace
  if (trace === undefined || trace.kind === 'dispatch') return undefined
  const event = physicalEvent(match)
  if (trace.kind === 'tool') return toolTraceEntry(event, trace)
  if (trace.kind === 'progress') {
    return {
      key: `progress:${String(trace.sourceSequence)}`,
      entry: { seq: event.seq, time: event.time, type: 'progress', phase: trace.phase },
    }
  }
  if (trace.kind === 'terminal') {
    return {
      key: trace.sourceSequence === undefined
        ? `event:${String(event.seq)}`
        : `progress:${String(trace.sourceSequence)}`,
      entry: {
        seq: event.seq,
        time: event.time,
        type: 'terminal',
        code: trace.outcome === 'success' ? 'completed' : 'error',
        outcome: trace.outcome,
      },
    }
  }
  if (trace.kind === 'degraded') {
    return {
      key: `event:${String(event.seq)}`,
      entry: { seq: event.seq, time: event.time, type: 'degraded', code: 'PROGRESS_UNAVAILABLE' },
    }
  }
  const observation = trace.kind === 'usage'
    ? {
      kind: 'usage-updated' as const,
      usage: {
        ...(trace.inputTokens === undefined ? {} : { inputTokens: trace.inputTokens }),
        ...(trace.outputTokens === undefined ? {} : { outputTokens: trace.outputTokens }),
        ...(trace.cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens: trace.cacheReadInputTokens }),
        ...(trace.cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens: trace.cacheWriteInputTokens }),
      },
    }
    : trace.kind === 'native-tool'
      ? { kind: trace.status === 'running' ? 'tool-started' as const : 'tool-completed' as const }
      : { kind: trace.kind }
  return {
    key: `progress:${String(trace.sourceSequence)}`,
    entry: { seq: event.seq, time: event.time, type: 'observation', observation },
  }
}

function toolTraceEntry(
  event: PhysicalSessionEvent,
  trace: ToolTrace,
): { readonly key: string; readonly entry: TrajectoryPhysicalOperatorTraceEntry } {
  return {
    key: `tool:${trace.toolCallId}`,
    entry: {
      seq: event.seq,
      time: event.time,
      type: 'tool',
      tool: {
        toolCallId: trace.toolCallId,
        status: trace.status,
        ...(trace.argumentsShape === undefined ? {} : { argumentsShape: trace.argumentsShape }),
        ...(trace.resultShape === undefined ? {} : { resultShape: trace.resultShape }),
        ...(trace.status === 'running' ? { callSeq: event.seq } : { resultSeq: event.seq }),
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
  // A proven settlement is immutable; an indeterminate receipt may still
  // accept a later Host-projected durable result.
  if (previous.tool.status === 'completed' || previous.tool.status === 'error') return previous
  if (next.tool.status === 'running') return previous
  if (previous.tool.status === 'indeterminate' && next.tool.status === 'indeterminate') return previous
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

/** Command-scoped projection consuming only the Host-built public trace. */
const trajectoryPhysicalOperatorDefinition: ConversationNodeDefinition<PhysicalOperatorState> = {
  kind: 'trajectory-physical-operator-execution',
  target: 'trajectory',
  match: (event, input) => {
    const trace = input?.physicalOperatorTrace
    if (trace === undefined) return null
    if (trace.kind === 'dispatch') return { id: trace.commandId, role: 'start' }
    if (trace.kind === 'tool' && trace.standalone && eventTypeIs(event, 'physical-operator/tool-call')) {
      return { id: trace.commandId, role: 'start' }
    }
    return { id: trace.commandId, role: 'update' }
  },
  start: (_context, match) => {
    const trace = match.physicalOperatorTrace
    const event = physicalEvent(match)
    if (trace?.kind === 'dispatch') {
      return {
        commandId: trace.commandId,
        operatorId: trace.operator,
        turn: trace.turn,
        step: trace.step,
        dispatchSeq: event.seq,
        dispatchTime: event.time,
        entries: new Map([['dispatch', { seq: event.seq, time: event.time, type: 'dispatch' }]]),
      }
    }
    if (trace?.kind !== 'tool' || !trace.standalone) {
      throw new Error('trajectory physical-operator execution requires a public dispatch start')
    }
    const tool = toolTraceEntry(event, trace)
    return {
      commandId: trace.commandId,
      operatorId: 'physical-operator',
      turn: 0,
      step: 0,
      dispatchSeq: event.seq,
      dispatchTime: event.time,
      entries: new Map([
        ['dispatch', { seq: event.seq, time: event.time, type: 'dispatch' }],
        [tool.key, tool.entry],
      ]),
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
  publication: match => match.physicalOperatorTrace?.kind === 'progress' ? 'animation-frame' : 'immediate',
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.dispatchSeq, {
      kind: 'physical-operator',
      execution: execution(context.state),
    }),
}

/**
 * Register the Host-projected Physical Operator trace Definition.
 *
 * @param ctx - Client Context that owns the conversation event registry.
 */
export function registerTrajectoryPhysicalOperatorDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryPhysicalOperatorDefinition)
}
