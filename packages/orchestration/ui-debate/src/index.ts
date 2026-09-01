/** Authenticated same-origin Debate projection and trusted controls. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  type DebateEventV1,
  type DebateEventType,
  type DebateJsonValue,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
} from '@deepseek-ai/dsh-debate'
import {
  authorizeRemoteRequest,
  type RemoteDeviceScope,
} from '@deepseek-ai/dsh-host-remote-auth'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  DEBATE_DASHBOARD_PATH,
  type DesktopDebateControlAction,
  type DesktopDebateControlRequest,
  type DesktopDebateDashboard,
  type DesktopDebateEvent,
  type DesktopDebateRun,
  type DesktopDebateRunSummary,
} from './contracts.ts'

export { DEBATE_DASHBOARD_PATH } from './contracts.ts'
export type * from './contracts.ts'

export const name = 'ui-debate'
export const inject = ['debates', 'webServer']

const MAX_CONTROL_BYTES = 64 * 1024
const MAX_TEXT = 2_000
const MAX_TURN_PREVIEW = 800
const MAX_ITEMS = 100
const CONTROL_ACTIONS = new Set<DesktopDebateControlAction>(['approve', 'reject', 'pause', 'resume', 'stop'])

/**
 * Decide whether a remote device scope may issue a Debate control action.
 * @param scope - authenticated remote device scope.
 * @param action - requested Debate lifecycle action.
 * @returns whether the scope may perform the action.
 */
export function remoteDebateControlAllowed(scope: RemoteDeviceScope, action: DesktopDebateControlAction): boolean {
  if (scope === 'admin' || scope === 'cockpit') return true
  return action === 'approve' || action === 'reject' || action === 'pause' || action === 'resume'
}

/* jscpd:ignore-start -- the independently unloadable Debate Host plugin owns
 * its transport boundary; sharing these helpers with orchestration would add a
 * forbidden cross-plugin runtime dependency. */
function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const encoded = Buffer.from(JSON.stringify(value))
  response.statusCode = status
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Content-Length', encoded.byteLength)
  response.end(encoded)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_CONTROL_BYTES) throw new Error('debate control request exceeds 64 KiB')
    chunks.push(value)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('control request must be an object')
  return parsed as Record<string, unknown>
}
/* jscpd:ignore-end */

function requiredString(body: Record<string, unknown>, key: string, max = 4_096): string {
  const value = body[key]
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new Error(`${key} must be a non-empty string no longer than ${String(max)} characters`)
  }
  return value
}

function requiredRevision(body: Record<string, unknown>): number {
  const value = body.expectedRevision
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('expectedRevision must be a non-negative integer')
  }
  return value
}

function requiredAction(body: Record<string, unknown>): DesktopDebateControlAction {
  const value = requiredString(body, 'action')
  if (!CONTROL_ACTIONS.has(value as DesktopDebateControlAction)) throw new Error(`unsupported Debate control action: ${value}`)
  return value as DesktopDebateControlAction
}

