/** Local resident-operatord JSON-RPC server and lifecycle authority. @module @deepseek-ai/dsh-resident-operator-local/daemon */

import { chmodSync, closeSync, existsSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  PhysicalOperatorExecutionPreference,
  PhysicalOperatorReasoningEffort,
} from '@deepseek-ai/dsh-physical-operator'
import {
  ResidentOperatorError,
  RESIDENT_PROTOCOL_VERSION,
  RESIDENT_STATE_SCHEMA_VERSION,
  type ResidentProviderStatus,
  type ResidentProductDriver,
} from '@deepseek-ai/dsh-resident-operator'
import {
  ClaudeCodeResidentDriver,
  CodexResidentDriver,
  EXPECTED_CLAUDE_CLI_VERSION,
  EXPECTED_CODEX_CLI_VERSION,
  EXPECTED_CODEX_SCHEMA_SHA256,
} from './drivers.ts'
import { residentDriverManifestSha256 } from './driver-modules.ts'
import { wireFailure, wireSuccess } from './protocol.ts'
import { canonicalRequestHash, ResidentStore } from './store.ts'
import { resolveResidentExecutionProfile } from './profile.ts'

/** Public protocol-v6 method set advertised by daemon handshake. */
export const RESIDENT_METHODS = Object.freeze([
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

interface ActiveTurn {
  readonly commandId: string
  readonly controller: AbortController
  readonly done: Promise<void>
}

/** Construction inputs for one independent local daemon. */
export interface ResidentDaemonOptions {
  readonly root: string
  readonly buildCommit?: string
  readonly drivers?: readonly ResidentProductDriver[]
  readonly driverManifestHash?: string
  readonly heartbeatIntervalMs?: number
}

/**
 * Normalize trusted product Driver failures at the daemon authority boundary.
 *
 * This boundary classification is intentionally duplicated from product-level
 * parsing so bundled class identity or a Driver regression cannot collapse an
 * actionable native-subscription failure into a generic result error.
 *
 * @param error Driver failure caught by the daemon.
 * @param aborted Whether caller-owned interruption was already requested.
 * @returns One stable Resident protocol error for durable receipt storage.
 */
export function normalizeResidentDriverError(error: unknown, aborted: boolean): ResidentOperatorError {
  const message = error instanceof Error ? error.message : String(error)
  if (/claude code.*(?:oauth access token has expired|re-authenticate to continue|\b401\b)/isu.test(message)) {
    return new ResidentOperatorError(
      'Claude Code subscription authentication expired; run `claude auth login` and retry the node.',
      'AUTH_MODE_MISMATCH',
    )
  }
  if (/claude code.*(?:certificate verification|unable to connect to api)/isu.test(message)) {
    return new ResidentOperatorError(message, 'RUNTIME_UNAVAILABLE')
  }
  const codexTransportFailure = /subagent-codex.*stream disconnected before completion/isu.test(message)
    || /subagent-codex.*error sending request for url/isu.test(message)
    || /subagent-codex.*app-server protocol stream closed/isu.test(message)
    || /subagent-codex.*\b(?:ECONNRESET|ETIMEDOUT|EPIPE)\b/isu.test(message)
  if (codexTransportFailure) {
    return new ResidentOperatorError(message, 'RUNTIME_UNAVAILABLE')
  }
  if (error instanceof ResidentOperatorError) return error
  return new ResidentOperatorError(message, aborted ? 'RUNTIME_UNAVAILABLE' : 'INVALID_RESULT')
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ResidentOperatorError(`resident protocol requires non-empty ${name}`, 'INVALID_RESULT')
  }
  return value
}

function taskLabelParam(params: Record<string, unknown>): string | undefined {
  const value = params.task_label
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ResidentOperatorError('resident protocol task_label must be a string', 'INVALID_RESULT')
  }
  const normalized = value.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized.length === 0) return undefined
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)
  return Array.from(graphemes, part => part.segment).slice(0, 160).join('')
}

