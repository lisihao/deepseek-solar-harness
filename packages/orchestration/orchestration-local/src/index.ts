/** Local `ctx.orchestrations` Provider over dsh-orchestratord. */
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import OrchestrationService, {
  type CapabilityUpdateReceipt,
  type CapabilityUpdateRequest,
  type OrchestrationArtifactRef,
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
  type OrchestrationRunId,
  type OrchestrationRunSnapshot,
  type OrchestrationStartRequest,
} from '@deepseek-ai/dsh-orchestration'
import { OrchestrationDaemonClient } from './client.ts'
import { LocalRemoteOperatorHostService } from './remote-execution-host.ts'

export { OrchestrationDaemonClient, startDetachedOrchestrationDaemon } from './client.ts'
export { OrchestrationDaemon, ORCHESTRATION_METHODS, ORCHESTRATION_PROTOCOL_VERSION } from './daemon.ts'
export { graphCertificate, nodesConflict, scopeOverlap, validateGraph } from './graph.ts'
export { BasicContextCompiler, DirectIntentCompiler, LocalCapabilityCapsuleService } from './providers.ts'
export { ORCHESTRATION_STATE_SCHEMA_VERSION, OrchestrationStore } from './store.ts'
export { LocalRemoteOperatorHostService } from './remote-execution-host.ts'
export * from './auto-refine.ts'

export const name = 'orchestration-local'

// Local daemon plugins intentionally expose the same bounded connection configuration surface.
/* jscpd:ignore-start */
/** Local daemon client configuration. */
export interface Config {
  /** Optional DSH home; defaults to the ordinary harness-owned location. */
  readonly dshHome?: string
  /** Start an independent daemon when no compatible socket is available. */
  readonly autoStart?: boolean
  /** Maximum handshake and per-request connection wait in milliseconds. */
  readonly connectTimeoutMs?: number
  /** Independently packaged Resident Driver modules required by headless execution. */
  readonly residentDriverModules?: string[]
  /** Trusted plugins that register executable TypeScript Skills in the daemon. */
  readonly skillProviderModules?: string[]
  /** Maximum time for one Server-side exact-commit Git materialization. */
  readonly remoteMaterializationTimeoutMs?: number
  /** Maximum time for one bounded Resident artifact read. */
  readonly remoteArtifactReadTimeoutMs?: number
  /** Maximum exact artifact bytes returned over Remote Sync. */
  readonly remoteArtifactMaxBytes?: number
  /** Lease retained for one command-isolated remote execution checkout. */
  readonly remoteWorkspaceLeaseMs?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  autoStart: z.boolean().default(true),
  connectTimeoutMs: z.number().step(1).min(100).max(60_000).default(5_000),
  residentDriverModules: z.array(z.string()).default([]),
  skillProviderModules: z.array(z.string()).default([]),
  remoteMaterializationTimeoutMs: z.number().step(1).min(1_000).max(15 * 60_000).default(120_000),
  remoteArtifactReadTimeoutMs: z.number().step(1).min(100).max(60_000).default(15_000),
  remoteArtifactMaxBytes: z.number().step(1).min(1_024).max(8 * 1024 * 1024).default(8 * 1024 * 1024),
  remoteWorkspaceLeaseMs: z.number().step(1).min(60_000).max(7 * 24 * 60 * 60_000).default(24 * 60 * 60_000),
})
/* jscpd:ignore-end */

class LocalOrchestrationService extends OrchestrationService {
  private readonly client: OrchestrationDaemonClient

  constructor(ctx: Context, config: Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>) {
    super(ctx)
    const dshHome = resolveDshHome(config.dshHome)
    this.client = new OrchestrationDaemonClient({
      root: `${dshHome}/orchestrations`,
      dshHome,
      autoStart: config.autoStart,
      connectTimeoutMs: config.connectTimeoutMs,
      residentDriverModules: config.residentDriverModules.map((module) => {
        if (ctx.baseUrl === undefined) throw new Error('orchestration-local requires ctx.baseUrl to resolve Resident Driver modules')
        return createRequire(ctx.baseUrl).resolve(module)
      }),
      skillProviderModules: config.skillProviderModules.map((module) => {
        if (ctx.baseUrl === undefined) throw new Error('orchestration-local requires ctx.baseUrl to resolve Skill Provider modules')
        return createRequire(ctx.baseUrl).resolve(module)
      }),
    })
  }

  compile(request: OrchestrationCompileRequest): Promise<OrchestrationCompilationV1> { return this.client.compile(request) }
  start(request: OrchestrationStartRequest): Promise<OrchestrationRunSnapshot> { return this.client.start(request) }
  list(): Promise<OrchestrationRunSnapshot[]> { return this.client.list() }
  inspect(runId: OrchestrationRunId): Promise<OrchestrationRunSnapshot> { return this.client.inspect(String(runId)) }
  readEvents(request: OrchestrationEventReadRequest): Promise<OrchestrationEventPage> { return this.client.readEvents(request) }
  readArtifact(ref: OrchestrationArtifactRef): Promise<unknown> { return this.client.readArtifact(ref) }
  control(request: OrchestrationControlRequest): Promise<OrchestrationRunSnapshot> { return this.client.control(request) }
  decide(request: OrchestrationDecisionRequest): Promise<OrchestrationRunSnapshot> { return this.client.decide(request) }
  resolveIndeterminate(request: OrchestrationIndeterminateRequest): Promise<OrchestrationRunSnapshot> {
    return this.client.resolveIndeterminate(request)
  }

  resolveAutoRefineIndeterminate(request: OrchestrationAutoRefineIndeterminateRequest): Promise<OrchestrationRunSnapshot> {
    return this.client.resolveAutoRefineIndeterminate(request)
  }

  proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt> {
    return this.client.proposeCapabilityUpdate(request)
  }

  clusterStatus(): Promise<OrchestrationClusterStatus | undefined> { return this.client.clusterStatus() }
  clusterRequestVote(request: OrchestrationClusterVoteRequest): Promise<OrchestrationClusterVoteResponse> {
    return this.client.clusterRequestVote(request)
  }
  clusterHeartbeat(request: OrchestrationClusterHeartbeatRequest): Promise<OrchestrationClusterHeartbeatResponse> {
    return this.client.clusterHeartbeat(request)
  }
  clusterExportReplica(): Promise<OrchestrationClusterReplicaV1> { return this.client.clusterExportReplica() }
  clusterInstallReplica(request: OrchestrationClusterInstallRequest): Promise<OrchestrationClusterInstallReceipt> {
    return this.client.clusterInstallReplica(request)
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>
  const dshHome = resolveDshHome(resolved.dshHome)
  new LocalRemoteOperatorHostService(ctx, {
    dshHome,
    timeoutMs: resolved.remoteMaterializationTimeoutMs ?? 120_000,
    artifactReadTimeoutMs: resolved.remoteArtifactReadTimeoutMs ?? 15_000,
    artifactMaxBytes: resolved.remoteArtifactMaxBytes ?? 8 * 1024 * 1024,
    workspaceLeaseMs: resolved.remoteWorkspaceLeaseMs ?? 24 * 60 * 60_000,
  })
  new LocalOrchestrationService(ctx, resolved)
}
