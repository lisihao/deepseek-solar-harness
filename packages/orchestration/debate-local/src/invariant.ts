/** Package invariant companion. @module @deepseek-ai/dsh-debate-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'debate-local-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: the Provider validates and atomically persists its owner-local projection at each mutation. */ }, { inject: ['debates'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-debate-local', install))
