/**
 * Fresh Codex app-server catalog query over one short-lived stdio process.
 * @module @deepseek-ai/dsh-resident-operator-local/codex-catalog
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  CodexAppServerWire,
  type CodexAppServerModel,
  type CodexAppServerRateLimit,
} from '@deepseek-ai/dsh-subagent-codex'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Bound for the complete read-only Codex model and quota catalog request. */
export const CODEX_CATALOG_TIMEOUT_MS = 15_000

const EOF_GRACE_MS = 100
const TERMINATION_GRACE_MS = 500

/** Collect one fresh catalog through the read-only app-server control methods. */
export type CodexCatalogCollector<T> = (
  listModels: () => Promise<readonly CodexAppServerModel[]>,
  readRateLimits: () => Promise<readonly CodexAppServerRateLimit[]>,
) => Promise<T>

function exitsWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, timeoutMs).unref()
    child.once('exit', onExit)
  })
}

function signalCatalogProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    child.kill(signal)
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

async function disposeCatalogProcess(child: ChildProcess, timedOut: boolean): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.stdin?.end()
  if (await exitsWithin(child, timedOut ? 0 : EOF_GRACE_MS)) return
  signalCatalogProcess(child, 'SIGTERM')
  if (await exitsWithin(child, TERMINATION_GRACE_MS)) return
  signalCatalogProcess(child, 'SIGKILL')
  if (!await exitsWithin(child, TERMINATION_GRACE_MS)) {
    throw new Error('Codex app-server catalog process did not exit after SIGKILL')
  }
}

/**
 * Start the qualified Codex app-server only long enough to read its current
 * model catalog and account quota controls. The callback cannot start a
 * thread or turn because it receives only those two control operations.
 *
 * @param executable - absolute Codex executable qualified for this check.
 * @param collect - maps the current model and quota control responses.
 * @returns the collector result after the child reaches quiescence.
 */
export async function readFreshCodexCatalog<T>(
  executable: string,
  collect: CodexCatalogCollector<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(CODEX_CATALOG_TIMEOUT_MS)
  const child = spawn(executable, ['app-server', '--stdio'], {
    cwd: process.cwd(),
    detached: process.platform !== 'win32',
    env: scrubbedParentEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const spawnFailure = Promise.withResolvers<never>()
  const onSpawnError = (error: Error): void => { spawnFailure.reject(error) }
  child.once('error', onSpawnError)
  // The failure race observes spawn errors while the caught branch prevents a
  // late failed launch from becoming an unhandled rejection during teardown.
  void spawnFailure.promise.catch(() => {})
  // Closing stdin during owned teardown may race the app-server closing it.
  // The wire observes active protocol failures; this listener keeps a late
  // teardown EPIPE from escaping the awaited process lifecycle.
  child.stdin.on('error', () => {})
  // Catalog RPC has no stderr protocol, but the pipe must drain so a noisy
  // failed launch cannot block the child before its exit is observed.
  child.stderr.resume()

  const wire = new CodexAppServerWire(child.stdout, child.stdin, 'require')
  try {
    wire.start()
    await Promise.race([wire.initialize(signal), spawnFailure.promise])
    return await Promise.race([
      collect(
        () => wire.listModels(signal),
        () => wire.readRateLimits(signal),
      ),
      spawnFailure.promise,
    ])
  } finally {
    wire.close()
    try {
      await disposeCatalogProcess(child, signal.aborted)
    } finally {
      child.off('error', onSpawnError)
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
}
