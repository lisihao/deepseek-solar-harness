import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'

import { EgoProcessError, type EgoProcessRequest, type EgoProcessResult } from './process-contract.js'

const TERM_GRACE_MS = 250
const KILL_WAIT_MS = 1_000
const POLL_MS = 20

type StopReason = {
  readonly code: 'EGO_TIMEOUT' | 'EGO_ABORTED' | 'EGO_OUTPUT_TOO_LARGE'
  readonly message: string
}

type CloseResult = {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

type ForcedCompletion = {
  readonly reason: StopReason
  readonly stopped: boolean
}

function error(
  code: string,
  message: string,
  executionStopped: boolean,
  mayHaveLateEffects: boolean,
  stderr = '',
): EgoProcessError {
  return new EgoProcessError(code, message, executionStopped, mayHaveLateEffects, stderr)
}

function invalidRequest(message: string): EgoProcessError {
  return error('EGO_SPAWN_FAILED', message, true, false)
}

function validateRequest(request: EgoProcessRequest): void {
  if (!request || typeof request !== 'object') throw invalidRequest('Ego process request is invalid')
  if (typeof request.executable !== 'string' || request.executable.length === 0) {
    throw invalidRequest('Ego process executable is invalid')
  }
  if (typeof request.source !== 'string') throw invalidRequest('Ego process source is invalid')
  if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) {
    throw invalidRequest('Ego process cwd must be an absolute directory')
  }
  try {
    if (!statSync(request.cwd).isDirectory()) throw new Error('not a directory')
  } catch {
    throw invalidRequest('Ego process cwd is not an existing directory')
  }
  for (const [name, value] of [
    ['timeoutMs', request.timeoutMs],
    ['stdoutMaxBytes', request.stdoutMaxBytes],
    ['stderrMaxBytes', request.stderrMaxBytes],
  ] as const) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw invalidRequest(`Ego process ${name} is invalid`)
    }
  }
}

/** Provider credentials are not needed by the browser-owned Ego process. */
function isProviderSecret(name: string): boolean {
  const upper = name.toUpperCase()
  if (!/^(?:OPENAI|ANTHROPIC|DEEPSEEK)(?:_|$)/.test(upper)) return false
  return /(?:^|_)(?:API[_-]?KEY|KEY|API[_-]?TOKEN|AUTH[_-]?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/.test(upper)
}

function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (isProviderSecret(key)) delete env[key]
  }
  return env
}

function chunkBuffer(chunk: unknown): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
}

function appendTail(current: Buffer, chunk: Buffer, maxBytes: number): Buffer {
  if (maxBytes === 0) return Buffer.alloc(0)
  if (chunk.length >= maxBytes) return Buffer.from(chunk.subarray(chunk.length - maxBytes))
  if (current.length === 0) return Buffer.from(chunk)
  const combined = Buffer.concat([current, chunk])
  if (combined.length <= maxBytes) return combined
  return Buffer.from(combined.subarray(combined.length - maxBytes))
}

function processGroupExists(pid: number | undefined): boolean {
  if (process.platform === 'win32' || pid === undefined || pid <= 1) return false
  try {
    process.kill(-pid, 0)
    return true
  } catch (caught) {
    const code = (caught as NodeJS.ErrnoException).code
    // EPERM means that the group exists but the caller cannot signal it.
    if (code === 'EPERM') return true
    return false
  }
}

function signalChildGroup(child: ChildProcess, pid: number | undefined, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && pid !== undefined && pid > 1) {
    try {
      process.kill(-pid, signal)
      return
    } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  try {
    child.kill(signal)
  } catch {
    // The process already exited, or the platform cannot signal it.
  }
}

function destroyChildStreams(child: ChildProcess): void {
  try { child.stdin?.destroy() } catch { /* already closed */ }
  try { child.stdout?.destroy() } catch { /* already closed */ }
  try { child.stderr?.destroy() } catch { /* already closed */ }
}

async function waitForGroupStopped(
  child: ChildProcess,
  pid: number | undefined,
  childClosed: () => boolean,
  deadline: number,
): Promise<boolean> {
  const stopped = (): boolean => {
    const childStopped = childClosed() || child.exitCode !== null || child.signalCode !== null
    if (process.platform === 'win32') return childStopped
    return childStopped && !processGroupExists(pid)
  }
  while (Date.now() < deadline) {
    if (stopped()) return true
    await wait(POLL_MS)
  }
  return stopped()
}

async function terminateChildGroup(
  child: ChildProcess,
  pid: number | undefined,
  childClosed: () => boolean,
): Promise<boolean> {
  signalChildGroup(child, pid, 'SIGTERM')
  if (await waitForGroupStopped(child, pid, childClosed, Date.now() + TERM_GRACE_MS)) return true

  signalChildGroup(child, pid, 'SIGKILL')
  return waitForGroupStopped(child, pid, childClosed, Date.now() + KILL_WAIT_MS)
}

