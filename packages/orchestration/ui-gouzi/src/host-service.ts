/** Service Definition of the process lifecycle of Gouzi members on this host. */

import { Service, type Context } from '@deepseek-ai/cordis'

/** Identity and workspace allowlist a member is created with. */
export interface GouziProvisionInput {
  readonly gouziId: string
  readonly ownerId: string
  readonly hostId: string
  readonly generation: number
  readonly authorityEpoch: string
  /** Repositories the member may materialize: canonical identity and clone source. */
  readonly repositories: readonly { readonly repository: string; readonly source: string }[]
}

/** Facts about a running member process. */
export interface GouziProcessInfo {
  readonly endpoint: string
  readonly pid: number
  readonly incarnation: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    gouziHost: GouziHostService
  }
}

/**
 * Starts and stops member processes on the machine that runs this Server. The Desktop product provides it; a
 * Server without it can still list members but cannot adopt or wake one.
 */
export abstract class GouziHostService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'gouziHost')
  }

  /** Stable identity of this main instance, written into every grant epoch binding. */
  abstract readonly ownerId: string

  /**
   * Resolve a local workspace to the repository identity a member may materialize.
   * @param path - absolute path inside a Git repository.
   * @returns the canonical repository identity and the path to clone from.
   * @throws Error - when the path is not inside a Git repository with a usable remote.
   */
  abstract resolveRepository(path: string): Promise<{ readonly repository: string; readonly source: string }>

  /**
   * Create the member's home, identity, and repository allowlist. Idempotent for the same identity.
   * @param input - identity and allowlist.
   */
  abstract provision(input: GouziProvisionInput): Promise<void>

  /**
   * Start the member's process, or adopt the one already running.
   * @param gouziId - member identity.
   * @returns where it listens and which incarnation answered.
   */
  abstract start(gouziId: string): Promise<GouziProcessInfo>

  /**
   * Stop the member's process.
   * @param gouziId - member identity.
   * @param options - `reclaimResident` also stops the Resident daemon the member started.
   * @returns whether no process of the member remains.
   */
  abstract stop(gouziId: string, options?: { readonly reclaimResident?: boolean }): Promise<{ readonly processTreeStopped: boolean }>

  /**
   * Whether the member's process is running now.
   * @param gouziId - member identity.
   * @returns true while the process answers to its ready record.
   */
  abstract isRunning(gouziId: string): boolean
}
