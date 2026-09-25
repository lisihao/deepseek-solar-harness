import { describe, expect, it } from 'vitest'
import {
  apply,
  isDiagnosticOrchestrationWorkspace,
  projectOrchestrationRuns,
  remoteRlmAgentsControlAllowed,
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
        register(entry: { path: string; handler: NonNullable<typeof handler> }) {
          if (entry.path === '/api/orchestrations') handler = entry.handler
          return () => {}
        },
      },
      effect(callback: () => unknown) { callback() },
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
    expect(remoteRlmAgentsControlAllowed('pocket')).toBe(false)
    expect(remoteRlmAgentsControlAllowed('cockpit')).toBe(true)
  })

  it('keeps the orchestration UI active when the optional RLM runtime is absent', async () => {
    type Handler = (request: unknown, response: unknown) => Promise<void>
    const handlers = new Map<string, Handler>()
    const ctx = {
      webServer: {
        register(entry: { path: string; handler: Handler }) {
          handlers.set(entry.path, entry.handler)
          return () => {}
        },
      },
      effect(callback: () => unknown) { callback() },
      get() { return undefined },
      logger: { warn() {} },
      orchestrations: {},
    }
    apply(ctx as never)
    const handler = handlers.get('/api/orchestrations/rlm-agents')
    if (handler === undefined) throw new Error('RLM Agents route was not registered')
    const response = {
      statusCode: 0,
      body: '',
      setHeader() {},
      end(value?: Uint8Array) { this.body = Buffer.from(value ?? []).toString('utf8') },
    }
    await handler({
      method: 'GET',
      url: '/api/orchestrations/rlm-agents',
      headers: { host: '127.0.0.1:3080' },
      socket: { remoteAddress: '127.0.0.1' },
    }, response)
    expect(response.statusCode).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ error: 'RLM_UNAVAILABLE' })
  })

  it('projects bounded RLM status while retaining control leases in the Host', async () => {
    type Handler = (request: unknown, response: unknown) => Promise<void>
    const handlers = new Map<string, Handler>()
    const calls: { attach: unknown[]; input: unknown[]; detach: unknown[] } = {
      attach: [], input: [], detach: [],
    }
    const session = {
      version: 1,
      sessionId: 'rlm:root',
      executionId: 'execution-secret',
      workspace: '/private/secret-workspace',
      sessionDir: '/private/secret-session-dir',
      task: 'raw task prompt must not reach the browser',
      model: { operatorId: 'codex', model: 'gpt-5.6-luna', source: 'native-subscription' },
      limits: { maxDepth: 2, maxChildren: 4, maxTurns: 8, maxCellMs: 1_000, maxOutputBytes: 8_192 },
      depth: 0,
      lifecycle: 'running',
      stateRevision: 3,
      eventCursor: 17,
      children: [{
        version: 1,
        rlmChildId: 'child-secret',
        sessionId: 'rlm:child',
        parentSessionId: 'rlm:root',
        name: 'private child task name',
        sessionDir: '/private/child-session-dir',
        task: 'child raw task prompt must not reach the browser',
        model: { operatorId: 'codex', model: 'gpt-5.6-luna' },
        depth: 1,
        lifecycle: 'running',
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:01.000Z',
      }],
      restorableVariables: ['privateVariable'],
      degradedVariables: [],
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z',
    }
    const message = {
      version: 1,
      messageId: 'message-1',
      commandId: 'command-secret',
      fromSessionId: 'rlm:root',
      toSessionId: 'rlm:child',
      mode: 'auto',
      text: 'raw control prompt must not reach the browser',
      artifactRefs: ['sha256:artifact-secret'],
      source: 'control',
      controlLeaseId: 'lease-opaque',
      effectiveMode: 'steer',
      deliveryStatus: 'queued',
      deliveryError: 'raw delivery error must not reach the browser',
      queuedAt: '2026-08-28T00:00:00.000Z',
      createdAt: '2026-08-28T00:00:00.000Z',
    }
    const remoteAuth = {
      authenticate: (token: string) => token === 'pocket-token'
        ? { deviceId: 'phone', deviceName: 'Phone', scope: 'pocket' as const }
        : undefined,
    }
    const ctx = {
      webServer: {
        register(entry: { path: string; handler: Handler }) {
          handlers.set(entry.path, entry.handler)
          return () => {}
        },
      },
      effect(callback: () => unknown) { callback() },
      get(name: string) {
        if (name === 'remoteAuth') return remoteAuth
        if (name === 'rlmRuntime') return this.rlmRuntime
        return undefined
      },
      logger: { warn() {} },
      orchestrations: {},
      rlmRuntime: {
        async list() { return [session] },
        async readMessages() { return [message] },
        async attach(request: unknown) {
          calls.attach.push(request)
          return {
            version: 1,
            lease: {
              version: 1,
              leaseId: 'lease-opaque',
              sessionId: 'rlm:root',
              callerId: 'local-owner',
              acquiredAt: '2026-08-28T00:00:02.000Z',
              lastSeenAt: '2026-08-28T00:00:02.000Z',
            },
            snapshot: session,
            eventCursor: 18,
          }
        },
        async input(request: unknown) {
          calls.input.push(request)
          return {
            version: 1,
            sessionId: 'rlm:root',
            leaseId: 'lease-opaque',
            commandId: 'input-1',
            messageId: 'message-2',
            effectiveMode: 'steer',
            deliveryStatus: 'queued',
            stateRevision: 4,
            eventCursor: 19,
          }
        },
        async detach(request: unknown) {
          calls.detach.push(request)
          return {
            version: 1,
            sessionId: 'rlm:root',
            leaseId: 'lease-opaque',
            detached: true,
            eventCursor: 20,
          }
        },
      },
    }
    apply(ctx as never)
    const handler = handlers.get('/api/orchestrations/rlm-agents')
    if (handler === undefined) throw new Error('RLM Agents route was not registered')
    const response = () => ({
      statusCode: 0,
      headers: new Map<string, unknown>(),
      body: '',
      setHeader(name: string, value: unknown) { this.headers.set(name, value) },
      writeHead(status: number) { this.statusCode = status },
      end(value?: Uint8Array) { this.body = Buffer.from(value ?? []).toString('utf8') },
    })
    const request = (
      method: string,
      url: string,
      body?: Record<string, unknown>,
      remoteAddress = '127.0.0.1',
      authorization?: string,
    ) => ({
      method,
      url,
      headers: {
        host: '127.0.0.1:3080',
        ...(authorization === undefined ? {} : { authorization }),
        ...(method === 'POST' ? { 'x-dsh-orchestration-control': '1' } : {}),
      },
      socket: { remoteAddress },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body))
      },
    })

    const projection = response()
    await handler(request('GET', '/api/orchestrations/rlm-agents?session_id=rlm%3Aroot'), projection)
    expect(projection.statusCode).toBe(200)
    expect(JSON.parse(projection.body)).toMatchObject({
      version: 1,
      selectedSessionId: 'rlm:root',
      sessions: [{
        sessionId: 'rlm:root', lifecycle: 'running',
        children: [{ rlmChildId: 'child-secret', lifecycle: 'running' }],
      }],
      messages: [{ messageId: 'message-1', source: 'control', deliveryStatus: 'queued', artifactCount: 1 }],
      control: { canControl: true, attachment: 'not_attached', controller: 'runtime' },
    })
    for (const hidden of [
      'execution-secret', 'secret-workspace', 'secret-session-dir', 'raw task prompt',
      'private child task name', 'raw control prompt', 'command-secret', 'lease-opaque',
      'artifact-secret', 'raw delivery error', 'privateVariable',
    ]) expect(projection.body).not.toContain(hidden)

    const attached = response()
    await handler(request('POST', '/api/orchestrations/rlm-agents', {
      version: 1, action: 'attach', sessionId: 'rlm:root', commandId: 'attach-1',
    }), attached)
    expect(attached.statusCode).toBe(200)
    expect(calls.attach).toEqual([{
      version: 1, sessionId: 'rlm:root', commandId: 'attach-1', callerId: 'local-owner',
    }])
    expect(attached.body).not.toContain('lease-opaque')

    const rawInput = 'this input must stay between the browser request and Runtime'
    const input = response()
    await handler(request('POST', '/api/orchestrations/rlm-agents', {
      version: 1, action: 'input', sessionId: 'rlm:root', commandId: 'input-1', text: rawInput, mode: 'steer',
    }), input)
    expect(input.statusCode).toBe(200)
    expect(calls.input).toEqual([{
      version: 1, sessionId: 'rlm:root', leaseId: 'lease-opaque', commandId: 'input-1', text: rawInput, mode: 'steer',
    }])
    expect(input.body).not.toContain(rawInput)
    expect(input.body).not.toContain('lease-opaque')

    const detached = response()
    await handler(request('POST', '/api/orchestrations/rlm-agents', {
      version: 1, action: 'detach', sessionId: 'rlm:root', commandId: 'detach-1',
    }), detached)
    expect(detached.statusCode).toBe(200)
    expect(calls.detach).toEqual([{
      version: 1, sessionId: 'rlm:root', leaseId: 'lease-opaque', commandId: 'detach-1',
    }])

    const denied = response()
    await handler(request('POST', '/api/orchestrations/rlm-agents', {
      version: 1, action: 'attach', sessionId: 'rlm:root', commandId: 'attach-pocket-1',
    }, '10.0.0.5', 'Bearer pocket-token'), denied)
    expect(denied.statusCode).toBe(403)
    expect(calls.attach).toHaveLength(1)
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
