/** Model-facing Consumer for the provider-neutral Debate seam; a Debate starts only from a kennel Session. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { captureRuntimeContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  DEFAULT_DEBATE_CONVERGENCE,
  DEFAULT_DEBATE_PERSONAS,
  DEFAULT_DEBATE_ROUNDS,
  defaultDebateBudget,
  type DebateControlAction,
  type DebateAgentProgressUsageV1,
  type DebateEventV1,
  type DebatePolicyV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateRuntimeContextV1,
  type DebateStartRequestV1,
  type DebateTraceSessionEventV1,
  type DebateTraceProgressV1,
  type DebateTraceStateV1,
  type DebateTurnRoutingV1,
} from '@deepseek-ai/dsh-debate'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type { DebateExecutionMode, DebateInitialPlan } from './types.ts'

export type * from './types.ts'

export const name = 'tool-debate'
export const inject = ['debates', 'tools', 'systemPrompt']

/** Agent preset whose Sessions may start a Debate. */
const KENNEL_PRESET = 'kennel'
/** A kennel request is the user's explicit choice, so a started Debate is admitted at once. */
const STARTED_MODE = 'enabled' as const satisfies DebateExecutionMode
const MAX_LIST_ITEMS = 20
const MAX_PREVIEW_CHARS = 600
const MAX_REF_ITEMS = 20
const EXPLICIT_DEBATE_APPROVAL_REASON = 'The user explicitly selected Debate for this Session and submitted this request.'
const EXACT_ONE_ROUND_HINT = new RegExp(
  [
    String.raw`\b(?:exactly|just|only)\s+(?:one|1)\s+rounds?\b`,
    String.raw`(?:只|仅|恰好|正好|明确)\s*(?:讨论|进行)?\s*(?:一|1)\s*轮(?:即可|就够)?`,
    String.raw`(?:一|1)\s*轮(?:即可|就够)`,
  ].join('|'),
  'iu',
)
const QUICK_OR_BASIC_DEBATE_HINT = /(?:\b(?:quick|basic|simple)\b|快速|基础(?:讨论|请求|方案)?|简单(?:讨论|请求|方案)?)/iu
const DEEP_OR_SYSTEM_DESIGN_HINT = /(?:\b(?:deep|system[\s-]*design|architecture|multi[\s-]*constraints?)\b|深入|深度|系统设计|架构|多项?约束)/iu
const ROLE_COPY: Readonly<Record<string, { readonly title: string; readonly mandate: string }>> = {
  'constructive-proposer': {
    title: '建设性提案者',
    mandate: '提出可执行的正向方案，并明确前提。',
  },
  'skeptical-falsifier': {
    title: '怀疑式证伪者',
    mandate: '寻找决定性的反例、隐藏前提和失败风险。',
  },
  'evidence-auditor': {
    title: '证据审计员',
    mandate: '核对关键主张是否有直接、可追溯且与决策相关的证据。',
  },
  'decision-judge': {
    title: '决策裁判（主持人）',
    mandate: '综合最有力的主张，保留实质异议并给出明确结论。',
  },
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Durable bounded link from a model tool call to the admitted Debate run. */
    'debate/admission': {
      readonly runId: string
      readonly mode: DebateExecutionMode
      readonly revision: number
      readonly state: string
    }
    /**
     * One bounded public fact from a durable Debate run, keyed by its source event sequence.
     * @param runId Persistent Debate run identity.
     * @param sourceSequence Durable sequence from the Debate Provider.
     */
    'debate/trace': DebateTraceSessionEventV1
  }
}

/**
 * Session-local placement for a Debate trace projection.
 *
 * A model-invoked `debate` tool owns a normal `tool/call`, so its turn and
 * step are recovered from that durable call.
 */
interface DebateTraceDispatch {
  readonly turn?: number
  readonly step?: number
}

type ToolArgs = {
  readonly action: 'start' | 'list' | 'inspect' | 'control'
  readonly prompt?: string
  readonly objective?: string
  readonly run_id?: string
  readonly expected_revision?: number
  readonly control_action?: DebateControlAction
  readonly reason?: string
}

