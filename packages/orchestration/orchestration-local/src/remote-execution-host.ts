/** Server-local workspace admission and immutable Resident artifact Provider. */

import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  canonicalRemoteRepositoryIdentity,
  RemoteOperatorHostService,
  type RemoteMaterializedWorkspaceV1,
  type RemoteOperatorHostQualification,
  type RemoteResidentArtifactDocument,
  type RemoteResidentTurnSnapshot,
  type RemoteWorkspaceIdentityV1,
  type RemoteExecutionWorkspaceIdentityV1,
  type RemoteGouziWorkspaceIdentityV1,
} from '@deepseek-ai/dsh-client-connection'
import { readOrchestrationClusterConfig, type OrchestrationClusterMember } from './cluster.ts'

type WorkspaceMutation = NonNullable<NonNullable<RemoteResidentTurnSnapshot['result']>['workspaceMutation']>

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const QUALIFICATION_TTL_MS = 30_000

interface WorkspaceLeaseV1 {
  readonly version: 1
  readonly executionId: string
  readonly identity: RemoteExecutionWorkspaceIdentityV1
  readonly mutationReturn?: { readonly baseSha: string; readonly bundleDigest?: string }
  readonly snapshotInput?: { readonly baseSha: string; readonly bundleDigest: string }
  readonly leaseUntil: number
}

interface DirectoryWorkspaceLeaseV1 extends WorkspaceLeaseV1 {
  readonly identity: RemoteGouziWorkspaceIdentityV1
  readonly memberId: string
  readonly root: string
  readonly path: string
}

/** Runtime bounds for Server-local workspace materialization. */
export interface LocalRemoteOperatorHostOptions {
  readonly dshHome: string
  /** Absolute metadata root shared by every member on this host; required for directory executions. */
  readonly directoryLockRoot?: string
  readonly timeoutMs: number
  readonly artifactReadTimeoutMs: number
  readonly artifactMaxBytes: number
  readonly workspaceLeaseMs: number
}

/**
 * Derive the immutable Git identity represented by one clean sender workspace.
 * @param workspace - sender workspace inside a Git repository.
 * @param timeoutMs - upper bound for each Git inspection command.
 * @returns exact repository, commit, and optional subdirectory identity.
 */
export async function identifyRemoteWorkspace(
  workspace: string,
  timeoutMs: number,
): Promise<RemoteWorkspaceIdentityV1> {
  const cwd = await realpath(workspace)
  const root = await realpath((await git(['rev-parse', '--show-toplevel'], cwd, timeoutMs)).trim())
  const child = relative(root, cwd)
  if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    throw new Error('remote execution workspace is outside its Git repository')
  }
  const status = await git(['status', '--porcelain=v1', '-uall', '--no-renames'], root, timeoutMs)
  if (status.length > 0) {
    throw new Error('remote execution requires a clean Git workspace so one commit reproduces its inputs')
  }
  const commit = (await git(['rev-parse', 'HEAD'], root, timeoutMs)).trim()
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('remote execution could not resolve a full Git commit')
  const origin = (await git(['remote', 'get-url', 'origin'], root, timeoutMs)).trim()
  return {
    version: 1,
    repository: canonicalRemoteRepositoryIdentity(origin),
    commit,
    ...child.length === 0 ? {} : { subdir: child.split(sep).join('/') },
  }
}

/**
 * Resolve a local workspace to the repository a member may be allowed to materialize. Unlike
 * {@link identifyRemoteWorkspace} it does not require a clean tree: it names a repository, not a commit.
 * @param workspace - path inside a Git repository that has an `origin` remote.
 * @param timeoutMs - upper bound for each Git inspection command.
 * @returns the canonical repository identity and the repository root to clone from.
 */
export async function resolveRepositorySource(
  workspace: string,
  timeoutMs: number,
): Promise<{ readonly repository: string; readonly source: string }> {
  const cwd = await realpath(workspace)
  const root = await realpath((await git(['rev-parse', '--show-toplevel'], cwd, timeoutMs)).trim())
  const origin = (await git(['remote', 'get-url', 'origin'], root, timeoutMs)).trim()
  return { repository: canonicalRemoteRepositoryIdentity(origin), source: root }
}

