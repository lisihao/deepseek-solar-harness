/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-bench-testkit`.
 * @module @deepseek-ai/dsh-bench-testkit/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bench-testkit'

/** Cordis companion plugin name. */
export const name = 'bench-testkit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package is a vitest helper that grades simulated
 * runs in scratch directories; it mounts no plugin and owns no event stream
 * or shared runtime data.
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
