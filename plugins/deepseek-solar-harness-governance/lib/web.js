export const GOVERNANCE_TRACE_PATH = '/code-harness/v1/trace'

function sendJson(res, status, payload, head = false, extraHeaders = {}) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(head ? undefined : body)
}

function parseLimit(url) {
  const raw = url.searchParams.get('limit')
  if (raw === null) return undefined
  if (!/^\d+$/u.test(raw)) throw new RangeError('limit must be a positive integer')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('limit must be a positive integer')
  return value
}

export function createGovernanceTraceHandler(ctx, governance) {
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, {
        error: { code: 'METHOD_NOT_ALLOWED', message: 'governance trace accepts GET and HEAD only' },
      }, false, { allow: 'GET, HEAD' })
      return
    }
    let url
    try {
      url = new URL(req.url ?? GOVERNANCE_TRACE_PATH, 'http://localhost')
    } catch {
      sendJson(res, 400, { error: { code: 'INVALID_REQUEST', message: 'request URL is invalid' } })
      return
    }
    const sessionId = url.searchParams.get('sessionId')?.trim()
    if (sessionId === undefined || sessionId === '') {
      sendJson(res, 400, { error: { code: 'SESSION_REQUIRED', message: 'sessionId is required' } })
      return
    }
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) {
      sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: `session ${sessionId} is not live` } })
      return
    }
    try {
      sendJson(res, 200, {
        sessionId,
        ...governance.traceSession(session, parseLimit(url)),
      }, req.method === 'HEAD')
    } catch (error) {
      sendJson(res, 400, {
        error: {
          code: 'INVALID_LIMIT',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
}

export function registerGovernanceTraceRoute(ctx, governance) {
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: GOVERNANCE_TRACE_PATH,
      handler: createGovernanceTraceHandler(ctx, governance),
    }), 'code-harness-governance: trace HTTP projection')
  })
}
