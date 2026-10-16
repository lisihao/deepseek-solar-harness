/** Keyless snapshot of the runnable Prime/RLM Loader example. */

import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import type { ScenarioName } from './fixtures/prime-rlm-evaluation/scenarios.ts'
import { describe, expect, it } from 'vitest'
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

it('snapshot: prime-rlm-terminal keeps a non-success RLM result from being overwritten by a later turn and tells each message continuation its own task', async () => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-terminal/driver.ts', import.meta.url))
  const expected = new URL('./fixtures/prime-rlm-terminal/expected.json', import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: 'prime-rlm-terminal keyless example',
    tempDirPrefix: 'dsh-prime-rlm-terminal-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-terminal/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    // The driver starts the production orchestration and Resident daemons and runs five scenarios. Its timer limits are listed
    // in its header and sum to 131.7 s (not counting directory creation, module loading, and scheduling); a normal run takes
    // about 18 s. This limit lets it fail by stage and finish its cleanup before the launcher's SIGKILL, which would skip it. The
    // test's own limit, below, is 15 s longer.
    processTimeoutMs: 155_000,
    // Set only to save the normalized request bodies for a before and after comparison; the snapshot does not depend on it.
    env: process.env.DSH_REQUEST_CAPTURE_DIR === undefined ? {} : { DSH_REQUEST_CAPTURE_DIR: process.env.DSH_REQUEST_CAPTURE_DIR },
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
}, 170_000)

const evidenceDirectory = process.env.DSH_EVALUATION_EVIDENCE_DIR

/** What each scenario of the evaluation fixture shows; the `tree` one is the original scenario of the ledger. */
const EVALUATION_SCENARIOS: ReadonlyArray<readonly [ScenarioName, string]> = [
  ['tree', 'admits every physical request of an RLM tree into one ledger and sends nothing past its limit'],
  ['integration', 'meters a root, two children and a batched continuation that reads a child result, each request reserved before it is sent'],
  ['refuse-first', 'sends nothing when the first request is refused, and reports the refusal without requeueing or a busy error'],
  ['refuse-later', 'sends nothing past a refused request of the batched continuation, which fails without requeueing its messages'],
  ['refuse-round', 'sends nothing past a refused request of a later round of one command, which keeps the usage of its settled round'],
  ['cancelled', 'keeps the error of a command cancelled with a request in flight and records that request as unknown'],
  ['missing-usage', 'withholds the usage of a command when a request reports none, and records the missing request apart from the outcome'],
  ['unknown-no-replay', 'does not replay a node whose failed command left a request of unknown outcome, although its retry policy lists the error code'],
  ['unknown-error-finish', 'reports a command whose request ended in an HTTP error with an unknown outcome and does not retry the node'],
  ['unknown-child', 'marks a child whose request ended with an unknown outcome indeterminate while the other child reports'],
  ['unknown-continuation', 'marks the messages of a continuation whose request ended with an unknown outcome indeterminate and sends nothing again'],
  ['unknown-goal', 'does not replay a node whose goal continuation left a request of unknown outcome, whatever its retry policy lists'],
  ['unknown-autonomous', 'does not replay a node whose Autonomous continuation left a request of unknown outcome, whatever its retry policy lists'],
  ['unknown-message-autonomous', 'does not replay an Autonomous node whose message continuation left a request of unknown outcome'],
  ['known-goal-retry', 'still retries a node whose goal continuation failed in a known way, with the second attempt metered apart'],
  ['known-retry', 'meters the second attempt of a node apart from the first when a known failure is retried'],
  ['zero-child', 'meters a root that creates no child'],
  ['ordinary', 'sends the same root in a home without a scope with no ledger, no scope fields and the usage it always published'],
]

