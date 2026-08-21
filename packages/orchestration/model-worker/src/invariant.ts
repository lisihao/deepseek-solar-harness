import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'model-worker-invariant'
export const inject = ['invariants']
/** No runtime invariant: registry ownership and provider identity are enforced by the Cordis service. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['modelWorkers'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-model-worker', install))
