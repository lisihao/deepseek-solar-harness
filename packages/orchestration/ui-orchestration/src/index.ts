/** Owner-local HTTP projection and trusted controls for durable orchestration. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import {
  authorizeRemoteRequest,
  type RemoteDeviceScope,
  type RemoteRequestAuthority,
} from '@deepseek-ai/dsh-host-remote-auth'
import { OrchestrationArtifactRef, OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import {
  RlmCommandId,
  RlmControlCallerId,
  RlmControlLeaseId,
  RlmRuntimeSessionId,
  type RlmChildSnapshotV1,
  type RlmMessageMode,
  type RlmMessageV1,
  type RlmRuntimeService,
  type RlmRuntimeSessionSnapshotV1,
} from '@deepseek-ai/dsh-rlm-runtime'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  ORCHESTRATION_RLM_AGENTS_PATH,
  type DesktopRlmAgentsDashboardV1,
  type DesktopRlmChild,
  type DesktopRlmControlActionV1,
  type DesktopRlmControlErrorV1,
  type DesktopRlmControlReceiptV1,
  type DesktopRlmControlStatusV1,
  type DesktopRlmMessage,
  type DesktopRlmModel,
  type DesktopRlmSession,
} from './contracts.ts'

export { ORCHESTRATION_RLM_AGENTS_PATH } from './contracts.ts'

export const name = 'ui-orchestration'
export const inject = ['orchestrations', 'webServer']
/** Same-origin Host route used by the trusted orchestration dashboard. */
export const ORCHESTRATION_DASHBOARD_PATH = '/api/orchestrations'

const MAX_CONTROL_BYTES = 64 * 1024

interface HeldRlmControlLease {
  readonly leaseId: ReturnType<typeof RlmControlLeaseId>
  readonly acquiredAt: string
  readonly lastSeenAt: string
}

const RLM_CONTROL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  RLM_CONTROL_BUSY: '该 Session 当前已由其他可信控制者附着。',
  RLM_CONTROL_LEASE_INVALID: 'Runtime 已拒绝当前控制租约，请重新附着。',
  RLM_SESSION_NOT_FOUND: '目标 Session 不存在或已不可用。',
  RLM_UNAVAILABLE: 'RLM Runtime 暂时不可用。',
  RLM_INVALID: 'RLM 控制请求无效。',
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
 * Check whether a remote device may attach or steer a programmable RLM session.
 * @param scope - authenticated remote device scope.
 * @returns whether Agents View control is allowed.
 */
