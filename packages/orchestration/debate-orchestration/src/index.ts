/** Debate execution adapter over the existing durable TaskGraph Scheduler. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DebateError } from '@deepseek-ai/dsh-debate'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import LocalDebateProvider from '@deepseek-ai/dsh-debate-local'
import type {
  DebateRoundExecutionRequestV1,
  DebateRoundExecutionResultV1,
  DebateRoundExecutorPort,
  DebateTurnRequestV1,
  DebateTurnResultV1,
} from '@deepseek-ai/dsh-debate-local'
import {
  OrchestrationArtifactRef,
  OrchestrationRunId,
} from '@deepseek-ai/dsh-orchestration'
import type {
  LogicalTaskGraphV1,
  OrchestrationNodeSpecV1,
  OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import type {
  DebateTaskGraphAdapterOptions,
  DebateTaskGraphNodeIdentityV1,
  DebateTaskGraphOrchestrations,
  DebateTaskGraphPlanV1,
} from './types.ts'

export type * from './types.ts'

export const name = 'debate-orchestration'

const DEFAULT_MAX_PARALLEL = 3
const DEFAULT_POLL_INTERVAL_MS = 50
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000
const MAX_RESULT_PREVIEW = 4_000

/** Loader configuration for the local Debate owner and TaskGraph adapter. */
export interface Config extends DebateTaskGraphAdapterOptions {
  /** Optional DSH home; defaults to the ordinary harness-owned location. */
  readonly dshHome?: string
  /** Stable Provider identity retained in Debate provenance. */
  readonly providerId?: string
  /** Provider version retained in Debate provenance. */
  readonly providerVersion?: string
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  providerId: z.string(),
  providerVersion: z.string(),
  maxParallel: z.number().min(1).max(4).step(1).default(DEFAULT_MAX_PARALLEL),
  pollIntervalMs: z.number().min(10).max(10_000).step(1).default(DEFAULT_POLL_INTERVAL_MS),
  timeoutMs: z.number().min(1_000).max(86_400_000).step(1).default(DEFAULT_TIMEOUT_MS),
})

function nodeId(round: number, slotId: string): string {
  return `debate-r${String(round)}-${slotId}`
}

function outputSchema(): string {
  return JSON.stringify({
    confidence: 'number 0..1',
    outputPreview: 'bounded final answer or analysis',
    claims: [{
      version: 1,
      claimId: 'stable claim id',
      statement: 'claim text',
      status: 'open|supported|refuted|settled|unresolved',
      severity: 'low|medium|high|critical',
      confidence: 'number 0..1',
      supportingSlotIds: ['slot id'],
      opposingSlotIds: ['slot id'],
      evidenceRefs: [{ version: 1, ref: 'source or artifact ref', kind: 'source|artifact|observation|quote' }],
      rationale: 'optional concise rationale',
    }],
    dissent: [{
      version: 1,
      claimId: 'known claim id',
      position: 'minority position',
      reason: 'reason',
      confidence: 'number 0..1',
      evidenceRefs: [],
    }],
    unresolved: [{
      version: 1,
      claimId: 'known claim id',
      description: 'gap',
      severity: 'low|medium|high|critical',
      blocking: true,
      reason: 'reason',
      requiredEvidenceRefs: [],
    }],
    evidenceRefs: [],
  })
}

