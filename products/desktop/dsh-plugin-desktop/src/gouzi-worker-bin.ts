/** Executable entry for one Gouzi execution member. */

import { startGouziWorker } from './gouzi-worker.ts'

void startGouziWorker().catch((cause: unknown) => {
  process.stderr.write(`dsh-gouzi-worker: ${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
  process.exitCode = 1
})
