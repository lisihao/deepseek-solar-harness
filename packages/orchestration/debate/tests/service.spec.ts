import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DebateService,
  validateDebateControlRequest,
  validateDebateEventReadRequest,
  validateDebatePolicy,
  validateDebateStartRequest,
} from '../src/index.ts'
import type {
  DebateClaimLedgerV1,
  DebateControlRequestV1,
  DebateEventPageV1,
  DebateEventReadRequestV1,
  DebateEventV1,
  DebateEvidenceRefV1,
  DebatePolicyV1,
  DebateRunSnapshotV1,
  DebateRunSummaryV1,
  DebateStartRequestV1,
} from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function policy(): DebatePolicyV1 {
  const persona = (title: string, mandate: string, stance: string) => ({
    title,
    mandate,
    stance,
    instructions: ['Identify claims explicitly.', 'Attach evidence refs and confidence.'],
  })
  return {
    version: 1,
    mode: 'enabled',
    roster: [
      {
        version: 1, role: 'constructive-proposer', kind: 'participant', operatorId: 'codex', model: 'luna', tier: 'low', source: 'native-subscription',
        persona: persona('Proposer', 'Construct a viable answer.', 'Constructive'), required: false,
      },
      {
        version: 1, role: 'skeptical-falsifier', kind: 'participant', operatorId: 'claude-code', fallbackOperatorIds: ['codex'], model: 'sonnet', tier: 'medium', source: 'native-subscription',
        persona: persona('Falsifier', 'Find counterexamples and failure modes.', 'Skeptical'), required: false,
      },
      {
        version: 1, role: 'decision-judge', kind: 'judge', operatorId: 'codex', model: 'sol', tier: 'high', source: 'native-subscription',
        persona: persona('Judge', 'Assess the ledger and produce a decision.', 'Evidence-first'), required: true,
      },
    ],
    budget: {
      version: 1, maxRounds: 3, maxTurnsPerAgent: 1, maxAgentsPerRound: 3,
      maxInputTokens: 4_000, maxOutputTokens: 4_000, maxTotalTokens: 20_000, maxCostUsd: 2,
    },
    rounds: { version: 1, firstRound: 'blind-independent', followUp: 'claim-ledger', escalation: 'high-severity-unresolved' },
    convergence: {
      version: 1, scoreThreshold: 0.8, minSettledAgents: 2, maxUnresolvedHighSeverity: 0,
      requireEvidenceForCritical: true, earlyStop: true,
    },
    preserveDissent: true,
  }
}

function startRequest(overrides: Partial<DebateStartRequestV1> = {}): DebateStartRequestV1 {
  return {
    version: 1,
    commandId: 'cmd-1',
    workspace: '/workspace',
    prompt: 'Compare two implementation options and preserve unresolved risks.',
    objective: 'Choose the safest option with evidence.',
    policy: policy(),
    sourceRefs: [{ version: 1, ref: 'artifact:brief', kind: 'artifact', digest: 'sha256:brief' }],
    execution: { version: 1, kind: 'taskgraph-node', runId: 'run-1', nodeId: 'debate-node' },
    ...overrides,
  }
}

const evidence: DebateEvidenceRefV1 = { version: 1, ref: 'artifact:brief', kind: 'artifact', digest: 'sha256:brief' }
const ledger: DebateClaimLedgerV1 = {
  version: 1,
  claims: [{
    version: 1, claimId: 'claim-1', statement: 'Option A is reversible.', status: 'supported', severity: 'high', confidence: 0.9,
    supportingSlotIds: ['constructive-proposer'], opposingSlotIds: [], evidenceRefs: [evidence], rationale: 'The artifact describes a rollback path.',
  }],
  coverage: 1,
  digest: 'sha256:ledger',
}

