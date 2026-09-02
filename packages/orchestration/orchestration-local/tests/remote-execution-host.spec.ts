/** Server-local Git materialization and Resident artifact transfer. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  identifyRemoteWorkspace,
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
  })

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
  })
})