/** Host Provider for isolated Git checkouts and locked registered project directories. */
export class LocalRemoteOperatorHostService extends RemoteOperatorHostService {
  private readonly mutationCaptures = new Map<string, Promise<WorkspaceMutation | undefined>>()
  private readonly cacheMaterializations = new Map<string, Promise<string>>()
  private readonly orchestrationRoot: string
  private readonly cacheRoot: string
  private readonly executionRoot: string
  private readonly residentArtifactRoot: string
  private qualificationCache: { readonly expiresAt: number; readonly value: RemoteOperatorHostQualification } | undefined

  constructor(ctx: Context, private readonly options: LocalRemoteOperatorHostOptions) {
    super(ctx)
    if (options.directoryLockRoot !== undefined && !isAbsolute(options.directoryLockRoot)) {
      throw new Error('directoryLockRoot must be an absolute path')
    }
    this.orchestrationRoot = join(options.dshHome, 'orchestrations')
    // Git materialization creates object paths below the cache and checkout.
    // Keep cluster configuration at its established location, but use a short
    // Windows-only workspace root so those paths stay below MAX_PATH.
    const remoteWorkspaceRoot = process.platform === 'win32'
      ? join(options.dshHome, 'rw')
      : join(this.orchestrationRoot, 'remote-workspaces')
    this.cacheRoot = join(remoteWorkspaceRoot, 'cache')
    this.executionRoot = join(remoteWorkspaceRoot, 'executions')
    this.residentArtifactRoot = join(options.dshHome, 'resident-operators', 'artifacts', 'sha256')
  }

