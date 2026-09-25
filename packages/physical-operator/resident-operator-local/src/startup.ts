#!/usr/bin/env node
/** Standalone lifecycle entry for dsh-resident-operatord. @module @deepseek-ai/dsh-resident-operator-local/startup */

import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ResidentDaemon } from './daemon.ts'
import { ClaudeCodeResidentDriver, CodexResidentDriver } from './drivers.ts'
import { loadResidentProductDrivers, residentDriverManifestSha256 } from './driver-modules.ts'
import { cliRuntimesRoot, managedCliBinDir } from './cli-runtimes.ts'

const ELECTRON_RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'

/**
 * Remove Electron's bootstrap marker before product Drivers create children.
 * @param environment - child environment that must not retain Electron RunAsNode state.
 */
export function clearElectronRunAsNode(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === ELECTRON_RUN_AS_NODE) Reflect.deleteProperty(environment, key)
  }
}

/**
 * Put the DSH-managed CLI wrapper directory first on PATH. Product commands
 * resolve through PATH at each call, so a later activation takes effect on the
 * next qualification or turn without restarting the daemon.
 * @param environment - daemon environment inherited by product Drivers.
 * @param root - Resident daemon state root beside the managed runtimes.
 */
export function preferManagedCliRuntimes(environment: NodeJS.ProcessEnv, root: string): void {
  const bin = managedCliBinDir(cliRuntimesRoot(root))
  const rest = (environment.PATH ?? '').split(delimiter).filter(entry => entry.length > 0 && entry !== bin)
  environment.PATH = [bin, ...rest].join(delimiter)
}

/**
 * Run one signal-aware Resident daemon until graceful closure.
 * @param root - owner-only daemon state root.
 * @param driverModules - absolute independent product Driver entries loaded before startup.
 * @returns after the daemon closes and signal listeners are removed.
 */
export async function runResidentDaemon(root: string, driverModules: readonly string[] = []): Promise<void> {
  clearElectronRunAsNode(process.env)
  preferManagedCliRuntimes(process.env, root)
  const external = await loadResidentProductDrivers(root, driverModules)
  const daemon = new ResidentDaemon({
    root,
    drivers: [new ClaudeCodeResidentDriver(), new CodexResidentDriver(), ...external],
    driverManifestHash: residentDriverManifestSha256(driverModules),
  })
  await daemon.start()
  const stop = (): void => { void daemon.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await daemon.closed
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function argumentValues(argv: readonly string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== name) continue
    const value = argv[index + 1]
    if (value === undefined || value.length === 0) throw new Error(`${name} needs a value`)
    values.push(value)
    index += 1
  }
  return values
}

function argumentRoot(argv: readonly string[]): string {
  const index = argv.indexOf('--root')
  if (index >= 0) {
    const value = argv[index + 1]
    if (value === undefined || value.length === 0) throw new Error('--root needs a path')
    return value
  }
  return `${resolveDshHome()}/resident-operators`
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invoked) {
  const argv = process.argv.slice(2)
  await runResidentDaemon(argumentRoot(argv), argumentValues(argv, '--driver-module'))
}
