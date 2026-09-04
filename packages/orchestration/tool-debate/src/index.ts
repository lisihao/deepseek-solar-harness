/** Model-facing Consumer and per-session policy for the provider-neutral Debate seam. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  type DebateControlAction,
  type DebateAgentProgressUsageV1,
  DebateError,
  type DebateEventV1,
  type DebatePolicyV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateStartRequestV1,
  type DebateTraceSessionEventV1,
  type DebateTraceProgressV1,
  type DebateTraceStateV1,
  type DebateTurnRoutingV1,
} from '@deepseek-ai/dsh-debate'
import {
  isAgentLoopRequest,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {
  DebateExecutionMode,
  DebateExecutionPreferences,
  DebateExecutionPreferencesSelect,
} from './types.ts'

export type * from './types.ts'

export const name = 'tool-debate'
export const inject = ['debates', 'tools', 'systemPrompt']

const DEBATE_HOST_PROVIDER = 'dsh-debate-host'
const DEBATE_HOST_MODEL = 'debate'
const MODE_OPTIONS = ['auto', 'enabled', 'disabled'] as const satisfies readonly DebateExecutionMode[]
const DEFAULT_PREFERENCES: DebateExecutionPreferences = { mode: 'disabled' }
const MAX_LIST_ITEMS = 20
const MAX_PREVIEW_CHARS = 600
const MAX_REF_ITEMS = 20
const DEBATE_TRANSCRIPT_POLL_INTERVAL_MS = 100
const EXPLICIT_DEBATE_APPROVAL_REASON = 'The user explicitly selected Debate for this Session and submitted this request.'
const CONCISE_DEBATE_HINT = /(?:简洁|简要|精简|三条|要点|concise|brief)/iu
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/gu
const TRAILING_FALLBACK_ANSI = /\[1m$/u

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

const OPERATOR_LABELS: Readonly<Record<string, string>> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
}

const MODEL_LABELS: Readonly<Record<string, string>> = {
  'gpt-5.6-sol': 'GPT-5.6 Sol',
  'gpt-5.6-terra': 'GPT-5.6 Terra',
  'gpt-5.6-luna': 'GPT-5.6 Luna',
  'claude-opus-5': 'Claude Opus 5',
  'claude-fable-5': 'Claude Fable 5',
  'claude-sonnet-4': 'Claude Sonnet 4',
}

const TERMINAL_RUN_STATES: ReadonlySet<DebateRunSnapshotV1['state']> = new Set([
  'completed',
  'budget_limited',
  'max_rounds',
  'stopped',
  'failed',
  'indeterminate',
])

function isDebateMode(value: unknown): value is DebateExecutionMode {
  return typeof value === 'string' && MODE_OPTIONS.some(option => option === value)
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole-value strategy for future Debate admissions in this Session. */
    'debate/preferences': DebateExecutionPreferences
    /** Durable bounded link from a model tool call to the admitted Debate run. */
    'debate/admission': {
      readonly runId: string
      readonly mode: DebateExecutionMode
      readonly revision: number
      readonly state: string
    }
    /**
     * Durable host admission for one user message while Debate is explicitly enabled.
     * @param commandId Idempotent Debate command identity.
     * @param promptMessageId User message owned by this admission.
     * @param turn Agent turn receiving the message.
     * @param step Agent step replaced by the Debate host adapter.
     */
    'debate/dispatch': {
      readonly commandId: string
      readonly promptMessageId: string
      readonly turn: number
      readonly step: number
    }
    /**
     * One bounded public fact from a durable Debate run, keyed by its source event sequence.
     * @param runId Persistent Debate run identity.
     * @param sourceSequence Durable sequence from the Debate Provider.
     */
    'debate/trace': DebateTraceSessionEventV1
  }
}

interface HostMessage {
  readonly id: string
  readonly content: readonly ContentBlock[]
  readonly source: { readonly kind: string }
}

interface DebateHostDispatch {
  readonly commandId: string
  readonly promptMessageId: string
  readonly turn: number
  readonly step: number
}

