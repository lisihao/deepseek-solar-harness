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

const MAX_PUBLIC_PREVIEW_CHARS = 1_600
const MAX_PUBLIC_LABEL_CHARS = 160

/** Keep only bounded, credential-scrubbed display text at the public boundary. */
function scrubPublicText(value: unknown, limit: number) {
  if (typeof value !== 'string') return undefined
  const scrubbed = value
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu, '[REDACTED]')
    .replace(/\b(?:api[_-]?key|authorization|password|token|secret)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+)\b/gu, '[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .slice(0, limit)
  return scrubbed.length === 0 ? undefined : scrubbed
}

function toolResultPreviews(
  data: Record<string, unknown>,
  isError: boolean,
): Pick<Extract<PhysicalOperatorTraceView, { kind: 'tool' }>, 'resultPreview' | 'errorPreview'> {
  // Legacy tool receipts contain raw provider output under `result`. It is
  // intentionally shape-only at this boundary. A producer must opt in to
  // display text by writing one of the explicit public fields below; this
  // keeps an old log from becoming a data-exfiltration channel when replayed.
  const result = record(data.result)
  const publicResultPreview = scrubPublicText(
    data.publicResultPreview ?? result?.publicResultPreview,
    MAX_PUBLIC_PREVIEW_CHARS,
  )
  const publicErrorPreview = scrubPublicText(
    data.publicErrorPreview ?? result?.publicErrorPreview,
    MAX_PUBLIC_PREVIEW_CHARS,
  )
  if (isError) return publicErrorPreview === undefined ? {} : { errorPreview: publicErrorPreview }
  return publicResultPreview === undefined ? {} : { resultPreview: publicResultPreview }
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
    case 'public-output': {
      const preview = scrubPublicText(data.preview, MAX_PUBLIC_PREVIEW_CHARS)
      return {
        version: 1, kind: 'public-output', commandId, sourceSequence,
        ...(preview === undefined ? {} : { preview }),
      }
    }
    case 'tool-started':
    case 'tool-completed': {
      const toolName = scrubPublicText(data.toolName, MAX_PUBLIC_LABEL_CHARS)
      return {
        version: 1,
        kind: 'native-tool',
        commandId,
        sourceSequence,
        status: data.kind === 'tool-started' ? 'running' : 'completed',
        ...(toolName === undefined ? {} : { toolName }),
      }
    }
    case 'approval-required': {
      const approvalKind = scrubPublicText(data.approvalKind, MAX_PUBLIC_LABEL_CHARS)
      const preview = scrubPublicText(data.preview, MAX_PUBLIC_PREVIEW_CHARS)
      return {
        version: 1, kind: 'approval-required', commandId, sourceSequence,
        ...(approvalKind === undefined ? {} : { approvalKind }),
        ...(preview === undefined ? {} : { preview }),
      }
    }
    case 'usage-updated': {
      const usage = record(data.usage)
      if (usage === undefined) return undefined
      const inputTokens = finiteNumber(usage.inputTokens)
      const outputTokens = finiteNumber(usage.outputTokens)
      const cacheReadInputTokens = finiteNumber(usage.cacheReadInputTokens)
      const cacheWriteInputTokens = finiteNumber(usage.cacheWriteInputTokens)
      const costUsd = finiteNumber(usage.costUsd)
      if (inputTokens === undefined && outputTokens === undefined
        && cacheReadInputTokens === undefined && cacheWriteInputTokens === undefined && costUsd === undefined) return undefined
      return {
        version: 1,
        kind: 'usage',
        commandId,
        sourceSequence,
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
        ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
        ...(costUsd === undefined ? {} : { costUsd }),
      }
    }
    default: return undefined
  }
}

