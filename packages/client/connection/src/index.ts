/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingHttpHeaders } from 'node:http'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ResidentExecuteRequest } from '@deepseek-ai/dsh-resident-operator'
import type {
  OrchestrationClusterHeartbeatRequest,
  OrchestrationClusterInstallRequest,
  OrchestrationClusterReplicaV1,
  OrchestrationClusterVoteRequest,
} from '@deepseek-ai/dsh-orchestration'
import { SessionReplicationError, type SessionReplica } from '@deepseek-ai/dsh-session-persistence'
import {
  RemoteAuthError,
  type RemoteAuthService,
  type RemoteDeviceScope,
  type RemotePrincipal,
} from '@deepseek-ai/dsh-host-remote-auth'
// Activates the webServer Context merge used below.
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { assertTrustedAuthority, isLoopbackApiRequest, isTrustedApiRequest } from './api-request-trust.ts'
import { ConnectionRpcHttpError, HostConnectionService } from './rpc-host.ts'
import type { ConnectionRpcRequestContext } from './rpc.ts'
import { REMOTE_AUTH_RPC_CHANNEL } from './remote-auth-wire.ts'
import { RemoteSyncHub } from './remote-sync-host.ts'
import {
  canonicalRemoteRepositoryIdentity,
  REMOTE_SYNC_COMPATIBLE_MINOR, REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_PROTOCOL, REMOTE_SYNC_RPC_CHANNEL,
  type RemoteResidentExecuteRequest,
  type RemoteSyncProtocolVersion,
  type RemoteWorkspaceIdentityV1,
} from './remote-sync.ts'
import { rejectWebSocketUpgrade, WebSocketDownlinks } from './websocket-downlink.ts'

export type {
  ConnectionRpcAuthority,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcHandler,
  ConnectionRpcHandlerOptions,
  ConnectionRpcRequestContext,
  HostConnectionHandle,
  HostConnectionRpc,
} from './rpc.ts'
export { HostConnectionService } from './rpc-host.ts'
export { REMOTE_AUTH_RPC_CHANNEL } from './remote-auth-wire.ts'
export { RemoteOperatorHostService } from './remote-operator-host.ts'
export type { RemoteMaterializedWorkspaceV1, RemoteOperatorHostQualification } from './remote-operator-host.ts'
export type {
  RemoteAccessSession, RemoteDeviceCredential, RemoteDeviceScope,
  RemotePairingChallenge,
} from './remote-auth-wire.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
export {
  REMOTE_SYNC_COMPATIBLE_MINOR, REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_PROTOCOL, REMOTE_SYNC_RPC_CHANNEL,
  bindRemoteResidentProtocol, canonicalRemoteRepositoryIdentity, RemoteResidentProtocolClient,
  parseRemoteResidentAcceptedTurn, parseRemoteResidentArtifact, parseRemoteResidentEventPage,
  parseRemoteResidentProviders, parseRemoteResidentResult, parseRemoteResidentTurn,
  parseRemoteSessionReplicaApplyResult, parseRemoteSessionReplicaDocument, parseRemoteSessionReplicaList,
  parseRemoteSyncCursor, parseRemoteSyncDescription, parseRemoteSyncFrame, parseRemoteSyncSnapshot,
} from './remote-sync.ts'
export type {
  RemoteResidentAcceptedTurn, RemoteResidentArtifactDocument, RemoteResidentEventPage, RemoteResidentExecuteRequest,
  RemoteResidentModelOption, RemoteResidentProviderStatus, RemoteResidentQuotaPool,
  RemoteResidentProtocolBindings, RemoteResidentQuotaWindow, RemoteResidentReasoningEffort, RemoteResidentTurnSnapshot,
  RemoteSessionReplicaApplyResult, RemoteSessionReplicaDocument, RemoteSessionReplicaSummary,
  RemoteSyncCapability, RemoteSyncClusterProjection, RemoteSyncCursor, RemoteSyncDescription, RemoteSyncEvent, RemoteSyncFrame,
  RemoteSyncProtocolVersion, RemoteSyncResyncRequired, RemoteSyncSnapshot, RemoteWorkspaceIdentityV1,
} from './remote-sync.ts'

/** Stable Cordis plugin name. */
export const name = 'client-connection'

