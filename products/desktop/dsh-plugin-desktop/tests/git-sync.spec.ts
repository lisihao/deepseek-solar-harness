import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DesktopGitSyncController,
  type DesktopGitCommandRunner,
  type DesktopGitSyncRepository,
} from '../src/git-sync.ts'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)

class FixtureGit implements DesktopGitCommandRunner {
  readonly calls: string[][] = []

  constructor(
    private local = SHA_A,
    private authority = SHA_A,
    private readonly dirty = false,
    private readonly ancestry: 'equal' | 'behind' | 'ahead' | 'diverged' = 'equal',
    private readonly branch = 'main',
    private readonly failAccelerator = false,
  ) {}

  run(_cwd: string, args: readonly string[]): Promise<string> {
    this.calls.push([...args])
    const command = args.join(' ')
    if (command === 'rev-parse --is-inside-work-tree') return Promise.resolve('true')
    if (command === 'status --porcelain') return Promise.resolve(this.dirty ? ' M src/index.ts' : '')
    if (command === 'symbolic-ref --short HEAD') return Promise.resolve(this.branch)
    if (command === 'remote get-url macmini' && this.failAccelerator) return Promise.reject(new Error('peer offline'))
    if (command.startsWith('remote get-url ')) return Promise.resolve('git@github.com:lisihao/project.git')
    if (command.startsWith('fetch ')) return Promise.resolve('')
    if (command === 'rev-parse HEAD') return Promise.resolve(this.local)
    if (command === 'rev-parse origin/main') return Promise.resolve(this.authority)
    if (command === `merge-base --is-ancestor ${this.local} ${this.authority}`) {
      return this.ancestry === 'behind' ? Promise.resolve('') : Promise.reject(new Error('not ancestor'))
    }
    if (command === `merge-base --is-ancestor ${this.authority} ${this.local}`) {
      return this.ancestry === 'ahead' ? Promise.resolve('') : Promise.reject(new Error('not ancestor'))
    }
    if (command === 'merge --ff-only origin/main') {
      this.local = this.authority
      return Promise.resolve('')
    }
    if (command === 'push origin HEAD:refs/heads/main') {
      this.authority = this.local
      return Promise.resolve('')
    }
    return Promise.reject(new Error(`unexpected Git command: ${command}`))
  }
}

function repository(direction: DesktopGitSyncRepository['direction'] = 'bidirectional'): DesktopGitSyncRepository {
  return {
    id: 'project', label: 'Project', repositoryPath: '/workspace/project',
    authorityRemote: 'origin', branch: 'main', direction,
  }
}

