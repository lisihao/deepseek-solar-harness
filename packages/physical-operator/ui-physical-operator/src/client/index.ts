import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ResidentOperatorsPanel } from './ResidentOperatorsPanel.tsx'
import {
  PhysicalOperatorRoutingControl,
  type PhysicalOperatorRoutingInjected,
} from './PhysicalOperatorRoutingControl.tsx'
import { installPhysicalOperatorStyles } from './styles.ts'

export { ResidentOperatorsPanel } from './ResidentOperatorsPanel.tsx'
export * from './PhysicalOperatorRoutingControl.tsx'

/** Browser services required by the Resident projection and routing control. */
export const inject = ['slots', 'connection', 'remote', 'remote.commands', 'sessions']

/** Register provider-neutral physical-operator controls in any DSH client shell. */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.effect(installPhysicalOperatorStyles, 'ui-physical-operator: styles')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'resident-physical-operators',
    order: 70,
    label: 'Resident 物理算子',
    inject: () => ({ request: connection.request }),
  }, ResidentOperatorsPanel))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'physical-operator-routing',
    order: 900,
    label: '物理算子执行策略',
    inject: (sessionId: SessionId): PhysicalOperatorRoutingInjected => ({
      request: connection.request,
      select: async (policy) => {
        const result = await ctx.remote.commands.execute(sessionId, `/operator ${policy}`)
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /operator'
        return null
      },
      selectProfile: async (operatorId, model, effort) => {
        const result = await ctx.remote.commands.execute(
          sessionId,
          `/operator-profile ${operatorId} ${model ?? 'auto'} ${effort ?? 'auto'}`,
        )
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /operator-profile'
        return null
      },
      selectOrchestrationStrategy: async (rlm, continualHarness, optimization) => {
        const result = await ctx.remote.commands.execute(
          sessionId,
          `/orchestration-strategy ${rlm} ${continualHarness} ${optimization}`,
        )
        if (!result.ok) return `${result.error.message} (${result.error.code})`
        if (result.value === undefined) return 'unknown command: /orchestration-strategy'
        return null
      },
    }),
  }, PhysicalOperatorRoutingControl))
}
