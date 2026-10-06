/**
 * Provider of `ctx.gouziHost` for the product Server: Gouzi members run as processes on this machine, or on
 * SSH hosts the user added.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  GOUZI_LOCAL_HOST_ID,
  GouziHostService,
  type GouziProcessInfo,
  type GouziProvisionInput,
  type GouziSshTarget,
} from '@deepseek-ai/dsh-ui-gouzi'
import { LocalGouziOperations } from './gouzi-local.ts'
import { RemoteGouziHosts } from './gouzi-remote.ts'
import { SYSTEM_SSH, type SshBinaries } from './gouzi-ssh.ts'

export const name = 'gouzi-host'

/** Member host configuration. */
export interface Config {
  /** Directory that holds one home per local member. */
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
  /** Directory for the SSH hosts: their catalog, dedicated keys, and pinned host keys. */
  readonly hostsRoot: string
  /** OpenSSH client binaries; the defaults are the ones on `PATH`. */
  readonly ssh: SshBinaries
  /** Where DSH Desktop is installed on SSH hosts. */
  readonly remoteApp?: string
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
  hostsRoot: z.string().required(),
  ssh: z.object({
    ssh: z.string().default(SYSTEM_SSH.ssh),
    sshKeygen: z.string().default(SYSTEM_SSH.sshKeygen),
    sshKeyscan: z.string().default(SYSTEM_SSH.sshKeyscan),
  }),
  remoteApp: z.string(),
})

/** Runs members as detached processes of this machine or of an SSH host; exported so a test can wrap it. */
export class LocalGouziHost extends GouziHostService {
  readonly ownerId: string
  private readonly local: LocalGouziOperations
  private readonly remote: RemoteGouziHosts

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.ownerId = config.ownerId
    this.local = new LocalGouziOperations(config)
    this.remote = new RemoteGouziHosts({
      root: config.hostsRoot,
      binaries: config.ssh,
      ...config.remoteApp === undefined ? {} : { remoteApp: config.remoteApp },
    })
    // Forwards of members that were running when the previous main instance ended come back with this one.
    this.remote.restore()
    ctx.effect(() => () => { this.remote.dispose() }, 'gouzi-host: close SSH forwards')
  }

  hosts() {
    return Promise.resolve(this.remote.list())
  }

  inspectHost(target: GouziSshTarget) {
    return this.remote.inspect(target)
  }

  addHost(input: GouziSshTarget & { readonly password: string; readonly fingerprint: string; readonly label?: string }) {
    return this.remote.add(input)
  }

  removeHost(hostId: string): Promise<void> {
    return this.remote.remove(hostId)
  }

  browse(hostId: string, path?: string) {
    return hostId === GOUZI_LOCAL_HOST_ID ? Promise.resolve(this.local.browse(path)) : this.remote.browse(hostId, path)
  }

  resolveRepository(hostId: string, path: string) {
    return hostId === GOUZI_LOCAL_HOST_ID ? this.local.resolveRepository(path) : this.remote.resolveRepository(hostId, path)
  }

  prepareRepository(hostId: string, path: string) {
    return hostId === GOUZI_LOCAL_HOST_ID ? this.local.prepareRepository(path) : this.remote.prepareRepository(hostId, path)
  }

  async provision(input: GouziProvisionInput): Promise<void> {
    if (input.hostId === GOUZI_LOCAL_HOST_ID) await this.local.provision(input)
    else await this.remote.provision(input)
  }

  async start(hostId: string, gouziId: string): Promise<GouziProcessInfo> {
    if (hostId !== GOUZI_LOCAL_HOST_ID) return this.remote.start(hostId, gouziId)
    const started = await this.local.start(gouziId)
    return { endpoint: `http://127.0.0.1:${String(started.port)}/`, pid: started.pid, incarnation: started.incarnation }
  }

  stop(hostId: string, gouziId: string, options: { readonly reclaimResident?: boolean } = {}): Promise<{ readonly processTreeStopped: boolean }> {
    return hostId === GOUZI_LOCAL_HOST_ID ? this.local.stop(gouziId, options) : this.remote.stop(hostId, gouziId, options)
  }
}

/**
 * Register the member host.
 * @param ctx - plugin context.
 * @param config - resolved configuration.
 */
export function apply(ctx: Context, config: Config): void {
  new LocalGouziHost(ctx, config)
}
