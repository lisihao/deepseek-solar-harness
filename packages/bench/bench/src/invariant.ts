/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-bench`.
 * @module @deepseek-ai/dsh-bench/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bench'

/** Cordis companion plugin name. */
export const name = 'bench-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the registry's only relations (unique suite ids and
 * grader kinds) are refused synchronously inside `registerSuite` and
 * `registerGrader`, and task-file validity is checked by the declarative
 * loader on every `load()`; the package observes no event stream or mutable
 * shared data that could drift afterwards.
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
