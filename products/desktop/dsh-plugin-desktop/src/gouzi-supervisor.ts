/** Starts, adopts, and stops Gouzi member processes on this host, each in its own home. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { provisionGouziIdentity } from '@deepseek-ai/dsh-host-gouzi-member'
import { GOUZI_MEMBER_LIMIT } from '@deepseek-ai/dsh-orchestration'
import { GOUZI_WORKER_FILE, type GouziWorkerReady } from './gouzi-worker.ts'

/** Command that starts one member whose home is the given directory. */
export interface GouziWorkerCommand {
  readonly command: string
  readonly args: readonly string[]
  /** Extra environment for the process, for example `ELECTRON_RUN_AS_NODE` when the command is Electron. */
  readonly env?: Readonly<Record<string, string>>
}

/** Supervisor configuration. */
export interface GouziSupervisorOptions {
  /** Directory that holds one home per member. */
  readonly membersRoot: string
  /** Build the command that boots a member in `home`. */
  readonly workerCommand: (home: string) => GouziWorkerCommand
  /** Members that may run at once on this host. */
  readonly activeLimit: number
  /** Longest wait for a spawned member to write its ready record. */
  readonly readyTimeoutMs: number
  /** Longest wait after SIGTERM before a member is killed. */
  readonly stopTimeoutMs: number
}

/** Identity minted by the main instance for one member. */
export interface GouziProvisioning {
  readonly gouziId: string
  readonly ownerId: string
  readonly hostId: string
  readonly generation: number
  readonly authorityEpoch: string
  /** Repositories the member may materialize: canonical identity and clone source. */
  readonly repositories: readonly { readonly repository: string; readonly source: string }[]
}

