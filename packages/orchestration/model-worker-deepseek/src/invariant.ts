import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'model-worker-deepseek-invariant'
export const inject = ['invariants']
/** No runtime invariant: credential and bounded-result validation occur at the worker request boundary. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['modelWorkers'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-model-worker-deepseek', install))
