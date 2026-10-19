/** Research Definition invariant companion. @module @deepseek-ai/dsh-research-handoff/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'research-handoff-invariant'
export const inject = ['invariants']

// The abstract Definition owns no mutable runtime state or event relationship; its Provider owns those facts.
const install: InvariantInstaller = () => {}

/** Register the Definition companion without inventing a Provider-state invariant. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-research-handoff', install))
