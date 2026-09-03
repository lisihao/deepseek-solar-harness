/** Debate execution adapter over the existing durable TaskGraph Scheduler. */

import type { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  DebateError,
  type DebateAgentProgressUsageV1,
  type DebateAgentProgressV1,
  type DebateTurnRoutingV1,
} from '@deepseek-ai/dsh-debate'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import LocalDebateProvider from '@deepseek-ai/dsh-debate-local'
import type {
  DebateRoundExecutionRequestV1,
  DebateRoundExecutionResultV1,
  DebateRoundAgentProgressV1,
  DebateRoundExecutorPort,
  DebateTurnFailureV1,
  DebateTurnRequestV1,
  DebateTurnResultV1,
} from '@deepseek-ai/dsh-debate-local'
import {
  OrchestrationArtifactRef,
  OrchestrationRunId,
} from '@deepseek-ai/dsh-orchestration'
import type {
  LogicalTaskGraphV1,
  NodeExecutionPlanV1,
  OrchestrationNodeSnapshot,
  OrchestrationNodeSpecV1,
  OrchestrationEvent,
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
const MAX_PROGRESS_PREVIEW = 1_600
const MAX_PROGRESS_NAME = 160

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
    outputPreview: 'bounded public user-facing summary; never hidden reasoning, chain-of-thought, or private analysis',
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
      ...(turn.round === 1 ? [] : [
        'Keep the prior ledger as the topic boundary. You may add at most four new claim IDs only when they are strictly necessary to reconcile this round\'s participant evidence.',
        'Any dissent or unresolved entry must reference either a prior claim ID or one reconciliation claim emitted in this same result.',
      ]),
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
    operator: {
      preferredIds: [turn.operatorId],
      ...(turn.fallbackOperatorIds === undefined ? {} : { fallbackIds: turn.fallbackOperatorIds }),
      profile: { model: turn.model },
    },
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

function boundedPublicText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, limit)
  return text.length === 0 ? undefined : text
}

function publicProgressUsage(value: unknown): DebateAgentProgressUsageV1 | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const entries = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'costUsd']
    .flatMap((field) => {
      const counter = source[field]
      return typeof counter === 'number' && Number.isFinite(counter) && counter >= 0
        ? [[field, counter] as const]
        : []
    })
  return entries.length === 0
    ? undefined
    : Object.fromEntries(entries) as DebateAgentProgressUsageV1
}

function publicProgress(
  event: OrchestrationEvent,
  orchestrationRunId: string,
  routing: DebateTurnRoutingV1,
): DebateAgentProgressV1 | undefined {
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1 || !Number.isFinite(Date.parse(event.time))) return undefined
  const source = {
    orchestrationRunId,
    sequence: event.sequence,
    time: new Date(event.time).toISOString(),
  }
  const publicRouting: DebateTurnRoutingV1 = Object.assign(
    { version: 1 as const, requestedOperatorId: routing.requestedOperatorId, requestedModel: routing.requestedModel },
    routing.actualOperatorId === undefined ? {} : { actualOperatorId: routing.actualOperatorId },
    routing.actualModel === undefined ? {} : { actualModel: routing.actualModel },
    routing.fallbackReasonCode === undefined ? {} : { fallbackReasonCode: routing.fallbackReasonCode },
  )
  if (event.type === 'node.operator.progress') {
    const phase = boundedPublicText(event.data.phase, MAX_PROGRESS_NAME)
    return phase === undefined ? undefined : { version: 1, kind: 'phase', source, phase, routing: publicRouting }
  }
  if (event.type !== 'node.operator.observation') return undefined
  const observation = event.data.observation
  if (observation === null || typeof observation !== 'object' || Array.isArray(observation)) return undefined
  const value = observation as Record<string, unknown>
  switch (value.kind) {
    case 'public-output': {
      const publicOutputPreview = boundedPublicText(value.preview, MAX_PROGRESS_PREVIEW)
      return publicOutputPreview === undefined
        ? undefined
        : { version: 1, kind: 'public-output', source, publicOutputPreview, routing: publicRouting }
    }
    case 'tool-started':
    case 'tool-completed': {
      const toolName = boundedPublicText(value.toolName, MAX_PROGRESS_NAME)
      return toolName === undefined ? undefined : { version: 1, kind: value.kind, source, toolName, routing: publicRouting }
    }
    case 'approval-required': {
      const approvalKind = boundedPublicText(value.approvalKind, MAX_PROGRESS_NAME)
      const approvalPreview = boundedPublicText(value.preview, MAX_PROGRESS_PREVIEW)
      return approvalKind === undefined
        ? undefined
        : {
          version: 1,
          kind: 'approval-required',
          source,
          approvalKind,
          ...(approvalPreview === undefined ? {} : { approvalPreview }),
          routing: publicRouting,
        }
    }
    case 'usage-updated': {
      const usage = publicProgressUsage(value.usage)
      return usage === undefined ? undefined : { version: 1, kind: 'usage-updated', source, usage, routing: publicRouting }
    }
    default: return undefined
  }
}