/**
 * Session-local placement for a Debate trace projection.
 *
 * Host-routed Debate has an explicit message dispatch. A model-invoked
 * `debate` tool instead owns a normal `tool/call`; it can still recover its
 * turn/step from that durable call without inventing a user-message id.
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
      persona: Object.freeze({
        title: 'Constructive Proposer',
        mandate: 'Build the strongest practical answer to the user objective.',
        stance: 'Constructive, concrete, and explicit about assumptions.',
        instructions: Object.freeze([
          'Present a compact position with testable claims and implementation consequences.',
          'Use source references when available and identify the highest-impact uncertainty.',
        ]),
      }),
    }),
    Object.freeze({
      version: 1, role: 'skeptical-falsifier', kind: 'participant', operatorId: 'claude-code',
      model: 'claude-fable-5', tier: 'medium', source: 'native-subscription', required: true,
      fallbackOperatorIds: Object.freeze(['codex']),
      persona: Object.freeze({
        title: 'Skeptical Falsifier',
        mandate: 'Find decisive counterexamples, hidden assumptions, and failure modes.',
        stance: 'Skeptical without becoming contrarian or speculative.',
        instructions: Object.freeze([
          'Attack claims rather than personalities and rank objections by decision impact.',
          'Distinguish observed contradictions from uncertainties needing evidence.',
        ]),
      }),
    }),
    Object.freeze({
      version: 1, role: 'evidence-auditor', kind: 'participant', operatorId: 'codex',
      model: 'gpt-5.6-sol', tier: 'high', source: 'native-subscription', required: true,
      persona: Object.freeze({
        title: 'Evidence Auditor',
        mandate: 'Check whether important claims are supported, traceable, and decision-relevant.',
        stance: 'Evidence-first and precise about what is not established.',
        instructions: Object.freeze([
          'Map each material claim to an available source or mark the evidence gap.',
          'Reject citations or artifacts that do not directly support the associated claim.',
        ]),
      }),
    }),
    Object.freeze({
      version: 1, role: 'decision-judge', kind: 'judge', operatorId: 'claude-code',
      model: 'claude-opus-5', tier: 'high', source: 'native-subscription', required: true,
      fallbackOperatorIds: Object.freeze(['codex']),
      persona: Object.freeze({
        title: 'Decision Judge',
        mandate: 'Reconcile the strongest supported claims and preserve material dissent.',
        stance: 'Decisive when evidence permits and explicit when it does not.',
        instructions: Object.freeze([
          'Judge the shared claim ledger after participant outputs, not by model reputation.',
          'State the decision, unresolved blockers, minority view, and conditions that would change it.',
        ]),
      }),
    }),
  ]),
  budget: Object.freeze({
    version: 1, maxRounds: 3, maxTurnsPerAgent: 3, maxAgentsPerRound: 4,
    maxInputTokens: 400_000, maxOutputTokens: 180_000, maxTotalTokens: 580_000,
  }),
  rounds: Object.freeze({
    version: 1, firstRound: 'blind-independent', followUp: 'claim-ledger',
    escalation: 'high-severity-unresolved',
  }),
  convergence: Object.freeze({
    version: 1, scoreThreshold: 0.82, minSettledAgents: 3,
    maxUnresolvedHighSeverity: 0, requireEvidenceForCritical: true, earlyStop: true,
  }),
  preserveDissent: true,
})

/**
 * Use one three-role round when the user explicitly asks for a concise result.
 *
 * @param prompt - The user request inspected for an explicit concise-output hint.
 * @param mode - The selected debate policy mode to preserve in the derived policy.
 * @returns The default policy or its bounded single-round concise variant.
 */
export function debatePolicyForPrompt(
  prompt: string,
  mode: DebatePolicyV1['mode'] = 'enabled',
): DebatePolicyV1 {
  if (!CONCISE_DEBATE_HINT.test(prompt)) return { ...DEFAULT_DEBATE_POLICY, mode }
  const roster = DEFAULT_DEBATE_POLICY.roster.filter(role => role.role !== 'evidence-auditor')
  return {
    ...DEFAULT_DEBATE_POLICY,
    mode,
    roster,
    budget: {
      ...DEFAULT_DEBATE_POLICY.budget,
      maxRounds: 1,
      maxTurnsPerAgent: 1,
      maxAgentsPerRound: roster.length,
      maxInputTokens: 80_000,
      maxOutputTokens: 40_000,
      maxTotalTokens: 120_000,
      maxCostUsd: 2,
    },
    convergence: { ...DEFAULT_DEBATE_POLICY.convergence, minSettledAgents: roster.length },
  }
}

/** Model-visible guidance. Debate is an explicit/automatic strategy, not a second Scheduler. */
export const debateGuidance = 'The debate tool runs a bounded, persistent multi-agent deliberation through the provider-neutral Debate service. Use action=start only when this Session has Debate enabled, or when Smart Auto has selected Debate for a genuinely contested, high-impact decision that benefits from independent proposals, falsification, evidence audit, and a final judge. Do not use Debate for greetings, simple retrieval, or one obvious implementation step. Debate preserves dissent, stops early on evidence-backed convergence, caps the roster at four native-subscription agents and the run at three rounds, and returns bounded status plus artifact references instead of large reports. Use list or inspect after a restart; use control only for an explicit user decision. Debate does not replace the DSH TaskGraph Scheduler and never calls a physical operator directly.'

function jsonObject(value: object): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>
}

function preview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  return value.length <= MAX_PREVIEW_CHARS ? value : `${value.slice(0, MAX_PREVIEW_CHARS - 1)}…`
}