/** Headroom for RPC JSON fields around aggregate base64 image payloads. */
const REQUEST_ENVELOPE_HEADROOM_BYTES = 1024 * 1024

function assertImageBodyCapacity(ctx: Context, maxRequestBodyBytes: number): void {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return
  const requiredImageBodyBytes = Math.ceil(
    attachments.imageLimits.maxMessageImageBytes * 4 / 3,
  ) + REQUEST_ENVELOPE_HEADROOM_BYTES
  if (maxRequestBodyBytes < requiredImageBodyBytes) {
    throw new Error(
      `client-connection maxRequestBodyBytes (${String(maxRequestBodyBytes)}) must be at least `
      + `${String(requiredImageBodyBytes)} for the configured aggregate image limit`,
    )
  }
}

/** Services required before providing Connection; API Proxy is an optional `/api` fallback. */
export const inject = ['webServer']

/** Plugin config: the deployment's non-loopback serving authorities. */
export interface ConnectionConfig {
  /**
   * Authorities this deployment serves beyond loopback: exact `host:port`, or
   * port-less `host` matching any port. The /api trust fence refuses any
   * request whose Host is neither loopback nor listed here, so a
   * non-loopback (`0.0.0.0`) deployment must declare the names it is reached
   * by (the dsh CLI derives the machine's LAN IP literals itself). An entry
   * that is not a bare, canonical authority fails the plugin load.
   */
  trustedHosts?: string[]
  /** Maximum buffered JSON body for every `/api` request. */
  maxRequestBodyBytes?: number
  /** Enable the independently versioned snapshot + cursor Server projection. */
  remoteSync?: boolean
  /** Retained event count and per-Frontend unsent-frame bound. */
  remoteSyncJournalCapacity?: number
}

export const Config: z<ConnectionConfig> = z.object({
  trustedHosts: z.array(String).default([]),
  maxRequestBodyBytes: z.natural().min(1).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
  remoteSync: z.boolean().default(false),
  remoteSyncJournalCapacity: z.natural().min(1).default(4096),
})

/**
 * Methods gated to loopback even on a trusted-host deployment. Native dialogs
 * act on the host machine; the settings and credential domains mutate the
 * user's configuration and secret store, and READING them is equally
 * privileged — `settings.describe` returns every exposed namespace's
 * configuration and `credentials.describe` reports whether an arbitrary
 * environment-variable name is configured and where from, which is
 * reconnaissance no anonymous caller should have. `trustedHosts` is a
 * DNS-rebinding fence, explicitly not authentication, so the whole
 * configuration plane stays loopback-same-origin until a real authentication
 * layer exists. `llm.discoverModels` belongs to that plane on both counts: it
 * carries a draft credential, and it makes the HOST issue a GET to a URL the
 * caller chose and reports back the status or the parsed body — an anonymous
 * LAN caller would have a probe for whatever the host can reach and the
 * browser cannot.
 *
 * The model catalog (`llm.providers`, `llm.models`) is deliberately NOT here:
 * it carries provider ids, display names, and model lists — no endpoints,
 * keys, or key state — and a LAN client's model picker legitimately needs it.
 */
const PRIVILEGED_METHODS = new Set([
  // A preset composition names the plugins a session runs, so reading one is
  // reconnaissance; copy and remove rearrange what the deployment offers, and
  // openDocument drives the host desktop — all more than the roster beside
  // them. (Authoring is copy-only, so no method here accepts composition text
  // or a path; the pin is about who may manage the roster at all.)
  //
  // CHOOSING one is not pinned, and `agentPreset.list` is not either. Picking a
  // preset looks like escalation — one of them mounts the toolset that edits the
  // live runtime — but `session.create` already takes an `agentPreset`, so
  // pinning only the switch would leave the same capability one method over.
  // The deeper reason is that the capability is not the preset's to grant: the
  // deployment's own default already carries `bash` and the filesystem tools, so
  // any caller that may start a session at all can already run commands as this
  // process. Pinning the switch would be a fence beside an open gate.
  'agentPreset.read',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
  'host.pickDirectory',
  'host.openPath',
  'settings.describe',
  'settings.openDocument',
  'settings.update',
  'settings.replace',
  'settings.mutate',
  'credentials.describe',
  'credentials.set',
  'credentials.unset',
  'llm.discoverModels',
])