function terminal(state: OrchestrationRunSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'indeterminate'
}

function failureCode(error: unknown): string {
  if (error instanceof DebateError) return error.code
  if (error instanceof Error) {
    const code = (error as Error & { readonly code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  return 'DEBATE_INVALID'
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function participantFailure(
  node: OrchestrationNodeSnapshot,
  routing: DebateTurnRoutingV1,
  error: unknown,
): DebateTurnFailureV1 {
  const code = failureCode(error)
  return {
    state: 'failed',
    attempt: node.attempt,
    errorCode: code,
    blockers: [{ code, message: failureMessage(error), nodeId: node.id }],
    routing,
  }
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

  private async routing(
    turn: DebateTurnRequestV1,
    node: OrchestrationNodeSnapshot,
  ): Promise<DebateTurnRoutingV1> {
    let fallbackReasonCode: string | undefined
    let allocationPlanRef: string | undefined
    if (node.executionPlanRef !== undefined) {
      const rawPlan = await this.orchestrations.readArtifact(node.executionPlanRef)
      if (typeof rawPlan !== 'object' || rawPlan === null || !('allocationPlanRef' in rawPlan) || !('allocationPlan' in rawPlan)) {
        throw new DebateError(`Debate node ${node.id} has an invalid execution plan artifact`, 'DEBATE_INVALID')
      }
      const plan = rawPlan as NodeExecutionPlanV1
      allocationPlanRef = String(plan.allocationPlanRef)
      fallbackReasonCode = plan.allocationPlan.fallback?.reasonCode
    }
    return {
      version: 1,
      requestedOperatorId: turn.operatorId,
      requestedModel: turn.model,
      ...(node.operatorId === undefined ? {} : { actualOperatorId: node.operatorId }),
      ...(node.model === undefined ? {} : { actualModel: node.model }),
      ...(fallbackReasonCode === undefined ? {} : { fallbackReasonCode }),
      ...(allocationPlanRef === undefined ? {} : { allocationPlanRef }),
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
    let progressCursor = 0
    const reportedProgress = new Set<string>()
    const routingByNode = new Map<string, Promise<DebateTurnRoutingV1>>()
    const drainProgress = async (): Promise<void> => {
      if (request.onProgress === undefined) return
      for (;;) {
        const page = await this.orchestrations.readEvents({
          runId: run.runId,
          afterSequence: progressCursor,
          limit: 200,
        })
        if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence < progressCursor) {
          throw new DebateError(`Debate TaskGraph ${String(run.runId)} returned an invalid progress cursor`, 'DEBATE_INVALID')
        }
        if (page.events.length === 0) return
        if (page.nextSequence <= progressCursor) {
          throw new DebateError(`Debate TaskGraph ${String(run.runId)} progress cursor did not advance`, 'DEBATE_INVALID')
        }
        for (const event of page.events) {
          if (event.type !== 'node.operator.progress' && event.type !== 'node.operator.observation') continue
          const identity = plan.identities.find(candidate => candidate.nodeId === event.nodeId)
          if (identity === undefined) continue
          const node = run.nodes.find(candidate => candidate.id === identity.nodeId)
          const turn = request.turns.find(candidate => candidate.slotId === identity.slotId)
          if (node === undefined || turn === undefined) continue
          const routingKey = `${node.id}\u0000${String(node.attempt)}`
          let routing = routingByNode.get(routingKey)
          if (routing === undefined) {
            routing = this.routing(turn, node)
            routingByNode.set(routingKey, routing)
          }
          const progress = publicProgress(event, String(run.runId), await routing)
          if (progress === undefined) continue
          const key = `${identity.round}\u0000${identity.slotId}\u0000${progress.source.orchestrationRunId}\u0000${String(progress.source.sequence)}`
          if (reportedProgress.has(key)) continue
          await request.onProgress({
            version: 1,
            runId: request.runId,
            round: identity.round,
            slotId: identity.slotId,
            role: turn.role,
            progress,
          } satisfies DebateRoundAgentProgressV1)
          reportedProgress.add(key)
        }
        progressCursor = page.nextSequence
        if (page.events.length < 200) return
      }
    }
    await drainProgress()
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
      await drainProgress()
    }
    await drainProgress()
    const resultsBySlot: Record<string, DebateTurnResultV1> = {}
    const failuresBySlot: Record<string, DebateTurnFailureV1> = {}
    let hasNonPassedNodeFailure = false
    for (const identity of plan.identities) {
      const node = run.nodes.find(candidate => candidate.id === identity.nodeId)
      const turn = request.turns.find(candidate => candidate.slotId === identity.slotId)
      if (node === undefined || turn === undefined) {
        throw new DebateError(`Debate TaskGraph omitted planned node ${identity.nodeId}`, 'DEBATE_INVALID')
      }
      const routing = await this.routing(turn, node)
      if (node.state !== 'passed') {
        hasNonPassedNodeFailure = true
        if (!['blocked', 'failed', 'indeterminate', 'cancelled'].includes(node.state)) {
          throw new DebateError(
            `Debate TaskGraph ended as ${run.state} with non-terminal node ${identity.nodeId}=${node.state}`,
            'DEBATE_INVALID',
          )
        }
        const state = node.state === 'blocked'
          ? 'blocked' as const
          : node.state === 'indeterminate'
            ? 'indeterminate' as const
            : 'failed' as const
        const defaultCode = node.state === 'indeterminate'
          ? 'DEBATE_INDETERMINATE'
          : node.state === 'cancelled'
            ? 'DEBATE_INTERRUPTED'
            : 'DEBATE_PROVIDER_UNAVAILABLE'
        failuresBySlot[identity.slotId] = {
          state,
          attempt: node.attempt,
          errorCode: node.blockers[0]?.code ?? defaultCode,
          blockers: node.blockers.map(blocker => ({ ...blocker })),
          routing,
        }
        continue
      }
      const evidenceRef = node.evidenceRefs.at(-1)
      if (evidenceRef === undefined) {
        failuresBySlot[identity.slotId] = participantFailure(
          node,
          routing,
          new DebateError(`Debate node ${identity.nodeId} omitted settled Evidence`, 'DEBATE_PROVIDER_UNAVAILABLE'),
        )
        continue
      }
      // Keep the durable artifact read outside the participant parser catches:
      // an unavailable/corrupt orchestration store is a run-level failure, not
      // a partial Debate result that can be safely presented as settled.
      const evidence = await this.orchestrations.readArtifact(OrchestrationArtifactRef(String(evidenceRef)))
      let output: string
      try {
        output = textOutput(evidence, `Debate node ${identity.nodeId}`)
      } catch (error) {
        failuresBySlot[identity.slotId] = participantFailure(node, routing, error)
        continue
      }
      let parsed: Record<string, unknown>
      try {
        parsed = parseJsonOutput(output, `Debate node ${identity.nodeId}`)
      } catch (error) {
        failuresBySlot[identity.slotId] = participantFailure(node, routing, error)
        continue
      }
      let usage: DebateTurnResultV1['usage']
      try {
        usage = evidenceUsage(evidence)
      } catch (error) {
        failuresBySlot[identity.slotId] = participantFailure(node, routing, error)
        continue
      }
      resultsBySlot[identity.slotId] = {
        ...parsed as unknown as DebateTurnResultV1,
        attempt: node.attempt,
        routing,
        outputRef: String(evidenceRef),
        outputPreview: typeof parsed.outputPreview === 'string'
          ? parsed.outputPreview.slice(0, MAX_RESULT_PREVIEW)
          : output.slice(0, MAX_RESULT_PREVIEW),
        ...(usage === undefined ? {} : { usage }),
      }
    }
    if (run.state === 'completed' && hasNonPassedNodeFailure) {
      throw new DebateError(`Completed Debate TaskGraph ${String(run.runId)} contains failed nodes`, 'DEBATE_INVALID')
    }
    if (run.state !== 'completed' && !hasNonPassedNodeFailure) {
      throw new DebateError(`Debate TaskGraph ${String(run.runId)} ended as ${run.state} without a node failure`, 'DEBATE_PROVIDER_UNAVAILABLE')
    }
    return {
      version: 1,
      resultsBySlot,
      ...(Object.keys(failuresBySlot).length === 0 ? {} : { failuresBySlot }),
    }
  }
}

export const inject = ['orchestrations']

/** Mount the local Debate owner with the existing TaskGraph service as its only executor. */
export function apply(ctx: Context, config: Config): void {
  const executor = new DebateTaskGraphRoundExecutor(ctx.orchestrations, config)
  ctx.plugin(LocalDebateProvider, {
    root: join(resolveDshHome(config.dshHome), 'debates'),
    executor,
    ...(config.providerId === undefined ? {} : { providerId: config.providerId }),
    ...(config.providerVersion === undefined ? {} : { providerVersion: config.providerVersion }),
  })
}
