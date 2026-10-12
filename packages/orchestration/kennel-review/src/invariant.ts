/** Package invariant companion. @module @deepseek-ai/dsh-kennel-review/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'kennel-review-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(
  () => { /* No runtime invariant: a review is an ordinary TaskGraph run, so the Scheduler already checks its plan and recipients. */ },
  { inject: ['orchestrations', 'kennelCollaborations'] },
)
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-kennel-review', install))
