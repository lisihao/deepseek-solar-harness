/** Owner-local HTTP projection and trusted controls for durable orchestration. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { OrchestrationRunId } from '@deepseek-ai/dsh-orchestration'
import type {} from '@deepseek-ai/dsh-host-webserver'

export const name = 'ui-orchestration'
export const inject = ['orchestrations', 'webServer']
/** Same-origin Host route used by the trusted orchestration dashboard. */
export const ORCHESTRATION_DASHBOARD_PATH = '/api/orchestrations'

const MAX_CONTROL_BYTES = 64 * 1024

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
  if (runId === null) return { generatedAt: new Date().toISOString(), runs: await ctx.orchestrations.list() }
  const run = await ctx.orchestrations.inspect(OrchestrationRunId(runId))
  const events = await ctx.orchestrations.readEvents({
    runId: run.runId,
    afterSequence: Number(url.searchParams.get('after_sequence') ?? 0),
    limit: 200,
  })
  return { generatedAt: new Date().toISOString(), runs: [run], selectedRunId: runId, events: events.events }
}

async function executeControl(ctx: Context, body: Record<string, unknown>) {
  const action = requiredString(body, 'action')
  const runId = OrchestrationRunId(requiredString(body, 'runId'))
  const expectedRevision = requiredRevision(body)
  const reason = optionalString(body, 'reason') ?? ''
  if (action === 'pause' || action === 'resume' || action === 'cancel') {
    return ctx.orchestrations.control({ runId, expectedRevision, action, reason })
  }
  if (action === 'approve' || action === 'reject') {
    return ctx.orchestrations.decide({
      runId,
      expectedRevision,
      ...body.nodeId === undefined ? {} : { nodeId: requiredString(body, 'nodeId') },
      decision: action,
      reason,
    })
  }
  if (action === 'abandon' || action === 'retry') {
    return ctx.orchestrations.resolveIndeterminate({
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
          sendJson(response, 200, await executeControl(ctx, await readBody(request)))
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