function controller(git: DesktopGitCommandRunner): DesktopGitSyncController {
  return new DesktopGitSyncController(mkdtempSync(join(tmpdir(), 'dsh-git-sync-')), git)
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

describe('Desktop Git commit synchronization', () => {
  it('pulls only by fast-forward from the authority remote', async () => {
    const git = new FixtureGit(SHA_A, SHA_B, false, 'behind')
    const sync = controller(git)
    await sync.start()
    await sync.configure({ enabled: true, intervalMinutes: 10, repositories: [repository()] })
    await expect(sync.runNow()).resolves.toMatchObject({
      results: [{ state: 'pulled', localHead: SHA_B, authorityHead: SHA_B }],
    })
    expect(git.calls).toContainEqual(['merge', '--ff-only', 'origin/main'])
  })

  it('pushes committed local progress and never creates a commit', async () => {
    const git = new FixtureGit(SHA_B, SHA_A, false, 'ahead')
    const sync = controller(git)
    await sync.start()
    await sync.configure({ enabled: true, intervalMinutes: 10, repositories: [repository()] })
    await expect(sync.runNow()).resolves.toMatchObject({ results: [{ state: 'pushed' }] })
    expect(git.calls).toContainEqual(['push', 'origin', 'HEAD:refs/heads/main'])
    expect(git.calls.some(args => args[0] === 'commit')).toBe(false)
  })

  it('pauses a dirty worktree before network access', async () => {
    const git = new FixtureGit(SHA_A, SHA_A, true)
    const sync = controller(git)
    await sync.start()
    await sync.configure({ enabled: true, intervalMinutes: 10, repositories: [repository()] })
    await expect(sync.runNow()).resolves.toMatchObject({ results: [{ state: 'paused-dirty' }] })
    expect(git.calls.some(args => args[0] === 'fetch' || args[0] === 'push')).toBe(false)
  })

  it('reports divergence and direction blocks without changing refs', async () => {
    const diverged = new FixtureGit(SHA_A, SHA_B, false, 'diverged')
    const conflictSync = controller(diverged)
    await conflictSync.start()
    await conflictSync.configure({ enabled: false, intervalMinutes: 10, repositories: [repository()] })
    await expect(conflictSync.runNow()).resolves.toMatchObject({ results: [{ state: 'conflict' }] })

    const behind = new FixtureGit(SHA_A, SHA_B, false, 'behind')
    const pushOnlySync = controller(behind)
    await pushOnlySync.start()
    await pushOnlySync.configure({ enabled: false, intervalMinutes: 10, repositories: [repository('push')] })
    await expect(pushOnlySync.runNow()).resolves.toMatchObject({ results: [{ state: 'blocked-direction' }] })
    expect(behind.calls.some(args => args[0] === 'merge')).toBe(false)
  })

  it('prefetches an optional peer but still resolves the authority ref from GitHub', async () => {
    const git = new FixtureGit()
    const sync = controller(git)
    await sync.start()
    await sync.configure({
      enabled: false,
      intervalMinutes: 10,
      repositories: [{ ...repository(), acceleratorRemote: 'macmini' }],
    })
    await expect(sync.runNow()).resolves.toMatchObject({ results: [{ state: 'up-to-date' }] })
    expect(git.calls).toContainEqual(['fetch', '--no-tags', 'macmini', 'main'])
    expect(git.calls).toContainEqual(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  })

  it('does not push a differently checked-out branch into the configured authority branch', async () => {
    const git = new FixtureGit(SHA_B, SHA_A, false, 'ahead', 'feature')
    const sync = controller(git)
    await sync.start()
    await sync.configure({ enabled: false, intervalMinutes: 10, repositories: [repository()] })
    await expect(sync.runNow()).resolves.toMatchObject({
      results: [{ state: 'error', message: '当前分支是 feature，不是配置的 main' }],
    })
    expect(git.calls.some(args => args[0] === 'fetch' || args[0] === 'push')).toBe(false)
  })

  it('continues through GitHub when the optional Tailscale accelerator is offline', async () => {
    const git = new FixtureGit(SHA_A, SHA_A, false, 'equal', 'main', true)
    const sync = controller(git)
    await sync.start()
    await sync.configure({
      enabled: false,
      intervalMinutes: 10,
      repositories: [{ ...repository(), acceleratorRemote: 'macmini' }],
    })
    await expect(sync.runNow()).resolves.toMatchObject({
      results: [{ state: 'up-to-date', message: expect.stringContaining('peer offline') }],
    })
    expect(git.calls).toContainEqual(['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
  })

  it('round-trips committed changes through a real authority repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-git-sync-native-'))
    const authority = join(root, 'authority.git')
    const seed = join(root, 'seed')
    const client = join(root, 'client')
    mkdirSync(seed)
    execFileSync('git', ['init', '--bare', authority])
    git(seed, 'init', '-b', 'main')
    git(seed, 'config', 'user.name', 'DSH Test')
    git(seed, 'config', 'user.email', 'dsh@example.invalid')
    writeFileSync(join(seed, 'progress.txt'), 'one\n')
    git(seed, 'add', 'progress.txt')
    git(seed, 'commit', '-m', 'initial')
    git(seed, 'remote', 'add', 'origin', authority)
    git(seed, 'push', '-u', 'origin', 'main')
    execFileSync('git', ['clone', '--branch', 'main', authority, client])
    git(client, 'config', 'user.name', 'DSH Test')
    git(client, 'config', 'user.email', 'dsh@example.invalid')

    const sync = new DesktopGitSyncController(mkdtempSync(join(tmpdir(), 'dsh-git-sync-state-')))
    await sync.start()
    await sync.configure({
      enabled: false,
      intervalMinutes: 10,
      repositories: [{ ...repository(), repositoryPath: client }],
    })
    await expect(sync.runNow()).resolves.toMatchObject({ results: [{ state: 'up-to-date' }] })

    writeFileSync(join(seed, 'progress.txt'), 'two\n')
    git(seed, 'add', 'progress.txt')
    git(seed, 'commit', '-m', 'server progress')
    git(seed, 'push', 'origin', 'main')
    await expect(sync.runNow()).resolves.toMatchObject({ results: [{ state: 'pulled' }] })

    writeFileSync(join(client, 'progress.txt'), 'three\n')
    git(client, 'add', 'progress.txt')
    git(client, 'commit', '-m', 'frontend progress')
    const clientHead = git(client, 'rev-parse', 'HEAD')
    await expect(sync.runNow()).resolves.toMatchObject({ results: [{ state: 'pushed', localHead: clientHead }] })
    expect(execFileSync('git', ['--git-dir', authority, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim()).toBe(clientHead)
  })
})
