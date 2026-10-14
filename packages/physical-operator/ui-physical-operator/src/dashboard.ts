/** Resident Operator projection and explicit owner-local authentication action. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { authorizeRemoteRequest } from '@deepseek-ai/dsh-host-remote-auth'
import {
  ResidentOperatorCommandId,
  ResidentOperatorSessionId,
} from '@deepseek-ai/dsh-resident-operator'
import type {
  ResidentEvent,
  ResidentProviderStatus,
  ResidentSessionSnapshot,
  ResidentTurnSnapshot,
  ResidentTurnSummary,
} from '@deepseek-ai/dsh-resident-operator'
import type {
  DesktopResidentAuthenticationFailureReason,
  DesktopResidentCliRuntimes,
  DesktopResidentCliUpdate,
  DesktopResidentDashboard,
  DesktopResidentEvent,
  DesktopResidentProvider,
  DesktopResidentSession,
  DesktopResidentTurn,
} from './contracts.ts'
import {
  RESIDENT_CLI_PATH,
  RESIDENT_DASHBOARD_PATH,
  RESIDENT_NATIVE_OUTCOME_UNCONFIRMED,
  RESIDENT_SESSION_RECOVERY_PATH,
} from './contracts.ts'
import type { DesktopResidentRecoveryFailure } from './contracts.ts'
import { buildResidentActivities, isDiagnosticResidentWorkspace } from './presentation.ts'

/**
 * Read the daemon-owned projection without copying Resident state into Desktop.
 * @param ctx - Host context carrying the trusted Resident management service.
 * @param sessionId - optional selected Session whose bounded events and latest turn are expanded.
 * @returns one JSON-safe snapshot for the browser panel.
 */
export async function readResidentDashboard(ctx: Context, sessionId?: string): Promise<DesktopResidentDashboard> {
  const [providers, sessions] = await Promise.all([ctx.residentOperators.providers(), ctx.residentOperators.list()])
  return assembleResidentDashboard(ctx, providers, sessions, sessionId)
}

async function assembleResidentDashboard(
  ctx: Context,
  providers: ResidentProviderStatus[],
  sessions: ResidentSessionSnapshot[],
  sessionId?: string,
): Promise<DesktopResidentDashboard> {
  // A closed lane is always listed: it is the only place the owner can release it.
  const visibleSessions = sessions
    .filter(session => !isDiagnosticResidentWorkspace(session.workspace) || session.healthReason === RESIDENT_NATIVE_OUTCOME_UNCONFIRMED)
    .sort((left, right) => {
      const lifecycle = Number(right.lifecycle === 'running') - Number(left.lifecycle === 'running')
      return lifecycle === 0 ? right.updatedAt.localeCompare(left.updatedAt) : lifecycle
    })
  const selected = sessionId === undefined
    ? undefined
    : visibleSessions.find(session => String(session.sessionId) === sessionId)
  const events = selected === undefined
    ? []
    : (await ctx.residentOperators.readEvents({ sessionId: selected.sessionId, limit: 200 })).events
  const latestTurnId = selected?.latestTurn?.turnId
  const selectedTurn = latestTurnId === undefined
    ? undefined
    : await ctx.residentOperators.inspectTurn(String(latestTurnId))
  return {
    generatedAt: new Date().toISOString(),
    providers: providers.map(providerValue),
    sessions: visibleSessions.map(sessionValue),
    ...selected === undefined ? {} : { selectedSessionId: String(selected.sessionId) },
    events: events.map(eventValue),
    activities: buildResidentActivities(events.map(eventValue)),
    hiddenDiagnosticSessions: sessions.length - visibleSessions.length,
    activeWorkers: visibleSessions.filter(session => session.lifecycle === 'running').length,
    ...selectedTurn === undefined ? {} : { selectedTurn: turnValue(selectedTurn) },
  }
}

/**
 * Register the authenticated Resident route for projection and explicit owner-local login.
 * @param ctx - Host context carrying Web Server, Remote Auth, and Resident services.
 * @returns a disposer that unregisters the route.
 */
