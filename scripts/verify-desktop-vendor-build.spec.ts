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

async function fixture(options: {
  archived: string
  built: string
  source?: string
  output?: string
}): Promise<string> {
  const source = options.source ?? 'packages/group/example'
  const output = options.output ?? 'lib'
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-vendor-build-'))
  roots.push(root)
  const sourceRoot = join(root, source)
  const vendorRoot = join(root, 'products/desktop/dsh-plugin-desktop/vendor')
  const archiveRoot = join(root, 'archive/package')
  await mkdir(join(sourceRoot, output), { recursive: true })
  await mkdir(join(vendorRoot, 'dsh-packages'), { recursive: true })
  await mkdir(join(archiveRoot, output), { recursive: true })
  await writeFile(join(sourceRoot, 'package.json'), '{"name":"example"}\n')
  await writeFile(join(sourceRoot, output, 'index.js'), options.built)
  await writeFile(join(archiveRoot, output, 'index.js'), options.archived)
  await writeFile(join(vendorRoot, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 1,
    sourcePackages: {
      'dsh-packages/example.tgz': `${source}/package.json`,
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

  it('includes bundled dist files', () => {
    expect(parseGeneratedArchiveMembers('package/dist/\npackage/dist/assets/index-a.js\npackage/README.md\n'))
      .toEqual(['dist/assets/index-a.js'])
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

  it('rejects a stale app bundle', async () => {
    const root = await fixture({ archived: 'old\n', built: 'new\n', source: 'apps/web', output: 'dist' })

    await expect(verifyDesktopVendorBuild(root)).rejects.toThrow(
      'contains stale dist/index.js relative to apps/web/package.json',
    )
  })
})
