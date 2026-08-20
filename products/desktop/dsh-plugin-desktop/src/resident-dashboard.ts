/** Read-only Resident Operator projection served to the local Desktop renderer. */

import type { ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {
  ResidentEvent,
  ResidentProviderStatus,
  ResidentSessionSnapshot,
  ResidentTurnSnapshot,
  ResidentTurnSummary,
} from '@deepseek-ai/dsh-resident-operator'
import type {
  DesktopResidentDashboard,
  DesktopResidentEvent,
  DesktopResidentProvider,
  DesktopResidentSession,
  DesktopResidentTurn,
} from './resident-dashboard-contracts.ts'
import { RESIDENT_DASHBOARD_PATH } from './resident-dashboard-contracts.ts'
import { buildResidentActivities, isDiagnosticResidentWorkspace } from './resident-presentation.ts'

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
  const visibleSessions = sessions
    .filter(session => !isDiagnosticResidentWorkspace(session.workspace))
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

/** Register the owner-only loopback read route for the Resident browser panel. */
export function registerResidentDashboard(ctx: Context): () => void {
  let providerCache: { readonly expiresAt: number; readonly value: ResidentProviderStatus[] } | undefined
  return ctx.webServer.register({
    kind: 'exact',
    path: RESIDENT_DASHBOARD_PATH,
    handler: async (request, response) => {
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' })
        response.end()
        return
      }
      const url = new URL(request.url ?? RESIDENT_DASHBOARD_PATH, 'http://127.0.0.1')
      const sessionId = url.searchParams.get('session_id') ?? undefined
      try {
        const [providers, sessions] = await Promise.all([
          providerCache !== undefined && providerCache.expiresAt > Date.now()
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

function providerValue(provider: ResidentProviderStatus): DesktopResidentProvider {
  return {
    operatorId: provider.operatorId,
    product: provider.product,
    available: provider.available,
    ...provider.unavailableReason === undefined ? {} : { unavailableReason: provider.unavailableReason },
    authentication: provider.authentication,
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

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}
