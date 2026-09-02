/** Unix-socket resident daemon client and polling turn handle. @module @deepseek-ai/dsh-resident-operator-local/client */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type {
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorModelToolBridgeV1,
  PhysicalOperatorNativeToolPolicy,
} from '@deepseek-ai/dsh-physical-operator'
import {
  ResidentOperatorError,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  RESIDENT_PROTOCOL_VERSION,
  RESIDENT_STATE_SCHEMA_VERSION,
  type ResidentEventPage,
  type ResidentCompactResult,
  type ResidentProviderStatus,
  type ResidentSessionSnapshot,
  type ResidentTurnSnapshot,
  type ResidentTurnResult,
} from '@deepseek-ai/dsh-resident-operator'
import { unwrapWire } from './protocol.ts'
import type { AcceptedTurn, TurnInspection } from './store.ts'
import { residentDriverManifestSha256 } from './driver-modules.ts'

const REQUIRED_METHODS = Object.freeze([
  'system.handshake',
  'system.shutdown',
  'operator.list',
  'operator.authenticate',
  'session.list',
  'session.inspect',
  'turn.execute',
  'turn.inspect',
  'turn.interrupt',
  'turn.resolve_indeterminate',
  'session.compact',
  'session.reset',
  'event.read',
] as const)

const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DAEMON_RECOVERIES_BY_ROOT = new Map<string, Promise<void>>()

interface ListResponse {
  readonly sessions: ResidentSessionSnapshot[]
}

interface ProviderResponse {
  readonly providers: ResidentProviderStatus[]
}

interface HandshakeResponse {
  readonly protocolVersion: number
  readonly stateSchemaVersion: number
  readonly daemonInstanceId: string
  readonly buildCommit: string
  readonly methods: string[]
  readonly driverManifestSha256: string
}

const HANDSHAKE_FAILURE = Symbol('resident handshake failure')

type HandshakeFailure = Error & {
  readonly [HANDSHAKE_FAILURE]: true
  readonly error: Error
  readonly daemonPid?: number
}

function markHandshakeFailure(error: unknown, daemonPid: number | undefined): HandshakeFailure {
  return Object.assign(new Error(`resident daemon handshake failed: ${errorMessage(error)}`), {
    [HANDSHAKE_FAILURE]: true as const,
    error: toThrowable(error),
    ...daemonPid === undefined ? {} : { daemonPid },
  })
}

function unwrapHandshakeFailure(error: unknown): HandshakeFailure | undefined {
  if (error === null || typeof error !== 'object') return undefined
  return HANDSHAKE_FAILURE in error && (error as Partial<HandshakeFailure>)[HANDSHAKE_FAILURE] === true
    ? error as HandshakeFailure
    : undefined
}

class DaemonQualificationError extends ResidentOperatorError {
  constructor(message: string, code: string, readonly daemonInstanceId: string) {
    super(message, code)
    this.name = 'DaemonQualificationError'
  }
}

