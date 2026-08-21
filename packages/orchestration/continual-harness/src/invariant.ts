/** Package invariant companion. @module @deepseek-ai/dsh-continual-harness/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'continual-harness-invariant'
export const inject = ['invariants']
/** No runtime invariant: immutable snapshot validation is enforced by the service boundary. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['continualHarness'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-continual-harness', install))
