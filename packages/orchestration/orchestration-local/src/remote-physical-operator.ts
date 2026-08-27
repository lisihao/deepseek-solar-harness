/** Remote Resident Provider over the authenticated DSH Server control plane. */

import {
  PhysicalOperatorError,
  PhysicalOperatorId,
  type PhysicalOperator,
  type PhysicalOperatorAcceptedReceipt,
  type PhysicalOperatorProviderRun,
  type PhysicalOperatorProviderStartRequest,
  type PhysicalOperatorResidentCatalog,
  type PhysicalOperatorResult,
} from '@deepseek-ai/dsh-physical-operator'
import type { RemoteResidentProviderStatus, RemoteResidentTurnSnapshot } from '@deepseek-ai/dsh-client-connection'
import { RemoteSyncHttpClient } from './remote-sync-http-client.ts'

/** One independently addressable DSH Server execution member. */
export interface RemotePhysicalOperatorServer {
  /** Stable deployment id used to namespace Provider and quota identities. */
  readonly id: string
  readonly label: string
  readonly endpoint: string
  readonly accessToken?: string
  /** Settlement polling interval; defaults to 250ms. */
  readonly pollIntervalMs?: number
}

function alias(serverId: string, nativeOperatorId: string): string {
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(serverId)) {
    throw new Error('remote physical operator server id must use lowercase letters, digits, dots, underscores, or hyphens')
  }
  return `remote.${serverId}.${nativeOperatorId}`
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('remote operator wait aborted'))
  }
  return new Promise<void>((resolve, reject) => {
    const complete = (): void => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(complete, delayMs)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error('remote operator wait aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** One remote Server's native product projected through the Physical Operator seam. */
export class RemotePhysicalOperator implements PhysicalOperator {
  readonly descriptor
  private provider: RemoteResidentProviderStatus
  private readonly client: RemoteSyncHttpClient

  constructor(
    readonly server: RemotePhysicalOperatorServer,
    provider: RemoteResidentProviderStatus,
    request: typeof fetch = globalThis.fetch,
  ) {
    this.provider = provider
    this.client = new RemoteSyncHttpClient(server.endpoint, server.accessToken, request)
    this.descriptor = {
      id: PhysicalOperatorId(alias(server.id, provider.operatorId)),
      displayName: `${provider.displayName} · ${server.label}`,
      description: `${provider.description} Remote execution on ${server.label}.`,
      tags: Object.freeze([...provider.tags, 'remote', `server.${server.id}`]),
      maxConcurrency: provider.maxConcurrency,
      executionModes: ['resident'] as const,
    }
  }

  availability() {
    return this.provider.available
      ? { available: true as const }
      : { available: false as const, reason: this.provider.unavailableReason ?? 'remote Provider unavailable' }
  }

  async residentCatalog(): Promise<PhysicalOperatorResidentCatalog> {
    const current = (await this.client.operatorProviders())
      .find(value => value.operatorId === this.provider.operatorId)
    if (current === undefined) {
      throw new PhysicalOperatorError(
        `remote Provider "${this.provider.operatorId}" disappeared from ${this.server.label}`,
        'OPERATOR_UNAVAILABLE',
      )
    }
    this.provider = current
    return {
      operatorId: this.descriptor.id,
      product: current.product,
      injectionBoundaries: current.injectionBoundaries,
      supportsModelToolBridge: false,
      location: 'remote',
      supportsWorkspaceMutationReturn: false,
      available: current.available,
      ...current.unavailableReason === undefined ? {} : { unavailableReason: current.unavailableReason },
      ...current.quotaUnavailableReason === undefined ? {} : { quotaUnavailableReason: current.quotaUnavailableReason },
      authentication: current.authentication,
      productVersion: current.productVersion,
      protocolHash: current.protocolHash,
      models: current.models,
      ...current.quotaPools === undefined ? {} : {
        quotaPools: current.quotaPools.map(pool => ({
          ...pool,
          poolId: `remote.${this.server.id}.${pool.poolId}`,
        })),
      },
    }
  }

  async start(request: PhysicalOperatorProviderStartRequest): Promise<PhysicalOperatorProviderRun> {
    if (request.modelToolBridge !== undefined) {
      throw new PhysicalOperatorError(
        'remote physical operators do not expose an owner-local model-tool socket',
        'OPERATOR_MODE_UNSUPPORTED',
      )
    }
    const workspace = request.parent.session.header.cwd
    if (workspace === undefined) {
      throw new PhysicalOperatorError('remote physical operator requires a workspace', 'WORKSPACE_INVALID')
    }
    const accepted = await this.client.operatorExecute({
      commandId: String(request.executionId),
      operatorId: this.provider.operatorId,
      workspace,
      laneId: request.residentLaneId ?? String(request.executionId),
      ...request.label === undefined ? {} : { taskLabel: request.label },
      prompt: request.prompt,
      ...request.systemPrompt === undefined ? {} : { systemPrompt: request.systemPrompt },
      ...request.residentProfile === undefined ? {} : { profile: request.residentProfile },
    }, request.signal)
    return this.observe(accepted, request.signal)
  }

  async reattach(turnId: string): Promise<PhysicalOperatorProviderRun> {
    let turn: RemoteResidentTurnSnapshot
    try {
      turn = await this.client.operatorInspect(turnId)
    } catch (error) {
      if (error instanceof Error && error.message.includes('SESSION_UNAVAILABLE')) {
        throw new PhysicalOperatorError(error.message, 'COMMAND_INDETERMINATE')
      }
      throw error
    }
    return this.observe({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      stateRevision: turn.stateRevision,
    })
  }

  interrupt(receipt: PhysicalOperatorAcceptedReceipt): Promise<void> {
    return this.client.operatorInterrupt(receipt.sessionId, receipt.turnId)
  }

  private observe(
    accepted: PhysicalOperatorAcceptedReceipt,
    executionSignal?: AbortSignal,
  ): PhysicalOperatorProviderRun {
    const polling = new AbortController()
    const interrupt = (): void => {
      void this.client.operatorInterrupt(accepted.sessionId, accepted.turnId).catch(() => undefined)
    }
    executionSignal?.addEventListener('abort', interrupt, { once: true })
    if (executionSignal?.aborted === true) interrupt()

    const result = this.settle(accepted.turnId, polling.signal)
      .finally(() => { executionSignal?.removeEventListener('abort', interrupt) })
    return {
      receipt: accepted,
      readEvents: async (afterSequence, limit, signal) => {
        const page = await this.client.operatorEvents(accepted.sessionId, afterSequence, limit, signal)
        return {
          events: page.events.map(value => ({
            sequence: value.sequence,
            type: value.type,
            time: value.time,
            data: value.data,
          })),
          nextSequence: page.nextSequence,
        }
      },
      result,
      // Detach only: the remote daemon retains Receipt, Session, and native execution.
      dispose: () => {
        polling.abort(new Error('remote physical operator observer detached'))
        return Promise.resolve()
      },
    }
  }

  private async settle(turnId: string, signal: AbortSignal): Promise<PhysicalOperatorResult> {
    while (true) {
      const turn = await this.client.operatorInspect(turnId, signal)
      if (turn.state === 'settled') {
        if (turn.result === undefined) {
          throw new PhysicalOperatorError('remote settled turn omitted its terminal result', 'INVALID_RESULT')
        }
        return {
          output: [...turn.result.output],
          stopReason: turn.result.stopReason,
          continuity: { sessionId: turn.sessionId, stateRevision: turn.stateRevision },
        }
      }
      if (turn.state === 'indeterminate') {
        throw new PhysicalOperatorError(
          turn.error?.message ?? 'remote turn outcome is indeterminate',
          'COMMAND_INDETERMINATE',
        )
      }
      await wait(this.server.pollIntervalMs ?? 250, signal)
    }
  }
}

/**
 * Qualify one Server and construct its independently registered remote Providers.
 * @param server - remote DSH Server member to qualify.
 * @param request - HTTP implementation used for authenticated control calls.
 * @returns independently registered Physical Operator projections.
 */
export async function createRemotePhysicalOperators(
  server: RemotePhysicalOperatorServer,
  request: typeof fetch = globalThis.fetch,
): Promise<RemotePhysicalOperator[]> {
  const client = new RemoteSyncHttpClient(server.endpoint, server.accessToken, request)
  return (await client.operatorProviders()).map(provider => new RemotePhysicalOperator(server, provider, request))
}
