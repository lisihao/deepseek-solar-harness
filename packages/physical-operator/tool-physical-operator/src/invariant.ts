/** Package-owned invariant companion. @module @deepseek-ai/dsh-tool-physical-operator/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-physical-operator'

/** Cordis companion plugin name. */
export const name = 'tool-physical-operator-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: tools own I/O and physicalOperators owns execution lifecycle. */
const install: InvariantInstaller = () => {}

/** Register the package-owned invariant contribution. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
