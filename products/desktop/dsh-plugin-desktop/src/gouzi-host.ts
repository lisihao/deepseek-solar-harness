/** Provider of `ctx.gouziHost` for the product Server: Gouzi members run as processes on this machine. */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveRepositorySource } from '@deepseek-ai/dsh-orchestration-local'
import {
  GouziHostService,
  type GouziProcessInfo,
  type GouziProvisionInput,
} from '@deepseek-ai/dsh-ui-gouzi'
import { GouziSupervisor, residentDaemonPid } from './gouzi-supervisor.ts'

export const name = 'gouzi-host'

/** Local member host configuration. */
export interface Config {
  /** Directory that holds one home per member. */
  readonly membersRoot: string
  /** Stable identity of this main instance. */
  readonly ownerId: string
  /** Members that may run at once on this machine. */
  readonly activeLimit: number
  /** Longest wait for a started member to report ready, in milliseconds. */
  readonly readyTimeoutMs: number
  /** Longest wait after SIGTERM before a member is killed, in milliseconds. */
  readonly stopTimeoutMs: number
  /** Longest wait for one Git inspection when a project is resolved, in milliseconds. */
  readonly gitTimeoutMs: number
  /** Launcher script of one member; defaults to the `dsh-gouzi-worker` entry next to this module. */
  readonly workerScript?: string
  /** Node options placed before the launcher script, for example a TypeScript loader when running from source. */
  readonly nodeArgs: string[]
}

export const Config: z<Config> = z.object({
  membersRoot: z.string().required(),
  ownerId: z.string().required(),
  activeLimit: z.number().step(1).min(1).max(10).default(2),
  readyTimeoutMs: z.number().step(1).min(1_000).max(10 * 60_000).default(120_000),
  stopTimeoutMs: z.number().step(1).min(1_000).max(5 * 60_000).default(20_000),
  gitTimeoutMs: z.number().step(1).min(1_000).max(120_000).default(10_000),
  workerScript: z.string(),
  nodeArgs: z.array(z.string()).default([]),
})

/** Runs members as detached processes of this machine; exported so a test can wrap it. */
export class LocalGouziHost extends GouziHostService {
  readonly ownerId: string
  private readonly supervisor: GouziSupervisor

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    this.ownerId = config.ownerId
    const script = config.workerScript ?? fileURLToPath(new URL('./gouzi-worker-bin.js', import.meta.url))
    this.supervisor = new GouziSupervisor({
      membersRoot: config.membersRoot,
      workerCommand: () => ({
        command: process.execPath,
        args: [...config.nodeArgs, script, '--host', '127.0.0.1', '--port', '0'],
        // Inside Electron the executable is the app; this makes it behave as plain Node for the member.
        ...process.versions.electron === undefined ? {} : { env: { ELECTRON_RUN_AS_NODE: '1' } },
      }),
      activeLimit: config.activeLimit,
      readyTimeoutMs: config.readyTimeoutMs,
      stopTimeoutMs: config.stopTimeoutMs,
    })
  }

  resolveRepository(path: string) {
    return resolveRepositorySource(path, this.config.gitTimeoutMs)
  }

  async provision(input: GouziProvisionInput): Promise<void> {
    await this.supervisor.provision(input)
  }

  async start(gouziId: string): Promise<GouziProcessInfo> {
    const ready = await this.supervisor.start(gouziId)
    return { endpoint: `http://127.0.0.1:${String(ready.port)}/`, pid: ready.pid, incarnation: ready.incarnation }
  }

  async stop(gouziId: string, options: { readonly reclaimResident?: boolean } = {}): Promise<{ readonly processTreeStopped: boolean }> {
    await this.supervisor.stop(gouziId, options)
    const resident = options.reclaimResident === true ? residentDaemonPid(this.supervisor.homeOf(gouziId)) : undefined
    return { processTreeStopped: this.supervisor.running(gouziId) === undefined && resident === undefined }
  }

  isRunning(gouziId: string): boolean {
    return this.supervisor.running(gouziId) !== undefined
  }
}

/**
 * Register the local member host.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  new LocalGouziHost(ctx, config)
}
