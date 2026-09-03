import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  TrajectoryDebateClaim, TrajectoryDebateExecution, TrajectoryDebateRole,
  TrajectoryDebateProgress, TrajectoryDebateTraceEntry,
} from './trajectory-contract.ts'
import { trajectoryNode } from './trajectory-definition-common.ts'

const TRACE_EVENT_TYPE = 'debate/trace'

interface DebateTracePayload {
  readonly runId: string
  readonly sourceSequence: number
  readonly state: string
  readonly topic?: string
  readonly sessionTurn?: number
  readonly sessionStep?: number
  readonly entry: Omit<TrajectoryDebateTraceEntry, 'seq' | 'time' | 'sourceSequence'>
}

interface DebateTraceState {
  readonly runId: string
  readonly topic?: string
  readonly turn: number
  readonly step: number
  readonly dispatchSeq: number
  readonly dispatchTime: number
  readonly entries: ReadonlyMap<number, TrajectoryDebateTraceEntry>
}

function object(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function publicRole(value: unknown): TrajectoryDebateRole | undefined {
  const input = object(value)
  if (input === undefined) return undefined
  const requested = object(input.requested)
  const title = string(input.title)
  const kind = string(input.kind)
  const requestedOperatorId = requested === undefined ? undefined : string(requested.operatorId)
  const requestedModel = requested === undefined ? undefined : string(requested.model)
  if (title === undefined
    || (kind !== 'participant' && kind !== 'judge' && kind !== 'moderator')
    || requestedOperatorId === undefined
    || requestedModel === undefined) return undefined
  const actual = object(input.actual)
  const actualOperatorId = actual === undefined ? undefined : string(actual.operatorId)
  const actualModel = actual === undefined ? undefined : string(actual.model)
  const actualRoute = actualOperatorId !== undefined && actualModel !== undefined
  const fallbackReasonCode = string(input.fallbackReasonCode)
  return {
    title,
    kind,
    requestedOperatorId,
    requestedModel,
    ...(actualRoute ? { actualOperatorId, actualModel } : {}),
    ...(fallbackReasonCode === undefined
      ? {}
      : { fallbackReasonCode }),
  }
}

function publicClaims(value: unknown): readonly TrajectoryDebateClaim[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const input = object(candidate)
    if (input === undefined) return []
    const statement = string(input.statement)
    const status = string(input.status)
    const severity = string(input.severity)
    return statement === undefined || status === undefined || severity === undefined
      ? []
      : [{ statement, status, severity }]
  })
}

function publicEvidenceRefs(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    const ref = string(object(candidate)?.ref)
    return ref === undefined ? [] : [ref]
  })
}

function publicUsage(value: unknown): TrajectoryDebateTraceEntry['usage'] | undefined {
  const input = object(value)
  if (input === undefined) return undefined
  const inputTokens = nonNegativeInteger(input.inputTokens)
  const outputTokens = nonNegativeInteger(input.outputTokens)
  const cacheReadInputTokens = nonNegativeInteger(input.cacheReadInputTokens)
  const cacheWriteInputTokens = nonNegativeInteger(input.cacheWriteInputTokens)
  const costUsd = finiteNumber(input.costUsd)
  if (inputTokens === undefined
    && outputTokens === undefined
    && cacheReadInputTokens === undefined
    && cacheWriteInputTokens === undefined
    && costUsd === undefined) return undefined
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadInputTokens === undefined ? {} : { cacheReadInputTokens }),
    ...(cacheWriteInputTokens === undefined ? {} : { cacheWriteInputTokens }),
    ...(costUsd === undefined ? {} : { costUsd }),
  }
}

