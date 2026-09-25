/** App-local pnpm command environment available to desktop Host plugins. */

import { randomUUID } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'

const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE'
const PATH = 'PATH'
const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'
const DIRECTORY_MODE = 0o700
const EXECUTABLE_FILE_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const TEMPORARY_ID = /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

/** Inputs used to install one app-local pnpm command environment. */
export interface DesktopPnpmRuntimeOptions {
  /** Host platform selecting POSIX or Windows command shims. */
  platform: NodeJS.Platform
  /** Electron executable reused in RunAsNode mode. */
  appExecutable: string
  /** Physical packaged pnpm JavaScript entry. */
  pnpmBinPath: string
  /** Electron version used when pnpm installs native dependencies. */
  electronVersion: string
  /** Private application-owned directory receiving generated files. */
  stateDir: string
  /** Parent environment whose PATH is updated; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv
  /** Optional real Node/helper executable used by detached headless daemons. */
  headlessNodeExecutable?: string
}

/** Files and reversible PATH update created for the Host runtime. */
export interface DesktopPnpmRuntimeInstallation {
  /** Public directory prepended to the Host PATH; it contains only pnpm. */
  pathDir: string
  /** Public pnpm command shim. */
  pnpmShimPath: string
  /** Private directory made visible only inside the pnpm process tree. */
  nodeBinDir: string
  /** Private Node command shim used by pnpm lifecycle scripts. */
  nodeShimPath: string
  /** Preloaded module that removes Electron RunAsNode from child environments. */
  clearEnvironmentPath: string
  /** Headless Node launcher used by detached daemons; never points at the APPL binary. */
  headlessNodePath: string
  /** Remove this installation's PATH entry without deleting persistent generated files. */
  dispose(): void
}

/** Reject a value that cannot be represented in a generated command file. */
function assertScriptValue(label: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`dsh-plugin-desktop: pnpm runtime ${label} must not be empty`)
  }
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`dsh-plugin-desktop: pnpm runtime ${label} must not contain NUL or newlines`)
  }
}

/** Quote one arbitrary value as a POSIX shell word. */
function quoteSh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** Quote one Windows batch argv word without permitting quote injection. */
function quoteBatchWord(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new Error('dsh-plugin-desktop: pnpm runtime Windows arguments must not contain quotes or newlines')
  }
  return `"${value.replaceAll('%', '%%')}"`
}

/** Escape a value inside the quoted right-hand side of a batch `set` command. */
function escapeBatchSetValue(value: string): string {
  if (/["\r\n]/u.test(value)) {
    throw new Error('dsh-plugin-desktop: pnpm runtime Windows environment values must not contain quotes or newlines')
  }
  return value.replaceAll('%', '%%')
}

/** Return one lstat result, preserving every failure except absence. */
function lstatOptional(filename: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw cause
  }
}

/** Create one owner-only real directory and reject a pre-existing alternate file type. */
function preparePrivateDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`dsh-plugin-desktop: pnpm runtime path is not a private directory: ${directory}`)
  }
  chmodSync(directory, DIRECTORY_MODE)
}

/** Reject command-directory entries not owned by this runtime generation. */
function assertOwnedDirectoryEntries(directory: string, allowed: readonly string[]): void {
  const unexpected = readdirSync(directory).filter(entry => !allowed.includes(entry))
  if (unexpected.length > 0) {
    throw new Error(
      `dsh-plugin-desktop: pnpm runtime directory contains unexpected entries: ${unexpected.join(', ')}`,
    )
  }
}

/** Remove only stale atomic-write files generated for one exact target name. */
function removeStaleTemporaryFiles(directory: string, targetName: string): void {
  const prefix = `.${targetName}.`
  const suffix = '.tmp'
  for (const entry of readdirSync(directory)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) continue
    const identity = entry.slice(prefix.length, -suffix.length)
    if (!TEMPORARY_ID.test(identity)) continue
    const filename = join(directory, entry)
    const stat = lstatSync(filename)
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`dsh-plugin-desktop: pnpm runtime stale temporary path is not a file: ${filename}`)
    }
    unlinkSync(filename)
  }
}

/** Remove a temporary file while preserving every failure except absence. */
function unlinkTemporaryFile(filename: string): void {
  try {
    unlinkSync(filename)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
  }
}

