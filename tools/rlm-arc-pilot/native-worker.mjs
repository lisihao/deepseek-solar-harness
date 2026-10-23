#!/opt/homebrew/opt/node@22/bin/node

import { spawn, execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection, Server as NetServer } from 'node:net'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const FIXED_ROUTE = Object.freeze({
  provider: 'openai-codex',
  model: 'gpt-6.1-sol',
  reasoningEffort: 'high',
  maxTokens: 16_384,
})
const FIXED_REQUEST_LIMIT = 32
const FIXED_WALL_TIME_MS = 3_600_000
const FIXED_AUTONOMOUS = Object.freeze({ maxTurns: 32, maxTokens: 4_000_000 })
const ARC_PROTOCOL = 'arc-pilot-v1'
const RECURSION_ABLATION_PROTOCOL = 'recursion-ablation-v1'
const QUALITY_PILOT_PROTOCOL = 'quality-pilot-v1'
const QUALITY_RECOVERY_PROTOCOL = 'quality-recovery-v1'
const QUALITY_CONTROL_PROTOCOL = 'quality-control-v1'
const QUALITY_GATE_CONTROL_PROTOCOL = 'quality-gate-control-v1'
const RECURSION_ABLATION_REQUEST_LIMIT = 14
const RECURSION_ABLATION_WALL_TIME_MS = 1_200_000
const RECURSION_ABLATION_AUTONOMOUS = Object.freeze({ maxTurns: 14, maxTokens: 4_000_000 })
const QUALITY_PILOT_REQUEST_LIMIT = 32
const QUALITY_PILOT_WALL_TIME_MS = 1_200_000
const QUALITY_PILOT_AUTONOMOUS = Object.freeze({ maxTurns: 32, maxTokens: 4_000_000 })
const QUALITY_RECOVERY_REQUEST_LIMIT = 11
const QUALITY_RECOVERY_WALL_TIME_MS = 1_200_000
const QUALITY_RECOVERY_AUTONOMOUS = Object.freeze({ maxTurns: 11, maxTokens: 4_000_000 })
const QUALITY_CONTROL_REQUEST_LIMIT = 32
const QUALITY_CONTROL_WALL_TIME_MS = 1_200_000
const QUALITY_CONTROL_AUTONOMOUS = Object.freeze({ maxTurns: 32, maxTokens: 4_000_000 })
const QUALITY_GATE_CONTROL_REQUEST_LIMIT = QUALITY_CONTROL_REQUEST_LIMIT
const QUALITY_GATE_CONTROL_WALL_TIME_MS = QUALITY_CONTROL_WALL_TIME_MS
const QUALITY_GATE_CONTROL_AUTONOMOUS = Object.freeze({ ...QUALITY_CONTROL_AUTONOMOUS, gateMaxRetries: 32, maxContinuations: 32 })
const PRIME_META = 'ai.primeintellect.prime-agent'
const MAX_HTTP_REQUEST_BYTES = 32 * 1024 * 1024
const MAX_INLINE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_INLINE_IMAGES_PER_REQUEST = 32 * 1024 * 1024
const NODE = '/opt/homebrew/opt/node@22/bin/node'

function error(code, detail) {
  return new Error(`${code}: ${detail}`)
}

function errorText(value) {
  if (value instanceof Error) return value.stack ?? value.message
  return String(value)
}

function recordError(value) {
  return { name: value instanceof Error ? value.name : 'Error', message: errorText(value) }
}

function createStopLatch() {
  let reason
  return {
    note(value) {
      if (reason === undefined) reason = String(value ?? 'parent stop')
      return reason
    },
    get reason() {
      return reason
    },
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value) {
  return isRecord(value) ? value : {}
}

function absolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw error('ARC_WORKER_CONFIG', `${label} must be a non-empty absolute path`)
  }
  return resolve(value)
}

function inside(root, candidate) {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel))
}

function exactJson(value, label) {
  const omitted = Symbol('omitted')
  const ancestors = new Set()
  const visit = (candidate, path, arrayItem = false) => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw error('ARC_IPC_JSON', `${label} has a non-finite number at ${path}`)
      return candidate
    }
    if (candidate === undefined || typeof candidate === 'function' || typeof candidate === 'symbol') {
      if (arrayItem) throw error('ARC_IPC_JSON', `${label} has an unsupported array value at ${path}`)
      return omitted
    }
    if (typeof candidate === 'bigint') throw error('ARC_IPC_JSON', `${label} has a bigint at ${path}`)
    if (typeof candidate !== 'object') throw error('ARC_IPC_JSON', `${label} has an unsupported value at ${path}`)
    if (ancestors.has(candidate)) throw error('ARC_IPC_JSON', `${label} contains a cycle at ${path}`)
    ancestors.add(candidate)
    try {
      if (Array.isArray(candidate)) return candidate.map((entry, index) => visit(entry, `${path}[${String(index)}]`, true))
      const output = {}
      for (const key of Object.keys(candidate)) {
        const child = visit(candidate[key], `${path}.${key}`)
        if (child !== omitted) output[key] = child
      }
      return output
    } finally {
      ancestors.delete(candidate)
    }
  }
  const result = visit(value, '$')
  if (result === omitted) throw error('ARC_IPC_JSON', `${label} is not JSON`)
  return result
}

async function requireDirectory(value, label) {
  const path = absolute(value, label)
  const canonical = await realpath(path)
  const info = await stat(canonical)
  if (!info.isDirectory()) throw error('ARC_WORKER_CONFIG', `${label} is not a directory`)
  return canonical
}

function normalizedRoute(value) {
  if (!isRecord(value)) throw error('ARC_WORKER_CONFIG', 'route must be an object')
  const output = value.maxOutputTokens ?? value.maxTokens
  if (value.provider !== FIXED_ROUTE.provider
    || value.model !== FIXED_ROUTE.model
    || value.reasoningEffort !== FIXED_ROUTE.reasoningEffort
    || output !== FIXED_ROUTE.maxTokens
    || (value.maxOutputTokens !== undefined && value.maxTokens !== undefined && value.maxOutputTokens !== value.maxTokens)) {
    throw error('ARC_ROUTE_CHANGED', 'worker accepts only openai-codex/gpt-6.1-sol/high/16384')
  }
  return { ...FIXED_ROUTE }
}

