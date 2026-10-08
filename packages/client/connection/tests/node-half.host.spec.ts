/** Node half: registers the /api prefix route bridging to the api gateway. */
import { EventEmitter, once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy/api'
import WebSocket from 'ws'
import { RemoteAuthError, type RemoteAuthService } from '@deepseek-ai/dsh-host-remote-auth'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { WebServer, WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  API_PATH, apply, GouziAdmissionError, GouziMemberService, gouziRequestHash, HOST_EVENTS_PATH, inject, MUX_EVENTS_PATH,
  HostConnectionService, REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_PROTOCOL, REMOTE_SYNC_RPC_CHANNEL,
  RemoteOperatorHostService, type RemoteExecutionWorkspaceIdentityV1,
  type HostConnectionHandle,
} from '../src/index.ts'

/** Structural webServer fake recording both route registries. */
function fakeHttpServer(
  routes: WebRoute[],
  upgrades: WebUpgradeRoute[],
): Pick<WebServer, 'register' | 'registerUpgrade' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      if (routes.some(candidate => candidate.kind === route.kind && candidate.path === route.path)) {
        throw new Error(`duplicate route ${route.path}`)
      }
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    registerUpgrade(route) {
      upgrades.push(route)
      return () => { upgrades.splice(upgrades.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

/** Bodyless GET carrying the given headers (enough for the trust fence + bridge). */
function fakeRequest(
  headers: Record<string, string>,
  url = `${API_PATH}/session.list`,
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const request = Readable.from([]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'GET', headers, socket: { remoteAddress } })
  return request
}

/** JSON POST carrying a complete client-request envelope. */
function fakePost(
  headers: Record<string, string>,
  url: string,
  body: unknown,
  remoteAddress = '127.0.0.1',
): IncomingMessage {
  const request = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage
  Object.assign(request, {
    url,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    socket: { remoteAddress },
  })
  return request
}

/** Raw POST for malformed-body and media-type boundary cases. */
function fakeRawPost(headers: Record<string, string>, url: string, body: string): IncomingMessage {
  const request = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, { url, method: 'POST', headers, socket: { remoteAddress: '127.0.0.1' } })
  return request
}

/** Response recorder compatible with both the fence's short-circuit and the bridge. */
function fakeResponse(): { response: ServerResponse; state: { status?: number; body?: unknown } } {
  const state: { status?: number; body?: unknown } = {}
  const chunks: Buffer[] = []
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writeHead(value: number) { state.status = value; return this },
    write(value: string | Uint8Array) { chunks.push(Buffer.from(value)); return true },
    end(this: { writableEnded: boolean }, value?: unknown) {
      if (typeof value === 'string' || value instanceof Uint8Array) chunks.push(Buffer.from(value))
      else if (value !== undefined) throw new TypeError('fake response only accepts string or Uint8Array bodies')
      if (chunks.length > 0) state.body = Buffer.concat(chunks).toString()
      this.writableEnded = true
      return this
    },
  }) as unknown as ServerResponse
  return { response, state }
}

async function mounted(
  config?: { trustedHosts?: string[]; remoteSync?: boolean; remoteSyncJournalCapacity?: number },
  api: ApiProxy = {} as ApiProxy,
  provide: (ctx: Context) => void = () => {},
): Promise<{
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  connection: HostConnectionHandle
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  const routes: WebRoute[] = []
  const upgrades: WebUpgradeRoute[] = []
  ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
  ctx.provide('apiProxy', api)
  provide(ctx)
  if (config?.remoteSync === true) {
    const commandReceipts = new Map<string, {
      requestHash: string
      state: 'accepted' | 'settled' | 'indeterminate'
      response?: { status: number; contentType?: string; body: string }
    }>()
    ctx.provide('remoteAuth', {
      issuePairing: () => ({ code: '12345678', scope: 'cockpit', expiresAt: new Date().toISOString() }),
      redeemPairing: async (code: string) => {
        if (code !== '12345678') throw new RemoteAuthError('PAIRING_INVALID', 'pairing code is invalid')
        return { deviceId: 'device-1', credential: 'credential', scope: 'cockpit' }
      },
      exchange: (credential: string) => {
        if (credential !== 'credential') {
          throw new RemoteAuthError('CREDENTIAL_INVALID', 'device credential is invalid')
        }
        return {
          deviceId: 'device-1', deviceName: 'MacBook', scope: 'cockpit',
          accessToken: 'access', expiresAt: new Date().toISOString(),
        }
      },
      authenticate: (token: string) => {
        if (token === 'access') return { deviceId: 'device-1', deviceName: 'MacBook', scope: 'cockpit' }
        if (token === 'pocket-access') return { deviceId: 'device-2', deviceName: 'Phone', scope: 'pocket' }
        if (token === 'admin-access') return { deviceId: 'device-3', deviceName: 'Admin', scope: 'admin' }
        if (token === 'gouzi-access') return { deviceId: 'device-4', deviceName: 'Gouzi', scope: 'gouzi' }
        return undefined
      },
      listDevices: () => [],
      revoke: async (deviceId: string) => {
        if (deviceId !== 'device-1') throw new RemoteAuthError('DEVICE_NOT_FOUND', 'remote device not found')
      },
      beginCommand: async (deviceId: string, commandId: string, requestHash: string) => {
        const key = `${deviceId}:${commandId}`
        const receipt = commandReceipts.get(key)
        if (receipt === undefined) {
          commandReceipts.set(key, { requestHash, state: 'accepted' })
          return { kind: 'accepted' as const }
        }
        if (receipt.requestHash !== requestHash) return { kind: 'conflict' as const }
        if (receipt.state === 'settled' && receipt.response !== undefined) {
          return { kind: 'settled' as const, response: receipt.response }
        }
        return { kind: receipt.state === 'accepted' ? 'running' as const : 'indeterminate' as const }
      },
      settleCommand: async (
        deviceId: string,
        commandId: string,
        requestHash: string,
        response: { status: number; contentType?: string; body: string },
      ) => {
        commandReceipts.set(`${deviceId}:${commandId}`, { requestHash, state: 'settled', response })
      },
      markCommandIndeterminate: async (deviceId: string, commandId: string, requestHash: string) => {
        commandReceipts.set(`${deviceId}:${commandId}`, { requestHash, state: 'indeterminate' })
      },
    } as unknown as RemoteAuthService)
  }
  const fiber = ctx.plugin({ inject: [...inject], apply }, config)
  await fiber.await()
  return {
    routes,
    upgrades,
    connection: ctx.get('connection') as HostConnectionHandle,
    dispose: () => fiber.dispose(),
  }
}

