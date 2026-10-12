/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-workspace`.
 * @module @deepseek-ai/dsh-client-ui-workspace/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-workspace'

/** Cordis companion plugin name. */
export const name = 'client-ui-workspace-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a plugin registering presentational components into
 * two host-declared slots plus its locale dictionaries — its inject face is
 * stateless RPC wrappers plus a create-and-open call; it emits no cordis
 * events. The one piece of state it owns, the session list filter registry,
 * is a list of predicates with no relation to other data: adding or removing
 * one only recombines the rule, and a removed rule's rows reappear.
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
