import { describe, expect, it } from 'vitest'
import {
  apply,
  isDiagnosticOrchestrationWorkspace,
  projectOrchestrationRuns,
  remoteOrchestrationControlAllowed,
} from '../src/index.ts'
import { authorizeRemoteRequest } from '@deepseek-ai/dsh-host-remote-auth'

describe('orchestration dashboard presentation', () => {
  it('loads only Evidence retained by the selected Run', async () => {
    let handler: ((request: unknown, response: unknown) => Promise<void>) | undefined
    let artifactReads = 0
    const evidenceRef = `sha256:${'a'.repeat(64)}`
    const ctx = {
      webServer: {
        register(entry: { handler: typeof handler }) { handler = entry.handler },
      },
      get() { return undefined },
      logger: { warn() {} },
      orchestrations: {
        async list() { return [] },
        async inspect() {
          return {
            runId: 'run-1', workspace: '/tmp/project', nodes: [{ evidenceRefs: [evidenceRef] }],
          }
        },
        async readArtifact() {
          artifactReads += 1
          return { output: [{ type: 'text', text: 'complete model-visible output' }] }
        },
      },
    }
    apply(ctx as never)
    if (handler === undefined) throw new Error('orchestration route was not registered')
    const response = () => ({
      statusCode: 0,
      headers: new Map<string, unknown>(),
      body: '',
      setHeader(name: string, value: unknown) { this.headers.set(name, value) },
      end(value: Uint8Array) { this.body = Buffer.from(value).toString('utf8') },
    })
    const request = (ref: string) => ({
      method: 'GET',
      url: `/api/orchestrations?run_id=run-1&evidence_ref=${encodeURIComponent(ref)}`,
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    })
    const accepted = response()
    await handler(request(evidenceRef), accepted)
    expect(accepted.statusCode).toBe(200)
    expect(JSON.parse(accepted.body)).toMatchObject({
      selectedRunId: 'run-1', evidenceRef,
      evidence: { output: [{ type: 'text', text: 'complete model-visible output' }] },
    })
    const rejected = response()
    await handler(request(`sha256:${'b'.repeat(64)}`), rejected)
    expect(rejected.statusCode).toBe(400)
    expect(artifactReads).toBe(1)
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
