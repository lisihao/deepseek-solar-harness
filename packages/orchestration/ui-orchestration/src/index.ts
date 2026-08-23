/** Owner-local HTTP projection and trusted controls for durable orchestration. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteAuthService, RemoteDeviceScope } from '@deepseek-ai/dsh-host-remote-auth'
import { OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'ui-orchestration'
export const inject = ['orchestrations', 'webServer']
/** Same-origin Host route used by the trusted orchestration dashboard. */
export const ORCHESTRATION_DASHBOARD_PATH = '/api/orchestrations'

const MAX_CONTROL_BYTES = 64 * 1024

interface OrchestrationRequestAuthority {
  readonly local: boolean
  readonly scope: RemoteDeviceScope
}

function loopbackAddress(value: string | undefined): boolean {
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
}

function loopbackAuthority(value: string | undefined): boolean {
  if (value === undefined) return false
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`)
    return url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost'
  } catch {
    return false
  }
}

function firstHeader(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  return typeof value[0] === 'string' ? value[0] : undefined
}

/**
 * Resolve loopback authority or one authenticated remote device scope.
 * @param request - HTTP headers and peer address used at the trust boundary.
 * @param auth - remote authentication service when the request is not local.
 * @returns resolved authority, or undefined when authentication fails.
 */
export function authorizeOrchestrationRequest(
  request: Pick<IncomingMessage, 'headers' | 'socket'>,
  auth: Pick<RemoteAuthService, 'authenticate'> | undefined,
): OrchestrationRequestAuthority | undefined {
  const host = firstHeader(request.headers.host)
  const origin = firstHeader(request.headers.origin)
  if (loopbackAddress(request.socket.remoteAddress)
    && loopbackAuthority(host)
    && (origin === undefined || loopbackAuthority(origin))) {
    return { local: true, scope: 'admin' }
  }
  const authorization = firstHeader(request.headers.authorization)
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  const principal = token === undefined ? undefined : auth?.authenticate(token)
  return principal === undefined ? undefined : { local: false, scope: principal.scope }
}

/**
 * Apply the fixed cockpit/pocket/admin command surface.
 * @param scope - authenticated remote device scope.
 * @param action - requested orchestration control action.
 * @returns whether this scope may perform the action.
 */
export function remoteOrchestrationControlAllowed(scope: RemoteDeviceScope, action: string): boolean {
  if (scope === 'admin' || scope === 'cockpit') return true
  return action === 'pause' || action === 'resume' || action === 'approve' || action === 'reject'
}

/**
 * Classify the dedicated local acceptance-test workspace namespace.
 * @param workspace - normalized or platform-native workspace path.
 * @returns whether the workspace belongs to the acceptance-test namespace.
 */
export function isDiagnosticOrchestrationWorkspace(workspace: string): boolean {
  const normalized = workspace.replaceAll('\\', '/')
  return /\/(?:private\/)?tmp\/dsh-orchestration-/u.test(normalized)
}

/**
 * Mark retained acceptance runs and optionally remove them from one list projection.
 * @param source - durable run summaries to project.
 * @param includeDiagnostics - whether diagnostic runs remain in the returned list.
 * @returns projected runs and the retained diagnostic-run count.
 */
export function projectOrchestrationRuns<T extends { workspace: string }>(
  source: readonly T[],
  includeDiagnostics: boolean,
): { runs: Array<T & { diagnostic: boolean }>; diagnosticRunCount: number } {
  const projected = source.map(run => ({
    ...run,
    diagnostic: isDiagnosticOrchestrationWorkspace(run.workspace),
  }))
  const diagnosticRunCount = projected.filter(run => run.diagnostic).length
  return {
    runs: includeDiagnostics ? projected : projected.filter(run => !run.diagnostic),
    diagnosticRunCount,
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

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += value.byteLength
    if (bytes > MAX_CONTROL_BYTES) throw new Error('orchestration control request exceeds 64 KiB')
    chunks.push(value)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('control request must be an object')
  return parsed as Record<string, unknown>
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${key} must be a string`)
  return value
}

function requiredRevision(body: Record<string, unknown>): number {
  const value = body.expectedRevision
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error('expectedRevision must be a non-negative integer')
  }
  return value
}

