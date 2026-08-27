/** Node-safe authenticated client for remote Session and Resident control. */

import { randomUUID } from 'node:crypto'
import { RpcId, serverResponseSchema, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  parseRemoteResidentAcceptedTurn,
  parseRemoteResidentEventPage,
  parseRemoteResidentProviders,
  parseRemoteResidentTurn,
  type RemoteResidentAcceptedTurn,
  type RemoteResidentEventPage,
  type RemoteResidentExecuteRequest,
  type RemoteResidentProviderStatus,
  type RemoteResidentTurnSnapshot,
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

  constructor(
    endpoint: string | URL,
    private readonly accessToken?: string,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    this.base = new URL(endpoint)
  }

  /**
   * Read remote native-subscription capacity.
   * @param signal - optional cancellation signal.
   * @returns the validated remote Provider catalog.
   */
  async operatorProviders(signal?: AbortSignal): Promise<RemoteResidentProviderStatus[]> {
    return parseRemoteResidentProviders(await this.call('operator.providers', {}, signal))
  }

  /**
   * Admit one durable remote Resident command.
   * @param request - serializable Resident execution request.
   * @param signal - optional cancellation signal for admission.
   * @returns the durable accepted receipt.
   */
  async operatorExecute(
    request: RemoteResidentExecuteRequest,
    signal?: AbortSignal,
  ): Promise<RemoteResidentAcceptedTurn> {
    return parseRemoteResidentAcceptedTurn(await this.call('operator.execute', request, signal))
  }

  /**
   * Read the current state of one durable remote turn.
   * @param turnId - durable turn identity.
   * @param signal - optional cancellation signal.
   * @returns the validated turn projection.
   */
  async operatorInspect(turnId: string, signal?: AbortSignal): Promise<RemoteResidentTurnSnapshot> {
    return parseRemoteResidentTurn(await this.call('operator.inspect', { turnId }, signal))
  }

  /**
   * Read bounded structured progress for one remote Resident Session.
   * @param sessionId - durable Resident Session identity.
   * @param afterSequence - exclusive event cursor.
   * @param limit - maximum number of events to return.
   * @param signal - optional cancellation signal.
   * @returns the validated ordered event page.
   */
  async operatorEvents(
    sessionId: string,
    afterSequence: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<RemoteResidentEventPage> {
    return parseRemoteResidentEventPage(await this.call('operator.events', {
      sessionId, afterSequence, limit,
    }, signal))
  }

  /**
   * Interrupt one active remote turn without deleting Session continuity.
   * @param sessionId - durable Resident Session identity.
   * @param turnId - active turn identity.
   * @param signal - optional cancellation signal.
   * @returns when the interrupt request has been admitted.
   */
  async operatorInterrupt(sessionId: string, turnId: string, signal?: AbortSignal): Promise<void> {
    await this.call('operator.interrupt', { sessionId, turnId }, signal)
  }

  /** Request one term-fenced vote from a configured orchestration peer. */
  async clusterRequestVote(
    request: OrchestrationClusterVoteRequest,
    signal?: AbortSignal,
  ): Promise<OrchestrationClusterVoteResponse> {
    return clusterVoteResponse(await this.call('cluster.vote', request, signal))
  }

  /** Renew one majority-backed orchestration leader lease. */
  async clusterHeartbeat(
    request: OrchestrationClusterHeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<OrchestrationClusterHeartbeatResponse> {
    return clusterHeartbeatResponse(await this.call('cluster.heartbeat', request, signal))
  }

  /** Install one term-fenced logical TaskGraph replica on a follower. */
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
