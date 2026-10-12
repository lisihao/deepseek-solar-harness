/** Projects one Gouzi execution member as Physical Operators that attach an execution grant to every attempt. */

import {
  admissionGouziRecipients,
  OrchestrationArtifactRef,
  OrchestrationRunId,
  type GouziExecutionGrant,
  type GouziId,
  type NodeExecutionPlanV1,
} from '@deepseek-ai/dsh-orchestration'
import { gouziRequestHash, type RemoteResidentExecuteRequest, type RemoteResidentProviderStatus } from '@deepseek-ai/dsh-client-connection'
import { PhysicalOperatorError, PhysicalOperatorExecutionId } from '@deepseek-ai/dsh-physical-operator'
import type { RemotePhysicalOperatorServer } from './remote-physical-operator.ts'
import type { OrchestrationStore } from './store.ts'

/** What the grant issuer reads from the main instance's store. */
export type GouziGrantStore = Pick<OrchestrationStore, 'attemptByExecutionId' | 'readArtifact' | 'getRun' | 'gouzi'>

/** Inputs for projecting one member. */
export interface GouziOperatorOptions {
  readonly store: GouziGrantStore
  readonly gouziId: GouziId
  /**
   * Confirm the member generation still owns this registered, available execution entry at grant issuance.
   * @param operatorId - full registered Physical Operator identity.
   * @param generation - sealed recipient generation.
   * @returns whether the current member registration still owns the available entry.
   */
  readonly validateRecipientOperator?: (operatorId: string, generation: number) => boolean
  /** Device credential of the member host; absent for a loopback or tunnel endpoint that needs none. */
  readonly accessToken?: string
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
 * @param options - store, member identity, and credential.
 * @returns the Server description to pass to `createRemotePhysicalOperators`.
 * @throws PhysicalOperatorError - when the member or its host is not registered.
 */
export function gouziOperatorServer(options: GouziOperatorOptions): RemotePhysicalOperatorServer {
  const { store, gouziId } = options
  const now = options.now ?? Date.now
  const member = store.gouzi.read(gouziId)
  if (member === undefined || store.gouzi.getHost(member.hostId) === undefined) {
    throw new PhysicalOperatorError(`gouzi ${String(gouziId)} is not registered`, 'OPERATOR_UNAVAILABLE')
  }
  if (member.endpoint === undefined) {
    throw new PhysicalOperatorError(`gouzi ${String(gouziId)} has not been started`, 'OPERATOR_UNAVAILABLE')
  }
  return {
    id: `gouzi-${String(gouziId)}`,
    label: member.name,
    endpoint: member.endpoint,
    ...options.accessToken === undefined ? {} : { accessToken: options.accessToken },
    ...options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs },
    gouzi: {
      ...String(member.hostId) !== 'local' || !['127.0.0.1', '[::1]'].includes(new URL(member.endpoint).hostname) ? {} : { allowLocalWorkspaceSnapshot: true as const },
      gouziId: String(gouziId),
      issue(plan: RemoteResidentExecuteRequest, _start, workspace?: RemoteResidentProviderStatus['gouziWorkspace']): GouziExecutionGrant {
        const current = store.gouzi.read(gouziId)
        const currentHost = current === undefined ? undefined : store.gouzi.getHost(current.hostId)
        if (current === undefined || currentHost === undefined || current.membership !== 'enabled') {
          throw new PhysicalOperatorError(`gouzi ${String(gouziId)} is not enabled`, 'OPERATOR_UNAVAILABLE')
        }
        if ('kind' in plan.workspaceIdentity) {
          if (workspace === undefined || workspace.gouziId !== String(gouziId)
            || workspace.generation !== current.generation
            || workspace.projectId !== plan.workspaceIdentity.projectId) {
            throw new PhysicalOperatorError(
              'selected Gouzi project or generation is unavailable at grant issuance', 'OPERATOR_UNAVAILABLE',
            )
          }
        }
        const attempt = store.attemptByExecutionId(plan.commandId)
        if (attempt === undefined) {
          throw new PhysicalOperatorError(
            `gouzi ${String(gouziId)} runs TaskGraph attempts only; ${plan.commandId} is not one`,
            'OPERATOR_MODE_UNSUPPORTED',
          )
        }
        const nodePlan = store.readArtifact(OrchestrationArtifactRef(attempt.executionPlanRef)) as NodeExecutionPlanV1
        const recipients = admissionGouziRecipients(store.getRun(attempt.runId).snapshot.admission)
        if (recipients.length > 0) {
          const operatorId = `gouzi.${String(gouziId)}.${plan.operatorId}`
          // The run names this member, or the grant is refused; a set of members binds each member separately.
          const recipient = recipients.find(value => value.gouziId === gouziId)
          if (recipient === undefined || recipient.generation !== current.generation
            || member.generation !== current.generation || member.hostId !== current.hostId
            || member.ownerId !== current.ownerId || member.endpoint !== current.endpoint
            || nodePlan.operatorPlan.operatorId !== operatorId || !recipient.operatorIds.some(id => String(id) === operatorId)
            || options.validateRecipientOperator?.(operatorId, recipient.generation) !== true) {
            throw new PhysicalOperatorError('selected Gouzi generation or execution entry is unavailable at grant issuance', 'OPERATOR_UNAVAILABLE')
          }
        }
        const deadline = new Date(now() + current.grantDeadlineMs).toISOString()
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