/** Stable default roster: independent advocates, an evidence auditor, then a high-tier judge. */
export const DEFAULT_DEBATE_POLICY: DebatePolicyV1 = Object.freeze({
  version: 1,
  mode: 'enabled',
  roster: Object.freeze([
    Object.freeze({
      version: 1, role: 'constructive-proposer', kind: 'participant', operatorId: 'codex',
      model: 'gpt-5.6-sol', tier: 'high', source: 'native-subscription', required: true,
      persona: DEFAULT_DEBATE_PERSONAS['constructive-proposer'],
    }),
    Object.freeze({
      version: 1, role: 'skeptical-falsifier', kind: 'participant', operatorId: 'claude-code',
      model: 'claude-fable-5', tier: 'medium', source: 'native-subscription', required: true,
      fallbackOperatorIds: Object.freeze(['codex']),
      persona: DEFAULT_DEBATE_PERSONAS['skeptical-falsifier'],
    }),
    Object.freeze({
      version: 1, role: 'evidence-auditor', kind: 'participant', operatorId: 'codex',
      model: 'gpt-5.6-sol', tier: 'high', source: 'native-subscription', required: true,
      persona: DEFAULT_DEBATE_PERSONAS['evidence-auditor'],
    }),
    Object.freeze({
      version: 1, role: 'decision-judge', kind: 'judge', operatorId: 'claude-code',
      model: 'claude-opus-5', tier: 'high', source: 'native-subscription', required: true,
      fallbackOperatorIds: Object.freeze(['codex']),
      persona: DEFAULT_DEBATE_PERSONAS['decision-judge'],
    }),
  ]),
  budget: Object.freeze(defaultDebateBudget(3, 4)),
  rounds: DEFAULT_DEBATE_ROUNDS,
  convergence: DEFAULT_DEBATE_CONVERGENCE,
  preserveDissent: true,
})

/**
 * Resolve the transparent automatic depth policy without treating presentation
 * requests as a request for less deliberation.
 *
 * Exact one-round wording wins over every other cue. An explicit deep or
 * system-design request wins over a quick/basic cue; ordinary requests use
 * the three-round baseline.
 * @param prompt - user request inspected for explicit depth wording.
 * @returns selected initial plan and its user-facing explanation.
 */
export function debateInitialPlanForPrompt(prompt: string): DebateInitialPlan {
  if (EXACT_ONE_ROUND_HINT.test(prompt)) {
    return { plannedRounds: 1, reason: 'explicit-one-round', explanation: '用户明确要求只讨论 1 轮。' }
  }
  if (DEEP_OR_SYSTEM_DESIGN_HINT.test(prompt)) {
    return { plannedRounds: 4, reason: 'deep-or-system-design', explanation: '请求明确涉及深度分析、系统设计、架构或多项约束。' }
  }
  if (QUICK_OR_BASIC_DEBATE_HINT.test(prompt)) {
    return { plannedRounds: 2, reason: 'quick-or-basic', explanation: '请求明确为快速或基础讨论。' }
  }
  return { plannedRounds: 3, reason: 'ordinary', explanation: '普通讨论采用默认深度。' }
}

/**
 * Resolve the automatic policy for a prompt while retaining a caller-supplied
 * policy byte-for-byte, including its monetary cap.
 * @param prompt - user request inspected only when no policy was supplied.
 * @param mode - mode applied to the automatically derived policy.
 * @param explicitPolicy - complete caller-selected policy that must not be rewritten.
 * @returns caller policy or the deterministic automatic policy.
 */
export function debatePolicyForPrompt(
  prompt: string,
  mode: DebatePolicyV1['mode'] = 'enabled',
  explicitPolicy?: DebatePolicyV1,
): DebatePolicyV1 {
  if (explicitPolicy !== undefined) return explicitPolicy
  const plan = debateInitialPlanForPrompt(prompt)
  return {
    ...DEFAULT_DEBATE_POLICY,
    mode,
    budget: defaultDebateBudget(plan.plannedRounds, DEFAULT_DEBATE_POLICY.roster.length),
  }
}

