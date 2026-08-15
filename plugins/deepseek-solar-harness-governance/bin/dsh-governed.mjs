#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
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

const child = spawnSync(command[0], [...command.slice(1), ...args], {
  stdio: 'inherit',
  env: process.env,
  shell: false,
})
if (child.error) {
  console.error(`dsh-governed: launch failed: ${child.error.message}`)
  process.exit(70)
}
process.exit(child.status ?? 70)
