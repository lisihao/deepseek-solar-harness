#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { dshCommand, verifyDumpConfig, withGovernedProfile } from '../lib/preflight.js'

let command
try {
  command = dshCommand(process.env)
} catch (error) {
  console.error(`dsh-governed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(78)
}
const args = withGovernedProfile(process.argv.slice(2))
const inspected = spawnSync(command[0], [...command.slice(1), ...args, '--dump-config'], {
  encoding: 'utf8',
  env: process.env,
  shell: false,
  maxBuffer: 4 * 1024 * 1024,
})

if (inspected.error || inspected.status !== 0) {
  const detail = inspected.error?.message ?? inspected.stderr?.trim() ?? `exit ${String(inspected.status)}`
  console.error(`dsh-governed: configuration inspection failed: ${detail}`)
  process.exit(78)
}

const verdict = verifyDumpConfig(inspected.stdout)
if (!verdict.ok) {
  console.error(`dsh-governed: fail-closed startup refusal: ${verdict.message}`)
  process.exit(78)
}

const child = spawn(command[0], [...command.slice(1), ...args], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
})

// LaunchAgent and terminal supervisors signal this wrapper, not the nested DSH
// process. Forward shutdown signals so the Web host releases its listeners
// before KeepAlive starts the next wrapper; otherwise the orphaned child keeps
// port 3081 and the replacement fails with EADDRINUSE.
const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const forward = Object.fromEntries(forwardedSignals.map(signal => [
  signal,
  () => { child.kill(signal) },
]))
for (const signal of forwardedSignals) process.on(signal, forward[signal])

let launchError
child.once('error', (error) => { launchError = error })
const outcome = await new Promise(resolve => {
  child.once('close', (code, signal) => { resolve({ code, signal }) })
})
for (const signal of forwardedSignals) process.off(signal, forward[signal])

if (launchError !== undefined) {
  console.error(`dsh-governed: launch failed: ${launchError.message}`)
  process.exit(70)
}
if (outcome.signal !== null) {
  process.kill(process.pid, outcome.signal)
} else {
  process.exit(outcome.code ?? 70)
}
