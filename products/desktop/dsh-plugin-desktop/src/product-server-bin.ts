/** Executable entry for the headless DSH Product Server. */

import { readFileSync } from 'node:fs'
import { startProductServer } from './product-server.ts'

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }
  if (typeof manifest.version !== 'string') throw new Error('package.json has no string version')
  return manifest.version
}

const argv = process.argv.slice(2)
process.env.DSH_BUILD_COMMIT ??= `product-server-${packageVersion()}`
if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
  process.stdout.write(`${packageVersion()}\n`)
} else {
  void startProductServer(argv).catch((cause: unknown) => {
    process.stderr.write(`dsh-product-server: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
    process.exitCode = 1
  })
}
