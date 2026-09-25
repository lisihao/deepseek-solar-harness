/** Package invariant companion. @module @deepseek-ai/dsh-capability-capsule/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'capability-capsule-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: Service availability is the composition contract. */ }, { inject: ['capabilityCapsules'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-capability-capsule', install))
