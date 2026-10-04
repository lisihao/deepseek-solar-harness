/** Service Definition of the process lifecycle of Gouzi members on this host. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { GouziFolderListing, GouziHostInspection, GouziHostProjection } from './contracts.ts'

/** An SSH machine to add as a host. */
export interface GouziSshTarget {
  readonly address: string
  readonly port: number
  readonly user: string
}

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
   * List the SSH hosts the user added; the local machine is implicit.
   * @returns the stored SSH hosts.
   */
  abstract hosts(): Promise<readonly GouziHostProjection[]>

  /**
   * Read the key an SSH machine presents, without logging in.
   * @param target - machine and login name.
   * @returns the key type and fingerprint for the user to confirm.
   * @throws Error - when the machine cannot be reached.
   */
  abstract inspectHost(target: GouziSshTarget): Promise<GouziHostInspection>

  /**
   * Trust an SSH machine and prepare it: install a dedicated key with the password, then check that DSH Desktop
   * with Gouzi support is installed. The password is used once and not kept.
   * @param input - machine, login, password, and the fingerprint the user confirmed.
   * @returns the stored host.
   * @throws Error - when the key changed since inspection, the login fails, or DSH Desktop is missing or too old.
   */
  abstract addHost(input: GouziSshTarget & {
    readonly password: string
    readonly fingerprint: string
    readonly label?: string
  }): Promise<GouziHostProjection>

  /**
   * Forget an SSH host and its dedicated key. The caller has checked that no live member uses it.
   * @param hostId - host id.
   */
  abstract removeHost(hostId: string): Promise<void>

  /**
   * List the directories one level below `path` on a host, marking Git repositories.
   * @param hostId - host id.
   * @param path - absolute directory; absent lists the login home directory.
   * @returns the directory and its subdirectories.
   */
  abstract browse(hostId: string, path?: string): Promise<GouziFolderListing>

  /**
   * Resolve a workspace on a host to the repository identity a member may materialize.
   * @param hostId - host id.
   * @param path - absolute path on that host, inside a Git repository.
   * @returns the canonical repository identity and the path to clone from.
   * @throws Error - when the path is not inside a Git repository with a usable remote.
   */
  abstract resolveRepository(hostId: string, path: string): Promise<{ readonly repository: string; readonly source: string }>

  /**
   * Create the member's home, identity, and repository allowlist on its host. Idempotent for the same identity.
   * @param input - identity and allowlist; `hostId` selects the machine.
   */
  abstract provision(input: GouziProvisionInput): Promise<void>

  /**
   * Start the member's process, or adopt the one already running.
   * @param hostId - host of the member.
   * @param gouziId - member identity.
   * @returns where the main instance reaches it and which incarnation answered.
   */
  abstract start(hostId: string, gouziId: string): Promise<GouziProcessInfo>

  /**
   * Stop the member's process.
   * @param hostId - host of the member.
   * @param gouziId - member identity.
   * @param options - `reclaimResident` also stops the Resident daemon the member started.
   * @returns whether no process of the member remains.
   */
  abstract stop(
    hostId: string,
    gouziId: string,
    options?: { readonly reclaimResident?: boolean },
  ): Promise<{ readonly processTreeStopped: boolean }>
}
