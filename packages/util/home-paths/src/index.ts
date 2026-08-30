/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { createHash } from 'node:crypto'
import { opendir, realpath } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const MACOS_UNIX_SOCKET_PATH_MAX_BYTES = 103
const LOCAL_IPC_DIGEST_LENGTH = 24
const LOCAL_IPC_CHANNEL_LABEL_LENGTH = 16

/** Directory name for the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the default DeepSeek Harness home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Resolve one owner-local IPC endpoint without exposing filesystem-only socket
 * assumptions to callers. Windows named pipes are derived from the canonical
 * root and channel. POSIX platforms keep short endpoints inside their owner
 * directory and map longer endpoints into a deterministic owner-specific
 * temporary directory that fits the macOS Unix-socket path limit.
 * @param root - owner-local state directory for the daemon or bridge.
 * @param channel - short diagnostic channel name such as `control` or `rlm`.
 * @param platform - platform override used by cross-platform contract tests.
 * @returns a Unix-domain socket path or Windows named-pipe address.
 */
export function localIpcAddress(
  root: string,
  channel: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalizedChannel = channel.trim().replace(/[^a-z0-9._-]+/giu, '-').replace(/^-+|-+$/gu, '')
  if (normalizedChannel.length === 0) throw new Error('local IPC channel must be non-blank')
  const resolvedRoot = resolve(root)
  if (platform !== 'win32') {
    const directAddress = join(resolvedRoot, `${normalizedChannel}.sock`)
    if (Buffer.byteLength(directAddress) <= MACOS_UNIX_SOCKET_PATH_MAX_BYTES) return directAddress

    const owner = userInfo()
    const ownerIdentity = createHash('sha256')
      .update(`${owner.uid}\0${owner.username}\0${owner.homedir}`)
      .digest('hex')
      .slice(0, 12)
    const digest = createHash('sha256')
      .update(`${resolvedRoot}\0${normalizedChannel}`)
      .digest('hex')
      .slice(0, LOCAL_IPC_DIGEST_LENGTH)
    const filename = `${normalizedChannel.slice(0, LOCAL_IPC_CHANNEL_LABEL_LENGTH)}-${digest}.sock`
    const ownerDirectory = `dsh-ipc-${ownerIdentity}`
    const preferredAddress = join(tmpdir(), ownerDirectory, filename)
    if (Buffer.byteLength(preferredAddress) <= MACOS_UNIX_SOCKET_PATH_MAX_BYTES) return preferredAddress
    return join('/tmp', ownerDirectory, filename)
  }
  const digest = createHash('sha256')
    .update(`${resolvedRoot}\0${normalizedChannel}`)
    .digest('hex')
    .slice(0, LOCAL_IPC_DIGEST_LENGTH)
  return `\\\\.\\pipe\\dsh-${normalizedChannel}-${digest}`
}

/**
 * Whether local IPC uses an address represented by a filesystem entry.
 * @param platform - platform override used by cross-platform contract tests.
 * @returns true for POSIX socket paths and false for Windows named pipes.
 */
export function localIpcUsesFilesystem(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32'
}

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve the single-root DeepSeek Harness home.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_HOME`, then
 * `~/.dsh`. The harness keeps all user data under one root. An empty or
 * whitespace-only `$DSH_HOME` is treated as unset, so a blank override never
 * resolves the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.dsh`, and any configured home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.dsh` for the default home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultDshHome()) ? DEFAULT_DSH_HOME_DISPLAY : `$${DSH_HOME_ENV}`
}
