/** Package invariant companion. @module @deepseek-ai/dsh-orchestration-local/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'orchestration-local-invariant'
export const inject = ['invariants']
const install: InvariantInstaller = Object.assign(() => { /* No runtime invariant: The daemon handshake owns health qualification. */ }, { inject: ['orchestrations'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-orchestration-local', install))