function integerParam(params: Record<string, unknown>, name: string): number {
  const value = params[name]
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ResidentOperatorError(`resident protocol requires non-negative integer ${name}`, 'INVALID_RESULT')
  }
  return Number(value)
}

function promptParam(params: Record<string, unknown>): ContentBlock[] {
  const value = params.prompt
  if (!Array.isArray(value) || value.length === 0) {
    throw new ResidentOperatorError('resident protocol prompt must be a non-empty array', 'INVALID_RESULT')
  }
  return value.map((block, index) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      throw new ResidentOperatorError(`resident prompt block ${index} must be an object`, 'INVALID_RESULT')
    }
    const record = block as Record<string, unknown>
    if (record.type !== 'text' || typeof record.text !== 'string') {
      throw new ResidentOperatorError(`resident prompt block ${index} must be a text block`, 'INVALID_RESULT')
    }
    return { type: 'text', text: record.text }
  })
}

const PROFILE_EFFORTS = new Set<PhysicalOperatorReasoningEffort>([
  'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
])

function profileParam(params: Record<string, unknown>): PhysicalOperatorExecutionPreference | undefined {
  const value = params.profile
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResidentOperatorError('resident protocol profile must be an object', 'INVALID_RESULT')
  }
  const record = value as Record<string, unknown>
  const model = record.model
  const effort = record.effort
  if (model !== undefined && (typeof model !== 'string' || model.length === 0 || model.trim() !== model)) {
    throw new ResidentOperatorError('resident protocol profile.model must be non-blank and trimmed', 'INVALID_RESULT')
  }
  if (effort !== undefined && (typeof effort !== 'string' || !PROFILE_EFFORTS.has(effort as PhysicalOperatorReasoningEffort))) {
    throw new ResidentOperatorError('resident protocol profile.effort is unsupported', 'INVALID_RESULT')
  }
  if (model === undefined && effort === undefined) return undefined
  return {
    ...model === undefined ? {} : { model },
    ...effort === undefined ? {} : { effort: effort as PhysicalOperatorReasoningEffort },
  }
}

function safeDiagnostic(message: string, prompt: readonly ContentBlock[]): string {
  let value = message
  for (const block of prompt) {
    if (block.type === 'text' && block.text.length > 0) {
      value = value.replaceAll(block.text, '[REDACTED_PROMPT]')
    }
  }
  value = value
    .replace(/\bBearer\s+(?:[A-Z0-9._~+/=]|-)+/giu, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, '[REDACTED_TOKEN]')
    .replace(/\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*\S+/giu, '[REDACTED_CREDENTIAL]')
  return value.slice(0, 8_192)
}

function unavailableProviderCode(status: ResidentProviderStatus): string {
  if (status.authentication !== 'native-subscription') return 'AUTH_MODE_MISMATCH'
  if (status.product === 'claude-code' && status.productVersion !== EXPECTED_CLAUDE_CLI_VERSION) {
    return 'PROVIDER_VERSION_MISMATCH'
  }
  if (status.product === 'codex'
    && (status.productVersion !== EXPECTED_CODEX_CLI_VERSION
      || status.protocolHash !== EXPECTED_CODEX_SCHEMA_SHA256)) {
    return 'PROVIDER_VERSION_MISMATCH'
  }
  return 'RUNTIME_UNAVAILABLE'
}

/** Single-writer Resident lifecycle authority over local JSON-RPC and SQLite. */
export class ResidentDaemon {
  /** Owner-only Unix control socket path. */
  readonly socketPath: string
  /** Daemon-owned durable store; exposed for local diagnostics and recovery tests. */
  readonly store: ResidentStore
  private readonly server: Server
  private readonly drivers = new Map<string, ResidentProductDriver>()
  private readonly driverManifestHash: string
  private readonly transports = new Set<JsonRpcLineTransport>()
  private readonly sockets = new Set<Socket>()
  private readonly active = new Map<string, ActiveTurn>()
  private readonly qualifications = new Map<string, Promise<ResidentProviderStatus>>()
  private lockDescriptor: number | undefined
  private closing = false
  private readonly closedResolver = Promise.withResolvers<void>()
  /** Settles after socket, store, pid, and lock cleanup complete. */
  readonly closed = this.closedResolver.promise

