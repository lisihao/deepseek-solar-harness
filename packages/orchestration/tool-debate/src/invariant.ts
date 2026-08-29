/** Package invariant companion. @module @deepseek-ai/dsh-tool-debate/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'tool-debate-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(
  () => { /* No runtime invariant: Tool and projection registration are checked by their owning registries. */ },
  { inject: ['debates', 'tools'] },
)
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-tool-debate', install))
