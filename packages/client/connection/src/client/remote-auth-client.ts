/** Browser/Electron client for pairing and short-lived remote access sessions. */

import {
  RpcId, serverResponseSchema, type ClientRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  REMOTE_AUTH_RPC_CHANNEL,
  parseRemoteAccessSession,
  parseRemoteDeviceCredential,
  parseRemoteDeviceList,
  parseRemotePairingChallenge,
  type RemoteAccessSession,
  type RemoteDeviceCredential,
  type RemoteDeviceScope,
  type RemoteDeviceView,
  type RemotePairingChallenge,
} from '../remote-auth-wire.ts'
import { randomUuid } from './random-uuid.ts'

/** Browser-safe client for pairing, token exchange, and paired-device administration. */
export interface RemoteAuthClient {
  issuePairing(scope: RemoteDeviceScope, signal?: AbortSignal): Promise<RemotePairingChallenge>
  redeemPairing(code: string, deviceName: string, signal?: AbortSignal): Promise<RemoteDeviceCredential>
  exchange(credential: string, signal?: AbortSignal): Promise<RemoteAccessSession>
  listDevices(signal?: AbortSignal): Promise<readonly RemoteDeviceView[]>
  revokeDevice(deviceId: string, signal?: AbortSignal): Promise<void>
}

/** The durable credential remains caller-owned; this client only carries an optional access token. */
export class WebRemoteAuthClient implements RemoteAuthClient {
  private readonly base: URL

  constructor(endpoint?: string | URL, private readonly accessToken?: string) {
    this.base = endpoint === undefined ? currentPageBase() : new URL(endpoint)
  }

  async issuePairing(scope: RemoteDeviceScope, signal?: AbortSignal): Promise<RemotePairingChallenge> {
    return parseRemotePairingChallenge(await this.call('pairing.issue', { scope }, signal))
  }

  async redeemPairing(
    code: string,
    deviceName: string,
    signal?: AbortSignal,
  ): Promise<RemoteDeviceCredential> {
    return parseRemoteDeviceCredential(await this.call('pairing.redeem', { code, deviceName }, signal))
  }

  async exchange(credential: string, signal?: AbortSignal): Promise<RemoteAccessSession> {
    return parseRemoteAccessSession(await this.call('session.exchange', { credential }, signal))
  }

  async listDevices(signal?: AbortSignal): Promise<readonly RemoteDeviceView[]> {
    return parseRemoteDeviceList(await this.call('device.list', {}, signal))
  }

  async revokeDevice(deviceId: string, signal?: AbortSignal): Promise<void> {
    const value = await this.call('device.revoke', { deviceId }, signal)
    if (typeof value !== 'object' || value === null || (value as { revoked?: unknown }).revoked !== true) {
      throw new Error('remote auth revoke result is invalid')
    }
  }

  private async call(endpoint: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const rpcId = RpcId(randomUuid())
    const request: ClientRequest = { type: 'client-request', rpcId, method: endpoint, payload }
    const response = await globalThis.fetch(
      new URL(`${REMOTE_AUTH_RPC_CHANNEL}/${endpoint}`, this.base),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.accessToken === undefined ? {} : { authorization: `Bearer ${this.accessToken}` },
        },
        body: JSON.stringify(request),
        ...signal === undefined ? {} : { signal },
      },
    )
    if (!response.ok) throw new Error(`remote auth ${endpoint} transport failed: HTTP ${response.status}`)
    const envelope = serverResponseSchema.parse(await response.json())
    if (envelope.rpcId !== rpcId) {
      throw new Error(`remote auth ${endpoint} rpcId mismatch: sent ${rpcId}, received ${envelope.rpcId}`)
    }
    if (!envelope.result.ok) {
      throw new Error(`remote auth ${endpoint} failed: ${envelope.result.error.code}: ${envelope.result.error.message}`)
    }
    return envelope.result.value
  }
}

function currentPageBase(): URL {
  const location = (globalThis as { location?: { origin?: string } }).location
  return new URL(location?.origin !== undefined && location.origin !== 'null'
    ? location.origin
    : 'http://dsh.internal')
}