function snapshot(): DebateRunSnapshotV1 {
  const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.01 }
  const cost = {
    version: 1 as const, usageStatus: 'known' as const, costStatus: 'known' as const,
    inputTokens: 300, outputTokens: 150, cacheReadInputTokens: 0, cacheWriteInputTokens: 0, costUsd: 0.03,
    unknownUsageTurns: 0, unknownCostTurns: 0,
    bySlot: [{ version: 1 as const, slotId: 'constructive-proposer', model: 'luna', usage }],
  }
  return {
    version: 1,
    runId: 'run-1', revision: 3, state: 'completed', mode: 'enabled', promptSha256: 'sha256:prompt', objective: 'Choose the safest option with evidence.',
    policy: policy(), roster: policy().roster, currentRound: 1,
    rounds: [{
      version: 1, round: 1, state: 'completed',
      turns: [{
        version: 1, round: 1, slotId: 'constructive-proposer', role: 'constructive-proposer', operatorId: 'codex', model: 'luna', state: 'settled',
        outputRef: 'artifact:turn-1', claimIds: ['claim-1'], evidenceRefs: [evidence], usage, startedAt: '2026-08-28T01:00:00.000Z', settledAt: '2026-08-28T01:01:00.000Z',
      }],
      claimLedger: ledger, dissent: [], unresolved: [], convergence: {
        version: 1, status: 'converged', score: 0.9, threshold: 0.8, disagreement: 0.1, coverage: 1, unresolvedHighSeverity: 0, settledAgents: 2, reason: 'ledger covered',
      },
    }],
    claimLedger: ledger, dissent: [], unresolved: [],
    evidence: { version: 1, refs: [evidence], coverage: 1, missingRefs: [], lineage: ['artifact:brief'] },
    cost, provenance: {
      version: 1, providerId: 'test-provider', providerVersion: '0.1.0', requestSha256: 'sha256:request', policySha256: 'sha256:policy',
      parentRunId: 'run-1', parentNodeId: 'debate-node', outputSha256: 'sha256:output',
    },
    synthesis: { version: 1, state: 'settled', artifactRef: 'artifact:synthesis', outputPreview: 'Option A', unresolvedClaimIds: [], dissentCount: 0 },
    createdAt: '2026-08-28T01:00:00.000Z', updatedAt: '2026-08-28T01:01:00.000Z',
  }
}

