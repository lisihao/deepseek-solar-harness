/** Unix-socket orchestration daemon client. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { localIpcAddress, localIpcUsesFilesystem } from '@deepseek-ai/dsh-home-paths'
import { fileURLToPath } from 'node:url'
import {
  OrchestrationError,
  type OrchestrationArtifactRef,
  type CapabilityUpdateReceipt,
  type CapabilityUpdateRequest,
  type OrchestrationCompilationV1,
  type OrchestrationClusterHeartbeatRequest,
  type OrchestrationClusterHeartbeatResponse,
  type OrchestrationClusterInstallReceipt,
  type OrchestrationClusterInstallRequest,
  type OrchestrationClusterReplicaV1,
  type OrchestrationClusterStatus,
  type OrchestrationClusterVoteRequest,
  type OrchestrationClusterVoteResponse,
  type OrchestrationAutoRefineIndeterminateRequest,
  type OrchestrationCompileRequest,
  type OrchestrationControlRequest,
  type OrchestrationDecisionRequest,
  type OrchestrationEventPage,
  type OrchestrationEventReadRequest,
  type OrchestrationIndeterminateRequest,
  type OrchestrationRunSnapshot,
  type OrchestrationStartRequest,
} from '@deepseek-ai/dsh-orchestration'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { waitForDaemonSocketRelease } from '@deepseek-ai/dsh-resident-operator-local'
import { ORCHESTRATION_METHODS, ORCHESTRATION_PROTOCOL_VERSION, skillProviderManifestSha256 } from './daemon.ts'
import { unwrapWire } from './protocol.ts'
import { ORCHESTRATION_STATE_SCHEMA_VERSION } from './store.ts'

const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/** Connection and daemon-start policy for one local orchestration client. */
export interface OrchestrationClientOptions {
  readonly root: string
  readonly dshHome: string
  readonly autoStart: boolean
  readonly connectTimeoutMs: number
  readonly residentDriverModules?: readonly string[]
  readonly skillProviderModules?: readonly string[]
}

/** Stateless-per-request client for the durable local Scheduler. */
export class OrchestrationDaemonClient {
  /** Owner-local Unix socket used for control requests. */
  readonly socketPath: string
  private readiness: Promise<void> | undefined

  constructor(private readonly options: OrchestrationClientOptions) {
    this.socketPath = localIpcAddress(options.root, 'control')
  }

  /**
   * Qualify the daemon protocol and build before a business request.
   * @returns a successful strict protocol and build handshake.
   */
  ready(): Promise<void> {
    this.readiness ??= this.ensureReady().catch((error: unknown) => {
      this.readiness = undefined
      throw error
    })
    return this.readiness
  }

  /**
   * Compile immutable intent and graph input.
   * @param request - immutable compilation input.
   * @returns the certified compilation.
   */
  compile(request: OrchestrationCompileRequest): Promise<OrchestrationCompilationV1> {
    return this.request('orchestration.compile', { request })
  }

  /**
   * Start one accepted certified compilation.
   * @param request - accepted compilation identity and approval.
   * @returns the new durable run.
   */
  start(request: OrchestrationStartRequest): Promise<OrchestrationRunSnapshot> {
    return this.request('orchestration.start', {
      compilation_id: request.compilationId,
      ...request.approvalRef === undefined ? {} : { approval_ref: request.approvalRef },
    })
  }

  /**
   * List known durable runs.
   * @returns bounded snapshots for all known runs.
   */
  list(): Promise<OrchestrationRunSnapshot[]> {
    return this.request('orchestration.list', {})
  }

  /**
   * Inspect one durable run.
   * @param runId - durable run identity.
   * @returns the current run snapshot.
   */
  inspect(runId: string): Promise<OrchestrationRunSnapshot> {
    return this.request('orchestration.inspect', { run_id: runId })
  }

  /**
   * Read append-only orchestration events.
   * @param request - run cursor and page bounds.
   * @returns an ordered event page.
   */
  readEvents(request: OrchestrationEventReadRequest): Promise<OrchestrationEventPage> {
    return this.request('event.read', {
      run_id: String(request.runId),
      after_sequence: request.afterSequence ?? 0,
      limit: request.limit ?? 100,
    })
  }

  /**
   * Read one digest-verified immutable artifact.
   * @param ref - artifact identity issued by the orchestration daemon.
   * @returns the decoded artifact value.
   */
  readArtifact(ref: OrchestrationArtifactRef): Promise<unknown> {
    return this.request('artifact.read', { artifact_ref: String(ref) })
  }

  /**
   * Apply a revision-checked run control.
   * @param request - revision-checked control request.
   * @returns the updated run.
   */
  control(request: OrchestrationControlRequest): Promise<OrchestrationRunSnapshot> {
    return this.request('orchestration.control', { request })
  }

