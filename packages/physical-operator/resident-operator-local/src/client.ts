/** Unix-socket resident daemon client and polling turn handle. @module @deepseek-ai/dsh-resident-operator-local/client */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { PhysicalOperatorExecutionPreference } from '@deepseek-ai/dsh-physical-operator'
import {
  ResidentOperatorError,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  RESIDENT_PROTOCOL_VERSION,
  RESIDENT_STATE_SCHEMA_VERSION,
  type ResidentEventPage,
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
  'session.list',
  'session.inspect',
  'turn.execute',
  'turn.inspect',
  'turn.interrupt',
  'turn.resolve_indeterminate',
  'session.reset',
  'event.read',
] as const)

const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

interface ListResponse {
  readonly sessions: ResidentSessionSnapshot[]
}

interface ProviderResponse {
  readonly providers: ResidentProviderStatus[]
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
 * @returns whether the path disappeared before the timeout.
 */
export async function waitForDaemonSocketRelease(socketPath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (existsSync(socketPath)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) return false
    await new Promise(resolve => setTimeout(resolve, Math.min(50, remaining)))
  }
  return true
}

/** Stateless-per-request Unix-socket client for trusted Resident consumers. */
export class ResidentDaemonClient {
  /** Resolved daemon control socket path. */
  readonly socketPath: string
  private readiness: Promise<void> | undefined

  constructor(private readonly options: ResidentClientOptions) {
    this.socketPath = `${options.root}/control.sock`
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
    profile?: PhysicalOperatorExecutionPreference
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
      ...request.profile === undefined ? {} : { profile: request.profile },
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
    let initialError: unknown
    try {
      await this.handshake()
      return
    } catch (error) {
      initialError = error
      if (!this.options.autoStart) throw error
    }
    if (initialError instanceof ResidentOperatorError
      && (initialError.code === 'PROTOCOL_MISMATCH' || initialError.code === 'PROVIDER_VERSION_MISMATCH')) {
      await this.retireIncompatibleDaemon(initialError)
    }
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
      `resident daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      'RUNTIME_UNAVAILABLE',
    )
  }

  /** Drain an older detached daemon before starting the protocol/schema-compatible build. */
  private async retireIncompatibleDaemon(initialError: ResidentOperatorError): Promise<void> {
    try {
      await this.rawRequest('system.shutdown', {})
    } catch (shutdownError) {
      if (existsSync(this.socketPath)) {
        throw new ResidentOperatorError(
          `resident daemon upgrade is blocked: ${initialError.message}; shutdown failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
          'PROTOCOL_MISMATCH',
        )
      }
      return
    }
    if (!await waitForDaemonSocketRelease(this.socketPath, this.options.connectTimeoutMs)) {
      throw new ResidentOperatorError(
        `resident daemon upgrade is blocked because the old daemon did not drain: ${initialError.message}`,
        'PROTOCOL_MISMATCH',
      )
    }
  }

  private async handshake(): Promise<void> {
    const response = await this.rawRequest<{
      protocolVersion: number
      stateSchemaVersion: number
      buildCommit: string
      methods: string[]
      driverManifestSha256: string
    }>('system.handshake', {
      protocol_version: RESIDENT_PROTOCOL_VERSION,
      state_schema_version: RESIDENT_STATE_SCHEMA_VERSION,
      driver_manifest_sha256: residentDriverManifestSha256(this.options.driverModules ?? []),
    })
    if (response.protocolVersion !== RESIDENT_PROTOCOL_VERSION
      || response.stateSchemaVersion !== RESIDENT_STATE_SCHEMA_VERSION) {
      throw new ResidentOperatorError('resident daemon protocol or state schema mismatch', 'PROTOCOL_MISMATCH')
    }
    const expectedBuildCommit = process.env.DSH_BUILD_COMMIT ?? 'development'
    if (response.buildCommit !== expectedBuildCommit) {
      throw new ResidentOperatorError(
        `resident daemon build ${response.buildCommit} does not match client ${expectedBuildCommit}`,
        'PROVIDER_VERSION_MISMATCH',
      )
    }
    const expectedDriverManifest = residentDriverManifestSha256(this.options.driverModules ?? [])
    if (response.driverManifestSha256 !== expectedDriverManifest) {
      throw new ResidentOperatorError(
        `resident daemon Driver manifest ${response.driverManifestSha256} does not match client ${expectedDriverManifest}`,
        'PROVIDER_VERSION_MISMATCH',
      )
    }
    if (!Array.isArray(response.methods)
      || REQUIRED_METHODS.some(method => !response.methods.includes(method))) {
      throw new ResidentOperatorError('resident daemon does not support the required method set', 'PROTOCOL_MISMATCH')
    }
  }

  private async request<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
    await this.ready()
    return this.rawRequest(method, params, signal)
  }

  private async rawRequest<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
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
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.start()
      try {
        return unwrapWire(await transport.request(method, params, signal)) as T
      } finally {
        transport.close()
      }
    } finally {
      clearTimeout(timeout)
      socket.end()
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