function normalizedAutonomous(value, fixed, detail) {
  const hasGateMaxRetries = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'gateMaxRetries')
  const gateMaxRetries = hasGateMaxRetries ? value.gateMaxRetries : undefined
  const expectsGateMaxRetries = Object.prototype.hasOwnProperty.call(fixed, 'gateMaxRetries')
  const hasMaxContinuations = isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'maxContinuations')
  const maxContinuations = hasMaxContinuations ? value.maxContinuations : undefined
  const expectsMaxContinuations = Object.prototype.hasOwnProperty.call(fixed, 'maxContinuations')
  if (!isRecord(value)
    || value.maxTurns !== fixed.maxTurns
    || value.maxTokens !== fixed.maxTokens
    || typeof value.gate !== 'string'
    || value.gate.trim().length === 0
    || (expectsGateMaxRetries ? gateMaxRetries !== fixed.gateMaxRetries : hasGateMaxRetries)
    || (expectsMaxContinuations ? maxContinuations !== fixed.maxContinuations : hasMaxContinuations)) {
    throw error('ARC_AUTONOMOUS_CHANGED', detail)
  }
  return {
    maxTurns: value.maxTurns,
    maxTokens: value.maxTokens,
    gate: value.gate,
    ...(expectsGateMaxRetries ? { gateMaxRetries: fixed.gateMaxRetries } : {}),
    ...(expectsMaxContinuations ? { maxContinuations: fixed.maxContinuations } : {}),
  }
}

async function normalizeConfig(message) {
  if (!isRecord(message) || message.type !== 'start') throw error('ARC_WORKER_CONFIG', 'first IPC message must be start')
  const original = exactJson(message, 'start config')
  const protocol = message.protocol === undefined ? ARC_PROTOCOL : message.protocol
  const recursionAblation = protocol === RECURSION_ABLATION_PROTOCOL
  const qualityPilot = protocol === QUALITY_PILOT_PROTOCOL
  const qualityRecovery = protocol === QUALITY_RECOVERY_PROTOCOL
  const qualityControl = protocol === QUALITY_CONTROL_PROTOCOL
  const qualityGateControl = protocol === QUALITY_GATE_CONTROL_PROTOCOL
  if (protocol !== ARC_PROTOCOL && !recursionAblation && !qualityPilot && !qualityRecovery && !qualityControl && !qualityGateControl) throw error('ARC_WORKER_CONFIG', 'protocol must be arc-pilot-v1, recursion-ablation-v1, quality-pilot-v1, quality-recovery-v1, quality-control-v1, or quality-gate-control-v1')
  if (recursionAblation) {
    if (message.arm !== 'S0' && message.arm !== 'S') throw error('ARC_WORKER_CONFIG', 'recursion ablation arm must be S0 or S')
  } else if (qualityRecovery) {
    if (message.arm !== 'S') throw error('ARC_WORKER_CONFIG', 'quality recovery arm must be S')
  } else if (qualityControl || qualityGateControl) {
    if (!['R', 'S', 'S0'].includes(message.arm)) throw error('ARC_WORKER_CONFIG', 'quality control arm must be R, S, or S0')
  } else if (message.arm !== 'R' && message.arm !== 'S') {
    throw error('ARC_WORKER_CONFIG', 'arm must be R or S')
  }
  if (typeof message.task !== 'string' || message.task.length === 0) throw error('ARC_WORKER_CONFIG', 'task must be the non-empty parent-supplied author prompt')
  if (!isRecord(message.modelInfo)) throw error('ARC_WORKER_CONFIG', 'modelInfo must be parent-supplied metadata')
  const requestLimit = recursionAblation
    ? RECURSION_ABLATION_REQUEST_LIMIT
    : qualityPilot ? QUALITY_PILOT_REQUEST_LIMIT
      : qualityRecovery ? QUALITY_RECOVERY_REQUEST_LIMIT
        : qualityControl ? QUALITY_CONTROL_REQUEST_LIMIT
          : qualityGateControl ? QUALITY_GATE_CONTROL_REQUEST_LIMIT : FIXED_REQUEST_LIMIT
  const wallTimeMs = recursionAblation
    ? RECURSION_ABLATION_WALL_TIME_MS
    : qualityPilot ? QUALITY_PILOT_WALL_TIME_MS
      : qualityRecovery ? QUALITY_RECOVERY_WALL_TIME_MS
        : qualityControl ? QUALITY_CONTROL_WALL_TIME_MS
          : qualityGateControl ? QUALITY_GATE_CONTROL_WALL_TIME_MS : FIXED_WALL_TIME_MS
  const autonomous = recursionAblation
    ? RECURSION_ABLATION_AUTONOMOUS
    : qualityPilot ? QUALITY_PILOT_AUTONOMOUS
      : qualityRecovery ? QUALITY_RECOVERY_AUTONOMOUS
        : qualityControl ? QUALITY_CONTROL_AUTONOMOUS
          : qualityGateControl ? QUALITY_GATE_CONTROL_AUTONOMOUS : FIXED_AUTONOMOUS
  if (message.requestLimit !== requestLimit) throw error('ARC_REQUEST_LIMIT_CHANGED', `expected ${String(requestLimit)}`)
  if (message.wallTimeMs !== wallTimeMs) throw error('ARC_WALL_TIME_CHANGED', `expected ${String(wallTimeMs)}`)
  if (!Number.isSafeInteger(message.bridgePort) || message.bridgePort < 1 || message.bridgePort > 65_535) {
    throw error('ARC_WORKER_CONFIG', 'bridgePort must be a valid TCP port')
  }

  const directory = await requireDirectory(message.directory, 'directory')
  const workspace = await requireDirectory(join(directory, 'workspace'), 'directory/workspace')
  const home = await requireDirectory(join(directory, 'home'), 'directory/home')
  const tmp = await requireDirectory(join(directory, 'tmp'), 'directory/tmp')
  const data = await requireDirectory(join(directory, 'data'), 'directory/data')
  const shared = await requireDirectory(message.shared, 'shared')
  const compiled = await requireDirectory(message.compiled, 'compiled')
  const packageRoot = await requireDirectory(message.packageRoot, 'packageRoot')
  const brokerOptional = recursionAblation || qualityPilot || qualityRecovery || qualityControl || qualityGateControl
  const brokerSocket = message.brokerSocket === undefined && brokerOptional ? undefined : absolute(message.brokerSocket, 'brokerSocket')
  const brokerState = message.brokerState === undefined && brokerOptional ? undefined : absolute(message.brokerState, 'brokerState')
  if ((brokerSocket !== undefined && !inside(directory, brokerSocket)) || (brokerState !== undefined && !inside(directory, brokerState))) {
    throw error('ARC_WORKER_CONFIG', 'broker socket and state must remain inside this run directory')
  }
  if (inside(directory, shared)) throw error('ARC_WORKER_CONFIG', 'shared may not be inside the writable run directory')
  if (!inside(shared, compiled)) throw error('ARC_WORKER_CONFIG', 'compiled must be under shared')
  if (!Array.isArray(message.dependencyReadRoots)) throw error('ARC_WORKER_CONFIG', 'dependencyReadRoots must be an array')
  const dependencyReadRoots = message.dependencyReadRoots.map((value, index) => absolute(value, `dependencyReadRoots[${String(index)}]`))
  if (!dependencyReadRoots.some(root => inside(root, packageRoot))) {
    throw error('ARC_WORKER_CONFIG', 'packageRoot must be covered by dependencyReadRoots')
  }

  return {
    original,
    protocol,
    arm: message.arm,
    nativeDepth: recursionAblation ? (message.arm === 'S0' ? 0 : 1) : qualityPilot || qualityRecovery ? 1 : qualityControl || qualityGateControl ? (message.arm === 'S0' ? 0 : 1) : 0,
    label: recursionAblation
      ? 'Recursion ablation text task'
      : qualityPilot ? 'Quality pilot text task'
        : qualityRecovery ? 'Quality recovery text task'
          : qualityControl ? 'Quality control text task'
            : qualityGateControl ? 'Quality gate-control text task' : 'ARC fixed author task',
    directory,
    workspace,
    home,
    tmp,
    data,
    shared,
    compiled,
    packageRoot,
    task: message.task,
    route: normalizedRoute(message.route),
    modelInfo: exactJson(message.modelInfo, 'modelInfo'),
    requestLimit: message.requestLimit,
    wallTimeMs: message.wallTimeMs,
    autonomous: normalizedAutonomous(message.autonomous, autonomous, recursionAblation
      ? 'worker accepts only the frozen 14-turn/4000000-token recursion-ablation autonomous configuration'
      : qualityPilot
        ? 'worker accepts only the frozen 32-turn/4000000-token quality-pilot autonomous configuration'
        : qualityRecovery
          ? 'worker accepts only the frozen 11-turn/4000000-token quality-recovery autonomous configuration'
          : qualityControl
            ? 'worker accepts only the frozen 32-turn/4000000-token quality-control autonomous configuration'
            : qualityGateControl
              ? 'worker accepts only the frozen 32-turn/4000000-token quality-gate-control autonomous configuration with gateMaxRetries=32 and maxContinuations=32'
        : 'worker accepts only the frozen 32-turn/4000000-token autonomous configuration'),
    brokerSocket,
    brokerState,
    bridgePort: message.bridgePort,
    dependencyReadRoots,
  }
}

