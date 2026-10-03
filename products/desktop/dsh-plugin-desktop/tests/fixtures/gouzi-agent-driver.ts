/** Stand-in for the remote `gouzi-agent-bin`: the real agent, with members launched from source through tsx. */

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { main } from '../../src/gouzi-agent.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function readAll(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

await main(process.argv.slice(2), process.env.FAKE_APP_VERSION ?? '3.36.0', readAll, text => process.stdout.write(text), {
  workerScript: join(root, 'src', 'gouzi-worker-bin.ts'),
  nodeArgs: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href],
})
