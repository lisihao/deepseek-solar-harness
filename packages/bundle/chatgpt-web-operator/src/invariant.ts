/** Package-owned invariant companion for the ChatGPT Web bundle. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-chatgpt-web-operator'

/** Stable Cordis plugin name. */
export const name = 'chatgpt-web-operator-bundle-invariant'
/** The invariant registry must be mounted before registration. */
export const inject = ['invariants']

// No runtime invariant: this is a composition-only package. The inserted
// Service Definition, Provider, and Consumer own their mutable-state invariants.
const install: InvariantInstaller = () => {}

/** Register the package companion without adding another runtime authority. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
