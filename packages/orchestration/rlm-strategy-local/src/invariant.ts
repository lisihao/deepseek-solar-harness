import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'rlm-strategy-local-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['rlmStrategy'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-rlm-strategy-local', install))