it.each(EVALUATION_SCENARIOS)('snapshot: prime-rlm-evaluation scenario %s %s', async (name) => {
  const driver = fileURLToPath(new URL('./fixtures/prime-rlm-evaluation/driver.ts', import.meta.url))
  const expected = new URL(`./fixtures/prime-rlm-evaluation/${name === 'tree' ? 'expected.json' : `expected-${name}.json`}`, import.meta.url)
  const { stdout } = await runLoaderSmoke({
    label: `prime-rlm-evaluation keyless example, scenario ${name}`,
    tempDirPrefix: 'dsh-prime-rlm-evaluation-snapshot-',
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL('./fixtures/prime-rlm-evaluation/cordis.yml', import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    // The driver's explicit waits for its body are fake server 3 s + boot 12 s + daemons ready 12 s + run 15 s = 42 s, and for
    // its cleanup abandoned requests 5 s + dispose 3 s + two daemon stops of 8 s + fake close 2 s + late-sweep pause 0.7 s + two
    // more stops of 8 s = 42.7 s; these are waiting budgets, not a measured total, and exclude unmeasured I/O, loading and
    // scheduling. A normal run takes about 8 s. The limit leaves room beyond the budgets so the driver can fail by stage and
    // finish its cleanup before the launcher's SIGKILL, which would skip it.
    processTimeoutMs: 100_000,
    // The evidence directory is set only to collect the driver's reconcilable files; the snapshot does not depend on it.
    env: { DSH_EVALUATION_SCENARIO: name, ...evidenceDirectory === undefined ? {} : { DSH_EVALUATION_EVIDENCE_DIR: evidenceDirectory } },
  })
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expected, stdout)
  expect(stdout).toBe(await readFile(expected, 'utf8'))
}, 120_000)

const execFileAsync = promisify(execFile)

/** Processes whose command line names this run's unique temporary directory, as `pid command` lines. */
async function processesIn(directory: string): Promise<string[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: 5_000 })
  return stdout.split('\n').filter(line => line.includes(directory))
}

/**
 * Run the terminal driver with one injected fault and require what the driver promises on failure: a non-zero exit, no
 * transcript, a named reason, every cleanup step reported, and no process of the run left behind. Leftovers are found by the
 * run's unique temporary directory in the command line, not by pid files, over four seconds, because a daemon whose start was
 * abandoned may appear after the driver has exited. Any leftover is stopped here and its exit is confirmed, and it still fails
 * the test.
 */
async function terminalFault(fault: string, reason: RegExp, cleanup: readonly (string | RegExp)[]): Promise<void> {
  await fixtureFault('prime-rlm-terminal', 'DSH_TERMINAL_FIXTURE_FAULT', fault, reason, cleanup)
}