async function writeExclusiveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
}

class DurableJournal {
  constructor(path) {
    this.path = path
    this.tail = Promise.resolve()
  }

  append(type, value) {
    const row = exactJson({ formatVersion: 1, time: new Date().toISOString(), type, value }, `journal ${type}`)
    const append = async () => {
      const handle = await open(this.path, 'a', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(row)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    const next = this.tail.catch(() => undefined).then(append)
    this.tail = next
    return next
  }

  async settle() {
    await this.tail
  }
}

function replaceEnvironment(values) {
  const before = new Map()
  for (const [key, value] of Object.entries(values)) {
    before.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function isolatedEnvironment(config, runtime = undefined, extras = {}) {
  const env = {
    PATH: '/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: config.home,
    USER: 'arc-native-worker',
    LOGNAME: 'arc-native-worker',
    TMPDIR: config.tmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PI_OFFLINE: '1',
    UV_OFFLINE: '1',
    PYTHONNOUSERSITE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_TELEMETRY_DISABLED: '1',
    ...runtime === undefined ? {} : {
      PI_PACKAGE_DIR: runtime.packageDir,
      PRIME_AGENT_KERNEL_PYTHON: runtime.python,
    },
    ...extras,
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined))
}

function ensureActive(controller, label) {
  if (controller.signal.aborted) throw error('ARC_STOPPED', `${label}: ${String(controller.signal.reason ?? 'parent stop')}`)
}

function cloneOptionsWithoutSignal(options) {
  if (!isRecord(options)) throw error('ARC_MODEL_OPTIONS', 'DSH options must be an object')
  const { signal: _signal, ...serializable } = options
  return exactJson(serializable, 'DSH options')
}

class PendingModel {
  constructor(id) {
    this.id = id
    this.queue = []
    this.closed = false
    this.failure = undefined
    this.waiter = undefined
  }

  push(chunk) {
    if (this.closed || this.failure !== undefined) return
    this.queue.push(chunk)
    this.wake()
  }

  end() {
    if (this.closed || this.failure !== undefined) return
    this.closed = true
    this.wake()
  }

  fail(reason) {
    if (this.failure !== undefined || this.closed) return
    this.failure = reason instanceof Error ? reason : new Error(String(reason))
    this.wake()
  }

  wake() {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.()
  }

  async next() {
    while (this.queue.length === 0 && !this.closed && this.failure === undefined) {
      await new Promise(resolveWait => { this.waiter = resolveWait })
    }
    if (this.failure !== undefined) throw this.failure
    if (this.queue.length > 0) return { done: false, value: this.queue.shift() }
    return { done: true, value: undefined }
  }
}

class ParentModelTransport {
  constructor({ journal, requestLimit, controller }) {
    this.journal = journal
    this.requestLimit = requestLimit
    this.controller = controller
    this.pending = new Map()
    this.requestCount = 0
    this.stopped = undefined
  }

  handle(message) {
    if (!isRecord(message) || typeof message.id !== 'string') return false
    const pending = this.pending.get(message.id)
    if (!pending) return false
    if (message.type === 'chunk') pending.push(message.chunk)
    else if (message.type === 'end') pending.end()
    else if (message.type === 'error') pending.fail(error('ARC_PARENT_MODEL_ERROR', typeof message.error === 'string' ? message.error : JSON.stringify(message.error)))
    else return false
    return true
  }

  stop(reason) {
    this.stopped = reason ?? 'parent stop'
    for (const [id, pending] of this.pending) {
      this.sendAbort(id, this.stopped)
      pending.fail(error('ARC_STOPPED', this.stopped))
    }
  }

  sendAbort(id, reason) {
    if (typeof process.send === 'function' && process.connected) process.send({ type: 'abort', id, reason: String(reason) })
  }

  async *stream(options, signal) {
    ensureActive(this.controller, 'model dispatch')
    if (this.stopped !== undefined) throw error('ARC_STOPPED', this.stopped)
    if (this.requestCount >= this.requestLimit) throw error('ARC_REQUEST_LIMIT', `worker-local limit ${String(this.requestLimit)} reached`)
    if (typeof process.send !== 'function' || !process.connected) throw error('ARC_IPC_UNAVAILABLE', 'worker has no connected parent IPC channel')
    const id = randomUUID()
    const serializable = cloneOptionsWithoutSignal(options)
    const pending = new PendingModel(id)
    this.pending.set(id, pending)
    this.requestCount += 1
    await this.journal.append('model-ipc-intent', { id, ordinal: this.requestCount, options: serializable })
    let aborted = false
    const abort = () => {
      aborted = true
      this.sendAbort(id, signal?.reason ?? this.controller.signal.reason ?? 'worker abort')
      pending.fail(error('ARC_MODEL_ABORTED', String(signal?.reason ?? this.controller.signal.reason ?? 'aborted')))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const parentAbort = () => abort()
    this.controller.signal.addEventListener('abort', parentAbort, { once: true })
    try {
      process.send({ type: 'model', id, options: serializable })
      while (true) {
        const value = await pending.next()
        if (value.done) return
        yield value.value
      }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.controller.signal.removeEventListener('abort', parentAbort)
      this.pending.delete(id)
      if (!aborted && (signal?.aborted || this.controller.signal.aborted)) this.sendAbort(id, signal?.reason ?? this.controller.signal.reason ?? 'aborted')
    }
  }
}

function inlineAttachment(data, mediaType) {
  if (!Buffer.isBuffer(data)) throw error('ARC_IMAGE_SERIALIZATION', 'image data must be a Buffer')
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mediaType)) throw error('ARC_IMAGE_SERIALIZATION', `unsupported image media type ${String(mediaType)}`)
  if (data.length === 0 || data.length > MAX_INLINE_IMAGE_BYTES) throw error('ARC_IMAGE_LIMIT', `image is ${String(data.length)} bytes`)
  return {
    kind: 'ipc-inline-image-v1',
    mediaType,
    dataBase64: data.toString('base64'),
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
  }
}

function inlineImage(data, mediaType) {
  return { type: 'image', attachment: inlineAttachment(data, mediaType) }
}

function imageResolverWithBudget() {
  let total = 0
  return async url => {
    if (typeof url !== 'string') throw error('ARC_IMAGE_UNSUPPORTED', 'image URL must be a string')
    const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
    if (!match || match[2].length % 4 !== 0) throw error('ARC_IMAGE_UNSUPPORTED', 'only canonical inline png/jpeg/gif/webp data URLs are accepted')
    const data = Buffer.from(match[2], 'base64')
    if (data.toString('base64') !== match[2]) throw error('ARC_IMAGE_UNSUPPORTED', 'image base64 is not canonical')
    total += data.length
    if (total > MAX_INLINE_IMAGES_PER_REQUEST) throw error('ARC_IMAGE_LIMIT', 'combined inline images exceed request limit')
    return inlineImage(data, match[1])
  }
}

function assertFixedCallRoute(config) {
  const route = object(config)
  if (route.provider !== FIXED_ROUTE.provider || route.model !== FIXED_ROUTE.model
    || route.reasoningEffort !== FIXED_ROUTE.reasoningEffort
    || route.maxTokens !== FIXED_ROUTE.maxTokens) {
    throw error('ARC_ROUTE_CHANGED', 'native bridge attempted to change fixed model route')
  }
}

function createRemoteLlm({ transport, modelInfo, controller, beforeDispatch }) {
  return {
    async resolveModelInfo(provider, model) {
      if (provider !== FIXED_ROUTE.provider || model !== FIXED_ROUTE.model) throw error('ARC_ROUTE_CHANGED', 'RlmHost requested a different model')
      return modelInfo
    },
    async prepareCall(config, signal) {
      assertFixedCallRoute(config)
      return {
        config: { ...FIXED_ROUTE },
        stream: async function* stream(actual) {
          ensureActive(controller, 'RlmHost stream')
          await beforeDispatch(actual.signal ?? signal)
          for await (const chunk of transport.stream(actual, actual.signal ?? signal)) yield chunk
        },
      }
    },
  }
}

function daemonCommand(socketPath, command, timeoutMs, signal) {
  return new Promise((resolveCommand, rejectCommand) => {
    const socket = createConnection({ path: socketPath })
    const id = randomUUID()
    let buffer = ''
    let sent = false
    let settled = false
    const done = (failure, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (failure) rejectCommand(failure)
      else resolveCommand(value)
    }
    const onAbort = () => done(error('ARC_STOPPED', String(signal?.reason ?? 'depth command aborted')))
    const timer = setTimeout(() => done(error('ARC_DEPTH_TIMEOUT', 'native daemon did not answer')), timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('error', failure => done(failure))
    socket.on('close', () => { if (!settled) done(error('ARC_DEPTH_CLOSED', 'native daemon socket closed')) })
    socket.on('data', bytes => {
      buffer += bytes.toString('utf8')
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) return done(error('ARC_DEPTH_FRAME_LIMIT', 'native daemon response exceeded 4 MiB'))
      let offset
      while ((offset = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, offset)
        buffer = buffer.slice(offset + 1)
        let message
        try { message = JSON.parse(line) } catch { return done(error('ARC_DEPTH_INVALID_JSON', 'native daemon sent invalid JSON')) }
        if (!sent && message.type === 'daemon_hello') {
          const protocol = message.protocol
          if (protocol?.name !== 'prime-agent.daemon' || protocol.version !== 7) {
            return done(error('ARC_DEPTH_PROTOCOL', 'unexpected native daemon protocol'))
          }
          sent = true
          socket.write(`${JSON.stringify({ type: 'command', id, protocol, clientId: `arc-native-worker:${randomUUID()}`, command: { ...command, id } })}\n`)
        } else if (sent && message.type === 'response' && message.id === id) {
          if (message.success !== true) return done(error('ARC_DEPTH_COMMAND', JSON.stringify(message.error ?? message)))
          return done(undefined, message)
        }
      }
    })
  })
}

async function getDepth(socketPath, activeSessionId, expectedDepth, signal) {
  if (typeof activeSessionId !== 'string' || activeSessionId.length === 0) throw error('ARC_DEPTH_SESSION', 'native root session id is missing')
  if (!Number.isSafeInteger(expectedDepth) || expectedDepth < 0) throw error('ARC_DEPTH_EXPECTED', 'expected native depth must be a non-negative safe integer')
  const get = await daemonCommand(socketPath, { type: 'get_rlm_max_depth_status', activeSessionId }, 15_000, signal)
  const actualDepth = get?.data?.maxDepth
  if (actualDepth !== expectedDepth) throw error('ARC_DEPTH_READBACK', JSON.stringify(get?.data ?? null))
  return { get, actualDepth }
}

async function importCompiled(compiled, file) {
  const target = join(compiled, file)
  const info = await stat(target)
  if (!info.isFile()) throw error('ARC_COMPILED_MODULE', `missing ${file}`)
  return import(pathToFileURL(target).href)
}

function wait(milliseconds, signal) {
  return new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(resolveWait, milliseconds)
    timer.unref?.()
    if (!signal) return
    const abort = () => { clearTimeout(timer); rejectWait(error('ARC_STOPPED', String(signal.reason ?? 'stopped'))) }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function waitForHost(host, runId, ownerSessionId, controller) {
  let latest
  while (true) {
    ensureActive(controller, 'RlmHost settlement')
    latest = await host.inspect(runId, ownerSessionId)
    if (['idle', 'failed', 'indeterminate', 'cancelled'].includes(latest.state)) return latest
    await wait(75, controller.signal)
  }
}

function withFixedBridgePort(port, start) {
  const original = NetServer.prototype.listen
  let replaced = false
  NetServer.prototype.listen = function guardedListen(...args) {
    if (!replaced && args[0] === 0 && args[1] === '127.0.0.1') {
      replaced = true
      return original.call(this, port, '127.0.0.1')
    }
    return original.apply(this, args)
  }
  return Promise.resolve()
    .then(start)
    .finally(() => { NetServer.prototype.listen = original })
    .then(value => {
      if (!replaced) throw error('ARC_BRIDGE_PORT_UNFIXED', 'RlmHost did not bind its bridge through the guarded fixed port')
      return value
    })
}

function classifyFailure(failure, controller) {
  if (controller.signal.aborted) return 'cancelled'
  const text = errorText(failure)
  if (/RLM_EFFECT_INDETERMINATE|UNKNOWN|INDETERMINATE|CLEANUP/.test(text)) return 'indeterminate'
  return 'failed'
}

function defaultNativeDepth(protocol, arm) {
  if (protocol === QUALITY_PILOT_PROTOCOL && (arm === 'R' || arm === 'S')) return 1
  if (protocol === QUALITY_RECOVERY_PROTOCOL && arm === 'S') return 1
  if (protocol === QUALITY_CONTROL_PROTOCOL || protocol === QUALITY_GATE_CONTROL_PROTOCOL) return arm === 'S0' ? 0 : (arm === 'R' || arm === 'S' ? 1 : 0)
  return protocol === RECURSION_ABLATION_PROTOCOL && arm === 'S' ? 1 : 0
}

async function closeServer(server) {
  if (!server) return { ok: false, reason: 'bridge was not created' }
  try {
    server.closeAllConnections?.()
    if (server.listening) await new Promise((resolveClose, rejectClose) => server.close(errorValue => errorValue ? rejectClose(errorValue) : resolveClose()))
    return { ok: !server.listening }
  } catch (failure) {
    return { ok: false, error: recordError(failure) }
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true
  return new Promise(resolveExit => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs)
    timer.unref?.()
    child.once('exit', () => { clearTimeout(timer); resolveExit(true) })
  })
}

async function stopOwnedFrontend(child) {
  if (!child) return { ok: false, reason: 'ACP frontend was not created' }
  if (await waitForExit(child, 1_000)) return { ok: true, exitCode: child.exitCode, signalCode: child.signalCode }
  try { child.kill('SIGTERM') } catch { /* This is only the handle spawned by this worker. */ }
  if (await waitForExit(child, 1_500)) return { ok: true, exitCode: child.exitCode, signalCode: child.signalCode }
  try { child.kill('SIGKILL') } catch { /* This is only the handle spawned by this worker. */ }
  const exited = await waitForExit(child, 1_500)
  return { ok: exited, exitCode: child.exitCode, signalCode: child.signalCode, ...(exited ? {} : { reason: 'owned ACP frontend exit was not confirmed' }) }
}

async function runShutdown(binary, env, cwd) {
  try {
    const result = await execFile(binary, ['shutdown', '--force', '--json'], { cwd, env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
    let receipt
    try { receipt = JSON.parse(result.stdout) } catch { return { ok: false, stdout: result.stdout, stderr: result.stderr, reason: 'shutdown stdout was not JSON' } }
    return {
      ok: Array.isArray(receipt.stopped) && Array.isArray(receipt.failed) && receipt.failed.length === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      receipt,
    }
  } catch (failure) {
    return {
      ok: false,
      error: recordError(failure),
      stdout: typeof failure?.stdout === 'string' ? failure.stdout : undefined,
      stderr: typeof failure?.stderr === 'string' ? failure.stderr : undefined,
    }
  }
}

function directLaunchArguments(config, socket) {
  const args = [
    '--mode', 'acp',
    '--offline',
    '--provider', 'solar-dsh',
    '--model', 'selected',
    '--cwd', config.workspace,
    '--daemon-socket', socket,
    '--thinking', 'high',
    '--autonomous',
    '--autonomous-max-turns', String(config.autonomous.maxTurns),
    '--autonomous-max-tokens', String(config.autonomous.maxTokens),
    '--autonomous-timeout-ms', String(config.wallTimeMs),
    '--autonomous-gate', config.autonomous.gate,
  ]
  if (Object.prototype.hasOwnProperty.call(config.autonomous, 'gateMaxRetries')) {
    args.push('--autonomous-gate-retries', String(config.autonomous.gateMaxRetries))
  }
  if (Object.prototype.hasOwnProperty.call(config.autonomous, 'maxContinuations')) {
    args.push('--autonomous-max-continuations', String(config.autonomous.maxContinuations))
  }
  return args
}

async function readRequestBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    const value = Buffer.from(chunk)
    bytes += value.length
    if (bytes > MAX_HTTP_REQUEST_BYTES) throw error('ARC_BRIDGE_REQUEST_LIMIT', 'Prime bridge request exceeds 32 MiB')
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function startDirectBridge({ config, transport, controller, journal, replay, getNativeSession }) {
  const { decodeChatRequest, encodeChatStream } = await importCompiled(config.compiled, 'model-wire.mjs')
  let ordinal = 0
  const token = `ARC_LOCAL_${randomUUID()}`
  const server = createServer((request, response) => {
    void (async () => {
      try {
        ensureActive(controller, 'bridge request')
        const peer = request.socket.remoteAddress
        if (peer !== '127.0.0.1' && peer !== '::ffff:127.0.0.1') {
          response.writeHead(403); response.end(); return
        }
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
          || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(403); response.end(); return
        }
        const body = JSON.parse(await readRequestBody(request))
        if (!isRecord(body) || body.model !== 'selected' || body.stream !== true) throw error('ARC_BRIDGE_ROUTE', 'Prime did not use the fixed local OpenAI wire route')
        if (ordinal >= config.requestLimit) throw error('ARC_REQUEST_LIMIT', 'bridge local request limit reached')
        const disconnect = new AbortController()
        response.on('close', () => { if (!response.writableEnded) disconnect.abort(error('ARC_BRIDGE_DISCONNECT', 'Prime disconnected')) })
        const signal = AbortSignal.any([controller.signal, disconnect.signal])
        const dshRequest = await decodeChatRequest(body, config.route, {
          signal,
          sessionId: getNativeSession().activeSessionId,
          replayFor: message => replay.forMessage(message),
          resolveImage: imageResolverWithBudget(),
        })
        assertFixedCallRoute(dshRequest)
        const depth = await getDepth(getNativeSession().socket, getNativeSession().activeSessionId, config.nativeDepth, signal)
        ordinal += 1
        const serializable = cloneOptionsWithoutSignal(dshRequest)
        await journal.append('r-model-intent', { ordinal, primeRequest: body, dshRequest: serializable, depth })
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
        let settlement
        async function* recorded() {
          for await (const chunk of transport.stream(dshRequest, signal)) {
            await journal.append('r-model-chunk', { ordinal, chunk })
            yield chunk
          }
        }
        for await (const data of encodeChatStream(recorded(), {
          id: randomUUID(),
          model: 'selected',
          onFinish: value => {
            settlement = value
            if (value?.replayState !== undefined) replay.record(value.message, value.replayState)
          },
        })) {
          if (!response.write(data)) await once(response, 'drain')
        }
        await journal.append('r-model-settlement', { ordinal, value: settlement ?? null })
        response.end()
      } catch (failure) {
        await journal.append('r-model-error', { error: recordError(failure) }).catch(() => undefined)
        if (response.headersSent) response.destroy(failure instanceof Error ? failure : new Error(String(failure)))
        else {
          response.writeHead(400, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { type: 'arc_native_bridge', message: errorText(failure) } }))
        }
      }
    })()
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(config.bridgePort, '127.0.0.1', resolveListen)
  }).catch(failure => { throw error('ARC_BRIDGE_PORT_COMPETED', errorText(failure)) })
  return { server, token, baseUrl: `http://127.0.0.1:${String(config.bridgePort)}/v1` }
}

async function runOriginal(config, { journal, transport, controller }) {
  const cleanup = { acpCancel: undefined, acpClose: undefined, acpDispose: undefined, shutdown: undefined, frontendExited: undefined, bridgeClosed: undefined }
  const evidence = { kind: 'original-prime-acp', rawJournal: join(config.data, 'r-acp.jsonl') }
  let runtime
  let child
  let client
  let bridge
  let sessionId
  let rootSession
  let answer = ''
  let promptResult
  let failure
  let state = 'failed'
  let nativeStopReason
  let actualDepth = null
  let journalTail = Promise.resolve()
  try {
    const [{ loadRuntime }, { AcpClient }, { ReplayRegistry }, { PrimeEvidence }] = await Promise.all([
      importCompiled(config.compiled, 'runtime.mjs'),
      importCompiled(config.compiled, 'acp-client.mjs'),
      importCompiled(config.compiled, 'replay.mjs'),
      importCompiled(config.compiled, 'prime-evidence.mjs'),
    ])
    runtime = await loadRuntime(config.packageRoot, config.data)
    const agentDir = join(config.data, 'r-prime-state')
    const sessionDir = join(agentDir, 'sessions')
    const socket = join(config.data, 'r-daemon.sock')
    if (Buffer.byteLength(socket) >= 100) throw error('ARC_SOCKET_PATH', 'R daemon socket path is too long')
    await mkdir(sessionDir, { recursive: true, mode: 0o700 })
    await Promise.all([
      writeFile(join(agentDir, '.arc-worker-marker'), 'owned by native-worker\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(failureValue => { if (failureValue?.code !== 'EEXIST') throw failureValue }),
      writeFile(join(agentDir, 'settings.json'), JSON.stringify({ factory: { enabled: false }, harnessRefinements: false, rlmMaxDepth: config.nativeDepth }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
      writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'solar-dsh': { baseUrl: `http://127.0.0.1:${String(config.bridgePort)}/v1`, apiKey: 'pending', api: 'openai-completions', authHeader: true, models: [{ id: 'selected', name: config.modelInfo.name, contextWindow: config.modelInfo?.context?.contextWindow, maxTokens: FIXED_ROUTE.maxTokens, reasoning: true, input: config.modelInfo?.inputModalities?.includes?.('image') ? ['text', 'image'] : ['text'] }] } } }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
      writeFile(join(agentDir, 'environment.json'), JSON.stringify({ brokerSocket: config.brokerSocket, brokerState: config.brokerState }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' }),
    ])
    // The directory hierarchy is parent-created. The marker makes accidental
    // reuse visible without allowing this worker to touch another run.
    await stat(agentDir)
    const env = isolatedEnvironment(config, runtime, {
      PRIME_AGENT_CODING_AGENT_DIR: agentDir,
      PRIME_AGENT_SESSION_DIR: sessionDir,
      PRIME_AGENT_DAEMON_SOCKET: socket,
    })
    const replay = new ReplayRegistry()
    const primeEvidence = new PrimeEvidence()
    let updateFailure
    bridge = await startDirectBridge({
      config,
      transport,
      controller,
      journal,
      replay,
      getNativeSession: () => {
        if (!rootSession) throw error('ARC_NATIVE_SESSION', 'bridge received a model request before root session confirmation')
        return rootSession
      },
    })
    // Replace the placeholder after the fixed bridge has successfully bound.
    await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'solar-dsh': { baseUrl: bridge.baseUrl, apiKey: bridge.token, api: 'openai-completions', authHeader: true, models: [{ id: 'selected', name: config.modelInfo.name, contextWindow: config.modelInfo?.context?.contextWindow, maxTokens: FIXED_ROUTE.maxTokens, reasoning: true, input: config.modelInfo?.inputModalities?.includes?.('image') ? ['text', 'image'] : ['text'] }] } } }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'w' })
    const args = directLaunchArguments(config, socket)
    await journal.append('r-native-launch', { runtimeFingerprint: runtime.fingerprint, args, nativeSettings: { factoryEnabled: false, harnessRefinements: false, rlmMaxDepth: config.nativeDepth }, route: config.route })
    child = spawn(runtime.binary, args, { cwd: config.workspace, env, stdio: ['pipe', 'pipe', 'pipe'] })
    client = new AcpClient(child, {
      maxFrameBytes: 16 * 1024 * 1024,
      record: (direction, value) => {
        journalTail = journalTail.then(() => journal.append('r-acp', { direction, value }))
        return journalTail
      },
      onUpdate: value => {
        try {
          const params = object(value)
          const update = object(params.update)
          const meta = object(object(params._meta)[PRIME_META] ?? object(update._meta)[PRIME_META])
          primeEvidence.observe(meta)
          if (update.sessionUpdate === 'agent_message_chunk') {
            const content = object(update.content)
            if (content.type === 'text' && typeof content.text === 'string') answer = (answer + content.text).slice(-32_000)
          }
        } catch (reason) {
          updateFailure ??= reason
          controller.abort(reason)
        }
      },
    })
    const initialized = await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'ARC native worker', version: '1' }, clientCapabilities: {} }, { timeoutMs: 30_000, signal: controller.signal })
    await journal.append('r-acp-initialized', initialized)
    const created = object(await client.request('session/new', { cwd: config.workspace, mcpServers: [] }, { timeoutMs: 30_000, signal: controller.signal }))
    if (typeof created.sessionId !== 'string') throw error('ARC_ACP_SESSION', 'Prime did not return sessionId')
    sessionId = created.sessionId
    const listed = JSON.parse((await execFile(runtime.binary, ['list', '--json', '--socket', socket], { cwd: config.workspace, env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 })).stdout)
    const sessions = Array.isArray(listed?.sessions) ? listed.sessions : []
    const root = sessions.find(row => isRecord(row) && !row.parentSessionId && row.cwd === config.workspace && typeof row.activeSessionId === 'string' && typeof row.sessionFile === 'string')
    if (!root) throw error('ARC_NATIVE_SESSION', 'native list --json did not expose the root session')
    rootSession = { activeSessionId: root.activeSessionId, sessionFile: root.sessionFile, socket }
    await journal.append('r-native-root-session', { listed, root: rootSession })
    const initialDepth = await getDepth(socket, rootSession.activeSessionId, config.nativeDepth, controller.signal)
    actualDepth = initialDepth.actualDepth
    await journal.append('r-native-depth-before-prompt', { native: rootSession, expectedDepth: config.nativeDepth, actualDepth, depth: initialDepth })
    primeEvidence.beginTurn()
    promptResult = object(await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: config.task }] }, { timeoutMs: config.wallTimeMs, signal: controller.signal }))
    if (updateFailure) throw updateFailure
    primeEvidence.assertSettled(promptResult.stopReason)
    nativeStopReason = promptResult.stopReason
    state = 'completed'
    await journal.append('r-native-settled', { promptResult, answer })
  } catch (reason) {
    failure = reason
    state = classifyFailure(reason, controller)
    nativeStopReason = errorText(reason)
    await journal.append('r-native-fault', { state, error: recordError(reason) }).catch(() => undefined)
  } finally {
    const env = runtime && rootSession
      ? isolatedEnvironment(config, runtime, { PRIME_AGENT_CODING_AGENT_DIR: join(config.data, 'r-prime-state'), PRIME_AGENT_SESSION_DIR: join(config.data, 'r-prime-state', 'sessions'), PRIME_AGENT_DAEMON_SOCKET: rootSession.socket })
      : runtime
        ? isolatedEnvironment(config, runtime, { PRIME_AGENT_CODING_AGENT_DIR: join(config.data, 'r-prime-state'), PRIME_AGENT_SESSION_DIR: join(config.data, 'r-prime-state', 'sessions'), PRIME_AGENT_DAEMON_SOCKET: join(config.data, 'r-daemon.sock') })
        : undefined
    if (client && sessionId) {
      try { await client.notify('session/cancel', { sessionId }); cleanup.acpCancel = { ok: true } }
      catch (reason) { cleanup.acpCancel = { ok: false, error: recordError(reason) } }
      try { await client.request('session/close', { sessionId }, { timeoutMs: 15_000 }); cleanup.acpClose = { ok: true } }
      catch (reason) { cleanup.acpClose = { ok: false, error: recordError(reason) } }
    } else cleanup.acpCancel = cleanup.acpClose = { ok: false, reason: 'ACP session was not created' }
    if (client) {
      try { await client.dispose(); cleanup.acpDispose = { ok: true } }
      catch (reason) { cleanup.acpDispose = { ok: false, error: recordError(reason) } }
    } else cleanup.acpDispose = { ok: false, reason: 'ACP client was not created' }
    try { await journalTail } catch (reason) { cleanup.acpJournal = { ok: false, error: recordError(reason) } }
    if (runtime && env) {
      cleanup.shutdown = await runShutdown(runtime.binary, env, config.workspace)
      await journal.append('r-native-shutdown', cleanup.shutdown).catch(() => undefined)
    } else cleanup.shutdown = { ok: false, reason: 'runtime was not available' }
    cleanup.frontendExited = await stopOwnedFrontend(child)
    cleanup.bridgeClosed = await closeServer(bridge?.server)
  }
  const physicalCleanup = cleanup.shutdown?.ok === true && cleanup.frontendExited?.ok === true && cleanup.bridgeClosed?.ok === true
  return {
    type: 'result',
    arm: config.arm,
    protocol: config.protocol,
    nativeDepth: config.nativeDepth,
    actualDepth,
    state,
    answer,
    requests: transport.requestCount,
    nativeRunId: rootSession?.activeSessionId ?? null,
    nativeStopReason: nativeStopReason ?? null,
    physicalCleanup,
    cleanup,
    raw: { ...evidence, promptResult: promptResult ?? null, rootSession: rootSession ?? null, nativeDepth: config.nativeDepth, actualDepth },
    ...(failure === undefined ? {} : { fault: recordError(failure) }),
    providerCodec: 'R, S, and S0 use the same parent IPC DSH-provider codec; this is not an independent provider-private protocol control.',
  }
}