function boundedText(value: string | undefined, max = MAX_TEXT): string | undefined {
  if (value === undefined) return undefined
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

const PUBLIC_EVENT_DATA_KEYS: Readonly<Record<DebateEventType, readonly string[]>> = {
  'debate.planned': ['mode', 'rosterSize'],
  'debate.roster.qualified': ['roles', 'maxRounds', 'maxAgentsPerRound'],
  'debate.roster.rejected': ['roles', 'reason'],
  'debate.admitted': ['action'],
  'debate.round.started': ['round', 'phase', 'slotIds'],
  'debate.agent.dispatched': ['round', 'role', 'model'],
  'debate.agent.settled': ['round', 'role', 'claimCount', 'evidenceCount', 'confidence'],
  'debate.agent.failed': ['round', 'errorCode', 'error'],
  'debate.agent.indeterminate': ['round', 'errorCode', 'error'],
  'debate.claims.compiled': ['round', 'claimCount', 'dissentCount', 'unresolvedCount'],
  'debate.convergence.evaluated': [
    'round', 'status', 'score', 'threshold', 'disagreement', 'coverage',
    'unresolvedHighSeverity', 'settledAgents', 'reason',
  ],
  'debate.synthesis.started': ['round'],
  'debate.synthesis.settled': ['round', 'unresolvedClaimIds', 'dissentCount'],
  'debate.cost.accounted': ['usageStatus', 'costStatus', 'inputTokens', 'outputTokens', 'costUsd'],
  'debate.stopped': ['action', 'reason'],
  'debate.failed': ['errorCode', 'error', 'reason'],
  'debate.indeterminate': ['errorCode', 'error', 'reason'],
}

function publicEventData(event: DebateEventV1): Record<string, unknown> {
  const data: Record<string, DebateJsonValue> = {}
  for (const key of PUBLIC_EVENT_DATA_KEYS[event.type]) {
    const value = event.data[key]
    if (value !== undefined) data[key] = value
  }
  return JSON.parse(JSON.stringify(data)) as Record<string, unknown>
}

function projectSummary(run: DebateRunSummaryV1): DesktopDebateRunSummary {
  return {
    version: 1,
    runId: run.runId,
    state: run.state,
    mode: run.mode,
    currentRound: run.currentRound,
    revision: run.revision,
    unresolvedCount: run.unresolvedCount,
    cost: JSON.parse(JSON.stringify(run.cost)) as DesktopDebateRunSummary['cost'],
    updatedAt: run.updatedAt,
  }
}

function projectRun(run: DebateRunSnapshotV1): DesktopDebateRun {
  const turns = run.rounds.flatMap(round => round.turns)
  const latestTurn = (role: string) => [...turns].reverse().find(turn => turn.role === role)
  const objective = boundedText(run.objective)
  const synthesis = run.synthesis === undefined
    ? undefined
    : (() => {
      const outputPreview = boundedText(run.synthesis.outputPreview, 1_200)
      return {
        state: run.synthesis.state,
        ...(run.synthesis.artifactRef === undefined ? {} : { artifactRef: run.synthesis.artifactRef }),
        ...(outputPreview === undefined ? {} : { outputPreview }),
        unresolvedClaimIds: run.synthesis.unresolvedClaimIds.slice(0, MAX_ITEMS),
        dissentCount: run.synthesis.dissentCount,
      }
    })()
  return {
    ...projectSummary({
      version: 1,
      runId: run.runId,
      state: run.state,
      mode: run.mode,
      currentRound: run.currentRound,
      revision: run.revision,
      unresolvedCount: run.unresolved.length,
      cost: run.cost,
      updatedAt: run.updatedAt,
    }),
    ...(objective === undefined ? {} : { objective }),
    roles: run.roster.map((role) => {
      const turn = latestTurn(role.role)
      const outputPreview = turn === undefined ? undefined : boundedText(turn.outputPreview, MAX_TURN_PREVIEW)
      return {
        role: role.role,
        kind: role.kind,
        title: role.persona.title,
        mandate: boundedText(role.persona.mandate, MAX_TURN_PREVIEW) ?? '',
        operatorId: role.operatorId,
        model: role.model,
        tier: role.tier,
        source: role.source,
        required: role.required === true,
        ...(turn === undefined ? {} : {
          latestTurn: {
            round: turn.round,
            state: turn.state,
            ...(turn.outputRef === undefined ? {} : { outputRef: turn.outputRef }),
            ...(outputPreview === undefined ? {} : { outputPreview }),
            claimIds: turn.claimIds.slice(0, MAX_ITEMS),
            evidenceRefs: turn.evidenceRefs.slice(0, MAX_ITEMS).map(ref => ref.ref),
            ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
            ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
            ...(turn.settledAt === undefined ? {} : { settledAt: turn.settledAt }),
            ...(turn.errorCode === undefined ? {} : { errorCode: turn.errorCode }),
          },
        }),
      }
    }),
    rounds: run.rounds.map(round => ({
      round: round.round,
      state: round.state,
      turnStates: round.turns.map((turn) => {
        const outputPreview = boundedText(turn.outputPreview, MAX_TURN_PREVIEW)
        return {
          round: turn.round,
          slotId: turn.slotId,
          role: turn.role,
          operatorId: turn.operatorId,
          model: turn.model,
          state: turn.state,
          ...(turn.outputRef === undefined ? {} : { outputRef: turn.outputRef }),
          ...(outputPreview === undefined ? {} : { outputPreview }),
          claimIds: turn.claimIds.slice(0, MAX_ITEMS),
          evidenceRefs: turn.evidenceRefs.slice(0, MAX_ITEMS).map(ref => ref.ref),
          ...(turn.usage === undefined ? {} : { usage: { ...turn.usage } }),
          ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
          ...(turn.settledAt === undefined ? {} : { settledAt: turn.settledAt }),
          ...(turn.errorCode === undefined ? {} : { errorCode: turn.errorCode }),
        }
      }),
      ...(round.convergence === undefined ? {} : { convergence: { ...round.convergence } }),
    })),
    claims: run.claimLedger.claims.slice(0, MAX_ITEMS).map((claim) => {
      const rationale = boundedText(claim.rationale)
      return {
        claimId: claim.claimId,
        statement: boundedText(claim.statement) ?? '',
        status: claim.status,
        severity: claim.severity,
        confidence: claim.confidence,
        supportingSlotIds: [...claim.supportingSlotIds],
        opposingSlotIds: [...claim.opposingSlotIds],
        evidenceRefs: claim.evidenceRefs.slice(0, MAX_ITEMS).map(ref => ref.ref),
        ...(rationale === undefined ? {} : { rationale }),
      }
    }),
    claimCoverage: run.claimLedger.coverage,
    dissent: run.dissent.slice(0, MAX_ITEMS).map(item => ({
      slotId: item.slotId,
      claimId: item.claimId,
      position: boundedText(item.position) ?? '',
      reason: boundedText(item.reason) ?? '',
      confidence: item.confidence,
      evidenceRefs: item.evidenceRefs.slice(0, MAX_ITEMS).map(ref => ref.ref),
    })),
    unresolved: run.unresolved.slice(0, MAX_ITEMS).map(item => ({
      claimId: item.claimId,
      description: boundedText(item.description) ?? '',
      severity: item.severity,
      blocking: item.blocking,
      reason: boundedText(item.reason) ?? '',
      requiredEvidenceRefs: item.requiredEvidenceRefs.slice(0, MAX_ITEMS).map(ref => ref.ref),
    })),
    evidence: {
      refs: run.evidence.refs.slice(0, MAX_ITEMS).map(ref => ref.ref),
      coverage: run.evidence.coverage,
      missingRefs: run.evidence.missingRefs.slice(0, MAX_ITEMS),
      lineage: run.evidence.lineage.slice(0, MAX_ITEMS),
    },
    ...(synthesis === undefined ? {} : { synthesis }),
    ...(run.provenance.sourceSessionId === undefined ? {} : { sourceSessionId: run.provenance.sourceSessionId }),
    createdAt: run.createdAt,
  }
}

function projectEvent(event: DebateEventV1): DesktopDebateEvent {
  return {
    version: 1,
    sequence: event.sequence,
    runId: event.runId,
    revision: event.revision,
    generation: event.generation,
    ...(event.round === undefined ? {} : { round: event.round }),
    ...(event.slotId === undefined ? {} : { slotId: event.slotId }),
    type: event.type,
    createdAt: event.createdAt,
    data: publicEventData(event),
  }
}

function cursor(url: URL, key: string, fallback: number, maximum: number): number {
  const raw = url.searchParams.get(key)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${key} is outside its allowed range`)
  return value
}

async function readProjection(ctx: Context, url: URL): Promise<DesktopDebateDashboard> {
  const runs = (await ctx.debates.list()).slice(0, MAX_ITEMS).map(projectSummary)
  const runId = url.searchParams.get('run_id')
  const base: DesktopDebateDashboard = { version: 1, generatedAt: new Date().toISOString(), runs }
  if (runId === null) return base
  if (runId.length === 0) throw new Error('run_id must be non-empty')
  const selectedRun = projectRun(await ctx.debates.inspect(runId))
  const events = await ctx.debates.readEvents({
    runId,
    afterSequence: cursor(url, 'after_sequence', 0, Number.MAX_SAFE_INTEGER),
    limit: cursor(url, 'limit', 200, 200),
  })
  return {
    ...base,
    selectedRunId: runId,
    selectedRun,
    events: events.events.map(projectEvent),
    nextSequence: events.nextSequence,
  }
}

async function executeControl(ctx: Context, body: Record<string, unknown>) {
  if (body.version !== 1) throw new Error('unsupported Debate control version')
  const request: DesktopDebateControlRequest = {
    version: 1,
    commandId: requiredString(body, 'commandId', 256),
    runId: requiredString(body, 'runId', 256),
    expectedRevision: requiredRevision(body),
    action: requiredAction(body),
    reason: requiredString(body, 'reason'),
  }
  return projectRun(await ctx.debates.control({
    ...request,
    action: request.action,
  }))
}

function httpStatus(error: unknown): number {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    if (error.code === 'DEBATE_NOT_FOUND') return 404
    if (error.code === 'DEBATE_REVISION_CONFLICT' || error.code === 'DEBATE_STATE_CONFLICT') return 409
    if (error.code === 'DEBATE_PROVIDER_UNAVAILABLE') return 503
  }
  return 400
}

/** Register the authenticated Debate projection and revision-fenced control route. */
export function apply(ctx: Context): void {
  /* jscpd:ignore-start -- authenticated exact-route wiring is deliberately
   * local to this plugin so Debate can be installed and removed independently. */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: DEBATE_DASHBOARD_PATH,
    handler: async (request, response) => {
      try {
        const remoteAuth = ctx.get('remoteAuth')
        const authority = authorizeRemoteRequest(request, remoteAuth)
        if (authority === undefined) {
          const unavailable = remoteAuth === undefined
          sendJson(response, unavailable ? 503 : 401, { error: unavailable ? 'REMOTE_AUTH_UNAVAILABLE' : 'UNAUTHORIZED' })
          return
        }
        if (request.method === 'GET') {
          sendJson(response, 200, await readProjection(ctx, new URL(request.url ?? DEBATE_DASHBOARD_PATH, 'http://127.0.0.1')))
          return
        }
        if (request.method === 'POST') {
          if (request.headers['x-dsh-debate-control'] !== '1') {
            sendJson(response, 403, { error: 'CONTROL_HEADER_REQUIRED' })
            return
          }
          const body = await readBody(request)
          const action = requiredAction(body)
          if (!remoteDebateControlAllowed(authority.scope, action)) {
            sendJson(response, 403, { error: 'REMOTE_SCOPE_FORBIDDEN' })
            return
          }
          sendJson(response, 200, await executeControl(ctx, body))
          return
        }
        response.writeHead(405, { Allow: 'GET, POST' })
        response.end()
      } catch (error) {
        ctx.logger.warn(error)
        sendJson(response, httpStatus(error), {
          error: error instanceof Error && 'code' in error ? String(error.code) : 'DEBATE_UI_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), 'ui-debate: dashboard route')
  /* jscpd:ignore-end */
}
