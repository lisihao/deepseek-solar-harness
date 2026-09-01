/** Deterministic provider-neutral Debate Service for the ACP Loader snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import DebateService, {
  type DebateAgentTurnV1,
  type DebateClaimV1,
  type DebateControlRequestV1,
  type DebateDissentV1,
  type DebateEventType,
  type DebateEventV1,
  type DebateEventPageV1,
  type DebateEventReadRequestV1,
  type DebateEvidenceRefV1,
  type DebateRoundSnapshotV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateStartRequestV1,
} from '@deepseek-ai/dsh-debate'

const RUN_ID = 'fixture-debate-run'
const CREATED_AT = '2026-08-29T00:00:00.000Z'
const ROUND_NUMBERS = [1, 2] as const

const ROLE_SUMMARIES: Readonly<Record<string, string>> = {
  'constructive-proposer': 'proposes reversible fixture option A with explicit acceptance gates',
  'skeptical-falsifier': 'tests option A against a failure case and preserves the material dissent',
  'evidence-auditor': 'checks that each decision claim is traceable to a bounded fixture artifact',
  'decision-judge': 'reconciles the ledger and records the moderator decision after all peers speak',
}

function turnPreview(round: number, role: string, title: string): string {
  const summary = ROLE_SUMMARIES[role] ?? 'records a deterministic role-specific observation'
  return `R${String(round)} ${title} [${role}]: ${summary}. output-preview:r${String(round)}:${role}`
}

function evidenceRef(round: number, role: string): DebateEvidenceRefV1 {
  return { version: 1, ref: `fixture:evidence:r${String(round)}:${role}`, kind: 'observation' }
}

function claim(round: number, role: string, evidence: DebateEvidenceRefV1): DebateClaimV1 {
  const claimId = `fixture:claim:r${String(round)}:${role}`
  return {
    version: 1,
    claimId,
    statement: `R${String(round)} ${role} observation is bounded and replayable.`,
    status: 'supported',
    severity: 'medium',
    confidence: role === 'decision-judge' ? 0.95 : 0.9,
    supportingSlotIds: [role],
    opposingSlotIds: role === 'skeptical-falsifier' ? ['constructive-proposer'] : [],
    evidenceRefs: [evidence],
    rationale: 'The keyless fixture uses a stable role and round marker rather than a model response.',
  }
}

function turn(round: number, slot: DebateRunSnapshotV1['roster'][number]): DebateAgentTurnV1 {
  const evidence = evidenceRef(round, slot.role)
  return {
    version: 1,
    round,
    slotId: slot.role,
    role: slot.role,
    operatorId: slot.operatorId,
    model: slot.model,
    state: 'settled',
    outputRef: `artifact:${RUN_ID}:round-${String(round)}:${slot.role}`,
    outputPreview: turnPreview(round, slot.role, slot.persona.title),
    claimIds: [claim(round, slot.role, evidence).claimId],
    evidenceRefs: [evidence],
    usage: { inputTokens: 10, outputTokens: 5, costUsd: 0 },
    startedAt: CREATED_AT,
    settledAt: CREATED_AT,
  }
}

function dissent(round: number): DebateDissentV1 {
  const evidence = evidenceRef(round, 'skeptical-falsifier')
  return {
    version: 1,
    slotId: 'skeptical-falsifier',
    claimId: `fixture:claim:r${String(round)}:skeptical-falsifier`,
    position: 'Option B remains viable if the acceptance gate lacks an independent rollback artifact.',
    reason: 'The falsifier keeps the highest-impact counterexample visible to the moderator.',
    confidence: 0.62,
    evidenceRefs: [evidence],
  }
}

function renderTranscript(
  roster: DebateRunSnapshotV1['roster'],
  rounds: readonly DebateRoundSnapshotV1[],
): string {
  const rosterText = roster
    .map(slot => `- ${slot.role} (${slot.kind}) · ${slot.persona.title} · ${slot.operatorId}/${slot.model}`)
    .join('\n')
  const roundsText = rounds
    .map(round => [
      `ROUND ${String(round.round)}`,
      ...round.turns.map(entry => `- ${entry.role}: ${entry.outputPreview ?? entry.outputRef ?? 'no preview'}`),
    ].join('\n'))
    .join('\n\n')
  return [
    'DEBATE TRANSCRIPT (KEYLESS FIXTURE)',
    'ROSTER',
    rosterText,
    '',
    roundsText,
    '',
    'MODERATOR SYNTHESIS',
    'Decision Judge / moderator: choose fixture option A, retain the falsifier dissent, and require the rollback artifact before release.',
    'Synthesis is settled from both rounds; no external model or paid API was called.',
  ].join('\n')
}

function completedProjection(request: DebateStartRequestV1, pending: DebateRunSnapshotV1): DebateRunSnapshotV1 {
  const rounds: DebateRoundSnapshotV1[] = []
  const allClaims: DebateClaimV1[] = []
  const allEvidence: DebateEvidenceRefV1[] = []
  for (const roundNumber of ROUND_NUMBERS) {
    const turns = request.policy.roster.map(slot => turn(roundNumber, slot))
    const roundClaims = turns.map(entry => claim(roundNumber, entry.role, entry.evidenceRefs[0]!))
    allClaims.push(...roundClaims)
    allEvidence.push(...turns.flatMap(entry => entry.evidenceRefs))
    const roundDissent = roundNumber === 2 && request.policy.roster.some(slot => slot.role === 'skeptical-falsifier')
      ? [dissent(roundNumber)]
      : []
    rounds.push({
      version: 1,
      round: roundNumber,
      state: 'completed',
      turns,
      claimLedger: {
        version: 1,
        claims: [...allClaims],
        coverage: 1,
        digest: `sha256:fixture-ledger-round-${String(roundNumber)}`,
      },
      dissent: roundDissent,
      unresolved: [],
      convergence: {
        version: 1,
        status: roundNumber === 2 ? 'converged' : 'continue',
        score: roundNumber === 2 ? 0.95 : 0.84,
        threshold: request.policy.convergence.scoreThreshold,
        disagreement: roundNumber === 2 ? 0.08 : 0.2,
        coverage: 1,
        unresolvedHighSeverity: 0,
        settledAgents: turns.length,
        reason: roundNumber === 2
          ? 'the two-round fixture has complete role coverage and a settled moderator decision'
          : 'the first round is retained before the claim-ledger follow-up',
      },
    })
  }
  const costBySlot = request.policy.roster.map(slot => ({
    version: 1 as const,
    slotId: slot.role,
    model: slot.model,
    usage: { inputTokens: 20, outputTokens: 10, costUsd: 0 },
  }))
  const transcript = renderTranscript(request.policy.roster, rounds)
  const finalDissent = request.policy.roster.some(slot => slot.role === 'skeptical-falsifier') ? [dissent(2)] : []
  return {
    ...pending,
    revision: 1,
    state: 'completed',
    currentRound: 2,
    rounds,
    claimLedger: {
      version: 1,
      claims: allClaims,
      coverage: 1,
      digest: 'sha256:fixture-debate-ledger-complete',
    },
    dissent: finalDissent,
    unresolved: [],
    evidence: {
      version: 1,
      refs: allEvidence,
      coverage: 1,
      missingRefs: [],
      lineage: allEvidence.map(entry => entry.ref),
    },
    cost: {
      version: 1,
      usageStatus: 'known',
      costStatus: 'known',
      inputTokens: request.policy.roster.length * 20,
      outputTokens: request.policy.roster.length * 10,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsd: 0,
      unknownUsageTurns: 0,
      unknownCostTurns: 0,
      bySlot: costBySlot,
    },
    synthesis: {
      version: 1,
      state: 'settled',
      artifactRef: `artifact:${RUN_ID}:moderator-synthesis`,
      outputPreview: transcript,
      unresolvedClaimIds: [],
      dissentCount: finalDissent.length,
    },
    updatedAt: CREATED_AT,
  }
}

function debateEvent(
  sequence: number,
  type: DebateEventType,
  data: DebateEventV1['data'],
  context: { readonly round?: number; readonly slotId?: string } = {},
): DebateEventV1 {
  return {
    version: 1,
    sequence,
    runId: RUN_ID,
    revision: 1,
    generation: sequence,
    type,
    createdAt: CREATED_AT,
    data,
    ...(context.round === undefined ? {} : { round: context.round }),
    ...(context.slotId === undefined ? {} : { slotId: context.slotId }),
  }
}

function completedEvents(run: DebateRunSnapshotV1): DebateEventV1[] {
  const events: DebateEventV1[] = [
    debateEvent(1, 'debate.planned', { state: 'planned' }),
    debateEvent(2, 'debate.roster.qualified', { roles: run.roster.map(slot => slot.role) }),
    debateEvent(3, 'debate.admitted', { state: 'round_running' }),
  ]
  for (const round of run.rounds) {
    events.push(debateEvent(events.length + 1, 'debate.round.started', { phase: round.round === 1 ? 'blind-independent' : 'claim-ledger' }, { round: round.round }))
    for (const entry of round.turns) {
      events.push(debateEvent(events.length + 1, 'debate.agent.dispatched', { role: entry.role }, { round: round.round, slotId: entry.slotId }))
      events.push(debateEvent(events.length + 1, 'debate.agent.settled', {
        role: entry.role,
        outputRef: entry.outputRef ?? '',
        outputPreview: entry.outputPreview ?? '',
      }, { round: round.round, slotId: entry.slotId }))
    }
    events.push(debateEvent(events.length + 1, 'debate.claims.compiled', { claimCount: round.claimLedger.claims.length }, { round: round.round }))
    events.push(debateEvent(events.length + 1, 'debate.convergence.evaluated', {
      status: round.convergence?.status ?? 'continue',
      settledAgents: round.convergence?.settledAgents ?? 0,
    }, { round: round.round }))
    events.push(debateEvent(events.length + 1, 'debate.cost.accounted', { costUsd: run.cost.costUsd ?? 0 }, { round: round.round }))
  }
  events.push(debateEvent(events.length + 1, 'debate.synthesis.started', { round: run.currentRound }, { round: run.currentRound }))
  events.push(debateEvent(events.length + 1, 'debate.synthesis.settled', {
    artifactRef: run.synthesis?.artifactRef ?? '',
    outputPreview: run.synthesis?.outputPreview ?? '',
  }, { round: run.currentRound }))
  return events
}

function pendingEvents(run: DebateRunSnapshotV1): DebateEventV1[] {
  return [
    debateEvent(1, 'debate.planned', { state: 'planned' }),
    debateEvent(2, 'debate.roster.qualified', { roles: run.roster.map(slot => slot.role) }),
  ]
}

function snapshot(request: DebateStartRequestV1, state: DebateRunSnapshotV1['state']): DebateRunSnapshotV1 {
  const cost: DebateRunSnapshotV1['cost'] = {
    version: 1,
    usageStatus: 'known',
    costStatus: 'known',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    costUsd: 0,
    unknownUsageTurns: 0,
    unknownCostTurns: 0,
    bySlot: [],
  }
  const policy = request.policy
  return {
    version: 1,
    runId: RUN_ID,
    revision: state === 'awaiting_approval' ? 0 : 1,
    state,
    mode: policy.mode,
    promptSha256: 'sha256:fixture-debate-prompt',
    ...(request.objective === undefined ? {} : { objective: request.objective }),
    policy,
    roster: policy.roster,
    currentRound: 0,
    rounds: [],
    claimLedger: { version: 1, claims: [], coverage: 0, digest: 'sha256:fixture-debate-ledger' },
    dissent: [],
    unresolved: [],
    evidence: { version: 1, refs: [], coverage: 0, missingRefs: [], lineage: [] },
    cost,
    provenance: {
      version: 1,
      providerId: 'debate-loader-fixture',
      providerVersion: '1',
      requestSha256: 'sha256:fixture-debate-request',
      policySha256: 'sha256:fixture-debate-policy',
      ...(request.sourceSessionId === undefined ? {} : { sourceSessionId: request.sourceSessionId }),
    },
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  }
}

/** A real Loader service implementation whose methods never call a model. */
class FixtureDebateService extends DebateService {
  private current: DebateRunSnapshotV1 | undefined
  private startRequest: DebateStartRequestV1 | undefined
  private events: DebateEventV1[] = []

