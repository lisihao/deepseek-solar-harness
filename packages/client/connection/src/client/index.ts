/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { RemoteSyncController } from './remote-sync-controller.ts'
import { WebRemoteSyncClient } from './remote-sync-client.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { withBrowserRemoteAuthorization } from './browser-access-token.ts'
export { WebRemoteAuthClient } from './remote-auth-client.ts'
export type { RemoteAuthClient } from './remote-auth-client.ts'
export { RemoteSyncController } from './remote-sync-controller.ts'
export type {
  RemoteSyncControllerConfig, RemoteSyncControllerHandle, RemoteSyncSinks, RemoteSyncState,
} from './remote-sync-controller.ts'
export { WebRemoteSyncClient } from './remote-sync-client.ts'
export type { RemoteSyncClient } from './remote-sync-client.ts'
export { REMOTE_AUTH_RPC_CHANNEL } from '../remote-auth-wire.ts'
export type {
  RemoteAccessSession, RemoteDeviceCredential, RemoteDeviceScope, RemoteDeviceView,
  RemotePairingChallenge,
} from '../remote-auth-wire.ts'
export {
  REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_PROTOCOL, REMOTE_SYNC_RPC_CHANNEL,
  bindRemoteResidentProtocol, RemoteResidentProtocolClient,
  parseRemoteResidentAcceptedTurn, parseRemoteResidentEventPage, parseRemoteResidentProviders, parseRemoteResidentTurn,
  parseRemoteSessionReplicaApplyResult, parseRemoteSessionReplicaDocument, parseRemoteSessionReplicaList,
  parseRemoteSyncCursor, parseRemoteSyncDescription, parseRemoteSyncFrame, parseRemoteSyncSnapshot,
} from '../remote-sync.ts'
export type {
  RemoteResidentAcceptedTurn, RemoteResidentEventPage, RemoteResidentExecuteRequest,
  RemoteResidentModelOption, RemoteResidentProviderStatus, RemoteResidentQuotaPool,
  RemoteResidentProtocolBindings, RemoteResidentQuotaWindow, RemoteResidentReasoningEffort, RemoteResidentTurnSnapshot,
  RemoteSessionReplicaApplyResult, RemoteSessionReplicaDocument, RemoteSessionReplicaSummary,
  RemoteSyncCapability, RemoteSyncCursor, RemoteSyncDescription, RemoteSyncEvent, RemoteSyncFrame,
  RemoteSyncResyncRequired, RemoteSyncSnapshot,
} from '../remote-sync.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
export {
  getBrowserRemoteAccessToken, setBrowserRemoteAccessToken, withBrowserRemoteAuthorization,
} from './browser-access-token.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** UI-facing connection status; projections remain readable while reconnecting. */
export type ConnectionViewState = 'connecting' | 'connected' | 'reconnecting'

/** Observable connectivity source retained separately from cached projections. */
export interface ConnectionStateSource {
  getSnapshot(): ConnectionViewState
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Authenticated browser request using the same memory-only bearer as the primary transport. */
  readonly request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  /** Direct Host streams or the authenticated snapshot + cursor projection transport; absent means direct for old consumers. */
  readonly transport?: 'direct' | 'remote-projection'
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Observable connectivity without making cached projections disappear. */
  readonly state: ConnectionStateSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const remoteProjection = pageLocation !== undefined
    && new URLSearchParams(pageLocation.search).get('dsh-deployment-role') === 'frontend'
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? new WebApiClient()
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  let started = false
  let description: HostDescription | undefined
  let connectionState: ConnectionViewState = 'connecting'
  const descriptionListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const publishState = (next: ConnectionViewState): void => {
    if (connectionState === next) return
    connectionState = next
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] connection-state listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    request: (input, init) => globalThis.fetch(input, withBrowserRemoteAuthorization(init)),
    transport: remoteProjection ? 'remote-projection' : 'direct',
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => connectionState,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      if (remoteProjection) {
        let currentDescription: HostDescription | undefined
        const controller = new RemoteSyncController(new WebRemoteSyncClient(), {
          replace: (remoteDescription, snapshot) => {
            currentDescription = snapshot.host
            publishDescription(snapshot.host)
            sinks.onRemoteSnapshot?.(remoteDescription, snapshot)
          },
          apply: (event) => {
            if (event.stream === 'mux') sinks.onMuxEnvelope?.(event.envelope)
            else sinks.onHostEnvelope?.(event.envelope)
          },
          onStateChange: (state) => {
            if (state === 'connected') {
              /* v8 ignore next -- RemoteSyncController emits connected only from events.onOpen,
               * after its snapshot replace sink has assigned currentDescription. */
              if (currentDescription !== undefined) {
                publishDescription(currentDescription)
                publishState('connected')
                sinks.onStateChange?.('connected')
                sinks.onConnected?.(currentDescription)
              }
              return
            }
            if (state === 'reconnecting') {
              publishDescription(undefined)
              publishState('reconnecting')
              sinks.onStateChange?.('reconnecting')
            }
          },
          onError: (error) => {
            console.error('[web-runtime] remote projection sync failed:', error)
          },
        }, config?.backoffBaseMs === undefined ? {} : { retryDelayMs: config.backoffBaseMs })
        const remoteLoop = controller.start()
        return {
          stop: () => {
            remoteLoop.stop()
            publishDescription(undefined)
            publishState('connecting')
          },
        }
      }
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          publishState(state)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
          publishState('connecting')
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
