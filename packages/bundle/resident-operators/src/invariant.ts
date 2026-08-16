/** Package-owned invariant companion. @module @deepseek-ai/dsh-resident-operators/invariant */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
const PACKAGE_NAME = '@deepseek-ai/dsh-resident-operators'
export const name = 'resident-operators-bundle-invariant'
export const inject = ['invariants']
// No runtime invariant: this package is a static profile patch whose mounted
// Service and Provider packages own their lifecycle and persistence checks.
const install: InvariantInstaller = () => {}
export const apply = (ctx: Context): Promise<() => void> => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