export function remoteRlmAgentsControlAllowed(scope: RemoteDeviceScope): boolean {
  return scope === 'admin' || scope === 'cockpit'
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
  const evidenceRef = url.searchParams.get('evidence_ref')
  if (evidenceRef !== null && runId === null) throw new Error('evidence_ref requires run_id')
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
  if (evidenceRef !== null) {
    const retained = inspectedRun.nodes.some(node => node.evidenceRefs.some(ref => String(ref) === evidenceRef))
    if (!retained) throw new Error(`Evidence ${evidenceRef} does not belong to Run ${runId}`)
    return {
      generatedAt: new Date().toISOString(),
      selectedRunId: runId,
      evidenceRef,
      evidence: await ctx.orchestrations.readArtifact(OrchestrationArtifactRef(evidenceRef)),
    }
  }
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

function requiredRlmControlVersion(body: Record<string, unknown>): 1 {
  if (body.version !== 1) throw new Error('unsupported RLM Agents control version')
  return 1
}

function requiredRlmControlAction(body: Record<string, unknown>): DesktopRlmControlActionV1 {
  const action = requiredString(body, 'action')
  if (action === 'attach' || action === 'input' || action === 'detach') return action
  throw new Error(`unsupported RLM Agents control action: ${action}`)
}

function optionalRlmMessageMode(body: Record<string, unknown>): RlmMessageMode | undefined {
  const mode = optionalString(body, 'mode')
  if (mode === undefined || mode === 'auto' || mode === 'steer' || mode === 'follow_up') return mode
  throw new Error(`unsupported RLM message mode: ${mode}`)
}

function rlmControlErrorCode(error: unknown): string {
  if (error === null || typeof error !== 'object' || !('code' in error)) return 'RLM_CONTROL_ERROR'
  const code = error.code
  return typeof code === 'string' && /^RLM_[A-Z0-9_]+$/u.test(code) ? code : 'RLM_CONTROL_ERROR'
}

function rlmControlError(error: unknown): DesktopRlmControlErrorV1 {
  const code = rlmControlErrorCode(error)
  return {
    code,
    message: RLM_CONTROL_ERROR_MESSAGES[code] ?? 'RLM 控制请求未完成。',
    occurredAt: new Date().toISOString(),
  }
}

function rlmControlHttpStatus(error: unknown): number {
  switch (rlmControlErrorCode(error)) {
    case 'RLM_CONTROL_BUSY':
    case 'RLM_CONTROL_LEASE_INVALID':
      return 409
    case 'RLM_SESSION_NOT_FOUND':
      return 404
    case 'RLM_UNAVAILABLE':
      return 503
    default:
      return 400
  }
}

function rlmControlCallerId(authority: RemoteRequestAuthority) {
  if (authority.local) return RlmControlCallerId('local-owner')
  if (authority.principal === undefined) throw new Error('authenticated remote RLM control requires a principal')
  return RlmControlCallerId(`remote-device:${authority.principal.deviceId}`)
}

function rlmControlLeaseKey(callerId: ReturnType<typeof RlmControlCallerId>, sessionId: ReturnType<typeof RlmRuntimeSessionId>): string {
  return JSON.stringify([String(callerId), String(sessionId)])
}

function rlmModelValue(model: RlmRuntimeSessionSnapshotV1['model']): DesktopRlmModel {
  return {
    operatorId: model.operatorId,
    model: model.model,
    ...model.source === undefined ? {} : { source: model.source },
  }
}

function rlmChildValue(child: RlmChildSnapshotV1): DesktopRlmChild {
  return {
    rlmChildId: String(child.rlmChildId),
    sessionId: String(child.sessionId),
    parentSessionId: String(child.parentSessionId),
    depth: child.depth,
    lifecycle: child.lifecycle,
    model: rlmModelValue(child.model),
    createdAt: child.createdAt,
    updatedAt: child.updatedAt,
  }
}

function rlmSessionValue(session: RlmRuntimeSessionSnapshotV1): DesktopRlmSession {
  return {
    sessionId: String(session.sessionId),
    ...session.parentSessionId === undefined ? {} : { parentSessionId: String(session.parentSessionId) },
    depth: session.depth,
    lifecycle: session.lifecycle,
    model: rlmModelValue(session.model),
    children: session.children.map(rlmChildValue),
    updatedAt: session.updatedAt,
  }
}

function rlmMessageValue(message: RlmMessageV1): DesktopRlmMessage {
  return {
    messageId: message.messageId,
    source: message.source ?? 'agent',
    fromSessionId: String(message.fromSessionId),
    toSessionId: String(message.toSessionId),
    mode: message.mode,
    effectiveMode: message.effectiveMode,
    deliveryStatus: message.deliveryStatus,
    artifactCount: message.artifactRefs?.length ?? 0,
    queuedAt: message.queuedAt,
    ...message.deliveredAt === undefined ? {} : { deliveredAt: message.deliveredAt },
  }
}

function rlmControlStatus(
  lease: HeldRlmControlLease | undefined,
  canControl: boolean,
): DesktopRlmControlStatusV1 {
  if (lease === undefined) {
    return { canControl, attachment: 'not_attached', controller: 'runtime' }
  }
  return {
    canControl,
    attachment: 'attached',
    controller: 'current_trusted_user',
    acquiredAt: lease.acquiredAt,
    lastSeenAt: lease.lastSeenAt,
  }
}

async function readRlmAgentsProjection(
  runtime: RlmRuntimeService,
  url: URL,
  authority: RemoteRequestAuthority,
  leases: ReadonlyMap<string, HeldRlmControlLease>,
): Promise<DesktopRlmAgentsDashboardV1> {
  const sessions = await runtime.list()
  const selectedSessionId = url.searchParams.get('session_id') ?? undefined
  const selected = selectedSessionId === undefined
    ? undefined
    : sessions.find(session => String(session.sessionId) === selectedSessionId)
  if (selectedSessionId !== undefined && selected === undefined) {
    throw new Error(`RLM session is not in the current projection: ${selectedSessionId}`)
  }
  const messages = selected === undefined
    ? []
    : await runtime.readMessages({ sessionId: selected.sessionId, limit: 100 })
  const callerId = rlmControlCallerId(authority)
  const lease = selected === undefined
    ? undefined
    : leases.get(rlmControlLeaseKey(callerId, selected.sessionId))
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    sessions: sessions.map(rlmSessionValue),
    ...selected === undefined ? {} : { selectedSessionId: String(selected.sessionId) },
    messages: messages.map(rlmMessageValue),
    ...selected === undefined ? {} : { control: rlmControlStatus(lease, remoteRlmAgentsControlAllowed(authority.scope)) },
  }
}

