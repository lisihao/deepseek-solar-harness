/** Host-only projection from Physical Operator authority events to public trace data. */

import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  PhysicalOperatorTraceView, PhysicalOperatorValueShape,
} from './api/events.ts'

/** Public, sanitized projection of an authority Session event. */
export interface PublicSessionEventProjection {
  readonly event: SessionEvent
  readonly physicalOperatorTrace?: PhysicalOperatorTraceView
}

interface PhysicalEventEnvelope {
  readonly type: string
  readonly data: unknown
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function publicIdentity(value: unknown): string | undefined {
  const source = nonEmptyString(value)
  if (source === undefined) return undefined
  const digest = createHash('sha256').update('physical-operator-trace\0').update(source).digest('hex')
  return `trace-${digest.slice(0, 24)}`
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function operator(value: unknown): 'codex' | 'claude-code' | 'physical-operator' {
  return value === 'codex' || value === 'claude-code' ? value : 'physical-operator'
}

function valueShape(value: unknown): PhysicalOperatorValueShape {
  if (value === null) return { kind: 'null' }
  if (typeof value === 'string') return { kind: 'string', characters: value.length }
  if (typeof value === 'number') return { kind: 'number' }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (Array.isArray(value)) return { kind: 'array', items: value.length }
  if (typeof value === 'object') return { kind: 'object', fields: Object.keys(value).length }
  return { kind: 'unavailable' }
}

function progressPhase(value: unknown): Extract<PhysicalOperatorTraceView, { kind: 'progress' }>['phase'] {
  switch (value) {
    case 'connecting': return 'connecting'
    case 'session_ready': return 'session-ready'
    case 'reasoning': return 'reasoning'
    case 'tool_activity': return 'tool-activity'
    case 'finalizing': return 'finalizing'
    default: return 'working'
  }
}

function observationTrace(
  commandId: string,
  sourceSequence: number,
  value: unknown,
): PhysicalOperatorTraceView | undefined {
  const data = record(value)
  switch (data?.kind) {
    case 'public-output': return { version: 1, kind: 'public-output', commandId, sourceSequence }
    case 'tool-started': return { version: 1, kind: 'native-tool', commandId, sourceSequence, status: 'running' }
    case 'tool-completed': return { version: 1, kind: 'native-tool', commandId, sourceSequence, status: 'completed' }
    case 'approval-required': return { version: 1, kind: 'approval-required', commandId, sourceSequence }
    case 'usage-updated': {
      const usage = record(data.usage)
      if (usage === undefined) return undefined
      const inputTokens = finiteNumber(usage.inputTokens)
      const outputTokens = finiteNumber(usage.outputTokens)
      const cacheReadInputTokens = finiteNumber(usage.cacheReadInputTokens)
      const cacheWriteInputTokens = finiteNumber(usage.cacheWriteInputTokens)
      if (inputTokens === undefined && outputTokens === undefined
        && cacheReadInputTokens === undefined && cacheWriteInputTokens === undefined) return undefined
      return {
        version: 1,
        kind: 'usage',
        commandId,
        sourceSequence,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
        ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
      }
    }
    default: return undefined
  }
}

function toolTrace(
  event: PhysicalEventEnvelope,
  data: Record<string, unknown>,
): PhysicalOperatorTraceView | undefined {
  const commandId = publicIdentity(data.executionCommandId ?? data.commandId)
  const toolCallId = publicIdentity(data.toolCallId ?? data.commandId)
  if (commandId === undefined || toolCallId === undefined) return undefined
  if (event.type === 'physical-operator/tool-call') {
    return {
      version: 1,
      kind: 'tool',
      commandId,
      toolCallId,
      standalone: data.executionCommandId === undefined,
      status: 'running',
      argumentsShape: valueShape(data.arguments),
    }
  }
  if (event.type === 'physical-operator/tool-indeterminate') {
    return {
      version: 1,
      kind: 'tool',
      commandId,
      toolCallId,
      standalone: data.executionCommandId === undefined,
      status: 'indeterminate',
    }
  }
  const result = record(data.result)
  const isError = result?.isError === true || result?.error !== undefined
  const resultValue = result === undefined
    ? data.result
    : result.value === undefined ? result.content : result.value
  return {
    version: 1,
    kind: 'tool',
    commandId,
    toolCallId,
    standalone: data.executionCommandId === undefined,
    status: isError ? 'error' : 'completed',
    resultShape: valueShape(resultValue),
  }
}

function traceFor(event: PhysicalEventEnvelope): PhysicalOperatorTraceView | undefined {
  const data = record(event.data)
  if (data === undefined) return undefined
  if (event.type === 'physical-operator/tool-call'
    || event.type === 'physical-operator/tool-result'
    || event.type === 'physical-operator/tool-indeterminate') return toolTrace(event, data)
  const commandId = publicIdentity(data.commandId)
  if (commandId === undefined) return undefined
  if (event.type === 'physical-operator/dispatch' || event.type === 'physical-operator/tool-dispatch') {
    return {
      version: 1,
      kind: 'dispatch',
      commandId,
      operator: operator(data.operatorId),
      turn: event.type === 'physical-operator/dispatch' ? nonNegativeInteger(data.turn) : 0,
      step: event.type === 'physical-operator/dispatch' ? nonNegativeInteger(data.step) : 0,
    }
  }
  if (event.type === 'physical-operator/dispatch-terminal') {
    return { version: 1, kind: 'terminal', commandId, outcome: 'error' }
  }
  if (event.type === 'physical-operator/trace-degraded') {
    return { version: 1, kind: 'degraded', commandId }
  }
  if (event.type !== 'physical-operator/progress') return undefined
  const native = record(data.data)
  const sourceSequence = nonNegativeInteger(data.sequence)
  if (data.type === 'turn.progress') {
    return { version: 1, kind: 'progress', commandId, sourceSequence, phase: progressPhase(native?.phase) }
  }
  if (data.type === 'turn.settled') {
    return {
      version: 1,
      kind: 'terminal',
      commandId,
      sourceSequence,
      outcome: native?.stopReason === 'completed' ? 'success' : 'error',
    }
  }
  return data.type === 'turn.observation' ? observationTrace(commandId, sourceSequence, native) : undefined
}

/**
 * Build the event delivered over public Host transports. Physical Operator
 * authority payload is always removed, including for unknown future events in
 * the namespace; recognized events additionally receive a fixed safe trace.
 *
 * @param event - Authority Session event to project.
 * @returns Public event with the raw Physical Operator payload removed and an optional safe trace.
 */
export function projectPublicSessionEvent(event: SessionEvent): PublicSessionEventProjection {
  const physicalEvent = event as PhysicalEventEnvelope
  if (!physicalEvent.type.startsWith('physical-operator/')) return { event }
  const physicalOperatorTrace = traceFor(physicalEvent)
  const publicEvent = { ...event, data: {} } as SessionEvent
  return {
    event: publicEvent,
    ...(physicalOperatorTrace === undefined ? {} : { physicalOperatorTrace }),
  }
}
