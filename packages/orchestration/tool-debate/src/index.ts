/** Model-facing Consumer and per-session policy for the provider-neutral Debate seam. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  type DebateControlAction,
  DebateError,
  type DebatePolicyV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateStartRequestV1,
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

const ROLE_COPY: Readonly<Record<string, { readonly title: string; readonly mandate: string }>> = {
  'constructive-proposer': {
    title: '建设性提案者',
    mandate: '提出最可执行的方案，明确关键主张、假设和验收标准。',
  },
  'skeptical-falsifier': {
    title: '怀疑式证伪者',
    mandate: '寻找决定性反例、隐藏假设和失败条件，并按影响排序。',
  },
  'evidence-auditor': {
    title: '证据审计员',
    mandate: '核验重要主张是否有可追溯、直接且与决策相关的证据支持。',
  },
  'decision-judge': {
    title: '决策裁判（主持人）',
    mandate: '综合已支持的主张，裁定分歧，并保留重要少数意见。',
  },
}

const TERMINAL_RUN_STATES: ReadonlySet<DebateRunSnapshotV1['state']> = new Set([
  'completed',
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
    maxInputTokens: 72_000, maxOutputTokens: 48_000, maxTotalTokens: 120_000,
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
      maxInputTokens: 64_000,
      maxOutputTokens: 16_000,
      maxTotalTokens: 80_000,
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
    run.synthesis?.outputPreview ?? '主持人尚未提交最终总结。',
  ]
  if (run.unresolved.length > 0) {
    lines.push('', '### 未决问题', ...run.unresolved.slice(0, MAX_REF_ITEMS).map(item =>
      `- ${item.blocking ? '阻断：' : ''}${item.description}${item.reason.length > 0 ? `（${item.reason}）` : ''}`))
  }
  if (run.dissent.length > 0) {
    lines.push('', '### 保留异议', ...run.dissent.slice(0, MAX_REF_ITEMS).map(item =>
      `- ${roleTitle(item.slotId)}：${item.position}${item.reason.length > 0 ? `（${item.reason}）` : ''}`))
  }
  lines.push('', '<details>', '<summary>技术详情</summary>', '',
    `- Run ID：${run.runId}`,
    `- 状态：${lifecycleLabel(run.state)}`,
    `- 已完成轮次：${String(run.currentRound)}`,
    `- Prompt hash：${run.promptSha256}`,
    `- Provider：${run.provenance.providerId} ${run.provenance.providerVersion}`,
    `- 请求 hash：${run.provenance.requestSha256}`,
    ...run.provenance.outputSha256 === undefined ? [] : [`- 输出 hash：${run.provenance.outputSha256}`],
    ...run.synthesis?.artifactRef === undefined ? [] : [`- 总结 Artifact：${run.synthesis.artifactRef}`],
    '</details>')
  return lines.join('\n')
}

interface TranscriptTracker {
  topicEmitted: boolean
  topicState?: DebateRunSnapshotV1['state']
  rosterEmitted: boolean
  readonly roundStates: Map<number, string>
  readonly turnSignatures: Map<string, string>
  readonly turnFloors: Map<string, number>
  readonly convergenceSignatures: Map<number, string>
  readonly errorSignatures: Set<string>
  synthesisSignature?: string
  finalEmitted: boolean
  nextFloor: number
}

function createTranscriptTracker(): TranscriptTracker {
  return {
    topicEmitted: false,
    rosterEmitted: false,
    roundStates: new Map(),
    turnSignatures: new Map(),
    turnFloors: new Map(),
    convergenceSignatures: new Map(),
    errorSignatures: new Set(),
    finalEmitted: false,
    nextFloor: 1,
  }
}

function transcriptLines(
  run: DebateRunSnapshotV1,
  tracker: TranscriptTracker,
  final: boolean,
): string[] {
  const lines: string[] = []
  if (!tracker.topicEmitted) {
    tracker.topicEmitted = true
    tracker.topicState = run.state
    lines.push(
      '# 主题帖 · Debate',
      `状态：${lifecycleLabel(run.state)}`,
      ...run.objective === undefined ? [] : [`议题：${run.objective}`],
      '',
    )
  } else if (tracker.topicState !== run.state) {
    tracker.topicState = run.state
    lines.push(`**主题帖状态更新**：${lifecycleLabel(run.state)}`)
  }
  if (!tracker.rosterEmitted) {
    tracker.rosterEmitted = true
    lines.push('## 参与者名册')
    for (const role of run.roster.slice(0, MAX_REF_ITEMS)) {
      lines.push(`- **${roleTitle(role.role)}**：${roleMandate(role.role, role.persona.mandate)}`)
      lines.push(...roleTechnicalDetails(role))
    }
    lines.push('')
  }

  for (const round of run.rounds.slice(0, MAX_REF_ITEMS)) {
    if (tracker.roundStates.get(round.round) !== round.state) {
      tracker.roundStates.set(round.round, round.state)
      lines.push(`## 第 ${String(round.round)} 轮 · ${roundStateLabel(round.state)}`)
    }
    for (const turn of round.turns.slice(0, MAX_REF_ITEMS)) {
      const key = `${String(round.round)}:${turn.slotId}`
      const signature = JSON.stringify([
        turn.state,
        turn.operatorId,
        turn.model,
        turn.attempt,
        turn.routing,
        turn.blockers,
        turn.outputRef,
        turn.outputPreview,
      ])
      if (tracker.turnSignatures.get(key) === signature) continue
      tracker.turnSignatures.set(key, signature)
      const floor = tracker.turnFloors.get(key) ?? tracker.nextFloor++
      tracker.turnFloors.set(key, floor)
      lines.push(...transcriptTurnLines(run, round.round, floor, turn, tracker))
    }
    if (round.convergence !== undefined) {
      const signature = JSON.stringify(round.convergence)
      if (tracker.convergenceSignatures.get(round.round) !== signature) {
        tracker.convergenceSignatures.set(round.round, signature)
        lines.push(
          `**本轮收敛判断**：${convergenceLabel(round.convergence.status)}`
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

function roleTitle(role: string): string {
  return ROLE_COPY[role]?.title ?? role
}

function roleMandate(role: string, configured: string): string {
  return ROLE_COPY[role]?.mandate ?? preview(configured) ?? '职责未提供。'
}

function roleTechnicalDetails(role: DebatePolicyV1['roster'][number]): string[] {
  return [
    '<details>',
    '<summary>角色技术详情</summary>',
    '',
    `- 角色 ID：${role.role}`,
    `- 算子：${role.operatorId}`,
    `- 模型：${role.model}`,
    `- 层级：${role.tier}`,
    '</details>',
  ]
}

function transcriptTurnLines(
  run: DebateRunSnapshotV1,
  round: number,
  floor: number,
  turn: DebateRunSnapshotV1['rounds'][number]['turns'][number],
  tracker: TranscriptTracker,
): string[] {
  const lines = [
    `### ${String(floor)} 楼 · ${roleTitle(turn.role)}`,
    `**状态：** ${turnStateLabel(turn.state)}`,
  ]
  if (round === 1) lines.push('**发言类型：** 首轮独立发言')
  else if (turn.claimIds.length > 0) lines.push(`**回应主张：** ${claimReferences(run, turn.claimIds)}`)
  if (turn.outputPreview !== undefined) {
    lines.push('', '**公开发言：**', quoteText(preview(turn.outputPreview) ?? ''))
  } else if (turn.state === 'blocked' || turn.state === 'failed' || turn.state === 'indeterminate') {
    lines.push('', '**公开发言：**', '> 未产生公开输出。')
  } else {
    lines.push('', '**公开发言：**', '> 尚未记录公开输出。')
  }
  if (turn.claimIds.length > 0 && round === 1) lines.push(`**提出主张：** ${claimReferences(run, turn.claimIds)}`)
  if (turn.evidenceRefs.length > 0) lines.push(`**证据：** 已关联 ${String(turn.evidenceRefs.length)} 项`)
  for (const blocker of turn.blockers?.slice(0, MAX_REF_ITEMS) ?? []) {
    const signature = `${turn.role}\u0000${turn.round}\u0000${blocker.code}`
    if (tracker.errorSignatures.has(signature)) continue
    tracker.errorSignatures.add(signature)
    lines.push(`> ⚠️ 未完成：${blocker.message}`)
  }
  if (turn.errorCode !== undefined) {
    const signature = `${turn.role}\u0000${turn.round}\u0000${turn.errorCode}`
    if (!tracker.errorSignatures.has(signature)) {
      tracker.errorSignatures.add(signature)
      lines.push(`> ⚠️ 未完成：${turn.errorCode}`)
    }
  }
  lines.push('', '<details>', '<summary>技术详情</summary>', '',
    `- Slot：${turn.slotId}`,
    `- 请求算子/模型：${turn.routing?.requestedOperatorId ?? turn.operatorId}/${turn.routing?.requestedModel ?? turn.model}`,
    `- 实际算子/模型：${turn.routing?.actualOperatorId ?? turn.operatorId}/${turn.routing?.actualModel ?? turn.model}`,
    ...turn.routing?.fallbackReasonCode === undefined ? [] : [
      `- 回退原因：${turn.routing.fallbackReasonCode}`,
      `- 回退路由：${turn.routing.requestedOperatorId}/${turn.routing.requestedModel}`
        + ` → ${turn.routing.actualOperatorId ?? turn.operatorId}/${turn.routing.actualModel ?? turn.model}`,
    ],
    ...turn.attempt === undefined ? [] : [`- Attempt：${String(turn.attempt)}`],
    ...turn.outputRef === undefined ? [] : [`- 输出 Artifact：${turn.outputRef}`],
    ...turn.evidenceRefs.length === 0 ? [] : [`- Evidence refs：${turn.evidenceRefs.map(ref => ref.ref).join('、')}`],
    ...turn.usage === undefined ? [] : [`- Usage：输入 ${String(turn.usage.inputTokens)} · 输出 ${String(turn.usage.outputTokens)}`],
    '</details>',
    '')
  return lines
}

function claimReferences(run: DebateRunSnapshotV1, ids: readonly string[]): string {
  return ids.slice(0, MAX_REF_ITEMS).map((id) => {
    const claim = run.claimLedger.claims.find(item => item.claimId === id)
    return claim === undefined ? `编号 ${id}` : `“${preview(claim.statement) ?? id}”`
  }).join('、')
}

function quoteText(value: string): string {
  return value.split('\n').map(line => `> ${line}`).join('\n')
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
    for (const line of transcriptLines(started, tracker, startedIsTerminal)) {
      const delta = `${line}\n\n`
      assembledText += delta
      yield { type: 'text-delta', index: 0, text: delta }
    }

    let completion: Awaited<typeof completionResult> | undefined
    while (completion === undefined && !TERMINAL_RUN_STATES.has(started.state)) {
      options.signal?.throwIfAborted()
      const observed = await this.ctx.debates.inspect(started.runId)
      for (const line of transcriptLines(observed, tracker, false)) {
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
    for (const line of transcriptLines(admitted, tracker, true)) {
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
      if (args.action === 'list') {
        const runs = await ctx.debates.list()
        return jsonObject({ kind: 'list', runs: runs.slice(0, MAX_LIST_ITEMS).map(boundedSummary), truncated: runs.length > MAX_LIST_ITEMS })
      }

      if (args.action === 'inspect') {
        return jsonObject({ kind: 'inspect', run: boundedRun(await ctx.debates.inspect(requiredRunId(args))) })
      }

      const agent = exec.agent
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
      const run = preferences.mode === 'enabled'
        ? await approveExplicitDebate(ctx, started, stableCommandId)
        : started
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
