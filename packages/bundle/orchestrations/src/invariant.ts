/** Package invariant companion. @module @deepseek-ai/dsh-orchestrations/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'orchestrations-bundle-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = () => { /* No runtime invariant: This package is a declarative profile patch only. */ }
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-orchestrations', install))