function boundedSummary(summary: DebateRunSummaryV1): Record<string, JsonValue> {
  return jsonObject({
    runId: summary.runId,
    state: summary.state,
    mode: summary.mode,
    currentRound: summary.currentRound,
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
    currentRound: run.currentRound,
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

/**
 * Fold the most recent valid Debate preference; legacy Sessions remain Standard/disabled.
 * @param events - current Session's ordered event projection.
 * @returns most recent valid Debate preference or the Standard default.
 */
export function foldDebatePreferences(
  events: readonly { readonly type: string; readonly data: unknown }[],
): DebateExecutionPreferences {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'debate/preferences') continue
    const mode = (event.data as { readonly mode?: unknown }).mode
    if (isDebateMode(mode)) return { mode }
  }
  return { ...DEFAULT_PREFERENCES }
}

function preferenceProjection(value: DebateExecutionPreferences): DebateExecutionPreferencesSelect {
  return { ...value, options: MODE_OPTIONS }
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

function hostCommandId(sessionId: string, messageId: string): string {
  return `debate-host:${sessionId}:${messageId}`
}

function persistHostDispatch(
  agent: Agent,
  current: HostMessage,
  turn: number,
  step: number,
): DebateHostDispatch {
  const dispatch = {
    commandId: hostCommandId(String(agent.id), current.id),
    promptMessageId: current.id,
    turn,
    step,
  }
  agent.session.append('debate/dispatch', dispatch, { ignorable: true })
  return dispatch
}

function toolTraceDispatch(agent: Agent, callId: string): DebateTraceDispatch {
  const call = agent.session.events.findLast(event => event.type === 'tool/call'
    && String(event.data.callId) === callId
    && event.data.name === 'debate')
  if (call?.type !== 'tool/call') return {}
  return { turn: call.data.turn, step: call.data.step }
}

function latestDirectUser(messages: readonly HostMessage[]): HostMessage | undefined {
  return [...messages].reverse().find(message => message.source.kind === 'user')
}

function messageText(message: HostMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim()
}

function dispatchForPosition(
  events: readonly { readonly type: string; readonly data: unknown }[],
  turn: number,
  step: number,
): DebateHostDispatch | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'debate/dispatch') continue
    const data = event.data as Partial<DebateHostDispatch>
    if (data.turn === turn && data.step === step
      && typeof data.commandId === 'string' && typeof data.promptMessageId === 'string') {
      return data as DebateHostDispatch
    }
  }
  return undefined
}

function dispatchForPrompt(
  events: readonly { readonly type: string; readonly data: unknown }[],
  promptMessageId: string,
): DebateHostDispatch | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'debate/dispatch') continue
    const data = event.data as Partial<DebateHostDispatch>
    if (data.promptMessageId === promptMessageId
      && typeof data.commandId === 'string'
      && Number.isSafeInteger(data.turn)
      && Number.isSafeInteger(data.step)) {
      return data as DebateHostDispatch
    }
  }
  return undefined
}

function hasAdmission(events: readonly { readonly type: string; readonly data: unknown }[], runId: string): boolean {
  return events.some(event => event.type === 'debate/admission'
    && (event.data as { readonly runId?: unknown }).runId === runId)
}

