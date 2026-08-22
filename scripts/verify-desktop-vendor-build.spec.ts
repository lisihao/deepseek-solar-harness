import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseGeneratedArchiveMembers,
  verifyDesktopVendorBuild,
} from './verify-desktop-vendor-build.ts'

const roots: string[] = []

async function fixture(options: { archived: string; built: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-vendor-build-'))
  roots.push(root)
  const sourceRoot = join(root, 'packages/group/example')
  const vendorRoot = join(root, 'products/desktop/dsh-plugin-desktop/vendor')
  const archiveRoot = join(root, 'archive/package')
  await mkdir(join(sourceRoot, 'lib'), { recursive: true })
  await mkdir(join(vendorRoot, 'dsh-packages'), { recursive: true })
  await mkdir(join(archiveRoot, 'lib'), { recursive: true })
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"example"}\n')
  await writeFile(join(sourceRoot, 'lib/index.js'), options.built)
  await writeFile(join(archiveRoot, 'lib/index.js'), options.archived)
  await writeFile(join(vendorRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourcePackages: {
      'dsh-packages/example.tgz': 'packages/group/example/package.json',
    },
  })}\n`)
  execFileSync('tar', [
    '-czf', join(vendorRoot, 'dsh-packages/example.tgz'),
    '-C', join(root, 'archive'),
    'package',
  ])
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Desktop vendor build closure', () => {
  it('normalizes Windows CRLF in tar member listings', () => {
    expect(parseGeneratedArchiveMembers('package/lib/\r\npackage/lib/index.js\r\n'))
      .toEqual(['lib/index.js'])
  })

  it('accepts an archive built from the current root workspace output', async () => {
    const root = await fixture({ archived: 'export const value = 1\n', built: 'export const value = 1\n' })

    await expect(verifyDesktopVendorBuild(root)).resolves.toEqual({ archives: 1, files: 1 })
  })

  it('rejects stale generated code even when the archive manifest is still valid', async () => {
    const root = await fixture({ archived: 'export const value = 1\n', built: 'export const value = 2\n' })

    await expect(verifyDesktopVendorBuild(root)).rejects.toThrow(
      'contains stale lib/index.js relative to packages/group/example/package.json',
    )
  })
})
