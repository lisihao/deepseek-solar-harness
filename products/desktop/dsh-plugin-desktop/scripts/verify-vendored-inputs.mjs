import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const vendorRoot = resolve(import.meta.dirname, '../vendor')
const manifest = JSON.parse(await readFile(join(vendorRoot, 'manifest.json'), 'utf8'))
if (manifest.schemaVersion !== 1 || manifest.files === null || typeof manifest.files !== 'object') {
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

console.log(`verify-vendored-inputs: ${expected.length} immutable product inputs verified.`)
