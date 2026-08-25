/** Package invariant companion. @module @deepseek-ai/dsh-ui-physical-operator/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'ui-physical-operator-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(
  () => { /* No runtime invariant: the Host route and client slot registries own duplicate fencing. */ },
  { inject: ['residentOperators', 'webServer'] },
)
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-ui-physical-operator', install))
