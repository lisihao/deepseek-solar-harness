import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadResidentProductDrivers,
  residentDriverManifestSha256,
} from '../src/driver-modules.ts'

const roots: string[] = []
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'dsh-resident-driver-module-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('Resident Driver modules', () => {
  it('loads one independently packaged factory without coupling the daemon to its product', async () => {
    const stateRoot = root()
    const entry = join(stateRoot, 'driver.mjs')
    writeFileSync(entry, `
export function createResidentProductDriver(options) {
  return {
    operatorId: 'fixture-product',
    stateRoot: options.stateRoot,
    qualify() { throw new Error('unused') },
    execute() { throw new Error('unused') },
  }
}
`)
    const [driver] = await loadResidentProductDrivers(stateRoot, [entry])
    expect(driver).toMatchObject({
      operatorId: 'fixture-product',
      stateRoot: join(stateRoot, 'providers', '0'),
    })
  })

  it('fences the configured module set and rejects modules without the factory seam', async () => {
    expect(residentDriverManifestSha256(['/one'])).toBe(residentDriverManifestSha256(['/one']))
    expect(residentDriverManifestSha256(['/one'])).not.toBe(residentDriverManifestSha256(['/two']))
    const stateRoot = root()
    const entry = join(stateRoot, 'invalid.mjs')
    writeFileSync(entry, 'export const value = 1\n')
    await expect(loadResidentProductDrivers(stateRoot, [entry])).rejects.toMatchObject({
      code: 'PROTOCOL_MISMATCH',
    })
  })
})
