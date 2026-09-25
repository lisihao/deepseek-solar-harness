import { describe, expect, it } from 'vitest'
import { releaseMac, type MacReleaseOptions } from '../scripts/release-mac.ts'

interface CommandCall {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
}

function baseOptions(calls: CommandCall[], logs: string[] = []): MacReleaseOptions {
  return {
    env: {
      PATH: '/usr/bin',
      SAFE_BUILD_VALUE: 'kept',
      APPLE_ID: 'must-not-be-forwarded',
      CSC_LINK: 'must-not-be-forwarded',
    },
    platform: 'darwin',
    arch: 'arm64',
    desktopRoot: '/repo/dsh-plugin-desktop',
    run: (command, args, cwd, commandEnv) => {
      calls.push({ command, args: [...args], cwd, env: { ...commandEnv } })
    },
    log: message => logs.push(message),
  }
}

describe('macOS release command boundary', () => {
  it('builds without Apple credentials and applies the ad-hoc signature', () => {
    const calls: CommandCall[] = []
    const logs: string[] = []

    releaseMac(baseOptions(calls, logs))

    expect(calls).toHaveLength(4)
    expect(calls[0]).toEqual({
      command: 'yarn',
      args: [
        'exec', 'electron-builder', '--mac', 'dir',
        '--config.mac.identity=null', '--config.mac.notarize=false',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin', SAFE_BUILD_VALUE: 'kept' },
    })
    expect(calls[1]).toEqual({
      command: 'codesign',
      args: [
        '--force', '--deep', '--sign', '-',
        '/repo/dsh-plugin-desktop/dist/mac-arm64/DSH Desktop.app',
      ],
      cwd: '/repo/dsh-plugin-desktop',
      env: { PATH: '/usr/bin', SAFE_BUILD_VALUE: 'kept' },
    })
    expect(calls[2]?.args).toEqual(['scripts/verify-packaged-node-pty.ts'])
    expect(calls[3]?.args).toEqual(['scripts/verify-mac-release.ts'])
    expect(calls.every(call => call.env.APPLE_ID === undefined && call.env.CSC_LINK === undefined)).toBe(true)
    expect(logs).toEqual(['macOS release preflight passed: signing via ad-hoc'])
  })

  it('does not sign or verify after packaging fails', () => {
    const calls: CommandCall[] = []
    const options: MacReleaseOptions = {
      ...baseOptions(calls),
      run: (command, args, cwd, commandEnv) => {
        calls.push({ command, args: [...args], cwd, env: { ...commandEnv } })
        throw new Error('packaging failed')
      },
    }

    expect(() => releaseMac(options)).toThrow('packaging failed')
    expect(calls).toHaveLength(1)
  })
})
