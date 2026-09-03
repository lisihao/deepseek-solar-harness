/** Package-owned invariant companion for @deepseek-ai/dsh-output-style. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-output-style'

/** Cordis companion plugin name. */
export const name = 'output-style-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: ctx.systemPrompt already owns section identity, order,
 * replacement, and disposal for this stateless policy contribution.
 *
 * The system-prompt registry owns section ordering, duplicate detection, and
 * disposal. This package contributes one fixed section and owns no separate
 * runtime state to validate.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
