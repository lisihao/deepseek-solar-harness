import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { loadResidentDashboard, ResidentOperatorsPanel } from './ResidentOperatorsPanel.tsx'
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
    // The model menu's refresh also refreshes the native and website model
    // catalogs this plugin owns; the Host caches keep the fresh values for
    // the collaboration panel's next read.
    scope.effect(() => models.registerRefreshSource({
      name: '原生算子',
      refresh: async (sessionId) => {
        const dashboard = await loadResidentDashboard(String(sessionId), undefined, connection.request, { refresh: true })
        return dashboard.providers.map(provider => provider.available
          ? `${provider.displayName} ${String(provider.models.length)} 个模型`
          : `${provider.displayName} 不可用`).join('，')
      },
    }), 'ui-physical-operator: native model refresh')
    scope.effect(() => models.registerRefreshSource({
      name: 'ChatGPT Web',
      refresh: async (sessionId) => {
        const url = new URL('/api/chatgpt-web', window.location.origin)
        url.searchParams.set('catalog', '1')
        url.searchParams.set('refresh', '1')
        url.searchParams.set('session_id', String(sessionId))
        const response = await connection.request(url, { cache: 'no-store' })
        if (response.ok) return undefined
        if (response.status === 404) return '未安装，已跳过'
        if (response.status === 409) throw new Error('正忙，请完成当前请求后重试')
        throw new Error(`HTTP ${String(response.status)}`)
      },
    }), 'ui-physical-operator: ChatGPT Web model refresh')
    scope.slots.inject('conversation.input.right', () => scope.slots.register({
      name: 'conversation.input.right',
      id: 'physical-operator-routing',
      order: 900,
      label: '物理算子执行策略',
      inject: (sessionId: SessionId): PhysicalOperatorRoutingInjected => {
        const directory = models.directoryFor(sessionId)
        return {
          directory: directory.store,
          refreshModels: () => directory.load({ refresh: true }),
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
        }
      },
    }, PhysicalOperatorRoutingControl))
  })
}
