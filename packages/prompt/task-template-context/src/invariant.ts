/** Package-owned invariant companion. @module @deepseek-ai/dsh-task-template-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-template-context'

/** Cordis companion plugin name. */
export const name = 'task-template-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Model-visible reconstruction is enforced by the core Session invariant. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
