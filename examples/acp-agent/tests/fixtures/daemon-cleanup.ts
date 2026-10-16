/**
 * Stop the daemons a keyless fixture driver started in its isolated home, including a daemon that exists but has not published
 * its pid file yet. A daemon writes its pid file from its listen callback, so a cleanup that reads only the pid file reports
 * "nothing to stop" for a process that is still starting and that keeps running after the driver has exited. The orchestration
 * daemon listens only after it has waited for its Resident providers (`orchestration-local/src/daemon.ts`), so its window is the
 * longer one. Such a process is found by its startup entry and by the exact `--dsh-home` or `--root` of this run, stopped, and
 * confirmed gone, or the stop fails. The failing branches (a process still listed after the deadline, a rescue that SIGKILL did
 * not end) have no test: SIGKILL ends the processes of these runs.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PS_MS = 2_000
const TERMINATE_MS = 1_500
const DEADLINE_MS = 3_000
const POLL_MS = 100

/** The two daemons of a run, in the order they must be stopped: the orchestration daemon starts the Resident daemon. */
export type DaemonKind = 'orchestration' | 'resident'

/** One process as `ps` lists it. */
interface ListedProcess {
  readonly pid: number
  readonly command: string
}

/** The entry file a daemon is started from, the argument pair that names this run's home in its command line, and its pid file. */
interface DaemonIdentity {
  readonly entry: RegExp
  readonly flag: string
  readonly value: string
  readonly pidFile: string
}

function identity(home: string, kind: DaemonKind): DaemonIdentity {
  return kind === 'orchestration'
    ? {
      entry: /\/orchestration-local\/(?:src|lib)\/startup\.(?:ts|js)$/u, flag: '--dsh-home', value: home,
      pidFile: join(home, 'orchestrations', 'daemon.pid'),
    }
    : {
      entry: /\/resident-operator-local\/(?:src|lib)\/startup\.(?:ts|js)$/u, flag: '--root', value: join(home, 'resident-operators'),
      pidFile: join(home, 'resident-operators', 'daemon.pid'),
    }
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { readonly code?: unknown }).code : undefined
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (codeOf(error) === 'ESRCH') return false
    throw error
  }
}

/**
 * Processes started from a daemon's startup entry with this run's exact home, whether or not they published a pid file.
 * @param home - the isolated DSH home of the run.
 * @param kind - which daemon.
 * @returns the matching processes; a process of another run or another program never matches.
 */
async function daemonProcesses(home: string, kind: DaemonKind): Promise<ListedProcess[]> {
  const { entry, flag, value } = identity(home, kind)
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: PS_MS, maxBuffer: 64 * 1024 * 1024 })
  const found: ListedProcess[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const tokens = (match[2] ?? '').split(/\s+/u)
    const named = tokens.findIndex(token => entry.test(token))
    const at = tokens.indexOf(flag, named + 1)
    if (named >= 0 && at >= 0 && tokens[at + 1] === value) found.push({ pid: Number(match[1]), command: match[2] ?? '' })
  }
  return found
}

/** Stop the daemon named by its pid file, after checking its command line names this home. Nothing to stop is `false`. */
async function stopFromPidFile(pidFile: string, home: string): Promise<boolean> {
  let text: string
  try {
    text = await readFile(pidFile, 'utf8')
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return false
    throw error
  }
  const pid = Number(text.trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`pid file ${pidFile} does not hold a pid: ${JSON.stringify(text.slice(0, 40))}`)
  if (!alive(pid)) return false
  // `ps` exits with 1 and no output when the process is gone; a timeout or a missing `ps` is not that and is kept.
  const command = await execFileAsync('ps', ['-o', 'command=', '-p', String(pid)], { timeout: PS_MS }).then(
    result => result.stdout,
    (error: unknown) => {
      if (codeOf(error) === 1) return ''
      throw error
    },
  )
  if (command === '') return false
  if (!command.includes(home)) throw new Error(`pid ${String(pid)} from ${pidFile} does not belong to this run`)
  process.kill(pid, 'SIGTERM')
  const limit = Date.now() + 4_000
  while (alive(pid) && Date.now() < limit) await new Promise(resolve => setTimeout(resolve, 50))
  if (alive(pid)) {
    process.kill(pid, 'SIGKILL')
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  if (alive(pid)) throw new Error(`pid ${String(pid)} from ${pidFile} is still running after SIGKILL`)
  return true
}

/**
 * Stop one daemon of the run: first the one its pid file names, then every process that carries the daemon's startup entry and
 * this run's home, with SIGTERM and, after a grace period, SIGKILL. A scan that finds nothing confirms the daemon is gone; a
 * process still listed when the deadline passes fails the stop. A pid file that cannot be read still fails, after the scan ran.
 * @param home - the isolated DSH home of the run.
 * @param kind - which daemon; stop the orchestration daemon before the Resident daemon, which it starts.
 */
export async function stopDaemon(home: string, kind: DaemonKind): Promise<void> {
  let pidFileError: unknown
  let stoppedByPidFile = false
  try {
    stoppedByPidFile = await stopFromPidFile(identity(home, kind).pidFile, home)
  } catch (error) {
    pidFileError = error
  }
  const started = Date.now()
  let reported = false
  for (;;) {
    const found = await daemonProcesses(home, kind)
    if (found.length === 0) break
    if (!reported) {
      reported = true
      process.stderr.write(`${kind} daemon ${found.map(entry => String(entry.pid)).join(', ')} found by its command line (${stoppedByPidFile ? 'pid file stopped another process' : 'no pid file stopped it'})\n`)
    }
    const elapsed = Date.now() - started
    if (elapsed >= DEADLINE_MS) {
      throw new Error(`${kind} daemon ${found.map(entry => String(entry.pid)).join(', ')} still running ${String(DEADLINE_MS)} ms after it was signalled`)
    }
    for (const entry of found) {
      try {
        process.kill(entry.pid, elapsed < TERMINATE_MS ? 'SIGTERM' : 'SIGKILL')
      } catch (error) {
        if (codeOf(error) !== 'ESRCH') throw error
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
  if (pidFileError !== undefined) throw pidFileError
}

/**
 * Make the named daemon, when the driver starts it from now on, stay alive without listening, so it has no pid file until it is
 * signalled. The preload reaches the orchestration daemon through the client's `process.execArgv` and the Resident daemon
 * through that daemon's own; both read which daemon to hold from the environment.
 * @param kind - the daemon to hold; the other starts normally.
 */
export function holdDaemonBeforeListening(kind: DaemonKind): void {
  process.execArgv.push('--import', fileURLToPath(new URL('./hold-listen.mjs', import.meta.url)))
  process.env.DSH_FIXTURE_HOLD_LISTEN = kind
}

/**
 * Run one stage of a driver and report how long it took on stderr, whether it succeeded or not, so a stage that ran out of its
 * limit leaves a measured duration next to the limit.
 * @param name - the stage name printed in the line.
 * @param work - the stage.
 * @returns the stage's result.
 */
export async function timedStage<T>(name: string, work: () => Promise<T>): Promise<T> {
  const began = Date.now()
  try {
    return await work()
  } finally {
    process.stderr.write(`stage ${name}: ${String(Date.now() - began)} ms\n`)
  }
}
