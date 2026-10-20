import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { open, lstat, mkdir, chmod, unlink } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { basename, dirname, join, relative, resolve } from 'node:path'

const MAX_REQUEST_BYTES = 1 << 20
const MAX_RESPONSE_BYTES = 16 << 20
const READ_ONLY_TIMEOUT_MS = 5_000
const ACT_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 20_000
const VALID_ACTIONS = new Set(['RESET', 'ACTION1', 'ACTION2', 'ACTION3', 'ACTION4', 'ACTION5', 'ACTION6', 'ACTION7'])

export class BrokerError extends Error {
  constructor(code, message, options = {}) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BrokerError'
    this.code = code
    this.unknownEffect = options.unknownEffect === true
  }
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(key => allowed.has(key))
}

function fail(code, message, options) {
  throw new BrokerError(code, message, options)
}

function redactedDiagnostic(error) {
  return String(error instanceof Error ? error.message : error ?? 'unknown error')
    .replace(/(api[_-]?key|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500)
}

function jsonLine(value, limit, kind) {
  let encoded
  try {
    encoded = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  } catch (error) {
    fail('ARC_JSON', `${kind} is not JSON serializable`, { cause: error })
  }
  if (encoded.byteLength > limit) fail('ARC_FRAME_LIMIT', `${kind} exceeds ${limit} bytes`)
  return encoded
}

function parseJsonLine(frame, kind) {
  try {
    return JSON.parse(frame.toString('utf8'))
  } catch (error) {
    fail('ARC_JSON', `${kind} is not valid JSON`, { cause: error })
  }
}

function actionSummary(actions) {
  if (!Array.isArray(actions)) return { count: null, names: [] }
  return {
    count: actions.length,
    names: actions.map(action => isRecord(action) && typeof action.name === 'string' ? action.name : null),
    coordinates: actions
      .filter(action => isRecord(action) && action.name === 'ACTION6' && isRecord(action.data))
      .map(action => ({ x: action.data.x ?? null, y: action.data.y ?? null })),
  }
}

function requestSummary(request, bytes) {
  return {
    bytes,
    sha256: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    op: isRecord(request) && typeof request.op === 'string' ? request.op : null,
    actions: isRecord(request) ? actionSummary(request.actions) : { count: null, names: [] },
  }
}

function observationSummary(value) {
  if (!isRecord(value)) return { observation: false, frameSha256: null, actionsTaken: null, levelsCompleted: null, terminal: null }
  let frameSha256 = null
  if (Array.isArray(value.frame)) {
    frameSha256 = createHash('sha256').update(JSON.stringify(value.frame)).digest('hex')
  }
  return {
    observation: true,
    frameSha256,
    actionsTaken: Number.isSafeInteger(value.actions_taken) ? value.actions_taken : null,
    levelsCompleted: Number.isSafeInteger(value.levels_completed) ? value.levels_completed : null,
    terminal: typeof value.terminal === 'string' ? value.terminal : null,
    state: typeof value.state === 'string' ? value.state : null,
  }
}

function responseSummary(response) {
  if (!isRecord(response)) return { valid: false }
  return {
    valid: typeof response.ok === 'boolean',
    ok: response.ok === true,
    error: typeof response.error === 'string' ? response.error : null,
    fatal: response.fatal === true,
    observation: response.ok === true ? observationSummary(response.value) : null,
  }
}

function validateAction(action, index) {
  if (!isRecord(action) || !hasOnlyKeys(action, new Set(['name', 'data']))) {
    fail('ARC_PROXY_PROTOCOL', `actions[${index}] must contain exactly name and data`)
  }
  if (typeof action.name !== 'string' || !VALID_ACTIONS.has(action.name)) {
    fail('ARC_PROXY_PROTOCOL', `actions[${index}].name is not a supported action`)
  }
  if (!Object.hasOwn(action, 'data') || !isRecord(action.data)) {
    fail('ARC_PROXY_PROTOCOL', `actions[${index}].data must be an object`)
  }
  if (action.name === 'ACTION6') {
    if (!hasOnlyKeys(action.data, new Set(['x', 'y'])) || !Number.isInteger(action.data.x) || !Number.isInteger(action.data.y) || action.data.x < 0 || action.data.x > 63 || action.data.y < 0 || action.data.y > 63) {
      fail('ARC_PROXY_PROTOCOL', `actions[${index}].data must contain integer x and y in 0..63`)
    }
    return
  }
  if (Object.keys(action.data).length !== 0) {
    fail('ARC_PROXY_PROTOCOL', `actions[${index}].data must be an empty object`)
  }
}

function validateRequest(request, phase) {
  if (!isRecord(request) || typeof request.op !== 'string') fail('ARC_PROXY_PROTOCOL', 'request.op must be a string')
  if (request.op === 'observe' || request.op === 'status') {
    if (!hasOnlyKeys(request, new Set(['op']))) fail('ARC_PROXY_PROTOCOL', `${request.op} takes no fields`)
  } else if (request.op === 'act') {
    if (!hasOnlyKeys(request, new Set(['op', 'actions'])) || !Array.isArray(request.actions) || request.actions.length < 1 || request.actions.length > 20) {
      fail('ARC_PROXY_PROTOCOL', 'act takes 1..20 actions and no other fields')
    }
    request.actions.forEach(validateAction)
  } else {
    fail('ARC_PROXY_PROTOCOL', 'request.op must be observe, status, or act')
  }

  if (phase === 0 && request.op !== 'observe') {
    fail('ARC_BOOTSTRAP', 'the first game operation must be observe')
  }
  if (phase === 1 || phase === 2) {
    if (request.op !== 'act' || request.actions.length !== 1 || request.actions[0].name === 'RESET') {
      fail('ARC_BOOTSTRAP', 'an immediate single non-RESET action is required')
    }
  }
}

function validateEngineResponse(value) {
  if (!isRecord(value) || typeof value.ok !== 'boolean') fail('ARC_ENGINE_PROTOCOL', 'engine response lacks boolean ok')
  if (Object.hasOwn(value, 'fatal') && typeof value.fatal !== 'boolean') fail('ARC_ENGINE_PROTOCOL', 'engine response fatal marker is invalid')
  if (value.ok && (!Object.hasOwn(value, 'value') || !isRecord(value.value))) {
    fail('ARC_ENGINE_PROTOCOL', 'successful engine response lacks an observation object')
  }
  if (value.ok && !['ACTIVE', 'WIN', 'ACTION_CAP'].includes(value.value.terminal)) {
    fail('ARC_ENGINE_PROTOCOL', 'successful engine response lacks a recognized terminal state')
  }
  return value
}

function nextPhase(phase, request, response) {
  if (!response.ok) return phase
  if (phase === 0) return 1
  if (phase === 1) return response.value.terminal === 'ACTIVE' ? 2 : 3
  if (phase === 2) return 3
  return phase
}

function isPathInside(parent, candidate) {
  const difference = relative(parent, candidate)
  return difference === '' || (!difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && difference !== '..' && !difference.startsWith('..'))
}

async function assertNewSocketPath(path, label) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  fail('ARC_SOCKET_EXISTS', `${label} already exists: ${path}`)
}

