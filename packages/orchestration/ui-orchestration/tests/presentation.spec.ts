import { describe, expect, it } from 'vitest'
import {
  isDiagnosticOrchestrationWorkspace,
  projectOrchestrationRuns,
  remoteOrchestrationControlAllowed,
} from '../src/index.ts'
import { authorizeRemoteRequest } from '@deepseek-ai/dsh-host-remote-auth'
import { formatLocalTimestamp } from '../src/client/timestamp.ts'

describe('orchestration dashboard presentation', () => {
  it('renders canonical timestamps in the browser-selected zone', () => {
    expect(formatLocalTimestamp(
      '2026-08-16T23:18:28.617Z',
      '2026-08-17T01:05:03.000Z',
      'America/Toronto',
    )).toEqual({
      absolute: '今天 19:18:28 GMT-4',
      relative: '1 小时 46 分钟前',
    })
  })

  it('requires a remote bearer session while retaining owner-local access', () => {
    const request = (remoteAddress: string, authorization?: string) => ({
      headers: { host: '127.0.0.1:3080', ...(authorization === undefined ? {} : { authorization }) },
      socket: { remoteAddress },
    })
    const auth = {
      authenticate: (token: string) => token === 'pocket-token'
        ? { deviceId: 'phone', deviceName: 'Phone', scope: 'pocket' as const }
        : undefined,
    }

    expect(authorizeRemoteRequest(request('127.0.0.1') as never, undefined))
      .toEqual({ local: true, scope: 'admin' })
    expect(authorizeRemoteRequest(request('10.0.0.5') as never, auth)).toBeUndefined()
    expect(authorizeRemoteRequest(request('10.0.0.5', 'Bearer pocket-token') as never, auth))
      .toEqual({
        local: false,
        scope: 'pocket',
        principal: { deviceId: 'phone', deviceName: 'Phone', scope: 'pocket' },
      })
    expect(authorizeRemoteRequest({
      headers: { host: 'harness.example' }, socket: { remoteAddress: '127.0.0.1' },
    } as never, auth)).toBeUndefined()
    expect(remoteOrchestrationControlAllowed('pocket', 'approve')).toBe(true)
    expect(remoteOrchestrationControlAllowed('pocket', 'cancel')).toBe(false)
    expect(remoteOrchestrationControlAllowed('cockpit', 'cancel')).toBe(true)
  })

  it('identifies local acceptance workspaces without hiding user projects', () => {
    expect(isDiagnosticOrchestrationWorkspace('/private/tmp/dsh-orchestration-2.5.2-explicit-no-fallback')).toBe(true)
    expect(isDiagnosticOrchestrationWorkspace('/tmp/dsh-orchestration-acceptance')).toBe(true)
    expect(isDiagnosticOrchestrationWorkspace('/Users/me/Projects/DeepSeek-Solar-Harness')).toBe(false)
  })

  it('keeps acceptance evidence visible and labelled unless the caller hides it', () => {
    const source = [
      { runId: 'acceptance', workspace: '/private/tmp/dsh-orchestration-acceptance' },
      { runId: 'user', workspace: '/Users/me/Projects/app' },
    ]

    expect(projectOrchestrationRuns(source, true)).toEqual({
      runs: [
        { ...source[0], diagnostic: true },
        { ...source[1], diagnostic: false },
      ],
      diagnosticRunCount: 1,
    })
    expect(projectOrchestrationRuns(source, false)).toEqual({
      runs: [{ ...source[1], diagnostic: false }],
      diagnosticRunCount: 1,
    })
  })
})