async function runSolar(config, { journal, transport, controller }) {
  const cleanup = { cancel: undefined, dispose: undefined, shutdownReceipt: undefined, bridgeClosed: undefined }
  let host
  let runId
  let terminal
  let record
  let failure
  let state = 'failed'
  let actualDepth = null
  let sessionReadyResolve
  let sessionReadyReject
  const sessionReady = new Promise((resolveReady, rejectReady) => { sessionReadyResolve = resolveReady; sessionReadyReject = rejectReady })
  void sessionReady.catch(() => undefined)
  const restoreEnvironment = replaceEnvironment(isolatedEnvironment(config))
  try {
    const { RlmHost } = await importCompiled(config.compiled, 'host.mjs')
    const beforeDispatch = async signal => {
      const native = await sessionReady
      const depth = await getDepth(native.socket, native.activeSessionId, config.nativeDepth, signal ?? controller.signal)
      actualDepth = depth.actualDepth
      await journal.append('s-native-depth-before-dispatch', { native, expectedDepth: config.nativeDepth, actualDepth, depth })
    }
    const llm = createRemoteLlm({ transport, modelInfo: config.modelInfo, controller, beforeDispatch })
    host = new RlmHost({ llm, attachments: { saveImage: async ({ data, mediaType }) => inlineAttachment(data, mediaType) } }, config.data, config.packageRoot, MAX_HTTP_REQUEST_BYTES, { factoryEnabled: false, harnessRefinements: false, rlmMaxDepth: config.nativeDepth })
    const owner = { sessionId: `arc-s-${randomUUID()}`, route: { ...config.route }, signal: controller.signal }
    const started = await withFixedBridgePort(config.bridgePort, () => host.start({
      task: config.task,
      cwd: config.workspace,
      label: config.label,
      inputs: [],
      maxModelRequests: config.requestLimit,
      maxWallTimeMs: config.wallTimeMs,
      autonomous: config.autonomous,
    }, owner))
    runId = started.runId
    record = await host.store.get(runId)
    const runDirectory = host.store.directory(runId)
    const control = JSON.parse(await readFile(join(runDirectory, 'control.json'), 'utf8'))
    if (typeof record.nativeSessionId !== 'string' || typeof control.socket !== 'string') {
      throw error('ARC_NATIVE_SESSION', 'RlmHost store record did not preserve native root identity')
    }
    const native = { activeSessionId: record.nativeSessionId, socket: control.socket }
    sessionReadyResolve(native)
    await journal.append('s-host-started', { started, record, native, nativeSettings: { factoryEnabled: false, harnessRefinements: false, rlmMaxDepth: config.nativeDepth }, route: config.route })
    terminal = await waitForHost(host, runId, owner.sessionId, controller)
    if (terminal.state !== 'idle') throw error(`ARC_S_TERMINAL_${String(terminal.state).toUpperCase()}`, terminal.message ?? 'RlmHost did not reach native idle terminal')
    state = 'completed'
    await journal.append('s-native-settled', { terminal })
  } catch (reason) {
    failure = reason
    state = classifyFailure(reason, controller)
    sessionReadyReject(reason)
    await journal.append('s-native-fault', { state, error: recordError(reason) }).catch(() => undefined)
  } finally {
    if (host && runId) {
      try { cleanup.cancel = await host.cancel(runId) }
      catch (reason) { cleanup.cancel = { ok: false, error: recordError(reason) } }
      try { await host.dispose(); cleanup.dispose = { ok: true } }
      catch (reason) { cleanup.dispose = { ok: false, error: recordError(reason) } }
      try {
        const receiptPath = join(host.store.directory(runId), 'prime-state', 'solar-shutdown-receipt.json')
        cleanup.shutdownReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      } catch (reason) {
        cleanup.shutdownReceipt = { ok: false, error: recordError(reason) }
      }
      cleanup.bridgeClosed = {
        // A failed native turn can be closed before the later cancel() call.
        // The original shutdown receipt and host disposal establish closure.
        ok: cleanup.dispose?.ok === true && cleanup.shutdownReceipt?.stdout !== undefined,
      }
    } else {
      cleanup.cancel = { ok: false, reason: 'RlmHost run was not created' }
      cleanup.dispose = { ok: false, reason: 'RlmHost was not created' }
      cleanup.shutdownReceipt = { ok: false, reason: 'RlmHost run was not created' }
      cleanup.bridgeClosed = { ok: false, reason: 'RlmHost bridge was not created' }
    }
    restoreEnvironment()
  }
  const physicalCleanup = cleanup.dispose?.ok === true
    && cleanup.shutdownReceipt?.stdout !== undefined
    && cleanup.bridgeClosed?.ok === true
  return {
    type: 'result',
    arm: config.arm,
    protocol: config.protocol,
    nativeDepth: config.nativeDepth,
    actualDepth,
    state,
    answer: terminal?.result ?? '',
    requests: transport.requestCount,
    nativeRunId: runId ?? null,
    nativeStopReason: terminal?.state ?? (failure === undefined ? null : errorText(failure)),
    physicalCleanup,
    cleanup,
    raw: { hostStartRecord: record ?? null, terminal: terminal ?? null, nativeJournal: runId && host ? join(host.store.directory(runId), 'journal.jsonl') : null, nativeDepth: config.nativeDepth, actualDepth },
    ...(failure === undefined ? {} : { fault: recordError(failure) }),
    providerCodec: 'R, S, and S0 use the same parent IPC DSH-provider codec; this is not an independent provider-private protocol control.',
  }
}