/** Model-visible guidance. Debate is an explicit/automatic strategy, not a second Scheduler. */
export const debateGuidance = 'The debate tool runs a bounded, persistent multi-agent deliberation through the provider-neutral Debate service. Use action=start only in a kennel Session, for a genuinely contested, high-impact decision that benefits from independent proposals, falsification, evidence audit, and a final judge. Do not use Debate for greetings, simple retrieval, or one obvious implementation step. Presentation requests such as concise or three bullets do not reduce depth: explicit one-round requests use one round, explicit quick/basic requests two, ordinary requests three, and explicit deep/system-design/architecture/multi-constraint requests four. Debate preserves dissent, stops early on evidence-backed convergence, caps the roster at four native-subscription agents, and returns bounded status plus artifact references instead of large reports. Use list or inspect after a restart; use control only for an explicit user decision. Debate does not replace the DSH TaskGraph Scheduler and never calls a physical operator directly.'

function jsonObject(value: object): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function preview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.length <= MAX_PREVIEW_CHARS ? value : `${value.slice(0, MAX_PREVIEW_CHARS - 1)}…`
}

function completedRoundCount(run: Pick<DebateRunSnapshotV1, 'rounds'>): number {
  return run.rounds.filter(round => round.state === 'completed').length
}

function boundedSummary(summary: DebateRunSummaryV1, completedRounds: number): Record<string, JsonValue> {
  return jsonObject({
    runId: summary.runId,
    state: summary.state,
    mode: summary.mode,
    currentRound: completedRounds,
    revision: summary.revision,
    unresolvedCount: summary.unresolvedCount,
    cost: summary.cost,
    updatedAt: summary.updatedAt,
  })
}

function boundedRun(run: DebateRunSnapshotV1): Record<string, JsonValue> {
  return jsonObject({
    runId: run.runId,
    state: run.state,
    mode: run.mode,
    currentRound: completedRoundCount(run),
    revision: run.revision,
    roster: run.roster.slice(0, MAX_REF_ITEMS).map(role => ({
      role: role.role,
      kind: role.kind,
      title: preview(role.persona.title),
      mandate: preview(role.persona.mandate),
      operatorId: role.operatorId,
      model: role.model,
      ...role.fallbackOperatorIds === undefined ? {} : { fallbackOperatorIds: role.fallbackOperatorIds },
    })),
    rounds: run.rounds.slice(0, MAX_REF_ITEMS).map(round => ({
      round: round.round,
      state: round.state,
      turns: round.turns.slice(0, MAX_REF_ITEMS).map(turn => ({
        round: turn.round,
        slotId: turn.slotId,
        role: turn.role,
        operatorId: turn.operatorId,
        model: turn.model,
        state: turn.state,
        ...turn.attempt === undefined ? {} : { attempt: turn.attempt },
        ...turn.routing === undefined ? {} : {
          routing: {
            requestedOperatorId: turn.routing.requestedOperatorId,
            requestedModel: turn.routing.requestedModel,
            ...turn.routing.actualOperatorId === undefined ? {} : { actualOperatorId: turn.routing.actualOperatorId },
            ...turn.routing.actualModel === undefined ? {} : { actualModel: turn.routing.actualModel },
            ...turn.routing.fallbackReasonCode === undefined ? {} : { fallbackReasonCode: turn.routing.fallbackReasonCode },
            ...turn.routing.allocationPlanRef === undefined ? {} : { allocationPlanRef: preview(turn.routing.allocationPlanRef) },
          },
        },
        ...turn.blockers === undefined ? {} : {
          blockers: turn.blockers.slice(0, MAX_REF_ITEMS).map(blocker => ({
            code: blocker.code,
            message: preview(blocker.message),
            ...blocker.nodeId === undefined ? {} : { nodeId: blocker.nodeId },
          })),
        },
        ...turn.outputRef === undefined ? {} : { outputRef: preview(turn.outputRef) },
        ...turn.outputPreview === undefined ? {} : { outputPreview: preview(turn.outputPreview) },
      })),
      ...round.convergence === undefined ? {} : { convergence: round.convergence },
    })),
    convergence: run.rounds.at(-1)?.convergence,
    unresolved: run.unresolved.slice(0, MAX_REF_ITEMS).map(item => ({
      claimId: item.claimId,
      severity: item.severity,
      blocking: item.blocking,
      description: preview(item.description),
    })),
    dissent: run.dissent.slice(0, MAX_REF_ITEMS).map(item => ({
      slotId: item.slotId,
      claimId: item.claimId,
      position: preview(item.position),
      confidence: item.confidence,
    })),
    evidenceRefs: run.evidence.refs.slice(0, MAX_REF_ITEMS).map(item => item.ref),
    cost: run.cost,
    synthesis: run.synthesis === undefined ? undefined : {
      state: run.synthesis.state,
      artifactRef: run.synthesis.artifactRef,
      outputPreview: preview(run.synthesis.outputPreview),
      unresolvedClaimIds: run.synthesis.unresolvedClaimIds.slice(0, MAX_REF_ITEMS),
      dissentCount: run.synthesis.dissentCount,
    },
    updatedAt: run.updatedAt,
  })
}

