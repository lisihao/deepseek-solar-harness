/** Host-local execution facilities consumed by authenticated Remote Sync. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { RemoteResidentArtifactDocument, RemoteExecutionWorkspaceIdentityV1 } from './remote-sync.ts'

/** Server-local result of resolving an execution workspace. */
export interface RemoteMaterializedWorkspaceV1 {
  readonly version: 1
  readonly identity: RemoteExecutionWorkspaceIdentityV1
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
   * Read the persisted default project for this Gouzi host.
   * @returns the registered project identity, or undefined on a generic host.
   */
  gouziWorkspace(): Promise<{ projectId: string } | undefined> {
    return Promise.resolve(undefined)
  }

  /**
   * Inspect a previously acquired execution lease without acquiring or replacing it.
   * @param _executionId - physical execution identity owning the workspace.
   * @returns its workspace, or undefined when no lease exists.
   * @throws Error - when this generic host does not implement lease inspection.
   */
  inspectWorkspace(_executionId: string): Promise<RemoteMaterializedWorkspaceV1 | undefined> {
    return Promise.reject(new Error('remote execution workspace inspection is unsupported'))
  }

  /**
   * Resolve an allowed Git commit or a registered Gouzi project directory.
   * @param identity - receiving-host workspace selection and optional subdirectory.
   * @param executionId - idempotent physical execution identity owning the workspace lease.
   * @returns a Server-local execution cwd.
   */
  abstract materializeWorkspace(
    identity: RemoteExecutionWorkspaceIdentityV1,
    executionId: string,
  ): Promise<RemoteMaterializedWorkspaceV1>

  /**
   * Extend one in-flight execution workspace lease after a durable turn observation.
   * @param executionId - physical execution identity owning the workspace.
   */
  abstract renewWorkspace(executionId: string): Promise<void>

  /**
   * Release one settled execution lease; registered project files remain on disk.
   * @param executionId - physical execution identity owning the workspace.
   */
  abstract releaseWorkspace(executionId: string): Promise<void>

  /**
   * Read exact immutable bytes for a Resident result artifact.
   * @param ref - content-addressed result reference.
   * @param signal - optional caller cancellation signal.
   * @returns exact JSON bytes whose SHA-256 is the supplied reference.
   */
  abstract readResidentArtifact(ref: string, signal?: AbortSignal): Promise<RemoteResidentArtifactDocument>
}
