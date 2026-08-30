import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultDshHome,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  localIpcAddress,
  localIpcUsesFilesystem,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('resolves POSIX sockets and deterministic Windows named pipes', () => {
    const root = join(tmpdir(), 'dsh-ipc-fixture', 'resident-operators')
    expect(Buffer.byteLength(join(root, 'control.sock'))).toBeLessThanOrEqual(103)
    expect(localIpcAddress(root, 'control', 'darwin')).toBe(join(root, 'control.sock'))
    expect(localIpcAddress(root, 'control', 'win32')).toMatch(/^\\\\\.\\pipe\\dsh-control-[a-f0-9]{24}$/u)
    expect(localIpcAddress(root, 'control', 'win32')).toBe(localIpcAddress(root, 'control', 'win32'))
    expect(localIpcUsesFilesystem('linux')).toBe(true)
    expect(localIpcUsesFilesystem('win32')).toBe(false)
    expect(() => localIpcAddress(root, '   ', 'linux')).toThrow('local IPC channel must be non-blank')
  })

  it('maps long POSIX socket paths into a deterministic owner-specific temporary directory', () => {
    vi.stubEnv('TMPDIR', '/tmp')
    const root = join(tmpdir(), 'dsh-product-server', 'nested-root'.repeat(12), 'resident-operators')
    const first = localIpcAddress(root, 'control', 'darwin')
    const second = localIpcAddress(root, 'control', 'linux')

    expect(first).toBe(second)
    expect(first).not.toBe(join(resolve(root), 'control.sock'))
    expect(Buffer.byteLength(first)).toBeLessThanOrEqual(103)
    expect(first).toMatch(/[/\\]dsh-ipc-[a-f0-9]{12}[/\\]control-[a-f0-9]{24}\.sock$/u)
    expect(localIpcAddress(`${root}-other`, 'control', 'darwin')).not.toBe(first)
  })

  it('uses the bounded POSIX temporary root when the configured temporary root is too long', () => {
    vi.stubEnv('TMPDIR', join('/tmp', 'temporary-root'.repeat(12)))
    const root = join('/private', 'dsh-product-server'.repeat(12), 'orchestration')
    const address = localIpcAddress(root, 'control', 'darwin')

    expect(address).toMatch(/^\/tmp\/dsh-ipc-[a-f0-9]{12}\/control-[a-f0-9]{24}\.sock$/u)
    expect(Buffer.byteLength(address)).toBeLessThanOrEqual(103)
  })

  it('measures POSIX socket limits in UTF-8 bytes', () => {
    const root = join('/tmp', '长'.repeat(32))
    const direct = join(resolve(root), 'control.sock')

    expect(direct.length).toBeLessThanOrEqual(103)
    expect(Buffer.byteLength(direct)).toBeGreaterThan(103)
    expect(localIpcAddress(root, 'control', 'darwin')).not.toBe(direct)
  })

  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(target)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