async function waitForSocket(path, backend) {
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const details = await lstat(path)
      if (!details.isSocket() || details.isSymbolicLink()) fail('ARC_ENGINE_SOCKET', 'engine socket is not a regular Unix socket')
      return { dev: details.dev, ino: details.ino }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (backend?.exited?.()) {
      fail('ARC_BACKEND_EXIT', backend.diagnostic?.() ?? 'broker process exited before creating engine socket')
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  fail('ARC_BACKEND_TIMEOUT', `broker did not create ${path} within ${START_TIMEOUT_MS}ms`)
}

function waitForChild(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolvePromise => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit)
      resolvePromise(false)
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolvePromise(true)
    }
    child.once('exit', onExit)
  })
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child?.exitCode ?? null, signal: child?.signalCode ?? null, stopped: true }
  }
  let signalled = false
  if (Number.isInteger(child.pid) && child.pid > 0) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      signalled = true
    } catch {
      signalled = child.kill('SIGTERM')
    }
  }
  if (!(await waitForChild(child, 5_000)) && child.exitCode === null && child.signalCode === null) {
    if (Number.isInteger(child.pid) && child.pid > 0) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    await waitForChild(child, 5_000)
  }
  return {
    exitCode: child.exitCode,
    signal: child.signalCode,
    stopped: child.exitCode !== null || child.signalCode !== null,
    signalled,
  }
}

