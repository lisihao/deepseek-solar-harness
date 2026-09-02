/** Isolated command-line environment launched from the DSH Desktop tray. */

import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { assertDesktopProfileName } from './profile-manager.ts'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const DEFAULT_PROFILE = 'DSH_DESKTOP_DEFAULT_PROFILE'
const DSH_HOME = 'DSH_HOME'
const PATH = 'PATH'
const STATE_DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'

/** Process launcher injected by the Electron adapter. */
export type DesktopTerminalSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

/** Inputs for one isolated desktop terminal launch. */
export interface DesktopTerminalOptions {
  /** Host platform selecting the generated scripts and native launcher. */
  platform: NodeJS.Platform
  /** Electron executable reused as Node by command shims. */
  appExecutable: string
  /** Desktop-owned bootstrap that clears Node mode before importing the `dsh` CLI. */
  dshBootstrapPath: string
  /** Packaged JavaScript entry for the `pnpm` CLI. */
  pnpmBinPath: string
  /** Electron version used by pnpm native dependency installation. */
  electronVersion: string
  /** DSH profile selected by the desktop application. */
  profileName: string
  /** Product version displayed in the welcome message. */
  productVersion: string
  /** Absolute working directory of the selected profile. */
  profileDir: string
  /** Harness home exported as `DSH_HOME` inside the terminal. */
  homeDir: string
  /** Private directory receiving the generated terminal files. */
  stateDir: string
  /** Process launcher; production passes `node:child_process.spawn`. */
  spawn: DesktopTerminalSpawn
  /** Environment copied into the terminal child; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Reporter attached before the platform launcher can emit an asynchronous failure. */
  onLaunchError?: (cause: Error) => void
}

/** Files and process created for one desktop terminal launch. */
export interface DesktopTerminalLaunch {
  /** Private directory prepended to this terminal's `PATH`. */
  shimDir: string
  /** Generated platform-specific `dsh` shim. */
  dshShimPath: string
  /** Generated platform-specific `pnpm` shim. */
  pnpmShimPath: string
  /** Generated platform-specific `node` shim backed by Electron's Node mode. */
  nodeShimPath: string
  /** Generated script that configures and welcomes the interactive shell. */
  welcomePath: string
  /** Short-lived platform launcher; callers may observe its asynchronous failure. */
  child: ChildProcess
}

/**
 * Keep generated command shims stable for one selected profile.
 * @param userDataDir - Electron-owned persistent data directory.
 * @param profileName - profile embedded in the generated DSH shim.
 * @returns private per-profile terminal state directory.
 */
export function desktopTerminalStateDirectory(userDataDir: string, profileName: string): string {
  assertScriptValue('user data directory', userDataDir)
  assertDesktopProfileName(profileName)
  const identity = createHash('sha256').update(profileName, 'utf8').digest('hex')
  return join(userDataDir, 'cli', identity)
}

interface DesktopTerminalFiles {
  shimDir: string
  dshShimPath: string
  pnpmShimPath: string
  nodeShimPath: string
  welcomePath: string
}

/** Reject values that cannot be represented safely in generated command files. */
function assertScriptValue(label: string, value: string): void {
  if (value.length === 0) throw new Error(`dsh-plugin-desktop: terminal ${label} must not be empty`)
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`dsh-plugin-desktop: terminal ${label} must not contain NUL or newlines`)
  }
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Remove a temporary file while preserving every error except absence. */
function unlinkTemporaryFile(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

/** Replace one generated file without following a pre-existing target symlink. */
function replacePrivateFile(filename: string, contents: string, mode: number): void {
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, filename)
  } finally {
    unlinkTemporaryFile(temporary)
  }
}

