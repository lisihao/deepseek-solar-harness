/** Verify the repository-supported ad-hoc signature on the unpacked macOS app. */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Injectable command boundary for release verification. */
export interface MacReleaseVerificationOptions {
  /** Packaged application to verify. */
  readonly appPath: string
  /** Execute one macOS verification command. */
  readonly run: (command: string, args: readonly string[]) => void
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultOptions(): MacReleaseVerificationOptions {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  return {
    appPath: join(packageRoot, 'dist', `mac-${process.arch}`, 'DSH Desktop.app'),
    run,
  }
}

/**
 * Verify the packaged application's strict deep signature.
 * @param options - Application path and command boundary.
 * @returns The verified application path.
 */
export function verifyMacRelease(
  options: MacReleaseVerificationOptions = defaultOptions(),
): { readonly appPath: string } {
  options.run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.appPath])
  return { appPath: options.appPath }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    const verified = verifyMacRelease()
    console.log(`macOS release verification passed: ${verified.appPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
