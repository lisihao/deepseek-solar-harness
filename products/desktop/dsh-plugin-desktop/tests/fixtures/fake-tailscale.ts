/** A `tailscale` stand-in whose `nc` really relays to the target, records every call, and can pretend tailscaled is down. */

import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A stand-in CLI and what it saw. */
export interface FakeTailscale {
  /** Executable to configure as the Tailscale CLI. */
  readonly path: string
  /** The argument list of every call, oldest first. */
  calls(): string[][]
  /** Make every later call fail the way a stopped or misconfigured tailscaled does. */
  setDown(down: boolean): void
}

/**
 * Create the stand-in in `directory`.
 * @param directory - scratch directory.
 * @returns the stand-in.
 */
export function fakeTailscale(directory: string): FakeTailscale {
  const log = join(directory, 'tailscale-calls.jsonl')
  const down = join(directory, 'tailscale-down')
  const script = join(directory, 'fake-tailscale.mjs')
  writeFileSync(script, [
    "import { appendFileSync, existsSync } from 'node:fs'",
    "import { connect } from 'node:net'",
    'const argv = process.argv.slice(2)',
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + '\\n')`,
    `if (existsSync(${JSON.stringify(down)})) {`,
    "  process.stderr.write('failed to connect to local tailscaled; is it running?\\n')",
    '  process.exit(1)',
    '}',
    "const at = argv.indexOf('nc')",
    'const socket = connect({ host: argv[at + 1], port: Number(argv[at + 2]) })',
    'process.stdin.pipe(socket)',
    'socket.pipe(process.stdout)',
    "socket.on('error', () => process.exit(1))",
    "socket.on('close', () => process.exit(0))",
    "process.stdin.on('end', () => socket.end())",
    '',
  ].join('\n'))
  const path = join(directory, 'fake-tailscale.sh')
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`)
  chmodSync(path, 0o755)
  return {
    path,
    calls: () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(line => line.length > 0).map(line => JSON.parse(line) as string[]) : [],
    setDown: (value) => { if (value) writeFileSync(down, ''); else rmSync(down, { force: true }) },
  }
}
