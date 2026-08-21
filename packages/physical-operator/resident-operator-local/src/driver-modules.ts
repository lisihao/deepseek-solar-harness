/** Configured Resident product Driver module loading for the detached daemon. */

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ResidentProductDriver,
  ResidentProductDriverFactory,
} from '@deepseek-ai/dsh-resident-operator'
import { ResidentOperatorError } from '@deepseek-ai/dsh-resident-operator'

/**
 * Stable hash used to fence a daemon from a client with a different Driver set.
 * @param modules - canonical absolute Driver module entries in configuration order.
 * @returns SHA-256 digest of the configured Driver set.
 */
export function residentDriverManifestSha256(modules: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(modules)).digest('hex')
}

/**
 * Import configured Driver factories at the detached daemon boundary.
 * @param root - owner-private Resident state root.
 * @param modules - absolute module entries resolved by the Cordis host.
 * @returns one Driver per configured module, in configuration order.
 */
export async function loadResidentProductDrivers(
  root: string,
  modules: readonly string[],
): Promise<ResidentProductDriver[]> {
  const drivers: ResidentProductDriver[] = []
  for (const [index, entry] of modules.entries()) {
    const loaded = await import(pathToFileURL(entry).href) as {
      createResidentProductDriver?: ResidentProductDriverFactory
    }
    if (typeof loaded.createResidentProductDriver !== 'function') {
      throw new ResidentOperatorError(
        `resident Driver module ${entry} does not export createResidentProductDriver()`,
        'PROTOCOL_MISMATCH',
      )
    }
    const driver = await loaded.createResidentProductDriver({
      stateRoot: join(root, 'providers', String(index)),
    })
    if (typeof driver.operatorId !== 'string' || driver.operatorId.trim().length === 0) {
      throw new ResidentOperatorError(
        `resident Driver module ${entry} returned an invalid operatorId`,
        'PROTOCOL_MISMATCH',
      )
    }
    drivers.push(driver)
  }
  return drivers
}
