/** Local `ctx.orchestrations` Provider over dsh-orchestratord. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import OrchestrationService, {
  type CapabilityUpdateReceipt,
  type CapabilityUpdateRequest,
  type OrchestrationCompilationV1,
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

export { OrchestrationDaemonClient, startDetachedOrchestrationDaemon } from './client.ts'
export { OrchestrationDaemon, ORCHESTRATION_METHODS, ORCHESTRATION_PROTOCOL_VERSION } from './daemon.ts'
export { graphCertificate, nodesConflict, scopeOverlap, validateGraph } from './graph.ts'
export { BasicContextCompiler, DirectIntentCompiler, LocalCapabilityCapsuleService } from './providers.ts'
export { ORCHESTRATION_STATE_SCHEMA_VERSION, OrchestrationStore } from './store.ts'

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
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  autoStart: z.boolean().default(true),
  connectTimeoutMs: z.number().step(1).min(100).max(60_000).default(5_000),
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
    })
  }

  compile(request: OrchestrationCompileRequest): Promise<OrchestrationCompilationV1> { return this.client.compile(request) }
  start(request: OrchestrationStartRequest): Promise<OrchestrationRunSnapshot> { return this.client.start(request) }
  list(): Promise<OrchestrationRunSnapshot[]> { return this.client.list() }
  inspect(runId: OrchestrationRunId): Promise<OrchestrationRunSnapshot> { return this.client.inspect(String(runId)) }
  readEvents(request: OrchestrationEventReadRequest): Promise<OrchestrationEventPage> { return this.client.readEvents(request) }
  control(request: OrchestrationControlRequest): Promise<OrchestrationRunSnapshot> { return this.client.control(request) }
  decide(request: OrchestrationDecisionRequest): Promise<OrchestrationRunSnapshot> { return this.client.decide(request) }
  resolveIndeterminate(request: OrchestrationIndeterminateRequest): Promise<OrchestrationRunSnapshot> {
    return this.client.resolveIndeterminate(request)
  }

  proposeCapabilityUpdate(request: CapabilityUpdateRequest): Promise<CapabilityUpdateReceipt> {
    return this.client.proposeCapabilityUpdate(request)
  }
}

export function apply(ctx: Context, config: Config): void {
  new LocalOrchestrationService(ctx, config as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>)
}
