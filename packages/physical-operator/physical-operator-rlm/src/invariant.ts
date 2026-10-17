/** Package-owned invariant companion. @module @deepseek-ai/dsh-physical-operator-rlm/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'physical-operator-rlm-invariant'
export const inject = ['invariants']

// No runtime invariant: PhysicalOperatorRuntime owns registrations/lifecycle; the daemon owns command/run/settlement relationships.
const install: InvariantInstaller = () => {}

/** Register the package contribution; no second lifecycle or persistence owner is introduced. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-physical-operator-rlm', install))
