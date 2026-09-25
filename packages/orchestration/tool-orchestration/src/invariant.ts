/** Package invariant companion. @module @deepseek-ai/dsh-tool-orchestration/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'tool-orchestration-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: Tool registration is already checked by the owning registries. */ }, { inject: ['orchestrations', 'tools'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-tool-orchestration', install))
