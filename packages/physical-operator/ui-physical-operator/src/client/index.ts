import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
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

/** Fold one command Remote response into the routing control's failure line. */
function commandFailure(
  result: Awaited<ReturnType<ClientContext['remote']['commands']['execute']>>,
  unknownCommand: string,
): string | null {
  if (!result.ok) return `${result.error.message} (${result.error.code})`
  if (result.value === undefined) return `unknown command: ${unknownCommand}`
  return result.value.result.kind === 'error' ? result.value.result.text : null
}

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
  ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => {
    const models = scope.modelDirectories
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'physical-operator-routing',
      order: 900,
      label: '物理算子执行策略',
      inject: (sessionId: SessionId): PhysicalOperatorRoutingInjected => ({
        directory: models.directoryFor(sessionId).store,
        request: connection.request,
        select: async (policy) => {
          const result = await scope.remote.commands.execute(sessionId, `/operator ${policy}`)
          return commandFailure(result, '/operator')
        },
        selectProfile: async (operatorId, model, effort) => {
          const result = await scope.remote.commands.execute(
            sessionId,
            `/operator-profile ${operatorId} ${model ?? 'auto'} ${effort ?? 'auto'}`,
          )
          return commandFailure(result, '/operator-profile')
        },
        selectOrchestrationStrategy: async (
          rlm,
          autonomous,
          continualHarness,
          optimization,
          plannerVerifierPreference,
          executionPreference,
        ) => {
          const result = await scope.remote.commands.execute(
            sessionId,
            `/orchestration-strategy ${rlm} ${autonomous} ${continualHarness} ${optimization} ${plannerVerifierPreference} ${executionPreference}`,
          )
          return commandFailure(result, '/orchestration-strategy')
        },
        selectDebateMode: async (mode) => {
          const result = await scope.remote.commands.execute(sessionId, `/debate-mode ${mode}`)
          return commandFailure(result, '/debate-mode')
        },
      }),
    }, PhysicalOperatorRoutingControl))
  })
}
