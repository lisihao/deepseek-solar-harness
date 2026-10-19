/** Package-owned invariant companion. @module @deepseek-ai/dsh-research-handoff-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'research-handoff-local-invariant'
export const inject = ['invariants']

// No additional Cordis event invariant: admission checks private Host/Driver registrations and SQLite reads
// validate owner/action associations. The Provider exposes no authoritative public lifecycle event stream.
const install: InvariantInstaller = () => {}

/** Register the local Provider companion without introducing a second action owner. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-research-handoff-local', install))
