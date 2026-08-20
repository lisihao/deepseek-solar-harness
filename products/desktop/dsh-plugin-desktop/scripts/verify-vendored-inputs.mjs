import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const vendorRoot = resolve(import.meta.dirname, '../vendor')
const repositoryRoot = resolve(vendorRoot, '../../../..')
const manifest = JSON.parse(await readFile(join(vendorRoot, 'manifest.json'), 'utf8'))
if (manifest.schemaVersion !== 1
  || manifest.files === null || typeof manifest.files !== 'object'
  || manifest.sourcePackages === null || typeof manifest.sourcePackages !== 'object') {
  throw new Error('verify-vendored-inputs: invalid manifest schema')
}

async function filesBelow(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await filesBelow(path))
    else if (entry.isFile()) result.push(relative(vendorRoot, path))
    else throw new Error(`verify-vendored-inputs: unsupported vendor entry ${path}`)
  }
  return result
}

const actual = [
  ...await filesBelow(join(vendorRoot, 'agent-presets')),
  ...await filesBelow(join(vendorRoot, 'dsh-packages')),
].sort()
const expected = Object.keys(manifest.files).sort()
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error(`verify-vendored-inputs: file set mismatch\nexpected=${expected.join(',')}\nactual=${actual.join(',')}`)
}

const packageArchives = actual.filter(path => path.startsWith('dsh-packages/') && path.endsWith('.tgz'))
const sourceArchives = Object.keys(manifest.sourcePackages).sort()
if (JSON.stringify(packageArchives) !== JSON.stringify(sourceArchives)) {
  throw new Error(
    `verify-vendored-inputs: source package map mismatch\nexpected=${packageArchives.join(',')}\nactual=${sourceArchives.join(',')}`,
  )
}

for (const archivePath of packageArchives) {
  const sourcePath = manifest.sourcePackages[archivePath]
  if (typeof sourcePath !== 'string' || isAbsolute(sourcePath) || !sourcePath.endsWith('/package.json')) {
    throw new Error(`verify-vendored-inputs: invalid source package path for ${archivePath}`)
  }
  const sourceManifestPath = resolve(repositoryRoot, sourcePath)
  const sourceRelative = relative(repositoryRoot, sourceManifestPath)
  if (sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)) {
    throw new Error(`verify-vendored-inputs: source package escapes repository for ${archivePath}`)
  }
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', sourcePath], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    })
  }
  catch (cause) {
    throw new Error(`verify-vendored-inputs: source package is not tracked: ${sourcePath}`, { cause })
  }
  const sourcePackage = JSON.parse(await readFile(sourceManifestPath, 'utf8'))
  const archivedPackage = JSON.parse(execFileSync(
    'tar',
    ['-xOf', join(vendorRoot, archivePath), 'package/package.json'],
    { encoding: 'utf8' },
  ))
  if (sourcePackage.name !== archivedPackage.name || sourcePackage.version !== archivedPackage.version) {
    throw new Error(
      `verify-vendored-inputs: ${archivePath} is ${archivedPackage.name}@${archivedPackage.version} but ${sourcePath} is ${sourcePackage.name}@${sourcePackage.version}`,
    )
  }
}

for (const path of expected) {
  const contents = await readFile(join(vendorRoot, path))
  const digest = createHash('sha256').update(contents).digest('hex')
  if (digest !== manifest.files[path]) {
    throw new Error(`verify-vendored-inputs: SHA-256 mismatch for ${path}`)
  }
}

for (const filename of ['tool-bootstrap.mjs', 'instruction-hint.mjs']) {
  const content = await readFile(join(vendorRoot, 'agent-presets', 'anchored-standard', filename), 'utf8')
  if (!content.includes('createEpochPromotion(promoteEvents, { includeSubagents: true })')) {
    throw new Error(`verify-vendored-inputs: ${filename} does not anchor delegated workers`)
  }
}

console.log(`verify-vendored-inputs: ${expected.length} immutable product inputs and ${sourceArchives.length} tracked source packages verified.`)
