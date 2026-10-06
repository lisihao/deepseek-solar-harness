/** Member operations on the machine this module runs on: the local host, and the agent an SSH host runs. */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalRemoteRepositoryIdentity } from '@deepseek-ai/dsh-client-connection'
import type { GouziFolderListing, GouziProjectSource, GouziProvisionInput } from '@deepseek-ai/dsh-ui-gouzi'
import { GouziSupervisor } from './gouzi-supervisor.ts'

/** Settings of one machine's member operations. */
export interface LocalGouziConfig {
  /** Directory that holds one home per member. */
  readonly membersRoot: string
  /** Members that may run at once on this machine. */
  readonly activeLimit: number
  /** Longest wait for a started member to report ready, in milliseconds. */
  readonly readyTimeoutMs: number
  /** Longest wait after SIGTERM before a member is killed, in milliseconds. */
  readonly stopTimeoutMs: number
  /** Longest wait for one Git inspection when a project is resolved, in milliseconds. */
  readonly gitTimeoutMs: number
  /** Launcher script of one member; defaults to the `dsh-gouzi-worker` entry next to this module. */
  readonly workerScript?: string
  /** Node options placed before the launcher script, for example a TypeScript loader when running from source. */
  readonly nodeArgs: readonly string[]
}

/** Member process facts reported to the caller. */
export interface LocalGouziStarted {
  readonly port: number
  readonly pid: number
  readonly incarnation: number
}

/** Upper bound on the subdirectories one listing returns. */
const BROWSE_ENTRY_LIMIT = 500

const execFileAsync = promisify(execFile)

async function git(source: string, args: readonly string[], timeout: number): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CEILING_DIRECTORIES']) delete env[key]
  const result = await execFileAsync('git', [...args], { cwd: source, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 })
  return result.stdout.trim()
}

async function hasGitMarker(source: string): Promise<boolean> {
  let directory = source
  for (;;) {
    try {
      await lstat(join(directory, '.git'))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

async function inspectProject(path: string, timeout: number): Promise<{ project: GouziProjectSource; git: boolean }> {
  const source = await realpath(resolve(path))
  if (!(await stat(source)).isDirectory()) throw Object.assign(new Error(`project path is not a directory: ${source}`), { code: 'ENOTDIR' })
  const marked = await hasGitMarker(source)
  let initialized = false
  try {
    await git(source, ['rev-parse', '--git-dir'], timeout)
    initialized = true
  } catch (error) {
    // Only Git's explicit non-repository result without existing metadata denotes an ordinary directory.
    const failure = error as { code?: number; stderr?: string }
    if (marked || failure.code !== 128 || !failure.stderr?.includes('not a git repository')) throw error
  }
  let repository: string | undefined
  if (initialized) {
    let origin: string | undefined
    try {
      origin = await git(source, ['config', '--local', '--get', 'remote.origin.url'], timeout)
    } catch (error) {
      // `git config --get` exits 1 when this repository has no origin setting.
      if ((error as { code?: number }).code !== 1) throw error
    }
    if (origin !== undefined) {
      try {
        repository = canonicalRemoteRepositoryIdentity(origin)
      } catch {
        // A local or noncanonical origin is informational and does not identify this selected directory.
      }
    }
  }
  return { project: { projectId: createHash('sha256').update(source).digest('hex'), source, ...repository === undefined ? {} : { repository } }, git: initialized }
}

/** Starts, stops, and inspects members and workspaces on this machine. */
export class LocalGouziOperations {
  private readonly supervisor: GouziSupervisor

  constructor(private readonly config: LocalGouziConfig) {
    const script = config.workerScript ?? fileURLToPath(new URL('./gouzi-worker-bin.js', import.meta.url))
    this.supervisor = new GouziSupervisor({
      membersRoot: config.membersRoot,
      workerCommand: () => ({
        command: process.execPath,
        args: [...config.nodeArgs, script, '--host', '127.0.0.1', '--port', '0'],
        // Inside Electron the executable is the app; this makes it behave as plain Node for the member.
        ...process.versions.electron === undefined ? {} : { env: { ELECTRON_RUN_AS_NODE: '1' } },
      }),
      activeLimit: config.activeLimit,
      readyTimeoutMs: config.readyTimeoutMs,
      stopTimeoutMs: config.stopTimeoutMs,
    })
  }

  /**
   * Inspect a selected directory without writing its files or Git metadata.
   * @param path - selected directory, including a symlink or existing Git subdirectory.
   * @returns its realpath, stable project id, and optional canonical origin identity.
   */
  async resolveRepository(path: string): Promise<GouziProjectSource> {
    return (await inspectProject(path, this.config.gitTimeoutMs)).project
  }

  /**
   * Prepare a confirmed project selection by initializing Git only when needed.
   * @param path - directory selected for adoption.
   * @returns the same selected directory identity after successful preparation.
   */
  async prepareRepository(path: string): Promise<GouziProjectSource> {
    const inspected = await inspectProject(path, this.config.gitTimeoutMs)
    if (!inspected.git) await git(inspected.project.source, ['init', '--', inspected.project.source], this.config.gitTimeoutMs)
    return (await inspectProject(inspected.project.source, this.config.gitTimeoutMs)).project
  }

  async provision(input: GouziProvisionInput): Promise<void> {
    await this.supervisor.provision(input)
  }

  async start(gouziId: string): Promise<LocalGouziStarted> {
    const ready = await this.supervisor.start(gouziId)
    return { port: ready.port, pid: ready.pid, incarnation: ready.incarnation }
  }

  async stop(gouziId: string, options: { readonly reclaimResident?: boolean } = {}): Promise<{ readonly processTreeStopped: boolean }> {
    const outcome = await this.supervisor.stop(gouziId, options)
    // Only a confirmed exit counts: a missing ready record says nothing about a process that was killed but not reaped.
    return { processTreeStopped: outcome.workerStopped && outcome.residentStopped && this.supervisor.running(gouziId) === undefined }
  }

  /**
   * List the directories one level below `path`.
   * @param path - absolute directory; absent lists the user's home directory.
   * @returns the directory, its parent, and its non-hidden subdirectories with a Git marker.
   */
  browse(path?: string): GouziFolderListing {
    const directory = realpathSync(resolve(path ?? homedir()))
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, BROWSE_ENTRY_LIMIT)
      .map(entry => ({ name: entry.name, path: join(directory, entry.name), git: existsSync(join(directory, entry.name, '.git')) }))
    const parent = dirname(directory)
    return { path: directory, ...parent === directory ? {} : { parent }, entries }
  }
}
