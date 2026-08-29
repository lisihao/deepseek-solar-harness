/** Host-local execution facilities consumed by authenticated Remote Sync. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { RemoteResidentArtifactDocument, RemoteWorkspaceIdentityV1 } from './remote-sync.ts'

/** Server-local result of resolving and materializing one immutable Git workspace. */
export interface RemoteMaterializedWorkspaceV1 {
  readonly version: 1
  readonly identity: RemoteWorkspaceIdentityV1
  /** Absolute Server-local cwd; this value is never returned over Remote Sync. */
  readonly path: string
}

/** Bounded readiness result used before advertising remote execution. */
export interface RemoteOperatorHostQualification {
  readonly available: boolean
  readonly reason?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteOperatorHost: RemoteOperatorHostService
  }
}

/**
 * Server-local Provider seam for remote execution workspaces and Resident artifacts.
 * The connection package owns the wire Consumer; deployment-specific Git and
 * filesystem behavior belongs to a separately mounted Provider.
 */
export abstract class RemoteOperatorHostService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'remoteOperatorHost')
  }

  /**
   * Prove at least one configured repository can be resolved on this Server.
   * @returns bounded readiness without exposing source URLs or credentials.
   */
  abstract qualification(): Promise<RemoteOperatorHostQualification>

  /**
   * Resolve an allowed repository identity and materialize its exact commit.
   * @param identity - immutable repository, commit, and optional subdirectory.
   * @param executionId - idempotent physical execution identity owning the isolated workspace lease.
   * @returns a Server-local execution cwd.
   */
  abstract materializeWorkspace(
    identity: RemoteWorkspaceIdentityV1,
    executionId: string,
  ): Promise<RemoteMaterializedWorkspaceV1>

  /** Extend one in-flight execution workspace lease after a durable turn observation. */
  abstract renewWorkspace(executionId: string): Promise<void>

  /** Release one proven-settled execution workspace without touching the immutable object cache. */
  abstract releaseWorkspace(executionId: string): Promise<void>

  /**
   * Read exact immutable bytes for a Resident result artifact.
   * @param ref - content-addressed result reference.
   * @returns exact JSON bytes whose SHA-256 is the supplied reference.
   */
  abstract readResidentArtifact(ref: string, signal?: AbortSignal): Promise<RemoteResidentArtifactDocument>
}