async function spawnAuthorBackend({ sourceRoot, corpus, python, adapterPath, gameId, directory, engineSocket }) {
  const runtimeHome = join(directory, 'runtime-home')
  const runtimeTmp = join(directory, 'runtime-tmp')
  const runtimeMpl = join(directory, 'runtime-mpl')
  await Promise.all([
    mkdir(runtimeHome, { recursive: true, mode: 0o700 }),
    mkdir(runtimeTmp, { recursive: true, mode: 0o700 }),
    mkdir(runtimeMpl, { recursive: true, mode: 0o700 }),
  ])
  let childError = null
  let stderr = ''
  const child = spawn(python, [adapterPath, '--source', sourceRoot, '--corpus', corpus, '--game', gameId, '--socket', engineSocket], {
    cwd: directory,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      HOME: runtimeHome,
      TMPDIR: runtimeTmp,
      MPLCONFIGDIR: runtimeMpl,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      OPERATION_MODE: 'offline',
      PYTHONDONTWRITEBYTECODE: '1',
    },
  })
  child.once('error', error => { childError = error })
  child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-2_000) })
  return {
    child,
    exited: () => childError !== null || child.exitCode !== null || child.signalCode !== null,
    diagnostic: () => childError ? redactedDiagnostic(childError) : redactedDiagnostic(stderr || `exit=${child.exitCode ?? child.signalCode ?? 'unknown'}`),
    stop: () => stopChild(child),
  }
}

async function requestSocket(socketPath, request, { timeoutMs, responseLimit, endpoint }) {
  const requestFrame = jsonLine(request, MAX_REQUEST_BYTES, 'request')
  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let response = Buffer.alloc(0)
    let connected = false
    const socket = createConnection(socketPath)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    const timer = setTimeout(() => {
      finish(new BrokerError('ARC_SOCKET_TIMEOUT', `${endpoint} did not reply within ${timeoutMs}ms`))
    }, timeoutMs)
    socket.once('connect', () => {
      connected = true
      socket.write(requestFrame, error => {
        if (error) finish(new BrokerError('ARC_SOCKET_WRITE', `${endpoint} write failed`, { cause: error }))
      })
    })
    socket.on('data', chunk => {
      response = Buffer.concat([response, chunk])
      if (response.byteLength > responseLimit) {
        finish(new BrokerError('ARC_FRAME_LIMIT', `${endpoint} response exceeds ${responseLimit} bytes`))
        return
      }
      const newline = response.indexOf(0x0a)
      if (newline === -1) return
      const frame = response.subarray(0, newline + 1)
      const trailing = response.subarray(newline + 1)
      if (trailing.length > 0) {
        finish(new BrokerError('ARC_ENGINE_PROTOCOL', `${endpoint} returned more than one response frame`))
        return
      }
      let parsed
      try {
        parsed = parseJsonLine(frame, `${endpoint} response`)
      } catch (error) {
        finish(error)
        return
      }
      finish(null, parsed)
    })
    socket.once('error', error => finish(new BrokerError('ARC_SOCKET', `${endpoint} connection failed${connected ? ' after connect' : ''}`, { cause: error })))
    socket.once('end', () => finish(new BrokerError('ARC_SOCKET_DISCONNECT', `${endpoint} disconnected before a complete response`)))
  })
}

