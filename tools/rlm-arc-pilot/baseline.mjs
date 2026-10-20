import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ARM = 'B'
const MODEL_WIRE_ID = 'selected'
const REASONING_EFFORT = 'high'
const MAX_TOKENS = 16_384
const ACTION_LIMIT = 500
const DEFAULT_REQUEST_LIMIT = 32
const DEFAULT_WALL_TIME_MS = 3_600_000
const MAX_ACTION_BATCH = 20
const ACTION_NAMES = Object.freeze([
  'RESET',
  'ACTION1',
  'ACTION2',
  'ACTION3',
  'ACTION4',
  'ACTION5',
  'ACTION6',
  'ACTION7',
])

const NON_CLICK_ACTION_NAMES = Object.freeze(ACTION_NAMES.filter(name => name !== 'ACTION6'))

/**
 * These are the only operations exposed by the pinned ARC broker.  The
 * descriptions intentionally describe the broker protocol, rather than
 * teaching a strategy or exposing any game implementation detail.
 */
export const BASELINE_TOOLS = Object.freeze([
  {
    type: 'function',
    function: {
      name: 'observe',
      description: 'Read the current observation from the fixed game broker. This operation takes no arguments.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'status',
      description: 'Read the current status from the fixed game broker. This operation takes no arguments.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'act',
      description: 'Submit one to twenty protocol actions to the fixed game broker in order.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['actions'],
        properties: {
          actions: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_ACTION_BATCH,
            items: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'data'],
                  properties: {
                    name: { type: 'string', enum: NON_CLICK_ACTION_NAMES },
                    data: { type: 'object', additionalProperties: false },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'data'],
                  properties: {
                    name: { type: 'string', const: 'ACTION6' },
                    data: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['x', 'y'],
                      properties: {
                        x: { type: 'integer', minimum: 0, maximum: 63 },
                        y: { type: 'integer', minimum: 0, maximum: 63 },
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    },
  },
])

const CONTINUATION = 'Game is still ACTIVE; continue using the game tools. A text claim is not terminal evidence.'

function isRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function jsonClone(value) {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value))
}

function jsonLine(value) {
  return `${JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? `${item}n` : item)}\n`
}

function errorText(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function codedError(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

function requireString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw codedError('ARC_BASELINE_ARGS', `${path} must be a non-empty string`)
  return value
}

function requireFinitePositive(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw codedError('ARC_BASELINE_ARGS', `${path} must be a finite positive number`)
  }
  return value
}

function requireNonNegativeInteger(value, path) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw codedError('ARC_BASELINE_ARGS', `${path} must be a non-negative integer`)
  }
  return value
}

function actionError(path, message) {
  return { ok: false, error: { code: 'ARC_TOOL_ARGS', path, message } }
}

function hasOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return actionError(path, `unexpected field ${JSON.stringify(key)}`)
  }
  return undefined
}

function validateNoArgs(args, path) {
  if (!isRecord(args)) return actionError(path, 'arguments must be an object')
  const extra = hasOnlyKeys(args, new Set(), path)
  return extra ?? (Object.keys(args).length === 0 ? undefined : actionError(path, 'arguments must be empty'))
}

function validateAction(value, path) {
  if (!isRecord(value)) return actionError(path, 'action must be an object')
  const extra = hasOnlyKeys(value, new Set(['name', 'data']), path)
  if (extra) return extra
  if (typeof value.name !== 'string' || !ACTION_NAMES.includes(value.name)) {
    return actionError(`${path}.name`, `must be one of ${ACTION_NAMES.join(', ')}`)
  }
  if (!own(value, 'data')) return actionError(`${path}.data`, 'is required')
  if (value.name === 'ACTION6') {
    if (!isRecord(value.data)) return actionError(`${path}.data`, 'ACTION6 requires an object with x and y')
    const dataExtra = hasOnlyKeys(value.data, new Set(['x', 'y']), `${path}.data`)
    if (dataExtra) return dataExtra
    for (const coordinate of ['x', 'y']) {
      const coordinateValue = value.data[coordinate]
      if (!Number.isSafeInteger(coordinateValue) || coordinateValue < 0 || coordinateValue > 63) {
        return actionError(`${path}.data.${coordinate}`, 'must be an integer in 0..63')
      }
    }
    return undefined
  }
  if (!isRecord(value.data) || Object.keys(value.data).length !== 0) {
    return actionError(`${path}.data`, 'must be an empty object for this action')
  }
  return undefined
}

