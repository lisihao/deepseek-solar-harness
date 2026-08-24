/** Browser client for the independently versioned Server projection protocol. */

import {
  RpcId, serverResponseSchema, type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  REMOTE_SYNC_EVENTS_PATH, REMOTE_SYNC_RPC_CHANNEL,
  parseRemoteSyncDescription, parseRemoteSyncFrame, parseRemoteSyncSnapshot,
  type RemoteSyncCursor, type RemoteSyncDescription, type RemoteSyncFrame, type RemoteSyncSnapshot,
} from '../remote-sync.ts'
import { randomUuid } from './random-uuid.ts'
import { getBrowserRemoteAccessToken, withBrowserRemoteAuthorization } from './browser-access-token.ts'
import { readWebSocketDownlink } from './websocket-downlink.ts'

/** Read-only remote projection client; commands remain outside this seam. */
export interface RemoteSyncClient {
  describe(signal?: AbortSignal): Promise<RemoteSyncDescription>
  snapshot(signal?: AbortSignal): Promise<RemoteSyncSnapshot>
  events(
    cursor: RemoteSyncCursor,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RemoteSyncFrame>
}

/** HTTP-up/WebSocket-down implementation used by browser and Electron frontend roles. */
export class WebRemoteSyncClient implements RemoteSyncClient {
  private readonly base: URL

  /**
   * @param endpoint - Server URL; defaults to the current page authority.
   * @param accessToken - short-lived token kept in memory, never placed in a URL.
   */
  constructor(endpoint?: string | URL, private readonly accessToken?: string) {
    this.base = endpoint === undefined ? currentPageBase() : new URL(endpoint)
  }

  async describe(signal?: AbortSignal): Promise<RemoteSyncDescription> {
    return parseRemoteSyncDescription(await this.call('describe', signal))
  }

  async snapshot(signal?: AbortSignal): Promise<RemoteSyncSnapshot> {
    return parseRemoteSyncSnapshot(await this.call('snapshot', signal))
  }

  private async call(method: 'describe' | 'snapshot', signal?: AbortSignal): Promise<unknown> {
    const rpcId = RpcId(randomUuid())
    const request: ClientRequest = {
      type: 'client-request', rpcId, method, payload: {},
    }
    const response = await globalThis.fetch(
      new URL(`${REMOTE_SYNC_RPC_CHANNEL}/${method}`, this.base),
      withBrowserRemoteAuthorization({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.accessToken === undefined ? {} : { authorization: `Bearer ${this.accessToken}` },
        },
        body: JSON.stringify(request),
        ...signal === undefined ? {} : { signal },
      }),
    )
    if (!response.ok) throw new Error(`remote sync ${method} transport failed: HTTP ${response.status}`)
    const envelope = serverResponseSchema.parse(await response.json())
    if (envelope.rpcId !== rpcId) {
      throw new Error(`remote sync ${method} rpcId mismatch: sent ${rpcId}, received ${envelope.rpcId}`)
    }
    if (!envelope.result.ok) {
      throw new Error(`remote sync ${method} failed: ${envelope.result.error.code}: ${envelope.result.error.message}`)
    }
    return envelope.result.value
  }

  async *events(
    cursor: RemoteSyncCursor,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RemoteSyncFrame> {
    const url = new URL(REMOTE_SYNC_EVENTS_PATH, this.base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('deploymentId', cursor.deploymentId)
    url.searchParams.set('since', String(cursor.sequence))
    const token = this.accessToken ?? getBrowserRemoteAccessToken()
    const socket = new WebSocket(url, [
      'dsh-remote-sync-v1',
      ...token === undefined ? [] : [`dsh-bearer.${token}`],
    ])
    yield * readWebSocketDownlink(socket, signal, (event): RemoteSyncFrame => {
      if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
      return parseRemoteSyncFrame(JSON.parse(event.data))
    }, (error) => {
      console.error('[client-connection] dropping malformed remote sync frame:', error)
    }, onOpen)
  }
}

function currentPageBase(): URL {
  const location = (globalThis as { location?: { origin?: string } }).location
  return new URL(location?.origin !== undefined && location.origin !== 'null'
    ? location.origin
    : 'http://dsh.internal')
}
