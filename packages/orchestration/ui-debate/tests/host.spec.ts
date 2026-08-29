import { DebateError } from '@deepseek-ai/dsh-debate'
import type {
  DebateControlRequestV1,
  DebateEventReadRequestV1,
  DebatePolicyV1,
  DebateRunSnapshotV1,
  DebateRunSummaryV1,
} from '@deepseek-ai/dsh-debate'
import { describe, expect, it } from 'vitest'
import { apply, remoteDebateControlAllowed } from '../src/index.ts'

function policy(): DebatePolicyV1 {
  const persona = (title: string) => ({ title, mandate: `private mandate ${title}`, stance: 'private stance', instructions: ['private instruction'] })
  return {
    version: 1,
    mode: 'enabled',
    roster: [
      {
        version: 1, role: 'constructive-proposer', kind: 'participant', operatorId: 'codex',
        model: 'gpt-5.6-sol', tier: 'high', source: 'native-subscription', persona: persona('Proposer'), required: true,
      },
      {
        version: 1, role: 'skeptical-falsifier', kind: 'participant', operatorId: 'claude-code',
        model: 'claude-fable-5', tier: 'medium', source: 'native-subscription', persona: persona('Falsifier'), required: true,
      },
      {
        version: 1, role: 'decision-judge', kind: 'judge', operatorId: 'claude-code',
        model: 'claude-opus-5', tier: 'high', source: 'native-subscription', persona: persona('Judge'), required: true,
      },
    ],
    budget: {
      version: 1, maxRounds: 3, maxTurnsPerAgent: 3, maxAgentsPerRound: 3,
      maxInputTokens: 10_000, maxOutputTokens: 5_000, maxTotalTokens: 15_000,
    },
    rounds: { version: 1, firstRound: 'blind-independent', followUp: 'claim-ledger', escalation: 'high-severity-unresolved' },
    convergence: {
      version: 1, scoreThreshold: 0.8, minSettledAgents: 2,
      maxUnresolvedHighSeverity: 0, requireEvidenceForCritical: true, earlyStop: true,
    },
    preserveDissent: true,
  }
}

function run(): DebateRunSnapshotV1 {
  const evidence = { version: 1 as const, ref: 'artifact:evidence', kind: 'artifact' as const }
  const cost = {
    version: 1 as const,
    usageStatus: 'partial' as const,
    costStatus: 'unknown' as const,
    inputTokens: 1_000,
    outputTokens: 400,
    cacheReadInputTokens: 200,
    unknownUsageTurns: 1,
    unknownCostTurns: 1,
    bySlot: [],
  }
  const claims = [{
    version: 1 as const,
    claimId: 'claim-1',
    statement: 'Option A is safer.',
    status: 'supported' as const,
    severity: 'high' as const,
    confidence: 0.9,
    supportingSlotIds: ['constructive-proposer'],
    opposingSlotIds: ['skeptical-falsifier'],
    evidenceRefs: [evidence],
    rationale: 'Rollback is documented.',
  }]
  const ledger = { version: 1 as const, claims, coverage: 0.8, digest: 'sha256:ledger' }
  return {
    version: 1,
    runId: 'debate-1',
    revision: 7,
    state: 'awaiting_approval',
    mode: 'enabled',
    promptSha256: 'sha256:prompt',
    objective: 'Choose A or B.',
    policy: policy(),
    roster: policy().roster,
    currentRound: 1,
    rounds: [{
      version: 1,
      round: 1,
      state: 'completed',
      turns: [{
        version: 1,
        round: 1,
        slotId: 'constructive-proposer',
        role: 'constructive-proposer',
        operatorId: 'codex',
        model: 'gpt-5.6-sol',
        state: 'settled',
        outputRef: 'artifact:turn-1',
        outputPreview: 'Choose A.',
        claimIds: ['claim-1'],
        evidenceRefs: [evidence],
        usage: { inputTokens: 1_000, outputTokens: 400 },
      }],
      claimLedger: ledger,
      dissent: [],
      unresolved: [],
      convergence: { version: 1, status: 'converged', score: 0.9, threshold: 0.8, disagreement: 0.1, coverage: 0.8, unresolvedHighSeverity: 0, settledAgents: 3, reason: 'supported' },
    }],
    claimLedger: ledger,
    dissent: [{ version: 1, slotId: 'skeptical-falsifier', claimId: 'claim-1', position: 'B may be safer.', reason: 'Rollback evidence incomplete.', confidence: 0.4, evidenceRefs: [] }],
    unresolved: [{ version: 1, claimId: 'claim-2', description: 'Operational cost unknown.', severity: 'medium', blocking: false, reason: 'No benchmark.', requiredEvidenceRefs: [] }],
    evidence: { version: 1, refs: [evidence], coverage: 0.8, missingRefs: ['benchmark'], lineage: ['artifact:evidence'] },
    cost,
    provenance: { version: 1, providerId: 'fixture', providerVersion: '1', requestSha256: 'sha256:req', policySha256: 'sha256:policy', sourceSessionId: 'session-1' },
    synthesis: { version: 1, state: 'settled', artifactRef: 'artifact:synthesis', outputPreview: 'Choose A and retain the cost dissent.', unresolvedClaimIds: ['claim-2'], dissentCount: 1 },
    createdAt: '2026-08-29T01:00:00.000Z',
    updatedAt: '2026-08-29T01:01:00.000Z',
  }
}