async function removeOwnedSocket(path, identity) {
  try {
    const details = await lstat(path)
    if (!details.isSocket() || details.isSymbolicLink() || details.dev !== identity.dev || details.ino !== identity.ino) {
      return { removed: false, reason: 'identity_changed_or_not_socket' }
    }
    await unlink(path)
    return { removed: true, reason: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: true, reason: null }
    return { removed: false, reason: redactedDiagnostic(error) }
  }
}

function phaseName(phase) {
  return `phase-${phase}`
}

/**
 * Start one isolated, local ARC broker and expose only a guarded Unix socket.
 * `spawnBackend` is a deliberately narrow test seam; production uses the
 * pinned author's broker through the supplied SDK step facade.
 */
export async function createGameBroker({ sourceRoot, corpus, python, adapterPath, gameId, directory, proxySocket, spawnBackend = spawnAuthorBackend }) {
  if (typeof sourceRoot !== 'string' || typeof corpus !== 'string' || typeof python !== 'string' || typeof adapterPath !== 'string' || typeof gameId !== 'string' || typeof directory !== 'string' || typeof proxySocket !== 'string') {
    fail('ARC_BROKER_ARGS', 'sourceRoot, corpus, python, adapterPath, gameId, directory, and proxySocket must be strings')
  }
  if (!gameId || gameId.includes('\0')) fail('ARC_BROKER_ARGS', 'gameId must be a non-empty string without NUL')
  if (typeof spawnBackend !== 'function') fail('ARC_BROKER_ARGS', 'spawnBackend must be a function')

  const privateDirectory = resolve(directory)
  const engineSocket = join(privateDirectory, 'engine.sock')
  const publicSocket = resolve(proxySocket)
  if (basename(publicSocket) !== 'guard.sock') fail('ARC_BROKER_ARGS', 'proxySocket must be named guard.sock')
  if (isPathInside(privateDirectory, publicSocket)) fail('ARC_BROKER_ARGS', 'proxySocket must be outside the private engine directory')
  const stateRoot = join(dirname(publicSocket), 'client-state')
  const journalPath = join(privateDirectory, 'journal.jsonl')

  await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
  const privateDetails = await lstat(privateDirectory)
  if (!privateDetails.isDirectory() || privateDetails.isSymbolicLink()) fail('ARC_BROKER_ARGS', 'directory must be a real directory')
  await chmod(privateDirectory, 0o700)
  await mkdir(dirname(publicSocket), { recursive: true, mode: 0o700 })
  await mkdir(stateRoot, { recursive: true, mode: 0o700 })
  await chmod(stateRoot, 0o700)
  await assertNewSocketPath(engineSocket, 'engine socket')
  await assertNewSocketPath(publicSocket, 'proxy socket')

  let journalHandle
  try {
    journalHandle = await open(journalPath, 'wx', 0o600)
  } catch (error) {
    throw new BrokerError('ARC_JOURNAL', `cannot create journal at ${journalPath}`, { cause: error })
  }
  let journalTail = Promise.resolve()
  let journalClosed = false
  let journalSequence = 0
  const journal = async entry => {
    if (journalClosed) throw new BrokerError('ARC_JOURNAL', 'journal is closed')
    const sequence = ++journalSequence
    const line = `${JSON.stringify({ formatVersion: 1, sequence, at: new Date().toISOString(), gameId, ...entry })}\n`
    const write = journalTail.then(async () => {
      await journalHandle.writeFile(line, 'utf8')
      await journalHandle.sync()
    })
    journalTail = write.catch(() => {})
    return await write
  }

  let backend = null
  let engineIdentity = null
  let server = null
  let proxyIdentity = null
  let phase = 0
  let requestOrdinal = 0
  let queue = Promise.resolve()
  let stopped = false
  let stopPromise = null
  let fatal = null
  let stopScheduled = false
  let trustedLastObservation
  let trustedWinObservation
  const rememberObservation = async (response, op) => {
    if (!response.ok) return
    await journal({ event: 'trusted-engine-observation', op, observation: observationSummary(response.value) })
    trustedLastObservation = structuredClone(response.value)
    if (response.value.terminal === 'WIN') trustedWinObservation = structuredClone(response.value)
  }
  const clients = new Set()

  const scheduleStop = () => {
    if (stopScheduled) return
    stopScheduled = true
    setTimeout(() => { void stop() }, 0)
  }

  const markFatal = async (code, message, { schedule = true } = {}) => {
    if (fatal) return
    fatal = { code, message }
    try {
      await journal({ event: 'fatal', code, message, phase: phaseName(phase) })
    } catch {
      // The original error still propagates; there is no safe fallback journal.
    }
    if (schedule) scheduleStop()
  }

  const enqueue = job => {
    const result = queue.then(job, job)
    queue = result.catch(() => {})
    return result
  }

  const forwardEngine = async request => {
    const timeoutMs = request.op === 'act' ? ACT_TIMEOUT_MS : READ_ONLY_TIMEOUT_MS
    let raw
    try {
      raw = await requestSocket(engineSocket, request, { timeoutMs, responseLimit: MAX_RESPONSE_BYTES, endpoint: 'engine' })
      const response = validateEngineResponse(raw)
      await rememberObservation(response, request.op)
      return response
    } catch (error) {
      if (request.op === 'act') {
        await markFatal('ARC_UNKNOWN_EFFECT', 'engine disconnect, timeout, or malformed response after act; the run is closed without replay', { schedule: false })
        throw new BrokerError('ARC_UNKNOWN_EFFECT', 'engine result for act is unknown; the run is closed without replay', { cause: error, unknownEffect: true })
      }
      throw error
    }
  }

  const proxyDispatch = async (request, client) => {
    if (stopped || fatal) fail('ARC_RUN_CLOSED', fatal?.message ?? 'broker has been stopped')
    if (client?.destroyed) fail('ARC_CLIENT_DISCONNECT', 'client disconnected before the request could be forwarded')
    const phaseBefore = phase
    validateRequest(request, phaseBefore)
    const response = await forwardEngine(request)
    if (request.op === 'act' && client?.destroyed) {
      await markFatal('ARC_UNKNOWN_EFFECT', 'client disconnected before the acknowledged act could be delivered; the run is closed without replay', { schedule: false })
      fail('ARC_UNKNOWN_EFFECT', 'client disconnected after act; the run is closed without replay', { unknownEffect: true })
    }
    phase = nextPhase(phaseBefore, request, response)
    if (response.fatal === true) await markFatal('ARC_ENGINE_FATAL', 'engine reported a fatal condition', { schedule: false })
    return { response, phaseBefore, phaseAfter: phase }
  }

  const writeProxyResponse = async (socket, value) => {
    const frame = jsonLine(value, MAX_RESPONSE_BYTES, 'proxy response')
    if (socket.destroyed) return false
    return await new Promise(resolvePromise => {
      socket.write(frame, error => resolvePromise(!error && !socket.destroyed))
    })
  }

  const handleProxyFrame = async (socket, frame) => {
    const ordinal = ++requestOrdinal
    let request
    let requestInfo
    try {
      request = parseJsonLine(frame, 'proxy request')
      requestInfo = requestSummary(request, frame.byteLength)
    } catch (error) {
      requestInfo = { bytes: frame.byteLength, sha256: createHash('sha256').update(frame).digest('hex'), op: null, actions: { count: null, names: [] } }
      try {
        await journal({ event: 'proxy-request', ordinal, phase: phaseName(phase), valid: false, request: requestInfo })
        await journal({ event: 'proxy-ack', ordinal, phase: phaseName(phase), ok: false, error: error.code ?? 'ARC_JSON', response: null })
      } catch (journalError) {
        await markFatal('ARC_JOURNAL', 'journal failed while recording an invalid proxy request')
      }
      await writeProxyResponse(socket, { ok: false, error: error.code ?? 'ARC_JSON', message: error.message })
      return
    }

    try {
      await journal({ event: 'proxy-request', ordinal, phase: phaseName(phase), valid: true, request: requestInfo })
      const result = await enqueue(() => proxyDispatch(request, socket))
      const response = result.response
      await journal({
        event: 'proxy-ack',
        ordinal,
        phaseBefore: phaseName(result.phaseBefore),
        phaseAfter: phaseName(result.phaseAfter),
        ok: response.ok,
        response: responseSummary(response),
      })
      const delivered = await writeProxyResponse(socket, response)
      if (request.op === 'act' && !delivered && response.ok) {
        await markFatal('ARC_UNKNOWN_EFFECT', 'client did not receive an acknowledged act; the run is closed without replay')
      }
      if (fatal) scheduleStop()
    } catch (error) {
      const code = error instanceof BrokerError ? error.code : 'ARC_PROXY_ERROR'
      const message = error instanceof Error ? error.message : 'proxy request failed'
      try {
        await journal({ event: 'proxy-ack', ordinal, phase: phaseName(phase), ok: false, error: code, response: null })
      } catch {
        await markFatal('ARC_JOURNAL', 'journal failed while recording a proxy failure')
      }
      await writeProxyResponse(socket, { ok: false, error: code, message })
      if (fatal) scheduleStop()
    }
  }

  const rejectOversizedClientFrame = async socket => {
    const ordinal = ++requestOrdinal
    try {
      await journal({ event: 'proxy-request', ordinal, phase: phaseName(phase), valid: false, request: { bytes: null, sha256: null, op: null, actions: { count: null, names: [] } } })
      await journal({ event: 'proxy-ack', ordinal, phase: phaseName(phase), ok: false, error: 'ARC_FRAME_LIMIT', response: null })
    } catch {
      await markFatal('ARC_JOURNAL', 'journal failed while recording an oversized proxy frame')
    }
    await writeProxyResponse(socket, { ok: false, error: 'ARC_FRAME_LIMIT', message: `request exceeds ${MAX_REQUEST_BYTES} bytes` })
    socket.destroy()
  }

  const installProxyHandlers = createdServer => {
    createdServer.on('connection', socket => {
      clients.add(socket)
      let buffered = Buffer.alloc(0)
      let rejected = false
      socket.on('data', chunk => {
        if (rejected || stopped) return
        buffered = Buffer.concat([buffered, chunk])
        let newline
        while (!rejected && (newline = buffered.indexOf(0x0a)) !== -1) {
          const frame = buffered.subarray(0, newline + 1)
          buffered = buffered.subarray(newline + 1)
          if (frame.byteLength > MAX_REQUEST_BYTES) {
            rejected = true
            void rejectOversizedClientFrame(socket)
            return
          }
          void handleProxyFrame(socket, frame)
        }
        if (!rejected && buffered.byteLength > MAX_REQUEST_BYTES) {
          rejected = true
          void rejectOversizedClientFrame(socket)
        }
      })
      socket.on('end', () => {
        if (buffered.byteLength === 0 || rejected) return
        const ordinal = ++requestOrdinal
        void (async () => {
          try {
            await journal({ event: 'proxy-request', ordinal, phase: phaseName(phase), valid: false, request: { bytes: buffered.byteLength, sha256: createHash('sha256').update(buffered).digest('hex'), op: null, actions: { count: null, names: [] } } })
            await journal({ event: 'proxy-ack', ordinal, phase: phaseName(phase), ok: false, error: 'ARC_FRAME', response: null })
          } catch {
            await markFatal('ARC_JOURNAL', 'journal failed while recording an incomplete proxy frame')
          }
        })()
      })
      socket.on('close', () => clients.delete(socket))
      socket.on('error', () => {})
    })
  }

  const closeServer = async () => {
    if (!server) return
    for (const client of clients) client.destroy()
    clients.clear()
    await new Promise(resolvePromise => server.close(() => resolvePromise()))
  }

  const stop = async () => {
    if (stopPromise) return await stopPromise
    stopPromise = (async () => {
      stopped = true
      const receipt = {
        formatVersion: 1,
        stoppedAt: new Date().toISOString(),
        fatal: fatal ? { ...fatal } : null,
        proxy: { socket: publicSocket, removed: false, detail: null },
        engine: { socket: engineSocket, removed: false, detail: null },
        backend: null,
        journal: journalPath,
      }
      try {
        await closeServer()
      } catch (error) {
        receipt.proxy.detail = redactedDiagnostic(error)
      }
      try {
        receipt.backend = backend?.stop ? await backend.stop() : { stopped: true }
      } catch (error) {
        receipt.backend = { stopped: false, error: redactedDiagnostic(error) }
      }
      if (proxyIdentity) {
        const result = await removeOwnedSocket(publicSocket, proxyIdentity)
        receipt.proxy.removed = result.removed
        receipt.proxy.detail = receipt.proxy.detail ?? result.reason
      }
      if (engineIdentity) {
        const result = await removeOwnedSocket(engineSocket, engineIdentity)
        receipt.engine.removed = result.removed
        receipt.engine.detail = result.reason
      }
      try {
        await journal({ event: 'cleanup', receipt })
      } catch (error) {
        receipt.journalError = redactedDiagnostic(error)
      }
      journalClosed = true
      try {
        await journalTail
        await journalHandle.close()
      } catch (error) {
        receipt.journalCloseError = redactedDiagnostic(error)
      }
      return receipt
    })()
    return await stopPromise
  }

  try {
    await journal({ event: 'controller-starting', phase: phaseName(phase), engineSocket: 'private', proxySocket: publicSocket })
    backend = await spawnBackend({ sourceRoot: resolve(sourceRoot), corpus: resolve(corpus), python: resolve(python), adapterPath: resolve(adapterPath), gameId, directory: privateDirectory, engineSocket })
    if (!backend || typeof backend !== 'object' || typeof backend.stop !== 'function') fail('ARC_BACKEND', 'spawnBackend must return an object with stop()')
    engineIdentity = await waitForSocket(engineSocket, backend)
    if (backend.exited?.()) fail('ARC_BACKEND_EXIT', backend.diagnostic?.() ?? 'broker process exited after creating engine socket')
    if (backend.child?.once) {
      backend.child.once('exit', () => {
        if (!stopped) void markFatal('ARC_BACKEND_EXIT', 'broker process exited')
      })
    }
    server = createServer()
    installProxyHandlers(server)
    await new Promise((resolvePromise, rejectPromise) => {
      const onError = error => {
        server.removeListener('listening', onListening)
        rejectPromise(error)
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolvePromise()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(publicSocket)
    })
    await chmod(publicSocket, 0o600)
    const proxyDetails = await lstat(publicSocket)
    if (!proxyDetails.isSocket() || proxyDetails.isSymbolicLink()) fail('ARC_PROXY_SOCKET', 'proxy socket is not a regular Unix socket')
    proxyIdentity = { dev: proxyDetails.dev, ino: proxyDetails.ino }
    server.on('error', error => {
      if (!stopped) void markFatal('ARC_PROXY_SERVER', redactedDiagnostic(error))
    })
    await journal({ event: 'controller-ready', phase: phaseName(phase), engineSocket: 'private', proxySocket: publicSocket })
  } catch (error) {
    stopped = true
    try {
      if (backend?.stop) await backend.stop()
    } catch {
      // Preserve the startup error; cleanup failure is not a successful start.
    }
    try {
      if (server) await closeServer()
    } catch {
      // Preserve the startup error.
    }
    try {
      if (engineIdentity) await removeOwnedSocket(engineSocket, engineIdentity)
    } catch {
      // Preserve the startup error.
    }
    try {
      await journal({ event: 'controller-start-failed', code: error?.code ?? 'ARC_START', message: redactedDiagnostic(error) })
      journalClosed = true
      await journalTail
      await journalHandle.close()
    } catch {
      // Preserve the original startup error.
    }
    throw error
  }

  const call = async (op, args = {}) => {
    if (!isRecord(args)) fail('ARC_CLIENT_ARGS', 'args must be an object')
    if (Object.hasOwn(args, 'op')) fail('ARC_CLIENT_ARGS', 'args must not override op')
    const request = { op, ...args }
    const timeoutMs = op === 'act' ? ACT_TIMEOUT_MS : READ_ONLY_TIMEOUT_MS
    let response
    try {
      response = await requestSocket(publicSocket, request, { timeoutMs, responseLimit: MAX_RESPONSE_BYTES, endpoint: 'proxy' })
      response = validateEngineResponse(response)
    } catch (error) {
      if (op === 'act') await markFatal('ARC_UNKNOWN_EFFECT', 'proxy caller did not receive a definitive act result; the run is closed without replay')
      throw error
    }
    if (!response.ok) fail(response.error || 'ARC_BROKER_RESPONSE', typeof response.message === 'string' ? response.message : 'broker rejected request')
    return response.value
  }

  const inspect = async () => {
    if (stopped || fatal) fail('ARC_RUN_CLOSED', fatal?.message ?? 'broker has been stopped')
    const ordinal = ++requestOrdinal
    try {
      await journal({ event: 'trusted-inspect-request', ordinal, phase: phaseName(phase) })
      const response = validateEngineResponse(await requestSocket(engineSocket, { op: 'status' }, { timeoutMs: READ_ONLY_TIMEOUT_MS, responseLimit: MAX_RESPONSE_BYTES, endpoint: 'engine status' }))
      await journal({ event: 'trusted-inspect-ack', ordinal, phase: phaseName(phase), ok: response.ok, response: responseSummary(response) })
      if (!response.ok) fail(response.error || 'ARC_BROKER_RESPONSE', typeof response.message === 'string' ? response.message : 'engine rejected status')
      await rememberObservation(response, 'trusted-status')
      return response.value
    } catch (error) {
      try {
        await journal({ event: 'trusted-inspect-ack', ordinal, phase: phaseName(phase), ok: false, error: error?.code ?? 'ARC_INSPECT_ERROR', response: null })
      } catch {
        // The original inspect error remains visible.
      }
      throw error
    }
  }

  return { socket: publicSocket, stateRoot, call, inspect, stop, lastObservation: () => structuredClone(trustedWinObservation ?? trustedLastObservation) }
}

/** Grade only the independently observed engine terminal state. */
export function gradeGame({ observation, error, stopReason } = {}) {
  const actual = isRecord(observation) ? observation : null
  const terminal = typeof actual?.terminal === 'string' ? actual.terminal : null
  // This is deliberately not derived from a model message, a cleanup result,
  // or a later transport error. Once the trusted broker has reported WIN, that
  // observed fact remains in the score even if the surrounding execution did
  // not finish cleanly.
  const observedWin = terminal === 'WIN'
  const budgetFailure = terminal === 'ACTION_CAP'
  const errorPresent = error !== undefined && error !== null
  const normalStop = stopReason === undefined || stopReason === null || stopReason === 'WIN'
  const brokerObservationValid = actual !== null && ['ACTIVE', 'WIN', 'ACTION_CAP'].includes(terminal)
  const executionCompleted = observedWin && !errorPresent && normalStop
  const unknown = !observedWin && !budgetFailure
  return {
    win: observedWin ? 1 : 0,
    denominator: 1,
    terminal,
    observedWin,
    brokerObservationValid,
    protocolReview: 'not-reviewed',
    executionCompleted,
    levelsCompleted: Number.isSafeInteger(actual?.levels_completed) ? actual.levels_completed : null,
    actionsTaken: Number.isSafeInteger(actual?.actions_taken) ? actual.actions_taken : null,
    levels: Number.isSafeInteger(actual?.levels_completed) ? actual.levels_completed : null,
    actions: Number.isSafeInteger(actual?.actions_taken) ? actual.actions_taken : null,
    completed: observedWin,
    budgetFailure,
    unknown,
    errorPresent,
    error: error ?? null,
    stopReason: stopReason ?? null,
  }
}