/** Minimal long-lived API surface required by the Remote Sync vertical slice. */
function remoteSyncApi(): ApiProxy {
  const waitForAbort = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
  return {
    host: {
      describe: async (request: Parameters<ApiProxy['host']['describe']>[0]) => ({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            version: '3.1.3', cwd: '/srv/dsh', attachedSessions: 0, canOpenPath: false,
          },
        },
      }),
    },
    sessions: {
      list: async (request: Parameters<ApiProxy['sessions']['list']>[0]) => ({
        rpcId: request.rpcId, result: { ok: true, value: { items: [] } },
      }),
    },
    workspace: {
      list: async (request: Parameters<ApiProxy['workspace']['list']>[0]) => ({
        rpcId: request.rpcId,
        result: { ok: true, value: { items: [], archivedSessionIds: [] } },
      }),
    },
    events: {
      mux: (
        request: Parameters<ApiProxy['events']['mux']>[0],
        signal: Parameters<ApiProxy['events']['mux']>[1],
      ) => (async function * () {
        yield {
          rpcId: request.rpcId,
          payload: { type: 'session/subscribed', sessionId: 'session-1' as never, lastSeq: -1 },
        }
        await waitForAbort(signal)
      })(),
      host: (
        _request: Parameters<ApiProxy['events']['host']>[0],
        signal: Parameters<ApiProxy['events']['host']>[1],
      ) => (async function * () { await waitForAbort(signal) })(),
    },
  } as unknown as ApiProxy
}

