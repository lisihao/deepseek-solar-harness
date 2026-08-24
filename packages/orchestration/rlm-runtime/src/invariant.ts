import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'rlm-runtime-invariant'
export const inject = ['invariants']
/** The Provider validates commands and family boundaries before mutating durable state. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['rlmRuntime'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-rlm-runtime', install))
