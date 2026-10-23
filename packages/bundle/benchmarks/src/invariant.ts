/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-benchmarks`.
 * @module @deepseek-ai/dsh-benchmarks/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-benchmarks'

/** Cordis companion plugin name. */
export const name = 'benchmarks-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bundle's rows are a command-line provider and a
 * one-shot command that only call `ctx.benchRuntime` and the pure analysis;
 * the ledger relations they rely on belong to dsh-bench-runner.
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
