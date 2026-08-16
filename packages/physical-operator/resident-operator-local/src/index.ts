/** Local resident-operator Service Provider over a durable Unix-socket daemon. @module @deepseek-ai/dsh-resident-operator-local */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import ResidentOperatorService, {
  type ResidentEventPage,
  type ResidentEventReadRequest,
  type ResidentExecuteRequest,
  type ResidentIndeterminateResolutionRequest,
  type ResidentInterruptRequest,
  type ResidentProviderStatus,
  type ResidentResetRequest,
  type ResidentSessionSnapshot,
  type ResidentTurn,
  type ResidentTurnSnapshot,
} from '@deepseek-ai/dsh-resident-operator'
import { brandedSession, brandedTurn, ResidentDaemonClient } from './client.ts'

export { ResidentDaemonClient, startDetachedResidentDaemon } from './client.ts'
export { ResidentDaemon, RESIDENT_METHODS } from './daemon.ts'
export {
  ClaudeCodeResidentDriver,
  CodexResidentDriver,
  EXPECTED_CLAUDE_CLI_VERSION,
  EXPECTED_CLAUDE_SDK_VERSION,
  EXPECTED_CODEX_CLI_VERSION,
  EXPECTED_CODEX_SCHEMA_SHA256,
  type ResidentProductDriver,
} from './drivers.ts'
export { ResidentStore, canonicalRequestHash } from './store.ts'

export const name = 'resident-operator-local'

/** Local Resident Service Provider configuration. */
export interface Config {
  /** Optional DSH home override whose `resident-operators` child holds daemon state. */
  readonly dshHome?: string
  /** Start an independent local daemon when no compatible socket is reachable. */
  readonly autoStart?: boolean
  /** Bounded socket connection and daemon startup wait in milliseconds. */
  readonly connectTimeoutMs?: number
  /** Turn-settlement polling interval in milliseconds. */
  readonly pollIntervalMs?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  autoStart: z.boolean().default(true),
  connectTimeoutMs: z.number().step(1).min(100).max(60_000).default(5_000),
  pollIntervalMs: z.number().step(1).min(10).max(10_000).default(250),
})

class LocalResidentOperatorService extends ResidentOperatorService {
  private readonly client: ResidentDaemonClient

  constructor(ctx: Context, config: Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>) {
    super(ctx)
    this.client = new ResidentDaemonClient({
      root: `${resolveDshHome(config.dshHome)}/resident-operators`,
      autoStart: config.autoStart,
      connectTimeoutMs: config.connectTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
    })
  }

  providers(): Promise<ResidentProviderStatus[]> {
    return this.client.providers()
  }

  async execute(request: ResidentExecuteRequest): Promise<ResidentTurn> {
    const turn = await this.client.execute({
      commandId: request.commandId,
      ...request.supersedesCommandId === undefined ? {} : { supersedesCommandId: request.supersedesCommandId },
      operatorId: request.operatorId,
      workspace: request.workspace,
      prompt: request.prompt,
      signal: request.signal,
    })
    return {
      turnId: brandedTurn(turn.turnId),
      sessionId: brandedSession(turn.sessionId),
      stateRevision: turn.stateRevision,
      result: turn.result,
      dispose: turn.dispose,
    }
  }

  list(): Promise<ResidentSessionSnapshot[]> {
    return this.client.list()
  }

  inspect(sessionId: string): Promise<ResidentSessionSnapshot> {
    return this.client.inspect(sessionId)
  }

  inspectTurn(turnId: string): Promise<ResidentTurnSnapshot> {
    return this.client.inspectTurn(turnId)
  }

  readEvents(request: ResidentEventReadRequest): Promise<ResidentEventPage> {
    return this.client.readEvents(
      request.sessionId,
      request.afterSequence,
      request.limit,
      request.signal,
    )
  }

  interrupt(request: ResidentInterruptRequest): Promise<void> {
    return this.client.interrupt(request.sessionId, request.turnId)
  }

  reset(request: ResidentResetRequest): Promise<ResidentSessionSnapshot> {
    return this.client.reset(request.sessionId, request.expectedStateRevision, request.reason)
  }

  resolveIndeterminate(request: ResidentIndeterminateResolutionRequest): Promise<void> {
    return this.client.resolveIndeterminate(request.commandId, request.expectedStateRevision)
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>
  new LocalResidentOperatorService(ctx, resolved)
}