function taskFor(turn: DebateTurnRequestV1): string {
  const judgeInstructions = turn.role === 'decision-judge'
    ? [
      'All participant nodes in this round are dependencies of this judge node.',
      'Read every upstream Evidence body supplied by the TaskGraph Context Packet before judging.',
      'Synthesize the best supported result while preserving material dissent and unresolved gaps.',
    ]
    : [
      turn.round === 1
        ? 'Work independently; do not infer or imitate another participant response.'
        : 'Use only claim IDs already present in the prior ledger; do not expand the topic.',
    ]
  return [
    `Debate run ${turn.runId}, round ${String(turn.round)}, slot ${turn.slotId}.`,
    `Role: ${turn.persona.title}.`,
    `Mandate: ${turn.persona.mandate}`,
    `Stance: ${turn.persona.stance}`,
    ...turn.persona.instructions.map(instruction => `- ${instruction}`),
    ...judgeInstructions,
    '',
    `Objective: ${turn.objective ?? turn.prompt}`,
    `User request: ${turn.prompt}`,
    `Round phase: ${turn.phase}`,
    `Source refs: ${JSON.stringify(turn.sourceRefs)}`,
    `Parent execution: ${JSON.stringify(turn.execution ?? null)}`,
    `Source session: ${turn.sourceSessionId ?? 'none'}`,
    `Prior claim ledger: ${JSON.stringify(turn.priorLedger)}`,
    `Prior dissent: ${JSON.stringify(turn.priorDissent)}`,
    `Prior unresolved gaps: ${JSON.stringify(turn.priorUnresolved)}`,
    '',
    'Return exactly one JSON object. Do not use a Markdown fence or prose outside the object.',
    `Required response contract: ${outputSchema()}`,
  ].join('\n')
}

function graphNode(turn: DebateTurnRequestV1, participantIds: readonly string[]): OrchestrationNodeSpecV1 {
  const judge = turn.role === 'decision-judge'
  return {
    id: nodeId(turn.round, turn.slotId),
    dependsOn: judge ? participantIds : [],
    requiredForCompletion: true,
    title: `${turn.persona.title} · round ${String(turn.round)}`,
    task: taskFor(turn),
    role: `debate:${turn.role}`,
    capabilityRequirements: [],
    capabilityBudget: [],
    contextPolicy: {
      maxTokens: 16_000,
      allowedSourceKinds: ['intent', 'artifact'],
      unavailableSource: 'block',
    },
    effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
    readScopes: [],
    writeScopes: [],
    approvedSecretRefs: [],
    acceptance: [{
      id: 'debate-turn-completed',
      description: 'The selected operator returns one complete structured Debate turn.',
      kind: 'operator-completed',
    }],
    retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
    phase: judge ? 'synthesis' : 'execution',
    rlm: { mode: 'disabled', maxDepth: 1, maxChildren: 1, maxTurns: 1 },
    autonomous: { mode: 'disabled' },
    operator: { preferredIds: [turn.operatorId], profile: { model: turn.model } },
  }
}

function resultObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DebateError(`${label} must be an object`, 'DEBATE_INVALID')
  }
  return value as Record<string, unknown>
}