describe('Debate Service Definition', () => {
  it('normalizes a fixed role roster and preserves a JSON-only policy', () => {
    const validated = validateDebatePolicy(policy())
    expect(validated.roster.map(role => role.role)).toEqual([
      'constructive-proposer', 'skeptical-falsifier', 'decision-judge',
    ])
    expect(validated.roster.find(role => role.role === 'decision-judge')?.required).toBe(true)
    expect(validated.roster.find(role => role.role === 'skeptical-falsifier')?.fallbackOperatorIds).toEqual(['codex'])
    expect(JSON.parse(JSON.stringify(validated))).toEqual(validated)
  })

  it('rejects unknown fields, invalid versions, roster shape, and unsafe budgets', () => {
    expect(() => validateDebatePolicy({ ...policy(), extra: true })).toThrow('unknown field')
    expect(() => validateDebatePolicy({ ...policy(), version: 2 })).toThrow('must be 1')
    expect(() => validateDebatePolicy({
      ...policy(),
      roster: policy().roster.map((role, index) => index === 1 ? { ...role, persona: { ...role.persona, extra: 'nope' } } : role),
    })).toThrow('unknown field')
    expect(() => validateDebatePolicy({ ...policy(), roster: policy().roster.filter(role => role.role !== 'decision-judge') })).toThrow('decision-judge')
    expect(() => validateDebatePolicy({ ...policy(), budget: { ...policy().budget, maxTotalTokens: 100 } })).toThrow('maxTotalTokens')
    expect(() => validateDebatePolicy({ ...policy(), convergence: { ...policy().convergence, scoreThreshold: 2 } })).toThrow('scoreThreshold')
    expect(() => validateDebatePolicy({
      ...policy(),
      roster: policy().roster.map((role, index) => index === 1 ? { ...role, fallbackOperatorIds: ['claude-code'] } : role),
    })).toThrow('must not repeat the primary operatorId')
    expect(() => validateDebatePolicy({
      ...policy(),
      roster: policy().roster.map((role, index) => index === 1 ? { ...role, fallbackOperatorIds: ['codex', 'codex'] } : role),
    })).toThrow('must not contain duplicates')
  })

  it('validates start parent identity and rejects external unknown fields', () => {
    expect(validateDebateStartRequest(startRequest()).execution).toEqual({ version: 1, kind: 'taskgraph-node', runId: 'run-1', nodeId: 'debate-node' })
    expect(validateDebateStartRequest(startRequest({ execution: { version: 1, kind: 'rlm-session', sessionId: 'rlm-1' } }))).toMatchObject({ execution: { kind: 'rlm-session', sessionId: 'rlm-1' } })
    expect(validateDebateStartRequest(startRequest({ execution: { version: 1, kind: 'standalone' } }))).toMatchObject({ execution: { kind: 'standalone' } })
    expect(() => validateDebateStartRequest({ ...startRequest(), unexpected: 1 })).toThrow('unknown field')
    const { workspace: _missing, ...withoutWorkspace } = startRequest()
    expect(() => validateDebateStartRequest(withoutWorkspace)).toThrow('workspace')
    expect(() => validateDebateStartRequest(startRequest({ execution: { version: 1, kind: 'taskgraph-node', runId: 'run-1' } }))).toThrow('requires runId and nodeId only')
    expect(() => validateDebateStartRequest(startRequest({ sourceRefs: [{ version: 1, ref: 'source', kind: 'artifact', unsupported: true } as never] }))).toThrow('unknown field')
  })

  it('validates revision-safe controls and bounded event reads', () => {
    const control: DebateControlRequestV1 = { version: 1, commandId: 'control-1', runId: 'run-1', expectedRevision: 3, action: 'pause', reason: 'User requested review.' }
    expect(validateDebateControlRequest(control)).toEqual(control)
    expect(() => validateDebateControlRequest({ ...control, expectedRevision: -1 })).toThrow('expectedRevision')
    expect(() => validateDebateControlRequest({ ...control, extra: true })).toThrow('unknown field')
    const read: DebateEventReadRequestV1 = { runId: 'run-1', afterSequence: 4, limit: 20 }
    expect(validateDebateEventReadRequest(read)).toEqual(read)
    expect(() => validateDebateEventReadRequest({ ...read, limit: 0 })).toThrow('limit')
  })

  it('provides only a consumer/provider seam and keeps run evidence serializable', async () => {
    const run = snapshot()
    const event: DebateEventV1 = {
      version: 1, sequence: 1, runId: run.runId, revision: run.revision, generation: 1, round: 1, slotId: 'constructive-proposer',
      type: 'debate.agent.settled', createdAt: run.updatedAt, data: { claimId: 'claim-1', settled: true },
    }
    const page: DebateEventPageV1 = { events: [event], nextSequence: 2 }
    class Provider extends DebateService {
      async start(_request: DebateStartRequestV1): Promise<DebateRunSnapshotV1> { return run }
      async list(): Promise<readonly DebateRunSummaryV1[]> {
        return [{
          version: 1, runId: run.runId, state: run.state, mode: run.mode, currentRound: run.currentRound,
          revision: run.revision, unresolvedCount: 0, cost: run.cost, updatedAt: run.updatedAt,
        }]
      }
      async inspect(_runId: string): Promise<DebateRunSnapshotV1> { return run }
      async readEvents(_request: DebateEventReadRequestV1): Promise<DebateEventPageV1> { return page }
      async control(_request: DebateControlRequestV1): Promise<DebateRunSnapshotV1> { return run }
    }
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Provider)
    expect(ctx.debates).toBeInstanceOf(Provider)
    await expect(ctx.debates.start(validateDebateStartRequest(startRequest()))).resolves.toBe(run)
    await expect(ctx.debates.readEvents(validateDebateEventReadRequest({ runId: 'run-1', limit: 10 }))).resolves.toEqual(page)
    await expect(ctx.debates.control(validateDebateControlRequest({ version: 1, commandId: 'c', runId: 'run-1', expectedRevision: 3, action: 'stop', reason: 'done' }))).resolves.toBe(run)
    expect(JSON.parse(JSON.stringify({ run, page }))).toEqual({ run, page })
  })
})
