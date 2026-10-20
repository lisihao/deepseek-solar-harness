import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const PACKAGE_ROOT = join(ROOT, 'incubator', 'rlm')
const LIB = join(PACKAGE_ROOT, 'lib')
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc')

const REQUIRED_SOURCES = [
  'src/index.ts',
  'src/selftest.ts',
  'src/client.ts',
  'src/remote.ts',
  'src/typert.ts',
]

async function requireSources() {
  for (const relative of REQUIRED_SOURCES) {
    const path = join(PACKAGE_ROOT, relative)
    const info = await stat(path).catch(() => undefined)
    if (info?.isFile() !== true) throw new Error(`RLM build input is missing: ${path}`)
  }
  const tsc = await stat(TSC).catch(() => undefined)
  if (tsc?.isFile() !== true) throw new Error(`TypeScript compiler is missing: ${TSC}`)
}

async function buildJavaScript() {
  await build({
    absWorkingDir: PACKAGE_ROOT,
    entryPoints: ['src/index.ts', 'src/selftest.ts', 'src/remote.ts', 'src/typert.ts'],
    outdir: 'lib',
    bundle: true,
    packages: 'external',
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
  })
  await build({
    absWorkingDir: PACKAGE_ROOT,
    entryPoints: ['src/client.ts'],
    outfile: 'lib/client.cjs',
    bundle: true,
    packages: 'external',
    platform: 'browser',
    target: 'es2022',
    format: 'cjs',
    sourcemap: true,
  })
}

async function buildDeclarations() {
  const temporaryRoot = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'dsh-v4-rlm-types-'))
  const configPath = join(temporaryRoot, 'tsconfig.json')
  const config = {
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      declaration: true,
      emitDeclarationOnly: true,
      rootDir: join(PACKAGE_ROOT, 'src'),
      outDir: join(LIB, 'types'),
      types: ['node'],
      typeRoots: [join(ROOT, 'node_modules', '@types')],
    },
    include: [join(PACKAGE_ROOT, 'src', '**', '*.ts')],
    exclude: [join(PACKAGE_ROOT, 'tests'), join(ROOT, 'node_modules')],
  }
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  try {
    execFileSync(TSC, ['-p', configPath], { cwd: ROOT, stdio: 'inherit' })
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function main() {
  await requireSources()
  await rm(LIB, { recursive: true, force: true })
  await buildJavaScript()
  await buildDeclarations()
  process.stdout.write('build-rlm: generated ESM host entries, CJS client, and declarations.\n')
}

main().catch((error) => {
  process.stderr.write(`build-rlm: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