function commandId(sessionId: string | undefined, callId: string): string {
  const digest = createHash('sha256').update(`${sessionId ?? 'headless'}\0${callId}`).digest('hex').slice(0, 32)
  return `debate-tool-${digest}`
}

function approvalCommandId(startCommandId: string): string {
  const digest = createHash('sha256').update(startCommandId).digest('hex').slice(0, 32)
  return `debate-approval-${digest}`
}

async function approveExplicitDebate(
  ctx: Context,
  run: DebateRunSnapshotV1,
  startCommandId: string,
): Promise<DebateRunSnapshotV1> {
  if (run.state !== 'awaiting_approval') return run
  return ctx.debates.control({
    version: 1,
    commandId: approvalCommandId(startCommandId),
    runId: run.runId,
    expectedRevision: run.revision,
    action: 'approve',
    reason: EXPLICIT_DEBATE_APPROVAL_REASON,
  })
}

function toolTraceDispatch(agent: Agent, callId: string): DebateTraceDispatch {
  const call = agent.session.events.findLast(event => event.type === 'tool/call'
    && String(event.data.callId) === callId
    && event.data.name === 'debate')
  if (call?.type !== 'tool/call') return {}
  return { turn: call.data.turn, step: call.data.step }
}

/** Capture the owning request's rendered preference and memory contexts. */
function debateRuntimeContext(agent: Agent): DebateRuntimeContextV1 | undefined {
  return captureRuntimeContextSnapshot(agent.session.deriveMessages(), String(agent.id))
}

function roleTitle(role: string, roster?: DebateRunSnapshotV1['roster']): string {
  const localized = ROLE_COPY[role]?.title
  if (localized !== undefined) return localized
  const configured = roster?.find(candidate => candidate.role === role)?.persona.title
  return configured === undefined || configured.trim().length === 0 ? '参与者' : configured
}

function traceTopic(run: DebateRunSnapshotV1): NonNullable<DebateTraceSessionEventV1['topic']> {
  if (run.topic !== undefined) return run.topic
  if (run.objective !== undefined && run.objective.trim().length > 0) {
    return { version: 1, title: preview(run.objective) ?? '', source: 'objective' }
  }
  return { version: 1, title: '历史记录缺少议题正文', source: 'legacy-missing' }
}

function traceState(event: DebateEventV1): DebateTraceStateV1 | undefined {
  switch (event.type) {
    case 'debate.planned': return 'planned'
    case 'debate.roster.qualified':
    case 'debate.admitted':
    case 'debate.round.started': return 'running'
    case 'debate.agent.dispatched': return 'dispatched'
    case 'debate.agent.progress': return 'progress'
    case 'debate.agent.settled': return 'settled'
    case 'debate.agent.blocked': return 'blocked'
    case 'debate.agent.failed': return 'failed'
    case 'debate.agent.indeterminate': return 'indeterminate'
    case 'debate.claims.compiled': return 'round-completed'
    case 'debate.convergence.evaluated': {
      const status = event.data.status
      if (status === 'budget_limited') return 'budget-limited'
      if (status === 'max_rounds') return 'max-rounds'
      return 'round-completed'
    }
    case 'debate.synthesis.started': return 'synthesis-running'
    case 'debate.synthesis.settled': return 'synthesis-settled'
    case 'debate.stopped': return 'stopped'
    case 'debate.roster.rejected':
    case 'debate.failed': return 'failed'
    case 'debate.indeterminate': return 'indeterminate'
    case 'debate.cost.accounted': return undefined
    default: return undefined
  }
}

