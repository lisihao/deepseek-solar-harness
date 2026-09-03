/** Package-owned invariant companion for the ChatGPT web physical operator. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-physical-operator-chatgpt-web'

/** Cordis companion plugin name. */
export const name = 'physical-operator-chatgpt-web-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: browser and physical-operator Services own execution lifecycle pairs. */
const install: InvariantInstaller = () => {}

/** Register the package-owned invariant contribution. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
