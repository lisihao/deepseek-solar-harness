import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  macOutputDirectory,
  verifyPackagedNodePty,
  type PackagedNodePtyOptions,
} from '../scripts/verify-packaged-node-pty.ts'

function options(overrides: Partial<PackagedNodePtyOptions> = {}): PackagedNodePtyOptions {
  return {
    desktopRoot: '/repo/dsh-plugin-desktop',
    arch: 'arm64',
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin' },
    exists: () => true,
    run: () => ({
      status: 0,
      stdout: 'DSH_PACKAGED_NODE_PTY_OK\n',
      stderr: '',
    }),
    ...overrides,
  }
}

describe('packaged node-pty verification', () => {
  it.each([
    ['arm64', 'mac-arm64'],
    ['x64', 'mac'],
    ['universal', 'mac-universal'],
  ])('maps %s to the Electron Builder output %s', (arch, output) => {
    expect(macOutputDirectory(arch)).toBe(output)
  })

  it('executes node-pty through the packaged Electron runtime', () => {
    const run = vi.fn<PackagedNodePtyOptions['run']>(() => ({
      status: 0,
      stdout: 'DSH_PACKAGED_NODE_PTY_OK\n',
      stderr: '',
    }))

    verifyPackagedNodePty(options({ run }))

    const appRoot = join(
      '/repo/dsh-plugin-desktop',
      'dist',
      'mac-arm64',
      'DSH Desktop.app',
    )
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toBe(join(appRoot, 'Contents', 'MacOS', 'DSH Desktop'))
    expect(run.mock.calls[0]?.[1][0]).toBe('-e')
    expect(run.mock.calls[0]?.[1][2]).toBe(
      join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked'),
    )
    expect(run.mock.calls[0]?.[2]).toEqual({
      PATH: '/usr/bin:/bin',
      ELECTRON_RUN_AS_NODE: '1',
    })
  })

  it('reports the native failure instead of accepting file existence', () => {
    expect(() => verifyPackagedNodePty(options({
      run: () => ({
        status: 2,
        stdout: '',
        stderr: 'Error: posix_spawnp failed.',
      }),
    }))).toThrow('posix_spawnp failed')
  })

  it('fails before execution when spawn-helper is absent', () => {
    const missing = join(
      '/repo/dsh-plugin-desktop',
      'dist',
      'mac-arm64',
      'DSH Desktop.app',
      'Contents',
      'Resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
      'build',
      'Release',
      'spawn-helper',
    )
    const run = vi.fn<PackagedNodePtyOptions['run']>()

    expect(() => verifyPackagedNodePty(options({
      exists: filename => filename !== missing,
      run,
    }))).toThrow(`packaged application is missing ${missing}`)
    expect(run).not.toHaveBeenCalled()
  })
})