/** Create and verify the private directory holding terminal launch files. */
function prepareStateDirectory(stateDir: string): void {
  mkdirSync(stateDir, { recursive: true, mode: STATE_DIRECTORY_MODE })
  const stat = lstatSync(stateDir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: terminal state path is not a private directory: ${stateDir}`)
  }
  chmodSync(stateDir, STATE_DIRECTORY_MODE)
}

/** Build a command shim that enables Electron's Node mode only for its child. */
function macShim(appExecutable: string, binPath?: string): string {
  const entry = binPath === undefined ? '' : ` ${quoteSh(binPath)}`
  return [
    '#!/bin/sh',
    `${RUN_AS_NODE}=1 exec ${quoteSh(appExecutable)}${entry} "$@"`,
    '',
  ].join('\n')
}

/** Build the DSH shim with Loader internals and one process-local default profile. */
function macDshShim(options: DesktopTerminalOptions): string {
  return [
    '#!/bin/sh',
    [
      `${DEFAULT_PROFILE}=${quoteSh(options.profileName)}`,
      `${RUN_AS_NODE}=1`,
      `exec ${quoteSh(options.appExecutable)} --expose-internals ${quoteSh(options.dshBootstrapPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build a pnpm shim with Electron native-module settings scoped to its process tree. */
function macPnpmShim(options: DesktopTerminalOptions): string {
  return [
    '#!/bin/sh',
    [
      `${RUN_AS_NODE}=1`,
      'npm_config_runtime=electron',
      `npm_config_target=${quoteSh(options.electronVersion)}`,
      `npm_config_disturl=${quoteSh(ELECTRON_HEADERS_URL)}`,
      `exec ${quoteSh(options.appExecutable)} ${quoteSh(options.pnpmBinPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build a zsh startup file that preserves the user's rc and then restores desktop variables. */
function macZshRc(options: DesktopTerminalOptions, shimDir: string): string {
  return [
    'if [[ -n "${DSH_DESKTOP_USER_ZDOTDIR:-}" && -r "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc" ]]; then',
    '  ZDOTDIR="${DSH_DESKTOP_USER_ZDOTDIR}"',
    '  source "${DSH_DESKTOP_USER_ZDOTDIR}/.zshrc"',
    'fi',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    'typeset -U path',
    `path=(${quoteSh(shimDir)} $path)`,
    'export PATH',
    `unset DSH_DESKTOP_USER_ZDOTDIR`,
    '',
  ].join('\n')
}

/** Build a bash startup file that preserves the user's rc and then restores desktop variables. */
function macBashRc(options: DesktopTerminalOptions, shimDir: string): string {
  return [
    'if [ -n "${DSH_DESKTOP_USER_BASHRC:-}" ] && [ -r "${DSH_DESKTOP_USER_BASHRC}" ]; then',
    '  . "${DSH_DESKTOP_USER_BASHRC}"',
    'fi',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    'case ":${PATH:-}:" in',
    `  *:${quoteSh(shimDir)}:*) ;;`,
    `  *) export PATH=${quoteSh(shimDir)}:"\${PATH:-}" ;;`,
    'esac',
    'unset DSH_DESKTOP_USER_BASHRC',
    '',
  ].join('\n')
}

/** Build the macOS script opened by LaunchServices in the user's terminal. */
function macWelcome(
  options: DesktopTerminalOptions,
  shimDir: string,
  bashRcPath: string,
): string {
  const commandHelp = 'dsh --dump-config'
  const pluginAdd = 'dsh plugin add <third-party-plugin>'
  const pluginRemove = 'dsh plugin remove <third-party-plugin>'
  const pluginUpdate = 'dsh plugin update'
  return [
    '#!/bin/sh',
    `unset ${RUN_AS_NODE}`,
    `export ${DSH_HOME}=${quoteSh(options.homeDir)}`,
    `export PATH=${quoteSh(shimDir)}:"\${PATH:-}"`,
    `cd ${quoteSh(options.profileDir)}`,
    "printf '\\033[2J\\033[3J\\033[H'",
    `printf '%s\\n' ${quoteSh(`DSH Desktop ${options.productVersion} terminal`)}`,
    `printf '%s\\n' ${quoteSh(`Profile: ${options.profileName}`)}`,
    `printf '%s\\n' ${quoteSh(`Profile directory: ${options.profileDir}`)}`,
    `printf '%s\\n' ${quoteSh(`Harness home: ${options.homeDir}`)}`,
    `printf '%s\\n' ${quoteSh(`Plugin commands without --profile modify the ${options.profileName} profile.`)}`,
    `printf '%s\\n' ${quoteSh('Commands:')}`,
    `printf '  %s\\n' ${quoteSh(commandHelp)}`,
    `printf '  %s\\n' ${quoteSh(pluginAdd)}`,
    `printf '  %s\\n' ${quoteSh(pluginRemove)}`,
    `printf '  %s\\n' ${quoteSh(pluginUpdate)}`,
    `printf '%s\\n' ${quoteSh('Restart DSH Desktop after plugin changes.')}`,
    'case "${SHELL:-/bin/zsh}" in',
    '  */bash)',
    '    export DSH_DESKTOP_USER_BASHRC="${HOME:-}/.bashrc"',
    `    exec "\${SHELL}" --noprofile --rcfile ${quoteSh(bashRcPath)} -i`,
    '    ;;',
    '  */zsh)',
    '    export DSH_DESKTOP_USER_ZDOTDIR="${ZDOTDIR:-${HOME:-}}"',
    `    export ZDOTDIR=${quoteSh(options.stateDir)}`,
    '    exec "${SHELL}" -i',
    '    ;;',
    '  *)',
    '    export DSH_DESKTOP_USER_ZDOTDIR="${ZDOTDIR:-${HOME:-}}"',
    `    export ZDOTDIR=${quoteSh(options.stateDir)}`,
    '    exec /bin/zsh -i',
    '    ;;',
    'esac',
    '',
  ].join('\n')
}

/** Create command shims and the interactive welcome script. */
function prepareDesktopTerminalFiles(options: DesktopTerminalOptions): DesktopTerminalFiles {
  if (options.platform !== 'darwin') {
    throw new Error(`dsh-plugin-desktop: terminal is unsupported on ${options.platform}`)
  }
  assertDesktopProfileName(options.profileName)
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['dsh bootstrap', options.dshBootstrapPath],
    ['pnpm entry', options.pnpmBinPath],
    ['Electron version', options.electronVersion],
    ['profile directory', options.profileDir],
    ['Harness home', options.homeDir],
    ['state directory', options.stateDir],
    ['product version', options.productVersion],
  ] as const) assertScriptValue(label, value)

  prepareStateDirectory(options.stateDir)
  const shimDir = join(options.stateDir, 'bin')
  prepareStateDirectory(shimDir)
  const files: DesktopTerminalFiles = {
    shimDir,
    dshShimPath: join(shimDir, 'dsh'),
    pnpmShimPath: join(shimDir, 'pnpm'),
    nodeShimPath: join(shimDir, 'node'),
    welcomePath: join(options.stateDir, 'welcome.command'),
  }
  const bashRcPath = join(options.stateDir, 'bashrc')
  replacePrivateFile(files.dshShimPath, macDshShim(options), EXECUTABLE_FILE_MODE)
  replacePrivateFile(files.pnpmShimPath, macPnpmShim(options), EXECUTABLE_FILE_MODE)
  replacePrivateFile(files.nodeShimPath, macShim(options.appExecutable), EXECUTABLE_FILE_MODE)
  replacePrivateFile(join(options.stateDir, '.zshrc'), macZshRc(options, shimDir), PRIVATE_FILE_MODE)
  replacePrivateFile(bashRcPath, macBashRc(options, shimDir), PRIVATE_FILE_MODE)
  replacePrivateFile(files.welcomePath, macWelcome(options, shimDir, bashRcPath), EXECUTABLE_FILE_MODE)
  return files
}

/** Copy the Host environment and scope desktop command discovery to one terminal child. */
function terminalEnvironment(options: DesktopTerminalOptions, files: DesktopTerminalFiles): NodeJS.ProcessEnv {
  const source = options.environment ?? process.env
  const env: NodeJS.ProcessEnv = {}
  let inheritedPath: string | undefined
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase()
    if (normalized === RUN_AS_NODE || normalized === DSH_HOME) continue
    if (normalized === PATH) {
      inheritedPath ??= value
      continue
    }
    env[key] = value
  }
  env[PATH] = inheritedPath === undefined || inheritedPath.length === 0
    ? files.shimDir
    : `${files.shimDir}:${inheritedPath}`
  env[DSH_HOME] = options.homeDir
  return env
}

/** Report a launcher error without leaving an unhandled EventEmitter error. */
function reportLaunchError(options: DesktopTerminalOptions, cause: Error): void {
  if (options.onLaunchError !== undefined) {
    try {
      options.onLaunchError(cause)
      return
    } catch (reportCause) {
      const detail = reportCause instanceof Error ? reportCause.message : String(reportCause)
      process.stderr.write(`dsh-plugin-desktop: terminal error reporter failed: ${detail}\n`)
      return
    }
  }
  process.stderr.write(`dsh-plugin-desktop: failed to open terminal: ${cause.message}\n`)
}

/**
 * Generate a private desktop CLI environment and open it in a native terminal.
 * @param options - packaged CLI paths, profile identity, private state, and process adapter.
 * @returns generated file paths and the platform launcher process.
 */
export function openDesktopTerminal(options: DesktopTerminalOptions): DesktopTerminalLaunch {
  const files = prepareDesktopTerminalFiles(options)
  const env = terminalEnvironment(options, files)
  const command = '/usr/bin/open'
  const args = ['-a', 'Terminal', files.welcomePath]
  const spawnOptions: SpawnOptions = {
    cwd: options.profileDir,
    detached: true,
    env,
    shell: false,
    stdio: 'ignore',
  }
  const child = options.spawn(command, args, spawnOptions)
  let launchFailureReported = false
  const reportLaunchFailure = (cause: Error): void => {
    if (launchFailureReported) return
    launchFailureReported = true
    reportLaunchError(options, cause)
  }
  child.once('error', reportLaunchFailure)
  child.once('exit', (code, signal) => {
    if (code === 0) return
    const outcome = code === null
      ? `signal ${signal ?? 'unknown'}`
      : `code ${String(code)}`
    reportLaunchFailure(new Error(`terminal launcher exited with ${outcome}`))
  })
  child.unref()
  return {
    shimDir: files.shimDir,
    dshShimPath: files.dshShimPath,
    pnpmShimPath: files.pnpmShimPath,
    nodeShimPath: files.nodeShimPath,
    welcomePath: files.welcomePath,
    child,
  }
}