function toolTrace(
  event: PhysicalEventEnvelope,
  data: Record<string, unknown>,
): PhysicalOperatorTraceView | undefined {
  const executionCommandId = publicIdentity(data.executionCommandId)
  const commandId = executionCommandId ?? publicIdentity(data.commandId)
  const toolCallId = publicIdentity(data.toolCallId ?? data.commandId)
  const toolName = scrubPublicText(data.publicToolName, MAX_PUBLIC_LABEL_CHARS)
  if (commandId === undefined || toolCallId === undefined) return undefined
  if (event.type === 'physical-operator/tool-call') {
    return {
      version: 1,
      kind: 'tool',
      commandId,
      toolCallId,
      standalone: executionCommandId === undefined,
      status: 'running',
      argumentsShape: valueShape(data.arguments),
      ...(toolName === undefined ? {} : { toolName }),
    }
  }
  if (event.type === 'physical-operator/tool-indeterminate') {
    return {
      version: 1,
      kind: 'tool',
      commandId,
      toolCallId,
      standalone: executionCommandId === undefined,
      status: 'indeterminate',
      ...(toolName === undefined ? {} : { toolName }),
    }
  }
  const result = record(data.result)
  const isError = result?.isError === true || result?.error !== undefined
  const resultValue = result === undefined
    ? data.result
    : result.value === undefined ? result.content : result.value
  const previews = toolResultPreviews(data, isError)
  return {
    version: 1,
    kind: 'tool',
    commandId,
    toolCallId,
    standalone: executionCommandId === undefined,
    status: isError ? 'error' : 'completed',
    resultShape: valueShape(resultValue),
    ...(toolName === undefined ? {} : { toolName }),
    ...previews,
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

/** The model route of native physical operators (`NATIVE_CATALOG_PROVIDER` in the physical-operator package). */
export const NATIVE_ROUTE_PROVIDER = 'dsh-physical-operator'

/** A native model and effort as the Resident daemon or a dispatch named them. */
export interface NativeProfile {
  readonly model?: string
  readonly effort?: string
}

/**
 * The model and effort the Resident daemon resolved for a command, from its `turn.accepted` progress. Smart Auto picks
 * them when the dispatch names none.
 * @param events - one session's ordered durable log.
 * @param commandId - the dispatch's command.
 * @returns the resolved profile, or `undefined` when none was projected.
 */
export function resolvedNativeProfile(events: readonly SessionEvent[], commandId: string | undefined): NativeProfile | undefined {
  if (commandId === undefined) return undefined
  for (const event of events) {
    if ((event.type as string) !== 'physical-operator/progress') continue
    const data = event.data as { commandId?: string; type?: string; data?: { profile?: NativeProfile } }
    if (data.commandId === commandId && data.type === 'turn.accepted') return data.data?.profile
  }
  return undefined
}

/**
 * The native profile a router reply was served with: the newest dispatch of the same turn and step to that operator,
 * with the daemon's resolved profile preferred over the one the dispatch named.
 * @param events - one session's ordered durable log.
 * @param reply - an `assistant/message` event from the native route.
 * @returns the profile, or `undefined` when no dispatch names a model.
 */
function servedNativeProfile(events: readonly SessionEvent[], reply: SessionEvent): NativeProfile | undefined {
  const { turn, step, message } = reply.data as { turn?: number; step?: number; message?: { source?: { model?: string } } }
  const source = message?.source
  for (const event of events.toReversed()) {
    if (event.seq >= reply.seq || (event.type as string) !== 'physical-operator/dispatch') continue
    const data = event.data as { commandId?: string; operatorId?: string; turn?: number; step?: number; residentProfile?: NativeProfile }
    if (data.operatorId !== source?.model || data.turn !== turn || data.step !== step) continue
    const profile = resolvedNativeProfile(events, data.commandId) ?? data.residentProfile
    return profile?.model === undefined ? undefined : profile
  }
  return undefined
}

/**
 * Tell the client which native model and effort served a router reply. The reply is logged under the operator id alone,
 * so the public view names `<operator>:<model>` and the effort; the stored event is untouched.
 * @param projection - the public projection of one event.
 * @param events - one session's ordered durable log.
 * @returns the projection, with the served configuration on a native reply whose dispatch names a model.
 */
export function withServedNativeConfig(
  projection: PublicSessionEventProjection,
  events: readonly SessionEvent[],
): PublicSessionEventProjection {
  const { event } = projection
  if (event.type !== 'assistant/message') return projection
  const message = event.data.message
  if (message.source.provider !== NATIVE_ROUTE_PROVIDER) return projection
  const profile = servedNativeProfile(events, event)
  if (profile?.model === undefined) return projection
  const source = {
    ...message.source,
    model: `${message.source.model}:${profile.model}`,
    ...profile.effort === undefined ? {} : { reasoningEffort: profile.effort },
  }
  return { ...projection, event: { ...event, data: { ...event.data, message: { ...message, source } } } }
}
