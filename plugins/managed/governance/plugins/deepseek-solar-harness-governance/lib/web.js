export const GOVERNANCE_TRACE_PATH = '/code-harness/v1/trace'

/**
 * Session events that record an admission, route, or durable receipt decision.
 *
 * This is deliberately narrower than the ordinary execution trace. The
 * Governance Trace answers whether work was authorized and proven; the
 * Trajectory tab owns native progress, tools, and model-visible output.
 */
const GOVERNANCE_DECISION_EVENT_TYPES = new Set([
  'physical-operator/routing-decision',
  'physical-operator/dispatch',
  'physical-operator/tool-dispatch',
  'physical-operator/dispatch-terminal',
  'orchestration/admission',
])

function boundedDecisionText(value, limit = 400) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, limit) : undefined
}

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
    if (typeof record?.type !== 'string') continue
    const traceEvent = record.type.startsWith('governance/')
      || GOVERNANCE_DECISION_EVENT_TYPES.has(record.type)
    if (!traceEvent) continue
    if (!Number.isSafeInteger(record.seq) || record.seq < 0 || record.data === null || typeof record.data !== 'object') {
      throw new Error(`raw session ${sessionId} contains an invalid trace event at line ${String(index + 1)}`)
    }
    events.push(record)
  }
  return { events }
}

function eventTimestamp(event) {
  if (typeof event.time === 'number' && Number.isFinite(event.time)) return new Date(event.time).toISOString()
  if (typeof event.time === 'string') return event.time
  return null
}

function projectGovernanceDecisionEvent(event, index) {
  const data = event.data ?? {}
  const base = {
    sequence: Number.isSafeInteger(event.seq) ? event.seq : index,
    timestamp: eventTimestamp(event),
  }
  if (event.type === 'physical-operator/routing-decision') {
    const reason = boundedDecisionText(data.reason)
    return {
      ...base,
      type: 'operator.route-selected',
      category: 'policy',
      ...typeof data.policy === 'string' ? { policy: data.policy } : {},
      ...typeof data.route === 'string' ? { route: data.route } : {},
      ...typeof data.operatorId === 'string' ? { operatorId: data.operatorId } : {},
      ...reason === undefined ? {} : { reason },
    }
  }
  if (event.type === 'orchestration/admission') {
    return {
      ...base,
      type: 'orchestration.admitted',
      category: 'admission',
      ...typeof data.policy === 'string' ? { policy: data.policy } : {},
      ...typeof data.route === 'string' ? { route: data.route } : {},
      ...typeof data.runId === 'string' ? { runId: data.runId } : {},
      ...Number.isSafeInteger(data.maxParallel) ? { maxParallel: data.maxParallel } : {},
    }
  }
  if (event.type === 'physical-operator/dispatch' || event.type === 'physical-operator/tool-dispatch') {
    return {
      ...base,
      type: 'operator.dispatch-accepted',
      category: 'receipt',
      ...typeof data.commandId === 'string' ? { commandId: data.commandId } : {},
      ...typeof data.operatorId === 'string' ? { operatorId: data.operatorId } : {},
      ...typeof data.mode === 'string' ? { mode: data.mode } : {},
    }
  }
  if (event.type === 'physical-operator/dispatch-terminal') {
    return {
      ...base,
      type: 'operator.receipt-terminal',
      category: 'receipt',
      ...typeof data.commandId === 'string' ? { commandId: data.commandId } : {},
      ...typeof data.operatorId === 'string' ? { operatorId: data.operatorId } : {},
      ...typeof data.code === 'string' ? { code: data.code } : {},
      ...typeof data.stopReason === 'string' ? { stopReason: data.stopReason } : {},
    }
  }
  return undefined
}

function projectGovernanceDecisions(session, requestedLimit) {
  const limit = requestedLimit ?? 200
  const events = []
  for (const [index, event] of session.events.entries()) {
    const projected = projectGovernanceDecisionEvent(event, index)
    if (projected !== undefined) events.push(projected)
  }
  return {
    kind: 'governance-decisions',
    totalEvents: events.length,
    returnedEvents: Math.min(events.length, limit),
    events: events.slice(-limit),
  }
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
        collaboration: projectGovernanceDecisions(session, limit),
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
