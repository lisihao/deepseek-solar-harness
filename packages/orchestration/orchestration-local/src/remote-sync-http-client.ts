/** Node-safe authenticated client for remote Session and Resident control. */

import { randomUUID } from 'node:crypto'
import { RpcId, serverResponseSchema, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  bindRemoteResidentProtocol,
  type RemoteResidentProtocolBindings,
} from '@deepseek-ai/dsh-client-connection'
import type {
  OrchestrationClusterHeartbeatRequest,
  OrchestrationClusterHeartbeatResponse,
  OrchestrationClusterInstallReceipt,
  OrchestrationClusterInstallRequest,
  OrchestrationClusterVoteRequest,
  OrchestrationClusterVoteResponse,
} from '@deepseek-ai/dsh-orchestration'

/** The remote endpoint could not produce a correlated protocol response. */
export class RemoteSyncTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteSyncTransportError'
  }
}

/** The remote endpoint returned a correlated, explicit command refusal. */
export class RemoteSyncRejectedError extends Error {
  constructor(
    message: string,
    readonly remoteCode: string,
  ) {
    super(message)
    this.name = 'RemoteSyncRejectedError'
  }
}

/** Stateless HTTP-up client used by detached Schedulers and Electron main. */
export class RemoteSyncHttpClient {
  private readonly base: URL
  /** List remote Resident Provider qualification and model status. */
  declare readonly operatorProviders: RemoteResidentProtocolBindings['operatorProviders']
  /** Submit one durable remote Resident turn. */
  declare readonly operatorExecute: RemoteResidentProtocolBindings['operatorExecute']
  /** Inspect one durable remote Resident turn. */
  declare readonly operatorInspect: RemoteResidentProtocolBindings['operatorInspect']
  /** Read exact content-addressed bytes for one oversized Resident result. */
  declare readonly operatorArtifact: RemoteResidentProtocolBindings['operatorArtifact']
  /** Read one bounded page of remote Resident progress events. */
  declare readonly operatorEvents: RemoteResidentProtocolBindings['operatorEvents']
  /** Interrupt one active remote Resident turn. */
  declare readonly operatorInterrupt: RemoteResidentProtocolBindings['operatorInterrupt']

  constructor(
    endpoint: string | URL,
    private readonly accessToken?: string,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    this.base = new URL(endpoint)
    Object.assign(this, bindRemoteResidentProtocol((method, payload, signal) => this.call(method, payload, signal)))
  }

  /**
   * Request one term-fenced vote from a configured orchestration peer.
   * @param request - candidate term and replication watermark.
   * @param signal - optional request cancellation signal.
   * @returns the peer's validated vote response.
   */
  async clusterRequestVote(
    request: OrchestrationClusterVoteRequest,
    signal?: AbortSignal,
  ): Promise<OrchestrationClusterVoteResponse> {
    return clusterVoteResponse(await this.call('cluster.vote', request, signal))
  }

  /**
   * Renew one majority-backed orchestration leader lease.
   * @param request - elected leader term, lease, and replication watermark.
   * @param signal - optional request cancellation signal.
   * @returns the peer's validated lease acknowledgement.
   */
  async clusterHeartbeat(
    request: OrchestrationClusterHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<OrchestrationClusterHeartbeatResponse> {
    return clusterHeartbeatResponse(await this.call('cluster.heartbeat', request, signal))
  }

  /**
   * Install one term-fenced logical TaskGraph replica on a follower.
   * @param request - elected leader coordinates and logical state image.
   * @param signal - optional request cancellation signal.
   * @returns the follower's validated installation receipt.
   */
  async clusterInstallReplica(
    request: OrchestrationClusterInstallRequest,
    signal?: AbortSignal,
  ): Promise<OrchestrationClusterInstallReceipt> {
    return clusterInstallReceipt(await this.call('cluster.install', request, signal))
  }

  private async call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const rpcId = RpcId(randomUUID())
    const body: ClientRequest = { type: 'client-request', rpcId, method, payload }
    let response: Response
    try {
      response = await this.request(new URL(`/remote-sync/${method}`, this.base), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...this.accessToken === undefined ? {} : { authorization: `Bearer ${this.accessToken}` },
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (cause) {
      throw new RemoteSyncTransportError(`remote operator ${method} transport failed`, { cause })
    }
    if (!response.ok) {
      throw new RemoteSyncTransportError(
        `remote operator ${method} transport failed: HTTP ${String(response.status)}`,
      )
    }
    let envelope
    try {
      envelope = serverResponseSchema.parse(await response.json())
    } catch (cause) {
      throw new RemoteSyncTransportError(`remote operator ${method} returned an invalid response`, { cause })
    }
    if (envelope.rpcId !== rpcId) {
      throw new RemoteSyncTransportError(`remote operator ${method} rpcId mismatch`)
    }
    if (!envelope.result.ok) {
      throw new RemoteSyncRejectedError(
        `remote operator ${method} failed: ${envelope.result.error.code}: ${envelope.result.error.message}`,
        envelope.result.error.code,
      )
    }
    return envelope.result.value
  }
}

function clusterRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteSyncTransportError(`${label} returned an invalid response`)
  }
  return value as Record<string, unknown>
}

function clusterInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new RemoteSyncTransportError(`${label} must be non-negative`)
  return Number(value)
}

function clusterNodeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new RemoteSyncTransportError(`${label} must be non-blank`)
  return value
}

function clusterVoteResponse(value: unknown): OrchestrationClusterVoteResponse {
  const response = clusterRecord(value, 'cluster vote')
  if (typeof response.granted !== 'boolean') throw new RemoteSyncTransportError('cluster vote granted must be boolean')
  return {
    term: clusterInteger(response.term, 'cluster vote term'),
    voterId: clusterNodeId(response.voterId, 'cluster vote voterId'),
    granted: response.granted,
    commitIndex: clusterInteger(response.commitIndex, 'cluster vote commitIndex'),
  }
}

function clusterHeartbeatResponse(value: unknown): OrchestrationClusterHeartbeatResponse {
  const response = clusterRecord(value, 'cluster heartbeat')
  if (typeof response.accepted !== 'boolean') throw new RemoteSyncTransportError('cluster heartbeat accepted must be boolean')
  return {
    term: clusterInteger(response.term, 'cluster heartbeat term'),
    followerId: clusterNodeId(response.followerId, 'cluster heartbeat followerId'),
    accepted: response.accepted,
    commitIndex: clusterInteger(response.commitIndex, 'cluster heartbeat commitIndex'),
  }
}

function clusterInstallReceipt(value: unknown): OrchestrationClusterInstallReceipt {
  const response = clusterRecord(value, 'cluster install')
  if (response.state !== 'applied' && response.state !== 'unchanged') {
    throw new RemoteSyncTransportError('cluster install state is invalid')
  }
  return {
    nodeId: clusterNodeId(response.nodeId, 'cluster install nodeId'),
    commitIndex: clusterInteger(response.commitIndex, 'cluster install commitIndex'),
    state: response.state,
  }
}