function turnForTraceEvent(
  run: DebateRunSnapshotV1,
  event: DebateEventV1,
): DebateRunSnapshotV1['rounds'][number]['turns'][number] | undefined {
  if (event.round === undefined || event.slotId === undefined) return undefined
  return run.rounds.find(round => round.round === event.round)?.turns
    .find(turn => turn.slotId === event.slotId)
}

function traceRole(
  run: DebateRunSnapshotV1,
  turn: DebateRunSnapshotV1['rounds'][number]['turns'][number],
  includeActualRoute: boolean,
  routingOverride?: DebateTurnRoutingV1,
): NonNullable<DebateTraceSessionEventV1['role']> {
  const routing = routingOverride ?? turn.routing
  const requestedOperatorId = routing?.requestedOperatorId ?? turn.operatorId
  const requestedModel = routing?.requestedModel ?? turn.model
  const actualOperatorId = routing?.actualOperatorId
  const actualModel = routing?.actualModel
  return {
    title: roleTitle(turn.role, run.roster),
    kind: turn.role === 'decision-judge' ? 'judge' : 'participant',
    requested: { operatorId: requestedOperatorId, model: requestedModel },
    ...(!includeActualRoute || actualOperatorId === undefined || actualModel === undefined
      ? {}
      : { actual: { operatorId: actualOperatorId, model: actualModel } }),
    ...(!includeActualRoute || routing?.fallbackReasonCode === undefined
      ? {}
      : { fallbackReasonCode: routing.fallbackReasonCode }),
  }
}

function traceProgressText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  return preview(value.replace(/[\u0000-\u001f\u007f]/gu, ''))
}

function traceProgressUsage(value: unknown): DebateAgentProgressUsageV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const usage: {
    inputTokens?: number
    outputTokens?: number
    cacheReadInputTokens?: number
    cacheWriteInputTokens?: number
    costUsd?: number
  } = {}
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'costUsd'] as const) {
    const counter = source[field]
    if (typeof counter === 'number' && Number.isFinite(counter) && counter >= 0) usage[field] = counter
  }
  return Object.keys(usage).length === 0 ? undefined : usage
}

function traceProgressRouting(value: unknown): DebateTurnRoutingV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const routing = value as Record<string, unknown>
  if (routing.version !== 1 || typeof routing.requestedOperatorId !== 'string' || typeof routing.requestedModel !== 'string') {
    return undefined
  }
  const requestedOperatorId = traceProgressText(routing.requestedOperatorId)
  const requestedModel = traceProgressText(routing.requestedModel)
  if (requestedOperatorId === undefined || requestedModel === undefined) return undefined
  const actualOperatorId = traceProgressText(routing.actualOperatorId)
  const actualModel = traceProgressText(routing.actualModel)
  const fallbackReasonCode = traceProgressText(routing.fallbackReasonCode)
  return {
    version: 1,
    requestedOperatorId,
    requestedModel,
    ...(actualOperatorId === undefined ? {} : { actualOperatorId }),
    ...(actualModel === undefined ? {} : { actualModel }),
    ...(fallbackReasonCode === undefined ? {} : { fallbackReasonCode }),
  }
}

