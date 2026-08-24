/** Package-owned invariant companion for remote device authentication. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-remote-auth'

export const name = 'remote-auth-invariant'
export const inject = ['invariants']

// No runtime invariant: persistent document and token lifecycle relations are
// checked by the provider's focused tests; this companion reserves package ownership.
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