/**
 * Run one trusted Ego `nodejs` program through stdin.
 *
 * The executable is intentionally not run through a shell and the source is
 * never placed in argv. A detached child gives the transport an owned process
 * group on macOS and Linux so cancellation can clean descendants as well.
 */
export async function runEgoProcess(request: EgoProcessRequest): Promise<EgoProcessResult> {
  if (request?.signal?.aborted) {
    throw error('EGO_ABORTED', 'Ego process was aborted before launch', true, false)
  }
  validateRequest(request)

  let child: ChildProcess
  try {
    child = spawn(request.executable, ['nodejs'], {
      cwd: request.cwd,
      env: childEnvironment(),
      detached: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    throw error('EGO_SPAWN_FAILED', 'Ego process could not be launched', true, false)
  }

  const pid = child.pid
  let closed = false
  let spawnFailure = false
  let resolveClose!: (result: CloseResult) => void
  const closePromise = new Promise<CloseResult>((resolve) => { resolveClose = resolve })
  let stderrBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderrBytes = 0
  let stderrTruncated = false
  const stdoutChunks: Buffer[] = []
  let stdoutBytes = 0
  let stdinFailure = false
  let forced: StopReason | undefined
  let termination: Promise<boolean> | undefined
  let resolveForcedCompletion!: (completion: ForcedCompletion) => void
  const forcedCompletion = new Promise<ForcedCompletion>((resolve) => { resolveForcedCompletion = resolve })

  const forceStop = (reason: StopReason): void => {
    if (forced) return
    forced = reason
    termination = terminateChildGroup(child, pid, () => closed)
      .catch(() => false)
      .then((stopped) => {
        resolveForcedCompletion({ reason, stopped })
        if (!closed) destroyChildStreams(child)
        return stopped
      })
  }

  const onAbort = (): void => {
    forceStop({ code: 'EGO_ABORTED', message: 'Ego process was aborted' })
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  const timeout = setTimeout(() => {
    if (pid === undefined) {
      spawnFailure = true
      return
    }
    forceStop({ code: 'EGO_TIMEOUT', message: 'Ego process timed out' })
  }, request.timeoutMs)

  child.once('error', () => {
    // An error before a successful close is the launch failure reported by
    // ChildProcess for ENOENT/EACCES and similar spawn errors.
    spawnFailure = pid === undefined
  })
  child.once('close', (code, signal) => {
    closed = true
    resolveClose({ code, signal })
  })
  child.stdin?.once('error', () => { stdinFailure = true })
  child.stdout?.on('data', (value: unknown) => {
    if (forced) return
    const chunk = chunkBuffer(value)
    stdoutBytes += chunk.length
    if (stdoutBytes > request.stdoutMaxBytes) {
      forceStop({ code: 'EGO_OUTPUT_TOO_LARGE', message: 'Ego process stdout exceeded its limit' })
      return
    }
    stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (value: unknown) => {
    const chunk = chunkBuffer(value)
    stderrBytes += chunk.length
    if (stderrBytes > request.stderrMaxBytes) stderrTruncated = true
    stderrBuffer = appendTail(stderrBuffer, chunk, request.stderrMaxBytes)
  })

  if (!child.stdin || !child.stdout || !child.stderr) {
    spawnFailure = true
    forceStop({ code: 'EGO_OUTPUT_TOO_LARGE', message: 'Ego process streams are unavailable' })
  } else {
    try {
      child.stdin.end(request.source)
    } catch {
      stdinFailure = true
    }
  }

  try {
    // A forced execution has a bounded cleanup wait. Do not wait forever for
    // an inherited pipe held by a descendant that ignored both signals.
    const outcome = await Promise.race([
      closePromise.then((finished) => ({ kind: 'close' as const, finished })),
      forcedCompletion.then(({ reason, stopped }) => ({ kind: 'forced' as const, reason, stopped })),
    ])
    if (outcome.kind === 'forced') {
      throw error(outcome.reason.code, outcome.reason.message, outcome.stopped, true, stderrBuffer.toString('utf8'))
    }

    const finished = outcome.finished
    const forcedAfterClose = forced as StopReason | undefined
    if (forcedAfterClose) {
      const stopped = await termination?.then((value) => value) ?? false
      throw error(forcedAfterClose.code, forcedAfterClose.message, stopped, true, stderrBuffer.toString('utf8'))
    }
    if (spawnFailure) throw error('EGO_SPAWN_FAILED', 'Ego process could not be launched', true, false, stderrBuffer.toString('utf8'))
    if (stdinFailure || finished.code !== 0 || finished.signal !== null) {
      throw error('EGO_PROCESS_FAILED', 'Ego process exited unsuccessfully', true, true, stderrBuffer.toString('utf8'))
    }
    return {
      stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
      stderr: stderrBuffer.toString('utf8'),
      stderrTruncated,
      exitCode: 0,
      executionStopped: true,
    }
  } finally {
    clearTimeout(timeout)
    request.signal?.removeEventListener('abort', onAbort)
    if (forced && termination) {
      await termination
      if (!closed) {
        try { child.unref() } catch { /* already closed */ }
      }
    }
  }
}
