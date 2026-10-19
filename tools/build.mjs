import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const packages = []
for (const name of ['native-resident', 'native-collaboration', 'model-handoff']) {
  try { await stat(join(root, 'incubator', name, 'package.json')); packages.push(name) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
if (packages.length === 0) throw new Error('No native plugin candidate is present.')
for (const name of packages) {
  const directory = join(root, 'incubator', name)
  await rm(join(directory, 'lib'), { recursive: true, force: true })
  await build({
    entryPoints: name === 'native-resident'
      ? ['src/index.ts', 'src/daemon.ts', 'src/client.ts', 'src/contracts.ts']
      : ['src/index.ts'],
    absWorkingDir: directory,
    outdir: 'lib',
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
  })
}
const declarations = join(root, '.build-types')
await rm(declarations, { recursive: true, force: true })
const config = join(root, 'tools', 'tsconfig.build.json')
await writeFile(config, JSON.stringify({
  extends: '../tsconfig.json',
  compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, rootDir: '../incubator', outDir: '../.build-types' },
  include: ['../incubator/*/src/**/*.ts'],
  exclude: ['../incubator/*/tests/**', '../incubator/*/lib/**', '../node_modules/**'],
}, null, 2) + '\n')
execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', config], { cwd: root, stdio: 'inherit' })
for (const name of packages) {
  const target = join(root, 'incubator', name, 'lib', 'types')
  await mkdir(target, { recursive: true })
  await cp(join(declarations, name, 'src'), target, { recursive: true })
}
console.log(`Built ${packages.join(', ')} and declarations.`)
