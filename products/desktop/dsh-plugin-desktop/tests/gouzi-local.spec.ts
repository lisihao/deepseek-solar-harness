/** Selected project directories are inspected without writes and initialized only on preparation. */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalGouziOperations } from '../src/gouzi-local.ts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gouzi-directory-'))
  roots.push(root)
  const source = join(root, 'project')
  mkdirSync(source)
  const ops = new LocalGouziOperations({ membersRoot: join(root, 'members'), activeLimit: 1, readyTimeoutMs: 1000, stopTimeoutMs: 1000, gitTimeoutMs: 10000, nodeArgs: [] })
  return { root, source, ops }
}
function git(source: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('Gouzi selected directory preparation', () => {
  it('inspects plain directories without changing bytes and initializes an unborn empty-index repository only on preparation', async () => {
    const { root, source, ops } = fixture()
    const bytes = Buffer.from([0, 1, 255, 10])
    writeFileSync(join(source, 'data'), bytes)
    symlinkSync(source, join(root, 'alias'))
    const inspected = await ops.resolveRepository(join(root, 'alias'))
    expect(inspected).toEqual({ source: realpathSync(source), projectId: createHash('sha256').update(realpathSync(source)).digest('hex') })
    expect(existsSync(join(source, '.git'))).toBe(false)
    expect(readFileSync(join(source, 'data'))).toEqual(bytes)
    expect(await ops.prepareRepository(source)).toEqual(inspected)
    expect(existsSync(join(root, '.git'))).toBe(false)
    expect(existsSync(join(source, '.git'))).toBe(true)
    expect(() => git(source, 'rev-parse', '--verify', 'HEAD')).toThrow()
    expect(git(source, 'ls-files')).toBe('')
    expect(readFileSync(join(source, 'data'))).toEqual(bytes)
    const config = readFileSync(join(source, '.git', 'config'))
    expect(await ops.prepareRepository(source)).toEqual(inspected)
    expect(readFileSync(join(source, '.git', 'config'))).toEqual(config)
  })

  it('preserves no-origin repositories and selected subdirectories, with origin used only as optional information', async () => {
    const { source, ops } = fixture()
    git(source, 'init')
    const child = join(source, 'child')
    mkdirSync(child)
    const plain = await ops.resolveRepository(child)
    expect(plain.source).toBe(realpathSync(child))
    expect(plain.repository).toBeUndefined()
    expect(await ops.prepareRepository(child)).toEqual(plain)
    expect(existsSync(join(child, '.git'))).toBe(false)
    git(source, 'remote', 'add', 'origin', 'https://github.com/example/project.git')
    expect(await ops.resolveRepository(child)).toEqual({ ...plain, repository: 'github.com/example/project' })
    git(source, 'remote', 'set-url', 'origin', 'file:///local/repo')
    expect(await ops.resolveRepository(child)).toEqual(plain)
  })

  it('accepts an existing bare repository without modifying its files or creating nested Git metadata', async () => {
    const { source, ops } = fixture()
    git(source, 'init', '--bare')
    writeFileSync(join(source, 'README.md'), 'existing bare project\n')
    const objectId = git(source, 'hash-object', '-w', 'README.md')
    const files = ['HEAD', 'config', 'README.md', join('objects', objectId.slice(0, 2), objectId.slice(2))]
    const original = files.map(file => readFileSync(join(source, file)))
    const project = await ops.resolveRepository(source)
    expect(project).toEqual({ source: realpathSync(source), projectId: createHash('sha256').update(realpathSync(source)).digest('hex') })
    expect(await ops.prepareRepository(source)).toEqual(project)
    expect(files.map(file => readFileSync(join(source, file)))).toEqual(original)
    expect(existsSync(join(source, '.git'))).toBe(false)
    expect(git(source, 'rev-parse', '--is-bare-repository')).toBe('true')
  })

  it('rejects missing paths, files, and malformed existing Git metadata', async () => {
    const { source, ops } = fixture()
    await expect(ops.resolveRepository(join(source, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
    writeFileSync(join(source, 'file'), 'data')
    await expect(ops.prepareRepository(join(source, 'file'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    writeFileSync(join(source, '.git'), 'broken metadata')
    await expect(ops.resolveRepository(source)).rejects.toThrow()
    await expect(ops.prepareRepository(source)).rejects.toThrow()
    expect(readFileSync(join(source, '.git'), 'utf8')).toBe('broken metadata')
  })

  it('surfaces Git initialization failure without claiming preparation', async () => {
    const { root, source, ops } = fixture()
    vi.stubEnv('GIT_TEMPLATE_DIR', join(root, 'missing-template'))
    // An invalid initial branch causes git init to fail while read-only inspection remains available.
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', 'init.defaultBranch')
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'invalid branch name')
    expect((await ops.resolveRepository(source)).source).toBe(realpathSync(source))
    await expect(ops.prepareRepository(source)).rejects.toThrow()
  })

  it('does not let ambient Git paths redirect preparation away from the selected directory', async () => {
    const { root, source, ops } = fixture()
    const other = join(root, 'other')
    mkdirSync(other)
    vi.stubEnv('GIT_DIR', join(other, '.git'))
    vi.stubEnv('GIT_WORK_TREE', other)
    await ops.prepareRepository(source)
    expect(existsSync(join(source, '.git'))).toBe(true)
    expect(existsSync(join(other, '.git'))).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)('rejects a directory that cannot be inspected', async () => {
    const { source, ops } = fixture()
    chmodSync(source, 0)
    try {
      await expect(ops.resolveRepository(source)).rejects.toThrow()
      await expect(ops.prepareRepository(source)).rejects.toThrow()
    } finally {
      chmodSync(source, 0o700)
    }
  })

  it('provisions the exact selected projects and default project in the member cluster', async () => {
    const { root, source, ops } = fixture()
    const project = await ops.prepareRepository(source)
    await ops.provision({ gouziId: 'gouzi-1', ownerId: 'owner', hostId: 'local', generation: 1, authorityEpoch: 'epoch', projects: [project], defaultProjectId: project.projectId })
    const cluster = JSON.parse(readFileSync(join(root, 'members', 'gouzi-1', 'orchestrations', 'cluster.json'), 'utf8'))
    expect(cluster.members[0].remoteExecution).toEqual({ enabled: true, repositories: [], projects: [project], defaultProjectId: project.projectId })
  })
})
