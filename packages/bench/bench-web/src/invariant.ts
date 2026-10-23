/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-bench-web`.
 * @module @deepseek-ai/dsh-bench-web/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bench-web'

/** Cordis companion plugin name. */
export const name = 'bench-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the routes are a stateless read of ledgers owned by
 * dsh-bench-runner and of the pure analysis over them; the package keeps no
 * event stream or shared mutable data of its own.
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
