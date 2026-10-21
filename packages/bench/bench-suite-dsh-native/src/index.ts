/**
 * Function plugin registering the `dsh-native` benchmark suite: coding tasks
 * on DSH's own tool surface, kept as declarative data under `suite/` and
 * graded by test commands, file contents, and tool usage.
 *
 * @module @deepseek-ai/dsh-bench-suite-dsh-native
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { loadDeclarativeSuite } from '@deepseek-ai/dsh-bench'

/** Absolute directory of the suite data, beside both `src/` and the built `lib/`. */
export const SUITE_DIR = fileURLToPath(new URL('../suite/', import.meta.url))

/** Cordis plugin name. */
export const name = 'bench-suite-dsh-native'
/** The suite registry is the plugin's whole purpose. */
export const inject = ['benchmarks']

/**
 * Register the suite; the registration is an effect on this plugin's fiber.
 * @param ctx - registrant context carrying `ctx.benchmarks`.
 */
export async function apply(ctx: Context): Promise<void> {
  ctx.benchmarks.registerSuite(await loadDeclarativeSuite(SUITE_DIR))
}
