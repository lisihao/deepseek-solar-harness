/** Member operations on the machine this module runs on: the local host, and the agent an SSH host runs. */

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRepositorySource } from '@deepseek-ai/dsh-orchestration-local'
import type { GouziFolderListing, GouziProvisionInput } from '@deepseek-ai/dsh-ui-gouzi'
import { GouziSupervisor, residentDaemonPid } from './gouzi-supervisor.ts'

/** Settings of one machine's member operations. */
export interface LocalGouziConfig {
  /** Directory that holds one home per member. */
  readonly membersRoot: string
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
  readonly nodeArgs: readonly string[]
}

/** Member process facts reported to the caller. */
export interface LocalGouziStarted {
  readonly port: number
  readonly pid: number
  readonly incarnation: number
}

/** Upper bound on the subdirectories one listing returns. */
const BROWSE_ENTRY_LIMIT = 500

/** Starts, stops, and inspects members and workspaces on this machine. */
export class LocalGouziOperations {
  private readonly supervisor: GouziSupervisor

  constructor(private readonly config: LocalGouziConfig) {
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

  async start(gouziId: string): Promise<LocalGouziStarted> {
    const ready = await this.supervisor.start(gouziId)
    return { port: ready.port, pid: ready.pid, incarnation: ready.incarnation }
  }

  async stop(gouziId: string, options: { readonly reclaimResident?: boolean } = {}): Promise<{ readonly processTreeStopped: boolean }> {
    await this.supervisor.stop(gouziId, options)
    const resident = options.reclaimResident === true ? residentDaemonPid(this.supervisor.homeOf(gouziId)) : undefined
    return { processTreeStopped: this.supervisor.running(gouziId) === undefined && resident === undefined }
  }

  /**
   * List the directories one level below `path`.
   * @param path - absolute directory; absent lists the user's home directory.
   * @returns the directory, its parent, and its non-hidden subdirectories with a Git marker.
   */
  browse(path?: string): GouziFolderListing {
    const directory = realpathSync(resolve(path ?? homedir()))
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, BROWSE_ENTRY_LIMIT)
      .map(entry => ({ name: entry.name, path: join(directory, entry.name), git: existsSync(join(directory, entry.name, '.git')) }))
    const parent = dirname(directory)
    return { path: directory, ...parent === directory ? {} : { parent }, entries }
  }
}
