/**
 * Command-line entry. The desktop profile installs plugins without their
 * `@deepseek-ai/*` peers (the app shares its own copies), so a plain `node`
 * process cannot resolve them from the plugin directory. This bootstrap adds
 * a resolve hook that retries those specifiers from the host module tree —
 * the official app's bundled runtime by default, or `DSH_SOLAR_BENCH_HOST_MODULES`
 * — and then loads the real command.
 * @module @lisihao/dsh-solar-bench/cli
 */

import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Default host module tree: the official app's bundled runtime. */
const APP_HOST_MODULES = '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules'
const hostModules = process.env.DSH_SOLAR_BENCH_HOST_MODULES ?? APP_HOST_MODULES
const hostParent = pathToFileURL(join(hostModules, '..', 'package.json')).href

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('@deepseek-ai/')) throw error
      return next(specifier, { ...context, parentURL: hostParent })
    }
  },
})

const interrupt = new AbortController()
process.once('SIGINT', () => { interrupt.abort(new Error('interrupted')) })
const { main } = await import('./cli-main.js')
process.exitCode = await main(process.argv.slice(2), interrupt.signal)
