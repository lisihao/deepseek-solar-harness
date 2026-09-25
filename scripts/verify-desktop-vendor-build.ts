/** Verify that Desktop's sealed core archives contain the current root build outputs. */

import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ARCHIVE_MEMBER_MAX_BYTES = 16 * 1024 * 1024

/** Parse generated files from `tar -tzf`, accepting native LF or CRLF output. */
export function parseGeneratedArchiveMembers(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .filter(member => member.startsWith('package/lib/') && !member.endsWith('/'))
    .map(member => member.slice('package/'.length))
    .sort()
}

function assertInside(parent: string, child: string, label: string): void {
  const path = relative(parent, child)
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`verify-desktop-vendor-build: ${label} escapes ${parent}`)
  }
}

/**
 * Compare every root-workspace Desktop archive with the current built package.
 * @param repositoryRoot - repository whose build output and Desktop inputs are checked.
 * @returns counts of checked archives and generated files.
 */
export async function verifyDesktopVendorBuild(
  repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
): Promise<{ archives: number; files: number }> {
  const vendorRoot = join(repositoryRoot, 'products/desktop/dsh-plugin-desktop/vendor')
  const manifest: unknown = JSON.parse(
    await readFile(join(vendorRoot, 'manifest.json'), 'utf8'),
  )
  if (typeof manifest !== 'object'
    || manifest === null
    || !('schemaVersion' in manifest)
    || manifest.schemaVersion !== 1
    || !('sourcePackages' in manifest)
    || manifest.sourcePackages === null
    || typeof manifest.sourcePackages !== 'object') {
    throw new Error('verify-desktop-vendor-build: invalid manifest schema')
  }

  let archives = 0
  let files = 0
  const stale: string[] = []
  for (const [archivePath, sourceManifestPath] of Object.entries(manifest.sourcePackages)) {
    if (typeof sourceManifestPath !== 'string') {
      throw new Error(`verify-desktop-vendor-build: invalid source path for ${archivePath}`)
    }
    if (!sourceManifestPath.startsWith('packages/')) continue
    if (!archivePath.startsWith('dsh-packages/') || !archivePath.endsWith('.tgz')) {
      throw new Error(`verify-desktop-vendor-build: invalid archive path ${archivePath}`)
    }
    if (isAbsolute(sourceManifestPath) || !sourceManifestPath.endsWith('/package.json')) {
      throw new Error(`verify-desktop-vendor-build: invalid source path ${sourceManifestPath}`)
    }

    const archive = resolve(vendorRoot, archivePath)
    const sourceRoot = dirname(resolve(repositoryRoot, sourceManifestPath))
    assertInside(vendorRoot, archive, `archive ${archivePath}`)
    assertInside(repositoryRoot, sourceRoot, `source ${sourceManifestPath}`)

    const archiveMembers = parseGeneratedArchiveMembers(
      execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }),
    )
    if (archiveMembers.length === 0) {
      throw new Error(`verify-desktop-vendor-build: ${archivePath} contains no generated lib files`)
    }

    for (const member of archiveMembers) {
      const sourceFile = resolve(sourceRoot, member)
      assertInside(sourceRoot, sourceFile, `archive member ${member}`)
      const archivedContents = execFileSync('tar', ['-xOf', archive, `package/${member}`], {
        maxBuffer: ARCHIVE_MEMBER_MAX_BYTES,
      })
      let sourceContents: Buffer
      try {
        sourceContents = await readFile(sourceFile)
      }
      catch (cause) {
        stale.push(`${sourceManifestPath} is missing built ${member}; run pnpm run build first (${String(cause)})`)
        continue
      }
      if (!sourceContents.equals(archivedContents)) {
        stale.push(`${archivePath} contains stale ${member} relative to ${sourceManifestPath}`)
      }
      files += 1
    }
    archives += 1
  }
  if (archives === 0) throw new Error('verify-desktop-vendor-build: manifest maps no root workspace archives')
  if (stale.length > 0) {
    throw new Error(`verify-desktop-vendor-build: ${stale.length} stale generated archive file(s)\n${stale.join('\n')}`)
  }
  return { archives, files }
}

const invoked = process.argv[1]
if (invoked !== undefined && resolve(invoked) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyDesktopVendorBuild()
    console.log(
      `verify-desktop-vendor-build: ${result.files} generated archive files in ${result.archives} root workspaces match the current build.`,
    )
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
