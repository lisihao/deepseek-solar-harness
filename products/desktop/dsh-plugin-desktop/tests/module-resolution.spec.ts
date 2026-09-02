import { describe, expect, it } from 'vitest'
import {
  desktopProductEntryUrl,
  packagedRuntimePackageDirectory,
  packagedRuntimePackages,
} from '../src/module-resolution.ts'
import { SEALED_RUNTIME_PACKAGES } from '../src/product-bundles.ts'

describe('Desktop product package resolution', () => {
  it('pins every sealed product bundle to the App dependency tree', () => {
    for (const packageName of SEALED_RUNTIME_PACKAGES) {
      const resolved = desktopProductEntryUrl(packageName)
      expect(resolved, packageName).toBeTypeOf('string')
      expect(resolved, packageName).toContain('/node_modules/')
    }
  })

  it('discovers the App closure and keeps ordinary third-party packages profile-owned', () => {
    const packages = packagedRuntimePackages()
    expect(packages.some(({ name }) => name === '@deepseek-ai/dsh-terminal')).toBe(true)
    expect(packagedRuntimePackageDirectory('@deepseek-ai/dsh-terminal')).toBeTypeOf('string')
    expect(packagedRuntimePackageDirectory('react')).toBeUndefined()
  })

  it('resolves managed package subpaths from the App tree', () => {
    const specifier = '@deepseek-ai/dsh-terminal/invariant'
    expect(desktopProductEntryUrl(specifier)).toBe(import.meta.resolve(specifier))
    expect(desktopProductEntryUrl(specifier)).toContain('/node_modules/@deepseek-ai/dsh-terminal/')
  })

  it('resolves supported wildcard exports from the App tree without hook recursion', () => {
    const specifier = '@deepseek-ai/dsh-host-apiproxy/api/host.schema'
    expect(desktopProductEntryUrl(specifier)).toBe(import.meta.resolve(specifier))
    expect(desktopProductEntryUrl(specifier)).toContain('/node_modules/@deepseek-ai/dsh-host-apiproxy/')
  })

  it('rejects an unsealed Desktop-owned subpath instead of falling back to the profile', () => {
    expect(() => desktopProductEntryUrl('dsh-plugin-desktop/unknown')).toThrow(
      'Desktop product package export is not sealed',
    )
  })

  it('resolves a sealed plugin direct-file entry from the App tree', () => {
    const specifier = 'aegis/extensions/dsh/index.js'
    expect(desktopProductEntryUrl(specifier)).toBe(import.meta.resolve(specifier))
    expect(desktopProductEntryUrl(specifier)).toContain('/node_modules/aegis/')
  })

  it('leaves ordinary selected-profile packages under profile ownership', () => {
    expect(desktopProductEntryUrl('third-party-profile-plugin')).toBeUndefined()
  })
})