  start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1> {
    if (this.current === undefined) {
      this.startRequest = request
      this.current = snapshot(request, 'awaiting_approval')
      this.events = pendingEvents(this.current)
    }
    return Promise.resolve(this.current)
  }

  list(): Promise<readonly DebateRunSummaryV1[]> {
    const run = this.current
    if (run === undefined) return Promise.resolve([])
    return Promise.resolve([{
      version: 1,
      runId: run.runId,
      state: run.state,
      mode: run.mode,
      currentRound: run.currentRound,
      revision: run.revision,
      unresolvedCount: run.unresolved.length,
      cost: run.cost,
      updatedAt: run.updatedAt,
    }])
  }

  inspect(runId: string): Promise<DebateRunSnapshotV1> {
    if (this.current?.runId !== runId) return Promise.reject(new Error(`unknown fixture Debate run: ${runId}`))
    return Promise.resolve(this.current)
  }

  readEvents(request: DebateEventReadRequestV1): Promise<DebateEventPageV1> {
    if (this.current?.runId !== request.runId) {
      return Promise.reject(new Error(`unknown fixture Debate run: ${request.runId}`))
    }
    const afterSequence = request.afterSequence ?? 0
    const limit = Math.min(Math.max(request.limit ?? 50, 1), 200)
    const events = this.events.filter(event => event.sequence > afterSequence).slice(0, limit)
    return Promise.resolve({
      events,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
    })
  }

  control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1> {
    const run = this.current
    if (run === undefined || run.runId !== request.runId) return Promise.reject(new Error(`unknown fixture Debate run: ${request.runId}`))
    if (request.expectedRevision !== run.revision) return Promise.reject(new Error(`stale fixture Debate revision: ${String(request.expectedRevision)}`))
    if (request.action === 'approve') {
      if (this.startRequest === undefined) return Promise.reject(new Error('fixture Debate approval has no start request'))
      this.current = completedProjection(this.startRequest, run)
      this.events = completedEvents(this.current)
      return Promise.resolve(this.current)
    }
    const state: DebateRunSnapshotV1['state'] = request.action === 'reject' || request.action === 'stop'
      ? 'stopped'
      : run.state
    this.current = { ...run, state, revision: run.revision + 1, updatedAt: CREATED_AT }
    this.events = [
      ...this.events,
      debateEvent(this.events.length + 1, 'debate.stopped', { action: request.action, reason: request.reason }),
    ]
    return Promise.resolve(this.current)
  }
}

export const name = 'debate-loader-fixture'

/** Mount only the provider-neutral Debate seam for the keyless snapshot. */
export function apply(ctx: Context): void {
  new FixtureDebateService(ctx)
}
