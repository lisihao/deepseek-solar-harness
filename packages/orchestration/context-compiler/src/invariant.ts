/** Package invariant companion. @module @deepseek-ai/dsh-context-compiler/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'context-compiler-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: Service availability is the composition contract. */ }, { inject: ['contextCompiler'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-context-compiler', install))