describe('connection node half', () => {
  it('fails loud when the carrier cap cannot hold the configured image batch', () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('attachments', {
      imageLimits: { maxMessageImageBytes: 20 * 1024 * 1024 },
    } as AttachmentStore)
    ctx.provide('apiProxy', {} as ApiProxy)
    expect(() => { apply(ctx, { maxRequestBodyBytes: 1024 }) })
      .toThrow(/must be at least .* aggregate image limit/)
    expect(routes).toHaveLength(0)
  })

  it('fails the load on a trustedHosts entry that is not a bare authority', async () => {
    const routes: WebRoute[] = []
    const upgrades: WebUpgradeRoute[] = []
    const ctx = new Context()
    ctx.provide('webServer', fakeHttpServer(routes, upgrades) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.internal/path'] })
    await expect(fiber).rejects.toThrow(/not a bare host\[:port\] authority/)
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('registers one HTTP route plus one upgrade route per downlink and removes all three with the fiber', async () => {
    const { routes, upgrades, dispose } = await mounted()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })
    expect(upgrades.map(route => route.path)).toEqual([MUX_EVENTS_PATH, HOST_EVENTS_PATH])
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('mounts snapshot plus cursor routes only when the Server role enables Remote Sync', async () => {
    const { routes, upgrades, dispose } = await mounted({
      remoteSync: true,
      remoteSyncJournalCapacity: 8,
    }, remoteSyncApi())
    expect(routes.map(route => route.path)).toEqual([API_PATH, '/remote-auth', REMOTE_SYNC_RPC_CHANNEL])
    expect(upgrades.map(route => route.path)).toEqual([
      MUX_EVENTS_PATH, HOST_EVENTS_PATH, REMOTE_SYNC_EVENTS_PATH,
    ])

    const snapshotRoute = routes.find(route => route.path === REMOTE_SYNC_RPC_CHANNEL)!
    const describeRequest: ClientRequest = {
      type: 'client-request', rpcId: RpcId('remote-describe'), method: 'describe', payload: {},
    }
    const description = fakeResponse()
    await snapshotRoute.handler(fakePost(
      { host: '127.0.0.1:3080' },
      `${REMOTE_SYNC_RPC_CHANNEL}/describe`,
      describeRequest,
    ), description.response)
    expect(JSON.parse(String(description.state.body))).toMatchObject({
      rpcId: 'remote-describe',
      result: {
        ok: true,
        value: {
          protocol: { major: 1, minor: 3 },
          scope: 'admin',
          capabilities: ['session.read', 'workspace.read', 'event.subscribe', 'session.command', 'approval.respond'],
          host: { version: '3.1.3' },
        },
      },
    })
    const request: ClientRequest = {
      type: 'client-request', rpcId: RpcId('remote-snapshot'), method: 'snapshot', payload: {},
    }
    const result = fakeResponse()
    await snapshotRoute.handler(fakePost(
      { host: '127.0.0.1:3080' },
      `${REMOTE_SYNC_RPC_CHANNEL}/snapshot`,
      request,
    ), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toMatchObject({
      rpcId: 'remote-snapshot',
      result: {
        ok: true,
        value: {
          protocol: { major: 1, minor: 3 },
          host: { version: '3.1.3', cwd: '/srv/dsh' },
          sessions: [], workspaces: [], archivedSessionIds: [],
        },
      },
    })
    await dispose()
    expect(routes).toHaveLength(0)
    expect(upgrades).toHaveLength(0)
  })

  it('requires a short-lived credential remotely and enforces fixed device scopes', async () => {
    const { routes, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      remoteSync: true,
      remoteSyncJournalCapacity: 8,
    }, remoteSyncApi())
    const authRoute = routes.find(route => route.path === '/remote-auth')!
    const snapshotRoute = routes.find(route => route.path === REMOTE_SYNC_RPC_CHANNEL)!
    const call = async (
      route: WebRoute,
      channel: string,
      method: string,
      payload: Record<string, unknown>,
      headers: Record<string, string> = {},
    ): Promise<{ status?: number; body?: unknown }> => {
      const result = fakeResponse()
      await route.handler(fakePost(
        { host: 'harness.example', ...headers },
        `${channel}/${method}`,
        { type: 'client-request', rpcId: `rpc-${method}`, method, payload },
      ), result.response)
      return result.state
    }

    expect(await call(snapshotRoute, REMOTE_SYNC_RPC_CHANNEL, 'snapshot', {}))
      .toMatchObject({ status: 401, body: 'unauthorized' })
    expect((await call(snapshotRoute, REMOTE_SYNC_RPC_CHANNEL, 'snapshot', {}, {
      authorization: 'Bearer access',
    })).status).toBe(200)

    expect(await call(authRoute, '/remote-auth', 'pairing.issue', { scope: 'cockpit' }))
      .toMatchObject({ status: 403, body: 'forbidden' })
    const localIssue = fakeResponse()
    await authRoute.handler(fakePost(
      { host: '127.0.0.1:3080' },
      '/remote-auth/pairing.issue',
      { type: 'client-request', rpcId: 'rpc-pairing.issue', method: 'pairing.issue', payload: { scope: 'cockpit' } },
    ), localIssue.response)
    expect(localIssue.state.status).toBe(200)

    expect(await call(authRoute, '/remote-auth', 'pairing.redeem', {
      code: '00000000', deviceName: 'MacBook',
    })).toMatchObject({ status: 400, body: 'pairing code is invalid' })
    expect(await call(authRoute, '/remote-auth', 'session.exchange', { credential: 'wrong' }))
      .toMatchObject({ status: 401, body: 'unauthorized' })
    expect((await call(authRoute, '/remote-auth', 'session.exchange', { credential: 'credential' })).status)
      .toBe(200)

    expect(await call(authRoute, '/remote-auth', 'device.list', {}, {
      authorization: 'Bearer pocket-access',
    })).toMatchObject({ status: 403, body: 'forbidden' })
    expect((await call(authRoute, '/remote-auth', 'device.list', {}, {
      authorization: 'Bearer admin-access',
    })).status).toBe(200)
    expect(await call(authRoute, '/remote-auth', 'device.revoke', { deviceId: 'missing' }, {
      authorization: 'Bearer admin-access',
    })).toMatchObject({ status: 404, body: 'remote device not found' })

    await dispose()
  })

  it('confines a gouzi credential to describe and the operator execution methods', async () => {
    const { routes, upgrades, dispose } = await mounted({
      trustedHosts: ['harness.example'], remoteSync: true, remoteSyncJournalCapacity: 8,
    }, remoteSyncApi())
    const gouzi = { host: 'harness.example', authorization: 'Bearer gouzi-access' }
    const syncRoute = routes.find(route => route.path === REMOTE_SYNC_RPC_CHANNEL)!
    const syncCall = async (method: string, payload: Record<string, unknown> = {}): Promise<{ status?: number; body?: unknown }> => {
      const result = fakeResponse()
      await syncRoute.handler(fakePost(
        gouzi, `${REMOTE_SYNC_RPC_CHANNEL}/${method}`,
        { type: 'client-request', rpcId: `rpc-${method}`, method, payload },
      ), result.response)
      return result.state
    }

    // Everything outside describe and operator.* is refused before the handler runs.
    for (const method of [
      'snapshot', 'replica.list', 'replica.read', 'replica.apply',
      'cluster.status', 'cluster.vote', 'cluster.heartbeat', 'cluster.export', 'cluster.install',
      'gouzi.create', 'no.such.method',
    ]) {
      expect(await syncCall(method), method).toMatchObject({ status: 403, body: 'forbidden' })
    }

    const described = await syncCall('describe', { protocol: REMOTE_SYNC_PROTOCOL })
    expect(described.status).toBe(200)
    const envelope = JSON.parse(described.body as string) as {
      result: { ok: true; value: { scope: string; capabilities: string[] } }
    }
    expect(envelope.result.value.scope).toBe('gouzi')
    // No Resident host is mounted here, so the operator list is empty; no session or cluster capability may appear.
    expect(envelope.result.value.capabilities).toEqual([])

    // The operator methods pass the scope gate; without a Resident host they fail for another reason, not 403.
    for (const method of ['operator.providers', 'operator.inspect', 'operator.events', 'operator.interrupt']) {
      expect((await syncCall(method)).status, method).not.toBe(403)
    }

    // The API bridge, member management, and both event sockets stay closed to the scope.
    const apiRoute = routes.find(route => route.path === API_PATH)!
    for (const method of ['session.list', 'settings.describe', 'session.cancel']) {
      const denied = fakeResponse()
      await apiRoute.handler(fakePost(
        gouzi, `${API_PATH}/${method}`,
        { type: 'client-request', rpcId: `rpc-${method}`, method, payload: {} },
      ), denied.response)
      expect(denied.state, method).toMatchObject({ status: 403, body: 'forbidden' })
    }
    const authRoute = routes.find(route => route.path === '/remote-auth')!
    const devices = fakeResponse()
    await authRoute.handler(fakePost(
      gouzi, '/remote-auth/device.list',
      { type: 'client-request', rpcId: 'rpc-devices', method: 'device.list', payload: {} },
    ), devices.response)
    expect(devices.state).toMatchObject({ status: 403, body: 'forbidden' })
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH, REMOTE_SYNC_EVENTS_PATH]) {
      const socket = new PassThrough()
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      const ended = once(socket, 'end')
      await upgrades.find(route => route.path === path)!.handler(fakeRequest(gouzi, path), socket, Buffer.alloc(0))
      await ended
      expect(Buffer.concat(chunks).toString(), path).toContain('HTTP/1.1 403 Forbidden')
    }
    await dispose()
  })

  it('admits gouzi execution only with a grant the member accepts and replays a stored receipt', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'connection-gouzi-project-'))
    const projectId = 'b'.repeat(64)
    await writeFile(join(projectPath, 'untracked.txt'), 'existing user data')
    const accepted = { sessionId: 'resident-session', turnId: 'resident-turn', stateRevision: 2 }
    const commandReceipts = new Map<string, unknown>()
    let failRecordAccepted = false
    const execute = vi.fn(async (request: { workspace: string; commandId: string }) => {
      if (request.workspace === projectPath) {
        expect(await readFile(join(request.workspace, 'untracked.txt'), 'utf8')).toBe('existing user data')
        await writeFile(join(request.workspace, 'output.txt'), 'resident wrote this')
        commandReceipts.set(request.commandId, { ...accepted, commandId: request.commandId, state: 'running' })
      }
      return { ...accepted, result: new Promise(() => {}), dispose: async () => undefined }
    })
    const materializeWorkspace = vi.fn(async (identity: RemoteExecutionWorkspaceIdentityV1) => {
      if ('kind' in identity && identity.projectId !== projectId) throw new Error('unknown registered project')
      return { version: 1 as const, identity, path: 'kind' in identity ? projectPath : '/srv/work' }
    })
    class ProjectHost extends RemoteOperatorHostService {
      override async inspectWorkspace() { return undefined }
      async qualification() { return { available: true } }
      override async gouziWorkspace() { return { projectId, projectScopes: [projectPath] } }
      materializeWorkspace = materializeWorkspace
      async renewWorkspace() {}
      async releaseWorkspace() {}
      async readResidentArtifact(ref: string) { return { ref, json: '{}' } }
    }
    const stored = new Map<string, { hash: string; accepted?: unknown }>()
    class FakeMember extends GouziMemberService {
      hello() {
        return {
          gouziId: 'gouzi-1', ownerId: 'owner-1', hostId: 'host-1', generation: 1, authorityEpoch: 'epoch-1', incarnation: 1,
        }
      }
      async admit(grant: { executionId: string; generation: number; planHash: string }, hash: string) {
        if (grant.generation !== 1) throw new GouziAdmissionError('GOUZI_GENERATION_MISMATCH', 'wrong generation')
        if (grant.planHash !== hash) throw new GouziAdmissionError('GOUZI_PLAN_MISMATCH', 'wrong plan')
        const entry = stored.get(grant.executionId)
        if (entry === undefined) {
          stored.set(grant.executionId, { hash })
          return { kind: 'new' as const }
        }
        if (entry.hash !== hash) throw new GouziAdmissionError('GOUZI_EXECUTION_CONFLICT', 'conflict')
        return entry.accepted === undefined ? { kind: 'new' as const } : { kind: 'replay' as const, accepted: entry.accepted as never }
      }
      async recordAccepted(executionId: string, receipt: unknown) {
        if (failRecordAccepted) { failRecordAccepted = false; throw new Error('member ledger write failed') }
        stored.get(executionId)!.accepted = receipt
      }
    }
    const withMember = async (member: boolean) => mounted(
      { trustedHosts: ['harness.example'], remoteSync: true, remoteSyncJournalCapacity: 8 },
      remoteSyncApi(),
      (ctx) => {
        ctx.provide('residentOperators', {
          inspectCommand: async (commandId: string) => commandReceipts.get(commandId),
          providers: async () => [], execute, inspectTurn: async () => ({}),
          readEvents: async () => ({}), interrupt: async () => undefined,
        })
        ctx.plugin(ProjectHost)
        if (member) ctx.plugin(FakeMember)
      },
    )
    const request = (commandId: string) => ({
      commandId, operatorId: 'codex', laneId: 'lane-1', prompt: [],
      workspaceIdentity: { version: 1, repository: 'github.com/lisihao/project', commit: 'a'.repeat(40) },
    })
    const grantFor = (commandId: string, patch: Record<string, unknown> = {}) => ({
      runId: 'run-1', nodeId: 'node-1', attempt: 1, executionId: commandId, gouziId: 'gouzi-1', generation: 1,
      authorityEpoch: 'epoch-1', planHash: gouziRequestHash(request(commandId) as never),
      scopes: { read: [], write: [], effects: [] }, credentialRefs: [],
      deadline: '2999-01-01T00:00:00.000Z', offlineUntil: '2999-01-01T00:00:00.000Z', ...patch,
    })
    const call = async (route: WebRoute, method: string, payload: Record<string, unknown>, token = 'gouzi-access') => {
      const result = fakeResponse()
      await route.handler(fakePost(
        { host: 'harness.example', authorization: `Bearer ${token}` }, `${REMOTE_SYNC_RPC_CHANNEL}/${method}`,
        { type: 'client-request', rpcId: `rpc-${method}`, method, payload },
      ), result.response)
      return result.state
    }

    const hosted = await withMember(true)
    const route = hosted.routes.find(candidate => candidate.path === REMOTE_SYNC_RPC_CHANNEL)!
    const body = (command: string, patch: Record<string, unknown> = {}) => ({
      ...request(command), protocol: REMOTE_SYNC_PROTOCOL, gouziGrant: grantFor(command, patch),
    })
    const hello = await call(route, 'gouzi.hello', {})
    expect(hello.status).toBe(200)
    expect((JSON.parse(hello.body as string) as { result: { value: unknown } }).result.value)
      .toMatchObject({ gouziId: 'gouzi-1', incarnation: 1 })

    // A04: nothing reaches the workspace or the Resident host when the grant is refused.
    expect(await call(route, 'operator.execute', body('exec-1', { generation: 2 })))
      .toSatisfy((state: { status?: number; body?: unknown }) => state.status === 403 && String(state.body).includes('GOUZI_GENERATION_MISMATCH'))
    expect(await call(route, 'operator.execute', body('exec-1', { planHash: 'f'.repeat(64) })))
      .toSatisfy((state: { status?: number; body?: unknown }) => state.status === 403 && String(state.body).includes('GOUZI_PLAN_MISMATCH'))
    expect(await call(route, 'operator.execute', body('exec-1', { executionId: 'exec-other' })))
      .toSatisfy((state: { status?: number; body?: unknown }) => state.status === 403 && String(state.body).includes('GOUZI_EXECUTION_MISMATCH'))
    expect(await call(route, 'operator.execute', { ...request('exec-1'), protocol: REMOTE_SYNC_PROTOCOL }))
      .toMatchObject({ status: 400 })
    expect(await call(route, 'operator.execute', { ...body('exec-1'), gouziGrant: { executionId: 'exec-1' } }))
      .toMatchObject({ status: 400 })
    expect(materializeWorkspace).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()

    // A05: the first call executes once; a repeat returns the stored receipt; another request under the id conflicts.
    expect((await call(route, 'operator.execute', body('exec-1'))).status).toBe(200)
    expect((await call(route, 'operator.execute', body('exec-1'))).status).toBe(200)
    expect(execute).toHaveBeenCalledTimes(1)
    expect(materializeWorkspace).toHaveBeenCalledTimes(1)
    const changed = { ...request('exec-1'), laneId: 'lane-2' }
    expect(await call(route, 'operator.execute', {
      ...changed, protocol: REMOTE_SYNC_PROTOCOL,
      gouziGrant: grantFor('exec-1', { planHash: gouziRequestHash(changed as never) }),
    })).toSatisfy((state: { status?: number; body?: unknown }) => state.status === 409 && String(state.body).includes('GOUZI_EXECUTION_CONFLICT'))
    expect(execute).toHaveBeenCalledTimes(1)

    // A member host needs a grant from every caller, whatever its credential scope.
    expect((await call(route, 'operator.execute', { ...request('exec-cockpit'), protocol: REMOTE_SYNC_PROTOCOL }, 'access')).status)
      .toBe(400)
    expect((await call(route, 'operator.execute', body('exec-cockpit'), 'access')).status).toBe(200)

    const directory = (commandId: string, identity: Record<string, unknown> = { version: 1, kind: 'gouzi-project', projectId }) => {
      const requestBody = { ...request(commandId), workspaceIdentity: identity }
      return {
        ...requestBody, protocol: REMOTE_SYNC_PROTOCOL,
        gouziGrant: grantFor(commandId, { planHash: gouziRequestHash(requestBody as never) }),
      }
    }
    for (const identity of [
      { version: 1, kind: 'unknown', projectId },
      { version: 1, kind: 'gouzi-project', projectId, commit: 'a'.repeat(40) },
      { version: 1, repository: 'github.com/lisihao/project', commit: 'a'.repeat(40), projectId },
      { version: 1, kind: 'gouzi-project', projectId: 'not-a-project' },
      ...['../secret', '/secret', 'a\\b', 'a/./b', 'a//b'].map(subdir => ({ version: 1, kind: 'gouzi-project', projectId, subdir })),
    ]) expect((await call(route, 'operator.execute', directory('invalid-dir', identity))).status).toBe(400)
    const goodDirectory = directory('exec-directory')
    expect((await call(route, 'operator.execute', { ...goodDirectory, protocol: { major: 1, minor: 4 } })).status).toBe(409)
    expect((await call(route, 'operator.execute', {
      ...goodDirectory, workspaceIdentity: { version: 1, kind: 'gouzi-project', projectId: 'c'.repeat(64) },
    })).status).toBe(403)
    const beforeDirectory = execute.mock.calls.length
    expect((await call(route, 'operator.execute', goodDirectory)).status).toBe(200)
    expect((await call(route, 'operator.execute', goodDirectory)).status).toBe(200)
    expect(execute.mock.calls.length).toBe(beforeDirectory + 1)
    const beforeLostReceipt = execute.mock.calls.length
    failRecordAccepted = true
    expect((await call(route, 'operator.execute', directory('ledger-lost'))).status).toBe(500)
    expect((await call(route, 'operator.execute', directory('ledger-lost'))).status).toBe(200)
    expect(execute.mock.calls.length).toBe(beforeLostReceipt + 1)
    expect(await readFile(join(projectPath, 'output.txt'), 'utf8')).toBe('resident wrote this')
    expect((await call(route, 'operator.execute', directory('unknown-dir', { version: 1, kind: 'gouzi-project', projectId: 'c'.repeat(64) }))).status).toBe(500)
    expect(execute.mock.calls.length).toBe(beforeLostReceipt + 1)
    await hosted.dispose()

    // Without a mounted member gate the scope can neither execute nor say hello.
    const bare = await withMember(false)
    const bareRoute = bare.routes.find(candidate => candidate.path === REMOTE_SYNC_RPC_CHANNEL)!
    expect(await call(bareRoute, 'operator.execute', body('exec-2'))).toMatchObject({ status: 403, body: 'forbidden' })
    expect(await call(bareRoute, 'gouzi.hello', {})).toMatchObject({ status: 403, body: 'forbidden' })
    // A host without the gate keeps the ordinary remote-execution path for cockpit callers.
    expect((await call(bareRoute, 'operator.execute', { ...request('exec-3'), protocol: REMOTE_SYNC_PROTOCOL }, 'access')).status)
      .toBe(200)
    for (const token of ['gouzi-access', 'access', 'admin-access']) {
      expect((await call(bareRoute, 'operator.execute', directory('bare-dir'), token)).status).toBe(403)
    }
    const localDirectory = fakeResponse()
    await bareRoute.handler(fakePost(
      { host: '127.0.0.1:3080' }, `${REMOTE_SYNC_RPC_CHANNEL}/operator.execute`,
      { type: 'client-request', rpcId: 'loopback-directory', method: 'operator.execute', payload: directory('loopback-dir') },
    ), localDirectory.response)
    expect(localDirectory.state.status).toBe(403)
    await bare.dispose()
    await rm(projectPath, { recursive: true, force: true })
  })

  it('never grants local-owner authority from a forged loopback Host', async () => {
    const { routes, upgrades, connection, dispose } = await mounted({
      trustedHosts: ['harness.example'],
      remoteSync: true,
      remoteSyncJournalCapacity: 8,
    }, remoteSyncApi())
    const remoteAddress = '203.0.113.10'
    const authRoute = routes.find(route => route.path === '/remote-auth')!
    const snapshotRoute = routes.find(route => route.path === REMOTE_SYNC_RPC_CHANNEL)!
    const apiRoute = routes.find(route => route.path === API_PATH)!

    const pairing = fakeResponse()
    await authRoute.handler(fakePost(
      { host: 'localhost:3080' },
      '/remote-auth/pairing.issue',
      {
        type: 'client-request', rpcId: 'forged-pairing', method: 'pairing.issue', payload: { scope: 'admin' },
      },
      remoteAddress,
    ), pairing.response)
    expect(pairing.state).toMatchObject({ status: 403, body: 'forbidden' })

    const snapshot = fakeResponse()
    await snapshotRoute.handler(fakePost(
      { host: 'localhost:3080' },
      `${REMOTE_SYNC_RPC_CHANNEL}/snapshot`,
      { type: 'client-request', rpcId: 'forged-snapshot', method: 'snapshot', payload: {} },
      remoteAddress,
    ), snapshot.response)
    expect(snapshot.state).toMatchObject({ status: 401, body: 'unauthorized' })

    const sessionList = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'localhost:3080' },
      `${API_PATH}/session.list`,
      { type: 'client-request', rpcId: 'forged-list', method: 'session.list', payload: {} },
      remoteAddress,
    ), sessionList.response)
    expect(sessionList.state).toMatchObject({ status: 401, body: 'unauthorized' })

    const removeGateway = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: { accepted: true } }),
      { authority: 'trusted-host' },
    )
    const gatewayRequest = {
      type: 'client-request', rpcId: 'forged-gateway', method: 'goals/create', payload: {},
    }
    const gatewayDenied = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'localhost:3080' },
      `${API_PATH}/goals/create`,
      gatewayRequest,
      remoteAddress,
    ), gatewayDenied.response)
    expect(gatewayDenied.state).toMatchObject({ status: 401, body: 'unauthorized' })

    const gatewayAccepted = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'localhost:3080', authorization: 'Bearer access' },
      `${API_PATH}/goals/create`,
      gatewayRequest,
      remoteAddress,
    ), gatewayAccepted.response)
    expect(gatewayAccepted.state.status).toBe(200)
    await removeGateway()

    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades.find(route => route.path === MUX_EVENTS_PATH)!.handler(
      fakeRequest({ host: 'localhost:3080' }, MUX_EVENTS_PATH, remoteAddress),
      socket,
      Buffer.alloc(0),
    )
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('authenticates remote reads and settles cockpit commands exactly once', async () => {
    let cancelCalls = 0
    const api = remoteSyncApi()
    api.sessions.cancel = async (request) => {
      cancelCalls++
      return { rpcId: request.rpcId, result: { ok: true, value: { accepted: true } } }
    }
    const { routes, upgrades, dispose } = await mounted({
      trustedHosts: ['harness.example'], remoteSync: true, remoteSyncJournalCapacity: 8,
    }, api)
    const apiRoute = routes.find(route => route.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request', rpcId: RpcId('remote-session-list'), method: 'session.list', payload: {},
    }
    const denied = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'harness.example' }, `${API_PATH}/session.list`, request,
    ), denied.response)
    expect(denied.state).toMatchObject({ status: 401, body: 'unauthorized' })

    for (const token of ['access', 'pocket-access']) {
      const accepted = fakeResponse()
      await apiRoute.handler(fakePost(
        { host: 'harness.example', authorization: `Bearer ${token}` },
        `${API_PATH}/session.list`,
        request,
      ), accepted.response)
      expect(accepted.state.status).toBe(200)
    }

    const pocketSettings = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'harness.example', authorization: 'Bearer pocket-access' },
      `${API_PATH}/settings.describe`,
      { type: 'client-request', rpcId: 'pocket-settings', method: 'settings.describe', payload: {} },
    ), pocketSettings.response)
    expect(pocketSettings.state.status).toBe(403)
    const cockpitSettings = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'harness.example', authorization: 'Bearer access' },
      `${API_PATH}/settings.describe`,
      { type: 'client-request', rpcId: 'cockpit-settings', method: 'settings.describe', payload: {} },
    ), cockpitSettings.response)
    expect(cockpitSettings.state.status).not.toBe(403)

    const command = {
      type: 'client-request' as const,
      rpcId: 'remote-cancel',
      method: 'session.cancel',
      payload: { sessionId: 'session-1' },
    }
    const pocketWrite = fakeResponse()
    await apiRoute.handler(fakePost(
      { host: 'harness.example', authorization: 'Bearer pocket-access' },
      `${API_PATH}/session.cancel`, command,
    ), pocketWrite.response)
    expect(pocketWrite.state.status).toBe(403)

    for (let attempt = 0; attempt < 2; attempt++) {
      const write = fakeResponse()
      await apiRoute.handler(fakePost(
        { host: 'harness.example', authorization: 'Bearer access' },
        `${API_PATH}/session.cancel`, command,
      ), write.response)
      expect(write.state.status).toBe(200)
    }
    expect(cancelCalls).toBe(1)

    const legacyEvents = upgrades.find(route => route.path === MUX_EVENTS_PATH)!
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await legacyEvents.handler(fakeRequest({ host: 'harness.example' }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('requires WebSocket upgrade for network GETs to either event path', async () => {
    const { routes, dispose } = await mounted()
    for (const path of [MUX_EVENTS_PATH, HOST_EVENTS_PATH]) {
      const { response, state } = fakeResponse()
      await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }, path), response)
      expect(state.status).toBe(426)
      expect(state.body).toBe('upgrade required')
    }
    await dispose()
  })

  it('rejects an untrusted WebSocket upgrade before protocol negotiation', async () => {
    const { upgrades, dispose } = await mounted()
    const socket = new PassThrough()
    const chunks: Buffer[] = []
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    const ended = once(socket, 'end')
    await upgrades[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }, MUX_EVENTS_PATH), socket, Buffer.alloc(0))
    await ended
    expect(Buffer.concat(chunks).toString()).toContain('HTTP/1.1 403 Forbidden')
    await dispose()
  })

  it('refuses an untrusted Host on any /api path before the bridge runs', async () => {
    const { routes, dispose } = await mounted()
    const { response, state } = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example', origin: 'http://harness.example', 'sec-fetch-site': 'same-origin',
    }), response)
    expect(state.status).toBe(403)
    expect(state.body).toBe('forbidden')
    await dispose()
  })

  it('does not treat a declared trusted authority as remote authentication', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    // The privileged set: native dialogs plus the whole settings/credential
    // configuration plane, reads included, plus the one method that makes the
    // host fetch a caller-chosen URL. A declared authority only passes the
    // rebinding fence; without Remote Sync authentication all API methods 403.
    for (const method of [
      'host.pickDirectory', 'host.openPath',
      'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
      'credentials.describe', 'credentials.set', 'credentials.unset',
      'llm.discoverModels',
      // A composition names the plugins a session runs: reading one is
      // reconnaissance, and copy/remove/openDocument manage the roster and
      // drive the host desktop.
      'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
    ]) {
      const denied = fakeResponse()
      await routes[0]!.handler(
        fakeRequest({ host: 'harness.example' }, `${API_PATH}/${method}`),
        denied.response,
      )
      expect(denied.state.status).toBe(403)
      expect(denied.state.body).toBe('forbidden')
    }
    const read = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: 'harness.example' }), read.response)
    expect(read.state).toMatchObject({ status: 403, body: 'forbidden' })
    await dispose()
  })

  it('passes loopback requests and keeps declared authorities behind remote authentication', async () => {
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example:3080', '192.168.1.5'] })
    // Loopback, no browser markers (curl shape): the fence passes; the carrier
    // answers 404 for a GET unary path — proof the bridge ran.
    const loopback = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '127.0.0.1:3080' }), loopback.response)
    expect(loopback.state.status).toBe(404)
    // A declared authority passes the DNS-rebinding fence but is not an
    // authentication credential. With Remote Sync disabled it remains closed.
    const lan = fakeResponse()
    await routes[0]!.handler(fakeRequest({ host: '192.168.1.5:3080' }), lan.response)
    expect(lan.state.status).toBe(403)
    // Declared public authority, same-origin browser shape.
    const declared = fakeResponse()
    await routes[0]!.handler(fakeRequest({
      host: 'harness.example:3080', origin: 'http://harness.example:3080', 'sec-fetch-site': 'same-origin',
    }), declared.response)
    expect(declared.state.status).toBe(403)
    await dispose()
  })

  it('provides a disposable dedicated RPC channel without requiring apiProxy', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(routes).toHaveLength(1)
    expect(routes[0]).toMatchObject({ kind: 'prefix', path: API_PATH })

    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.handle('/rpc', async (endpoint, payload) => {
      calls.push({ endpoint, payload })
      return { ok: true, value: { accepted: true } }
    }, { authority: 'trusted-host' })
    const route = routes.find(candidate => candidate.path === '/rpc')
    expect(route).toBeDefined()

    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-dedicated'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }
    const result = fakeResponse()
    await route!.handler(fakePost({ host: '127.0.0.1:3080' }, '/rpc/goals/create', request), result.response)
    expect(result.state.status).toBe(200)
    expect(JSON.parse(String(result.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-dedicated',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    expect(() => connection.rpc.handle('/rpc', async () => ({ ok: true, value: null }), {
      authority: 'trusted-host',
    })).toThrow(/duplicate route/)
    await remove()
    expect(routes.map(candidate => candidate.path)).toEqual([API_PATH])
    await fiber.dispose()
    expect(routes).toHaveLength(0)
  })

  it('dispatches claimed /api endpoints before the API Proxy fallback and withdraws the claim', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    ctx.provide('apiProxy', {} as unknown as ApiProxy)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const calls: unknown[] = []
    const remove = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return { ok: true, value: { accepted: true } }
      },
      { authority: 'trusted-host' },
    )
    expect(() => connection.rpc.intercept(
      '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('already has an interceptor')
    expect(() => connection.rpc.intercept(
      '/rpc' as '/api',
      () => true,
      async () => ({ ok: true, value: null }),
      { authority: 'trusted-host' },
    )).toThrow('invalid shared RPC channel')
    const route = routes.find(candidate => candidate.path === API_PATH)!
    const request: ClientRequest = {
      type: 'client-request',
      rpcId: RpcId('rpc-shared'),
      method: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }

    const claimed = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), claimed.response)
    expect(JSON.parse(String(claimed.state.body))).toEqual({
      type: 'server-response',
      rpcId: 'rpc-shared',
      result: { ok: true, value: { accepted: true } },
    })
    expect(calls).toEqual([{
      endpoint: 'goals/create',
      payload: { args: { agentId: 'agent-1' } },
    }])

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/api/goals/create', request), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })
    expect(calls).toHaveLength(1)

    const unclaimed = fakeResponse()
    await route.handler(fakeRequest({ host: '127.0.0.1:3080' }, '/api/session.list'), unclaimed.response)
    expect(unclaimed.state.status).toBe(404)

    await remove()
    const withdrawn = fakeResponse()
    await route.handler(fakePost({ host: '127.0.0.1:3080' }, '/api/goals/create', request), withdrawn.response)
    expect(withdrawn.state.status).toBe(404)
    expect(calls).toHaveLength(1)

    const removeLoopback = connection.rpc.intercept(
      '/api',
      endpoint => endpoint === 'goals/create',
      async () => ({ ok: true, value: null }),
      { authority: 'loopback' },
    )
    const shared = (ctx.get('connection') as HostConnectionService).createSharedFetchHandler(
      API_PATH,
      { fetch: async () => new Response('fallback', { status: 418 }) },
    )
    const sharedRequest = (): Request => new Request('http://localhost:3080/api/goals/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3080' },
      body: JSON.stringify(request),
    })
    const forgedShared = await shared.fetch(sharedRequest(), { remoteAddress: '203.0.113.10' })
    expect(forgedShared.status).toBe(403)
    expect(await forgedShared.text()).toBe('forbidden')
    const localShared = await shared.fetch(sharedRequest(), { remoteAddress: '127.0.0.1' })
    expect(localShared.status).toBe(200)
    const loopbackOnly = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/api/goals/create', request), loopbackOnly.response)
    expect(loopbackOnly.state.status).toBe(403)
    await removeLoopback()
    await fiber.dispose()
  })

  it('applies the configured trust fence and JSON envelope checks to generic channels', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('webServer', fakeHttpServer(routes, []) as WebServer)
    const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts: ['harness.example'] })
    await fiber.await()
    const connection = ctx.get('connection') as HostConnectionHandle
    const remove = connection.rpc.handle('/rpc', async (endpoint) => {
      if (endpoint === 'fail') throw new Error('handler broke')
      return { ok: true, value: null }
    }, {
      authority: 'trusted-host',
    })
    const route = routes.find(candidate => candidate.path === '/rpc')!

    const denied = fakeResponse()
    await route.handler(fakePost({ host: 'other.example' }, '/rpc/goals/create', {}), denied.response)
    expect(denied.state).toMatchObject({ status: 403, body: 'forbidden' })

    const methodMismatch = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', {
      type: 'client-request', rpcId: 'rpc-bad', method: 'other', payload: {},
    }), methodMismatch.response)
    expect(JSON.parse(String(methodMismatch.state.body))).toMatchObject({
      rpcId: 'rpc-bad',
      result: { ok: false, error: { code: 'bad-request' } },
    })

    for (const [request, status] of [
      [fakeRequest({ host: 'harness.example' }, '/rpc/goals/create'), 404],
      [fakePost({ host: 'harness.example' }, '/outside/goals/create', {}), 404],
      [fakePost({ host: 'harness.example' }, '/rpc/goals//create', {}), 404],
      [fakeRawPost({ host: 'harness.example' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'text/plain' }, '/rpc/goals/create', '{}'), 415],
      [fakeRawPost({ host: 'harness.example', 'content-type': 'application/json; charset=utf-8' }, '/rpc/goals/create', '{'), 400],
    ] as const) {
      const response = fakeResponse()
      await route.handler(request, response.response)
      expect(response.state.status).toBe(status)
    }

    for (const [body, rpcId] of [
      [{ rpcId: 'retained-id' }, 'retained-id'],
      [{ rpcId: 42 }, 'invalid-request'],
      [null, 'invalid-request'],
    ] as const) {
      const response = fakeResponse()
      await route.handler(fakePost({ host: 'harness.example' }, '/rpc/goals/create', body), response.response)
      expect(JSON.parse(String(response.state.body))).toMatchObject({
        rpcId,
        result: { ok: false, error: { code: 'bad-request' } },
      })
    }

    const failed = fakeResponse()
    await route.handler(fakePost({ host: 'harness.example' }, '/rpc/fail', {
      type: 'client-request', rpcId: 'rpc-fail', method: 'fail', payload: {},
    }), failed.response)
    expect(failed.state).toMatchObject({ status: 500, body: 'handler failure: Error: handler broke' })

    expect(() => connection.rpc.handle('/api', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')
    expect(() => connection.rpc.handle('api3', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })).toThrow('invalid or reserved RPC channel')

    const removeLoopback = connection.rpc.handle('/loopback', async () => ({ ok: true, value: null }), {
      authority: 'loopback',
    })
    const loopbackRoute = routes.find(candidate => candidate.path === '/loopback')!
    const publicResponse = fakeResponse()
    await loopbackRoute.handler(fakePost({ host: 'harness.example' }, '/loopback/read', {
      type: 'client-request', rpcId: 'rpc-public', method: 'read', payload: {},
    }), publicResponse.response)
    expect(publicResponse.state.status).toBe(403)

    const forgedLoopback = fakeResponse()
    await loopbackRoute.handler(fakePost(
      { host: 'localhost:3080' },
      '/loopback/read',
      { type: 'client-request', rpcId: 'rpc-forged-loopback', method: 'read', payload: {} },
      '203.0.113.10',
    ), forgedLoopback.response)
    expect(forgedLoopback.state).toMatchObject({ status: 403, body: 'forbidden' })
    await removeLoopback()
    await remove()
    await fiber.dispose()
  })
})

