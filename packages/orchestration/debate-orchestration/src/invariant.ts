/** Package invariant companion. @module @deepseek-ai/dsh-debate-orchestration/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'debate-orchestration-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(
  () => { /* No runtime invariant: TaskGraph plan dependencies are checked at the compile boundary. */ },
  { inject: ['debates', 'orchestrations'] },
)
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-debate-orchestration', install))
