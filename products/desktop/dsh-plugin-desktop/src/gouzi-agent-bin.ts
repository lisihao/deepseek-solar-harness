/** Executable entry of the remote Gouzi agent. */

import { readFileSync } from 'node:fs'
import { main } from './gouzi-agent.ts'

/** Version of the installed DSH Desktop, read from this package so the main instance can compare. */
function installedVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return manifest.version
}

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

// The outcome is in the result line; a nonzero exit is reserved for a process that could not run at all.
void main(process.argv.slice(2), installedVersion(), readAll, text => process.stdout.write(text))
