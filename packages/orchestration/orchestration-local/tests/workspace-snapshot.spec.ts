/** Real source snapshots, remote bundle inputs, and conditional verified file delivery. */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { GouziMemberService } from '@deepseek-ai/dsh-client-connection'
import { WorkspaceSnapshotManager } from '../src/workspace-snapshot.ts'
import { LocalRemoteOperatorHostService } from '../src/remote-execution-host.ts'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', ...args], { cwd, encoding: 'utf8' }).trim()
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-private-snapshot-'))
  const source = join(root, 'source')
  await mkdir(source)
  await writeFile(join(source, 'work.txt'), 'current user bytes\n')
  await writeFile(join(source, 'unrelated.txt'), 'unrelated user bytes\n')
  const manager = new WorkspaceSnapshotManager({ ownedRoot: join(root, 'snapshots'), maxFiles: 100,
    maxBytes: 1024 * 1024, maxBundleBytes: 1024 * 1024, timeoutMs: 10_000 })
  return { root, source, manager }
}

class Member extends GouziMemberService {
  hello() { return { gouziId: 'fixture', ownerId: 'owner', hostId: 'host', generation: 1,
    authorityEpoch: 'epoch', incarnation: 1 } as never }
  admit() { return Promise.reject(new Error('fixture does not admit commands')) }
  recordAccepted() { return Promise.resolve() }
}

