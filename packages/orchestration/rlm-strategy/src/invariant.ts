import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'rlm-strategy-invariant'
export const inject = ['invariants']
/** No runtime invariant: bounded RLM plans are immutable and schema-validated before sealing. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['rlmStrategy'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-rlm-strategy', install))
