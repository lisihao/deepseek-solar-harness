import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type convergence only: locale/theme declarations expose settings slot rows.
// The desktop client does not load or register a settings surface.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { applyAdvancedShell } from './advanced-shell.ts'
import { parseDesktopClientEnvironment } from './environment.ts'
import { installSolarBrand } from './SolarBrand.tsx'
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
  ctx.effect(() => installSolarBrandStyles(), 'desktop: Solar brand styles')
  ctx.effect(() => installSolarBrand(environment.productVersion), 'desktop: Solar brand bar')
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'resident-physical-operators',
    order: -900,
    label: 'Resident 物理算子',
  }, props => ResidentOperatorsPanel(props)))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'durable-orchestrations',
    order: -850,
    label: '持久化任务编排',
  }, props => OrchestrationsPanel(props)))
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
    }),
  }, PhysicalOperatorRoutingControl))
  if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)
}