describe('connection node half over a real HTTP server', () => {
  /** Serve the registered prefix route from a real server and return its port. */
  async function serve(
    routes: WebRoute[],
    upgrades: WebUpgradeRoute[] = [],
  ): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const route = routes.find(candidate => pathname === candidate.path || pathname.startsWith(`${candidate.path}/`))
      if (route === undefined) {
        response.writeHead(404)
        response.end('not found')
      } else {
        void route.handler(request, response)
      }
    })
    server.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '/', 'http://dsh.internal').pathname
      const route = upgrades.find(candidate => candidate.path === pathname)
      if (route === undefined) socket.destroy()
      else void route.handler(request, socket, head)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    return {
      port: address.port,
      close: () => new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve()
          else reject(error)
        })
      }),
    }
  }

  /** One real request; `host` spoofs the authority the way a LAN client's browser would send it. */
  function call(port: number, method: string, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path: `${API_PATH}/${method}`, method: 'GET', headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => { resolve(response.statusCode ?? 0) })
        },
      )
      request.on('error', reject)
      request.end()
    })
  }

  it('answers a declared LAN authority with 403 on every configuration method, over real HTTP', async () => {
    // The fence's input is a real IncomingMessage parsed by Node from the
    // wire, not a hand-assembled object: the Host header a LAN browser sends
    // is exactly what decides loopback-only here, so the boundary is asserted
    // against the parse the server actually performs.
    const { routes, dispose } = await mounted({ trustedHosts: ['harness.example'] })
    const { port, close } = await serve(routes)
    try {
      // Reads are as privileged as writes: describe returns the exposed
      // configuration, and credentials.describe probes arbitrary env-var names.
      for (const method of [
        'settings.describe', 'settings.openDocument', 'settings.update', 'settings.replace', 'settings.mutate',
        'credentials.describe', 'credentials.set', 'credentials.unset',
        'host.pickDirectory', 'host.openPath',
        // Carries a draft credential and turns the host into a fetcher for a
        // URL the caller picked: an anonymous LAN caller must not reach it.
        'llm.discoverModels',
        'agentPreset.read', 'agentPreset.copy', 'agentPreset.openDocument', 'agentPreset.remove',
      ]) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // A trusted authority is only a DNS-rebinding fence, not authentication;
      // without Remote Sync auth even read-only catalog endpoints stay closed.
      for (const method of ['llm.providers', 'llm.models', 'agentPreset.list', 'agentPreset.select']) {
        expect([method, await call(port, method, 'harness.example')]).toEqual([method, 403])
      }
      // Loopback reaches everything, configuration included.
      expect(await call(port, 'settings.describe', `127.0.0.1:${String(port)}`)).toBe(404)
    } finally {
      await close()
      await dispose()
    }
  })

  it('rejects an unauthenticated remote event socket and accepts the bearer subprotocol', async () => {
    const { routes, upgrades, dispose } = await mounted({
      trustedHosts: ['harness.example'], remoteSync: true, remoteSyncJournalCapacity: 8,
    }, remoteSyncApi())
    const snapshotRoute = routes.find(route => route.path === REMOTE_SYNC_RPC_CHANNEL)!
    const snapshotResponse = fakeResponse()
    await snapshotRoute.handler(fakePost(
      { host: 'harness.example', authorization: 'Bearer access' },
      `${REMOTE_SYNC_RPC_CHANNEL}/snapshot`,
      { type: 'client-request', rpcId: 'rpc-ws-snapshot', method: 'snapshot', payload: {} },
    ), snapshotResponse.response)
    const snapshotEnvelope = JSON.parse(String(snapshotResponse.state.body)) as {
      result: { value: { deploymentId: string; cursor: { sequence: number } } }
    }
    const { port, close } = await serve(routes, upgrades)
    const url = new URL(`ws://127.0.0.1:${String(port)}${REMOTE_SYNC_EVENTS_PATH}`)
    url.searchParams.set('deploymentId', snapshotEnvelope.result.value.deploymentId)
    url.searchParams.set('since', String(snapshotEnvelope.result.value.cursor.sequence))
    try {
      const deniedStatus = await new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(url, ['dsh-remote-sync-v1'], { headers: { host: 'harness.example' } })
        socket.once('open', () => { reject(new Error('unauthenticated event socket opened')) })
        socket.once('unexpected-response', (_request, response) => {
          response.resume()
          resolve(response.statusCode ?? 0)
        })
        socket.once('error', () => {})
      })
      expect(deniedStatus).toBe(403)

      const accepted = new WebSocket(url, [
        'dsh-remote-sync-v1', 'dsh-bearer.access',
      ], { headers: { host: 'harness.example' } })
      await once(accepted, 'open')
      expect(accepted.protocol).toBe('dsh-remote-sync-v1')
      accepted.close()
      await once(accepted, 'close')
    } finally {
      await close()
      await dispose()
    }
  })
})
