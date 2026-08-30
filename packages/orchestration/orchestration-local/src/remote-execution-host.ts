/** Server-local Git materialization and immutable Resident artifact Provider. */

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
  type RemoteWorkspaceIdentityV1,
} from '@deepseek-ai/dsh-client-connection'
import { readOrchestrationClusterConfig, type OrchestrationClusterMember } from './cluster.ts'

const execFileAsync = promisify(execFile)
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024
const QUALIFICATION_TTL_MS = 30_000

interface WorkspaceLeaseV1 {
  readonly version: 1
  readonly executionId: string
  readonly identity: RemoteWorkspaceIdentityV1
  readonly leaseUntil: number
}

/** Runtime bounds for one Server-local Git materialization. */
export interface LocalRemoteOperatorHostOptions {
  readonly dshHome: string
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

/** Host Provider backed by immutable Git caches and per-command writable checkouts. */
export class LocalRemoteOperatorHostService extends RemoteOperatorHostService {
  private readonly cacheMaterializations = new Map<string, Promise<string>>()
  private readonly orchestrationRoot: string
  private readonly cacheRoot: string
  private readonly executionRoot: string
  private readonly residentArtifactRoot: string
  private qualificationCache: { readonly expiresAt: number; readonly value: RemoteOperatorHostQualification } | undefined

  constructor(ctx: Context, private readonly options: LocalRemoteOperatorHostOptions) {
    super(ctx)
    this.orchestrationRoot = join(options.dshHome, 'orchestrations')
    this.cacheRoot = join(this.orchestrationRoot, 'remote-workspaces', 'cache')
    this.executionRoot = join(this.orchestrationRoot, 'remote-workspaces', 'executions')
    this.residentArtifactRoot = join(options.dshHome, 'resident-operators', 'artifacts', 'sha256')
  }

  async qualification(): Promise<RemoteOperatorHostQualification> {
    if (this.qualificationCache !== undefined && this.qualificationCache.expiresAt > Date.now()) {
      return this.qualificationCache.value
    }
    let value: RemoteOperatorHostQualification
    try {
      const member = this.localMember()
      const failures: string[] = []
      let available = false
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

  async materializeWorkspace(
    identity: RemoteWorkspaceIdentityV1,
    executionId: string,
  ): Promise<RemoteMaterializedWorkspaceV1> {
    if (executionId.length === 0 || executionId.trim() !== executionId) {
      throw new Error('remote workspace executionId must be a non-blank trimmed string')
    }
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
      if (lease.executionId !== executionId || canonicalIdentity(lease.identity) !== canonicalIdentity(normalized)) {
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
    if (installedLease.executionId !== executionId
      || canonicalIdentity(installedLease.identity) !== canonicalIdentity(normalized)) {
      throw new Error(`remote workspace execution identity conflicts with existing command ${executionId}`)
    }
    return this.materializedResult(normalized, checkout)
  }

  async renewWorkspace(executionId: string): Promise<void> {
    const directory = join(this.executionRoot, sha256(executionId))
    const leasePath = join(directory, 'lease.json')
    if (!await exists(leasePath)) return
    const lease = await this.readLease(leasePath)
    if (lease.executionId !== executionId) throw new Error('remote workspace lease identity mismatch')
    await this.writeLease(leasePath, { ...lease, leaseUntil: Date.now() + this.options.workspaceLeaseMs })
  }

  async releaseWorkspace(executionId: string): Promise<void> {
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
        if (lease.leaseUntil <= Date.now()) await rm(directory, { recursive: true, force: true })
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

function canonicalIdentity(identity: RemoteWorkspaceIdentityV1): string {
  return JSON.stringify(normalizeIdentity(identity))
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