/** Read surface temporarily exposed to authenticated Frontends before the command seam lands. */
const REMOTE_READ_METHODS = new Set([
  'session.list',
  'session.search',
  'session.history',
  'session.models',
  'session.attachment',
  'subagent.list',
  'subagent.history',
  'host.describe',
  'workspace.list',
  'skill.list',
  'agentPreset.list',
  'llm.providers',
  'llm.models',
])

/** Desktop cockpit reads needed to render configuration without granting mutation. */
const REMOTE_COCKPIT_READ_METHODS = new Set([
  'host.listDirectory',
  'agentPreset.read',
  'settings.describe',
  'credentials.describe',
])

/** Authenticated cockpit commands whose response is protected by a durable receipt. */
const REMOTE_COCKPIT_COMMAND_METHODS = new Set([
  'session.create',
  'session.selectModel',
  'session.rename',
  'session.fork',
  'session.prompt',
  'session.updateQueue',
  'session.cancel',
  'subagent.prompt',
  'subagent.interrupt',
  'agentPreset.select',
  'workspace.create',
  'workspace.rename',
  'workspace.insertBefore',
  'workspace.insertSessionBefore',
  'workspace.archiveSession',
  'goal.create',
  'goal.edit',
  'goal.pause',
  'goal.resume',
  'goal.complete',
  'goal.clear',
])

/** Pocket is an observation/approval face, not a general execution client. */
const REMOTE_POCKET_COMMAND_METHODS = new Set(['respond'])

