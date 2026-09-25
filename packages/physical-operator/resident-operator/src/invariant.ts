/** Package-owned invariant companion. @module @deepseek-ai/dsh-resident-operator/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-resident-operator'
export const name = 'resident-operator-invariant'
export const inject = ['invariants']

/** No runtime invariant: this abstract capability seam owns no mutable implementation state. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['residentOperators'] })

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
