/** Model-facing Consumer and per-session policy for the provider-neutral Debate seam. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
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
const EXPLICIT_DEBATE_APPROVAL_REASON = 'The user explicitly selected Debate for this Session and submitted this request.'
const CONCISE_DEBATE_HINT = /(?:简洁|简要|精简|三条|要点|concise|brief)/iu

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
  const summary = run.synthesis?.outputPreview
    ?? `Debate run is ${run.state}; inspect ${run.runId} for its current durable state.`
  return [
    summary,
    '',
    `Debate Run: ${run.runId}`,
    `State: ${run.state}`,
    `Rounds: ${String(run.currentRound)}`,
    ...run.synthesis?.artifactRef === undefined ? [] : [`Artifact: ${run.synthesis.artifactRef}`],
    ...run.unresolved.length === 0 ? [] : [`Unresolved: ${String(run.unresolved.length)}`],
    ...run.dissent.length === 0 ? [] : [`Dissent: ${String(run.dissent.length)}`],
  ].join('\n')
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

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: DEBATE_HOST_MODEL, name: 'Debate' }])
  }

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
    const run = await this.ctx.debates.start({
      version: 1,
      commandId: dispatch.commandId,
      workspace,
      prompt,
      policy: debatePolicyForPrompt(prompt),
      execution: { version: 1, kind: 'standalone' },
      sourceSessionId: String(agent.id),
    })
    const admitted = await approveExplicitDebate(this.ctx, run, dispatch.commandId)
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
    const text = runText(admitted)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    const usage = runUsage(admitted)
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
      agent.session.append('debate/dispatch', {
        commandId: hostCommandId(String(agent.id), current.id),
        promptMessageId: current.id,
        turn,
        step,
      }, { ignorable: true })
      return decision
    })

    hostCtx.on('agent/request', async ({ agent, turn, step }, next) => {
      const base = await next()
      if (dispatchForPosition(agent.session.events, turn, step) === undefined) return base
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