let started = false
let transport
let controller
let journal
let activeStop
const pendingStop = createStopLatch()

async function send(message) {
  if (typeof process.send !== 'function' || !process.connected) return
  await new Promise(resolveSend => process.send(message, () => resolveSend()))
}

async function execute(message) {
  let config
  let result
  try {
    config = await normalizeConfig(message)
    journal = new DurableJournal(join(config.data, 'native-worker-events.jsonl'))
    await writeExclusiveJson(join(config.data, 'native-worker-config.original.json'), config.original)
    await journal.append('worker-configuration', {
      protocol: config.protocol,
      arm: config.arm,
      nativeDepth: config.nativeDepth,
      route: config.route,
      requestLimit: config.requestLimit,
      wallTimeMs: config.wallTimeMs,
      autonomous: config.autonomous,
      ...(config.brokerSocket === undefined ? {} : { brokerSocket: config.brokerSocket }),
      ...(config.brokerState === undefined ? {} : { brokerState: config.brokerState }),
      bridgePort: config.bridgePort,
      dependencyReadRoots: config.dependencyReadRoots,
      nativeSettings: { factoryEnabled: false, harnessRefinements: false, rlmMaxDepth: config.nativeDepth },
      node: process.version,
      nodePath: process.execPath,
    })
    controller = new AbortController()
    transport = new ParentModelTransport({ journal, requestLimit: config.requestLimit, controller })
    activeStop = reason => {
      const stopReason = pendingStop.note(reason)
      if (!controller.signal.aborted) controller.abort(error('ARC_PARENT_STOP', stopReason))
      transport.stop(stopReason)
    }
    if (pendingStop.reason !== undefined) activeStop(pendingStop.reason)
    if (controller.signal.aborted) throw controller.signal.reason
    result = config.protocol === RECURSION_ABLATION_PROTOCOL || config.arm !== 'R'
      ? await runSolar(config, { journal, transport, controller })
      : await runOriginal(config, { journal, transport, controller })
  } catch (failure) {
    const failedProtocol = config?.protocol ?? (typeof message?.protocol === 'string' ? message.protocol : ARC_PROTOCOL)
    const failedArm = config?.arm ?? (typeof message?.arm === 'string' ? message.arm : null)
    const failedNativeDepth = config?.nativeDepth ?? defaultNativeDepth(failedProtocol, failedArm)
    result = {
      type: 'result',
      arm: failedArm,
      protocol: failedProtocol,
      nativeDepth: failedNativeDepth,
      actualDepth: null,
      state: controller?.signal.aborted ? 'cancelled' : classifyFailure(failure, controller ?? { signal: { aborted: false } }),
      answer: '',
      requests: transport?.requestCount ?? 0,
      nativeRunId: null,
      nativeStopReason: errorText(failure),
      physicalCleanup: false,
      cleanup: { worker: { ok: false, error: recordError(failure) } },
      fault: recordError(failure),
      providerCodec: 'R, S, and S0 use the same parent IPC DSH-provider codec; this is not an independent provider-private protocol control.',
    }
  }
  try { await journal?.append('worker-result', result) } catch { /* The result still reaches the trusted parent. */ }
  try { await journal?.settle() } catch { /* The parent receives the persistence fault in the result when applicable. */ }
  await send(result)
  process.exitCode = result.state === 'completed' && result.physicalCleanup === true ? 0 : 1
  if (process.connected) process.disconnect()
}

function isDirectWorkerEntrypoint() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isDirectWorkerEntrypoint()) {
  if (process.versions.node.split('.')[0] !== '22') {
    throw error('ARC_NODE_VERSION', `native worker requires Node 22, got ${process.version}`)
  }
  process.on('message', message => {
    if (isRecord(message) && message.type === 'stop') {
      const reason = pendingStop.note(message.reason)
      activeStop?.(reason)
      return
    }
    if (transport?.handle(message)) return
    if (started) return
    started = true
    void execute(message)
  })

  process.on('disconnect', () => {
    const reason = pendingStop.note('parent IPC disconnected')
    activeStop?.(reason)
  })
}

// Kept deliberately small and side-effect free for the zero-model boundary
// test. These helpers are not a parent/worker protocol surface.
export { normalizeConfig }
export const __test = { exactJson, inlineAttachment, inlineImage, createStopLatch, normalizeConfig, defaultNativeDepth, directLaunchArguments }
