/** Deterministic provider-neutral Debate Service for the ACP Loader snapshot. */

import type { Context } from '@deepseek-ai/cordis'
import DebateService, {
  type DebateControlRequestV1,
  type DebateEventPageV1,
  type DebateEventReadRequestV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateStartRequestV1,
} from '@deepseek-ai/dsh-debate'

const RUN_ID = 'fixture-debate-run'
const CREATED_AT = '2026-08-29T00:00:00.000Z'

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

  start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1> {
    this.current ??= snapshot(request, 'awaiting_approval')
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

  readEvents(_request: DebateEventReadRequestV1): Promise<DebateEventPageV1> {
    return Promise.resolve({ events: [], nextSequence: 0 })
  }

  control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1> {
    const run = this.current
    if (run === undefined || run.runId !== request.runId) return Promise.reject(new Error(`unknown fixture Debate run: ${request.runId}`))
    if (request.expectedRevision !== run.revision) return Promise.reject(new Error(`stale fixture Debate revision: ${String(request.expectedRevision)}`))
    const state: DebateRunSnapshotV1['state'] = request.action === 'approve'
      ? 'completed'
      : request.action === 'reject' || request.action === 'stop'
        ? 'stopped'
        : run.state
    this.current = {
      ...run,
      state,
      revision: run.revision + 1,
      currentRound: request.action === 'approve' ? 1 : run.currentRound,
      ...request.action !== 'approve' ? {} : {
        synthesis: {
          version: 1,
          state: 'settled',
          outputPreview: 'DEBATE_READY',
          unresolvedClaimIds: [],
          dissentCount: 0,
        },
      },
      updatedAt: CREATED_AT,
    }
    return Promise.resolve(this.current)
  }
}

export const name = 'debate-loader-fixture'

/** Mount only the provider-neutral Debate seam for the keyless snapshot. */
export function apply(ctx: Context): void {
  // ACP drives the Agent directly (rather than through the browser Session
  // command adapter), so it cannot submit `/debate-mode enabled`. Seed the
  // same durable preference at fixture-session creation; this keeps the
  // snapshot focused on the real tool/Provider seam without spending a model
  // turn on command plumbing.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.events.some(event => event.type === 'debate/preferences')) return
    agent.session.append('debate/preferences', { mode: 'enabled' }, { ignorable: true })
  })
  new FixtureDebateService(ctx)
}
