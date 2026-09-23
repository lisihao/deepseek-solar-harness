/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-task-template-rpc`.
 * @module @deepseek-ai/dsh-task-template-rpc/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-template-rpc'

/** Cordis companion plugin name. */
export const name = 'task-template-rpc-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns a request-scoped handler effect and
 * no durable event/data relationship; focused tests prove trusted authority,
 * strict payload handling, returned snapshots, and effect disposal.
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
