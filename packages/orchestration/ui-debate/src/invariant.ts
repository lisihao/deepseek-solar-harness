/** Package invariant companion. @module @deepseek-ai/dsh-ui-debate/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'ui-debate-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(
  () => { /* No runtime invariant: Route and slot registration are checked by their owning registries. */ },
  { inject: ['debates', 'webServer'] },
)
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-ui-debate', install))