async function readProjection(ctx: Context, url: URL) {
  const runId = url.searchParams.get('run_id')
  const includeDiagnostics = url.searchParams.get('include_diagnostics') !== '0'
  const listedRuns = await ctx.orchestrations.list()
  let runs = projectOrchestrationRuns(listedRuns, true).runs

  if (runId === null) {
    const projection = projectOrchestrationRuns(listedRuns, includeDiagnostics)
    return {
      generatedAt: new Date().toISOString(),
      runs: projection.runs,
      diagnosticRunCount: projection.diagnosticRunCount,
      diagnosticsIncluded: includeDiagnostics,
    }
  }

  const inspectedRun = await ctx.orchestrations.inspect(OrchestrationRunId(runId))
  const projectedRun = {
    ...inspectedRun,
    diagnostic: isDiagnosticOrchestrationWorkspace(inspectedRun.workspace),
  }
  const listedIndex = runs.findIndex(run => run.runId === inspectedRun.runId)
  if (listedIndex === -1) runs = [...runs, projectedRun]
  else runs = runs.with(listedIndex, projectedRun)
  const diagnosticRunCount = runs.filter(run => run.diagnostic).length
  const events = await ctx.orchestrations.readEvents({
    runId: inspectedRun.runId,
    afterSequence: Number(url.searchParams.get('after_sequence') ?? 0),
    limit: 200,
  })
  return {
    generatedAt: new Date().toISOString(),
    runs: includeDiagnostics ? runs : runs.filter(run => !run.diagnostic),
    diagnosticRunCount,
    diagnosticsIncluded: includeDiagnostics,
    selectedRunId: runId,
    events: events.events,
  }
}

async function executeControl(ctx: Context, body: Record<string, unknown>) {
  const action = requiredString(body, 'action')
  const commandId = requiredString(body, 'commandId')
  const runId = OrchestrationRunId(requiredString(body, 'runId'))
  const expectedRevision = requiredRevision(body)
  const reason = optionalString(body, 'reason') ?? ''
  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    return ctx.orchestrations.control({ commandId, runId, expectedRevision, action, reason })
  }
  if (action === 'approve' || action === 'reject') {
    return ctx.orchestrations.decide({
      commandId,
      runId,
      expectedRevision,
      ...body.nodeId === undefined ? {} : { nodeId: requiredString(body, 'nodeId') },
      decision: action,
      reason,
    })
  }
  if (action === 'abandon' || action === 'retry') {
    return ctx.orchestrations.resolveIndeterminate({
      commandId,
      runId,
      nodeId: requiredString(body, 'nodeId'),
      expectedRevision,
      decision: action,
      reason,
    })
  }
  throw new Error(`unsupported orchestration control action: ${action}`)
}

/** Register the same-origin read projection and header-protected human controls. */
export function apply(ctx: Context): void {
  ctx.webServer.register({
    kind: 'exact',
    path: ORCHESTRATION_DASHBOARD_PATH,
    handler: async (request, response) => {
      try {
        const authority = authorizeOrchestrationRequest(request, ctx.get('remoteAuth'))
        if (authority === undefined) {
          sendJson(response, ctx.get('remoteAuth') === undefined ? 503 : 401, {
            error: ctx.get('remoteAuth') === undefined ? 'REMOTE_AUTH_UNAVAILABLE' : 'UNAUTHORIZED',
          })
          return
        }
        if (request.method === 'GET') {
          const url = new URL(request.url ?? ORCHESTRATION_DASHBOARD_PATH, 'http://127.0.0.1')
          sendJson(response, 200, await readProjection(ctx, url))
          return
        }
        if (request.method === 'POST') {
          if (request.headers['x-dsh-orchestration-control'] !== '1') {
            sendJson(response, 403, { error: 'CONTROL_HEADER_REQUIRED' })
            return
          }
          const body = await readBody(request)
          const action = requiredString(body, 'action')
          if (!remoteOrchestrationControlAllowed(authority.scope, action)) {
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
        sendJson(response, 400, {
          error: error instanceof Error && 'code' in error ? String(error.code) : 'ORCHESTRATION_UI_ERROR',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })
}
