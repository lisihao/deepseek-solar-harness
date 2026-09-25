/** Host projection for provider-neutral Resident physical operators. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-resident-operator'
import { registerResidentCliRuntimes, registerResidentDashboard } from './dashboard.ts'

export { readResidentDashboard, registerResidentCliRuntimes, registerResidentDashboard } from './dashboard.ts'
export * from './contracts.ts'
export * from './presentation.ts'

export const name = 'ui-physical-operator'
export const inject = ['residentOperators', 'webServer']

/** Register the authenticated Resident projection, owner-local login action, and native CLI route. */
export function apply(ctx: Context): void {
  ctx.effect(() => registerResidentDashboard(ctx), 'ui-physical-operator: Resident dashboard route')
  ctx.effect(() => registerResidentCliRuntimes(ctx), 'ui-physical-operator: native CLI route')
}