export function registerResidentDashboard(ctx: Context): () => void {
  let providerCache: { readonly expiresAt: number; readonly value: ResidentProviderStatus[] } | undefined
  return ctx.webServer.register({
    kind: 'exact',
    path: RESIDENT_DASHBOARD_PATH,
    handler: async (request, response) => {
      const authority = authorize(ctx, request, response)
      if (authority === undefined) return
      const url = new URL(request.url ?? RESIDENT_DASHBOARD_PATH, 'http://127.0.0.1')
      if (request.method === 'POST') {
        if (!authority.local) {
          sendJson(response, 403, { error: 'LOCAL_OWNER_REQUIRED' })
          return
        }
        const operatorId = url.searchParams.get('operator_id')
        if (operatorId === null || operatorId.trim().length === 0) {
          sendJson(response, 400, { error: 'OPERATOR_ID_REQUIRED' })
          return
        }
        try {
          const provider = await ctx.residentOperators.authenticate(operatorId)
          providerCache = undefined
          sendJson(response, 200, { provider: providerValue(provider) })
        } catch (cause) {
          ctx.logger.warn(cause)
          sendJson(response, 503, {
            error: 'RESIDENT_AUTHENTICATION_FAILED',
            reason: authenticationFailureReason(cause),
            message: cause instanceof Error ? cause.message : String(cause),
          })
        }
        return
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET, POST' })
        response.end()
        return
      }
      const sessionId = url.searchParams.get('session_id') ?? undefined
      const refresh = url.searchParams.get('refresh') === '1'
      const snapshot = ctx.residentOperators.providerSnapshot()
      if (snapshot !== undefined && snapshot.observedAt + 60_000 > Date.now()) {
        providerCache = { expiresAt: snapshot.observedAt + 60_000, value: snapshot.providers }
      }
      try {
        const [providers, sessions] = await Promise.all([
          !refresh && providerCache !== undefined && providerCache.expiresAt > Date.now()
            ? providerCache.value
            : ctx.residentOperators.providers().then((value) => {
              providerCache = { expiresAt: Date.now() + 60_000, value }
              return value
            }),
          ctx.residentOperators.list(),
        ])
        sendJson(response, 200, await assembleResidentDashboard(ctx, providers, sessions, sessionId))
      } catch (cause) {
        ctx.logger.warn(cause)
        sendJson(response, 503, {
          error: 'RESIDENT_DASHBOARD_UNAVAILABLE',
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    },
  })
}

function authenticationFailureReason(cause: unknown): DesktopResidentAuthenticationFailureReason {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause
    ? String(cause.code)
    : undefined
  switch (code) {
    case 'NETWORK_UNAVAILABLE': return 'network_unavailable'
    case 'CALLBACK_LISTENER_MISSING': return 'callback_listener_missing'
    case 'AUTH_REQUIRED':
    case 'AUTH_MODE_MISMATCH':
    default: return 'auth_required'
  }
}

function providerValue(provider: ResidentProviderStatus): DesktopResidentProvider {
  return {
    operatorId: provider.operatorId,
    product: provider.product,
    displayName: provider.displayName,
    description: provider.description,
    tags: [...provider.tags],
    maxConcurrency: provider.maxConcurrency,
    injectionBoundaries: [...provider.injectionBoundaries],
    available: provider.available,
    ...provider.unavailableReason === undefined ? {} : { unavailableReason: provider.unavailableReason },
    ...provider.unavailableCode === undefined ? {} : { unavailableCode: provider.unavailableCode },
    ...provider.quotaUnavailableReason === undefined ? {} : {
      quotaUnavailableReason: provider.quotaUnavailableReason,
    },
    authentication: provider.authentication,
    ...provider.supportsExplicitAuthentication === undefined ? {} : {
      supportsExplicitAuthentication: provider.supportsExplicitAuthentication,
    },
    productVersion: provider.productVersion,
    models: provider.models.map(model => ({
      model: model.model,
      ...model.resolvedModel === undefined ? {} : { resolvedModel: model.resolvedModel },
      displayName: model.displayName,
      description: model.description,
      supportedEfforts: [...model.supportedEfforts],
      ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
      isDefault: model.isDefault,
      supportsAdaptiveThinking: model.supportsAdaptiveThinking,
    })),
  }
}

function sessionValue(session: ResidentSessionSnapshot): DesktopResidentSession {
  return {
    sessionId: String(session.sessionId),
    operatorId: session.operatorId,
    workspace: session.workspace,
    workspaceDisplay: displayWorkspace(session.workspace),
    laneId: session.laneId,
    lifecycle: session.lifecycle,
    health: session.health,
    ...session.healthReason === undefined ? {} : { healthReason: session.healthReason },
    stateRevision: session.stateRevision,
    ...session.activeTurnId === undefined ? {} : { activeTurnId: String(session.activeTurnId) },
    ...session.executionProfile === undefined ? {} : {
      executionProfile: { ...session.executionProfile },
    },
    ...session.executionProfileSource === undefined ? {} : {
      executionProfileSource: session.executionProfileSource,
    },
    ...session.latestTurn === undefined ? {} : { latestTurn: turnSummaryValue(session.latestTurn) },
    ...session.latestEvent === undefined ? {} : { latestEvent: eventValue(session.latestEvent) },
    updatedAt: session.updatedAt,
  }
}

function turnSummaryValue(turn: ResidentTurnSummary): DesktopResidentTurn {
  return {
    commandId: String(turn.commandId),
    turnId: String(turn.turnId),
    state: turn.state,
    ...turn.taskLabel === undefined ? {} : { taskLabel: turn.taskLabel },
    ...turn.stopReason === undefined ? {} : { stopReason: turn.stopReason },
    ...turn.resultRef === undefined ? {} : { resultRef: turn.resultRef },
    updatedAt: turn.updatedAt,
  }
}

function displayWorkspace(workspace: string): string {
  const home = homedir()
  return workspace === home ? '~' : workspace.startsWith(`${home}/`) ? `~${workspace.slice(home.length)}` : workspace
}

function turnValue(turn: ResidentTurnSnapshot): NonNullable<DesktopResidentDashboard['selectedTurn']> {
  return {
    ...turnSummaryValue(turn),
    sessionId: String(turn.sessionId),
    stateRevision: turn.stateRevision,
    ...turn.result === undefined ? {} : {
      result: {
        stopReason: turn.result.stopReason,
        ...turn.result.resultRef === undefined ? {} : { resultRef: turn.result.resultRef },
      },
    },
    ...turn.error === undefined ? {} : { error: turn.error },
  }
}

function eventValue(event: ResidentEvent): DesktopResidentEvent {
  return {
    sequence: event.sequence,
    type: event.type,
    time: event.time,
    data: { ...event.data },
  }
}

/**
 * Register the authenticated native CLI route: GET checks running and
 * published versions; a local-owner POST downloads, qualifies, and activates
 * the newest CLI of `?product=`.
 * @param ctx - Host context carrying Web Server, Remote Auth, and Resident services.
 * @returns a disposer that unregisters the route.
 */
export function registerResidentCliRuntimes(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: RESIDENT_CLI_PATH,
    handler: async (request, response) => {
      const authority = authorize(ctx, request, response)
      if (authority === undefined) return
      if (request.method !== 'GET' && request.method !== 'POST') {
        response.writeHead(405, { Allow: 'GET, POST' })
        response.end()
        return
      }
      if (request.method === 'POST' && !authority.local) {
        sendJson(response, 403, { error: 'LOCAL_OWNER_REQUIRED' })
        return
      }
      const product = new URL(request.url ?? RESIDENT_CLI_PATH, 'http://127.0.0.1').searchParams.get('product')
      if (request.method === 'POST' && product !== 'claude-code' && product !== 'codex') {
        sendJson(response, 400, { error: 'PRODUCT_REQUIRED' })
        return
      }
      try {
        if (product === 'claude-code' || product === 'codex') {
          const result = await ctx.residentOperators.updateCli(product)
          sendJson(response, 200, {
            product: result.product,
            version: result.version,
            status: result.status,
            ...result.reason === undefined ? {} : { reason: result.reason },
          } satisfies DesktopResidentCliUpdate)
          return
        }
        sendJson(response, 200, {
          runtimes: (await ctx.residentOperators.cliRuntimes()).map(runtime => ({ ...runtime })),
        } satisfies DesktopResidentCliRuntimes)
      } catch (cause) {
        ctx.logger.warn(cause)
        sendJson(response, 503, {
          error: 'RESIDENT_CLI_UNAVAILABLE',
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    },
  })
}

/** Messages for the refusals the Resident service can answer to a recovery request. */
const RECOVERY_CONFLICT_CODES = new Set(['REVISION_CONFLICT', 'COMMAND_CONFLICT', 'SESSION_BUSY'])

/**
 * Register the local-owner route that releases a lane closed by a native turn whose end is not known.
 * `?action=resolve` records that the owner accepts the lane without that turn and keeps the native session;
 * `?action=reset` drops the native session so the next task starts a new one. The route refuses any other
 * lane, takes the command to resolve from the lane's own latest turn, and never stops anything in the native product.
 * @param ctx - Host context carrying Web Server, Remote Auth, and Resident services.
 * @returns a disposer that unregisters the route.
 */
export function registerResidentSessionRecovery(ctx: Context): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: RESIDENT_SESSION_RECOVERY_PATH,
    handler: async (request, response) => {
      const authority = authorize(ctx, request, response)
      if (authority === undefined) return
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' })
        response.end()
        return
      }
      const fail = (status: number, error: DesktopResidentRecoveryFailure['error'], message?: string): void => {
        sendJson(response, status, { error, ...message === undefined ? {} : { message } } satisfies DesktopResidentRecoveryFailure)
      }
      if (!authority.local) { fail(403, 'LOCAL_OWNER_REQUIRED'); return }
      const query = new URL(request.url ?? RESIDENT_SESSION_RECOVERY_PATH, 'http://127.0.0.1').searchParams
      const sessionId = query.get('session_id')
      const action = query.get('action')
      const revision = Number(query.get('revision'))
      if (sessionId === null || sessionId.trim().length === 0) { fail(400, 'SESSION_REQUIRED'); return }
      if (action !== 'resolve' && action !== 'reset') { fail(400, 'ACTION_REQUIRED'); return }
      if (!Number.isSafeInteger(revision) || revision < 0) { fail(400, 'REVISION_REQUIRED'); return }
      try {
        const session = await ctx.residentOperators.inspect(sessionId)
        if (session.healthReason !== RESIDENT_NATIVE_OUTCOME_UNCONFIRMED) {
          fail(409, 'LANE_NOT_CLOSED', '这条 lane 当前没有被暂停，无需处理。')
          return
        }
        const blocking = session.latestTurn
        if (action === 'resolve') {
          if (blocking === undefined || blocking.state !== 'indeterminate') {
            fail(409, 'STATE_CHANGED', '这条 lane 的状态已变化，请刷新后再看。')
            return
          }
          await ctx.residentOperators.resolveIndeterminate({
            commandId: ResidentOperatorCommandId(String(blocking.commandId)),
            decision: 'abandon',
            expectedStateRevision: revision,
          })
        } else {
          await ctx.residentOperators.reset({
            sessionId: ResidentOperatorSessionId(sessionId),
            expectedStateRevision: revision,
            reason: 'owner reset of a lane closed by an unconfirmed native turn',
          })
        }
        const after = await ctx.residentOperators.inspect(sessionId)
        if (after.healthReason === RESIDENT_NATIVE_OUTCOME_UNCONFIRMED) {
          fail(409, 'LANE_STILL_CLOSED', '这条 lane 仍然被暂停：还有另一条任务没有确认结束。')
          return
        }
        sendJson(response, 200, { session: sessionValue(after) })
      } catch (cause) {
        ctx.logger.warn(cause)
        const code = typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : undefined
        if (code !== undefined && RECOVERY_CONFLICT_CODES.has(code)) {
          fail(409, 'STATE_CHANGED', '这条 lane 的状态已变化，请刷新后再看。')
          return
        }
        fail(503, 'RESIDENT_RECOVERY_FAILED', cause instanceof Error ? cause.message : String(cause))
        return
      }
    },
  })
}

/** Resolve the caller's Remote Auth authority, answering 503/401 when there is none. */
function authorize(
  ctx: Context,
  request: IncomingMessage,
  response: ServerResponse,
): ReturnType<typeof authorizeRemoteRequest> {
  const authority = authorizeRemoteRequest(request, ctx.get('remoteAuth'))
  if (authority === undefined) {
    sendJson(response, ctx.get('remoteAuth') === undefined ? 503 : 401, {
      error: ctx.get('remoteAuth') === undefined ? 'REMOTE_AUTH_UNAVAILABLE' : 'UNAUTHORIZED',
    })
  }
  return authority
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}
