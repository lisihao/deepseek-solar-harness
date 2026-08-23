/** Host HTTP bridge for browser-client RPC. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingHttpHeaders } from 'node:http'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
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
import { assertTrustedAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { ConnectionRpcHttpError, HostConnectionService } from './rpc-host.ts'
import { REMOTE_AUTH_RPC_CHANNEL } from './remote-auth-wire.ts'
import { RemoteSyncHub } from './remote-sync-host.ts'
import { REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_RPC_CHANNEL } from './remote-sync.ts'
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
export type {
  RemoteAccessSession, RemoteDeviceCredential, RemoteDeviceScope,
  RemotePairingChallenge,
} from './remote-auth-wire.ts'

export { API_PATH, HOST_EVENTS_PATH, MUX_EVENTS_PATH } from './api-path.ts'
export {
  REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_PROTOCOL, REMOTE_SYNC_RPC_CHANNEL,
  parseRemoteSyncCursor, parseRemoteSyncDescription, parseRemoteSyncFrame, parseRemoteSyncSnapshot,
} from './remote-sync.ts'
export type {
  RemoteSyncCapability, RemoteSyncCursor, RemoteSyncDescription, RemoteSyncEvent, RemoteSyncFrame,
  RemoteSyncResyncRequired, RemoteSyncSnapshot,
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
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const method = pathname.startsWith(`${API_PATH}/`)
        ? pathname.slice(API_PATH.length + 1)
        : undefined
      let remoteAccessScope: RemoteDeviceScope | undefined
      let remotePrincipal: RemotePrincipal | undefined
      let remoteCommand = false
      if (remoteSync && !isTrustedApiRequest(request, [])) {
        const auth = ctx.get('remoteAuth')
        if (auth === undefined) return new Response('remote authentication unavailable', { status: 503 })
        let access: RemotePrincipal
        try {
          access = requireRemoteAccess(auth, request, ['cockpit', 'pocket', 'admin'])
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
        && !isTrustedApiRequest(request, [])
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
          if (remoteSync && !isTrustedApiRequest(req, [])) {
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
      const hub = new RemoteSyncHub(authCtx.apiProxy, remoteSyncJournalCapacity)
      const removeAuthRpc = connection.rpc.handle(
        REMOTE_AUTH_RPC_CHANNEL,
        async (endpoint, payload, _signal, requestContext) => remoteAuthCall(
          authCtx.remoteAuth,
          endpoint,
          payload,
          requestContext.request,
        ),
        { authority: 'trusted-host' },
      )
      const removeSyncRpc = connection.rpc.handle(
        REMOTE_SYNC_RPC_CHANNEL,
        async (endpoint, _payload, signal, requestContext) => {
          const access = requireRemoteAccess(
            authCtx.remoteAuth,
            requestContext.request,
            ['cockpit', 'pocket', 'admin'],
          )
          if (endpoint === 'describe') return { ok: true, value: await hub.describe(signal, access.scope) }
          if (endpoint === 'snapshot') return { ok: true, value: await hub.snapshot(signal) }
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
  request: Request,
): Promise<{ ok: true; value: unknown }> {
  const body = recordPayload(payload)
  switch (endpoint) {
    case 'pairing.issue': {
      if (!isTrustedApiRequest(request, [])) throw new ConnectionRpcHttpError(403, 'forbidden')
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
      requireRemoteAccess(auth, request, ['admin'])
      return { ok: true, value: { devices: auth.listDevices() } }
    case 'device.revoke':
      requireRemoteAccess(auth, request, ['admin'])
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
  request: RemoteAuthRequest,
  scopes: readonly RemoteDeviceScope[],
): RemotePrincipal {
  if (isTrustedApiRequest(request, [])) {
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
  if (isTrustedApiRequest(request, [])) return true
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

interface RemoteAuthRequest {
  readonly headers: Headers | IncomingHttpHeaders
}

function requestHeader(request: RemoteAuthRequest, name: string): string | undefined {
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConnectionRpcHttpError(400, `${field} must be a non-empty string`)
  }
  return value
}

function remoteScope(value: unknown): RemoteDeviceScope {
  if (value === 'cockpit' || value === 'pocket' || value === 'admin') return value
  throw new ConnectionRpcHttpError(400, 'scope must be cockpit, pocket, or admin')
}
