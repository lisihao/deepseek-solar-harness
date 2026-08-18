/** Package invariant companion. @module @deepseek-ai/dsh-orchestration/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'orchestration-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: Service availability is the composition contract. */ }, { inject: ['orchestrations'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-orchestration', install))