function runText(run: DebateRunSnapshotV1): string {
  const lines = [
    '## 置顶 · 主持人总结',
    formatPublicSpeech(run.synthesis?.outputPreview ?? '主持人尚未提交最终总结。'),
  ]
  const moderatorFailure = [...run.rounds]
    .reverse()
    .flatMap(round => [...round.turns].reverse())
    .find(turn => turn.role === 'decision-judge' && turn.state !== 'settled')
  if (run.synthesis === undefined && moderatorFailure !== undefined) {
    const seen = new Set<string>()
    const messages = moderatorFailure.blockers?.filter((blocker) => {
      const key = [moderatorFailure.attempt ?? '', blocker.nodeId ?? '', blocker.code, blocker.message].join('\u0000')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(blocker => blocker.message) ?? []
    lines.push(
      '',
      '### 主持人状态',
      `- ${turnStateLabel(moderatorFailure.state)}${messages.length === 0 ? '' : `：${messages.join('；')}`}`,
    )
  }
  if (run.unresolved.length > 0) {
    lines.push('', '### 未决问题', ...run.unresolved.slice(0, MAX_REF_ITEMS).map(item =>
      `- ${item.blocking ? '阻断：' : ''}${item.description}${item.reason.length > 0 ? `（${item.reason}）` : ''}`))
  }
  if (run.dissent.length > 0) {
    lines.push('', '### 保留异议', ...run.dissent.slice(0, MAX_REF_ITEMS).map(item =>
      `- ${roleTitleForSlot(run, item.slotId)}：${item.position}${item.reason.length > 0 ? `（${item.reason}）` : ''}`))
  }
  lines.push(
    '',
    '### 本场结果',
    `- 状态：${finalLifecycleLabel(run.state)}`,
    `- 已完成轮次：${String(run.currentRound)}`,
  )
  return lines.join('\n')
}

interface TranscriptTracker {
  topicEmitted: boolean
  topicState?: DebateRunSnapshotV1['state']
  rosterEmitted: boolean
  rosterStatusSignature?: string
  readonly roundStates: Map<number, string>
  readonly emittedTurnKeys: Set<string>
  readonly turnFloors: Map<string, number>
  readonly convergenceSignatures: Map<number, string>
  synthesisSignature?: string
  finalEmitted: boolean
  nextFloor: number
}

function createTranscriptTracker(): TranscriptTracker {
  return {
    topicEmitted: false,
    rosterEmitted: false,
    roundStates: new Map(),
    emittedTurnKeys: new Set(),
    turnFloors: new Map(),
    convergenceSignatures: new Map(),
    finalEmitted: false,
    nextFloor: 1,
  }
}

function transcriptLines(
  run: DebateRunSnapshotV1,
  tracker: TranscriptTracker,
  final: boolean,
  requestTopic?: string,
): string[] {
  const lines: string[] = []
  if (!tracker.topicEmitted) {
    tracker.topicEmitted = true
    tracker.topicState = run.state
    lines.push(
      '# 主题帖',
      `## ${topicTitle(run, requestTopic)}`,
      `**当前状态：** ${transcriptLifecycleLabel(run, final)}`,
      '',
    )
  } else if (tracker.topicState !== run.state) {
    tracker.topicState = run.state
    lines.push(`**主题帖状态更新：** ${transcriptLifecycleLabel(run, final)}`)
  }
  if (!tracker.rosterEmitted) {
    tracker.rosterEmitted = true
    const rosterLines = ['## 参与者名册']
    for (const role of run.roster.slice(0, MAX_REF_ITEMS)) {
      const turn = latestRoleTurn(run, role.role)
      const route = turn === undefined ? configuredRoute(role) : actualRoute(turn)
      rosterLines.push(
        `**${rosterRoleTitle(role)}**`,
        `职责 · ${roleMandate(role)}`,
        `执行 · ${routeDescription(route)}`,
        `启动状态 · ${turn === undefined ? '等待分派' : turnStateLabel(turn.state)}`,
        '',
      )
    }
    lines.push(...rosterLines)
    tracker.rosterStatusSignature = rosterTerminalStatusSignature(run)
  } else {
    const currentSignature = rosterTerminalStatusSignature(run)
    if (tracker.rosterStatusSignature !== currentSignature) {
      const update = rosterTerminalStatusSummary(run)
      if (update !== undefined) lines.push(`**参与者状态更新：** ${update}`)
      tracker.rosterStatusSignature = currentSignature
    }
  }

  for (const round of run.rounds.slice(0, MAX_REF_ITEMS)) {
    const previousRoundState = tracker.roundStates.get(round.round)
    if (previousRoundState === undefined) {
      tracker.roundStates.set(round.round, round.state)
      lines.push(`## 第 ${String(round.round)} 轮 · ${roundStateLabel(round.state)}`)
    } else if (previousRoundState !== round.state) {
      tracker.roundStates.set(round.round, round.state)
      lines.push(`**第 ${String(round.round)} 轮状态更新**：${roundStateLabel(round.state)}`)
    }
    for (const turn of round.turns.slice(0, MAX_REF_ITEMS)) {
      const key = `${String(round.round)}:${turn.slotId}`
      if ((!roundIsTerminal(round.state) && run.state !== 'stopped') || !turnIsTerminal(turn.state)) continue
      if (tracker.emittedTurnKeys.has(key)) continue
      tracker.emittedTurnKeys.add(key)
      if (!tracker.turnFloors.has(key)) tracker.turnFloors.set(key, tracker.nextFloor++)
      const floor = tracker.turnFloors.get(key)
      if (floor !== undefined) lines.push(...transcriptTurnLines(run, round.round, floor, turn))
    }
    if (round.convergence !== undefined) {
      const signature = JSON.stringify(round.convergence)
      if (tracker.convergenceSignatures.get(round.round) !== signature) {
        tracker.convergenceSignatures.set(round.round, signature)
        lines.push(
          `**本轮收敛判断：** ${transcriptConvergenceLabel(round.convergence.status, final)}`
          + `（得分 ${round.convergence.score.toFixed(2)} / 阈值 ${round.convergence.threshold.toFixed(2)}，${round.convergence.reason}）`,
        )
      }
    }
  }

  if (!final && run.synthesis !== undefined) {
    const signature = [run.synthesis.state, run.synthesis.artifactRef ?? '', run.synthesis.outputPreview ?? ''].join('\u0000')
    if (tracker.synthesisSignature !== signature) {
      tracker.synthesisSignature = signature
      lines.push(`**主持人状态**：${synthesisLabel(run.synthesis.state)}`)
    }
  }
  if (final && !tracker.finalEmitted) {
    tracker.finalEmitted = true
    lines.push(runText(run))
  }
  return lines
}

function roleTitle(role: string, roster?: DebateRunSnapshotV1['roster']): string {
  const localized = ROLE_COPY[role]?.title
  if (localized !== undefined) return localized
  const configured = roster?.find(candidate => candidate.role === role)?.persona.title
  return configured === undefined || configured.trim().length === 0 ? '参与者' : configured
}

function roleTitleForSlot(run: DebateRunSnapshotV1, slotId: string): string {
  const turn = run.rounds.flatMap(round => round.turns).find(candidate => candidate.slotId === slotId)
  return turn === undefined ? '一位参与者' : roleTitle(turn.role, run.roster)
}

function rosterRoleTitle(role: DebateRunSnapshotV1['roster'][number]): string {
  const localized = roleTitle(role.role, [role])
  const configured = preview(role.persona.title)
  return isDefaultRolePersona(role) || configured === undefined || configured === localized
    ? localized
    : `${localized}（${configured}）`
}

function roleMandate(role: DebateRunSnapshotV1['roster'][number]): string {
  return isDefaultRolePersona(role)
    ? ROLE_COPY[role.role]?.mandate ?? '职责未提供。'
    : preview(role.persona.mandate) ?? '职责未提供。'
}

function isDefaultRolePersona(role: DebateRunSnapshotV1['roster'][number]): boolean {
  const defaultRole = DEFAULT_DEBATE_POLICY.roster.find(candidate => candidate.role === role.role)
  return defaultRole?.persona.title === role.persona.title && defaultRole.persona.mandate === role.persona.mandate
}

function transcriptTurnLines(
  run: DebateRunSnapshotV1,
  round: number,
  floor: number,
  turn: DebateRunSnapshotV1['rounds'][number]['turns'][number],
): string[] {
  const lines = [
    `### ${String(floor)} 楼 · ${roleTitle(turn.role, run.roster)}`,
    `**状态：** ${turnStateLabel(turn.state)}`,
    `**执行者：** ${routeDescription(actualRoute(turn))}`,
  ]
  if (round === 1) lines.push('**发言类型：** 首轮独立发言')
  else lines.push('**发言类型：** Claim Ledger 后续发言')
  if (turn.outputPreview !== undefined) {
    lines.push('', '**公开发言：**', formatPublicSpeech(turn.outputPreview))
  } else if (turn.state === 'blocked' || turn.state === 'failed' || turn.state === 'indeterminate') {
    lines.push('', '**公开发言：**', '> 未产生公开输出。')
  } else {
    lines.push('', '**公开发言：**', '> 未提供公开摘要。')
  }
  if (turn.claimIds.length > 0) {
    lines.push('', '**本楼主张：**', ...claimReferences(run, turn.claimIds).map((claim, index) => `${String(index + 1)}. ${claim}`))
  }
  if (turn.evidenceRefs.length > 0) lines.push(`**证据：** 已关联 ${String(turn.evidenceRefs.length)} 项`)
  const errorSignatures = new Set<string>()
  for (const blocker of turn.blockers?.slice(0, MAX_REF_ITEMS) ?? []) {
    const signature = [turn.attempt ?? '', blocker.nodeId ?? '', blocker.code, blocker.message].join('\u0000')
    if (errorSignatures.has(signature)) continue
    errorSignatures.add(signature)
    lines.push(`> ⚠️ 未完成：${blocker.message}`)
  }
  if (turn.errorCode !== undefined) {
    const alreadyExplained = turn.blockers?.some(blocker => blocker.code === turn.errorCode) ?? false
    if (!alreadyExplained) {
      lines.push(`> ⚠️ 未完成：${turn.errorCode}`)
    }
  }
  lines.push('')
  return lines
}

function roundIsTerminal(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'indeterminate'
}

function turnIsTerminal(state: string): boolean {
  return state === 'settled' || state === 'blocked' || state === 'failed' || state === 'indeterminate'
}

function claimReferences(run: DebateRunSnapshotV1, ids: readonly string[]): string[] {
  return ids.slice(0, MAX_REF_ITEMS).map((id) => {
    const claim = run.claimLedger.claims.find(item => item.claimId === id)
    return claim === undefined ? '一项未能读取正文的主张' : formatInlineText(preview(claim.statement) ?? '')
  })
}

function formatInlineText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().replace(/\|/gu, '\\|')
}

function formatPublicSpeech(value: string): string {
  const bounded = preview(value) ?? ''
  const normalized = bounded.replace(/\r\n?/gu, '\n').trim().replace(/\n{3,}/gu, '\n\n')
  return normalized
    .replace(/(^|[^\n])\s+(P[0-9]+)\s*[：:]\s*/gu, (_match, before: string, priority: string) => `${before}\n\n**${priority}**：`)
    .replace(/^(P[0-9]+)\s*[：:]\s*/gmu, (_match, priority: string) => `**${priority}**：`)
    .replace(/^(立场|结论|建议|验收标准|主要风险|最高影响不确定性)\s*[：:]\s*/gmu, (_match, heading: string) => `**${heading}**：`)
}

interface DisplayRoute {
  readonly operator: string

  readonly model: string
  readonly requested?: { readonly operator: string; readonly model: string }
}
function normalizeRouteValue(value: string): string {
  return value
    .replace(ANSI_SGR_RE, '')
    .replace(TRAILING_FALLBACK_ANSI, '')
    .trim()
}

function rosterTerminalStatusSignature(run: DebateRunSnapshotV1): string {
  const values: string[] = []
  for (const role of run.roster) {
    const status = latestRoleTerminalState(run, role.role)
    if (status !== undefined) values.push(`${role.role}:${status}`)
  }
  return values.join('\u0000')
}

function rosterTerminalStatusSummary(run: DebateRunSnapshotV1): string | undefined {
  const lines: string[] = []
  for (const role of run.roster) {
    const status = latestRoleTerminalState(run, role.role)
    if (status === undefined) continue
    lines.push(`${roleTitle(role.role, run.roster)}：${turnStateLabel(status)}`)
  }
  return lines.length === 0 ? undefined : lines.join('；')
}

function latestRoleTerminalState(run: DebateRunSnapshotV1, role: string): DebateRunSnapshotV1['rounds'][number]['turns'][number]['state'] | undefined {
  return latestRoleTurn(run, role, turn => turnIsTerminal(turn.state))?.state
}

function configuredRoute(role: DebateRunSnapshotV1['roster'][number]): DisplayRoute {
  return {
    operator: operatorLabel(role.operatorId),
    model: modelLabel(role.model),
  }
}

function actualRoute(turn: DebateRunSnapshotV1['rounds'][number]['turns'][number]): DisplayRoute {
  const requestedOperator = normalizeRouteValue(turn.routing?.requestedOperatorId ?? turn.operatorId)
  const requestedModel = normalizeRouteValue(turn.routing?.requestedModel ?? turn.model)
  const actualOperator = normalizeRouteValue(turn.routing?.actualOperatorId ?? turn.operatorId)
  const actualModel = normalizeRouteValue(turn.routing?.actualModel ?? turn.model)
  const requested = requestedOperator === actualOperator && requestedModel === actualModel
    ? undefined
    : { operator: operatorLabel(requestedOperator), model: modelLabel(requestedModel) }
  return { operator: operatorLabel(actualOperator), model: modelLabel(actualModel), ...(requested === undefined ? {} : { requested }) }
}

function routeDescription(route: DisplayRoute): string {
  const actual = `${route.operator} · ${route.model}`
  return route.requested === undefined
    ? actual
    : `${actual}（已从 ${route.requested.operator} · ${route.requested.model} 自动回退）`
}

function operatorLabel(value: string): string {
  return OPERATOR_LABELS[value] ?? value
}

function modelLabel(value: string): string {
  return MODEL_LABELS[value] ?? value
}

function latestRoleTurn(
  run: DebateRunSnapshotV1,
  role: string,
  predicate?: (turn: DebateRunSnapshotV1['rounds'][number]['turns'][number]) => boolean,
): DebateRunSnapshotV1['rounds'][number]['turns'][number] | undefined {
  for (let roundIndex = run.rounds.length - 1; roundIndex >= 0; roundIndex -= 1) {
    const round = run.rounds[roundIndex]
    if (round === undefined) continue
    for (let turnIndex = round.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const turn = round.turns[turnIndex]
      if (turn === undefined || turn.role !== role) continue
      if (predicate !== undefined && !predicate(turn)) continue
      return turn
    }
  }
  return undefined
}

function topicTitle(run: DebateRunSnapshotV1, requestTopic?: string): string {
  const title = run.topic?.title ?? run.objective ?? requestTopic
  return title === undefined || title.trim().length === 0
    ? '历史记录缺少议题正文'
    : formatInlineText(preview(title) ?? '')
}

function transcriptLifecycleLabel(run: DebateRunSnapshotV1, final: boolean): string {
  if (final) return finalLifecycleLabel(run.state)
  if (run.state === 'budget_limited') return '预算已达上限，正在整理主持人总结'
  if (run.state === 'max_rounds') return '已达轮次上限，正在整理主持人总结'
  return lifecycleLabel(run.state)
}

function finalLifecycleLabel(state: DebateRunSnapshotV1['state']): string {
  if (state === 'budget_limited') return '预算已达上限，主持人总结已完成'
  if (state === 'max_rounds') return '已达轮次上限，主持人总结已完成'
  return lifecycleLabel(state)
}

function transcriptConvergenceLabel(state: string, final: boolean): string {
  if (state === 'budget_limited') return final
    ? '本轮预算已达上限，主持人总结已完成'
    : '本轮预算已达上限，进入主持人综合'
  if (state === 'max_rounds') return final
    ? '已达轮次上限，主持人总结已完成'
    : '已达轮次上限，进入主持人综合'
  return convergenceLabel(state)
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

function turnStateLabel(state: string): string {
  return ({ planned: '待执行', dispatched: '运行中', settled: '已完成', blocked: '已阻断', failed: '失败', indeterminate: '不确定' } as Record<string, string>)[state] ?? state
}

function roundStateLabel(state: string): string {
  return ({ planned: '待开始', running: '进行中', reviewing: '审查中', completed: '已完成', failed: '失败', indeterminate: '不确定' } as Record<string, string>)[state] ?? state
}

function convergenceLabel(state: string): string {
  return ({ converged: '已收敛', continue: '继续辩论', budget_limited: '预算停止', max_rounds: '轮次上限' } as Record<string, string>)[state] ?? state
}

function synthesisLabel(state: string): string {
  return ({ pending: '等待综合', running: '综合中', settled: '综合完成', failed: '综合失败' } as Record<string, string>)[state] ?? state
}

function lifecycleLabel(state: string): string {
  return ({ planned: '已规划', awaiting_approval: '等待批准', admitting: '准入中', round_running: '辩论中', reviewing: '审查中', converged: '已收敛', next_round: '准备下一轮', budget_limited: '预算停止', max_rounds: '达到轮次上限', synthesizing: '综合中', completed: '已完成', stopped: '已暂停/停止', failed: '失败', indeterminate: '状态不确定' } as Record<string, string>)[state] ?? state
}

function waitForTranscriptPoll(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) signal.throwIfAborted()
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new Error('Debate transcript polling was aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, DEBATE_TRANSCRIPT_POLL_INTERVAL_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

function runUsage(run: DebateRunSnapshotV1): TokenUsage | undefined {
  const inputTokens = run.cost.inputTokens
  const outputTokens = run.cost.outputTokens
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return {
    inputTokens,
    outputTokens,
    ...run.cost.cacheReadInputTokens === undefined ? {} : { cacheReadTokens: run.cost.cacheReadInputTokens },
    ...run.cost.cacheWriteInputTokens === undefined ? {} : { cacheWriteTokens: run.cost.cacheWriteInputTokens },
  }
}

class DebateHostAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!isAgentLoopRequest(options)) throw new Error('Debate host adapter only accepts an Agent Loop request')
    const agent = this.ctx.agents.requireInitiator()
    const current = latestDirectUser(options.messages)
    if (current === undefined) throw new Error('Debate host adapter requires a current user message')
    const dispatch = dispatchForPrompt(agent.session.events, current.id)
    if (dispatch === undefined) throw new Error(`Debate host adapter has no durable dispatch for ${current.id}`)
    const prompt = messageText(current)
    if (prompt.length === 0) throw new DebateError('Debate requires a text prompt', 'DEBATE_INVALID')
    const workspace = agent.session.header.cwd
    if (workspace === undefined || workspace.length === 0) {
      throw new DebateError('Debate requires a Session workspace', 'DEBATE_INVALID')
    }
    const started = await this.ctx.debates.start({
      version: 1,
      commandId: dispatch.commandId,
      workspace,
      prompt,
      objective: prompt,
      policy: debatePolicyForPrompt(prompt),
      execution: { version: 1, kind: 'standalone' },
      sourceSessionId: String(agent.id),
    })
    options.signal?.throwIfAborted()
    const completionResult = approveExplicitDebate(this.ctx, started, dispatch.commandId).then(
      value => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const tracker = createTranscriptTracker()
    let assembledText = ''
    const startedIsTerminal = TERMINAL_RUN_STATES.has(started.state)

    yield { type: 'block-start', index: 0, blockType: 'text' }
    await projectDebateTrace(this.ctx, agent, started, dispatch)
    for (const line of transcriptLines(started, tracker, startedIsTerminal, prompt)) {
      const delta = `${line}\n\n`
      assembledText += delta
      yield { type: 'text-delta', index: 0, text: delta }
    }

    let completion: Awaited<typeof completionResult> | undefined
    while (completion === undefined && !TERMINAL_RUN_STATES.has(started.state)) {
      options.signal?.throwIfAborted()
      const observed = await this.ctx.debates.inspect(started.runId)
      await projectDebateTrace(this.ctx, agent, observed, dispatch)
      for (const line of transcriptLines(observed, tracker, false, prompt)) {
        const delta = `${line}\n\n`
        assembledText += delta
        yield { type: 'text-delta', index: 0, text: delta }
      }
      if (TERMINAL_RUN_STATES.has(observed.state)) break
      const next = await Promise.race([
        completionResult,
        waitForTranscriptPoll(options.signal),
      ])
      if (next !== undefined) completion = next
    }

    completion ??= await completionResult
    if (!completion.ok) throw completion.error
    const admitted = completion.value
    await projectDebateTrace(this.ctx, agent, admitted, dispatch)
    for (const line of transcriptLines(admitted, tracker, true, prompt)) {
      const delta = `${line}\n\n`
      assembledText += delta
      yield { type: 'text-delta', index: 0, text: delta }
    }
    if (!hasAdmission(agent.session.events, admitted.runId)) {
      agent.session.append('debate/admission', {
        runId: admitted.runId,
        mode: 'enabled',
        revision: admitted.revision,
        state: admitted.state,
      }, { ignorable: true })
    }
    if (admitted.state === 'failed' || admitted.state === 'indeterminate') {
      throw new DebateError(`Debate run ${admitted.runId} ended as ${admitted.state}`, 'DEBATE_PROVIDER_UNAVAILABLE')
    }
    const usage = runUsage(admitted)
    yield { type: 'block-end', index: 0, block: { type: 'text', text: assembledText } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function requiredRunId(args: ToolArgs): string {
  if (args.run_id === undefined || args.run_id.trim().length === 0) {
    throw new Error('run_id is required for this action')
  }
  return args.run_id
}

/** Register the Debate tool, durable per-session mode command, and client projection. */
export function apply(ctx: Context): void {
  ctx.inject(['llm', 'agents'], (hostCtx) => {
    hostCtx.llm.registerAdapter([DEBATE_HOST_PROVIDER], new DebateHostAdapter(hostCtx))

    hostCtx.on('agent/pre-step', async ({ agent, turn, step }, next): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind !== 'enter' || foldDebatePreferences(agent.session.events).mode !== 'enabled') return decision
      const current = latestDirectUser(decision.messages)
      if (current === undefined || dispatchForPosition(agent.session.events, turn, step) !== undefined) return decision
      persistHostDispatch(agent, current, turn, step)
      return decision
    })

    hostCtx.on('agent/request', async ({ agent, turn, step }, next) => {
      const base = await next()
      let dispatch = dispatchForPosition(agent.session.events, turn, step)
      if (dispatch === undefined && base.provider === DEBATE_HOST_PROVIDER && base.model === DEBATE_HOST_MODEL) {
        const current = latestDirectUser(agent.session.deriveMessages())
        if (current === undefined) throw new Error('Debate host route requires a current direct user message')
        dispatch = persistHostDispatch(agent, current, turn, step)
      }
      if (dispatch === undefined) return base
      const { reasoningEffort: _reasoningEffort, ...portable } = base
      return { ...portable, provider: DEBATE_HOST_PROVIDER, model: DEBATE_HOST_MODEL }
    })
  })
  ctx.systemPrompt.section({ name: 'tool:debate', order: 119, text: debateGuidance })

  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register<'debateExecutionPreferences', DebateExecutionPreferences>({
      key: 'debateExecutionPreferences',
      schema: zod.object({
        mode: zod.enum(MODE_OPTIONS),
        options: zod.array(zod.enum(MODE_OPTIONS)),
      }),
      init: () => ({ ...DEFAULT_PREFERENCES }),
      apply: (state, event) => event.type === 'debate/preferences'
        ? { ...(event.data) }
        : state,
      view: preferenceProjection,
      stateVersion: 1,
    })
  })

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'debate-mode',
      description: 'Select automatic, enabled, or disabled Debate for the current Session',
      input: { hint: '<auto|enabled|disabled>' },
      handler: ({ agent, rawInput }) => {
        const mode = rawInput.trim()
        if (!isDebateMode(mode)) {
          return { kind: 'error', text: 'usage: /debate-mode <auto|enabled|disabled>' }
        }
        if (foldDebatePreferences(agent.session.events).mode !== mode) {
          agent.session.append('debate/preferences', { mode }, { ignorable: true })
        }
        return { kind: 'success', text: `debate mode ${mode}` }
      },
    })
  })

  ctx.tools.register(defineTool({
    name: 'debate',
    description: 'Start a bounded multi-agent debate, list or inspect persistent runs, or apply an explicit revision-fenced control action.',
    parameters: {
      action: { type: 'string', required: true, enum: ['start', 'list', 'inspect', 'control'] },
      prompt: { type: 'string', description: 'Debate question or instruction; required for start.' },
      objective: { type: 'string', description: 'Optional concise decision objective for start.' },
      run_id: { type: 'string', description: 'Persistent Debate run id; required for inspect/control.' },
      expected_revision: { type: 'number', description: 'Current run revision; required for control.' },
      control_action: { type: 'string', enum: ['approve', 'reject', 'pause', 'resume', 'stop'], description: 'Explicit control decision.' },
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
        return jsonObject({ kind: 'list', runs: runs.slice(0, MAX_LIST_ITEMS).map(boundedSummary), truncated: runs.length > MAX_LIST_ITEMS })
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
      const preferences = foldDebatePreferences(agent.session.events)
      if (preferences.mode === 'disabled') {
        throw new Error('Debate is disabled for this Session; select Auto or Debate before starting')
      }
      if (args.prompt === undefined || args.prompt.trim().length === 0) throw new Error('prompt is required for action=start')
      const workspace = agent.session.header.cwd
      if (workspace === undefined || workspace.length === 0) throw new Error('action=start requires a Session workspace')

      const request: DebateStartRequestV1 = {
        version: 1,
        commandId: stableCommandId,
        workspace,
        prompt: args.prompt,
        ...(args.objective === undefined || args.objective.trim().length === 0 ? {} : { objective: args.objective }),
        policy: debatePolicyForPrompt(args.prompt, preferences.mode),
        execution: { version: 1, kind: 'standalone' },
        sourceSessionId: String(agent.id),
      }
      const started = await ctx.debates.start(request)
      await projectToolTrace(started)
      const run = preferences.mode === 'enabled'
        ? await approveExplicitDebate(ctx, started, stableCommandId)
        : started
      await projectToolTrace(run)
      agent.session.append('debate/admission', {
        runId: run.runId,
        mode: preferences.mode,
        revision: run.revision,
        state: run.state,
      }, { ignorable: true })
      return jsonObject({ kind: 'start', run: boundedRun(run) })
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
