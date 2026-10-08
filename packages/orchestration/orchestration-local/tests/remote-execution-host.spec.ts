/** Server-local Git materialization and Resident artifact transfer. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createRemotePhysicalOperators } from '../src/remote-physical-operator.ts'
import { OrchestrationStore } from '../src/store.ts'
import { describe, expect, it } from 'vitest'
import { GouziMemberService } from '@deepseek-ai/dsh-client-connection'
import {
  identifyRemoteWorkspace,
  resolveRepositorySource,
  LocalRemoteOperatorHostService,
} from '../src/remote-execution-host.ts'

async function sourceRepository(): Promise<{ readonly root: string; readonly commit: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-source-'))
  await mkdir(join(root, 'packages', 'core'), { recursive: true })
  await writeFile(join(root, 'packages', 'core', 'fixture.txt'), 'exact commit fixture\n')
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'DSH Test'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'dsh-test@example.invalid'], { cwd: root })
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: root })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/lisihao/remote-fixture.git'], { cwd: root })
  return { root, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }
}

function normalizeCheckoutText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

async function serviceFixture() {
  const source = await sourceRepository()
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-remote-host-'))
  await mkdir(join(dshHome, 'orchestrations'), { recursive: true })
  await writeFile(join(dshHome, 'orchestrations', 'cluster.json'), JSON.stringify({
    version: 1,
    nodeId: 'server-a',
    members: [{
      id: 'server-a', label: 'Server A', endpoint: 'http://127.0.0.1:13080',
      remoteExecution: {
        enabled: true,
        repositories: [{ repository: 'github.com/lisihao/remote-fixture', source: source.root }],
      },
    }],
  }))
  const ctx = new Context()
  const service = new LocalRemoteOperatorHostService(ctx, {
    dshHome, timeoutMs: 10_000, artifactReadTimeoutMs: 1_000, artifactMaxBytes: 1_024, workspaceLeaseMs: 60_000,
  })
  return { source, dshHome, service }
}

describe('LocalRemoteOperatorHostService', () => {
  it.each([{ endpoint: 'http://127.0.0.1:13301', qualified: false }, { endpoint: 'https://remote.invalid', qualified: true }])(
    'refuses complete snapshot transfer without both local authority qualification and loopback ($endpoint)', async ({ endpoint, qualified }) => {
      const { source, dshHome } = await serviceFixture()
      const store = new OrchestrationStore(join(dshHome, 'owner-store'))
      const provider = { operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'fixture', tags: [],
        maxConcurrency: 1, injectionBoundaries: [], available: true, authentication: 'native-subscription',
        productVersion: 'fixture', protocolHash: 'fixture', models: [], supportsWorkspaceMutationReturn: true,
        supportsWorkspaceSnapshotInput: true }
      let sentAfterQualification = 0
      const transport: typeof fetch = async (_url, init) => {
        if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
        const call = JSON.parse(init.body) as { rpcId: string; method: string }
        sentAfterQualification += 1
        return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [provider] } })
      }
      const [operator] = await createRemotePhysicalOperators({ id: 'fixture', label: 'Fixture', endpoint,
        gouzi: { gouziId: 'fixture', ...qualified ? { allowLocalWorkspaceSnapshot: true } : {},
          issue: () => { throw new Error('grant issuance must not occur') } } }, store, transport)
      sentAfterQualification = 0
      await expect(operator!.start({ executionId: 'blocked-snapshot' as never, mode: 'resident', prompt: [],
        parent: { session: { header: { cwd: source.root } } } as never, signal: new AbortController().signal,
        workspaceSnapshotInput: { baseSha: source.commit, baseBundle: Buffer.from('fixture bytes').toString('base64') } }))
        .rejects.toThrow('authority-qualified local member and loopback endpoint')
      expect(sentAfterQualification).toBe(0)
      store.close()
    },
  )

  it('returns a real remote edit into the caller execution checkout and recovers the same patch without replaying it', async () => {
    const { source, service, dshHome } = await serviceFixture()
    const store = new OrchestrationStore(join(dshHome, 'owner-store'))
    const provider = {
      operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'fixture', tags: [],
      maxConcurrency: 1, injectionBoundaries: ['pre-dispatch'], available: true,
      authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture', models: [],
      supportsWorkspaceMutationReturn: true,
    }
    let commandId = ''
    let executes = 0
    const transport: typeof fetch = async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string; payload: Record<string, unknown> }
      let value: unknown
      if (call.method === 'operator.providers') value = [provider]
      else if (call.method === 'operator.execute') {
        executes += 1
        commandId = String(call.payload.commandId)
        const workspace = await service.materializeWorkspace(
          call.payload.workspaceIdentity as never, commandId, call.payload.workspaceMutationReturn as never,
        )
        await writeFile(join(workspace.path, 'packages/core/fixture.txt'), 'actually developed remotely\n')
        await writeFile(join(workspace.path, 'new.txt'), 'actual new file\n')
        value = { sessionId: 'session', turnId: 'turn', stateRevision: 1 }
      } else if (call.method === 'operator.inspect') {
        const mutation = await service.captureWorkspaceMutation(commandId)
        await service.releaseWorkspace(commandId)
        value = { commandId, sessionId: 'session', turnId: 'turn', stateRevision: 2,
          state: 'settled', updatedAt: new Date().toISOString(), result: { output: [], stopReason: 'completed', workspaceMutation: mutation } }
      } else throw new Error(`unexpected method ${call.method}`)
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    }
    const [operator] = await createRemotePhysicalOperators({ id: 'fixture', label: 'Fixture', endpoint: 'http://fixture.invalid' }, store, transport)
    const run = await operator!.start({ executionId: 'write-command' as never, mode: 'resident', prompt: [],
      parent: { session: { header: { cwd: source.root } } } as never, signal: new AbortController().signal,
      nativeToolPolicy: 'inherit', workspaceMutationReturn: { baseSha: source.commit } })
    await run.result
    expect(await readFile(join(source.root, 'packages/core/fixture.txt'), 'utf8')).toBe('actually developed remotely\n')
    expect(await readFile(join(source.root, 'new.txt'), 'utf8')).toBe('actual new file\n')
    const [restarted] = await createRemotePhysicalOperators({ id: 'fixture', label: 'Fixture', endpoint: 'http://fixture.invalid' }, store, transport)
    await (await restarted!.reattach('turn')).result
    expect(executes).toBe(1)
    store.close()
  })

  it('refuses a dirty caller mutation target before remote admission and preserves user bytes', async () => {
    const { source, service, dshHome } = await serviceFixture()
    const store = new OrchestrationStore(join(dshHome, 'owner-store'))
    const provider = { operatorId: 'codex', product: 'codex', displayName: 'Codex', description: 'fixture', tags: [],
      maxConcurrency: 1, injectionBoundaries: ['pre-dispatch'], available: true, authentication: 'native-subscription',
      productVersion: 'fixture', protocolHash: 'fixture', models: [], supportsWorkspaceMutationReturn: true }
    let executes = 0
    const transport: typeof fetch = async (_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string }
      if (call.method !== 'operator.providers') executes += 1
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: [provider] } })
    }
    const [operator] = await createRemotePhysicalOperators({ id: 'fixture', label: 'Fixture', endpoint: 'http://fixture.invalid' }, store, transport)
    await writeFile(join(source.root, 'packages/core/fixture.txt'), 'user dirty bytes\n')
    await expect(operator!.start({ executionId: 'dirty-command' as never, mode: 'resident', prompt: [],
      parent: { session: { header: { cwd: source.root } } } as never, signal: new AbortController().signal,
      workspaceMutationReturn: { baseSha: source.commit } })).rejects.toThrow('clean Git workspace')
    expect(executes).toBe(0)
    expect(await readFile(join(source.root, 'packages/core/fixture.txt'), 'utf8')).toBe('user dirty bytes\n')
    expect(await service.captureWorkspaceMutation('dirty-command')).toBeUndefined()
    store.close()
  })

  it('captures actual tracked and untracked edits as a durable exact-base patch before release', async () => {
    const { source, service } = await serviceFixture()
    const identity = await identifyRemoteWorkspace(source.root, 10_000)
    const workspace = await service.materializeWorkspace(identity, 'mutation', { baseSha: source.commit })
    await writeFile(join(workspace.path, 'packages/core/fixture.txt'), 'real edited bytes\n')
    execFileSync('git', ['add', '.'], { cwd: workspace.path })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'native edit'],
      { cwd: workspace.path })
    await writeFile(join(workspace.path, 'new.txt'), 'new file\n')
    const [mutation, concurrent] = await Promise.all([service.captureWorkspaceMutation('mutation'), service.captureWorkspaceMutation('mutation')])
    expect(concurrent).toEqual(mutation)
    expect(mutation).toMatchObject({ repository: identity.repository, baseSha: source.commit })
    expect(mutation?.patch).toContain('real edited bytes')
    expect(mutation?.patch).toContain('new file')
    expect(await readFile(join(source.root, 'packages/core/fixture.txt'), 'utf8')).toBe('exact commit fixture\n')
    await service.releaseWorkspace('mutation')
    expect(await service.captureWorkspaceMutation('mutation')).toEqual(mutation)
    const patch = join(source.root, '..', 'returned.patch')
    await writeFile(patch, mutation!.patch)
    execFileSync('git', ['apply', '--check', '--', patch], { cwd: source.root })
    execFileSync('git', ['apply', '--', patch], { cwd: source.root })
    expect(await readFile(join(source.root, 'new.txt'), 'utf8')).toBe('new file\n')
  })

  it('maps a clean sender workspace to repository identity and materializes the exact commit and subdir', async () => {
    const { source, service } = await serviceFixture()
    const sender = await identifyRemoteWorkspace(join(source.root, 'packages', 'core'), 10_000)
    expect(sender).toEqual({
      version: 1,
      repository: 'github.com/lisihao/remote-fixture',
      commit: source.commit,
      subdir: 'packages/core',
    })

    await expect(service.qualification()).resolves.toEqual({ available: true })
    const first = await service.materializeWorkspace(sender, 'execution-1')
    const second = await service.materializeWorkspace(sender, 'execution-1')
    expect(second.path).toBe(first.path)
    expect(first.path).not.toContain(source.root)
    expect(normalizeCheckoutText(await readFile(join(first.path, 'fixture.txt'), 'utf8')))
      .toBe('exact commit fixture\n')
    const checkoutRoot = join(first.path, '..', '..')
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkoutRoot, encoding: 'utf8' }).trim())
      .toBe(source.commit)
  }, 15_000)

  it('resolves a repository for an allowlist from a dirty subdirectory, and refuses a path with no origin', async () => {
    const { source } = await serviceFixture()
    await writeFile(join(source.root, 'uncommitted.txt'), 'dirty')
    await expect(resolveRepositorySource(join(source.root, 'packages', 'core'), 10_000)).resolves.toEqual({
      repository: 'github.com/lisihao/remote-fixture',
      source: await realpath(source.root),
    })
    execFileSync('git', ['remote', 'remove', 'origin'], { cwd: source.root })
    await expect(resolveRepositorySource(source.root, 10_000)).rejects.toThrow()
  }, 15_000)

  it('rejects dirty senders and repositories outside the Server allowlist', async () => {
    const { source, service } = await serviceFixture()
    await writeFile(join(source.root, 'uncommitted.txt'), 'dirty')
    await expect(identifyRemoteWorkspace(source.root, 10_000)).rejects.toThrow('requires a clean Git workspace')
    await expect(service.materializeWorkspace({
      version: 1, repository: 'github.com/lisihao/not-allowed', commit: source.commit,
    }, 'execution-denied')).rejects.toThrow('is not allowed')
  })

  it('isolates tracked and untracked mutations between concurrent executions of the same commit', async () => {
    const { source, service } = await serviceFixture()
    const identity = await identifyRemoteWorkspace(source.root, 10_000)
    const [first, second] = await Promise.all([
      service.materializeWorkspace(identity, 'execution-a'),
      service.materializeWorkspace(identity, 'execution-b'),
    ])
    expect(first.path).not.toBe(second.path)
    await writeFile(join(first.path, 'packages', 'core', 'fixture.txt'), 'changed by A\n')
    await writeFile(join(first.path, 'untracked.txt'), 'A only\n')
    expect(normalizeCheckoutText(await readFile(join(second.path, 'packages', 'core', 'fixture.txt'), 'utf8')))
      .toBe('exact commit fixture\n')
    await expect(access(join(second.path, 'untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(execFileSync('git', ['status', '--porcelain=v1', '-uall'], { cwd: second.path, encoding: 'utf8' })).toBe('')
    await service.releaseWorkspace('execution-a')
    await expect(access(first.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(second.path)).resolves.toBeUndefined()
  }, process.platform === 'win32' ? 15_000 : 5_000)

  it('returns exact Resident artifact bytes only when their digest matches', async () => {
    const { dshHome, service } = await serviceFixture()
    const json = JSON.stringify({ output: [{ type: 'text', text: 'large result' }], stopReason: 'completed' })
    const digest = createHash('sha256').update(json).digest('hex')
    const root = join(dshHome, 'resident-operators', 'artifacts', 'sha256')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, digest), json)
    await expect(service.readResidentArtifact(`sha256:${digest}`)).resolves.toEqual({
      ref: `sha256:${digest}`, json,
    })
    await writeFile(join(root, digest), `${json}\n`)
    await expect(service.readResidentArtifact(`sha256:${digest}`)).rejects.toThrow('digest mismatch')
    const oversized = 'x'.repeat(1_025)
    const oversizedDigest = createHash('sha256').update(oversized).digest('hex')
    await writeFile(join(root, oversizedDigest), oversized)
    await expect(service.readResidentArtifact(`sha256:${oversizedDigest}`)).rejects.toThrow('exceeds 1024 bytes')
    const abort = new AbortController()
    abort.abort(new Error('cancelled'))
    await expect(service.readResidentArtifact(`sha256:${digest}`, abort.signal)).rejects.toThrow()
  }, process.platform === 'win32' ? 15_000 : 5_000)
})

class FixtureGouziMember extends GouziMemberService {
  hello() { return { gouziId: 'dog', ownerId: 'main', hostId: 'host', generation: 1, authorityEpoch: 'epoch', incarnation: 1 } }
  async admit(): Promise<never> { throw new Error('not used by workspace tests') }
  async recordAccepted(): Promise<void> {}
}

async function directoryFixture(options: { root?: string; lockRoot?: string; mounted?: boolean; projectId?: string } = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-directory-source-'))
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-directory-host-'))
  const lockRoot = options.lockRoot ?? await mkdtemp(join(tmpdir(), 'dsh-directory-locks-'))
  await mkdir(join(dshHome, 'orchestrations'), { recursive: true })
  await writeFile(join(dshHome, 'orchestrations', 'cluster.json'), JSON.stringify({
    version: 1, nodeId: dshHome,
    members: [{ id: dshHome, label: 'Member', endpoint: 'http://localhost:3081', remoteExecution: {
      enabled: true, repositories: [], projects: [{ projectId: 'project', source: root }],
      defaultProjectId: options.projectId ?? 'project',
    } }],
  }))
  const ctx = new Context()
  if (options.mounted !== false) new FixtureGouziMember(ctx)
  const service = new LocalRemoteOperatorHostService(ctx, {
    dshHome, directoryLockRoot: lockRoot, timeoutMs: 10_000,
    artifactReadTimeoutMs: 1_000, artifactMaxBytes: 1_024, workspaceLeaseMs: 60_000,
  })
  return { root, dshHome, lockRoot, service }
}

function directoryReceiptPath(dshHome: string, executionId: string): string {
  const workspaceRoot = process.platform === 'win32'
    ? join(dshHome, 'rw')
    : join(dshHome, 'orchestrations', 'remote-workspaces')
  const digest = createHash('sha256').update(executionId).digest('hex')
  return join(workspaceRoot, 'executions', `${digest}.directory.json`)
}

const directoryIdentity = { version: 1 as const, kind: 'gouzi-project' as const, projectId: 'project' }

describe('registered directory execution', () => {
  it.each(['plain', 'unborn', 'dirty-no-origin'])('uses current %s directory bytes and release preserves every file', async (kind) => {
    const { root, service } = await directoryFixture()
    await writeFile(join(root, 'user.txt'), 'untracked current bytes')
    if (kind !== 'plain') execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
    if (kind === 'dirty-no-origin') {
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'add', '.'], { cwd: root })
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'fixture'], { cwd: root })
      await writeFile(join(root, 'user.txt'), 'dirty current bytes')
    }
    await expect(service.gouziWorkspace()).resolves.toEqual({ projectId: 'project', projectScopes: [await realpath(root)] })
    await expect(service.qualification()).resolves.toEqual({ available: true })
    const before = await readFile(join(root, 'user.txt'), 'utf8')
    const workspace = await service.materializeWorkspace(directoryIdentity, 'execution')
    expect(workspace.path).toBe(await realpath(root))
    expect(await readFile(join(workspace.path, 'user.txt'), 'utf8')).toBe(before)
    await writeFile(join(root, 'new-file.txt'), 'execution output')
    await service.renewWorkspace('execution')
    await expect(service.materializeWorkspace(directoryIdentity, 'execution')).resolves.toEqual(workspace)
    await service.releaseWorkspace('execution')
    expect(await readFile(join(root, 'user.txt'), 'utf8')).toBe(before)
    expect(await readFile(join(root, 'new-file.txt'), 'utf8')).toBe('execution output')
    await expect(service.materializeWorkspace(directoryIdentity, 'next')).resolves.toMatchObject({ path: workspace.path })
    await service.releaseWorkspace('next')
  })

  it('isolates registered dirty Git projects without an origin and binds the returned patch to the project', async () => {
    const { root, service } = await directoryFixture()
    await writeFile(join(root, 'tracked.txt'), 'base\n')
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'base'], { cwd: root })
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    await writeFile(join(root, 'tracked.txt'), 'user dirty bytes\n')
    await writeFile(join(root, 'private-untracked.txt'), 'user bytes\n')
    const isolated = await service.materializeWorkspace(directoryIdentity, 'isolated-project', { baseSha })
    expect(isolated.path).not.toBe(root)
    expect(await readFile(join(isolated.path, 'tracked.txt'), 'utf8')).toBe('base\n')
    await expect(readFile(join(isolated.path, 'private-untracked.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(isolated.path, 'tracked.txt'), 'remote actual edit\n')
    const mutation = await service.captureWorkspaceMutation('isolated-project')
    expect(mutation).toMatchObject({ projectId: 'project', baseSha })
    expect(mutation?.patch).toContain('remote actual edit')
    await service.releaseWorkspace('isolated-project')
    expect(await readFile(join(root, 'tracked.txt'), 'utf8')).toBe('user dirty bytes\n')
    expect(await service.captureWorkspaceMutation('isolated-project')).toEqual(mutation)
    await expect(service.materializeWorkspace(directoryIdentity, 'missing-base', { baseSha: 'a'.repeat(40) })).rejects.toThrow()
  })

  it('uses contained subdirectories and rejects unknown projects, traversal, escaping symlinks and changed replay paths', async () => {
    const { root, service } = await directoryFixture()
    await mkdir(join(root, 'child'))
    const first = await service.materializeWorkspace({ ...directoryIdentity, subdir: 'child' }, 'child-execution')
    expect(first.path).toBe(await realpath(join(root, 'child')))
    await expect(service.materializeWorkspace(directoryIdentity, 'child-execution')).rejects.toThrow('conflicting execution')
    await expect(service.materializeWorkspace({ ...directoryIdentity, projectId: 'missing' }, 'unknown')).rejects.toThrow('not registered')
    for (const subdir of ['../outside', '/outside', 'child/..', 'child\\..', 'child//nested']) {
      await expect(service.materializeWorkspace({ ...directoryIdentity, subdir }, 'invalid')).rejects.toThrow('subdir')
    }
    const outside = await mkdtemp(join(tmpdir(), 'dsh-directory-outside-'))
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(service.materializeWorkspace({ ...directoryIdentity, subdir: 'escape' }, 'escape')).rejects.toThrow('escapes')
    await service.releaseWorkspace('child-execution')
  })

  it('rejects nonmembers and missing shared-lock configuration', async () => {
    const { service } = await directoryFixture({ mounted: false })
    await expect(service.qualification()).resolves.toMatchObject({ available: false, reason: 'directory execution requires a mounted Gouzi member' })
    await expect(service.materializeWorkspace(directoryIdentity, 'nonmember')).rejects.toThrow('mounted Gouzi')
    const fixture = await directoryFixture()
    const ctx = new Context()
    new FixtureGouziMember(ctx)
    const unconfigured = new LocalRemoteOperatorHostService(ctx, {
      dshHome: fixture.dshHome, timeoutMs: 10_000, artifactReadTimeoutMs: 1_000, artifactMaxBytes: 1_024, workspaceLeaseMs: 60_000,
    })
    await expect(unconfigured.materializeWorkspace(directoryIdentity, 'missing-config')).rejects.toThrow('directoryLockRoot')
  })

  it('serializes members sharing an actual project directory and refuses expired unresolved locks', async () => {
    const first = await directoryFixture()
    const second = await directoryFixture({ root: first.root, lockRoot: first.lockRoot })
    const results = await Promise.allSettled([
      first.service.materializeWorkspace(directoryIdentity, 'first'),
      second.service.materializeWorkspace(directoryIdentity, 'second'),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    const firstWon = results[0]?.status === 'fulfilled'
    const owner = firstWon ? first : second
    const loser = firstWon ? second : first
    const executionId = firstWon ? 'first' : 'second'
    const digest = createHash('sha256').update(await realpath(first.root)).digest('hex')
    const lock = join(first.lockRoot, `${digest}.json`)
    const lease = JSON.parse(await readFile(lock, 'utf8')) as Record<string, unknown>
    await writeFile(lock, JSON.stringify({ ...lease, leaseUntil: 0 }))
    await expect(owner.service.materializeWorkspace(directoryIdentity, executionId)).rejects.toThrow('expired unresolved')
    await expect(loser.service.materializeWorkspace(directoryIdentity, 'third')).rejects.toThrow('conflicting execution')
    await expect(owner.service.qualification()).resolves.toEqual({ available: true })
    await expect(access(lock)).resolves.toBeUndefined()
    await owner.service.releaseWorkspace(executionId)
    await expect(loser.service.materializeWorkspace(directoryIdentity, 'third')).resolves.toMatchObject({ path: await realpath(first.root) })
    await loser.service.releaseWorkspace('third')
  })

  it('inspects an occupied and expired directory lease without modifying metadata or user files', async () => {
    const fixture = await directoryFixture()
    await mkdir(join(fixture.root, 'child'))
    await writeFile(join(fixture.root, 'child', 'user.txt'), 'current untracked bytes')
    await expect(fixture.service.inspectWorkspace('absent')).resolves.toBeUndefined()
    const identity = { ...directoryIdentity, subdir: 'child' }
    const workspace = await fixture.service.materializeWorkspace(identity, 'existing')
    const lock = join(fixture.lockRoot, `${createHash('sha256').update(await realpath(fixture.root)).digest('hex')}.json`)
    const receipt = directoryReceiptPath(fixture.dshHome, 'existing')
    const beforeReceipt = await readFile(receipt, 'utf8')
    await expect(fixture.service.qualification()).resolves.toEqual({ available: true })
    const beforeLock = await readFile(lock, 'utf8')
    await expect(fixture.service.inspectWorkspace('existing')).resolves.toEqual(workspace)
    expect(await readFile(lock, 'utf8')).toBe(beforeLock)
    const lease = JSON.parse(beforeLock) as Record<string, unknown>
    const expired = JSON.stringify({ ...lease, leaseUntil: 0 })
    await writeFile(lock, expired)
    await expect(fixture.service.qualification()).resolves.toEqual({ available: true })
    await expect(fixture.service.inspectWorkspace('existing')).resolves.toEqual(workspace)
    await expect(fixture.service.materializeWorkspace(identity, 'different')).rejects.toThrow('conflicting execution')
    expect(await readFile(lock, 'utf8')).toBe(expired)
    expect(await readFile(receipt, 'utf8')).toBe(beforeReceipt)
    expect(await readFile(join(workspace.path, 'user.txt'), 'utf8')).toBe('current untracked bytes')
    await fixture.service.releaseWorkspace('existing')
    await expect(fixture.service.inspectWorkspace('existing')).resolves.toBeUndefined()
    expect(await readFile(join(workspace.path, 'user.txt'), 'utf8')).toBe('current untracked bytes')
  })

  it('rejects inspected leases for a wrong member, conflicting lock, changed project path or malformed metadata', async () => {
    const fixture = await directoryFixture()
    await fixture.service.materializeWorkspace(directoryIdentity, 'owned')
    const digest = createHash('sha256').update(await realpath(fixture.root)).digest('hex')
    const lock = join(fixture.lockRoot, `${digest}.json`)
    const lockBytes = await readFile(lock, 'utf8')
    const lease = JSON.parse(lockBytes) as Record<string, unknown>
    await writeFile(lock, JSON.stringify({ ...lease, executionId: 'other' }))
    await expect(fixture.service.inspectWorkspace('owned')).rejects.toThrow('conflicting execution')
    await writeFile(lock, lockBytes)
    const receipt = directoryReceiptPath(fixture.dshHome, 'owned')
    const receiptBytes = await readFile(receipt, 'utf8')
    const receiptLease = JSON.parse(receiptBytes) as Record<string, unknown>
    await writeFile(receipt, JSON.stringify({ ...receiptLease, memberId: 'wrong-member' }))
    await expect(fixture.service.inspectWorkspace('owned')).rejects.toThrow('lease identity mismatch')
    await writeFile(receipt, JSON.stringify({ ...receiptLease, identity: { version: 1, kind: 'gouzi-project' } }))
    await expect(fixture.service.inspectWorkspace('owned')).rejects.toThrow('invalid directory workspace lease')
    await writeFile(receipt, receiptBytes)
    const configPath = join(fixture.dshHome, 'orchestrations', 'cluster.json')
    const configBytes = await readFile(configPath, 'utf8')
    const replacement = await mkdtemp(join(tmpdir(), 'dsh-inspected-replacement-'))
    await writeFile(configPath, configBytes.replace(JSON.stringify(fixture.root), JSON.stringify(replacement)))
    await expect(fixture.service.inspectWorkspace('owned')).rejects.toThrow('conflicting execution')
    await writeFile(configPath, configBytes)
    await expect(fixture.service.inspectWorkspace('owned')).resolves.toMatchObject({ path: await realpath(fixture.root) })
    await fixture.service.releaseWorkspace('owned')
  })

  it('rejects overlapping project roots across members while allowing independent directories', async () => {
    const parent = await directoryFixture()
    const childRoot = join(parent.root, 'child')
    await mkdir(childRoot)
    const child = await directoryFixture({ root: childRoot, lockRoot: parent.lockRoot })
    const independent = await directoryFixture({ lockRoot: parent.lockRoot })
    const concurrent = await Promise.allSettled([
      parent.service.materializeWorkspace(directoryIdentity, 'parent'),
      child.service.materializeWorkspace(directoryIdentity, 'child'),
    ])
    expect(concurrent.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const parentWon = concurrent[0]?.status === 'fulfilled'
    const loser = parentWon ? child : parent
    await expect(loser.service.materializeWorkspace(directoryIdentity, 'overlap')).rejects.toThrow('conflicting execution')
    await expect(independent.service.materializeWorkspace(directoryIdentity, 'independent')).resolves.toMatchObject({ path: await realpath(independent.root) })
    await independent.service.releaseWorkspace('independent')
    await (parentWon ? parent : child).service.releaseWorkspace(parentWon ? 'parent' : 'child')
    await expect(loser.service.materializeWorkspace(directoryIdentity, 'after-release')).resolves.toMatchObject({ path: await realpath(loser.root) })
    await loser.service.releaseWorkspace('after-release')
    await expect(access(childRoot)).resolves.toBeUndefined()
  })

  it('does not reap an unresolved admission guard', async () => {
    const fixture = await directoryFixture()
    await writeFile(join(fixture.lockRoot, '.admission'), 'unknown prior owner')
    await expect(fixture.service.materializeWorkspace(directoryIdentity, 'guarded')).rejects.toThrow('busy or unresolved')
    await expect(fixture.service.qualification()).resolves.toEqual({ available: true })
    expect(await readFile(join(fixture.lockRoot, '.admission'), 'utf8')).toBe('unknown prior owner')
  })

  it('rejects lock metadata inside the user project before creating it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-directory-metadata-source-'))
    const lockRoot = join(root, 'must-not-create')
    const { service } = await directoryFixture({ root, lockRoot })
    await expect(service.materializeWorkspace(directoryIdentity, 'inside')).rejects.toThrow('metadata must be outside')
    await expect(access(lockRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
