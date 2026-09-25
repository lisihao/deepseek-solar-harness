import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REQUIRED_CONFIG_MARKERS } from '../lib/preflight.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(root, 'runtime/source-manifest.json'), 'utf8'))
const runtime = await readFile(resolve(root, 'runtime/governance.py'))
const patch = await readFile(resolve(root, 'cordis.patch.yml'), 'utf8')
const client = await readFile(resolve(root, 'lib/client.js'), 'utf8')
const digest = createHash('sha256').update(runtime).digest('hex')

const errors = []
if (pkg.name !== '@lisihao/dsh-code-harness-governance') errors.push('package name mismatch')
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') errors.push('missing dsh.bundle patch declaration')
if (pkg.dsh?.client?.platform !== 'web') errors.push('missing dsh.client web declaration')
if (pkg.exports?.['./client'] !== './lib/client.js') errors.push('missing client bundle export')
if (manifest.source_sha256 !== digest) errors.push('packaged governance.py digest does not match manifest')
for (const marker of REQUIRED_CONFIG_MARKERS.slice(0, 3)) {
  const packageName = marker.slice('name: '.length)
  if (!patch.includes(packageName)) errors.push(`cordis patch missing ${packageName}`)
}
if (!patch.includes('strict: true')) errors.push('cordis patch must enable strict mode')
for (const marker of [
  'code-harness-governance-trace',
  '/code-harness/v1/trace',
  'data-testid',
]) {
  if (!client.includes(marker)) errors.push(`client bundle missing ${marker}`)
}
const clientCheck = spawnSync(process.execPath, [resolve(root, 'scripts/build-client.mjs'), '--check'], {
  cwd: root,
  encoding: 'utf8',
})
if (clientCheck.status !== 0) errors.push(clientCheck.stderr.trim() || clientCheck.stdout.trim())
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`)
  process.exit(1)
}
console.log(`DSH governance bundle is valid; runtime sha256=${digest}`)
