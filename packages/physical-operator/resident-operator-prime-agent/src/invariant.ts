/** Package-owned invariant companion. @module @deepseek-ai/dsh-resident-operator-prime-agent/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-resident-operator-prime-agent'
export const name = 'resident-operator-prime-agent-invariant'
export const inject = ['invariants']
/** No runtime invariant: RPC framing and subscription qualification are covered at the Driver boundary. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: [] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
