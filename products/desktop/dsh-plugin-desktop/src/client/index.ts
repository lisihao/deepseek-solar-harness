import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
// The desktop client does not load or register a settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { mountSolarBrandFooter } from './SolarBrand.tsx'
import { ResidentOperatorsPanel } from './ResidentOperatorsPanel.tsx'
import { OrchestrationsPanel } from './OrchestrationsPanel.tsx'
import {
  PhysicalOperatorRoutingControl,
  type PhysicalOperatorRoutingInjected,
} from './PhysicalOperatorRoutingControl.tsx'
import { installSolarBrandStyles } from './styles.ts'

export { applyAdvancedShell } from './advanced-shell.ts'
export { parseDesktopClientEnvironment } from './environment.ts'
export type { DesktopClientEnvironment, DesktopClientMode, DesktopClientPlatform } from './environment.ts'

/** Services required by advanced presentation. */
export const inject = [
  'slots',
  'remote',
  'remote.commands',
  'sessions',
  'theme',
]

/** Register desktop-owned client surfaces for the current BrowserWindow mode. @param ctx - browser Cordis context. */
export function apply(ctx: ClientContext): void {
  const environment = parseDesktopClientEnvironment(window.location.search)
  ctx.effect(() => {
    const removeStyles = installSolarBrandStyles()
    const removeFooter = mountSolarBrandFooter(environment.productVersion)
    return () => {
      removeFooter()
      removeStyles()
    }
  }, 'desktop: Solar product footer')
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'resident-physical-operators',
    order: 70,
    label: 'Resident 物理算子',
  }, ResidentOperatorsPanel))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'durable-orchestrations',
    order: 80,
    label: '持久化任务编排',
  }, OrchestrationsPanel))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'physical-operator-routing',
    order: 900,
    label: '物理算子执行策略',
    inject: (sessionId: SessionId): PhysicalOperatorRoutingInjected => ({
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
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}