  /**
   * Apply a revision-checked human decision.
   * @param request - revision-checked human decision.
   * @returns the updated run.
   */
  decide(request: OrchestrationDecisionRequest): Promise<OrchestrationRunSnapshot> {
    return this.request('orchestration.decide', { request })
  }

  /**
   * Resolve an indeterminate physical outcome explicitly.
   * @param request - explicit uncertain-result decision.
   * @returns the updated run.
   */
  resolveIndeterminate(request: OrchestrationIndeterminateRequest): Promise<OrchestrationRunSnapshot> {
    return this.request('orchestration.resolve_indeterminate', { request })
  }

  /**
   * Explicitly abandon one uncertain auto-refinement round without replay.
   * @param request - revision-fenced uncertain-round resolution.
   * @returns the updated orchestration run.
   */
  resolveAutoRefineIndeterminate(request: OrchestrationAutoRefineIndeterminateRequest): Promise<OrchestrationRunSnapshot> {
    return this.request('harness.auto_refine.resolve_indeterminate', { request })
  }

  /**
   * Propose a versioned capability-binding change.
   * @param request - requested capability change.
   * @returns the durable update receipt.
   */
  proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt> {
    return this.request('capability.propose_update', { request })
  }

  /**
   * Read this Product Server's bounded cluster authority state.
   * @returns the current cluster status, or undefined in standalone mode.
   */
  async clusterStatus(): Promise<OrchestrationClusterStatus | undefined> {
    const status = await this.request<OrchestrationClusterStatus | null>('cluster.status', {})
    return status ?? undefined
  }

  /**
   * Forward an authenticated peer vote to the durable election state.
   * @param request - candidate term and replication watermark.
   * @returns this member's term-fenced vote response.
   */
  clusterRequestVote(request: OrchestrationClusterVoteRequest): Promise<OrchestrationClusterVoteResponse> {
    return this.request('cluster.vote', { request })
  }

  /**
   * Forward an authenticated leader heartbeat to the durable election state.
   * @param request - elected leader term, lease, and replication watermark.
   * @returns this follower's lease acknowledgement.
   */
  clusterHeartbeat(request: OrchestrationClusterHeartbeatRequest): Promise<OrchestrationClusterHeartbeatResponse> {
    return this.request('cluster.heartbeat', { request })
  }

  /**
   * Export a complete logical state image for one authenticated follower.
   * @returns the current durable TaskGraph state image.
   */
  clusterExportReplica(): Promise<OrchestrationClusterReplicaV1> {
    return this.request('cluster.export', {})
  }

  /**
   * Install a term-fenced logical state image on a follower.
   * @param request - elected leader coordinates and logical state image.
   * @returns the follower's applied or unchanged watermark.
   */
  clusterInstallReplica(request: OrchestrationClusterInstallRequest): Promise<OrchestrationClusterInstallReceipt> {
    return this.request('cluster.install', { request })
  }

  /**
   * Ask the daemon to enter draining shutdown.
   * @returns completion after the daemon accepts the request.
   */
  shutdown(): Promise<void> {
    return this.request('system.shutdown', {}).then(() => undefined)
  }

