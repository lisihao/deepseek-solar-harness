/** Projects one Gouzi execution member as Physical Operators that attach an execution grant to every attempt. */

import {
  OrchestrationArtifactRef,
  OrchestrationRunId,
  type GouziExecutionGrant,
  type GouziId,
  type NodeExecutionPlanV1,
} from '@deepseek-ai/dsh-orchestration'
import { gouziRequestHash, type RemoteResidentExecuteRequest } from '@deepseek-ai/dsh-client-connection'
import { PhysicalOperatorError, PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import type { RemotePhysicalOperatorServer } from './remote-physical-operator.ts'
import type { OrchestrationStore } from './store.ts'

/** What the grant issuer reads from the main instance's store. */
export type GouziGrantStore = Pick<OrchestrationStore, 'attemptByExecutionId' | 'readArtifact' | 'gouzi'>

/** Inputs for projecting one member. */
export interface GouziOperatorOptions {
  readonly store: GouziGrantStore
  readonly gouziId: GouziId
  /** Device credential of the member host, read by the caller from its credential entry. */
  readonly accessToken: string
  /** How long after issue a grant may start work. */
  readonly grantDeadlineMs: number
  /** Settlement polling interval of the remote operator. */
  readonly pollIntervalMs?: number
  /** Clock in epoch milliseconds, injected for deterministic deadlines. */
  readonly now?: () => number
}

function effectScopes(effects: NodeExecutionPlanV1['effectiveEffects']): string[] {
  return [
    ...effects.execute.map(value => `execute:${value}`),
    ...effects.network.map(value => `network:${value}`),
    ...effects.cost.map(value => `cost:${value}`),
    ...effects.risk.map(value => `risk:${value}`),
  ]
}

/**
 * Describe a paired member as a remote Server that signs every attempt with an execution grant. The member and
 * host rows are read when a grant is issued, so a changed generation or epoch applies to the next attempt.
 * @param options - store, member identity, credential, and grant lifetime.
 * @returns the Server description to pass to `createRemotePhysicalOperators`.
 * @throws PhysicalOperatorError - when the member or its host is not registered.
 */
export function gouziOperatorServer(options: GouziOperatorOptions): RemotePhysicalOperatorServer {
  const { store, gouziId } = options
  const now = options.now ?? Date.now
  const member = store.gouzi.read(gouziId)
  const host = member === undefined ? undefined : store.gouzi.getHost(member.hostId)
  if (member === undefined || host === undefined) {
    throw new PhysicalOperatorError(`gouzi ${String(gouziId)} is not registered`, 'OPERATOR_UNAVAILABLE')
  }
  return {
    id: `gouzi-${String(gouziId)}`,
    label: member.name,
    endpoint: host.endpoint,
    accessToken: options.accessToken,
    ...options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs },
    gouzi: {
      gouziId: String(gouziId),
      issue(plan: RemoteResidentExecuteRequest): GouziExecutionGrant {
        const current = store.gouzi.read(gouziId)
        const currentHost = current === undefined ? undefined : store.gouzi.getHost(current.hostId)
        if (current === undefined || currentHost === undefined || current.membership !== 'enabled') {
          throw new PhysicalOperatorError(`gouzi ${String(gouziId)} is not enabled`, 'OPERATOR_UNAVAILABLE')
        }
        const attempt = store.attemptByExecutionId(plan.commandId)
        if (attempt === undefined) {
          throw new PhysicalOperatorError(
            `gouzi ${String(gouziId)} runs TaskGraph attempts only; ${plan.commandId} is not one`,
            'OPERATOR_MODE_UNSUPPORTED',
          )
        }
        const nodePlan = store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
        const deadline = new Date(now() + options.grantDeadlineMs).toISOString()
        return {
          runId: OrchestrationRunId(attempt.runId),
          nodeId: attempt.nodeId,
          attempt: attempt.attempt,
          executionId: PhysicalOperatorExecutionId(plan.commandId),
          gouziId,
          generation: current.generation,
          authorityEpoch: currentHost.authorityEpoch,
          planHash: gouziRequestHash(plan),
          scopes: {
            read: [...nodePlan.effectiveReadScopes],
            write: [...nodePlan.effectiveWriteScopes],
            effects: effectScopes(nodePlan.effectiveEffects),
          },
          credentialRefs: [],
          deadline,
          // The first version does not run without the main instance reachable.
          offlineUntil: deadline,
        }
      },
    },
  }
}