function publicProgress(value: unknown): TrajectoryDebateProgress | undefined {
  const input = object(value)
  if (input === undefined) return undefined
  const kind = string(input.kind)
  if (kind !== 'phase'
    && kind !== 'public-output'
    && kind !== 'tool-started'
    && kind !== 'tool-completed'
    && kind !== 'approval-required'
    && kind !== 'usage-updated') return undefined
  const sourceTime = string(input.sourceTime)
  if (sourceTime === undefined) return undefined
  const phase = string(input.phase)
  const publicOutputPreview = string(input.publicOutputPreview)
  const toolName = string(input.toolName)
  const approvalKind = string(input.approvalKind)
  const approvalPreview = string(input.approvalPreview)
  const usage = publicUsage(input.usage)
  const progress: {
    kind: TrajectoryDebateProgress['kind']
    sourceTime: string
    phase?: string
    publicOutputPreview?: string
    toolName?: string
    approvalKind?: string
    approvalPreview?: string
    usage?: NonNullable<TrajectoryDebateProgress['usage']>
  } = { kind, sourceTime }
  if (phase !== undefined) progress.phase = phase
  if (publicOutputPreview !== undefined) progress.publicOutputPreview = publicOutputPreview
  if (toolName !== undefined) progress.toolName = toolName
  if (approvalKind !== undefined) progress.approvalKind = approvalKind
  if (approvalPreview !== undefined) progress.approvalPreview = approvalPreview
  if (usage !== undefined) progress.usage = usage
  return progress
}

function publicConvergence(value: unknown): TrajectoryDebateTraceEntry['convergence'] | undefined {
  const input = object(value)
  if (input === undefined) return undefined
  const status = string(input.status)
  const score = finiteNumber(input.score)
  const threshold = finiteNumber(input.threshold)
  const reason = string(input.reason)
  return status === undefined || score === undefined || threshold === undefined || reason === undefined
    ? undefined
    : { status, score, threshold, reason }
}

function publicSynthesis(value: unknown): TrajectoryDebateTraceEntry['synthesis'] | undefined {
  const input = object(value)
  if (input === undefined) return undefined
  const state = string(input.state)
  const unresolvedCount = nonNegativeInteger(input.unresolvedCount)
  const dissentCount = nonNegativeInteger(input.dissentCount)
  const outputPreview = string(input.outputPreview)
  const artifactRef = string(input.artifactRef)
  if (state === undefined || unresolvedCount === undefined || dissentCount === undefined) return undefined
  return {
    state,
    ...(outputPreview === undefined ? {} : { outputPreview }),
    ...(artifactRef === undefined ? {} : { artifactRef }),
    unresolvedCount,
    dissentCount,
  }
}

function debateTrace(event: { readonly type: string; readonly data: unknown }): DebateTracePayload | undefined {
  if (event.type !== TRACE_EVENT_TYPE) return undefined
  const input = object(event.data)
  if (input?.version !== 1) return undefined
  const runId = string(input.runId)
  const sourceSequence = nonNegativeInteger(input.sourceSequence)
  const state = string(input.state)
  if (runId === undefined || sourceSequence === undefined || state === undefined) return undefined
  const output = object(input.publicOutput)
  const topic = string(object(input.topic)?.title)
  const sessionTurn = nonNegativeInteger(input.sessionTurn)
  const sessionStep = nonNegativeInteger(input.sessionStep)
  const round = nonNegativeInteger(input.round)
  const role = publicRole(input.role)
  const publicOutputPreview = string(output?.preview)
  const publicOutputRef = string(output?.ref)
  const usage = publicUsage(input.usage)
  const progress = publicProgress(input.progress)
  if (state === 'progress' && progress === undefined) return undefined
  const convergence = publicConvergence(input.convergence)
  const synthesis = publicSynthesis(input.synthesis)
  return {
    runId,
    sourceSequence,
    state,
    ...(topic === undefined ? {} : { topic }),
    ...(sessionTurn === undefined ? {} : { sessionTurn }),
    ...(sessionStep === undefined ? {} : { sessionStep }),
    entry: {
      state,
      ...(round === undefined ? {} : { round }),
      ...(role === undefined ? {} : { role }),
      ...(publicOutputPreview === undefined ? {} : { publicOutputPreview }),
      ...(publicOutputRef === undefined ? {} : { publicOutputRef }),
      claims: publicClaims(input.claims),
      evidenceRefs: publicEvidenceRefs(input.evidenceRefs),
      ...(usage === undefined ? {} : { usage }),
      ...(progress === undefined ? {} : { progress }),
      ...(convergence === undefined ? {} : { convergence }),
      ...(synthesis === undefined ? {} : { synthesis }),
    },
  }
}

