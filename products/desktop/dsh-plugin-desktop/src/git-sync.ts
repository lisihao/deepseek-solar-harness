/** Desktop-owned background synchronization for immutable Git commits. */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export type DesktopGitSyncDirection = 'pull' | 'push' | 'bidirectional'
export type DesktopGitSyncResultState = 'idle' | 'up-to-date' | 'pulled' | 'pushed' | 'paused-dirty' | 'blocked-direction' | 'conflict' | 'error'

export interface DesktopGitSyncRepository {
  readonly id: string
  readonly label: string
  readonly repositoryPath: string
  readonly authorityRemote: string
  readonly branch: string
  readonly direction: DesktopGitSyncDirection
  readonly acceleratorRemote?: string
}

export interface DesktopGitSyncRepositoryResult {
  readonly repositoryId: string
  readonly state: DesktopGitSyncResultState
  readonly message: string
  readonly localHead?: string
  readonly authorityHead?: string
  readonly completedAt: string
}

export interface DesktopGitSyncSnapshot {
  readonly version: 1
  readonly enabled: boolean
  readonly intervalMinutes: number
  readonly repositories: readonly DesktopGitSyncRepository[]
  readonly results: readonly DesktopGitSyncRepositoryResult[]
  readonly running: boolean
}

export interface DesktopGitSyncConfigureRequest {
  readonly enabled: boolean
  readonly intervalMinutes: number
  readonly repositories: readonly DesktopGitSyncRepository[]
}

interface DesktopGitSyncDocument extends DesktopGitSyncConfigureRequest {
  readonly version: 1
  readonly results: readonly DesktopGitSyncRepositoryResult[]
}

export interface DesktopGitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string>
}

const DEFAULT_DOCUMENT: DesktopGitSyncDocument = {
  version: 1,
  enabled: false,
  intervalMinutes: 10,
  repositories: [],
  results: [],
}

/** Execute bounded Git commands without a shell. */
export class NativeDesktopGitCommandRunner implements DesktopGitCommandRunner {
  run(cwd: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(String(stderr).trim() || error.message))
          return
        }
        resolve(String(stdout).trim())
      })
    })
  }
}

/**
 * Synchronize only clean, committed repositories against an authoritative Git remote.
 * An optional peer remote can prefetch objects, but never decides the accepted ref.
 */
export class DesktopGitSyncController {
  private readonly statePath: string
  private document: DesktopGitSyncDocument = DEFAULT_DOCUMENT
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<DesktopGitSyncSnapshot> | undefined
  private started = false

  constructor(
    userDataPath: string,
    private readonly git: DesktopGitCommandRunner = new NativeDesktopGitCommandRunner(),
  ) {
    this.statePath = join(userDataPath, 'git-sync', 'state.json')
  }

  async start(): Promise<void> {
    if (this.started) return
    this.document = await this.load()
    this.started = true
    this.schedule()
  }

