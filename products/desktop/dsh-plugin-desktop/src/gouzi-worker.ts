/** Launcher of one Gouzi execution member: the product Server transport without a scheduler. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {} from '@deepseek-ai/dsh-client-connection'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { prepareGouziWorkerProfile } from './profile.ts'
import { startProductServer } from './product-server.ts'

const BIN_NAME = 'dsh-gouzi-worker'

/** File under `<member home>/gouzi/` that a booted member writes with its {@link GouziWorkerReady} record. */
export const GOUZI_WORKER_FILE = 'worker.json'

/** First stdout line of a booted member; a supervisor reads it to learn the listener and identity. */
export interface GouziWorkerReady {
  readonly event: 'gouzi-worker-ready'
  readonly pid: number
  readonly port: number
  readonly gouziId: string
  readonly generation: number
  readonly authorityEpoch: string
  readonly incarnation: number
}

/**
 * Start a member under plain Node. `DSH_HOME` selects the member's own home and state root; the member must have
 * been provisioned with an identity there. Pass `--host 127.0.0.1 --port 0` to let the OS pick the listener.
 * @param argv - web flags such as `--port 0`, without the executable.
 */
export async function startGouziWorker(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await startProductServer(argv, {
    binName: BIN_NAME,
    prepare: (telemetryDisabled, home, platform) => prepareGouziWorkerProfile(home, telemetryDisabled, platform),
    onBooted: (ctx) => {
      const member = ctx.get('gouziMember')
      const webServer = ctx.get('webServer')
      if (member === undefined || webServer === undefined) {
        throw new Error(`${BIN_NAME}: the member gate or the web server is not mounted`)
      }
      const ready: GouziWorkerReady = {
        event: 'gouzi-worker-ready',
        pid: process.pid,
        port: webServer.port,
        gouziId: member.hello().gouziId,
        generation: member.hello().generation,
        authorityEpoch: member.hello().authorityEpoch,
        incarnation: member.hello().incarnation,
      }
      // A supervisor that outlives or replaces this process finds the member through this file.
      const directory = join(resolveDshHome(), 'gouzi')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, GOUZI_WORKER_FILE), `${JSON.stringify(ready)}\n`, { mode: 0o600 })
      process.stdout.write(`${JSON.stringify(ready)}\n`)
    },
  })
}
