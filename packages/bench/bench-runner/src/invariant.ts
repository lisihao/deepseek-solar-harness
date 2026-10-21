/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-bench-runner`.
 * @module @deepseek-ai/dsh-bench-runner/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-bench-runner'

/** Cordis companion plugin name. */
export const name = 'bench-runner-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the runtime's relation — at most one ledger record
 * per (variant, task, repetition) — is kept by `run()` itself, which derives
 * pending cells from the ledger it reads before launching any child, and the
 * ledger lives on disk rather than in an event stream or shared in-process
 * data a checker could observe.
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