function summary(snapshot = run()): DebateRunSummaryV1 {
  return {
    version: 1,
    runId: snapshot.runId,
    state: snapshot.state,
    mode: snapshot.mode,
    currentRound: snapshot.currentRound,
    revision: snapshot.revision,
    unresolvedCount: snapshot.unresolved.length,
    cost: snapshot.cost,
    updatedAt: snapshot.updatedAt,
  }
}

type Handler = (request: unknown, response: unknown) => Promise<void>

function response() {
  return {
    statusCode: 0,
    headers: new Map<string, unknown>(),
    body: '',
    setHeader(name: string, value: unknown) { this.headers.set(name, value) },
    writeHead(status: number) { this.statusCode = status },
    end(value?: Uint8Array) { this.body = Buffer.from(value ?? []).toString('utf8') },
  }
}

function request(
  method: string,
  url: string,
  body?: Record<string, unknown>,
  options: { remoteAddress?: string; token?: string; controlHeader?: boolean } = {},
) {
  return {
    method,
    url,
    headers: {
      host: '127.0.0.1:3080',
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.controlHeader === true ? { 'x-dsh-debate-control': '1' } : {}),
    },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
}

describe('Debate Host projection', () => {
  it('serves bounded list/inspect/events without exposing persona instructions', async () => {
    let handler: Handler | undefined
    const selected = run()
    const ctx = {
      webServer: { register(entry: { handler: Handler }) { handler = entry.handler; return () => {} } },
      effect(callback: () => unknown) { callback() },
      get() { return undefined },
      logger: { warn() {} },
      debates: {
        async list() { return [summary(selected)] },
        async inspect() { return selected },
        async readEvents(_request: DebateEventReadRequestV1) {
          return {
            events: [{
              version: 1, sequence: 1, runId: selected.runId, revision: 7, generation: 2, round: 1,
              slotId: 'constructive-proposer', type: 'debate.agent.settled', createdAt: selected.updatedAt,
              data: { outputRef: 'artifact:turn-1' },
            }],
            nextSequence: 2,
          }
        },
      },
    }
    apply(ctx as never)
    if (handler === undefined) throw new Error('Debate route was not registered')

    const listed = response()
    await handler(request('GET', '/api/debates'), listed)
    expect(listed.statusCode).toBe(200)
    expect(JSON.parse(listed.body)).toMatchObject({ version: 1, runs: [{ runId: 'debate-1', state: 'awaiting_approval' }] })

    const inspected = response()
    await handler(request('GET', '/api/debates?run_id=debate-1&after_sequence=0&limit=10'), inspected)
    expect(inspected.statusCode).toBe(200)
    const projected = JSON.parse(inspected.body) as Record<string, unknown>
    expect(projected).toMatchObject({
      selectedRunId: 'debate-1',
      selectedRun: {
        claims: [{ claimId: 'claim-1', status: 'supported' }],
        synthesis: { artifactRef: 'artifact:synthesis' },
        cost: { usageStatus: 'partial', costStatus: 'unknown', unknownUsageTurns: 1 },
      },
      events: [{ type: 'debate.agent.settled' }],
      nextSequence: 2,
    })
    expect((projected.selectedRun as { roles: unknown[] }).roles[0]).toMatchObject({
      role: 'constructive-proposer', latestTurn: { outputRef: 'artifact:turn-1' },
    })
    expect((projected.selectedRun as { cost: Record<string, unknown> }).cost).not.toHaveProperty('costUsd')
    expect(inspected.body).not.toContain('private mandate')
    expect(inspected.body).not.toContain('private instruction')
  })

  it('requires a control header and applies revision-fenced controls', async () => {
    let handler: Handler | undefined
    const controls: DebateControlRequestV1[] = []
    const selected = run()
    const ctx = {
      webServer: { register(entry: { handler: Handler }) { handler = entry.handler; return () => {} } },
      effect(callback: () => unknown) { callback() },
      get() { return undefined },
      logger: { warn() {} },
      debates: {
        async control(control: DebateControlRequestV1) { controls.push(control); return selected },
      },
    }
    apply(ctx as never)
    if (handler === undefined) throw new Error('Debate route was not registered')
    const body = { version: 1, commandId: 'control-1', runId: 'debate-1', expectedRevision: 7, action: 'approve', reason: 'approved' }

    const denied = response()
    await handler(request('POST', '/api/debates', body), denied)
    expect(denied.statusCode).toBe(403)
    expect(controls).toHaveLength(0)

    const accepted = response()
    await handler(request('POST', '/api/debates', body, { controlHeader: true }), accepted)
    expect(accepted.statusCode).toBe(200)
    expect(controls).toEqual([body])
    expect(JSON.parse(accepted.body)).toMatchObject({ runId: 'debate-1', revision: 7 })
  })

  it('limits pocket controls and maps revision conflicts to HTTP 409', async () => {
    expect(remoteDebateControlAllowed('pocket', 'pause')).toBe(true)
    expect(remoteDebateControlAllowed('pocket', 'stop')).toBe(false)
    expect(remoteDebateControlAllowed('cockpit', 'stop')).toBe(true)
    let handler: Handler | undefined
    const remoteAuth = {
      authenticate: (token: string) => token === 'pocket'
        ? { deviceId: 'phone', deviceName: 'Phone', scope: 'pocket' as const }
        : undefined,
    }
    const ctx = {
      webServer: { register(entry: { handler: Handler }) { handler = entry.handler; return () => {} } },
      effect(callback: () => unknown) { callback() },
      get(name: string) { return name === 'remoteAuth' ? remoteAuth : undefined },
      logger: { warn() {} },
      debates: { async control() { throw new DebateError('stale revision', 'DEBATE_REVISION_CONFLICT') } },
    }
    apply(ctx as never)
    if (handler === undefined) throw new Error('Debate route was not registered')
    const stop = { version: 1, commandId: 'stop-1', runId: 'debate-1', expectedRevision: 7, action: 'stop', reason: 'stop' }
    const forbidden = response()
    await handler(request('POST', '/api/debates', stop, { remoteAddress: '10.0.0.5', token: 'pocket', controlHeader: true }), forbidden)
    expect(forbidden.statusCode).toBe(403)

    const pause = response()
    await handler(request('POST', '/api/debates', { ...stop, action: 'pause' }, { remoteAddress: '10.0.0.5', token: 'pocket', controlHeader: true }), pause)
    expect(pause.statusCode).toBe(409)
    expect(JSON.parse(pause.body)).toMatchObject({ error: 'DEBATE_REVISION_CONFLICT' })
  })
})