function validateToolCall(name, args) {
  if (name === 'observe' || name === 'status') {
    return validateNoArgs(args, `tool.${name}`)
  }
  if (name !== 'act') return actionError('tool.name', `unsupported tool ${JSON.stringify(name)}`)
  if (!isRecord(args)) return actionError('tool.act', 'arguments must be an object')
  const extra = hasOnlyKeys(args, new Set(['actions']), 'tool.act')
  if (extra) return extra
  if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > MAX_ACTION_BATCH) {
    return actionError('tool.act.actions', `must contain 1..${MAX_ACTION_BATCH} actions`)
  }
  for (let index = 0; index < args.actions.length; index += 1) {
    const error = validateAction(args.actions[index], `tool.act.actions[${index}]`)
    if (error) return error
  }
  return undefined
}

function buildUserPrompt(gameId) {
  return [
    `Play exactly one independent ARC-AGI-3 offline game identified as ${gameId}.`,
    'Use only the provided observe, status and act tools for this fixed game.',
    `The game action limit is ${ACTION_LIMIT} and this condition has a ${DEFAULT_REQUEST_LIMIT}-request model budget.`,
    'Continue until the broker reports WIN or ACTION_CAP.',
  ].join(' ')
}

function assistantText(message) {
  return isRecord(message) && typeof message.content === 'string' ? message.content : null
}

function unwrapBrokerResult(result) {
  if (isRecord(result) && result.ok === false) {
    return { ok: false, raw: result, error: result.message ?? result.error ?? 'broker returned an error' }
  }
  if (isRecord(result) && result.ok === true && own(result, 'value')) {
    return { ok: true, raw: result, value: result.value }
  }
  return { ok: true, raw: result, value: result }
}

function terminalOf(value) {
  const candidates = []
  if (isRecord(value)) {
    candidates.push(value.terminal, value.state, value.status)
    if (isRecord(value.value)) candidates.push(value.value.terminal, value.value.state, value.value.status)
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.toUpperCase()
    if (normalized === 'WIN' || normalized === 'ACTION_CAP') return normalized
  }
  return undefined
}

function brokerCondition(value) {
  if (!isRecord(value)) return undefined
  const candidates = [value, isRecord(value.value) ? value.value : undefined].filter(Boolean)
  for (const candidate of candidates) {
    if (candidate.unknown === true || candidate.indeterminate === true) return 'unknown'
    if (candidate.fatal === true) return 'fatal'
    for (const key of ['error', 'code', 'status', 'terminal', 'state']) {
      const item = candidate[key]
      if (typeof item !== 'string') continue
      const normalized = item.toUpperCase()
      if (normalized.includes('UNKNOWN') || normalized.includes('INDETERMINATE')) return 'unknown'
      if (key === 'error' && item.length > 0) return 'fatal'
      if (normalized === 'FATAL') return 'fatal'
    }
  }
  return undefined
}

function toolResultContent(result) {
  try {
    return JSON.stringify(result)
  } catch {
    return JSON.stringify({ ok: false, error: 'broker result was not JSON serializable' })
  }
}

function assistantToolCalls(message) {
  if (!isRecord(message) || !own(message, 'tool_calls')) return []
  if (!Array.isArray(message.tool_calls)) throw codedError('ARC_MODEL_MESSAGE', 'assistant.tool_calls must be an array')
  return message.tool_calls
}

