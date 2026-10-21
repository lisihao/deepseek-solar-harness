/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-bench-suite-dsh-native`.
 * @module @deepseek-ai/dsh-bench-suite-dsh-native/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bench-suite-dsh-native'

/** Cordis companion plugin name. */
export const name = 'bench-suite-dsh-native-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package registers one declarative suite whose
 * task file is validated by the dsh-bench loader on every `load()`, and its
 * graders' ability to tell passing from failing runs is checked by the
 * conformance test, not at runtime.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