  constructor(private readonly options: ResidentDaemonOptions) {
    this.socketPath = join(options.root, 'control.sock')
    this.store = new ResidentStore(options.root)
    for (const driver of options.drivers ?? [new ClaudeCodeResidentDriver(), new CodexResidentDriver()]) {
      if (this.drivers.has(driver.operatorId)) {
        throw new Error(`duplicate resident driver ${driver.operatorId}`)
      }
      this.drivers.set(driver.operatorId, driver)
    }
    this.driverManifestHash = options.driverManifestHash ?? residentDriverManifestSha256([])
    this.server = createServer((socket) => { this.acceptSocket(socket) })
  }

  /**
   * Acquire single-instance ownership and begin listening.
   * @returns after the owner-only socket and pid are published.
   */
  async start(): Promise<void> {
    this.acquireLock()
    this.removeStaleSocket()
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.socketPath, () => {
        this.server.off('error', onError)
        chmodSync(this.socketPath, 0o600)
        writeFileSync(join(this.options.root, 'daemon.pid'), `${process.pid}\n`, { mode: 0o600 })
        resolve()
      })
    })
  }

  /**
   * Stop new admission, drain active turns, and release all daemon resources.
   * @returns after durable state and process markers are closed.
   */
  async close(): Promise<void> {
    if (this.closing) return this.closed
    this.closing = true
    // Graceful administration drains admitted turns. A process-level forced
    // stop leaves their receipts for startup recovery as indeterminate.
    await Promise.allSettled([...this.active.values()].map(turn => turn.done))
    for (const transport of this.transports) transport.close()
    for (const socket of this.sockets) socket.end()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    this.store.close()
    this.safeUnlink(this.socketPath)
    this.safeUnlink(join(this.options.root, 'daemon.pid'))
    this.releaseLock()
    this.closedResolver.resolve()
  }

  private acceptSocket(socket: Socket): void {
    socket.setEncoding('utf8')
    const transport = new JsonRpcLineTransport(socket, socket)
    this.transports.add(transport)
    this.sockets.add(socket)
    transport.onRequest(async (method, params) => {
      try {
        return wireSuccess(await this.dispatch(method, params))
      } catch (error) {
        return wireFailure(error)
      }
    })
    const remove = (): void => {
      transport.close()
      this.transports.delete(transport)
      this.sockets.delete(socket)
    }
    socket.once('close', remove)
    socket.once('error', remove)
    transport.start()
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'system.handshake':
        return this.handshake(params)
      case 'operator.list': {
        const providers = await this.providerStatuses()
        return { providers, sessions: this.store.list() }
      }
      case 'session.list':
        return { sessions: this.store.list() }
      case 'session.inspect':
        return this.store.inspectSession(stringParam(params, 'session_id'))
      case 'turn.execute':
        return this.execute(params)
      case 'turn.inspect':
        return this.store.inspectTurn(stringParam(params, 'turn_id'))
      case 'turn.interrupt': {
        const sessionId = stringParam(params, 'session_id')
        const turnId = stringParam(params, 'turn_id')
        this.store.assertTurnSession(turnId, sessionId)
        const active = this.active.get(turnId)
        if (active !== undefined) active.controller.abort(new Error('resident turn interrupted'))
        return { interrupted: active !== undefined }
      }
      case 'turn.resolve_indeterminate': {
        if (params.decision !== 'abandon') {
          throw new ResidentOperatorError('protocol v4 only permits abandoning an indeterminate command', 'INVALID_RESULT')
        }
        this.store.resolveIndeterminate(
          stringParam(params, 'command_id'),
          integerParam(params, 'expected_state_revision'),
        )
        return { resolved: true }
      }
      case 'session.reset':
        return this.store.reset(
          stringParam(params, 'session_id'),
          integerParam(params, 'expected_state_revision'),
          stringParam(params, 'reason'),
        )
      case 'event.read':
        return this.store.readEvents(
          stringParam(params, 'session_id'),
          params.after_sequence === undefined ? 0 : integerParam(params, 'after_sequence'),
          params.limit === undefined ? 100 : integerParam(params, 'limit'),
        )
      case 'system.shutdown':
        setTimeout(() => { void this.close() }, 10)
        return { draining: true }
      default:
        throw new ResidentOperatorError(`resident protocol method not found: ${method}`, 'PROTOCOL_MISMATCH')
    }
  }

  private async handshake(params: Record<string, unknown>): Promise<unknown> {
    const requestedProtocol = integerParam(params, 'protocol_version')
    const requestedSchema = integerParam(params, 'state_schema_version')
    const requestedDriverManifest = stringParam(params, 'driver_manifest_sha256')
    if (requestedProtocol !== RESIDENT_PROTOCOL_VERSION || requestedSchema !== RESIDENT_STATE_SCHEMA_VERSION) {
      throw new ResidentOperatorError(
        `resident daemon protocol ${RESIDENT_PROTOCOL_VERSION}/schema ${RESIDENT_STATE_SCHEMA_VERSION} does not match client ${requestedProtocol}/${requestedSchema}`,
        'PROTOCOL_MISMATCH',
      )
    }
    if (requestedDriverManifest !== this.driverManifestHash) {
      throw new ResidentOperatorError(
        `resident daemon Driver manifest ${this.driverManifestHash} does not match client ${requestedDriverManifest}`,
        'PROVIDER_VERSION_MISMATCH',
      )
    }
    return {
      protocolVersion: RESIDENT_PROTOCOL_VERSION,
      stateSchemaVersion: RESIDENT_STATE_SCHEMA_VERSION,
      buildCommit: this.options.buildCommit ?? process.env.DSH_BUILD_COMMIT ?? 'development',
      driverManifestSha256: this.driverManifestHash,
      methods: RESIDENT_METHODS,
      providers: await this.providerStatuses(),
    }
  }

  private providerStatuses(): Promise<ResidentProviderStatus[]> {
    return Promise.all([...this.drivers.values()].map(driver => this.qualify(driver)))
  }

  private qualify(driver: ResidentProductDriver): Promise<ResidentProviderStatus> {
    const current = this.qualifications.get(driver.operatorId)
    if (current !== undefined) return current
    const pending = driver.qualify().finally(() => {
      if (this.qualifications.get(driver.operatorId) === pending) {
        this.qualifications.delete(driver.operatorId)
      }
    })
    this.qualifications.set(driver.operatorId, pending)
    return pending
  }

  private async execute(params: Record<string, unknown>): Promise<unknown> {
    if (this.closing) throw new ResidentOperatorError('resident daemon is draining', 'RUNTIME_UNAVAILABLE')
    const commandId = stringParam(params, 'command_id')
    const operatorId = stringParam(params, 'operator_id')
    const configuredWorkspace = stringParam(params, 'workspace')
    const laneId = stringParam(params, 'lane_id')
    const taskLabel = taskLabelParam(params)
    const prompt = promptParam(params)
    const requestedProfile = profileParam(params)
    const supersedesCommandId = params.supersedes_command_id === undefined
      ? undefined
      : stringParam(params, 'supersedes_command_id')
    const workspace = await realpath(configuredWorkspace).catch(() => {
      throw new ResidentOperatorError(`resident workspace does not exist: ${configuredWorkspace}`, 'WORKSPACE_INVALID')
    })
    const driver = this.drivers.get(operatorId)
    if (driver === undefined) {
      throw new ResidentOperatorError(`no resident provider for ${operatorId}`, 'SESSION_UNAVAILABLE')
    }
    const qualification = await this.qualify(driver)
    if (!qualification.available || qualification.authentication !== 'native-subscription') {
      throw new ResidentOperatorError(
        qualification.unavailableReason ?? `${operatorId} has no qualified subscription`,
        unavailableProviderCode(qualification),
      )
    }
    const locked = this.store.lockedProfile(operatorId, workspace, laneId)
    const resolved = locked !== undefined && requestedProfile === undefined
      ? locked
      : resolveResidentExecutionProfile(
        driver.operatorId,
        qualification.models,
        prompt,
        locked === undefined || requestedProfile === undefined
          ? requestedProfile
          : {
            model: requestedProfile.model ?? locked.profile.model,
            ...(requestedProfile.effort ?? locked.profile.effort) === undefined
              ? {}
              : { effort: requestedProfile.effort ?? locked.profile.effort },
          },
      )
    const requestHash = canonicalRequestHash(operatorId, workspace, prompt, resolved.profile, supersedesCommandId, laneId)
    const accepted = this.store.accept(
      commandId,
      requestHash,
      operatorId,
      workspace,
      resolved.profile,
      resolved.source,
      supersedesCommandId,
      taskLabel,
      laneId,
    )
    if (accepted.state === 'accepted' && !this.active.has(accepted.turnId)) {
      const controller = new AbortController()
      const done = this.runDriver(
        driver,
        commandId,
        accepted.sessionId,
        workspace,
        prompt,
        resolved.profile,
        controller,
      )
      this.active.set(accepted.turnId, { commandId, controller, done })
      void done.finally(() => { this.active.delete(accepted.turnId) })
    }
    return accepted
  }

  private async runDriver(
    driver: ResidentProductDriver,
    commandId: string,
    sessionId: string,
    workspace: string,
    prompt: ContentBlock[],
    profile: Parameters<ResidentProductDriver['execute']>[0]['profile'],
    controller: AbortController,
  ): Promise<void> {
    const heartbeat = setInterval(
      () => { this.store.heartbeat(commandId) },
      this.options.heartbeatIntervalMs ?? 5_000,
    )
    heartbeat.unref()
    try {
      this.store.markRunning(commandId)
      const nativeSessionId = this.store.nativeSessionId(sessionId)
      const result = await driver.execute({
        workspace,
        prompt,
        profile,
        ...nativeSessionId === undefined ? {} : { nativeSessionId },
        signal: controller.signal,
        onRunning: (nativeSessionId, nativeTurnId) => {
          this.store.markRunning(commandId, nativeSessionId, nativeTurnId)
        },
        onProgress: (phase) => {
          this.store.progress(commandId, phase)
        },
      })
      this.store.markRunning(commandId, result.nativeSessionId)
      this.store.settle(commandId, result)
    } catch (error) {
      const aborted = controller.signal.aborted
      const normalized = normalizeResidentDriverError(error, aborted)
      this.store.fail(
        commandId,
        normalized.code,
        safeDiagnostic(normalized.message, prompt),
        aborted ? 'aborted' : 'error',
      )
    } finally {
      clearInterval(heartbeat)
    }
  }

  private acquireLock(): void {
    const lockPath = join(this.options.root, 'daemon.lock')
    try {
      this.lockDescriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const pidPath = join(this.options.root, 'daemon.pid')
      const pid = existsSync(pidPath) ? Number(readFileSync(pidPath, 'utf8').trim()) : Number.NaN
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          throw new ResidentOperatorError(`resident daemon already runs as pid ${pid}`, 'RUNTIME_UNAVAILABLE')
        } catch (probe) {
          if (probe instanceof ResidentOperatorError) throw probe
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe
        }
      }
      this.safeUnlink(lockPath)
      this.lockDescriptor = openSync(lockPath, 'wx', 0o600)
    }
  }

  private releaseLock(): void {
    if (this.lockDescriptor !== undefined) closeSync(this.lockDescriptor)
    this.lockDescriptor = undefined
    this.safeUnlink(join(this.options.root, 'daemon.lock'))
  }

  private removeStaleSocket(): void {
    if (!existsSync(this.socketPath)) return
    if (!lstatSync(this.socketPath).isSocket()) {
      throw new ResidentOperatorError(`resident control path is not a socket: ${this.socketPath}`, 'RUNTIME_UNAVAILABLE')
    }
    unlinkSync(this.socketPath)
  }

  private safeUnlink(path: string): void {
    try { unlinkSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
