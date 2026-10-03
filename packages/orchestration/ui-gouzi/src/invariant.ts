/** Package-owned invariant companion for the Gouzi panel Host routes. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-ui-gouzi'

export const name = 'ui-gouzi-invariant'
export const inject = ['invariants']

// No runtime invariant: the member-count and state-transition relations belong to the orchestration store and are
// checked by its tests; this package only projects them. This companion reserves package ownership.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