function textOutput(value: unknown, label: string): string {
  const evidence = resultObject(value, label)
  if (evidence.stopReason !== 'completed') {
    throw new DebateError(`${label} did not complete`, 'DEBATE_PROVIDER_UNAVAILABLE')
  }
  if (!Array.isArray(evidence.output)) throw new DebateError(`${label}.output must be an array`, 'DEBATE_INVALID')
  return evidence.output.map((block, index) => {
    const record = resultObject(block, `${label}.output[${String(index)}]`)
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).join('\n').trim()
}

function parseJsonOutput(text: string, label: string): Record<string, unknown> {
  const unfenced = text.replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch (error) {
    throw new DebateError(`${label} returned invalid JSON`, 'DEBATE_INVALID', { cause: error })
  }
  return resultObject(parsed, label)
}

function evidenceUsage(value: unknown): DebateTurnResultV1['usage'] {
  const evidence = resultObject(value, 'orchestration Evidence')
  if (evidence.usage === undefined) return undefined
  const usage = resultObject(evidence.usage, 'orchestration Evidence.usage')
  if (!Number.isSafeInteger(usage.inputTokens) || Number(usage.inputTokens) < 0
    || !Number.isSafeInteger(usage.outputTokens) || Number(usage.outputTokens) < 0) {
    throw new DebateError('orchestration Evidence usage is invalid', 'DEBATE_INVALID')
  }
  const cacheRead = usage.cacheReadInputTokens
  const cacheWrite = usage.cacheWriteInputTokens
  const cost = usage.costUsd
  if (cacheRead !== undefined && (!Number.isSafeInteger(cacheRead) || Number(cacheRead) < 0)) {
    throw new DebateError('orchestration Evidence cache-read usage is invalid', 'DEBATE_INVALID')
  }
  if (cacheWrite !== undefined && (!Number.isSafeInteger(cacheWrite) || Number(cacheWrite) < 0)) {
    throw new DebateError('orchestration Evidence cache-write usage is invalid', 'DEBATE_INVALID')
  }
  if (cost !== undefined && (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)) {
    throw new DebateError('orchestration Evidence cost is invalid', 'DEBATE_INVALID')
  }
  return {
    inputTokens: Number(usage.inputTokens),
    outputTokens: Number(usage.outputTokens),
    ...(cacheRead === undefined ? {} : { cacheReadInputTokens: Number(cacheRead) }),
    ...(cacheWrite === undefined ? {} : { cacheWriteInputTokens: Number(cacheWrite) }),
    ...(cost === undefined ? {} : { costUsd: cost }),
  }
}

function terminal(state: OrchestrationRunSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'indeterminate'
}

/** One-round adapter that compiles and starts only the existing TaskGraph service. */
export class DebateTaskGraphRoundExecutor implements DebateRoundExecutorPort {
  private readonly maxParallel: number
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number

  constructor(
    private readonly orchestrations: DebateTaskGraphOrchestrations,
    options: DebateTaskGraphAdapterOptions = {},
  ) {
    this.maxParallel = options.maxParallel ?? DEFAULT_MAX_PARALLEL
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * Build the immutable round graph without executing it.
   * @param request - sealed roster turns for one Debate round.
   * @returns certified TaskGraph plan for the existing Scheduler.
   */
  plan(request: DebateRoundExecutionRequestV1): DebateTaskGraphPlanV1 {
    if (request.turns.length < 3) throw new DebateError('a Debate round requires at least two participants and one judge', 'DEBATE_ROSTER_INVALID')
    const judgeTurns = request.turns.filter(turn => turn.role === 'decision-judge')
    const participants = request.turns.filter(turn => turn.role !== 'decision-judge')
    if (judgeTurns.length !== 1 || participants.length < 2) {
      throw new DebateError('a Debate round requires exactly one judge and at least two participants', 'DEBATE_ROSTER_INVALID')
    }
    const judge = judgeTurns[0]
    if (judge === undefined) throw new DebateError('Debate round judge is missing', 'DEBATE_ROSTER_INVALID')
    const workspace = request.turns[0]?.workspace
    if (workspace === undefined || request.turns.some(turn => turn.workspace !== workspace)) {
      throw new DebateError('all Debate turns in one round must use the same workspace', 'DEBATE_INVALID')
    }
    const unsupportedSource = request.turns.find(turn => turn.source !== 'native-subscription')
    if (unsupportedSource !== undefined) {
      throw new DebateError(
        `TaskGraph Debate requires an exact native-subscription model binding for ${unsupportedSource.slotId}`,
        'DEBATE_UNSUPPORTED',
      )
    }
    const participantIds = participants.map(turn => nodeId(turn.round, turn.slotId))
    const orderedTurns = [...participants, judge]
    const graph: LogicalTaskGraphV1 = {
      version: 1,
      title: `Debate ${request.runId} · round ${String(request.round)}`,
      workspace,
      workspaceIsolation: 'shared',
      maxParallel: Math.max(1, Math.min(request.maxParallel, this.maxParallel, participants.length)),
      risk: 'low',
      nodes: orderedTurns.map(turn => graphNode(turn, participantIds)),
    }
    return {
      graph,
      identities: orderedTurns.map((turn): DebateTaskGraphNodeIdentityV1 => ({
        version: 1,
        nodeId: nodeId(turn.round, turn.slotId),
        slotId: turn.slotId,
        runId: request.runId,
        round: request.round,
      })),
    }
  }

  /** Execute one round through the single durable TaskGraph authority. */
  async executeRound(request: DebateRoundExecutionRequestV1): Promise<DebateRoundExecutionResultV1> {
    const plan = this.plan(request)
    const sourceSessionId = request.turns.find(turn => turn.sourceSessionId !== undefined)?.sourceSessionId
      ?? `debate:${request.runId}`
    const compilation = await this.orchestrations.compile({
      intent: {
        request: request.turns[0]?.objective ?? request.turns[0]?.prompt ?? `Debate round ${String(request.round)}`,
        ...(request.turns[0]?.sourceRefs === undefined
          ? {}
          : { sourceRefs: request.turns[0].sourceRefs.map(ref => ref.ref) }),
      },
      graph: plan.graph,
      admission: {
        policy: 'auto',
        route: 'taskgraph',
        sourceSessionId,
        rlm: 'disabled',
        autonomous: 'disabled',
        continualHarness: 'off',
        optimization: 'quality',
      },
    })
    let run = await this.orchestrations.start({
      commandId: `debate:${request.runId}:round:${String(request.round)}`,
      compilationId: compilation.compilationId,
    })
    const deadline = Date.now() + this.timeoutMs
    while (!terminal(run.state)) {
      if (request.signal?.aborted === true) {
        try {
          const latest = await this.orchestrations.inspect(run.runId)
          if (terminal(latest.state)) {
            run = latest
            break
          }
          const cancelled = await this.orchestrations.control({
            commandId: `debate:${request.runId}:round:${String(request.round)}:cancel:${String(latest.revision)}`,
            runId: latest.runId,
            expectedRevision: latest.revision,
            action: 'cancel',
            reason: typeof request.signal.reason === 'string' ? request.signal.reason : 'Debate stop requested',
          })
          if (cancelled.state !== 'cancelled') {
            throw new Error(`cancel returned ${cancelled.state}`)
          }
        } catch (error) {
          throw new DebateError(
            `Debate TaskGraph ${String(run.runId)} interruption outcome is indeterminate`,
            'DEBATE_INDETERMINATE',
            { cause: error },
          )
        }
        throw new DebateError(`Debate TaskGraph ${String(run.runId)} was interrupted`, 'DEBATE_INTERRUPTED')
      }
      if (Date.now() >= deadline) {
        throw new DebateError(`Debate TaskGraph ${String(run.runId)} exceeded its adapter wait bound`, 'DEBATE_INDETERMINATE')
      }
      await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs))
      run = await this.orchestrations.inspect(OrchestrationRunId(String(run.runId)))
    }
    if (run.state === 'indeterminate') {
      throw new DebateError(`Debate TaskGraph ${String(run.runId)} is indeterminate`, 'DEBATE_INDETERMINATE')
    }
    if (run.state !== 'completed') {
      throw new DebateError(`Debate TaskGraph ${String(run.runId)} ended as ${run.state}`, 'DEBATE_PROVIDER_UNAVAILABLE')
    }
    const resultsBySlot: Record<string, DebateTurnResultV1> = {}
    for (const identity of plan.identities) {
      const node = run.nodes.find(candidate => candidate.id === identity.nodeId)
      const evidenceRef = node?.evidenceRefs.at(-1)
      if (node?.state !== 'passed' || evidenceRef === undefined) {
        throw new DebateError(`Debate node ${identity.nodeId} omitted settled Evidence`, 'DEBATE_PROVIDER_UNAVAILABLE')
      }
      const evidence = await this.orchestrations.readArtifact(OrchestrationArtifactRef(String(evidenceRef)))
      const output = textOutput(evidence, `Debate node ${identity.nodeId}`)
      const parsed = parseJsonOutput(output, `Debate node ${identity.nodeId}`)
      const usage = evidenceUsage(evidence)
      resultsBySlot[identity.slotId] = {
        ...parsed as unknown as DebateTurnResultV1,
        outputRef: String(evidenceRef),
        outputPreview: typeof parsed.outputPreview === 'string'
          ? parsed.outputPreview.slice(0, MAX_RESULT_PREVIEW)
          : output.slice(0, MAX_RESULT_PREVIEW),
        ...(usage === undefined ? {} : { usage }),
      }
    }
    return { version: 1, resultsBySlot }
  }
}

export const inject = ['orchestrations']

/** Mount the local Debate owner with the existing TaskGraph service as its only executor. */
export function apply(ctx: Context, config: Config): void {
  const executor = new DebateTaskGraphRoundExecutor(ctx.orchestrations, config)
  ctx.plugin(LocalDebateProvider, {
    root: `${resolveDshHome(config.dshHome)}/debates`,
    executor,
    ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
    ...(config.providerVersion === undefined ? {} : { providerVersion: config.providerVersion }),
  })
}
