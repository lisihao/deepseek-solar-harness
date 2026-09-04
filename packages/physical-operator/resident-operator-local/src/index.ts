/** Local resident-operator Service Provider over a durable Unix-socket daemon. @module @deepseek-ai/dsh-resident-operator-local */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import ResidentOperatorService, {
  type ResidentEventPage,
  type ResidentEventReadRequest,
  type ResidentCompactRequest,
  type ResidentCompactResult,
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

export { ResidentDaemonClient, startDetachedResidentDaemon, waitForDaemonSocketRelease } from './client.ts'
export { ResidentDaemon, RESIDENT_METHODS } from './daemon.ts'
export {
  ClaudeCodeResidentDriver,
  CodexResidentDriver,
  EXPECTED_CLAUDE_CLI_VERSION,
  EXPECTED_CLAUDE_SDK_VERSION,
  EXPECTED_CODEX_CLI_VERSION,
  EXPECTED_CODEX_SCHEMA_SHA256,
} from './drivers.ts'
export type { ResidentProductDriver } from '@deepseek-ai/dsh-resident-operator'
export { ResidentStore, canonicalCompactRequestHash, canonicalRequestHash } from './store.ts'

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
  /** Independently packaged Driver modules loaded by the detached daemon. */
  readonly driverModules?: string[]
  /** Explicit executable or helper used for the detached headless daemon. */
  readonly headlessNodeExecutable?: string
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  autoStart: z.boolean().default(true),
  connectTimeoutMs: z.number().step(1).min(100).max(60_000).default(5_000),
  pollIntervalMs: z.number().step(1).min(10).max(10_000).default(250),
  headlessNodeExecutable: z.string(),
  driverModules: z.array(z.string()).default([]),
})

class LocalResidentOperatorService extends ResidentOperatorService {
  private readonly client: ResidentDaemonClient

  constructor(
    ctx: Context,
    config: Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>,
    driverModules: readonly string[],
  ) {
    super(ctx)
    this.client = new ResidentDaemonClient({
      root: `${resolveDshHome(config.dshHome)}/resident-operators`,
      autoStart: config.autoStart,
      connectTimeoutMs: config.connectTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      headlessNodeExecutable: config.headlessNodeExecutable,
      driverModules,
    })
  }

  providers(): Promise<ResidentProviderStatus[]> {
    return this.client.providers()
  }

  override authenticate(operatorId: string): Promise<ResidentProviderStatus> {
    return this.client.authenticate(operatorId)
  }

  /** Ensure the configured detached daemon owns the socket before dependants start. */
  ready(): Promise<void> {
    return this.client.ready()
  }

  async execute(request: ResidentExecuteRequest): Promise<ResidentTurn> {
    const turn = await this.client.execute({
      commandId: request.commandId,
      ...request.supersedesCommandId === undefined ? {} : { supersedesCommandId: request.supersedesCommandId },
      operatorId: request.operatorId,
      workspace: request.workspace,
      laneId: request.laneId,
      ...request.taskLabel === undefined ? {} : { taskLabel: request.taskLabel },
      prompt: request.prompt,
      ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
      ...request.profile === undefined ? {} : { profile: request.profile },
      ...request.modelToolBridge === undefined ? {} : { modelToolBridge: request.modelToolBridge },
      ...request.nativeToolPolicy === undefined ? {} : { nativeToolPolicy: request.nativeToolPolicy },
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

  override compact(request: ResidentCompactRequest): Promise<ResidentCompactResult> {
    return this.client.compact({
      commandId: request.commandId,
      sessionId: request.sessionId,
      expectedStateRevision: request.expectedStateRevision,
      ...request.instructions === undefined ? {} : { instructions: request.instructions },
    })
  }

  reset(request: ResidentResetRequest): Promise<ResidentSessionSnapshot> {
    return this.client.reset(request.sessionId, request.expectedStateRevision, request.reason)
  }

  resolveIndeterminate(request: ResidentIndeterminateResolutionRequest): Promise<void> {
    return this.client.resolveIndeterminate(request.commandId, request.expectedStateRevision)
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as Required<Omit<Config, 'dshHome'>> & Pick<Config, 'dshHome'>
  const modules = resolved.driverModules
  let driverModules: string[] = []
  if (modules.length > 0) {
    if (ctx.baseUrl === undefined) {
      throw new Error('resident-operator-local: ctx.baseUrl is required to resolve Driver modules')
    }
    const require = createRequire(ctx.baseUrl)
    driverModules = modules.map((module, index) => {
      if (module.length === 0 || module.trim() !== module) {
        throw new Error(`resident-operator-local: driverModules[${String(index)}] must be non-blank and trimmed`)
      }
      return require.resolve(module)
    })
  }
  const service = new LocalResidentOperatorService(ctx, resolved, driverModules)
  await service.ready()
}
