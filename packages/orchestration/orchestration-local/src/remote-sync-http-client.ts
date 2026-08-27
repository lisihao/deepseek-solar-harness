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

  private async call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const rpcId = RpcId(randomUUID())
    const body: ClientRequest = { type: 'client-request', rpcId, method, payload }
    const response = await this.request(new URL(`/remote-sync/${method}`, this.base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.accessToken === undefined ? {} : { authorization: `Bearer ${this.accessToken}` },
      },
      body: JSON.stringify(body),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new Error(`remote operator ${method} transport failed: HTTP ${String(response.status)}`)
    const envelope = serverResponseSchema.parse(await response.json())
    if (envelope.rpcId !== rpcId) throw new Error(`remote operator ${method} rpcId mismatch`)
    if (!envelope.result.ok) {
      throw new Error(`remote operator ${method} failed: ${envelope.result.error.code}: ${envelope.result.error.message}`)
    }
    return envelope.result.value
  }
}
