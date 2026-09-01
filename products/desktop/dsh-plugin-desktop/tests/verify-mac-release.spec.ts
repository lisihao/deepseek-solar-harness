import { describe, expect, it } from 'vitest'
import {
  verifyMacRelease,
  type MacReleaseVerificationOptions,
} from '../scripts/verify-mac-release.ts'

describe('macOS ad-hoc release artifact verification', () => {
  it('strictly verifies the packaged application signature', () => {
    const calls: Array<{ command: string; args: readonly string[] }> = []
    const options: MacReleaseVerificationOptions = {
      appPath: '/release/dist/mac-arm64/DSH Desktop.app',
      run: (command, args) => calls.push({ command, args: [...args] }),
    }

    expect(verifyMacRelease(options)).toEqual({ appPath: options.appPath })
    expect(calls).toEqual([{
      command: 'codesign',
      args: ['--verify', '--deep', '--strict', '--verbose=2', options.appPath],
    }])
  })

  it('propagates signature verification failures', () => {
    const options: MacReleaseVerificationOptions = {
      appPath: '/release/dist/mac-arm64/DSH Desktop.app',
      run: () => { throw new Error('invalid signature') },
    }

    expect(() => verifyMacRelease(options)).toThrow('invalid signature')
  })
})