async function executeRlmAgentsControl(
  runtime: RlmRuntimeService,
  leases: Map<string, HeldRlmControlLease>,
  authority: RemoteRequestAuthority,
  body: Record<string, unknown>,
): Promise<DesktopRlmControlReceiptV1> {
  const version = requiredRlmControlVersion(body)
  const action = requiredRlmControlAction(body)
  const sessionId = RlmRuntimeSessionId(requiredString(body, 'sessionId'))
  const commandId = RlmCommandId(requiredString(body, 'commandId'))
  const callerId = rlmControlCallerId(authority)
  const key = rlmControlLeaseKey(callerId, sessionId)
  if (action === 'attach') {
    const result = await runtime.attach({ version, sessionId, commandId, callerId })
    leases.set(key, {
      leaseId: result.lease.leaseId,
      acquiredAt: result.lease.acquiredAt,
      lastSeenAt: result.lease.lastSeenAt,
    })
    return { version, action, sessionId: String(sessionId), attachment: 'attached', eventCursor: result.eventCursor }
  }
  const held = leases.get(key)
  if (held === undefined) throw new Error('attach RLM control before submitting input or detach')
  if (action === 'input') {
    const mode = optionalRlmMessageMode(body)
    const result = await runtime.input({
      version,
      sessionId,
      leaseId: held.leaseId,
      commandId,
      text: requiredString(body, 'text'),
      ...mode === undefined ? {} : { mode },
    })
    leases.set(key, { ...held, lastSeenAt: new Date().toISOString() })
    return {
      version,
      action,
      sessionId: String(sessionId),
      attachment: 'attached',
      eventCursor: result.eventCursor,
      message: {
        messageId: result.messageId,
        effectiveMode: result.effectiveMode,
        deliveryStatus: result.deliveryStatus,
      },
    }
  }
  const result = await runtime.detach({ version, sessionId, leaseId: held.leaseId, commandId })
  leases.delete(key)
  return { version, action, sessionId: String(sessionId), attachment: 'not_attached', eventCursor: result.eventCursor }
}

/** Register the same-origin read projection and header-protected human controls. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const leases = new Map<string, HeldRlmControlLease>()
    const disposeDashboard = ctx.webServer.register({
      kind: 'exact',
      path: ORCHESTRATION_DASHBOARD_PATH,
      handler: async (request, response) => {
        try {
          const remoteAuth = ctx.get('remoteAuth')
          const authority = authorizeRemoteRequest(request, remoteAuth)
          if (authority === undefined) {
            const unavailable = remoteAuth === undefined
            sendJson(response, unavailable ? 503 : 401, {
              error: unavailable ? 'REMOTE_AUTH_UNAVAILABLE' : 'UNAUTHORIZED',
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
    const disposeRlmAgents = ctx.webServer.register({
      kind: 'exact',
      path: ORCHESTRATION_RLM_AGENTS_PATH,
      handler: async (request, response) => {
        try {
          const remoteAuth = ctx.get('remoteAuth')
          const authority = authorizeRemoteRequest(request, remoteAuth)
          if (authority === undefined) {
            const unavailable = remoteAuth === undefined
            sendJson(response, unavailable ? 503 : 401, {
              error: unavailable ? 'REMOTE_AUTH_UNAVAILABLE' : 'UNAUTHORIZED',
            })
            return
          }
          const rlmRuntime = ctx.get('rlmRuntime')
          if (rlmRuntime === undefined) {
            sendJson(response, 503, { error: 'RLM_UNAVAILABLE', message: RLM_CONTROL_ERROR_MESSAGES.RLM_UNAVAILABLE })
            return
          }
          if (request.method === 'GET') {
            const url = new URL(request.url ?? ORCHESTRATION_RLM_AGENTS_PATH, 'http://127.0.0.1')
            sendJson(response, 200, await readRlmAgentsProjection(rlmRuntime, url, authority, leases))
            return
          }
          if (request.method === 'POST') {
            if (request.headers['x-dsh-orchestration-control'] !== '1') {
              sendJson(response, 403, { error: 'CONTROL_HEADER_REQUIRED' })
              return
            }
            if (!remoteRlmAgentsControlAllowed(authority.scope)) {
              sendJson(response, 403, { error: 'REMOTE_SCOPE_FORBIDDEN' })
              return
            }
            sendJson(response, 200, await executeRlmAgentsControl(rlmRuntime, leases, authority, await readBody(request)))
            return
          }
          response.writeHead(405, { Allow: 'GET, POST' })
          response.end()
        } catch (error) {
          ctx.logger.warn(error)
          const failure = rlmControlError(error)
          sendJson(response, rlmControlHttpStatus(error), {
            error: failure.code,
            message: failure.message,
          })
        }
      },
    })
    return () => {
      disposeRlmAgents()
      disposeDashboard()
    }
  }, 'ui-orchestration: dashboard routes')
}
