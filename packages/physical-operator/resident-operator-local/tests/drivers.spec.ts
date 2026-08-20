import { describe, expect, it } from 'vitest'
import type { SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  claudeEnvironment,
  claudeResultFailure,
} from '../src/drivers.ts'

describe('Claude Code resident driver environment', () => {
  it('uses the macOS system CA store without changing the parent environment', () => {
    const parent = { PATH: '/usr/bin:/bin' }
    expect(claudeEnvironment(parent, 'darwin')).toEqual({
      PATH: '/usr/bin:/bin',
      NODE_USE_SYSTEM_CA: '1',
    })
    expect(parent).toEqual({ PATH: '/usr/bin:/bin' })
  })

  it('preserves an explicit caller CA policy and does not change other platforms', () => {
    expect(claudeEnvironment({ NODE_USE_SYSTEM_CA: '0' }, 'darwin')).toEqual({ NODE_USE_SYSTEM_CA: '0' })
    expect(claudeEnvironment({ PATH: '/usr/bin' }, 'linux')).toEqual({ PATH: '/usr/bin' })
  })
})

describe('Claude Code resident terminal failures', () => {
  it('classifies an expired native subscription as an authentication failure', () => {
    const failure = claudeResultFailure({
      type: 'result', subtype: 'success', is_error: true,
      result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.',
    } as SDKResultMessage)
    expect(failure).toMatchObject({ code: 'AUTH_MODE_MISMATCH' })
    expect(failure?.message).toContain('claude auth login')
  })

  it('classifies certificate verification as runtime unavailability', () => {
    const failure = claudeResultFailure({
      type: 'result', subtype: 'success', is_error: true,
      result: 'API Error: Unable to connect to API (UNKNOWN_CERTIFICATE_VERIFICATION_ERROR)',
    } as SDKResultMessage)
    expect(failure).toMatchObject({ code: 'RUNTIME_UNAVAILABLE' })
  })

  it('accepts a successful final result', () => {
    expect(claudeResultFailure({
      type: 'result', subtype: 'success', is_error: false, result: 'ok',
    } as SDKResultMessage)).toBeUndefined()
  })
})
