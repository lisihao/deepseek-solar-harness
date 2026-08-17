/** App-private command projection for native-subscription Claude Code and Codex. */

import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path'

const DIRECTORY_MODE = 0o700
const EXECUTABLE_MODE = 0o700
const PRODUCT_COMMANDS = ['claude', 'codex'] as const

type NativeProductCommand = typeof PRODUCT_COMMANDS[number]

/** Inputs used to discover and project native product commands. */
export interface NativeProductRuntimeOptions {
  /** Host platform; the first release supports macOS only. */
  readonly platform: NodeJS.Platform
  /** User home used for deterministic product installation candidates. */
  readonly homeDir: string
  /** Private app-owned directory that receives command wrappers. */
  readonly stateDir: string
  /** Host environment whose PATH is projected and restored. */
  readonly environment?: NodeJS.ProcessEnv
}

/** Product command targets and reversible PATH projection. */
export interface NativeProductRuntimeInstallation {
  /** Absolute native command path when one qualified installation candidate exists. */
  readonly commands: Readonly<Partial<Record<NativeProductCommand, string>>>
  /** Remove this installation's private command directory from PATH. */
  dispose(): void
}

function optionalLstat(filename: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

function executable(filename: string): boolean {
  if (!isAbsolute(filename) || /[\0\r\n]/u.test(filename)) return false
  try {
    const stat = lstatSync(filename)
    if (!stat.isFile() && !stat.isSymbolicLink()) return false
    accessSync(filename, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function uniqueDirectories(values: readonly string[]): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (!isAbsolute(value) || value.includes('\0') || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/**
 * Resolve only well-known native product commands, without widening Finder's PATH.
 * @param options - platform, user home, and source environment.
 * @returns absolute executable candidates keyed by product command.
 */
export function resolveNativeProductCommands(
  options: Pick<NativeProductRuntimeOptions, 'platform' | 'homeDir' | 'environment'>,
): Readonly<Partial<Record<NativeProductCommand, string>>> {
  if (options.platform !== 'darwin') return {}
  const environment = options.environment ?? process.env
  const inheritedDirectories = (environment.PATH ?? '')
    .split(delimiter)
    .filter(value => value.length > 0)
  const directories = uniqueDirectories([
    ...inheritedDirectories,
    join(options.homeDir, '.local', 'bin'),
    join(options.homeDir, '.npm-global', 'bin'),
    join(options.homeDir, '.bun', 'bin'),
    join(options.homeDir, '.volta', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ])
  const commands: Partial<Record<NativeProductCommand, string>> = {}
  for (const command of PRODUCT_COMMANDS) {
    const candidate = directories.map(directory => join(directory, command)).find(executable)
    if (candidate !== undefined) commands[command] = candidate
  }
  return commands
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function replacePrivateExecutable(filename: string, content: string): void {
  const existing = optionalLstat(filename)
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`dsh-plugin-desktop: native product wrapper is not a regular file: ${filename}`)
  }
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: EXECUTABLE_MODE })
    chmodSync(temporary, EXECUTABLE_MODE)
    renameSync(temporary, filename)
  } finally {
    try {
      unlinkSync(temporary)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    }
  }
}

function removeWrapper(filename: string): void {
  const existing = optionalLstat(filename)
  if (existing === undefined) return
  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: stale native product wrapper is not a regular file: ${filename}`)
  }
  unlinkSync(filename)
}

function removePathDirectory(value: string, directory: string): string {
  return value.split(delimiter).filter(component => component !== directory).join(delimiter)
}

/**
 * Create two command-only wrappers and prepend their private directory to PATH.
 * Missing products remain unavailable and are reported later by Resident qualification.
 * @param options - platform, home, state directory, and mutable Host environment.
 * @returns resolved product targets and reversible PATH ownership.
 */
export function installNativeProductRuntime(
  options: NativeProductRuntimeOptions,
): NativeProductRuntimeInstallation {
  const environment = options.environment ?? process.env
  const commands = resolveNativeProductCommands(options)
  if (options.platform !== 'darwin') return { commands, dispose: () => {} }

  mkdirSync(options.stateDir, { recursive: true, mode: DIRECTORY_MODE })
  const state = lstatSync(options.stateDir)
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: native product runtime path is not a private directory: ${options.stateDir}`)
  }
  chmodSync(options.stateDir, DIRECTORY_MODE)

  for (const command of PRODUCT_COMMANDS) {
    const wrapper = join(options.stateDir, command)
    const target = commands[command]
    if (target === undefined) {
      removeWrapper(wrapper)
      continue
    }
    replacePrivateExecutable(wrapper, [
      '#!/bin/sh',
      `exec ${quoteShell(target)} "$@"`,
      '',
    ].join('\n'))
  }

  const currentPath = environment.PATH ?? ''
  const withoutPrivate = removePathDirectory(currentPath, options.stateDir)
  environment.PATH = withoutPrivate.length === 0
    ? options.stateDir
    : `${options.stateDir}${delimiter}${withoutPrivate}`
  let disposed = false
  return {
    commands,
    dispose: () => {
      if (disposed) return
      disposed = true
      const updated = removePathDirectory(environment.PATH ?? '', options.stateDir)
      if (updated.length === 0) Reflect.deleteProperty(environment, 'PATH')
      else environment.PATH = updated
    },
  }
}