function parseToolCall(call, index) {
  const path = `assistant.tool_calls[${index}]`
  if (!isRecord(call)) return { error: actionError(path, 'tool call must be an object') }
  if (typeof call.id !== 'string' || call.id.length === 0) return { error: actionError(`${path}.id`, 'must be a non-empty string') }
  if (call.type !== 'function') return { id: call.id, error: actionError(`${path}.type`, 'must be function') }
  if (!isRecord(call.function)) return { id: call.id, error: actionError(`${path}.function`, 'must be an object') }
  if (typeof call.function.name !== 'string' || call.function.name.length === 0) {
    return { id: call.id, error: actionError(`${path}.function.name`, 'must be a non-empty string') }
  }
  const argumentText = call.function.arguments
  if (typeof argumentText !== 'string') return { id: call.id, name: call.function.name, error: actionError(`${path}.function.arguments`, 'must be a JSON string') }
  let args
  try {
    args = JSON.parse(argumentText)
  } catch (error) {
    return { id: call.id, name: call.function.name, error: actionError(`${path}.function.arguments`, `invalid JSON: ${errorText(error)}`) }
  }
  return { id: call.id, name: call.function.name, args }
}

function stopClassification({ signal, abortKind }) {
  if (!signal.aborted) return undefined
  return abortKind === 'wall-time' ? 'wall-time' : 'aborted'
}

async function writeLine(directory, fileName, value) {
  await appendFile(join(directory, fileName), jsonLine(value), { encoding: 'utf8', mode: 0o600 })
}

async function writeJson(directory, fileName, value) {
  await writeFile(join(directory, fileName), jsonLine(value), { encoding: 'utf8', mode: 0o600, flag: 'w' })
}

function resultBase(evidenceDirectory, requests, answer, observation) {
  return {
    arm: ARM,
    state: 'failed',
    requests,
    answer,
    observation,
    evidenceDirectory,
    physicalCleanup: true,
  }
}

/**
 * Run the ordinary structured-tool ARC baseline for one frozen game.
 *
 * This function owns no provider, subprocess, game engine, or credentials.
 * `callModel` and `broker` are supplied by the trusted parent runner.
 */
