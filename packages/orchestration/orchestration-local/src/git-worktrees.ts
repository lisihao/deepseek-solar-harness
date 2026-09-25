/** Git worktree isolation and serialized integration for Workbench worker attempts. */
import { execFile } from 'node:child_process'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  OrchestrationError,
  type NodeExecutionWorkspaceV1,
  type OrchestrationErrorCode,
} from '@deepseek-ai/dsh-orchestration'

const run = promisify(execFile)

interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

/** Proven commits and authority-branch head produced by one integrated attempt. */
export interface GitWorktreeIntegration {
  readonly branch: string
  readonly worktreePath: string
  readonly startSha: string
  readonly commits: readonly string[]
  readonly integratedHead: string
}

function safeSegment(value: string, fallback: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return (normalized || fallback).slice(0, 48)
}

function gitFailure(
  error: unknown,
  fallback: string,
  code: OrchestrationErrorCode = 'WORKSPACE_INVALID',
): OrchestrationError {
  const stderr = error !== null && typeof error === 'object' && 'stderr' in error
    ? String(error.stderr).trim()
    : ''
  return new OrchestrationError(stderr || (error instanceof Error ? error.message : fallback), code)
}

/** Daemon-owned Git operations; model workers never receive authority to integrate branches. */
export class GitWorktreeManager {
  private operation = Promise.resolve()

  constructor(private readonly root: string) {}

  /**
   * Verify the certified repository boundary before accepting a worktree-isolated graph.
   * @param repository - canonical authority repository root.
   * @param baseSha - graph-certified starting commit.
   */
  async verifyRepository(repository: string, baseSha: string): Promise<void> {
    await this.serial(async () => {
      const top = await this.git(repository, ['rev-parse', '--show-toplevel'])
      if (await realpath(top.stdout.trim()) !== await realpath(repository)) {
        throw new OrchestrationError('git-worktree workspace must be the repository root', 'WORKSPACE_INVALID')
      }
      const head = await this.git(repository, ['rev-parse', 'HEAD'])
      const certified = await this.git(repository, ['rev-parse', `${baseSha}^{commit}`])
      if (head.stdout.trim() !== certified.stdout.trim()) {
        throw new OrchestrationError('graph.baseSha does not match the repository HEAD', 'REVISION_CONFLICT')
      }
      await this.requireClean(repository)
    })
  }

  /**
   * Create or recover one stable worktree and branch for a mutating attempt.
   * @param repository - canonical authority repository root.
   * @param runId - durable orchestration run identity.
   * @param nodeId - logical graph node identity.
   * @param attempt - one-based attempt number.
   * @returns the isolated execution workspace.
   */
  async prepare(repository: string, runId: string, nodeId: string, attempt: number): Promise<NodeExecutionWorkspaceV1> {
    return this.serial(async () => {
      const runSegment = safeSegment(runId.replace(/^run-/u, ''), 'run')
      const nodeSegment = safeSegment(nodeId, 'node')
      const branch = `dsh/${runSegment}/${nodeSegment}/${String(attempt)}`
      const worktreePath = join(this.root, runSegment, `${nodeSegment}-${String(attempt)}`)
      const existing = await stat(worktreePath).then(() => true, () => false)
      if (existing) {
        const actualBranch = (await this.git(worktreePath, ['branch', '--show-current'])).stdout.trim()
        if (actualBranch !== branch) {
          throw new OrchestrationError(`worktree path is already owned by ${actualBranch || 'detached HEAD'}`, 'WORKSPACE_INVALID')
        }
        return {
          mode: 'git-worktree', path: worktreePath, branch,
          startSha: (await this.git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim(),
        }
      }
      await mkdir(join(this.root, runSegment), { recursive: true, mode: 0o700 })
      await this.requireClean(repository)
      const startSha = (await this.git(repository, ['rev-parse', 'HEAD'])).stdout.trim()
      try {
        await this.git(repository, ['worktree', 'add', '-b', branch, worktreePath, startSha])
      } catch (error) {
        throw gitFailure(error, 'failed to create isolated Git worktree')
      }
      return { mode: 'git-worktree', path: worktreePath, branch, startSha }
    })
  }

  /**
   * Commit worker changes and merge them into the authority workspace once.
   * @param repository - canonical authority repository root.
   * @param workspace - isolated workspace returned by {@link prepare}.
   * @param taskId - execution task identity used in commit evidence.
   * @returns integration evidence, or undefined for a non-worktree workspace.
   */
  async integrate(repository: string, workspace: NodeExecutionWorkspaceV1, taskId: string): Promise<GitWorktreeIntegration | undefined> {
    if (workspace.mode !== 'git-worktree' || workspace.branch === undefined || workspace.startSha === undefined) return undefined
    const { branch, path: worktreePath, startSha } = workspace
    return this.serial(async () => {
      await this.requireClean(repository)
      const porcelain = (await this.git(worktreePath, ['status', '--porcelain=v1', '--untracked-files=all'])).stdout
      if (porcelain.trim().length > 0) {
        await this.git(worktreePath, ['add', '-A'])
        try {
          await this.git(worktreePath, [
            '-c', 'user.name=DSH Workbench',
            '-c', 'user.email=dsh-workbench@local',
            'commit', '-m', `dsh: settle ${taskId}`,
          ])
        } catch (error) {
          throw gitFailure(error, 'failed to commit isolated worker changes', 'INTEGRATION_FAILED')
        }
      }
      const list = (await this.git(worktreePath, ['rev-list', '--reverse', `${startSha}..HEAD`])).stdout
        .split('\n').map(value => value.trim()).filter(Boolean)
      if (list.length > 0) {
        try {
          await this.git(repository, [
            '-c', 'user.name=DSH Workbench',
            '-c', 'user.email=dsh-workbench@local',
            'merge', '--no-ff', '--no-edit', branch,
            '-m', `dsh: integrate ${taskId}`,
          ])
        } catch (error) {
          await this.git(repository, ['merge', '--abort']).catch(() => undefined)
          throw gitFailure(error, 'isolated worker branch conflicts with an already integrated branch', 'INTEGRATION_CONFLICT')
        }
      }
      return {
        branch,
        worktreePath,
        startSha,
        commits: list,
        integratedHead: (await this.git(repository, ['rev-parse', 'HEAD'])).stdout.trim(),
      }
    })
  }

  private async requireClean(repository: string): Promise<void> {
    const status = await this.git(repository, ['status', '--porcelain=v1', '--untracked-files=all'])
    if (status.stdout.trim().length > 0) {
      throw new OrchestrationError('repository authority workspace must remain clean', 'WORKSPACE_DIRTY')
    }
  }

  private async git(cwd: string, args: readonly string[]): Promise<GitResult> {
    try {
      return await run('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
    } catch (error) {
      throw gitFailure(error, `git ${args.join(' ')} failed`)
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(() => undefined, () => undefined)
    return result
  }
}