/** Stop the listed processes and wait for them to exit; the ones that are still running after SIGKILL are returned. */
async function stopAndConfirm(directory: string): Promise<string[]> {
  for (let tenths = 0; tenths < 40; tenths += 1) {
    const running = await processesIn(directory)
    if (running.length === 0) return []
    for (const line of running) {
      const pid = Number(line.trim().split(/\s+/u)[0])
      if (Number.isSafeInteger(pid) && pid > 0) process.kill(pid, tenths < 15 ? 'SIGTERM' : 'SIGKILL')
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return processesIn(directory)
}

/**
 * The same check for any fixture whose driver reads an injected fault from an environment variable. Every finding is collected
 * and reported together with the driver's stderr, so a missing cleanup line and a leftover process are told apart in one failure.
 */
async function fixtureFault(
  fixture: string, variable: string, fault: string, reason: RegExp, cleanup: readonly (string | RegExp)[],
): Promise<string> {
  const driver = fileURLToPath(new URL(`./fixtures/${fixture}/driver.ts`, import.meta.url))
  const leftover: string[] = []
  const unstopped: string[] = []
  const { stdout, stderr } = await runLoaderSmoke({
    label: `${fixture} keyless example with fault ${fault}`,
    tempDirPrefix: `dsh-${fixture}-fault-`,
    binScript: driver,
    libBinScript: driver,
    configPath: fileURLToPath(new URL(`./fixtures/${fixture}/cordis.yml`, import.meta.url)),
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { [variable]: fault },
    expectedExitCode: 1,
    // The faults end the driver in about 30 s even under load (a hung request adds the 5 s wait for abandoned requests); an
    // unbounded wait would hit this limit instead of passing.
    processTimeoutMs: 60_000,
    inspect: async (cwd) => {
      for (let second = 0; second < 5; second += 1) {
        for (const line of await processesIn(cwd)) if (!leftover.includes(line)) leftover.push(line)
        if (leftover.length > 0) unstopped.push(...await stopAndConfirm(cwd))
        if (second < 4) await new Promise(resolve => setTimeout(resolve, 1_000))
      }
    },
  })
  const findings: string[] = []
  if (stdout !== '') findings.push('the driver printed a transcript')
  if (!reason.test(stderr)) findings.push(`stderr does not match ${String(reason)}`)
  for (const line of cleanup) {
    if (typeof line === 'string' ? !stderr.includes(line) : !line.test(stderr)) findings.push(`stderr lacks ${String(line)}`)
  }
  for (const line of leftover) findings.push(`left running after the driver exited: ${line}`)
  for (const line of unstopped) findings.push(`still running after SIGKILL: ${line}`)
  expect(findings, `driver stderr:\n${stderr}`).toEqual([])
  return stderr
}

it('snapshot: prime-rlm-terminal bounds a client request that never returns and still stops its daemons (start)', async () => {
  // A request that never returns is still held by the client, so the driver reports it as an abandoned request it could not settle.
  await terminalFault('hang-start', /request start did not return within 5000 ms/u, [
    'cleanup settle abandoned requests: FAILED', 'cleanup dispose Loader context: ok', 'cleanup stop orchestration daemon: ok',
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal bounds a status check that never returns and still stops its daemons (settle)', async () => {
  await terminalFault('hang-inspect', /stage "settle" did not happen in time; run state unavailable/u, [
    'cleanup settle abandoned requests: FAILED', 'cleanup stop orchestration daemon: ok', 'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
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
    // The abandoned start may or may not settle within its 5 s, depending on how fast the machine starts a daemon; the step
    // must be reported either way. What is required is that every other step succeeds and nothing of the run is left behind.
    /cleanup settle abandoned requests: (?:ok|FAILED)/u, 'cleanup dispose Loader context: ok', 'cleanup stop orchestration daemon: ok',
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

it('snapshot: prime-rlm-terminal reports a pid file it cannot read instead of treating it as no daemon', async () => {
  await terminalFault('bad-pid-file', /cleanup stop orchestration daemon: FAILED EISDIR/u, [
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
    'cleanup stop orchestration daemon (late sweep): FAILED EISDIR',
  ])
})

it('snapshot: prime-rlm-evaluation stops a daemon whose start was abandoned and finished starting afterwards', async () => {
  await fixtureFault('prime-rlm-evaluation', 'DSH_EVALUATION_FIXTURE_FAULT', 'slow-start', /request list did not return within/u, [
    // The abandoned start may or may not settle within its 5 s, depending on how fast the machine starts a daemon; the step must
    // be reported either way. What is required is that every other step succeeds and nothing of the run is left behind.
    /cleanup settle abandoned requests: (?:ok|FAILED)/u, 'cleanup dispose Loader context: ok', 'cleanup stop orchestration daemon: ok',
    'cleanup stop Resident daemon: ok', 'cleanup close fake DeepSeek: ok',
  ])
})

// A daemon held alive without listening has no pid file for as long as the fault lasts, far longer than the 5 s wait for abandoned
// requests and the 0.7 s pause before the second sweep. Only the scan by startup entry and run home can find it, so the "found by
// its command line" line is what shows the window was real. Each daemon is held on its own: held together, the orchestration
// daemon, which waits for the Resident daemon before it listens, may have exited by the time the cleanup looks.
describe.each([
  ['prime-rlm-terminal', 'DSH_TERMINAL_FIXTURE_FAULT', /stage "daemon ready" did not happen in time/u],
  ['prime-rlm-evaluation', 'DSH_EVALUATION_FIXTURE_FAULT', /request list did not return within/u],
] as const)('snapshot: %s stops a daemon that exists but has not written a pid file', (fixture, variable, reason) => {
  it.each(['orchestration', 'resident'] as const)('%s daemon', async (kind) => {
    const stderr = await fixtureFault(fixture, variable, `hold-${kind}`, reason, [
      'cleanup dispose Loader context: ok', 'cleanup stop orchestration daemon: ok', 'cleanup stop Resident daemon: ok',
      'cleanup close fake DeepSeek: ok', new RegExp(`${kind} daemon \\d+ found by its command line \\(no pid file stopped it\\)`, 'u'),
    ])
    expect(stderr).toMatch(/stage boot: \d+ ms/u)
  })
})