/**
 * Mounts the API gateway under the browser transport prefix. Every request on
 * the prefix passes the browser-trust fence first (DNS-rebinding and
 * cross-site defense — [api-request-trust](./api-request-trust.ts));
 * privileged methods additionally pass it with an empty trust list, which
 * pins them to loopback.
 * @param ctx - Host plugin context.
 * @param config - resolved plugin config (schema defaults applied).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  // The Loader resolves schema defaults; hand-built test contexts may pass none.
  const trustedHosts = config?.trustedHosts ?? []
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const remoteSync = config?.remoteSync ?? false
  const remoteSyncJournalCapacity = config?.remoteSyncJournalCapacity ?? 4096
  // Config boundary: a malformed entry fails the load loudly here rather than
  // silently authorizing its hostname prefix at request time.
  for (const entry of trustedHosts) assertTrustedAuthority(entry)
  if (ctx.get('apiProxy') !== undefined) assertImageBodyCapacity(ctx, maxRequestBodyBytes)
  const connection = new HostConnectionService(ctx, trustedHosts)
  const fetchHandler = connection.createSharedFetchHandler(API_PATH, {
    async fetch(request, transport) {
      const pathname = new URL(request.url).pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined
      let remoteAccessScope: RemoteDeviceScope | undefined
      let remotePrincipal: RemotePrincipal | undefined
      let remoteCommand = false
      if (!isLoopbackApiRequest(request, transport.remoteAddress)) {
        if (!remoteSync) return new Response('forbidden', { status: 403 })
        const auth = ctx.get('remoteAuth')
        if (auth === undefined) return new Response('remote authentication unavailable', { status: 503 })
        let access: RemotePrincipal
        try {
          access = requireRemoteAccess(auth, { request, ...transport }, ['cockpit', 'pocket', 'admin'])
        } catch (error) {
          if (error instanceof ConnectionRpcHttpError) {
            return new Response(error.message, { status: error.status })
          }
          throw error
        }
        const cockpitRead = access.scope !== 'pocket'
          && method !== undefined
          && REMOTE_COCKPIT_READ_METHODS.has(method)
        remoteCommand = method !== undefined && (
          (access.scope !== 'pocket' && REMOTE_COCKPIT_COMMAND_METHODS.has(method))
          || REMOTE_POCKET_COMMAND_METHODS.has(method)
        )
        if (method === undefined || (!REMOTE_READ_METHODS.has(method) && !cockpitRead && !remoteCommand)) {
          return new Response('remote command endpoint is not available', { status: 403 })
        }
        remoteAccessScope = access.scope
        remotePrincipal = access
      }
      if (method !== undefined
        && PRIVILEGED_METHODS.has(method)
        && !isLoopbackApiRequest(request, transport.remoteAddress)
        && !(remoteAccessScope !== undefined
          && remoteAccessScope !== 'pocket'
          && REMOTE_COCKPIT_READ_METHODS.has(method))) {
        return new Response('forbidden', { status: 403 })
      }
      if (request.method === 'GET' && (pathname === MUX_EVENTS_PATH || pathname === HOST_EVENTS_PATH)) {
        return new Response('upgrade required', {
          status: 426,
          headers: { connection: 'Upgrade', upgrade: 'websocket' },
        })
      }
      const apiProxy = ctx.get('apiProxy')
      if (apiProxy === undefined) return new Response('not found', { status: 404 })
      const invoke = (): Promise<Response> => toFetchHandler(apiProxy).fetch(request)
      return remoteCommand && remotePrincipal !== undefined
        ? authenticatedRemoteCommand(ctx.remoteAuth, remotePrincipal, request, invoke)
        : invoke()
    },
  })
  const route: WebRoute = {
    kind: 'prefix',
    path: API_PATH,
    handler: async (req, res) => {
      if (!isTrustedApiRequest(req, trustedHosts)) {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      if (!isLoopbackApiRequest(req, req.socket.remoteAddress)) {
        if (!remoteSync) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
        const auth = ctx.get('remoteAuth')
        if (auth === undefined) {
          res.writeHead(503)
          res.end('remote authentication unavailable')
          return
        }
        const authorization = requestHeader(req, 'authorization')
        const token = authorization?.startsWith('Bearer ')
          ? authorization.slice('Bearer '.length)
          : undefined
        const access = token === undefined ? undefined : auth.authenticate(token)
        if (access === undefined) {
          res.writeHead(401)
          res.end('unauthorized')
          return
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith(`${API_PATH}/`)
          ? pathname.slice(API_PATH.length + 1)
          : undefined
        if (access.scope === 'pocket'
          && (method === undefined
            || (!REMOTE_READ_METHODS.has(method) && !REMOTE_POCKET_COMMAND_METHODS.has(method)))) {
          res.writeHead(403)
          res.end('forbidden')
          return
        }
      }
      await bridge(req, res, fetchHandler, maxRequestBodyBytes)
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'client-connection: /api route')
  ctx.inject(['apiProxy'], (apiCtx) => {
    assertImageBodyCapacity(apiCtx, maxRequestBodyBytes)
    const downlinks = new WebSocketDownlinks(apiCtx.apiProxy)
    const registerDownlink = (
      path: string,
      handle: WebUpgradeRoute['handler'],
    ): void => {
      apiCtx.effect(() => apiCtx.webServer.registerUpgrade({
        path,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            rejectWebSocketUpgrade(socket)
            return
          }
          if (!isLoopbackApiRequest(req, req.socket.remoteAddress)) {
            if (!remoteSync) {
              rejectWebSocketUpgrade(socket)
              return
            }
            const auth = apiCtx.get('remoteAuth')
            if (auth === undefined || !hasRemoteAccess(auth, req, ['cockpit', 'pocket', 'admin'])) {
              rejectWebSocketUpgrade(socket)
              return
            }
          }
          return handle(req, socket, head)
        },
      }), `client-connection: ${path} WebSocket`)
    }
    apiCtx.effect(() => () => downlinks.close(), 'client-connection: WebSocket downlinks')
    registerDownlink(MUX_EVENTS_PATH, (req, socket, head) => { downlinks.handleMux(req, socket, head) })
    registerDownlink(HOST_EVENTS_PATH, (req, socket, head) => { downlinks.handleHost(req, socket, head) })
    if (remoteSync) apiCtx.inject(['remoteAuth'], (authCtx) => {
      const hub = new RemoteSyncHub(
        authCtx.apiProxy,
        remoteSyncJournalCapacity,
        authCtx.get('sessionPersistence'),
        authCtx.get('residentOperators'),
        () => authCtx.get('orchestrations'),
        () => authCtx.get('remoteOperatorHost'),
      )
      const removeAuthRpc = connection.rpc.handle(
        REMOTE_AUTH_RPC_CHANNEL,
        async (endpoint, payload, _signal, requestContext) => remoteAuthCall(
          authCtx.remoteAuth,
          endpoint,
          payload,
          requestContext,
        ),
        { authority: 'trusted-host' },
      )
      const removeSyncRpc = connection.rpc.handle(
        REMOTE_SYNC_RPC_CHANNEL,
        async (endpoint, payload, signal, requestContext) => {
          const access = requireRemoteAccess(
            authCtx.remoteAuth,
            requestContext,
            ['cockpit', 'pocket', 'admin'],
          )
          if (endpoint === 'describe') {
            return { ok: true, value: await hub.describe(signal, access.scope, requestedRemoteSyncProtocol(payload)) }
          }
          if (endpoint === 'snapshot') {
            return { ok: true, value: await hub.snapshot(signal, requestedRemoteSyncProtocol(payload)) }
          }
          if (endpoint === 'replica.list') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            return { ok: true, value: await hub.replicaList(signal) }
          }
          if (endpoint === 'replica.read') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            return { ok: true, value: await hub.replicaRead(requiredString(body.sessionId, 'sessionId'), signal) }
          }
          if (endpoint === 'replica.apply') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            const events = body.events
            if (!Array.isArray(events)) throw new ConnectionRpcHttpError(400, 'events must be an array')
            try {
              return {
                ok: true,
                value: await hub.replicaApply({ meta: body.meta, events } as SessionReplica, signal),
              }
            } catch (error) {
              if (!(error instanceof SessionReplicationError)) throw error
              return {
                ok: false,
                error: {
                  code: 'internal' as const,
                  message: `${error.code}: ${error.message}`,
                  details: {},
                },
              }
            }
          }
          if (endpoint === 'operator.providers') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            return { ok: true, value: await hub.operatorProviders() }
          }
          if (endpoint === 'operator.execute') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            requireCurrentRemoteSyncProtocol(body.protocol)
            if (!Array.isArray(body.prompt)) throw new ConnectionRpcHttpError(400, 'prompt must be an array')
            if (body.modelToolBridge !== undefined) {
              throw new ConnectionRpcHttpError(400, 'remote model-tool bridges are not supported')
            }
            const profile = body.profile === undefined ? undefined : residentProfile(body.profile)
            const request: RemoteResidentExecuteRequest = {
              commandId: requiredString(body.commandId, 'commandId'),
              operatorId: requiredString(body.operatorId, 'operatorId'),
              workspaceIdentity: remoteWorkspaceIdentity(body.workspaceIdentity),
              laneId: requiredString(body.laneId, 'laneId'),
              prompt: body.prompt as ContentBlock[],
              ...(typeof body.taskLabel === 'string' ? { taskLabel: body.taskLabel } : {}),
              ...(typeof body.systemPrompt === 'string' ? { systemPrompt: body.systemPrompt } : {}),
              ...profile === undefined ? {} : { profile },
              ...body.nativeToolPolicy === undefined
                ? {}
                : { nativeToolPolicy: residentNativeToolPolicy(body.nativeToolPolicy) },
            }
            return { ok: true, value: await hub.operatorExecute(request) }
          }
          if (endpoint === 'operator.inspect') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            return { ok: true, value: await hub.operatorInspectTurn(requiredString(body.turnId, 'turnId')) }
          }
          if (endpoint === 'operator.events') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            return {
              ok: true,
              value: await hub.operatorReadEvents(
                requiredString(body.sessionId, 'sessionId'),
                boundedInteger(body.afterSequence, 'afterSequence', 0, Number.MAX_SAFE_INTEGER),
                boundedInteger(body.limit, 'limit', 1, 500),
                signal,
              ),
            }
          }
          if (endpoint === 'operator.artifact.read') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            requireCurrentRemoteSyncProtocol(body.protocol)
            return { ok: true, value: await hub.operatorReadArtifact(requiredString(body.ref, 'ref'), signal) }
          }
          if (endpoint === 'operator.interrupt') {
            if (access.scope === 'pocket') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            await hub.operatorInterrupt(
              requiredString(body.sessionId, 'sessionId'),
              requiredString(body.turnId, 'turnId'),
            )
            return { ok: true, value: { interrupted: true } }
          }
          if (endpoint === 'cluster.status') {
            if (access.scope !== 'admin') throw new ConnectionRpcHttpError(403, 'forbidden')
            return { ok: true, value: await hub.clusterStatus() }
          }
          if (endpoint === 'cluster.vote') {
            if (access.scope !== 'admin') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            const request: OrchestrationClusterVoteRequest = {
              term: boundedInteger(body.term, 'term', 1, Number.MAX_SAFE_INTEGER),
              candidateId: requiredString(body.candidateId, 'candidateId'),
              commitIndex: boundedInteger(body.commitIndex, 'commitIndex', 0, Number.MAX_SAFE_INTEGER),
            }
            return { ok: true, value: await hub.clusterRequestVote(request) }
          }
          if (endpoint === 'cluster.heartbeat') {
            if (access.scope !== 'admin') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            const request: OrchestrationClusterHeartbeatRequest = {
              term: boundedInteger(body.term, 'term', 1, Number.MAX_SAFE_INTEGER),
              leaderId: requiredString(body.leaderId, 'leaderId'),
              commitIndex: boundedInteger(body.commitIndex, 'commitIndex', 0, Number.MAX_SAFE_INTEGER),
              leaseUntil: boundedInteger(body.leaseUntil, 'leaseUntil', 1, Number.MAX_SAFE_INTEGER),
            }
            return { ok: true, value: await hub.clusterHeartbeat(request) }
          }
          if (endpoint === 'cluster.export') {
            if (access.scope !== 'admin') throw new ConnectionRpcHttpError(403, 'forbidden')
            return { ok: true, value: await hub.clusterExportReplica() }
          }
          if (endpoint === 'cluster.install') {
            if (access.scope !== 'admin') throw new ConnectionRpcHttpError(403, 'forbidden')
            const body = recordPayload(payload)
            recordPayload(body.replica)
            const request: OrchestrationClusterInstallRequest = {
              term: boundedInteger(body.term, 'term', 1, Number.MAX_SAFE_INTEGER),
              leaderId: requiredString(body.leaderId, 'leaderId'),
              replica: body.replica as OrchestrationClusterReplicaV1,
            }
            return { ok: true, value: await hub.clusterInstallReplica(request) }
          }
          return {
            ok: false,
            error: {
              code: 'bad-request',
              message: `unknown remote sync method ${JSON.stringify(endpoint)}`,
              details: { issues: [] },
            },
          }
        },
        { authority: 'trusted-host' },
      )
      const removeUpgrade = authCtx.webServer.registerUpgrade({
        path: REMOTE_SYNC_EVENTS_PATH,
        handler: (req, socket, head) => {
          if (!isTrustedApiRequest(req, trustedHosts)
            || !hasRemoteAccess(authCtx.remoteAuth, req, ['cockpit', 'pocket', 'admin'])) {
            rejectWebSocketUpgrade(socket)
            return
          }
          hub.handleEvents(req, socket, head)
        },
      })
      authCtx.effect(() => async () => {
        removeUpgrade()
        await removeSyncRpc()
        await removeAuthRpc()
        await hub.close()
      }, 'client-connection: authenticated remote sync')
    })
  })
}

async function remoteAuthCall(
  auth: RemoteAuthService,
  endpoint: string,
  payload: unknown,
  requestContext: ConnectionRpcRequestContext,
): Promise<{ ok: true; value: unknown }> {
  const { request } = requestContext
  const body = recordPayload(payload)
  switch (endpoint) {
    case 'pairing.issue': {
      if (!isLoopbackApiRequest(request, requestContext.remoteAddress)) {
        throw new ConnectionRpcHttpError(403, 'forbidden')
      }
      return { ok: true, value: auth.issuePairing(remoteScope(body.scope)) }
    }
    case 'pairing.redeem':
      try {
        return {
          ok: true,
          value: await auth.redeemPairing(
            requiredString(body.code, 'code'),
            requiredString(body.deviceName, 'deviceName'),
          ),
        }
      } catch (error) {
        throw remoteAuthHttpError(error)
      }
    case 'session.exchange':
      try {
        return { ok: true, value: auth.exchange(requiredString(body.credential, 'credential')) }
      } catch (error) {
        throw remoteAuthHttpError(error)
      }
    case 'device.list':
      requireRemoteAccess(auth, requestContext, ['admin'])
      return { ok: true, value: { devices: auth.listDevices() } }
    case 'device.revoke':
      requireRemoteAccess(auth, requestContext, ['admin'])
      try {
        await auth.revoke(requiredString(body.deviceId, 'deviceId'))
      } catch (error) {
        throw remoteAuthHttpError(error)
      }
      return { ok: true, value: { revoked: true } }
    default:
      throw new ConnectionRpcHttpError(400, `unknown remote auth method ${JSON.stringify(endpoint)}`)
  }
}

function requireRemoteAccess(
  auth: RemoteAuthService,
  requestContext: ConnectionRpcRequestContext,
  scopes: readonly RemoteDeviceScope[],
): RemotePrincipal {
  const { request } = requestContext
  if (isLoopbackApiRequest(request, requestContext.remoteAddress)) {
    return { deviceId: 'loopback', deviceName: 'Loopback', scope: 'admin' }
  }
  const authorization = requestHeader(request, 'authorization')
  const token = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
  const principal = token === undefined ? undefined : auth.authenticate(token)
  if (principal === undefined) throw new ConnectionRpcHttpError(401, 'unauthorized')
  if (!scopes.includes(principal.scope)) throw new ConnectionRpcHttpError(403, 'forbidden')
  return principal
}

async function authenticatedRemoteCommand(
  auth: RemoteAuthService,
  principal: RemotePrincipal,
  request: Request,
  invoke: () => Promise<Response>,
): Promise<Response> {
  const raw = await request.clone().text()
  let commandId: string | undefined
  try {
    const envelope: unknown = JSON.parse(raw)
    if (typeof envelope === 'object' && envelope !== null && !Array.isArray(envelope)) {
      const candidate = (envelope as { rpcId?: unknown }).rpcId
      if (typeof candidate === 'string' && candidate.length > 0) commandId = candidate
    }
  } catch {
    // The downstream carrier owns the normal malformed-JSON response.
  }
  if (commandId === undefined) return invoke()
  const requestHash = createHash('sha256').update(raw).digest('hex')
  const receipt = await auth.beginCommand(principal.deviceId, commandId, requestHash)
  if (receipt.kind === 'settled') return commandResponse(receipt.response)
  if (receipt.kind !== 'accepted') {
    const message = receipt.kind === 'conflict'
      ? 'remote command id conflicts with a different request'
      : receipt.kind === 'running'
        ? 'remote command is still running'
        : 'remote command outcome is indeterminate'
    return new Response(message, { status: 409 })
  }
  try {
    const response = await invoke()
    const body = await response.clone().text()
    await auth.settleCommand(principal.deviceId, commandId, requestHash, {
      status: response.status,
      ...(response.headers.get('content-type') === null
        ? {}
        : { contentType: response.headers.get('content-type') as string }),
      body,
    })
    return response
  } catch (error) {
    await auth.markCommandIndeterminate(principal.deviceId, commandId, requestHash)
    throw error
  }
}

function commandResponse(response: {
  readonly status: number
  readonly contentType?: string
  readonly body: string
}): Response {
  return new Response(response.body, {
    status: response.status,
    ...(response.contentType === undefined ? {} : { headers: { 'content-type': response.contentType } }),
  })
}

function hasRemoteAccess(
  auth: RemoteAuthService,
  request: RemoteAuthRequest,
  scopes: readonly RemoteDeviceScope[],
): boolean {
  if (isLoopbackApiRequest(request, request.socket.remoteAddress)) return true
  const bearer = requestHeader(request, 'authorization')
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
    const principal = auth.authenticate(bearer.slice('Bearer '.length))
    if (principal !== undefined && scopes.includes(principal.scope)) return true
  }
  const rawProtocols = requestHeader(request, 'sec-websocket-protocol')
  const protocols = (rawProtocols ?? '')
    .split(',').map(value => value.trim())
  const encoded = protocols.find(value => value.startsWith('dsh-bearer.'))
  const principal = encoded === undefined ? undefined : auth.authenticate(encoded.slice('dsh-bearer.'.length))
  return principal !== undefined && scopes.includes(principal.scope)
}

interface HeaderRequest {
  readonly headers: Headers | IncomingHttpHeaders
}

interface RemoteAuthRequest extends HeaderRequest {
  readonly socket: { readonly remoteAddress: string | undefined }
}

function requestHeader(request: HeaderRequest, name: string): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(name) ?? undefined
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function remoteAuthHttpError(error: unknown): Error {
  if (!(error instanceof RemoteAuthError)) return error instanceof Error ? error : new Error(String(error))
  switch (error.code) {
    case 'CREDENTIAL_INVALID':
      return new ConnectionRpcHttpError(401, 'unauthorized')
    case 'PAIRING_INVALID':
    case 'PAIRING_EXPIRED':
      return new ConnectionRpcHttpError(400, error.message)
    case 'DEVICE_LIMIT_REACHED':
      return new ConnectionRpcHttpError(409, error.message)
    case 'DEVICE_NOT_FOUND':
      return new ConnectionRpcHttpError(404, error.message)
  }
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConnectionRpcHttpError(400, 'request payload must be an object')
  }
  return value as Record<string, unknown>
}

function requestedRemoteSyncProtocol(value: unknown): RemoteSyncProtocolVersion {
  const payload = recordPayload(value)
  if (payload.protocol === undefined) {
    return { major: REMOTE_SYNC_PROTOCOL.major, minor: REMOTE_SYNC_COMPATIBLE_MINOR }
  }
  const protocol = recordPayload(payload.protocol)
  if (protocol.major !== REMOTE_SYNC_PROTOCOL.major
    || (protocol.minor !== REMOTE_SYNC_COMPATIBLE_MINOR && protocol.minor !== REMOTE_SYNC_PROTOCOL.minor)) {
    throw new ConnectionRpcHttpError(409, 'remote sync protocol mismatch')
  }
  return { major: REMOTE_SYNC_PROTOCOL.major, minor: protocol.minor }
}

function requireCurrentRemoteSyncProtocol(value: unknown): void {
  const protocol = value === undefined
    ? { major: REMOTE_SYNC_PROTOCOL.major, minor: REMOTE_SYNC_COMPATIBLE_MINOR }
    : recordPayload(value)
  if (protocol.major !== REMOTE_SYNC_PROTOCOL.major || protocol.minor !== REMOTE_SYNC_PROTOCOL.minor) {
    throw new ConnectionRpcHttpError(409, 'remote operator execution requires remote sync protocol 1.4')
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectionRpcHttpError(400, `${field} must be a non-empty string`)
  }
  return value
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConnectionRpcHttpError(400, `${field} must be an integer from ${String(minimum)} to ${String(maximum)}`)
  }
  return value
}

function residentProfile(value: unknown): NonNullable<ResidentExecuteRequest['profile']> {
  const record = recordPayload(value)
  const model = requiredString(record.model, 'profile.model')
  const effort = record.effort
  if (effort !== undefined && effort !== 'low' && effort !== 'medium' && effort !== 'high'
    && effort !== 'xhigh' && effort !== 'max' && effort !== 'ultra') {
    throw new ConnectionRpcHttpError(400, 'profile.effort is invalid')
  }
  return { model, ...effort === undefined ? {} : { effort } }
}

function residentNativeToolPolicy(value: unknown): 'inherit' | 'disabled' {
  if (value !== 'inherit' && value !== 'disabled') {
    throw new ConnectionRpcHttpError(400, 'nativeToolPolicy must be inherit or disabled')
  }
  return value
}

function remoteWorkspaceIdentity(value: unknown): RemoteWorkspaceIdentityV1 {
  const record = recordPayload(value)
  if (record.version !== 1) throw new ConnectionRpcHttpError(400, 'workspaceIdentity.version must be 1')
  const commit = requiredString(record.commit, 'workspaceIdentity.commit')
  if (!/^[a-f0-9]{40}$/u.test(commit)) {
    throw new ConnectionRpcHttpError(400, 'workspaceIdentity.commit must be a lowercase full Git SHA')
  }
  const subdir = record.subdir === undefined ? undefined : requiredString(record.subdir, 'workspaceIdentity.subdir')
  if (subdir !== undefined && (subdir.startsWith('/') || subdir.split('/').some(segment => segment === '' || segment === '.' || segment === '..'))) {
    throw new ConnectionRpcHttpError(400, 'workspaceIdentity.subdir must be a normalized repository-relative path')
  }
  let repository: string
  try {
    repository = canonicalRemoteRepositoryIdentity(requiredString(record.repository, 'workspaceIdentity.repository'))
  } catch (cause) {
    throw new ConnectionRpcHttpError(400, cause instanceof Error ? cause.message : String(cause))
  }
  return {
    version: 1,
    repository,
    commit,
    ...subdir === undefined ? {} : { subdir },
  }
}

function remoteScope(value: unknown): RemoteDeviceScope {
  if (value === 'cockpit' || value === 'pocket' || value === 'admin') return value
  throw new ConnectionRpcHttpError(400, 'scope must be cockpit, pocket, or admin')
}