export async function runBaseline({
  directory,
  plan,
  gameId,
  broker,
  route,
  wire,
  callModel,
  signal,
  wallTimeMs = DEFAULT_WALL_TIME_MS,
  requestLimit = DEFAULT_REQUEST_LIMIT,
}) {
  const evidenceDirectory = resolve(requireString(directory, 'directory'))
  requireString(gameId, 'gameId')
  if (!isRecord(plan) || !isRecord(plan.arms) || !isRecord(plan.arms.B)) {
    throw codedError('ARC_BASELINE_ARGS', 'plan.arms.B is required')
  }
  requireString(plan.arms.B.systemPrompt, 'plan.arms.B.systemPrompt')
  if (broker === null || (typeof broker !== 'object' && typeof broker !== 'function') || typeof broker.call !== 'function' || typeof broker.inspect !== 'function') {
    throw codedError('ARC_BASELINE_ARGS', 'broker.call and broker.inspect are required')
  }
  if (wire === null || (typeof wire !== 'object' && typeof wire !== 'function') || typeof wire.decodeChatRequest !== 'function' || typeof wire.encodeChatStream !== 'function' || typeof wire.ReplayRegistry !== 'function') {
    throw codedError('ARC_BASELINE_ARGS', 'wire.decodeChatRequest, wire.encodeChatStream and wire.ReplayRegistry are required')
  }
  if (typeof callModel !== 'function') throw codedError('ARC_BASELINE_ARGS', 'callModel is required')
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw codedError('ARC_BASELINE_ARGS', 'signal must be an AbortSignal')
  requireFinitePositive(wallTimeMs, 'wallTimeMs')
  requireNonNegativeInteger(requestLimit, 'requestLimit')

  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 })
  const runId = randomUUID()
  const startedAt = new Date().toISOString()
  const controller = new AbortController()
  let abortKind = undefined
  let wallTimer = undefined
  const forwardAbort = () => {
    abortKind = 'caller'
    controller.abort(signal?.reason)
  }
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  wallTimer = setTimeout(() => {
    abortKind = 'wall-time'
    controller.abort(new Error('ARC baseline wall-time limit reached'))
  }, wallTimeMs)
  if (typeof wallTimer.unref === 'function') wallTimer.unref()

  const replay = new wire.ReplayRegistry()
  const messages = [
    { role: 'system', content: plan.arms.B.systemPrompt },
    { role: 'user', content: buildUserPrompt(gameId) },
  ]
  const initialRequest = {
    model: MODEL_WIRE_ID,
    stream: true,
    messages: jsonClone(messages),
    tools: jsonClone(BASELINE_TOOLS),
    reasoning_effort: REASONING_EFFORT,
    max_tokens: MAX_TOKENS,
  }
  await writeJson(evidenceDirectory, 'initial-request.json', {
    formatVersion: 1,
    arm: ARM,
    runId,
    gameId,
    requestLimit,
    actionLimit: ACTION_LIMIT,
    request: initialRequest,
  })
  await writeJson(evidenceDirectory, 'manifest.json', {
    formatVersion: 1,
    arm: ARM,
    runId,
    gameId,
    requestLimit,
    wallTimeMs,
    model: { id: 'gpt-6.1-sol', reasoningEffort: REASONING_EFFORT, maxOutputTokens: MAX_TOKENS },
    startedAt,
    physicalCleanup: true,
  })
  await writeLine(evidenceDirectory, 'messages.jsonl', { runId, ordinal: 0, phase: 'initial', messages: jsonClone(messages) })

  let requests = 0
  let answer = null
  let observation = undefined
  let stopReason = undefined
  let finalState = undefined

  const finish = (state, reason, error) => {
    finalState = state
    stopReason = reason
    const result = resultBase(evidenceDirectory, requests, answer, observation)
    result.state = state
    if (reason !== undefined) result.stopReason = reason
    if (error !== undefined) result.error = error
    return result
  }

  const inspectBroker = async () => {
    let raw
    try {
      raw = await broker.inspect()
    } catch (error) {
      return { ok: false, kind: 'fatal', error: errorText(error) }
    }
    const result = unwrapBrokerResult(raw)
    if (!result.ok) return { ok: false, kind: brokerCondition(raw) === 'unknown' ? 'unknown' : 'fatal', error: String(result.error), raw }
    const condition = brokerCondition(raw)
    if (condition) return { ok: false, kind: condition, error: condition === 'unknown' ? 'broker reported unknown state' : 'broker reported fatal state', raw }
    observation = result.value
    return { ok: true, terminal: terminalOf(result.value), value: result.value, raw }
  }

  try {
    if (requestLimit === 0) return finish('budget_exhausted', 'REQUEST_LIMIT')
    while (finalState === undefined) {
      const aborted = stopClassification({ signal: controller.signal, abortKind })
      if (aborted) return finish(aborted === 'aborted' ? 'cancelled' : 'failed', aborted === 'aborted' ? 'ABORTED' : 'WALL_TIME')
      if (requests >= requestLimit) return finish('budget_exhausted', 'REQUEST_LIMIT')

      const request = {
        model: MODEL_WIRE_ID,
        stream: true,
        messages: jsonClone(messages),
        tools: jsonClone(BASELINE_TOOLS),
        reasoning_effort: REASONING_EFFORT,
        max_tokens: MAX_TOKENS,
      }
      const ordinal = requests + 1
      const dshRequest = await wire.decodeChatRequest(request, route, {
        signal: controller.signal,
        sessionId: runId,
        replayFor: message => replay.forMessage(message),
      })
      await writeLine(evidenceDirectory, 'journal.jsonl', {
        formatVersion: 1,
        time: new Date().toISOString(),
        value: { type: 'model-intent', ordinal, request: jsonClone(request) },
      })
      await writeLine(evidenceDirectory, 'requests.jsonl', { runId, ordinal, request: jsonClone(request), dshRequest: jsonClone(dshRequest) })
      await writeLine(evidenceDirectory, 'journal.jsonl', {
        formatVersion: 1,
        time: new Date().toISOString(),
        value: { type: 'model-dispatch', ordinal },
      })
      requests += 1

      const rawChunks = []
      let settled
      let sseCount = 0
      try {
        const modelOptions = isRecord(dshRequest)
          ? { ...dshRequest, signal: controller.signal }
          : dshRequest
        const modelStream = await callModel(modelOptions)
        if (!modelStream || typeof modelStream[Symbol.asyncIterator] !== 'function') {
          throw codedError('ARC_MODEL_STREAM', 'callModel must return an AsyncIterable')
        }
        async function* recordChunks() {
          for await (const chunk of modelStream) {
            rawChunks.push(jsonClone(chunk))
            yield chunk
          }
        }
        for await (const _line of wire.encodeChatStream(recordChunks(), {
          id: runId,
          model: MODEL_WIRE_ID,
          onFinish: value => {
            if (settled !== undefined) throw codedError('ARC_MODEL_STREAM', 'stream produced more than one successful finish')
            settled = value
            if (value.replayState !== undefined) replay.record(value.message, value.replayState)
          },
        })) {
          sseCount += 1
        }
      } finally {
        await writeLine(evidenceDirectory, 'chunks.jsonl', { runId, ordinal, chunks: rawChunks, sseCount }).catch(() => {})
      }
      const streamAbort = stopClassification({ signal: controller.signal, abortKind })
      if (streamAbort) return finish(streamAbort === 'aborted' ? 'cancelled' : 'failed', streamAbort === 'aborted' ? 'ABORTED' : 'WALL_TIME')
      if (settled === undefined || !isRecord(settled) || !isRecord(settled.message)) {
        throw codedError('ARC_MODEL_STREAM', 'stream ended without a successful assistant finish')
      }
      await writeLine(evidenceDirectory, 'settlements.jsonl', { runId, ordinal, settlement: jsonClone(settled) })
      await writeLine(evidenceDirectory, 'journal.jsonl', {
        formatVersion: 1,
        time: new Date().toISOString(),
        value: { type: 'model-settlement', ordinal, value: jsonClone(settled) },
      })

      const assistant = jsonClone(settled.message)
      const text = assistantText(assistant)
      if (text !== null) answer = text
      messages.push(assistant)
      await writeLine(evidenceDirectory, 'messages.jsonl', { runId, ordinal, phase: 'assistant', message: assistant, messages: jsonClone(messages) })
      const calls = assistantToolCalls(assistant)

      if (calls.length === 0) {
        const inspection = await inspectBroker()
        if (!inspection.ok) return finish(inspection.kind === 'unknown' ? 'indeterminate' : 'failed', inspection.kind === 'unknown' ? 'BROKER_UNKNOWN' : 'BROKER_ERROR', inspection.error)
        if (inspection.terminal) return finish('completed', inspection.terminal)
        if (requests >= requestLimit) return finish('budget_exhausted', 'REQUEST_LIMIT')
        messages.push({ role: 'user', content: CONTINUATION })
        await writeLine(evidenceDirectory, 'messages.jsonl', { runId, ordinal, phase: 'continuation', message: { role: 'user', content: CONTINUATION }, messages: jsonClone(messages) })
        continue
      }

      for (let index = 0; index < calls.length; index += 1) {
        const parsed = parseToolCall(calls[index], index)
        let toolPayload
        let terminalAfterTool
        if (parsed.error) {
          toolPayload = parsed.error
        } else {
          const validationError = validateToolCall(parsed.name, parsed.args)
          if (validationError) {
            toolPayload = validationError
          } else {
            let brokerRaw
            try {
              brokerRaw = await broker.call(parsed.name, parsed.args)
            } catch (error) {
              const message = errorText(error)
              const kind = /unknown|indeterminate|disconnect|timeout/i.test(message) ? 'unknown' : 'fatal'
              return finish(kind === 'unknown' ? 'indeterminate' : 'failed', kind === 'unknown' ? 'BROKER_UNKNOWN' : 'BROKER_ERROR', message)
            }
            const brokerResult = unwrapBrokerResult(brokerRaw)
            if (!brokerResult.ok) {
              const kind = brokerCondition(brokerRaw) === 'unknown' || /unknown|indeterminate|disconnect|timeout/i.test(String(brokerResult.error)) ? 'unknown' : 'fatal'
              return finish(kind === 'unknown' ? 'indeterminate' : 'failed', kind === 'unknown' ? 'BROKER_UNKNOWN' : 'BROKER_ERROR', String(brokerResult.error))
            }
            const condition = brokerCondition(brokerRaw)
            if (condition) return finish(condition === 'unknown' ? 'indeterminate' : 'failed', condition === 'unknown' ? 'BROKER_UNKNOWN' : 'BROKER_ERROR', `broker reported ${condition} state`)
            // Preserve the broker acknowledgement exactly as returned so the
            // model sees protocol errors/metadata and not an adapter-invented
            // projection of the response.
            toolPayload = brokerResult.raw
            const claimedTerminal = terminalOf(brokerRaw) ?? terminalOf(brokerResult.value)
            if (claimedTerminal) {
              const inspection = await inspectBroker()
              if (!inspection.ok) return finish(inspection.kind === 'unknown' ? 'indeterminate' : 'failed', inspection.kind === 'unknown' ? 'BROKER_UNKNOWN' : 'BROKER_ERROR', inspection.error)
              terminalAfterTool = inspection.terminal
            }
          }
        }
        const toolMessage = {
          role: 'tool',
          tool_call_id: parsed.id ?? `invalid-${ordinal}-${index}`,
          content: toolResultContent(toolPayload),
        }
        messages.push(toolMessage)
        await writeLine(evidenceDirectory, 'messages.jsonl', { runId, ordinal, phase: 'tool', message: toolMessage, messages: jsonClone(messages) })
        if (terminalAfterTool) return finish('completed', terminalAfterTool)
      }

      if (requests >= requestLimit) return finish('budget_exhausted', 'REQUEST_LIMIT')
    }
    return finish('failed', stopReason ?? 'UNKNOWN')
  } catch (error) {
    const abort = stopClassification({ signal: controller.signal, abortKind })
    const state = abort === 'aborted' ? 'cancelled' : abort === 'wall-time' ? 'failed' : 'failed'
    const reason = abort === 'aborted' ? 'ABORTED' : abort === 'wall-time' ? 'WALL_TIME' : 'MODEL_ERROR'
    await writeLine(evidenceDirectory, 'journal.jsonl', {
      formatVersion: 1,
      time: new Date().toISOString(),
      value: { type: abort ? 'model-error' : 'model-error', ordinal: requests || undefined, error: errorText(error), reason },
    }).catch(() => {})
    return finish(state, reason, errorText(error))
  } finally {
    if (wallTimer !== undefined) clearTimeout(wallTimer)
    signal?.removeEventListener('abort', forwardAbort)
    await writeJson(evidenceDirectory, 'result.json', {
      formatVersion: 1,
      arm: ARM,
      runId,
      gameId,
      state: finalState,
      requests,
      answer,
      observation,
      stopReason,
    }).catch(() => {})
  }
}

