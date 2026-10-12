/** Package invariant companion. @module @deepseek-ai/dsh-scheduling-evidence/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
export const name = 'scheduling-evidence-invariant'
export const inject = ['invariants']
/** No runtime invariant: the gateway keeps no durable data or event stream; each call tracks and awaits its own child process. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['schedulingEvidence'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-scheduling-evidence', install))