function traceProgress(event: DebateEventV1): {
  readonly progress: DebateTraceProgressV1
  readonly routing?: DebateTurnRoutingV1
} | undefined {
  if (event.type !== 'debate.agent.progress') return undefined
  const sourceTime = traceProgressText(event.data.orchestrationTime)
  const kind = event.data.kind
  if (sourceTime === undefined || !Number.isFinite(Date.parse(sourceTime)) || typeof kind !== 'string') return undefined
  const routing = traceProgressRouting(event.data.routing)
  const base = { sourceTime: new Date(sourceTime).toISOString() }
  switch (kind) {
    case 'phase': {
      const phase = traceProgressText(event.data.phase)
      return phase === undefined ? undefined : { progress: { kind, ...base, phase }, ...(routing === undefined ? {} : { routing }) }
    }
    case 'public-output': {
      const publicOutputPreview = traceProgressText(event.data.publicOutputPreview)
      return publicOutputPreview === undefined
        ? undefined
        : { progress: { kind, ...base, publicOutputPreview }, ...(routing === undefined ? {} : { routing }) }
    }
    case 'tool-started':
    case 'tool-completed': {
      const toolName = traceProgressText(event.data.toolName)
      return toolName === undefined ? undefined : { progress: { kind, ...base, toolName }, ...(routing === undefined ? {} : { routing }) }
    }
    case 'approval-required': {
      const approvalKind = traceProgressText(event.data.approvalKind)
      const approvalPreview = traceProgressText(event.data.approvalPreview)
      return approvalKind === undefined
        ? undefined
        : {
          progress: {
            kind,
            ...base,
            approvalKind,
            ...(approvalPreview === undefined ? {} : { approvalPreview }),
          },
          ...(routing === undefined ? {} : { routing }),
        }
    }
    case 'usage-updated': {
      const usage = traceProgressUsage(event.data.usage)
      return usage === undefined ? undefined : { progress: { kind, ...base, usage }, ...(routing === undefined ? {} : { routing }) }
    }
    default: return undefined
  }
}

function traceClaims(
  run: DebateRunSnapshotV1,
  turn: DebateRunSnapshotV1['rounds'][number]['turns'][number],
): readonly NonNullable<DebateTraceSessionEventV1['claims']>[number][] {
  return turn.claimIds.slice(0, MAX_REF_ITEMS).flatMap((id) => {
    const claim = run.claimLedger.claims.find(candidate => candidate.claimId === id)
    return claim === undefined ? [] : [{
      statement: preview(claim.statement) ?? '',
      status: claim.status,
      severity: claim.severity,
    }]
  })
}

function traceSynthesis(run: DebateRunSnapshotV1): DebateTraceSessionEventV1['synthesis'] | undefined {
  const synthesis = run.synthesis
  if (synthesis === undefined) return undefined
  const outputPreview = preview(synthesis.outputPreview)
  return {
    state: synthesis.state,
    ...(outputPreview === undefined ? {} : { outputPreview }),
    ...(synthesis.artifactRef === undefined ? {} : { artifactRef: synthesis.artifactRef }),
    unresolvedCount: synthesis.unresolvedClaimIds.length,
    dissentCount: synthesis.dissentCount,
  }
}

/**
 * Project the synthesis-start event without borrowing settled output from a
 * later run snapshot. The source event carries no final text, so this trace
 * deliberately exposes only the running state and bounded counters.
 */
function traceSynthesisStarted(run: DebateRunSnapshotV1): DebateTraceSessionEventV1['synthesis'] | undefined {
  const synthesis = run.synthesis
  if (synthesis === undefined) return undefined
  return {
    state: 'running',
    unresolvedCount: synthesis.unresolvedClaimIds.length,
    dissentCount: synthesis.dissentCount,
  }
}

function tracePublicOutput(
  turn: DebateRunSnapshotV1['rounds'][number]['turns'][number],
): DebateTraceSessionEventV1['publicOutput'] | undefined {
  const outputPreview = preview(turn.outputPreview)
  const outputRef = turn.outputRef
  if (outputPreview === undefined && outputRef === undefined) return undefined
  return {
    ...(outputPreview === undefined ? {} : { preview: outputPreview }),
    ...(outputRef === undefined ? {} : { ref: outputRef }),
  }
}

function settledTraceDetails(
  run: DebateRunSnapshotV1,
  turn: DebateRunSnapshotV1['rounds'][number]['turns'][number],
): Pick<DebateTraceSessionEventV1, 'publicOutput' | 'claims' | 'evidenceRefs' | 'usage'> {
  const publicOutput = tracePublicOutput(turn)
  return {
    ...(publicOutput === undefined ? {} : { publicOutput }),
    ...(turn.claimIds.length === 0 ? {} : { claims: traceClaims(run, turn) }),
    ...(turn.evidenceRefs.length === 0 ? {} : { evidenceRefs: turn.evidenceRefs.slice(0, MAX_REF_ITEMS) }),
    ...(turn.usage === undefined ? {} : { usage: turn.usage }),
  }
}

