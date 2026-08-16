#!/usr/bin/env node
/** Standalone lifecycle entry for dsh-resident-operatord. @module @deepseek-ai/dsh-resident-operator-local/startup */

import { fileURLToPath } from 'node:url'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { ResidentDaemon } from './daemon.ts'

/**
 * Run one signal-aware Resident daemon until graceful closure.
 * @param root - owner-only daemon state root.
 * @returns after the daemon closes and signal listeners are removed.
 */
export async function runResidentDaemon(root: string): Promise<void> {
  const daemon = new ResidentDaemon({ root })
  await daemon.start()
  const stop = (): void => { void daemon.close() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await daemon.closed
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

function argumentRoot(argv: readonly string[]): string {
  const index = argv.indexOf('--root')
  if (index >= 0) {
    const value = argv[index + 1]
    if (value === undefined || value.length === 0) throw new Error('--root needs a path')
    return value
  }
  return `${resolveDshHome()}/resident-operators`
}

const invoked = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
if (invoked) {
  await runResidentDaemon(argumentRoot(process.argv.slice(2)))
}