  stop(): void {
    this.started = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  snapshot(): DesktopGitSyncSnapshot {
    return { ...structuredClone(this.document), running: this.active !== undefined }
  }

  async configure(request: DesktopGitSyncConfigureRequest): Promise<DesktopGitSyncSnapshot> {
    const config = parseConfigureRequest(request)
    const repositoryIds = new Set(config.repositories.map(repository => repository.id))
    this.document = {
      version: 1,
      ...config,
      results: this.document.results.filter(result => repositoryIds.has(result.repositoryId)),
    }
    await this.persist()
    this.schedule()
    return this.snapshot()
  }

  runNow(): Promise<DesktopGitSyncSnapshot> {
    const current = this.active
    if (current !== undefined) return current
    const run = this.runAll().finally(() => {
      if (this.active === run) this.active = undefined
      this.schedule()
    })
    this.active = run
    return run
  }

  private async runAll(): Promise<DesktopGitSyncSnapshot> {
    const results: DesktopGitSyncRepositoryResult[] = []
    for (const repository of this.document.repositories) {
      results.push(await this.syncRepository(repository))
    }
    this.document = { ...this.document, results }
    await this.persist()
    return { ...structuredClone(this.document), running: false }
  }

  private async syncRepository(repository: DesktopGitSyncRepository): Promise<DesktopGitSyncRepositoryResult> {
    const completedAt = new Date().toISOString()
    try {
      if (await this.git.run(repository.repositoryPath, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
        throw new Error('path is not a Git worktree')
      }
      if ((await this.git.run(repository.repositoryPath, ['status', '--porcelain'])).length > 0) {
        return result(repository.id, 'paused-dirty', '工作树有未提交修改；未执行同步', completedAt)
      }
      const currentBranch = await this.git.run(repository.repositoryPath, ['symbolic-ref', '--short', 'HEAD'])
      if (currentBranch !== repository.branch) {
        throw new Error(`当前分支是 ${currentBranch}，不是配置的 ${repository.branch}`)
      }
      await this.git.run(repository.repositoryPath, ['remote', 'get-url', repository.authorityRemote])
      let acceleratorWarning: string | undefined
      if (repository.acceleratorRemote !== undefined) {
        try {
          await this.git.run(repository.repositoryPath, ['remote', 'get-url', repository.acceleratorRemote])
          await this.git.run(repository.repositoryPath, ['fetch', '--no-tags', repository.acceleratorRemote, repository.branch])
        } catch (error) {
          acceleratorWarning = `Tailscale/SSH 预取不可用：${error instanceof Error ? error.message : String(error)}`
        }
      }
      const message = (value: string): string => acceleratorWarning === undefined ? value : `${value}；${acceleratorWarning}`
      const authorityRef = `${repository.authorityRemote}/${repository.branch}`
      await this.git.run(repository.repositoryPath, [
        'fetch',
        '--prune',
        '--no-tags',
        repository.authorityRemote,
        `+refs/heads/${repository.branch}:refs/remotes/${authorityRef}`,
      ])
      const localHead = await this.git.run(repository.repositoryPath, ['rev-parse', 'HEAD'])
      const authorityHead = await this.git.run(repository.repositoryPath, ['rev-parse', authorityRef])
      if (localHead === authorityHead) {
        return result(repository.id, 'up-to-date', message('本地与 GitHub 权威提交一致'), completedAt, localHead, authorityHead)
      }
      const localBehind = await this.isAncestor(repository.repositoryPath, localHead, authorityHead)
      const localAhead = await this.isAncestor(repository.repositoryPath, authorityHead, localHead)
      if (localBehind) {
        if (repository.direction === 'push') {
          return result(repository.id, 'blocked-direction', message('GitHub 有更新，但当前配置仅允许推送'), completedAt, localHead, authorityHead)
        }
        await this.git.run(repository.repositoryPath, ['merge', '--ff-only', authorityRef])
        const pulledHead = await this.git.run(repository.repositoryPath, ['rev-parse', 'HEAD'])
        return result(repository.id, 'pulled', message('已从 GitHub 快进到最新提交'), completedAt, pulledHead, authorityHead)
      }
      if (localAhead) {
        if (repository.direction === 'pull') {
          return result(repository.id, 'blocked-direction', message('本地有新提交，但当前配置仅允许拉取'), completedAt, localHead, authorityHead)
        }
        await this.git.run(repository.repositoryPath, ['push', repository.authorityRemote, `HEAD:refs/heads/${repository.branch}`])
        return result(repository.id, 'pushed', message('已将本地提交推送到 GitHub'), completedAt, localHead, localHead)
      }
      return result(repository.id, 'conflict', message('本地与 GitHub 已分叉；需要人工合并'), completedAt, localHead, authorityHead)
    } catch (error) {
      return result(repository.id, 'error', error instanceof Error ? error.message : String(error), completedAt)
    }
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git.run(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])
      return true
    } catch {
      return false
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.started || !this.document.enabled || this.document.repositories.length === 0) return
    this.timer = setTimeout(() => { void this.runNow() }, this.document.intervalMinutes * 60_000)
    this.timer.unref?.()
  }