function traceForEvent(
  run: DebateRunSnapshotV1,
  event: DebateEventV1,
  dispatch: DebateTraceDispatch,
): DebateTraceSessionEventV1 | undefined {
  const state = traceState(event)
  if (state === undefined) return undefined
  const turn = turnForTraceEvent(run, event)
  const agentEvent = event.type.startsWith('debate.agent.')
  if (agentEvent && turn === undefined) return undefined
  const progress = traceProgress(event)
  if (event.type === 'debate.agent.progress' && progress === undefined) return undefined
  const convergence = event.type === 'debate.convergence.evaluated'
    ? run.rounds.find(round => round.round === event.round)?.convergence
    : undefined
  if (event.type === 'debate.convergence.evaluated' && convergence === undefined) return undefined
  const synthesis = event.type === 'debate.synthesis.started'
    ? traceSynthesisStarted(run)
    : event.type === 'debate.synthesis.settled'
      ? traceSynthesis(run)
      : undefined
  const settledDetails = event.type === 'debate.agent.settled' && turn !== undefined
    ? settledTraceDetails(run, turn)
    : {}
  if ((event.type === 'debate.synthesis.started' || event.type === 'debate.synthesis.settled') && synthesis === undefined) return undefined
  return {
    version: 1,
    runId: run.runId,
    sourceSequence: event.sequence,
    state,
    ...(event.type === 'debate.planned' ? { topic: traceTopic(run) } : {}),
    ...(dispatch.turn === undefined ? {} : { sessionTurn: dispatch.turn }),
    ...(dispatch.step === undefined ? {} : { sessionStep: dispatch.step }),
    ...(event.round === undefined ? {} : { round: event.round }),
    ...(turn === undefined ? {} : {
      role: traceRole(
        run,
        turn,
        event.type !== 'debate.agent.dispatched',
        progress?.routing,
      ),
    }),
    ...settledDetails,
    ...(progress === undefined ? {} : { progress: progress.progress }),
    ...(convergence === undefined ? {} : { convergence }),
    ...(synthesis === undefined ? {} : { synthesis }),
  }
}

function hasProjectedTrace(
  events: readonly { readonly type: string; readonly data: unknown }[],
  runId: string,
  sourceSequence: number,
): boolean {
  return events.some((event) => {
    if (event.type !== 'debate/trace') return false
    const data = event.data as Partial<DebateTraceSessionEventV1>
    return data.runId === runId && data.sourceSequence === sourceSequence
  })
}

async function projectDebateTrace(
  ctx: Context,
  agent: Agent,
  run: DebateRunSnapshotV1,
  dispatch: DebateTraceDispatch,
): Promise<void> {
  let afterSequence = 0
  while (true) {
    const page = await ctx.debates.readEvents({ runId: run.runId, afterSequence, limit: MAX_REF_ITEMS })
    if (page.events.length === 0) return
    for (const event of page.events) {
      if (hasProjectedTrace(agent.session.events, run.runId, event.sequence)) continue
      const trace = traceForEvent(run, event, dispatch)
      if (trace !== undefined) agent.session.append('debate/trace', trace, { ignorable: true })
    }
    if (page.nextSequence <= afterSequence) return
    afterSequence = page.nextSequence
  }
}

function requiredRunId(args: ToolArgs): string {
  if (args.run_id === undefined || args.run_id.trim().length === 0) {
    throw new Error('run_id is required for this action')
  }
  return args.run_id
}