  async qualification(): Promise<RemoteOperatorHostQualification> {
    if (this.ctx.get('gouziMember') === undefined
      && this.qualificationCache !== undefined && this.qualificationCache.expiresAt > Date.now()) {
      return this.qualificationCache.value
    }
    let value: RemoteOperatorHostQualification
    try {
      const member = this.localMember()
      const failures: string[] = []
      let available = false
      if ((member.remoteExecution?.projects?.length ?? 0) > 0) {
        const workspace = await this.gouziWorkspace()
        if (workspace === undefined) throw new Error('Gouzi default project is not configured')
        available = true
      }
      for (const repository of member.remoteExecution?.repositories ?? []) {
        try {
          if (isAbsolute(repository.source)) {
            const source = await realpath(repository.source)
            await this.verifyRepositoryIdentity(repository.repository, source)
            await this.git(['rev-parse', '--git-dir'], source)
          } else {
            await this.git(['ls-remote', '--exit-code', '--', repository.source, 'HEAD'])
          }
          available = true
          break
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
      value = available
        ? { available: true }
        : { available: false, reason: failures[0] ?? 'no configured repository can be materialized' }
    } catch (error) {
      value = { available: false, reason: error instanceof Error ? error.message : String(error) }
    }
    this.qualificationCache = { expiresAt: Date.now() + QUALIFICATION_TTL_MS, value }
    return value
  }

  override async gouziWorkspace(): Promise<{ readonly projectId: string; readonly projectScopes: readonly string[] } | undefined> {
    const member = this.localMember()
    const projectId = member.remoteExecution?.defaultProjectId
    if (projectId === undefined) {
      if ((member.remoteExecution?.projects?.length ?? 0) > 0) throw new Error('Gouzi default project is not configured')
      return undefined
    }
    const { root } = await this.registeredDirectory({ version: 1, kind: 'gouzi-project', projectId }, member)
    this.directoryLockPath(root)
    return { projectId, projectScopes: [root] }
  }

  override async inspectWorkspace(executionId: string): Promise<RemoteMaterializedWorkspaceV1 | undefined> {
    if (executionId.length === 0 || executionId.trim() !== executionId) {
      throw new Error('remote workspace executionId must be a non-blank trimmed string')
    }
    const isolatedLease = join(this.executionRoot, sha256(executionId), 'lease.json')
    if (await exists(isolatedLease)) {
      const lease = await this.readLease(isolatedLease)
      if (lease.executionId !== executionId) throw new Error('remote workspace lease identity mismatch')
      const checkout = join(this.executionRoot, sha256(executionId), 'checkout')
      return {
        version: 1, identity: lease.identity,
        path: lease.identity.subdir === undefined ? checkout : await containedDirectory(checkout, lease.identity.subdir),
      }
    }
    const lease = await this.directoryLease(executionId)
    if (lease === undefined) return undefined
    const selected = await this.registeredDirectory(lease.identity, this.localMember())
    this.expectDirectoryLease(lease, { ...lease, ...selected })
    const lock = await this.readDirectoryLease(this.directoryLockPath(selected.root))
    this.expectDirectoryLease(lock, lease)
    return { version: 1, identity: lease.identity, path: selected.path }
  }

  override supportsWorkspaceMutationReturn(): boolean { return true }
  override supportsWorkspaceSnapshotInput(): boolean { return true }

  override captureWorkspaceMutation(executionId: string): Promise<WorkspaceMutation | undefined> {
    let capture = this.mutationCaptures.get(executionId)
    if (capture === undefined) {
      capture = this.captureMutation(executionId).finally(() => { this.mutationCaptures.delete(executionId) })
      this.mutationCaptures.set(executionId, capture)
    }
    return capture
  }

  private async captureMutation(executionId: string): Promise<WorkspaceMutation | undefined> {
    const receipt = join(this.executionRoot, `${sha256(executionId)}.mutation.json`)
    if (await exists(receipt)) return parseMutationReceipt(JSON.parse(await readFile(receipt, 'utf8')) as unknown)
    const directory = join(this.executionRoot, sha256(executionId))
    if (!await exists(join(directory, 'lease.json'))) return undefined
    const lease = await this.readLease(join(directory, 'lease.json'))
    if (lease.executionId !== executionId) throw new Error('mutation workspace lease identity mismatch')
    if (lease.mutationReturn === undefined) return undefined
    const binding = 'kind' in lease.identity ? { projectId: lease.identity.projectId } : { repository: lease.identity.repository }
    const checkout = join(directory, 'checkout')
    await this.verifyCommit(checkout, lease.mutationReturn.baseSha, JSON.stringify(binding))
    await this.git(['add', '--all', '--', '.'], checkout)
    const patch = await this.git(['diff', '--cached', '--binary', '--no-ext-diff', lease.mutationReturn.baseSha, '--'], checkout)
    const mutation = { ...binding, baseSha: lease.mutationReturn.baseSha, patch }
    const temporary = `${receipt}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(mutation), { flag: 'wx', mode: 0o600 })
    await rename(temporary, receipt)
    return mutation
  }

  async materializeWorkspace(
    identity: RemoteExecutionWorkspaceIdentityV1,
    executionId: string,
    mutationReturn?: { readonly baseSha: string; readonly baseBundle?: string },
    snapshotInput?: { readonly baseSha: string; readonly baseBundle: string },
  ): Promise<RemoteMaterializedWorkspaceV1> {
    if (mutationReturn !== undefined && (!('kind' in identity) && identity.commit !== mutationReturn.baseSha)) throw new Error('mutation requires exact-base isolated Git workspace')
    if (mutationReturn?.baseBundle !== undefined && !('kind' in identity)) throw new Error('snapshot bundle requires a registered project binding')
    if (executionId.length === 0 || executionId.trim() !== executionId) {
      throw new Error('remote workspace executionId must be a non-blank trimmed string')
    }
    if (snapshotInput !== undefined && (!('kind' in identity)
      || (mutationReturn !== undefined && mutationReturn.baseSha !== snapshotInput.baseSha))) throw new Error('snapshot input requires a matching registered project mutation base')
    if ('kind' in identity) return mutationReturn === undefined && snapshotInput === undefined
      ? this.materializeDirectory(identity, executionId)
      : this.materializeProjectMutation(identity, executionId, mutationReturn, snapshotInput)
    if (await this.directoryLease(executionId) !== undefined) throw new Error('remote workspace execution identity conflicts with directory command')
    const normalized = normalizeIdentity(identity)
    const member = this.localMember()
    const source = member.remoteExecution?.repositories
      .find(value => value.repository === normalized.repository)?.source
    if (source === undefined) {
      throw new Error(`remote repository "${normalized.repository}" is not allowed on Server ${member.id}`)
    }
    await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 })
    await mkdir(this.executionRoot, { recursive: true, mode: 0o700 })
    await Promise.all([chmod(this.cacheRoot, 0o700), chmod(this.executionRoot, 0o700)])
    await this.cleanupExpiredWorkspaces()
    const cache = await this.materializeCache(normalized.repository, source, normalized.commit)
    const executionDirectory = join(this.executionRoot, sha256(executionId))
    const checkout = join(executionDirectory, 'checkout')
    const leasePath = join(executionDirectory, 'lease.json')
    if (await exists(executionDirectory)) {
      const lease = await this.readLease(leasePath)
      if (lease.executionId !== executionId || canonicalIdentity(lease.identity) !== canonicalIdentity(normalized)
        || lease.mutationReturn?.baseSha !== mutationReturn?.baseSha) {
        throw new Error(`remote workspace execution identity conflicts with existing command ${executionId}`)
      }
      await this.writeLease(leasePath, { ...lease, leaseUntil: Date.now() + this.options.workspaceLeaseMs })
      return this.materializedResult(normalized, checkout)
    }
    const temporaryRoot = await mkdtemp(join(this.executionRoot, '.execution-'))
    const temporaryCheckout = join(temporaryRoot, 'checkout')
    try {
      await this.git(['clone', '--shared', '--no-checkout', '--', cache, temporaryCheckout])
      await this.git(['checkout', '--detach', normalized.commit], temporaryCheckout)
      const status = await this.git(['status', '--porcelain=v1', '-uall', '--no-renames'], temporaryCheckout)
      if (status.length > 0) throw new Error('fresh remote execution workspace is not clean')
      await this.writeLease(join(temporaryRoot, 'lease.json'), {
        version: 1,
        executionId,
        identity: normalized,
        ...mutationReturn === undefined ? {} : { mutationReturn: { baseSha: mutationReturn.baseSha } },
        leaseUntil: Date.now() + this.options.workspaceLeaseMs,
      })
      try {
        await rename(temporaryRoot, executionDirectory)
      } catch (error) {
        if (!await exists(executionDirectory)) throw error
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
    const installedLease = await this.readLease(leasePath)
    if (installedLease.mutationReturn?.baseSha !== mutationReturn?.baseSha) throw new Error('remote mutation command conflicts with existing lease')
    if (installedLease.executionId !== executionId
      || canonicalIdentity(installedLease.identity) !== canonicalIdentity(normalized)) {
      throw new Error(`remote workspace execution identity conflicts with existing command ${executionId}`)
    }
    return this.materializedResult(normalized, checkout)
  }

  private async materializeProjectMutation(
    identity: RemoteGouziWorkspaceIdentityV1,
    executionId: string,
    mutationReturn: { readonly baseSha: string; readonly baseBundle?: string } | undefined,
    snapshotInput: { readonly baseSha: string; readonly baseBundle: string } | undefined,
  ): Promise<RemoteMaterializedWorkspaceV1> {
    const { root } = await this.registeredDirectory(identity, this.localMember())
    const input = snapshotInput ?? mutationReturn
    if (input === undefined) throw new Error('isolated project execution requires sealed inputs')
    if (input.baseBundle === undefined) await this.verifyCommit(root, input.baseSha, identity.projectId)
    const bundle = input.baseBundle === undefined ? undefined : Buffer.from(input.baseBundle, 'base64')
    if (bundle !== undefined && (bundle.byteLength > 8 * 1024 * 1024 || bundle.toString('base64') !== input.baseBundle)) {
      throw new Error('invalid or oversized snapshot base bundle')
    }
    const bundleDigest = bundle === undefined ? undefined : createHash('sha256').update(bundle).digest('hex')
    const persistedMutation = mutationReturn === undefined ? undefined : { baseSha: mutationReturn.baseSha,
      ...bundleDigest === undefined ? {} : { bundleDigest } }
    const persistedInput = snapshotInput === undefined ? undefined
      : { baseSha: snapshotInput.baseSha, bundleDigest: bundleDigest as string }
    await prepareMetadataDirectory(this.executionRoot, root)
    const directory = join(this.executionRoot, sha256(executionId))
    const leasePath = join(directory, 'lease.json')
    if (await exists(leasePath)) {
      const lease = await this.readLease(leasePath)
      if (lease.executionId !== executionId || canonicalIdentity(lease.identity) !== canonicalIdentity(identity)
        || lease.mutationReturn?.baseSha !== mutationReturn?.baseSha
        || lease.mutationReturn?.bundleDigest !== persistedMutation?.bundleDigest
        || lease.snapshotInput?.baseSha !== persistedInput?.baseSha
        || lease.snapshotInput?.bundleDigest !== persistedInput?.bundleDigest) throw new Error('remote project mutation conflicts with original command')
    } else {
      if (await exists(directory)) throw new Error('remote project mutation workspace is unresolved')
      await mkdir(directory, { mode: 0o700 })
      // Failure retains the command directory; an unknown execution cannot acquire a fresh checkout.
      const checkout = join(directory, 'checkout')
      if (bundle === undefined) await this.git(['clone', '--no-checkout', '--local', '--', root, checkout])
      else {
        await mkdir(checkout)
        await this.git(['init', '--initial-branch=main'], checkout)
        const bundlePath = join(directory, 'base.bundle')
        await writeFile(bundlePath, bundle, { flag: 'wx', mode: 0o600 })
        await this.git(['bundle', 'verify', bundlePath], checkout)
        await this.git(['bundle', 'unbundle', bundlePath], checkout)
        await this.verifyCommit(checkout, input.baseSha, identity.projectId)
      }
      await this.git(['checkout', '--detach', input.baseSha], checkout)
      await this.writeLease(leasePath, {
        version: 1, executionId, identity,
        ...persistedMutation === undefined ? {} : { mutationReturn: persistedMutation },
        ...persistedInput === undefined ? {} : { snapshotInput: persistedInput },
        leaseUntil: Date.now() + this.options.workspaceLeaseMs,
      })
    }
    const checkout = await realpath(join(directory, 'checkout'))
    return { version: 1, identity, path: identity.subdir === undefined ? checkout : await containedDirectory(checkout, identity.subdir) }
  }

  async renewWorkspace(executionId: string): Promise<void> {
    const directoryLease = await this.directoryLease(executionId)
    if (directoryLease !== undefined) {
      await this.withDirectoryAdmission(async () => {
        const lockPath = this.directoryLockPath(directoryLease.root)
        const lock = await this.readDirectoryLease(lockPath)
        this.expectDirectoryLease(lock, directoryLease)
        await this.writeLease(lockPath, { ...lock, leaseUntil: Date.now() + this.options.workspaceLeaseMs })
      })
      return
    }
    const directory = join(this.executionRoot, sha256(executionId))
    const leasePath = join(directory, 'lease.json')
    if (!await exists(leasePath)) return
    const lease = await this.readLease(leasePath)
    if (lease.executionId !== executionId) throw new Error('remote workspace lease identity mismatch')
    await this.writeLease(leasePath, { ...lease, leaseUntil: Date.now() + this.options.workspaceLeaseMs })
  }

  async releaseWorkspace(executionId: string): Promise<void> {
    const lease = await this.directoryLease(executionId)
    if (lease !== undefined) {
      await this.withDirectoryAdmission(async () => {
        const lockPath = this.directoryLockPath(lease.root)
        if (await exists(lockPath)) {
          const lock = await this.readDirectoryLease(lockPath)
          this.expectDirectoryLease(lock, lease)
          await rm(lockPath)
        }
        await rm(this.directoryReceiptPath(executionId))
      })
      return
    }
    await rm(join(this.executionRoot, sha256(executionId)), { recursive: true, force: true })
  }

  async readResidentArtifact(ref: string, signal?: AbortSignal): Promise<RemoteResidentArtifactDocument> {
    const digest = artifactDigest(ref)
    const path = join(this.residentArtifactRoot, digest)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size > this.options.artifactMaxBytes) {
      throw new Error(`Resident artifact exceeds ${String(this.options.artifactMaxBytes)} bytes: ${ref}`)
    }
    const deadline = AbortSignal.timeout(this.options.artifactReadTimeoutMs)
    const readSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
    const bytes = await readFile(path, { signal: readSignal })
    if (bytes.byteLength > this.options.artifactMaxBytes) {
      throw new Error(`Resident artifact exceeds ${String(this.options.artifactMaxBytes)} bytes: ${ref}`)
    }
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== digest) throw new Error(`Resident artifact digest mismatch: ${ref}`)
    const json = bytes.toString('utf8')
    JSON.parse(json)
    return { ref, json }
  }

  private localMember(): OrchestrationClusterMember {
    const cluster = readOrchestrationClusterConfig(this.orchestrationRoot)
    if (cluster === undefined) throw new Error('remote workspace materialization requires cluster.json')
    const member = cluster.members.find(value => value.id === cluster.nodeId)
    if (member?.remoteExecution?.enabled !== true) {
      throw new Error(`remote execution is not enabled for local cluster member ${cluster.nodeId}`)
    }
    return member
  }

  private async registeredDirectory(
    identity: RemoteGouziWorkspaceIdentityV1,
    member: OrchestrationClusterMember,
  ): Promise<{ root: string; path: string }> {
    if (this.ctx.get('gouziMember') === undefined) throw new Error('directory execution requires a mounted Gouzi member')
    if (identity.projectId.length === 0 || identity.projectId.trim() !== identity.projectId) {
      throw new Error('remote workspace projectId must be a non-blank trimmed string')
    }
    const project = member.remoteExecution?.projects?.find(value => value.projectId === identity.projectId)
    if (project === undefined) throw new Error(`remote project "${identity.projectId}" is not registered on Server ${member.id}`)
    const root = await realpath(project.source)
    if (!(await stat(root)).isDirectory()) throw new Error('registered project source is not a directory')
    const subdir = normalizeDirectorySubdir(identity.subdir)
    const path = subdir === undefined ? root : await containedDirectory(root, subdir)
    return { root, path }
  }

  private directoryLockPath(root: string): string {
    const lockRoot = this.options.directoryLockRoot
    if (lockRoot === undefined || !isAbsolute(lockRoot)) {
      throw new Error('directory execution requires an absolute shared directoryLockRoot')
    }
    return join(lockRoot, `${sha256(root)}.json`)
  }

  private directoryReceiptPath(executionId: string): string {
    return join(this.executionRoot, `${sha256(executionId)}.directory.json`)
  }

  private async directoryLease(executionId: string): Promise<DirectoryWorkspaceLeaseV1 | undefined> {
    const receipt = this.directoryReceiptPath(executionId)
    if (!await exists(receipt)) return undefined
    const lease = await this.readDirectoryLease(receipt)
    if (lease.executionId !== executionId || lease.memberId !== this.localMember().id) {
      throw new Error('directory workspace lease identity mismatch')
    }
    return lease
  }

  private async readDirectoryLease(path: string): Promise<DirectoryWorkspaceLeaseV1> {
    const lease = await this.readLease(path)
    const directory = lease as Partial<DirectoryWorkspaceLeaseV1>
    const rawIdentity: unknown = lease.identity
    if (rawIdentity === null || typeof rawIdentity !== 'object' || Array.isArray(rawIdentity)) {
      throw new Error('invalid directory workspace lease')
    }
    const identity = rawIdentity as Record<string, unknown>
    if (identity.kind !== 'gouzi-project'
      || identity.version !== 1 || typeof identity.projectId !== 'string'
      || identity.projectId.length === 0 || identity.projectId.trim() !== identity.projectId
      || (identity.subdir !== undefined && typeof identity.subdir !== 'string')
      || !Number.isSafeInteger(lease.leaseUntil) || lease.leaseUntil < 0
      || typeof directory.memberId !== 'string' || typeof directory.root !== 'string'
      || !isAbsolute(directory.root) || typeof directory.path !== 'string' || !isAbsolute(directory.path)) {
      throw new Error('invalid directory workspace lease')
    }
    normalizeDirectorySubdir(identity.subdir)
    return directory as DirectoryWorkspaceLeaseV1
  }

  private expectDirectoryLease(actual: DirectoryWorkspaceLeaseV1, expected: DirectoryWorkspaceLeaseV1): void {
    if (actual.memberId !== expected.memberId || actual.executionId !== expected.executionId
      || actual.root !== expected.root || actual.path !== expected.path
      || canonicalIdentity(actual.identity) !== canonicalIdentity(expected.identity)) {
      throw new Error('directory workspace is locked by a conflicting execution')
    }
  }

  private async materializeDirectory(
    identity: RemoteGouziWorkspaceIdentityV1,
    executionId: string,
  ): Promise<RemoteMaterializedWorkspaceV1> {
    const member = this.localMember()
    const subdir = normalizeDirectorySubdir(identity.subdir)
    const normalized: RemoteGouziWorkspaceIdentityV1 = {
      version: 1, kind: 'gouzi-project', projectId: identity.projectId,
      ...subdir === undefined ? {} : { subdir },
    }
    const { root, path } = await this.registeredDirectory(normalized, member)
    const lockPath = this.directoryLockPath(root)
    await prepareMetadataDirectory(dirname(lockPath), root)
    await prepareMetadataDirectory(this.executionRoot, root)
    if (await exists(join(this.executionRoot, sha256(executionId)))) {
      throw new Error('remote workspace execution identity conflicts with Git command')
    }
    const lease: DirectoryWorkspaceLeaseV1 = {
      version: 1, executionId, identity: normalized, memberId: member.id, root, path,
      leaseUntil: Date.now() + this.options.workspaceLeaseMs,
    }
    await this.withDirectoryAdmission(async () => {
      for (const entry of await readdir(dirname(lockPath), { withFileTypes: true })) {
        if (!entry.name.endsWith('.json')) continue
        const existing = await this.readDirectoryLease(join(dirname(lockPath), entry.name))
        if (!directoriesOverlap(existing.root, root)) continue
        this.expectDirectoryLease(existing, lease)
        // Expiry cannot prove that the original Resident command has stopped.
        if (existing.leaseUntil <= Date.now()) throw new Error('directory workspace has an expired unresolved execution lock')
      }
      const receipt = await this.directoryLease(executionId)
      if (receipt !== undefined) this.expectDirectoryLease(receipt, lease)
      await this.writeLease(this.directoryReceiptPath(executionId), lease)
      // A failed lock write never removes an older owner's metadata.
      await this.writeLease(lockPath, lease)
    })
    return { version: 1, identity: normalized, path }
  }

  private async withDirectoryAdmission<T>(operation: () => Promise<T>): Promise<T> {
    const guard = join(dirname(this.directoryLockPath('/')), '.admission')
    try {
      await writeFile(guard, `${randomUUID()}\n`, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('directory workspace admission is busy or unresolved')
      }
      throw error
    }
    try {
      return await operation()
    } finally {
      await rm(guard)
    }
  }

  private async materializeCache(repository: string, source: string, commit: string): Promise<string> {
    const repositoryDirectory = join(this.cacheRoot, sha256(repository))
    const target = join(repositoryDirectory, `${commit}.git`)
    const key = `${repository}\0${commit}`
    let materialization = this.cacheMaterializations.get(key)
    if (materialization === undefined) {
      materialization = this.ensureCache(repository, source, commit, target)
        .finally(() => { this.cacheMaterializations.delete(key) })
      this.cacheMaterializations.set(key, materialization)
    }
    return materialization
  }

  private async ensureCache(repository: string, source: string, commit: string, target: string): Promise<string> {
    if (!await exists(target)) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      const temporaryRoot = await mkdtemp(join(dirname(target), '.cache-'))
      const mirror = join(temporaryRoot, 'mirror.git')
      try {
        const localSource = isAbsolute(source) ? await realpath(source) : undefined
        if (localSource !== undefined) await this.verifyRepositoryIdentity(repository, localSource)
        await this.git(['clone', '--mirror', ...(localSource === undefined ? [] : ['--local']), '--', localSource ?? source, mirror])
        if (localSource === undefined) await this.verifyRepositoryIdentity(repository, mirror)
        await this.verifyCommit(mirror, commit, repository)
        try {
          await rename(mirror, target)
        } catch (error) {
          if (!await exists(target)) throw error
        }
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true })
      }
    }
    await this.verifyCommit(target, commit, repository)
    return realpath(target)
  }

  private async verifyCommit(workspace: string, commit: string, repository: string): Promise<void> {
    const resolved = (await this.git(['rev-parse', '--verify', `${commit}^{commit}`], workspace)).trim()
    if (resolved !== commit) throw new Error(`remote repository ${repository} does not resolve exact commit ${commit}`)
  }

  private async verifyRepositoryIdentity(repository: string, workspace: string): Promise<void> {
    const origin = (await this.git(['remote', 'get-url', 'origin'], workspace)).trim()
    const actual = canonicalRemoteRepositoryIdentity(origin)
    if (actual !== repository) throw new Error(`Git source identity is ${actual}, expected ${repository}`)
  }

  private async materializedResult(
    identity: RemoteWorkspaceIdentityV1,
    checkout: string,
  ): Promise<RemoteMaterializedWorkspaceV1> {
    const root = await realpath(checkout)
    const actual = (await this.git(['rev-parse', 'HEAD'], root)).trim()
    if (actual !== identity.commit) throw new Error(`materialized remote workspace is at ${actual}, expected ${identity.commit}`)
    const path = identity.subdir === undefined ? root : await containedDirectory(root, identity.subdir)
    return { version: 1, identity, path }
  }

  private async cleanupExpiredWorkspaces(): Promise<void> {
    if (!await exists(this.executionRoot)) return
    for (const entry of await readdir(this.executionRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const directory = join(this.executionRoot, entry.name)
      try {
        const lease = await this.readLease(join(directory, 'lease.json'))
        if (lease.mutationReturn === undefined && lease.leaseUntil <= Date.now()) await rm(directory, { recursive: true, force: true })
      } catch {
        // An incomplete execution directory is not authoritative and is safe to reap.
        await rm(directory, { recursive: true, force: true })
      }
    }
  }

  private async readLease(path: string): Promise<WorkspaceLeaseV1> {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<WorkspaceLeaseV1>
    if (value.version !== 1 || typeof value.executionId !== 'string' || typeof value.leaseUntil !== 'number'
      || value.identity === undefined) throw new Error('invalid remote workspace lease')
    return value as WorkspaceLeaseV1
  }

  private async writeLease(path: string, lease: WorkspaceLeaseV1): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(lease)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  private async git(args: readonly string[], cwd?: string): Promise<string> {
    return git(args, cwd, this.options.timeoutMs)
  }
}

function parseMutationReceipt(value: unknown): WorkspaceMutation {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid persisted mutation receipt')
  const record = value as Record<string, unknown>
  if (typeof record.baseSha !== 'string' || !/^[a-f0-9]{40}$/u.test(record.baseSha)
    || typeof record.patch !== 'string' || Buffer.byteLength(record.patch, 'utf8') > MAX_GIT_OUTPUT_BYTES
    || (typeof record.repository !== 'string' && typeof record.projectId !== 'string')) throw new Error('invalid persisted mutation receipt')
  return value as WorkspaceMutation
}

function directoriesOverlap(first: string, second: string): boolean {
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child)
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
  }
  return contains(first, second) || contains(second, first)
}

async function prepareMetadataDirectory(path: string, projectRoot: string): Promise<void> {
  let ancestor = resolve(path)
  const suffix: string[] = []
  while (!await exists(ancestor)) {
    suffix.unshift(relative(dirname(ancestor), ancestor))
    ancestor = dirname(ancestor)
  }
  const target = resolve(await realpath(ancestor), ...suffix)
  const child = relative(projectRoot, target)
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) {
    throw new Error('directory execution metadata must be outside the registered project')
  }
  await mkdir(path, { recursive: true, mode: 0o700 })
}

async function git(args: readonly string[], cwd: string | undefined, timeoutMs: number): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    ...cwd === undefined ? {} : { cwd },
    encoding: 'utf8', env: scrubbedEnvironment(), maxBuffer: MAX_GIT_OUTPUT_BYTES, timeout: timeoutMs,
  })
  return stdout
}

function normalizeIdentity(identity: RemoteWorkspaceIdentityV1): RemoteWorkspaceIdentityV1 {
  const repository = canonicalRemoteRepositoryIdentity(identity.repository)
  if (!/^[a-f0-9]{40}$/u.test(identity.commit)) throw new Error('remote workspace commit must be a lowercase full Git SHA')
  const subdir = normalizeSubdir(identity.subdir)
  return { version: 1, repository, commit: identity.commit, ...subdir === undefined ? {} : { subdir } }
}

function canonicalIdentity(identity: RemoteExecutionWorkspaceIdentityV1): string {
  return JSON.stringify('kind' in identity
    ? { version: 1, kind: 'gouzi-project', projectId: identity.projectId, ...identity.subdir === undefined ? {} : { subdir: normalizeDirectorySubdir(identity.subdir) } }
    : normalizeIdentity(identity))
}

function normalizeDirectorySubdir(value: string | undefined): string | undefined {
  if (value?.includes('\\') === true) throw new Error('remote workspace subdir must use forward slashes')
  return normalizeSubdir(value)
}

function normalizeSubdir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (value.length === 0 || value.trim() !== value || value.startsWith('/')) {
    throw new Error('remote workspace subdir must be a non-blank normalized relative path')
  }
  const segments = value.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('remote workspace subdir must not contain empty, dot, or parent segments')
  }
  return segments.join('/')
}

async function containedDirectory(root: string, subdir: string): Promise<string> {
  const candidate = await realpath(resolve(root, subdir))
  const child = relative(root, candidate)
  if (child.length === 0 || child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    throw new Error('remote workspace subdir escapes the materialized repository')
  }
  if (!(await stat(candidate)).isDirectory()) throw new Error('remote workspace subdir is not a directory')
  return candidate
}

function artifactDigest(ref: string): string {
  const digest = ref.startsWith('sha256:') ? ref.slice(7) : ''
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('invalid Resident artifact reference')
  return digest
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const upper = name.toUpperCase()
    return !upper.includes('KEY') && !upper.includes('SECRET')
      && !upper.includes('TOKEN') && !upper.includes('PASSWORD')
  }))
}