/** More members are running on this host than the configured limit allows. */
export class GouziActiveLimitError extends Error {
  constructor(readonly limit: number) {
    super(`at most ${String(limit)} gouzi members may run at once on this host`)
    this.name = 'GouziActiveLimitError'
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process. EPERM would mean the pid exists under another user, which is alive for our purpose.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Send a signal to a process that may already be gone.
 * @param pid - process id.
 * @param signal - signal to send.
 */
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch (error) {
    // ESRCH: the process exited between the liveness check and the signal, which is the outcome being asked for.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

/**
 * Whether the pid still runs a Gouzi worker. A pid alone is not enough: after a crash the operating system may
 * hand the same number to an unrelated process, and the ready record would then adopt it.
 * @param pid - process id from a ready record.
 * @returns true when the process exists and its command line names the worker launcher.
 */
function runsWorker(pid: number): boolean {
  if (!alive(pid)) return false
  if (process.platform === 'win32') return true
  try {
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).includes('gouzi-worker')
  } catch (error) {
    // `ps` exits 1 when the pid vanished between the two checks.
    if ((error as { status?: number }).status === 1) return false
    throw error
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => { setTimeout(resolveSleep, milliseconds) })
}

/** Process lifecycle for the members on one host. The main instance decides who exists; this decides who runs. */
export class GouziSupervisor {
  private readonly children = new Map<string, ChildProcess>()
  /** Starts in flight, so a second request for the same member joins the first instead of spawning another. */
  private readonly starting = new Map<string, Promise<GouziWorkerReady>>()

  constructor(private readonly options: GouziSupervisorOptions) {
    if (!Number.isSafeInteger(options.activeLimit) || options.activeLimit < 1 || options.activeLimit > GOUZI_MEMBER_LIMIT) {
      throw new Error(`gouzi supervisor activeLimit must be 1 to ${String(GOUZI_MEMBER_LIMIT)}`)
    }
  }

  /**
   * Home directory of one member.
   * @param gouziId - member identity.
   * @returns the absolute home path.
   */
  homeOf(gouziId: string): string {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(gouziId)) throw new Error(`gouzi id "${gouziId}" is not a safe directory name`)
    return join(resolve(this.options.membersRoot), gouziId)
  }

  /**
   * Create a member's home with its identity and repository allowlist. Idempotent for the same identity.
   * @param input - identity and allowed repositories.
   * @returns the member home.
   */
  async provision(input: GouziProvisioning): Promise<string> {
    const home = this.homeOf(input.gouziId)
    mkdirSync(join(home, 'orchestrations'), { recursive: true, mode: 0o700 })
    await provisionGouziIdentity(home, {
      gouziId: input.gouziId,
      ownerId: input.ownerId,
      hostId: input.hostId,
      generation: input.generation,
      authorityEpoch: input.authorityEpoch,
    })
    // The remote execution host reads its repository allowlist from the member entry of cluster.json.
    writeFileSync(join(home, 'orchestrations', 'cluster.json'), `${JSON.stringify({
      version: 1,
      nodeId: input.gouziId,
      members: [{
        id: input.gouziId,
        label: input.gouziId,
        endpoint: 'http://127.0.0.1:1',
        remoteExecution: { enabled: true, repositories: input.repositories },
      }],
    }, null, 2)}\n`, { mode: 0o600 })
    return home
  }

  /**
   * Read the ready record of a member whose process is alive.
   * @param gouziId - member identity.
   * @returns the record, or undefined when the member is not running.
   */
  running(gouziId: string): GouziWorkerReady | undefined {
    let record: GouziWorkerReady
    try {
      record = JSON.parse(readFileSync(join(this.homeOf(gouziId), 'gouzi', GOUZI_WORKER_FILE), 'utf8')) as GouziWorkerReady
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return runsWorker(record.pid) ? record : undefined
  }

  /**
   * Start a member, or adopt the process that is already running it.
   * @param gouziId - member identity.
   * @returns the ready record of the running member.
   * @throws GouziActiveLimitError - when the host already runs {@link GouziSupervisorOptions.activeLimit} other members.
   */
  async start(gouziId: string): Promise<GouziWorkerReady> {
    const existing = this.running(gouziId)
    if (existing !== undefined) return existing
    const inFlight = this.starting.get(gouziId)
    if (inFlight !== undefined) return inFlight
    const attempt = this.spawnAndWait(gouziId).finally(() => { this.starting.delete(gouziId) })
    this.starting.set(gouziId, attempt)
    return attempt
  }

  private async spawnAndWait(gouziId: string): Promise<GouziWorkerReady> {
    // A process from an earlier failed start must be gone before another is spawned, or the two would overlap.
    const previous = this.children.get(gouziId)
    if (previous?.pid !== undefined && alive(previous.pid) && !await this.terminate(previous.pid)) {
      throw new Error(`gouzi ${gouziId} still has a process (pid ${String(previous.pid)}) from an earlier start that did not exit`)
    }
    const others = this.activeCount(gouziId)
    if (others >= this.options.activeLimit) throw new GouziActiveLimitError(this.options.activeLimit)
    const home = this.homeOf(gouziId)
    const file = join(home, 'gouzi', GOUZI_WORKER_FILE)
    rmSync(file, { force: true })
    const { command, args, env } = this.options.workerCommand(home)
    // The member keeps running if the supervisor's process ends, so output goes to a file, not a pipe.
    const log = openSync(join(home, 'worker.log'), 'a', 0o600)
    let child: ChildProcess
    try {
      child = spawn(command, [...args], {
        cwd: home,
        detached: true,
        stdio: ['ignore', log, log],
        env: { ...process.env, ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED ?? '1' },
      })
    } finally {
      closeSync(log)
    }
    child.unref()
    this.children.set(gouziId, child)
    let exitCode: number | null | undefined
    child.once('exit', (code) => {
      exitCode = code
      if (this.children.get(gouziId) === child) this.children.delete(gouziId)
    })
    const deadline = Date.now() + this.options.readyTimeoutMs
    while (Date.now() < deadline) {
      const ready = this.running(gouziId)
      if (ready !== undefined) return ready
      if (exitCode !== undefined) {
        throw new Error(`gouzi ${gouziId} exited with code ${String(exitCode)} before it was ready; see ${join(home, 'worker.log')}`)
      }
      await sleep(100)
    }
    // Report the failure only once the process is confirmed gone; a retry then cannot overlap it.
    const reclaimed = child.pid === undefined || await this.terminate(child.pid)
    const why = `gouzi ${gouziId} was not ready after ${String(this.options.readyTimeoutMs)} ms; see ${join(home, 'worker.log')}`
    throw new Error(reclaimed ? why : `${why}; its process (pid ${String(child.pid)}) did not exit and still holds its slot`)
  }

  /**
   * Stop a member's process. The ready record is forgotten only once the process is confirmed gone, so an
   * unconfirmed stop leaves the member visible as running. Optionally also stop the Resident daemon it started,
   * which otherwise outlives the member so that durable turns survive a restart.
   * @param gouziId - member identity.
   * @param options - `reclaimResident` also stops the member's Resident daemon.
   * @returns whether each process was confirmed gone; the Resident daemon counts as gone when it was not asked for.
   */
  async stop(
    gouziId: string,
    options: { readonly reclaimResident?: boolean } = {},
  ): Promise<{ readonly workerStopped: boolean; readonly residentStopped: boolean }> {
    const home = this.homeOf(gouziId)
    const record = this.running(gouziId)
    const starting = this.children.get(gouziId)
    const workerStopped = (record === undefined || await this.terminate(record.pid))
      && (starting?.pid === undefined || !alive(starting.pid) || await this.terminate(starting.pid))
    if (workerStopped) {
      rmSync(join(home, 'gouzi', GOUZI_WORKER_FILE), { force: true })
      this.children.delete(gouziId)
    }
    let residentStopped = true
    if (options.reclaimResident === true) {
      const pid = residentDaemonPid(home)
      residentStopped = pid === undefined || await this.terminate(pid)
    }
    return { workerStopped, residentStopped }
  }

  private activeCount(except: string): number {
    let count = 0
    for (const gouziId of this.knownMembers()) {
      if (gouziId === except) continue
      // A member that is still booting holds a slot as well, although it has not written its ready record yet.
      const booting = this.children.get(gouziId)
      if (this.running(gouziId) !== undefined || (booting?.pid !== undefined && alive(booting.pid))) count++
    }
    return count
  }

  private knownMembers(): string[] {
    try {
      return readdirSync(resolve(this.options.membersRoot), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  /**
   * Stop a process: SIGTERM, then SIGKILL after the stop timeout, and wait for the exit each time.
   * @param pid - process id.
   * @returns true only when the process is confirmed gone.
   */
  private async terminate(pid: number): Promise<boolean> {
    signalProcess(pid, 'SIGTERM')
    if (await this.exited(pid)) return true
    signalProcess(pid, 'SIGKILL')
    return this.exited(pid)
  }

  private async exited(pid: number): Promise<boolean> {
    const deadline = Date.now() + this.options.stopTimeoutMs
    while (alive(pid) && Date.now() < deadline) await sleep(50)
    return !alive(pid)
  }
}

/**
 * Find the Resident daemon a member started.
 * @param home - the member home.
 * @returns its pid, or undefined when the member has no recorded daemon.
 */
export function residentDaemonPid(home: string): number | undefined {
  let database: DatabaseSync
  try {
    database = new DatabaseSync(join(home, 'resident-operators', 'daemon-authority.sqlite'), { readOnly: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SQLITE_ERROR') return undefined
    throw error
  }
  try {
    const row = database.prepare('SELECT pid FROM daemon_authority WHERE singleton = 1').get() as { pid: number } | undefined
    return row !== undefined && alive(row.pid) ? row.pid : undefined
  } finally {
    database.close()
  }
}
