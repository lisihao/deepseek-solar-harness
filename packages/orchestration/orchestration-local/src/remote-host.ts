/**
 * Mounts only the Server-local remote execution host. A Gouzi member uses it to materialize exact-commit
 * workspaces without a TaskGraph daemon, scheduler, or cluster election.
 * @module @deepseek-ai/dsh-orchestration-local/remote-host
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { LocalRemoteOperatorHostService } from './remote-execution-host.ts'

export const name = 'orchestration-remote-host'

/** Remote execution host configuration shared with the full local orchestration plugin. */
export interface RemoteHostConfig {
  /** Optional DSH home; defaults to the ordinary harness-owned location. */
  readonly dshHome?: string
  /** Maximum time for one Server-side exact-commit Git materialization. */
  readonly remoteMaterializationTimeoutMs?: number
  /** Maximum time for one bounded Resident artifact read. */
  readonly remoteArtifactReadTimeoutMs?: number
  /** Maximum exact artifact bytes returned over Remote Sync. */
  readonly remoteArtifactMaxBytes?: number
  /** Lease retained for one command-isolated remote execution checkout. */
  readonly remoteWorkspaceLeaseMs?: number
}

export const Config: z<RemoteHostConfig> = z.object({
  dshHome: z.string(),
  remoteMaterializationTimeoutMs: z.number().step(1).min(1_000).max(15 * 60_000).default(120_000),
  remoteArtifactReadTimeoutMs: z.number().step(1).min(100).max(60_000).default(15_000),
  remoteArtifactMaxBytes: z.number().step(1).min(1_024).max(8 * 1024 * 1024).default(8 * 1024 * 1024),
  remoteWorkspaceLeaseMs: z.number().step(1).min(60_000).max(7 * 24 * 60 * 60_000).default(24 * 60 * 60_000),
})

/**
 * Register the remote execution host service.
 * @param ctx - plugin context.
 * @param config - resolved remote execution host configuration.
 */
export function apply(ctx: Context, config: RemoteHostConfig): void {
  mountRemoteOperatorHost(ctx, config as Required<Omit<RemoteHostConfig, 'dshHome'>> & Pick<RemoteHostConfig, 'dshHome'>)
}

/**
 * Construct the service from a fully defaulted configuration.
 * @param ctx - plugin context that owns the service.
 * @param config - defaulted configuration.
 */
export function mountRemoteOperatorHost(
  ctx: Context,
  config: Required<Omit<RemoteHostConfig, 'dshHome'>> & Pick<RemoteHostConfig, 'dshHome'>,
): void {
  new LocalRemoteOperatorHostService(ctx, {
    dshHome: resolveDshHome(config.dshHome),
    timeoutMs: config.remoteMaterializationTimeoutMs,
    artifactReadTimeoutMs: config.remoteArtifactReadTimeoutMs,
    artifactMaxBytes: config.remoteArtifactMaxBytes,
    workspaceLeaseMs: config.remoteWorkspaceLeaseMs,
  })
}
