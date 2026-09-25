import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'rlm-runtime-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: state is single-writer and all external child effects are receipt-gated. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['rlmRuntime'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-rlm-runtime-local', install))
