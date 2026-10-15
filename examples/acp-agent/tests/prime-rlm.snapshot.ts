/** Keyless snapshot of the runnable Prime/RLM Loader example. */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

it('snapshot: prime-rlm preserves strict inheritance and sealed execution inputs', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm keyless example',
    tempDirPrefix: 'dsh-prime-rlm-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})

it('snapshot: prime-rlm-delete keeps a permanently deleted subtree closed to new executions', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-delete/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm-delete/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm-delete keyless example',
    tempDirPrefix: 'dsh-prime-rlm-delete-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-delete/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})

it('snapshot: prime-rlm-terminal keeps a non-success RLM result from being overwritten by a later turn', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-terminal/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm-terminal/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm-terminal keyless example',
    tempDirPrefix: 'dsh-prime-rlm-terminal-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-terminal/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    // The driver starts the production orchestration and Resident daemons and runs two scenarios. Its own limits are listed in
    // its header: a normal run takes about 10 s and its worst case 93.7 s, so this limit lets it fail by stage and finish its
    // cleanup before the launcher's SIGKILL, which would skip it. The suite's per-test limit is 120 s.
    processTimeoutMs: 100_000,
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
})

const execFileAsync = promisify(execFile)

/** Processes whose command line names this run's unique temporary directory, as `pid command` lines. */
async function processesIn(directory: string): Promise<string[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 5_000 })
  return stdout.split('\n').filter(line => line.includes(directory))
}

/**
 * Run the terminal driver with one injected fault and require what the driver promises on failure: a non-zero exit, no
 * transcript, a named reason, every cleanup step reported, and no process of the run left behind. Leftovers are found by the
 * run's unique temporary directory in the command line, not by pid files, and are looked for over four seconds because a
 * daemon whose start was abandoned writes its pid file only after the driver has exited. Any leftover is stopped here.
 */
async function terminalFault(fault: string, reason: RegExp, cleanup: readonly string[]): Promise<void> {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-terminal/driver.ts', import.meta.url))
  const leftover: string[] = []
  const { stdout, stderr } = await runLoaderSmoke({
    label: `prime-rlm-terminal keyless example with fault ${fault}`,
    tempDirPrefix: 'dsh-prime-rlm-terminal-fault-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-terminal/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { DSH_TERMINAL_FIXTURE_FAULT: fault },
    expectedExitCode: 1,
    // The faults end the driver in well under this; an unbounded wait would hit it instead of passing.
    processTimeoutMs: 40_000,
    inspect: async (cwd) => {
      for (let second = 0; second < 5; second += 1) {
        for (const line of await processesIn(cwd)) {
          if (!leftover.includes(line)) leftover.push(line)
          const pid = Number(line.trim().split(/\s+/u)[0])
          if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, 'SIGTERM')
        }
        if (second < 4) await new Promise(resolve => setTimeout(resolve, 1_000))
      }
    },
  })
  expect(stdout).toBe('')
  expect(stderr).toMatch(reason)
  for (const line of cleanup) expect(stderr).toContain(line)
  expect(leftover).toEqual([])
}

it('snapshot: prime-rlm-terminal bounds a client request that never returns and still stops its daemons (start)', async () => {
  await terminalFault('hang-start', /request start did not return within 5000 ms/u, [
    'cleanup dispose Loader context: ok', 'cleanup stop orchestration daemon: ok',
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal bounds a status check that never returns and still stops its daemons (settle)', async () => {
  await terminalFault('hang-inspect', /stage "settle" did not happen in time; run state unavailable/u, [
    'cleanup stop orchestration daemon: ok', 'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal closes the fake provider when the Loader boot fails', async () => {
  await terminalFault('fail-boot', /prime-rlm-terminal failed: /u, [
    'cleanup dispose Loader context: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal keeps stopping its daemons and the provider when disposing the Loader fails', async () => {
  await terminalFault('fail-dispose', /cleanup dispose Loader context: FAILED injected dispose failure/u, [
    'cleanup stop orchestration daemon: ok', 'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal stops a daemon whose start was abandoned and finishes starting afterwards', async () => {
  await terminalFault('slow-start', /stage "daemon ready" did not happen in time/u, [
    'cleanup settle abandoned requests: ok', 'cleanup stop orchestration daemon: ok',
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal reports a pid file it cannot read instead of treating it as no daemon', async () => {
  await terminalFault('bad-pid-file', /cleanup stop orchestration daemon: FAILED EISDIR/u, [
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
    'cleanup stop orchestration daemon (late sweep): FAILED EISDIR',
  ])
})