  // Resident-backed daemons intentionally share the same bounded auto-start handshake lifecycle.
  /* jscpd:ignore-start */
  private async ensureReady(): Promise<void> {
    let initialError: unknown
    try {
      await this.handshake()
      return
    } catch (error) {
      initialError = error
      if (!this.options.autoStart) throw error
    }
    if (initialError instanceof OrchestrationError
      && initialError.code === 'ORCHESTRATION_VERSION_MISMATCH') {
      await this.retireIncompatibleDaemon(initialError)
    }
    startDetachedOrchestrationDaemon(
      this.options.root,
      this.options.dshHome,
      this.options.residentDriverModules ?? [],
      this.options.skillProviderModules ?? [],
    )
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
    throw new OrchestrationError(
      `orchestration daemon did not become ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      'ORCHESTRATION_UNAVAILABLE',
    )
  }
  /* jscpd:ignore-end */

  /** Drain an older detached daemon before starting the current Desktop build. */
  private async retireIncompatibleDaemon(initialError: OrchestrationError): Promise<void> {
    try {
      await this.rawRequest('system.shutdown', {})
    } catch (shutdownError) {
      if (!localIpcUsesFilesystem() || existsSync(this.socketPath)) {
        throw new OrchestrationError(
          `orchestration daemon upgrade is blocked: ${initialError.message}; shutdown failed: ${shutdownError instanceof Error ? shutdownError.message : String(shutdownError)}`,
          'ORCHESTRATION_VERSION_MISMATCH',
        )
      }
      return
    }
    if (!await waitForDaemonSocketRelease(this.socketPath, this.options.connectTimeoutMs)) {
      throw new OrchestrationError(
        `orchestration daemon upgrade is blocked because the old daemon did not drain: ${initialError.message}`,
        'ORCHESTRATION_VERSION_MISMATCH',
      )
    }
  }

  private async handshake(): Promise<void> {
    const response = await this.rawRequest<{
      protocolVersion: number
      stateSchemaVersion: number
      buildCommit: string
      methods: string[]
      skillProviderManifestSha256: string
    }>('system.handshake', {
      protocol_version: ORCHESTRATION_PROTOCOL_VERSION,
      state_schema_version: ORCHESTRATION_STATE_SCHEMA_VERSION,
      skill_provider_manifest_sha256: skillProviderManifestSha256(this.options.skillProviderModules ?? []),
    })
    if (response.protocolVersion !== ORCHESTRATION_PROTOCOL_VERSION
      || response.stateSchemaVersion !== ORCHESTRATION_STATE_SCHEMA_VERSION) {
      throw new OrchestrationError('orchestration daemon protocol or schema mismatch', 'ORCHESTRATION_VERSION_MISMATCH')
    }
    const expectedCommit = process.env.DSH_BUILD_COMMIT ?? 'development'
    if (response.buildCommit !== expectedCommit) {
      throw new OrchestrationError(
        `orchestration daemon build ${response.buildCommit} does not match client ${expectedCommit}`,
        'ORCHESTRATION_VERSION_MISMATCH',
      )
    }
    if (!Array.isArray(response.methods) || ORCHESTRATION_METHODS.some(method => !response.methods.includes(method))) {
      throw new OrchestrationError('orchestration daemon lacks required methods', 'ORCHESTRATION_VERSION_MISMATCH')
    }
    if (response.skillProviderManifestSha256 !== skillProviderManifestSha256(this.options.skillProviderModules ?? [])) {
      throw new OrchestrationError('orchestration daemon Skill Provider manifest mismatch', 'ORCHESTRATION_VERSION_MISMATCH')
    }
  }

  private async request<T>(method: string, params: object): Promise<T> {
    await this.ready()
    return this.rawRequest(method, params)
  }

  // Both local daemon clients own the same one-request JSONL socket lifecycle.
  /* jscpd:ignore-start */
  private async rawRequest<T>(method: string, params: object): Promise<T> {
    const socket = createConnection(this.socketPath)
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })
    const timeout = setTimeout(() => {
      socket.destroy(new Error(`orchestration daemon connection timed out after ${String(this.options.connectTimeoutMs)}ms`))
    }, this.options.connectTimeoutMs)
    try {
      await connected
      clearTimeout(timeout)
      const transport = new JsonRpcLineTransport(socket, socket)
      transport.start()
      try {
        return unwrapWire(await transport.request(method, params)) as T
      } finally {
        transport.close()
      }
    } finally {
      clearTimeout(timeout)
      socket.end()
    }
  }
  /* jscpd:ignore-end */
}

/**
 * Start an orchestration daemon independent of the current DSH/Electron generation.
 * @param root - owner-private orchestration state root.
 * @param dshHome - DSH home shared with the Resident daemon.
 * @param residentDriverModules - absolute independent Resident Driver entries for the headless composition.
 * @param skillProviderModules - absolute trusted TypeScript Skill Provider plugin entries.
 * @returns detached child process identity.
 */
export function startDetachedOrchestrationDaemon(
  root: string,
  dshHome: string,
  residentDriverModules: readonly string[] = [],
  skillProviderModules: readonly string[] = [],
): number {
  const builtEntry = fileURLToPath(new URL('./startup.js', import.meta.url))
  const sourceEntry = fileURLToPath(new URL('./startup.ts', import.meta.url))
  const entry = existsSync(builtEntry) ? builtEntry : sourceEntry
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === ELECTRON_RUN_AS_NODE) Reflect.deleteProperty(environment, key)
  }
  if (process.versions.electron !== undefined) environment[ELECTRON_RUN_AS_NODE] = '1'
  const child = spawn(process.execPath, [
    ...process.execArgv,
    entry,
    '--root', root,
    '--dsh-home', dshHome,
    ...residentDriverModules.flatMap(module => ['--resident-driver-module', module]),
    ...skillProviderModules.flatMap(module => ['--skill-provider-module', module]),
  ], {
    detached: true,
    stdio: 'ignore',
    env: environment,
  })
  child.unref()
  if (child.pid === undefined) throw new OrchestrationError('orchestration daemon did not publish a pid', 'ORCHESTRATION_UNAVAILABLE')
  return child.pid
}