/** Atomically replace one regular app-owned file without accepting a symlink target. */
function replacePrivateFile(filename: string, contents: string, mode: number): void {
  const existing = lstatOptional(filename)
  if (existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`dsh-plugin-desktop: pnpm runtime file is not a regular file: ${filename}`)
  }
  const temporary = join(dirname(filename), `.${basename(filename)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, filename)
  } finally {
    unlinkTemporaryFile(temporary)
  }
}

/** Module preloaded into RunAsNode children before their requested entry. */
function clearEnvironmentModule(): string {
  return [
    `for (const name of Object.keys(process.env)) {`,
    `  if (name.toUpperCase() === '${RUN_AS_NODE}') delete process.env[name]`,
    '}',
    '',
  ].join('\n')
}

/** Build the private POSIX Node command used only by pnpm lifecycle scripts. */
function posixNodeShim(appExecutable: string, clearEnvironmentUrl: string): string {
  return [
    '#!/bin/sh',
    `${RUN_AS_NODE}=1 exec ${quoteSh(appExecutable)} --import ${quoteSh(clearEnvironmentUrl)} "$@"`,
    '',
  ].join('\n')
}

/** Build the public POSIX pnpm command. */
function posixPnpmShim(
  options: DesktopPnpmRuntimeOptions,
  nodeBinDir: string,
  nodeShimPath: string,
  clearEnvironmentUrl: string,
): string {
  return [
    '#!/bin/sh',
    [
      `PATH=${quoteSh(nodeBinDir)}:"\${PATH:-}"`,
      `NODE=${quoteSh(nodeShimPath)}`,
      `${RUN_AS_NODE}=1`,
      'npm_config_runtime=electron',
      `npm_config_target=${quoteSh(options.electronVersion)}`,
      `npm_config_disturl=${quoteSh(ELECTRON_HEADERS_URL)}`,
      `exec ${quoteSh(options.appExecutable)} --import ${quoteSh(clearEnvironmentUrl)} ${quoteSh(options.pnpmBinPath)} "$@"`,
    ].join(' '),
    '',
  ].join('\n')
}

/** Build the private Windows Node command used only by pnpm lifecycle scripts. */
function windowsNodeShim(appExecutable: string, clearEnvironmentUrl: string): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    `${quoteBatchWord(appExecutable)} --import ${quoteBatchWord(clearEnvironmentUrl)} %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

/** Build the public Windows pnpm command. */
function windowsPnpmShim(
  options: DesktopPnpmRuntimeOptions,
  nodeBinDir: string,
  nodeShimPath: string,
  clearEnvironmentUrl: string,
): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "PATH=${escapeBatchSetValue(nodeBinDir)};%PATH%"`,
    `set "NODE=${escapeBatchSetValue(nodeShimPath)}"`,
    `set "${RUN_AS_NODE}=1"`,
    'set "npm_config_runtime=electron"',
    `set "npm_config_target=${escapeBatchSetValue(options.electronVersion)}"`,
    `set "npm_config_disturl=${ELECTRON_HEADERS_URL}"`,
    `${quoteBatchWord(options.appExecutable)} --import ${quoteBatchWord(clearEnvironmentUrl)} ${quoteBatchWord(options.pnpmBinPath)} %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}

interface PathEntry {
  key: string
  value: string | undefined
}

/** Return the environment entries addressing PATH on the selected platform. */
function pathEntries(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): PathEntry[] {
  return Object.entries(environment)
    .filter(([key]) => platform === 'win32' ? key.toUpperCase() === PATH : key === PATH)
    .map(([key, value]) => ({ key, value }))
}

/** Normalize one PATH component for duplicate detection. */
function normalizedPathComponent(component: string, platform: NodeJS.Platform): string {
  const unquoted = platform === 'win32' && component.startsWith('"') && component.endsWith('"')
    ? component.slice(1, -1)
    : component
  return platform === 'win32' ? unquoted.toLowerCase() : unquoted
}

/** Remove every occurrence of one directory from a PATH value. */
function withoutPathDirectory(value: string, directory: string, platform: NodeJS.Platform): string {
  const delimiter = platform === 'win32' ? ';' : ':'
  const target = normalizedPathComponent(directory, platform)
  return value
    .split(delimiter)
    .filter(component => normalizedPathComponent(component, platform) !== target)
    .join(delimiter)
}

/** Prepend one directory to PATH and return an idempotent, non-clobbering disposer. */
function installPathDirectory(
  environment: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform,
): () => void {
  const original = pathEntries(environment, platform)
  const current = original.find(entry => entry.value !== undefined)
  const currentValue = current?.value ?? ''
  if (withoutPathDirectory(currentValue, directory, platform) !== currentValue) return () => {}

  const key = current?.key ?? PATH
  const delimiter = platform === 'win32' ? ';' : ':'
  const installedValue = currentValue.length === 0 ? directory : `${directory}${delimiter}${currentValue}`
  for (const entry of original) delete environment[entry.key]
  environment[key] = installedValue

  let active = true
  return () => {
    if (!active) return
    active = false
    const latest = pathEntries(environment, platform)
    if (latest.length === 1 && latest[0]?.key === key && latest[0].value === installedValue) {
      delete environment[key]
      for (const entry of original) environment[entry.key] = entry.value
      return
    }
    for (const entry of latest) {
      if (entry.value === undefined) continue
      environment[entry.key] = withoutPathDirectory(entry.value, directory, platform)
    }
  }
}

/**
 * Install the packaged pnpm command into this Electron process's PATH.
 * @param options - packaged executable paths, platform, private state, and parent environment.
 * @returns generated file paths and an idempotent PATH disposer.
 */
export function installDesktopPnpmRuntime(options: DesktopPnpmRuntimeOptions): DesktopPnpmRuntimeInstallation {
  if (options.platform !== 'darwin' && options.platform !== 'linux' && options.platform !== 'win32') {
    throw new Error(`dsh-plugin-desktop: pnpm runtime is unsupported on ${options.platform}`)
  }
  for (const [label, value] of [
    ['application executable', options.appExecutable],
    ['pnpm entry', options.pnpmBinPath],
    ['Electron version', options.electronVersion],
    ['state directory', options.stateDir],
    ...(options.headlessNodeExecutable === undefined
      ? []
      : [['headless Node executable', options.headlessNodeExecutable] as const]),
  ] as const) assertScriptValue(label, value)
  if (options.headlessNodeExecutable !== undefined
    && platformResolve(options.headlessNodeExecutable, options.platform).toLowerCase()
      === platformResolve(options.appExecutable, options.platform).toLowerCase()) {
    throw new Error('dsh-plugin-desktop: headless Node executable must not be the Electron application executable')
  }


  const pathDir = join(options.stateDir, 'bin')
  const privateDir = join(options.stateDir, 'private')
  const nodeBinDir = join(privateDir, 'node-bin')
  preparePrivateDirectory(options.stateDir)
  preparePrivateDirectory(pathDir)
  preparePrivateDirectory(privateDir)
  preparePrivateDirectory(nodeBinDir)

  const windows = options.platform === 'win32'
  const pnpmShimName = windows ? 'pnpm.cmd' : 'pnpm'
  const nodeShimName = windows ? 'node.cmd' : 'node'
  const headlessNodeName = windows ? 'headless-node.cmd' : 'headless-node'
  const headlessNodeExecutable = options.headlessNodeExecutable
    ?? (process.versions.electron === undefined
      ? process.execPath
      : resolveHeadlessNodeExecutable({
        platform: options.platform,
        appExecutable: options.appExecutable,
        ...options.environment === undefined ? {} : { environment: options.environment },
      }) ?? options.appExecutable)
  removeStaleTemporaryFiles(pathDir, pnpmShimName)
  removeStaleTemporaryFiles(nodeBinDir, nodeShimName)
  removeStaleTemporaryFiles(privateDir, 'clear-env.mjs')
  removeStaleTemporaryFiles(privateDir, headlessNodeName)
  assertOwnedDirectoryEntries(pathDir, [pnpmShimName])
  assertOwnedDirectoryEntries(nodeBinDir, [nodeShimName])
  assertOwnedDirectoryEntries(privateDir, ['clear-env.mjs', 'node-bin', headlessNodeName])
  const pnpmShimPath = join(pathDir, pnpmShimName)
  const nodeShimPath = join(nodeBinDir, nodeShimName)
  const clearEnvironmentPath = join(privateDir, 'clear-env.mjs')
  replacePrivateFile(clearEnvironmentPath, clearEnvironmentModule(), PRIVATE_FILE_MODE)
  const headlessNodePath = join(privateDir, headlessNodeName)
  const clearEnvironmentUrl = pathToFileURL(clearEnvironmentPath).href
  replacePrivateFile(
    nodeShimPath,
    windows
      ? windowsNodeShim(options.appExecutable, clearEnvironmentUrl)
      : posixNodeShim(options.appExecutable, clearEnvironmentUrl),
    windows ? PRIVATE_FILE_MODE : EXECUTABLE_FILE_MODE,
  )
  replacePrivateFile(
    pnpmShimPath,
    windows
      ? windowsPnpmShim(options, nodeBinDir, nodeShimPath, clearEnvironmentUrl)
      : posixPnpmShim(options, nodeBinDir, nodeShimPath, clearEnvironmentUrl),
    windows ? PRIVATE_FILE_MODE : EXECUTABLE_FILE_MODE,
  )
  replacePrivateFile(
    headlessNodePath,
    windows
      ? windowsHeadlessNodeShim(headlessNodeExecutable)
      : posixHeadlessNodeShim(headlessNodeExecutable),
    windows ? PRIVATE_FILE_MODE : EXECUTABLE_FILE_MODE,
  )

  return {
    pathDir,
    pnpmShimPath,
    nodeBinDir,
    nodeShimPath,
    clearEnvironmentPath,
    headlessNodePath,
    dispose: installPathDirectory(options.environment ?? process.env, pathDir, options.platform),
  }
}
/** Return whether one candidate is an executable regular file or symlink. */
function isExecutableFile(filename: string): boolean {
  try {
    const stat = lstatSync(filename)
    if (!stat.isFile() && !stat.isSymbolicLink()) return false
    accessSync(filename, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve one absolute path using the selected platform's path rules. */
function platformAbsolute(filename: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' ? win32.isAbsolute(filename) : isAbsolute(filename)
}

/** Resolve one candidate path using the selected platform's path rules. */
function platformResolve(filename: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? win32.resolve(filename) : resolve(filename)
}

/** Find a packaged background Helper or real Node without selecting the Electron APPL. */
export function resolveHeadlessNodeExecutable(options: {
  platform: NodeJS.Platform
  appExecutable: string
  environment?: NodeJS.ProcessEnv
}): string | undefined {
  const environment = options.environment ?? process.env
  const pathKey = Object.keys(environment).find(key => (
    options.platform === 'win32' ? key.toUpperCase() === PATH : key === PATH
  ))
  const pathValue = pathKey === undefined ? undefined : environment[pathKey]
  const delimiter = options.platform === 'win32' ? ';' : ':'
  const executableNames = options.platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node']
  const pathCandidates = (pathValue ?? '')
    .split(delimiter)
    .map(directory => directory.trim().replace(/^"|"$/gu, ''))
    .filter(directory => platformAbsolute(directory, options.platform))
    .flatMap(directory => executableNames.map(name => (
      options.platform === 'win32' ? win32.join(directory, name) : join(directory, name)
    )))
  const fixedCandidates = options.platform === 'darwin'
    ? ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']
    : options.platform === 'linux'
      ? ['/usr/local/bin/node', '/usr/bin/node']
      : []
  const packagedHelper = options.platform === 'darwin'
    ? resolve(
      dirname(options.appExecutable),
      '..',
      'Frameworks',
      `${basename(options.appExecutable)} Helper.app`,
      'Contents',
      'MacOS',
      `${basename(options.appExecutable)} Helper`,
    )
    : undefined
  const appExecutable = platformResolve(options.appExecutable, options.platform).toLowerCase()
  for (const candidate of [packagedHelper, ...pathCandidates, ...fixedCandidates]) {
    if (candidate === undefined) continue
    if (!platformAbsolute(candidate, options.platform)) continue
    if (platformResolve(candidate, options.platform).toLowerCase() === appExecutable) continue
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}
/** Build a detached-daemon launcher that does not execute the Electron APPL. */
function posixHeadlessNodeShim(headlessNodeExecutable: string | undefined): string {
  return [
    '#!/bin/sh',
    'export ELECTRON_RUN_AS_NODE=1',
    headlessNodeExecutable === undefined
      ? 'exec /usr/bin/env node "$@"'
      : `exec ${quoteSh(headlessNodeExecutable)} "$@"`,
    '',
  ].join('\n')
}

/** Build a detached-daemon launcher that does not execute the Electron APPL. */
function windowsHeadlessNodeShim(headlessNodeExecutable: string | undefined): string {
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    `set "${RUN_AS_NODE}=1"`,
    headlessNodeExecutable === undefined
      ? 'node.exe %*'
      : `${quoteBatchWord(headlessNodeExecutable)} %*`,
    'exit /b %errorlevel%',
    '',
  ].join('\r\n')
}
