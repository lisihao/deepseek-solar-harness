/** Package-owned invariant companion for the Gouzi execution-member gate. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-gouzi-member'

export const name = 'gouzi-member-invariant'
export const inject = ['invariants']

// No runtime invariant: the ledger relations (one request hash per execution id, replay returns the stored
// receipt) are checked by the provider's focused tests; this companion reserves package ownership.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