/** Register the Debate tool and its guidance. */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({ name: 'tool:debate', order: 119, text: debateGuidance })

  ctx.tools.register(defineTool({
    name: 'debate',
    description: 'Start a bounded multi-agent debate, list or inspect persistent runs, or apply an explicit revision-fenced control action.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'list', 'inspect', 'control'] },
      prompt: { type: 'string', description: 'Debate question or instruction; required for start.' },
      objective: { type: 'string', description: 'Optional concise decision objective for start.' },
      run_id: { type: 'string', description: 'Persistent Debate run id; required for inspect/control.' },
      expected_revision: { type: 'number', description: 'Current run revision; required for control.' },
      control_action: { type: 'string', enum: ['approve', 'reject', 'pause', 'resume', 'stop', 'continue'], description: 'Explicit control decision; continue grants two further rounds only when the Provider reports eligibility.' },
      reason: { type: 'string', description: 'Human reason; required for control.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text' as const, text: JSON.stringify(value) }],
    },
    async execute(args: ToolArgs, exec) {
      const agent = exec.agent
      const projectToolTrace = async (run: DebateRunSnapshotV1): Promise<void> => {
        if (agent === undefined) return
        await projectDebateTrace(ctx, agent, run, toolTraceDispatch(agent, String(exec.callId)))
      }
      if (args.action === 'list') {
        const runs = await ctx.debates.list()
        const listed = runs.slice(0, MAX_LIST_ITEMS)
        const entries = await Promise.all(listed.map(async run => ({
          run,
          snapshot: await ctx.debates.inspect(run.runId),
        })))
        return jsonObject({
          kind: 'list',
          runs: entries.map(({ run, snapshot }) => boundedSummary(run, completedRoundCount(snapshot))),
          truncated: runs.length > MAX_LIST_ITEMS,
        })
      }

      if (args.action === 'inspect') {
        const run = await ctx.debates.inspect(requiredRunId(args))
        await projectToolTrace(run)
        return jsonObject({ kind: 'inspect', run: boundedRun(run) })
      }

      const stableCommandId = commandId(agent === undefined ? undefined : String(agent.id), String(exec.callId))
      if (args.action === 'control') {
        if (args.expected_revision === undefined || !Number.isInteger(args.expected_revision) || args.expected_revision < 0) {
          throw new Error('expected_revision is required and must be a non-negative integer for action=control')
        }
        if (args.control_action === undefined) throw new Error('control_action is required for action=control')
        if (args.reason === undefined || args.reason.trim().length === 0) throw new Error('reason is required for action=control')
        const run = await ctx.debates.control({
          version: 1,
          commandId: stableCommandId,
          runId: requiredRunId(args),
          expectedRevision: args.expected_revision,
          action: args.control_action,
          reason: args.reason,
        })
        await projectToolTrace(run)
        return jsonObject({ kind: 'control', run: boundedRun(run) })
      }

      if (agent === undefined) throw new Error('action=start requires an owning DSH Session')
      if (resolveSessionPreset(agent.session) !== KENNEL_PRESET) {
        throw new Error('Debate starts only from a kennel Session; open the kennel to start one')
      }
      if (args.prompt === undefined || args.prompt.trim().length === 0) throw new Error('prompt is required for action=start')
      const workspace = agent.session.header.cwd
      if (workspace === undefined || workspace.length === 0) throw new Error('action=start requires a Session workspace')

      const initialPlan = debateInitialPlanForPrompt(args.prompt)
      const runtimeContext = debateRuntimeContext(agent)
      const request: DebateStartRequestV1 = {
        version: 1,
        commandId: stableCommandId,
        workspace,
        prompt: args.prompt,
        ...(args.objective === undefined || args.objective.trim().length === 0 ? {} : { objective: args.objective }),
        policy: debatePolicyForPrompt(args.prompt, STARTED_MODE),
        execution: { version: 1, kind: 'standalone' },
        sourceSessionId: String(agent.id),
        ...runtimeContext === undefined ? {} : { runtimeContext },
      }
      const started = await ctx.debates.start(request)
      await projectToolTrace(started)
      const run = await approveExplicitDebate(ctx, started, stableCommandId)
      await projectToolTrace(run)
      agent.session.append('debate/admission', {
        runId: run.runId,
        mode: STARTED_MODE,
        revision: run.revision,
        state: run.state,
      }, { ignorable: true })
      return jsonObject({ kind: 'start', initialPlan, run: boundedRun(run) })
    },
    presentCall: args => ({
      card: 'generic',
      title: args.action === 'start'
        ? 'Start multi-agent debate'
        : args.action === 'list'
          ? 'List debates'
          : args.action === 'inspect'
            ? 'Inspect debate'
            : 'Control debate',
      kind: args.action === 'list' || args.action === 'inspect' ? 'read' : 'other',
      ...args.run_id === undefined ? {} : { rawInput: args.run_id },
    }),
  }))
}