  private async load(): Promise<DesktopGitSyncDocument> {
    let text: string
    try {
      text = await readFile(this.statePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_DOCUMENT
      throw error
    }
    return parseDocument(JSON.parse(text) as unknown)
  }

  private persist(): Promise<void> {
    return writeFileAtomic(this.statePath, `${JSON.stringify(this.document, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

function result(
  repositoryId: string,
  state: DesktopGitSyncResultState,
  message: string,
  completedAt: string,
  localHead?: string,
  authorityHead?: string,
): DesktopGitSyncRepositoryResult {
  return { repositoryId, state, message, completedAt, ...localHead === undefined ? {} : { localHead }, ...authorityHead === undefined ? {} : { authorityHead } }
}

function parseDocument(value: unknown): DesktopGitSyncDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: Git sync state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || !Array.isArray(record.results)) {
    throw new Error('dsh-plugin-desktop: unsupported Git sync state')
  }
  const config = parseConfigureRequest(record)
  const results = record.results.map(parseResult)
  return { version: 1, ...config, results }
}

function parseConfigureRequest(value: unknown): DesktopGitSyncConfigureRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: Git sync configuration must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.enabled !== 'boolean'
    || !Number.isSafeInteger(record.intervalMinutes)
    || Number(record.intervalMinutes) < 1
    || Number(record.intervalMinutes) > 1_440
    || !Array.isArray(record.repositories)) {
    throw new Error('dsh-plugin-desktop: invalid Git sync configuration')
  }
  const repositories = record.repositories.map(parseRepository)
  if (new Set(repositories.map(repository => repository.id)).size !== repositories.length) {
    throw new Error('dsh-plugin-desktop: Git sync repository ids must be unique')
  }
  return { enabled: record.enabled, intervalMinutes: Number(record.intervalMinutes), repositories }
}

function parseRepository(value: unknown): DesktopGitSyncRepository {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: Git sync repository must be an object')
  }
  const record = value as Record<string, unknown>
  const id = boundedString(record.id, 'repository id', 100)
  const label = boundedString(record.label, 'repository label', 100)
  const repositoryPath = boundedString(record.repositoryPath, 'repository path', 4_096)
  if (!isAbsolute(repositoryPath)) throw new Error('dsh-plugin-desktop: Git sync repository path must be absolute')
  const authorityRemote = gitRefName(record.authorityRemote, 'authority remote')
  const branch = gitRefName(record.branch, 'branch')
  const direction = record.direction
  if (direction !== 'pull' && direction !== 'push' && direction !== 'bidirectional') {
    throw new Error('dsh-plugin-desktop: invalid Git sync direction')
  }
  const acceleratorRemote = record.acceleratorRemote === undefined || record.acceleratorRemote === ''
    ? undefined
    : gitRefName(record.acceleratorRemote, 'accelerator remote')
  if (acceleratorRemote === authorityRemote) {
    throw new Error('dsh-plugin-desktop: accelerator remote must differ from the authority remote')
  }
  return { id, label, repositoryPath, authorityRemote, branch, direction, ...acceleratorRemote === undefined ? {} : { acceleratorRemote } }
}

function parseResult(value: unknown): DesktopGitSyncRepositoryResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh-plugin-desktop: Git sync result must be an object')
  }
  const record = value as Record<string, unknown>
  const state = record.state
  if (!['idle', 'up-to-date', 'pulled', 'pushed', 'paused-dirty', 'blocked-direction', 'conflict', 'error'].includes(String(state))) {
    throw new Error('dsh-plugin-desktop: invalid Git sync result state')
  }
  const completedAt = boundedString(record.completedAt, 'result time', 100)
  if (Number.isNaN(Date.parse(completedAt))) throw new Error('dsh-plugin-desktop: invalid Git sync result time')
  return {
    repositoryId: boundedString(record.repositoryId, 'result repository id', 100),
    state: state as DesktopGitSyncResultState,
    message: boundedString(record.message, 'result message', 2_000),
    completedAt,
    ...typeof record.localHead === 'string' ? { localHead: record.localHead } : {},
    ...typeof record.authorityHead === 'string' ? { authorityHead: record.authorityHead } : {},
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum || /[\r\n\0]/u.test(value)) {
    throw new Error(`dsh-plugin-desktop: invalid Git sync ${label}`)
  }
  return value
}

function gitRefName(value: unknown, label: string): string {
  const name = boundedString(value, label, 200)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(name) || name.includes('..') || name.endsWith('/') || name.startsWith('-')) {
    throw new Error(`dsh-plugin-desktop: invalid Git sync ${label}`)
  }
  return name
}