function mergeTraceEntry(
  previous: TrajectoryDebateTraceEntry,
  next: TrajectoryDebateTraceEntry,
): TrajectoryDebateTraceEntry {
  // A replay with the same durable source sequence is the same public fact.
  // Keep its first lifecycle projection, but allow a reconnect to fill a
  // progress field that was unavailable in the initial session event.
  if (previous.progress !== undefined || next.progress === undefined) return previous
  return { ...previous, progress: next.progress }
}

function entry(match: ConversationMatch, trace: DebateTracePayload): TrajectoryDebateTraceEntry {
  return {
    seq: match.event.seq,
    time: match.event.time,
    sourceSequence: trace.sourceSequence,
    ...trace.entry,
  }
}

function execution(state: DebateTraceState): TrajectoryDebateExecution {
  return {
    runId: state.runId,
    ...(state.topic === undefined ? {} : { topic: state.topic }),
    turn: state.turn,
    step: state.step,
    dispatchSeq: state.dispatchSeq,
    dispatchTime: state.dispatchTime,
    entries: [...state.entries.values()]
      .sort((left, right) => left.sourceSequence - right.sourceSequence || left.seq - right.seq),
  }
}

/** Public, durable Debate trace projected as one trajectory execution per run. */
const trajectoryDebateDefinition: ConversationNodeDefinition<DebateTraceState> = {
  kind: 'trajectory-debate-execution',
  target: 'trajectory',
  match: (event) => {
    const trace = debateTrace(event)
    if (trace === undefined) return null
    return {
      id: trace.runId,
      role: trace.state === 'planned' ? 'start' : 'update',
    }
  },
  start: (_context, match) => {
    const trace = debateTrace(match.event)
    if (trace === undefined || trace.state !== 'planned') {
      throw new Error('trajectory debate execution requires a public planned trace start')
    }
    return {
      runId: trace.runId,
      ...(trace.topic === undefined ? {} : { topic: trace.topic }),
      turn: trace.sessionTurn ?? 0,
      step: trace.sessionStep ?? 0,
      dispatchSeq: match.event.seq,
      dispatchTime: match.event.time,
      entries: new Map([[trace.sourceSequence, entry(match, trace)]]),
    }
  },
  update: (context, match) => {
    const trace = debateTrace(match.event)
    if (trace === undefined) return context.state
    const nextEntry = entry(match, trace)
    const previousEntry = context.state.entries.get(trace.sourceSequence)
    if (previousEntry !== undefined) {
      const merged = mergeTraceEntry(previousEntry, nextEntry)
      if (merged === previousEntry) return context.state
      const entries = new Map(context.state.entries)
      entries.set(trace.sourceSequence, merged)
      return { ...context.state, entries }
    }
    const entries = new Map(context.state.entries)
    entries.set(trace.sourceSequence, nextEntry)
    return {
      ...context.state,
      ...(context.state.topic === undefined && trace.topic !== undefined ? { topic: trace.topic } : {}),
      ...(context.state.turn === 0 && trace.sessionTurn !== undefined ? { turn: trace.sessionTurn } : {}),
      ...(context.state.step === 0 && trace.sessionStep !== undefined ? { step: trace.sessionStep } : {}),
      entries,
    }
  },
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.dispatchSeq, {
      kind: 'debate',
      execution: execution(context.state),
    }),
}

/**
 * Register the public Debate trace Definition.
 *
 * @param ctx - Plugin Context receiving the Definition.
 */
export function registerTrajectoryDebateDefinition(ctx: Context): void {
  ctx.conversationEvents.register(trajectoryDebateDefinition)
}
