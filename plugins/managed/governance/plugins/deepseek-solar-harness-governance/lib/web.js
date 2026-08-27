export const GOVERNANCE_TRACE_PATH = '/code-harness/v1/trace'

const DIRECT_OPERATOR_PROVIDER = 'dsh-physical-operator'
const COLLABORATION_EVENT_TYPES = new Set([
  'physical-operator/routing-decision',
  'physical-operator/dispatch',
  'physical-operator/dispatch-terminal',
  'physical-operator/tool-call',
  'physical-operator/tool-result',
  'orchestration/admission',
])
const MAX_OUTPUT_PREVIEW = 4_000

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
      || COLLABORATION_EVENT_TYPES.has(record.type)
      || record.type === 'assistant/message'
      || record.type === 'tool/call'
      || record.type === 'tool/result'
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

function directOperatorOutput(event) {
  if (event.type !== 'assistant/message') return undefined
  const message = event.data?.message
  if (message?.source?.provider !== DIRECT_OPERATOR_PROVIDER || !Array.isArray(message.content)) return undefined
  const text = message.content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
  if (text === '') return undefined
  return {
    output: text,
    outputPreview: text.slice(0, MAX_OUTPUT_PREVIEW),
    outputTruncated: text.length > MAX_OUTPUT_PREVIEW,
    operatorId: typeof message.source.model === 'string' ? message.source.model : undefined,
  }
}

function visibleContentText(content) {
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return []
    if (block.type === 'reasoning') return []
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'tool-result' && Array.isArray(block.content)) return [visibleContentText(block.content)]
    return [JSON.stringify(block)]
  }).filter(Boolean).join('\n')
}

function subagentOperator(toolName) {
  if (!/^subagent[_-](?:codex|claude(?:[_-]code)?)$/iu.test(toolName)) return undefined
  return /claude/iu.test(toolName) ? 'claude-code' : 'codex'
}

function projectCollaborationEvent(event, index, subagentCalls) {
  const output = directOperatorOutput(event)
  const data = event.data ?? {}
  if (event.type === 'tool/call') {
    const operatorId = subagentOperator(String(data.name ?? ''))
    if (operatorId === undefined || typeof data.callId !== 'string') return undefined
    const call = { operatorId, tool: data.name, input: String(data.arguments ?? '') }
    subagentCalls.set(data.callId, call)
    return {
      sequence: Number.isSafeInteger(event.seq) ? event.seq : index,
      type: 'subagent/call',
      timestamp: eventTimestamp(event),
      ...call,
    }
  }
  if (event.type === 'tool/result') {
    const callId = data.message?.source?.callId
    const call = typeof callId === 'string' ? subagentCalls.get(callId) : undefined
    if (call === undefined) return undefined
    const text = visibleContentText(data.message?.content)
    return {
      sequence: Number.isSafeInteger(event.seq) ? event.seq : index,
      type: 'subagent/output',
      timestamp: eventTimestamp(event),
      operatorId: call.operatorId,
      tool: call.tool,
      output: text,
      outputPreview: text.slice(0, MAX_OUTPUT_PREVIEW),
      outputTruncated: text.length > MAX_OUTPUT_PREVIEW,
      isError: data.message?.content?.some?.(block => block?.type === 'tool-result' && block.isError === true) === true,
    }
  }
  if (!COLLABORATION_EVENT_TYPES.has(event.type) && output === undefined) return undefined
  if (event.type === 'physical-operator/tool-call') {
    return {
      sequence: Number.isSafeInteger(event.seq) ? event.seq : index,
      type: event.type,
      timestamp: eventTimestamp(event),
      commandId: typeof data.commandId === 'string' ? data.commandId : undefined,
      tool: typeof data.tool === 'string' ? data.tool : undefined,
      input: JSON.stringify(data.arguments ?? {}, null, 2),
    }
  }
  if (event.type === 'physical-operator/tool-result') {
    const text = visibleContentText(data.result?.content)
    return {
      sequence: Number.isSafeInteger(event.seq) ? event.seq : index,
      type: event.type,
      timestamp: eventTimestamp(event),
      commandId: typeof data.commandId === 'string' ? data.commandId : undefined,
      tool: typeof data.tool === 'string' ? data.tool : undefined,
      output: text,
      outputPreview: text.slice(0, MAX_OUTPUT_PREVIEW),
      outputTruncated: text.length > MAX_OUTPUT_PREVIEW,
      isError: data.result?.isError === true,
    }
  }
  return {
    sequence: Number.isSafeInteger(event.seq) ? event.seq : index,
    type: output === undefined ? event.type : 'physical-operator/output',
    timestamp: eventTimestamp(event),
    ...typeof data.policy === 'string' ? { policy: data.policy } : {},
    ...typeof data.route === 'string' ? { route: data.route } : {},
    ...typeof data.reason === 'string' ? { reason: data.reason } : {},
    ...typeof data.operatorId === 'string' ? { operatorId: data.operatorId } : {},
    ...typeof data.commandId === 'string' ? { commandId: data.commandId } : {},
    ...typeof data.code === 'string' ? { code: data.code } : {},
    ...typeof data.runId === 'string' ? { runId: data.runId } : {},
    ...Number.isSafeInteger(data.maxParallel) ? { maxParallel: data.maxParallel } : {},
    ...output,
  }
}

function projectCollaboration(session, requestedLimit) {
  const limit = requestedLimit ?? 200
  const calls = new Map()
  const events = []
  for (const [index, event] of session.events.entries()) {
    const projected = projectCollaborationEvent(event, index, calls)
    if (projected !== undefined) events.push(projected)
  }
  return {
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
        collaboration: projectCollaboration(session, limit),
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
