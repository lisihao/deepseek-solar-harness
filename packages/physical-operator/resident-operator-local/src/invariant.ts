/** Package-owned invariant companion. @module @deepseek-ai/dsh-resident-operator-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-resident-operator-local'
export const name = 'resident-operator-local-invariant'
export const inject = ['invariants']
/** No runtime invariant: daemon durability requires socket, crash, and SQLite round-trip tests. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['residentOperators'] })
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
