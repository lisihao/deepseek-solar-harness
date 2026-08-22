/** Package invariant companion. @module @deepseek-ai/dsh-model-allocation/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'model-allocation-invariant'
export const inject = ['invariants']
/** No runtime invariant: allocation plans are immutable values validated by the service schema. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['modelAllocation'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-model-allocation', install))
