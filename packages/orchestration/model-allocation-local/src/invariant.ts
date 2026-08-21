/** Package invariant companion. @module @deepseek-ai/dsh-model-allocation-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'model-allocation-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: deterministic offer ranking has no independent mutable runtime state. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['modelAllocation'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-model-allocation-local', install))
