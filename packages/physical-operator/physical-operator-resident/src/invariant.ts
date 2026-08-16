/** Package-owned invariant companion. @module @deepseek-ai/dsh-physical-operator-resident/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-physical-operator-resident'
export const name = 'physical-operator-resident-invariant'
export const inject = ['invariants']
/** No runtime invariant: both delegated Service seams own their lifecycle pairs. */
const install: InvariantInstaller = Object.assign(() => {}, { inject: ['physicalOperators', 'residentOperators'] })
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
