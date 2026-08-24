#!/usr/bin/env node
/** Standalone lifecycle entry for dsh-orchestratord. */
import { resolve } from 'node:path'
import { OrchestrationDaemon } from './daemon.ts'

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

function argumentsFor(name: string): string[] {
  return process.argv.flatMap((value, index) => {
    const next = process.argv[index + 1]
    return value === name && next !== undefined ? [next] : []
  })
}

const root = argument('--root')
const dshHome = argument('--dsh-home')
if (root === undefined || dshHome === undefined) {
  process.stderr.write('usage: dsh-orchestratord --root <path> --dsh-home <path>\n')
  process.exitCode = 2
} else {
  const daemon = new OrchestrationDaemon({
    root: resolve(root),
    dshHome: resolve(dshHome),
    residentDriverModules: argumentsFor('--resident-driver-module').map(value => resolve(value)),
    skillProviderModules: argumentsFor('--skill-provider-module').map(value => resolve(value)),
  })
  const close = (): void => { void daemon.close() }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
  await daemon.start()
  await daemon.closed
}
