import { describe, expect, it } from 'vitest'
import {
  assertMacReleaseReady,
  withoutMacReleaseSecrets,
} from '../scripts/release-preflight.ts'

describe('macOS ad-hoc release preflight', () => {
  it('selects ad-hoc signing on macOS', () => {
    expect(assertMacReleaseReady('darwin')).toEqual({ signing: 'ad-hoc' })
  })

  it('rejects release execution away from macOS', () => {
    expect(() => assertMacReleaseReady('linux')).toThrow('must be built on macOS')
  })

  it('removes every Apple release variable from build subprocesses', () => {
    const input = {
      SAFE_BUILD_VALUE: 'kept',
      APPLE_ID: 'ignored@example.test',
      APPLE_APP_SPECIFIC_PASSWORD: 'ignored',
      APPLE_TEAM_ID: 'IGNORED',
      CSC_LINK: 'ignored',
      CSC_KEY_PASSWORD: 'ignored',
      CSC_NAME: 'ignored',
    }

    expect(withoutMacReleaseSecrets(input)).toEqual({ SAFE_BUILD_VALUE: 'kept' })
    expect(input.APPLE_ID).toBeDefined()
  })
})
