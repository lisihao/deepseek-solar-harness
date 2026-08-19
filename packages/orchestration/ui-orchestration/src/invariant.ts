/** Package invariant companion. @module @deepseek-ai/dsh-ui-orchestration/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'ui-orchestration-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: Route registration is already checked by the Host registry. */ }, { inject: ['orchestrations', 'webServer'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-ui-orchestration', install))
