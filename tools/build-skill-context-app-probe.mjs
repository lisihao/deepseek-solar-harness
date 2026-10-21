import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = join(root, 'tools', 'fixtures', 'skill-context-app-probe')
const output = join(fixture, 'lib')

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await build({
  absWorkingDir: root,
  entryPoints: [join(fixture, 'src', 'index.ts')],
  outfile: join(output, 'index.js'),
  bundle: true,
  // The probe's own fixture code is bundled. Host packages and the installed
  // Solar plugin remain external so the run exercises the installed bytes.
  packages: 'external',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
})

console.log('Built skill-context installed-host acceptance probe.')
