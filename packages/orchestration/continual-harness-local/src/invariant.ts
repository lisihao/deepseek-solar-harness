/** Package invariant companion. @module @deepseek-ai/dsh-continual-harness-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'continual-harness-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: the owner-local store validates its single-writer state at persistence boundaries. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['continualHarness'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-continual-harness-local', install))
