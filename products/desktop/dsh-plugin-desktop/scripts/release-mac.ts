/** Build and verify the repository-supported ad-hoc-signed macOS application. */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertMacReleaseReady,
  withoutMacReleaseSecrets,
} from './release-preflight.ts'

/** Injectable release boundary used by focused tests. */
export interface MacReleaseOptions {
  /** Environment inherited from the caller; Apple release credentials are removed. */
  readonly env: NodeJS.ProcessEnv
  /** Platform executing the release. */
  readonly platform: NodeJS.Platform
  /** CPU architecture used by Electron Builder's output directory. */
  readonly arch: string
  /** Desktop package root containing package.json. */
  readonly desktopRoot: string
  /** Execute one release command. */
  readonly run: (
    command: string,
    args: readonly string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => void
  /** Report non-secret release progress. */
  readonly log: (message: string) => void
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${String(result.status)}`)
  }
}

function defaultReleaseOptions(): MacReleaseOptions {
  return {
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    desktopRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    run,
    log: message => console.log(message),
  }
}

/**
 * Build the macOS artifact without Apple distribution credentials, then apply
 * and verify the repository-supported ad-hoc signature.
 * @param options - Injectable process and command boundaries.
 */
export function releaseMac(options: MacReleaseOptions = defaultReleaseOptions()): void {
  const result = assertMacReleaseReady(options.platform)
  const buildEnvironment = withoutMacReleaseSecrets(options.env)
  const appPath = join(options.desktopRoot, 'dist', `mac-${options.arch}`, 'DSH Desktop.app')
  options.log(`macOS release preflight passed: signing via ${result.signing}`)

  options.run('yarn', [
    'exec', 'electron-builder', '--mac', 'dir',
    '--config.mac.identity=null', '--config.mac.notarize=false',
  ], options.desktopRoot, buildEnvironment)
  options.run('codesign', ['--force', '--deep', '--sign', '-', appPath], options.desktopRoot, buildEnvironment)
  options.run(process.execPath, ['scripts/verify-packaged-node-pty.ts'], options.desktopRoot, buildEnvironment)
  options.run(process.execPath, ['scripts/verify-mac-release.ts'], options.desktopRoot, buildEnvironment)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  try {
    releaseMac()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
