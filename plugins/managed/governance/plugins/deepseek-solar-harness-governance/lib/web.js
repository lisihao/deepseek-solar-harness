export const GOVERNANCE_TRACE_PATH = '/code-harness/v1/trace'

function isLegacyGovernanceRefusal(error) {
  return error instanceof Error
    && /event type "governance\/[^"]+"/u.test(error.message)
    && /unknown to this harness and not marked ignorable/iu.test(error.message)
}

function rawGovernanceSession(raw, sessionId) {
  if (raw === undefined) return undefined
  if (raw.meta?.id !== sessionId) throw new Error(`raw session identity mismatch for ${sessionId}`)
  if (typeof raw.content !== 'string') throw new Error(`raw session ${sessionId} has no text content`)
  const events = []
  const lines = raw.content.split('\n')
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`raw session ${sessionId} contains invalid JSON at line ${String(index + 1)}`, { cause: error })
    }
    if (typeof record?.type !== 'string' || !record.type.startsWith('governance/')) continue
    if (!Number.isSafeInteger(record.seq) || record.seq < 0 || record.data === null || typeof record.data !== 'object') {
      throw new Error(`raw session ${sessionId} contains an invalid governance event at line ${String(index + 1)}`)
    }
    events.push(record)
  }
  return { events }
}

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
  return async (req, res) => {
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
    const live = ctx.sessions.get(sessionId)
    try {
      const limit = parseLimit(url)
      let source = 'live'
      let session = live
      if (session === undefined) {
        const persistence = ctx.get('sessionPersistence')
        if (persistence === undefined) {
          sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: `session ${sessionId} was not found` } })
          return
        }
        try {
          session = await persistence.inspect(sessionId)
          source = 'persistence'
        } catch (error) {
          if (error instanceof Error && /not[ -]found/iu.test(error.message)) {
            sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: `session ${sessionId} was not found` } })
            return
          }
          if (!isLegacyGovernanceRefusal(error) || persistence.supportsRawArtifacts !== true) throw error
          session = rawGovernanceSession(await persistence.readRaw(sessionId), sessionId)
          if (session === undefined) throw error
          source = 'raw-persistence'
        }
      }
      sendJson(res, 200, {
        sessionId,
        source,
        ...governance.traceSession(session, limit),
      }, req.method === 'HEAD')
    } catch (error) {
      const invalidLimit = error instanceof RangeError
      sendJson(res, invalidLimit ? 400 : 500, {
        error: {
          code: invalidLimit ? 'INVALID_LIMIT' : 'SESSION_INSPECTION_FAILED',
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