/** Read the stable cross-package error code without relying on instanceof. */
function residentErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const code = (error as { readonly code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error !== null && typeof error === 'object') {
    const message = (error as { readonly message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** Preserve stable codes while making arbitrary thrown values legal to rethrow. */
function toThrowable(error: unknown): Error {
  if (error instanceof Error) return error
  const normalized = new Error(errorMessage(error))
  const code = residentErrorCode(error)
  if (code !== undefined) Object.assign(normalized, { code })
  return normalized
}

function isDaemonQualificationMismatch(error: unknown): boolean {
  const code = residentErrorCode(error)
  return code === 'PROTOCOL_MISMATCH' || code === 'PROVIDER_VERSION_MISMATCH'
}

/** Connection, startup, and polling policy for one daemon client. */
export interface ResidentClientOptions {
  readonly root: string
  readonly autoStart: boolean
  readonly connectTimeoutMs: number
  readonly pollIntervalMs: number
  readonly driverModules?: readonly string[]
}

/**
 * Wait for one local daemon control path to disappear after graceful shutdown.
 * @param socketPath - control path owned by the retiring daemon.
 * @param timeoutMs - maximum shutdown interval.
 * @param platform - platform override used by cross-platform contract tests.
 * @returns whether the path disappeared before the timeout.
 */
export async function waitForDaemonSocketRelease(
  socketPath: string,
  timeoutMs: number,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  if (!localIpcUsesFilesystem(platform)) {
    while (await localIpcReachable(socketPath, Math.max(1, Math.min(50, deadline - Date.now())))) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
    }
    return true
  }
  while (existsSync(socketPath)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
  }
  return true
}

function localIpcReachable(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    let settled = false
    const finish = (reachable: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(reachable)
    }
    const timer = setTimeout(() => { finish(false) }, timeoutMs)
    socket.once('connect', () => { finish(true) })
    socket.once('error', () => { finish(false) })
  })
}

/** Stateless-per-request Unix-socket client for trusted Resident consumers. */
export class ResidentDaemonClient {
  /** Resolved daemon control socket path. */
  readonly socketPath: string
  private readiness: Promise<void> | undefined
  private readonly recoveryKey: string

  constructor(private readonly options: ResidentClientOptions) {
    this.socketPath = localIpcAddress(options.root, 'control')
    this.recoveryKey = resolve(options.root)
  }

  /**
   * Connect to and strictly qualify a compatible daemon, starting it when configured.
   * @returns after protocol, schema, build, and method validation succeeds.
   */
  ready(): Promise<void> {
    this.readiness ??= this.ensureReady().catch((error: unknown) => {
      this.readiness = undefined
      throw error
    })
    return this.readiness
  }

  /**
   * Read current native product qualification snapshots.
   * @returns one status per configured product Driver.
   */
  async providers(): Promise<ResidentProviderStatus[]> {
    return (await this.request<ProviderResponse>('operator.list', {})).providers
  }

  /**
   * Start one explicit owner-local native-subscription login flow.
   * @param operatorId - configured native product operator identity.
   * @returns refreshed Provider qualification after the owner action.
   */
  authenticate(operatorId: string): Promise<ResidentProviderStatus> {
    return this.request('operator.authenticate', { operator_id: operatorId })
  }

  /**
   * List daemon-owned Resident Sessions.
   * @returns current Session snapshots in daemon order.
   */
  async list(): Promise<ResidentSessionSnapshot[]> {
    return (await this.request<ListResponse>('session.list', {})).sessions
  }

  /**
   * Inspect one Resident Session.
   * @param sessionId - opaque Session identity.
   * @returns its current daemon projection.
   */
  inspect(sessionId: string): Promise<ResidentSessionSnapshot> {
    return this.request('session.inspect', { session_id: sessionId })
  }

  /**
   * Inspect one durable turn after the original caller disconnected.
   * @param turnId - daemon turn identity from execution, Session projection, or events.
   * @returns current receipt state and bounded terminal result when available.
   */
  inspectTurn(turnId: string): Promise<ResidentTurnSnapshot> {
    return this.request('turn.inspect', { turn_id: turnId })
  }

  /**
   * Admit or replay one durable command and poll its result.
   * @param request - command identity, retry lineage, operator, workspace, prompt, and signal.
   * @returns holder-owned raw turn identities, revision, result, and disposal.
   */
  async execute(request: {
    commandId: string
    supersedesCommandId?: string
    operatorId: string
    workspace: string
    laneId?: string
    taskLabel?: string
    prompt: readonly unknown[]
    systemPrompt?: string
    profile?: PhysicalOperatorExecutionPreference
    modelToolBridge?: PhysicalOperatorModelToolBridgeV1
    nativeToolPolicy?: PhysicalOperatorNativeToolPolicy
    signal: AbortSignal
  }): Promise<{
    turnId: string
    sessionId: string
    stateRevision: number
    result: Promise<ResidentTurnResult>
    dispose: () => Promise<void>
  }> {
    const workspace = await realpath(request.workspace).catch(() => {
      throw new ResidentOperatorError(`resident workspace does not exist: ${request.workspace}`, 'WORKSPACE_INVALID')
    })
    const accepted = await this.request<AcceptedTurn>('turn.execute', {
      command_id: request.commandId,
      ...request.supersedesCommandId === undefined ? {} : { supersedes_command_id: request.supersedesCommandId },
      operator_id: request.operatorId,
      workspace,
      lane_id: request.laneId ?? 'legacy',
      ...request.taskLabel === undefined ? {} : { task_label: request.taskLabel },
      prompt: request.prompt,
      ...request.systemPrompt === undefined ? {} : { system_prompt: request.systemPrompt },
      ...request.profile === undefined ? {} : { profile: request.profile },
      ...request.modelToolBridge === undefined ? {} : { model_tool_bridge: request.modelToolBridge },
      native_tool_policy: request.nativeToolPolicy ?? 'inherit',
    }, request.signal)
    let settled = false
    const observation = new AbortController()
    const detach = (): void => {
      observation.abort(request.signal.reason ?? new Error('resident caller detached'))
    }
    if (request.signal.aborted) detach()
    else request.signal.addEventListener('abort', detach, { once: true })
    const result = this.poll(accepted.turnId, observation.signal).finally(() => {
      settled = true
      request.signal.removeEventListener('abort', detach)
    })
    return {
      turnId: accepted.turnId,
      sessionId: accepted.sessionId,
      stateRevision: accepted.stateRevision,
      result,
      dispose: async () => {
        if (!settled) observation.abort(new Error('resident caller disposed'))
        await result.catch(() => {})
      },
    }
  }

  /**
   * Read one bounded page of structured Resident events.
   * @param sessionId - Session whose events to read.
   * @param afterSequence - exclusive event cursor.
   * @param limit - maximum event count.
   * @param signal - optional cancellation channel.
   * @returns ordered events and the next cursor.
   */
  readEvents(sessionId: string, afterSequence = 0, limit = 100, signal?: AbortSignal): Promise<ResidentEventPage> {
    return this.request('event.read', {
      session_id: sessionId,
      after_sequence: afterSequence,
      limit,
    }, signal)
  }

  /**
   * Interrupt one active turn after Session ownership validation.
   * @param sessionId - owning Session identity.
   * @param turnId - active turn identity.
   * @returns after the daemon accepts the interrupt.
   */
  interrupt(sessionId: string, turnId: string): Promise<void> {
    return this.request('turn.interrupt', { session_id: sessionId, turn_id: turnId }).then(() => undefined)
  }

  /**
   * Compact one idle native Session in place under optimistic concurrency.
   * @param request - durable command, Session revision, and optional native guidance.
   * @returns the revised idle Session snapshot.
   */
  compact(request: {
    readonly commandId: string
    readonly sessionId: string
    readonly expectedStateRevision: number
    readonly instructions?: string
  }): Promise<ResidentCompactResult> {
    return this.request('session.compact', {
      command_id: request.commandId,
      session_id: request.sessionId,
      expected_state_revision: request.expectedStateRevision,
      ...request.instructions === undefined ? {} : { instructions: request.instructions },
    })
  }

  /**
   * Replace an idle Session's native association under optimistic concurrency.
   * @param sessionId - Session to reset.
   * @param expectedStateRevision - exact revision the caller inspected.
   * @param reason - bounded audit reason.
   * @returns the revised Session snapshot.
   */
  reset(sessionId: string, expectedStateRevision: number, reason: string): Promise<ResidentSessionSnapshot> {
    return this.request('session.reset', {
      session_id: sessionId,
      expected_state_revision: expectedStateRevision,
      reason,
    })
  }

  /**
   * Explicitly abandon one indeterminate command.
   * @param commandId - indeterminate durable command identity.
   * @param expectedStateRevision - exact owning Session revision.
   * @returns after the resolution is committed.
   */
  resolveIndeterminate(commandId: string, expectedStateRevision: number): Promise<void> {
    return this.request('turn.resolve_indeterminate', {
      command_id: commandId,
      expected_state_revision: expectedStateRevision,
      decision: 'abandon',
    }).then(() => undefined)
  }

  /**
   * Ask the daemon to stop admission and drain accepted turns.
   * @returns after the drain request is accepted, before process exit.
   */
  shutdown(): Promise<void> {
    return this.request('system.shutdown', {}).then(() => undefined)
  }

  private async poll(turnId: string, signal: AbortSignal): Promise<ResidentTurnResult> {
    for (;;) {
      signal.throwIfAborted()
      const inspection = await this.request<TurnInspection>('turn.inspect', { turn_id: turnId }, signal)
      if (inspection.state === 'settled') {
        if (inspection.error !== undefined) {
          throw new ResidentOperatorError(inspection.error.message, inspection.error.code)
        }
        if (inspection.result === undefined) {
          throw new ResidentOperatorError(`resident turn ${turnId} settled without a result`, 'INVALID_RESULT')
        }
        return inspection.result
      }
      if (inspection.state === 'indeterminate') {
        throw new ResidentOperatorError(
          inspection.error?.message ?? `resident turn ${turnId} is indeterminate`,
          'COMMAND_INDETERMINATE',
        )
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        }, this.options.pollIntervalMs)
        const abort = (): void => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
          reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
        }
        signal.addEventListener('abort', abort, { once: true })
      })
    }
  }

  private async ensureReady(): Promise<void> {
    const existingRecovery = DAEMON_RECOVERIES_BY_ROOT.get(this.recoveryKey)
    if (existingRecovery !== undefined) {
      await existingRecovery
      await this.handshake()
      return
    }
    const daemonPid = this.daemonPid()
    let initialError: unknown
    try {
      await this.handshake()
      return
    } catch (error) {
      initialError = error
      if (!this.options.autoStart) throw error
    }
    if (isDaemonQualificationMismatch(initialError)) {
      await this.recoverIncompatibleDaemon(initialError, daemonPid)
      return
    }
    await this.startAndWaitForReady()
  }

  /** Start the configured detached daemon and wait for one compatible handshake. */
  private async startAndWaitForReady(): Promise<void> {
    startDetachedResidentDaemon(this.options.root, this.options.driverModules ?? [])
    const deadline = Date.now() + this.options.connectTimeoutMs
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await this.handshake()
        return
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    throw new ResidentOperatorError(
      `resident daemon did not become ready: ${errorMessage(lastError)}`,
      'RUNTIME_UNAVAILABLE',
    )
  }

  /** Serialize one safe old-daemon retirement and replacement across callers. */
  private async recoverIncompatibleDaemon(initialError: unknown, daemonPid: number | undefined): Promise<void> {
    this.readiness = undefined
    const existingRecovery = DAEMON_RECOVERIES_BY_ROOT.get(this.recoveryKey)
    if (existingRecovery !== undefined) {
      await existingRecovery
      await this.handshake()
      this.readiness ??= Promise.resolve()
      return
    }
    const recovery = (async () => {
      const retired = await this.retireIncompatibleDaemon(initialError, daemonPid)
      if (retired) await this.startAndWaitForReady()
    })()
    DAEMON_RECOVERIES_BY_ROOT.set(this.recoveryKey, recovery)
    try {
      await recovery
    } finally {
      if (DAEMON_RECOVERIES_BY_ROOT.get(this.recoveryKey) === recovery) {
        DAEMON_RECOVERIES_BY_ROOT.delete(this.recoveryKey)
      }
    }
    this.readiness ??= Promise.resolve()
  }

  /** Drain an older detached daemon before starting the protocol/schema-compatible build. */
  private async retireIncompatibleDaemon(initialError: unknown, observedPid: number | undefined): Promise<boolean> {
    if (observedPid === undefined) {
      throw new ResidentOperatorError(
        `resident daemon upgrade is blocked because its process identity is unavailable: ${errorMessage(initialError)}`,
        'PROTOCOL_MISMATCH',
      )
    }
    const currentPid = this.daemonPid()
    if (currentPid === undefined) {
      if (!localIpcUsesFilesystem() || existsSync(this.socketPath)) {
        throw new ResidentOperatorError(
          `resident daemon upgrade is blocked because its process identity disappeared: ${errorMessage(initialError)}`,
          'PROTOCOL_MISMATCH',
        )
      }
      return true
    }
    if (currentPid !== observedPid) {
      await this.handshake()
      return false
    }
    const expectedInstanceId = initialError instanceof DaemonQualificationError
      ? initialError.daemonInstanceId
      : `legacy-protocol-pid-${observedPid}`
    try {
      const response = await this.rawRequest<{ readonly draining: boolean; readonly replaced?: boolean }>(
        'system.shutdown',
        {
          expected_daemon_pid: observedPid,
          expected_daemon_instance_id: expectedInstanceId,
        },
      )
      if (response.replaced === true) {
        await this.handshake()
        return false
      }
    } catch (shutdownError) {
      if (!localIpcUsesFilesystem() || existsSync(this.socketPath)) {
        throw new ResidentOperatorError(
          `resident daemon upgrade is blocked: ${errorMessage(initialError)}; shutdown failed: ${errorMessage(shutdownError)}`,
          'PROTOCOL_MISMATCH',
        )
      }
      return true
    }
    if (!await waitForDaemonSocketRelease(this.socketPath, this.options.connectTimeoutMs)) {
      throw new ResidentOperatorError(
        `resident daemon upgrade is blocked because the old daemon did not drain: ${errorMessage(initialError)}`,
        'PROTOCOL_MISMATCH',
      )
    }
    return true
  }

  private handshakeParams(): object {
    return {
      protocol_version: RESIDENT_PROTOCOL_VERSION,
      state_schema_version: RESIDENT_STATE_SCHEMA_VERSION,
      driver_manifest_sha256: residentDriverManifestSha256(this.options.driverModules ?? []),
    }
  }

  private async handshake(): Promise<void> {
    const response = await this.rawRequest<HandshakeResponse>('system.handshake', this.handshakeParams())
    this.validateHandshake(response)
  }

  private async handshakeOnTransport(transport: JsonRpcLineTransport): Promise<void> {
    const response = unwrapWire(await transport.request('system.handshake', this.handshakeParams())) as HandshakeResponse
    this.validateHandshake(response)
  }

  private validateHandshake(response: HandshakeResponse): void {
    if (typeof response.daemonInstanceId !== 'string' || response.daemonInstanceId.length === 0) {
      throw new ResidentOperatorError('resident daemon handshake is missing its instance identity', 'PROTOCOL_MISMATCH')
    }
    if (response.protocolVersion !== RESIDENT_PROTOCOL_VERSION
      || response.stateSchemaVersion !== RESIDENT_STATE_SCHEMA_VERSION) {
      throw new DaemonQualificationError(
        'resident daemon protocol or state schema mismatch',
        'PROTOCOL_MISMATCH',
        response.daemonInstanceId,
      )
    }
    const expectedBuildCommit = process.env.DSH_BUILD_COMMIT ?? 'development'
    if (response.buildCommit !== expectedBuildCommit) {
      throw new DaemonQualificationError(
        `resident daemon build ${response.buildCommit} does not match client ${expectedBuildCommit}`,
        'PROVIDER_VERSION_MISMATCH',
        response.daemonInstanceId,
      )
    }
    const expectedDriverManifest = residentDriverManifestSha256(this.options.driverModules ?? [])
    if (response.driverManifestSha256 !== expectedDriverManifest) {
      throw new DaemonQualificationError(
        `resident daemon Driver manifest ${response.driverManifestSha256} does not match client ${expectedDriverManifest}`,
        'PROVIDER_VERSION_MISMATCH',
        response.daemonInstanceId,
      )
    }
    if (!Array.isArray(response.methods)
      || REQUIRED_METHODS.some(method => !response.methods.includes(method))) {
      throw new ResidentOperatorError('resident daemon does not support the required method set', 'PROTOCOL_MISMATCH')
    }
  }

  private async request<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    await this.ready()
    let retried = false
    for (;;) {
      try {
        return await this.requestWithHandshake<T>(method, params, signal)
      } catch (error) {
        const handshakeFailure = unwrapHandshakeFailure(error)
        if (handshakeFailure === undefined) throw error
        if (retried || !this.options.autoStart || !isDaemonQualificationMismatch(handshakeFailure.error)) {
          throw handshakeFailure.error
        }
        retried = true
        await this.recoverIncompatibleDaemon(handshakeFailure.error, handshakeFailure.daemonPid)
      }
    }
  }

  private async requestWithHandshake<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    const daemonPid = this.daemonPid()
    return this.withTransport(async (transport) => {
      let handshakeComplete = false
      try {
        await this.handshakeOnTransport(transport)
        handshakeComplete = true
        return unwrapWire(await transport.request(method, params, signal)) as T
      } catch (error) {
        if (!handshakeComplete) throw markHandshakeFailure(error, daemonPid)
        throw error
      }
    })
  }

  private async rawRequest<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    return this.withTransport(async transport => unwrapWire(await transport.request(method, params, signal)) as T)
  }

  private async withTransport<T>(callback: (transport: JsonRpcLineTransport) => Promise<T>): Promise<T> {
    const socket = createConnection(this.socketPath)
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`resident daemon connection timed out after ${this.options.connectTimeoutMs}ms`))
    }, this.options.connectTimeoutMs)
    try {
      await connected
      clearTimeout(timeout)
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.start()
      try {
        return await callback(transport)
      } finally {
        transport.close()
      }
    } finally {
      clearTimeout(timeout)
      socket.end()
    }
  }

  private daemonPid(): number | undefined {
    try {
      const value = Number(readFileSync(join(this.options.root, 'daemon.pid'), 'utf8').trim())
      return Number.isSafeInteger(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Start a daemon process that is independent of the current DSH lifecycle.
 * @param root - owner-only daemon state root.
 * @param driverModules - absolute independent product Driver entries loaded by the daemon.
 * @returns detached child process id.
 */
export function startDetachedResidentDaemon(root: string, driverModules: readonly string[] = []): number {
  const builtEntry = fileURLToPath(new URL('./startup.js', import.meta.url))
  const sourceEntry = fileURLToPath(new URL('./startup.ts', import.meta.url))
  const entry = existsSync(builtEntry) ? builtEntry : sourceEntry
  const driverArgs = driverModules.flatMap(module => ['--driver-module', module])
  const child = spawn(process.execPath, [...process.execArgv, entry, '--root', root, ...driverArgs], {
    detached: true,
    stdio: 'ignore',
    env: residentDaemonEnvironment(process.env, process.versions.electron),
  })
  child.unref()
  if (child.pid === undefined) {
    throw new ResidentOperatorError('resident daemon process did not publish a pid', 'RUNTIME_UNAVAILABLE')
  }
  return child.pid
}

/**
 * Build the detached daemon environment without changing the current host.
 * Electron must re-enter its executable in Node mode for the daemon entry;
 * ordinary Node hosts must remove any inherited marker instead of forwarding it.
 * @param environment - host environment to copy.
 * @param electronVersion - Electron runtime marker, injectable for focused tests.
 * @returns a fresh child-only environment.
 */
export function residentDaemonEnvironment(
  environment: NodeJS.ProcessEnv,
  electronVersion: string | undefined,
): NodeJS.ProcessEnv {
  const childEnvironment = { ...environment }
  for (const key of Object.keys(childEnvironment)) {
    if (key.toUpperCase() === ELECTRON_RUN_AS_NODE) Reflect.deleteProperty(childEnvironment, key)
  }
  if (electronVersion !== undefined && electronVersion.length > 0) {
    childEnvironment[ELECTRON_RUN_AS_NODE] = '1'
  }
  return childEnvironment
}

/**
 * Brand one daemon-returned Session identity for the Service Definition.
 * @param id - raw Session identity.
 * @returns branded Session identity.
 */
export function brandedSession(id: string): ReturnType<typeof ResidentOperatorSessionId> {
  return ResidentOperatorSessionId(id)
}

/**
 * Brand one daemon-returned turn identity for the Service Definition.
 * @param id - raw turn identity.
 * @returns branded turn identity.
 */
export function brandedTurn(id: string): ReturnType<typeof ResidentOperatorTurnId> {
  return ResidentOperatorTurnId(id)
}
