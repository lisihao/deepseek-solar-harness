import { describe, expect, it } from 'vitest'
import { desktopProductEntryUrl } from '../src/module-resolution.ts'
import { SEALED_RUNTIME_PACKAGES } from '../src/product-bundles.ts'

describe('Desktop product package resolution', () => {
  it('pins every sealed product bundle to the App dependency tree', () => {
    for (const packageName of SEALED_RUNTIME_PACKAGES) {
      const resolved = desktopProductEntryUrl(packageName)
      expect(resolved, packageName).toBeTypeOf('string')
      expect(resolved, packageName).toContain('/node_modules/')
    }
  })

  it('leaves ordinary selected-profile packages under profile ownership', () => {
    expect(desktopProductEntryUrl('third-party-profile-plugin')).toBeUndefined()
  })
})