describe('WorkspaceSnapshotManager', () => {
  it.each(['plain', 'unborn', 'dirty'])('checkpoints %s source bytes without changing its index or HEAD', async (kind) => {
    const { source, manager } = await fixture()
    if (kind !== 'plain') git(source, ['init', '--initial-branch=main'])
    if (kind === 'dirty') {
      git(source, ['add', '.'])
      git(source, ['commit', '-m', 'original'])
      await writeFile(join(source, 'work.txt'), 'staged user bytes\n')
      git(source, ['add', 'work.txt'])
      await writeFile(join(source, 'work.txt'), 'current user bytes\n')
    }
    const indexPath = join(source, '.git', 'index')
    const index = kind === 'dirty' ? await readFile(indexPath) : undefined
    const head = kind === 'dirty' ? git(source, ['rev-parse', 'HEAD']) : undefined
    const snapshot = await manager.prepare(source, `key-${kind}`)
    expect(snapshot.workspace).not.toBe(source)
    expect(await readFile(join(snapshot.workspace, 'work.txt'), 'utf8')).toBe('current user bytes\n')
    expect(git(snapshot.workspace, ['status', '--porcelain=v1', '-uall'])).toBe('')
    expect(await manager.prepare(source, `key-${kind}`)).toEqual(snapshot)
    if (kind === 'dirty') {
      expect(await readFile(indexPath)).toEqual(index)
      expect(git(source, ['rev-parse', 'HEAD'])).toBe(head)
    } else if (kind === 'unborn') expect(() => git(source, ['rev-parse', 'HEAD'])).toThrow()
    else await expect(readFile(join(source, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('imports a real self-contained base into a registered plain remote project and delivers only independently checked edits', async () => {
    const { root, source, manager } = await fixture()
    const snapshot = await manager.prepare(source, 'remote-write')
    const remoteHome = join(root, 'remote-home')
    await mkdir(join(remoteHome, 'orchestrations'), { recursive: true })
    const projectId = 'a'.repeat(64)
    await writeFile(join(remoteHome, 'orchestrations', 'cluster.json'), JSON.stringify({ version: 1, nodeId: 'remote',
      members: [{ id: 'remote', label: 'Remote', endpoint: 'http://127.0.0.1:1', remoteExecution: {
        enabled: true, repositories: [], defaultProjectId: projectId, projects: [{ projectId, source }],
      } }] }))
    const ctx = new Context()
    new Member(ctx)
    const remote = new LocalRemoteOperatorHostService(ctx, { dshHome: remoteHome, directoryLockRoot: join(root, 'locks'),
      timeoutMs: 10_000, artifactReadTimeoutMs: 1_000, artifactMaxBytes: 1024 * 1024, workspaceLeaseMs: 60_000 })
    const execution = await remote.materializeWorkspace({ version: 1, kind: 'gouzi-project', projectId }, 'actual-remote-write',
      { baseSha: snapshot.baseSha, baseBundle: snapshot.baseBundle })
    expect(execution.path).not.toBe(source)
    expect(execution.path).not.toBe(snapshot.workspace)
    await writeFile(join(execution.path, 'work.txt'), 'remote developed bytes\n')
    await writeFile(join(execution.path, 'new.txt'), 'actual new file\n')
    const mutation = await remote.captureWorkspaceMutation('actual-remote-write')
    await remote.releaseWorkspace('actual-remote-write')
    expect(mutation).toMatchObject({ baseSha: snapshot.baseSha, projectId })
    const patch = join(root, 'returned.patch')
    if (mutation === undefined) throw new Error('fixture expected a real mutation receipt')
    await writeFile(patch, mutation.patch)
    git(snapshot.workspace, ['apply', '--check', '--', patch])
    git(snapshot.workspace, ['apply', '--', patch])
    git(snapshot.workspace, ['add', '.'])
    git(snapshot.workspace, ['commit', '-m', 'integrated remote edit'])
    // A separate reader checks the actual result before the source-delivery API is invoked.
    expect(await readFile(join(snapshot.workspace, 'work.txt'), 'utf8')).toBe('remote developed bytes\n')
    expect(await readFile(join(snapshot.workspace, 'new.txt'), 'utf8')).toBe('actual new file\n')
    expect(await readFile(join(source, 'work.txt'), 'utf8')).toBe('current user bytes\n')
    await writeFile(join(source, 'unrelated.txt'), 'later unrelated dirty user bytes\n')
    expect(await manager.conditionalApply(snapshot.snapshotId, snapshot.workspace)).toEqual(['new.txt', 'work.txt'])
    expect(await readFile(join(source, 'work.txt'), 'utf8')).toBe('remote developed bytes\n')
    expect(await readFile(join(source, 'new.txt'), 'utf8')).toBe('actual new file\n')
    expect(await readFile(join(source, 'unrelated.txt'), 'utf8')).toBe('later unrelated dirty user bytes\n')
    expect(await manager.conditionalApply(snapshot.snapshotId, snapshot.workspace)).toEqual([])
    await expect(readFile(join(source, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects changed affected source bytes before writing any result and preserves a staged source index', async () => {
    const { source, manager } = await fixture()
    git(source, ['init', '--initial-branch=main'])
    git(source, ['add', '.'])
    git(source, ['commit', '-m', 'original'])
    await writeFile(join(source, 'work.txt'), 'staged source bytes\n')
    git(source, ['add', 'work.txt'])
    const index = await readFile(join(source, '.git', 'index'))
    const head = git(source, ['rev-parse', 'HEAD'])
    const snapshot = await manager.prepare(source, 'conflict')
    await writeFile(join(snapshot.workspace, 'work.txt'), 'verified result\n')
    await writeFile(join(snapshot.workspace, 'new.txt'), 'new verified file\n')
    git(snapshot.workspace, ['add', '.'])
    git(snapshot.workspace, ['commit', '-m', 'result'])
    await writeFile(join(source, 'work.txt'), 'later user edit\n')
    await expect(manager.conditionalApply(snapshot.snapshotId, snapshot.workspace)).rejects.toThrow('source changed since snapshot')
    expect(await readFile(join(source, 'work.txt'), 'utf8')).toBe('later user edit\n')
    await expect(readFile(join(source, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(source, '.git', 'index'))).toEqual(index)
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(head)
  })

  it('rejects snapshots above the configured entry and byte budgets', async () => {
    const { root, source } = await fixture()
    const small = new WorkspaceSnapshotManager({ ownedRoot: join(root, 'small'), maxFiles: 1,
      maxBytes: 1024, maxBundleBytes: 1024, timeoutMs: 10_000 })
    await expect(small.prepare(source, 'entries')).rejects.toThrow('exceeds 1 entries')
    const bytes = new WorkspaceSnapshotManager({ ownedRoot: join(root, 'bytes'), maxFiles: 10,
      maxBytes: 1, maxBundleBytes: 1024, timeoutMs: 10_000 })
    await expect(bytes.prepare(source, 'bytes')).rejects.toThrow('exceeds 1 bytes')
  })
})
