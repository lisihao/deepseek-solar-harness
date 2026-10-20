#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  copyFile,
  cp,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  readlink,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const PRIME_COMMIT = '7cbffa77b38facd7c87277fa3c82bcadbe816880'
const EXPECTED_BINARY_SHA256 = '6e2780ce477b52e23f24afcc24fc332026aa628fa9cd9a7a25659b997e61cca0'
const FORMAT_VERSION = 1
const REQUIRED_LOCKS = ['uv.lock', 'requirements.third-party.lock']
const LOCK_FILES = [
  'uv.lock',
  'requirements.lock',
  'requirements.third-party.lock',
  'dependency-manifest.txt',
  'installed-wheel-manifest.tsv',
  'payload-manifest.json',
]
const OPTIONAL_PACKAGE_ASSETS = ['models.bundled.json', 'mcp-services.bundled.json']
const DISALLOWED_SOURCE_PARTS = new Set([
  '.git',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  'target',
  'test',
  'tests',
])

function usage() {
  return [
    'Usage: node tools/rlm-capsule.mjs --source <prime-checkout> --binary <prime-agent> --python-prefix <prefix> --output <assets-dir>',
    '',
    'Assemble an offline macOS arm64 Prime Agent capsule without running pip, uv, Cargo, or network commands.',
  ].join('\n')
}

function fail(code, message) {
  throw new Error(`${code}: ${message}`)
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--help' || item === '-h') {
      console.log(usage())
      process.exit(0)
    }
    if (!item.startsWith('--')) fail('RLM_CAPSULE_ARGS', `unknown argument ${item}`)
    const key = item.slice(2)
    if (!['source', 'binary', 'python-prefix', 'output'].includes(key)) {
      fail('RLM_CAPSULE_ARGS', `unknown option --${key}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) fail('RLM_CAPSULE_ARGS', `missing value for --${key}`)
    values[key] = value
    index += 1
  }
  for (const key of ['source', 'binary', 'python-prefix', 'output']) {
    if (!values[key]) fail('RLM_CAPSULE_ARGS', `--${key} is required`)
  }
  return values
}

async function run(command, args, options = {}) {
  try {
    return await execFile(command, args, {
      ...options,
      maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : ''
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : ''
    const detail = [stderr, stdout].filter(Boolean).join(' | ')
    fail('RLM_CAPSULE_COMMAND', `${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function isDirectory(path) {
  try {
    return (await lstat(path)).isDirectory()
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function assertFile(path, label) {
  if (!(await isFile(path))) fail('RLM_CAPSULE_MISSING', `${label} is not a file: ${path}`)
}

async function assertDirectory(path, label) {
  if (!(await isDirectory(path))) fail('RLM_CAPSULE_MISSING', `${label} is not a directory: ${path}`)
}

async function digest(path) {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk)
  return hash.digest('hex')
}

function relativeParts(path) {
  return path.split(sep).filter(Boolean)
}

function toPosix(path) {
  return path.split(sep).join('/')
}

function shouldCopySource(relativePath) {
  const parts = relativeParts(relativePath)
  if (parts.some(part => DISALLOWED_SOURCE_PARTS.has(part))) return false
  if (parts.some(part => part.endsWith('.pyc') || part.endsWith('.egg-info'))) return false
  return true
}

async function copyFilteredTree(source, destination) {
  await mkdir(destination, { recursive: true })
  async function walk(sourceDir, destinationDir, prefix) {
    const entries = (await readdir(sourceDir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name
      if (!shouldCopySource(relativePath)) continue
      const sourcePath = join(sourceDir, entry.name)
      const destinationPath = join(destinationDir, entry.name)
      if (entry.isSymbolicLink()) fail('RLM_CAPSULE_SYMLINK', `source asset contains a symlink: ${sourcePath}`)
      if (entry.isDirectory()) {
        await mkdir(destinationPath, { recursive: true })
        await walk(sourcePath, destinationPath, relativePath)
        continue
      }
      if (!entry.isFile()) fail('RLM_CAPSULE_SOURCE_ENTRY', `unsupported source entry: ${sourcePath}`)
      await copyFile(sourcePath, destinationPath)
      const mode = (await lstat(sourcePath)).mode & 0o7777
      await chmod(destinationPath, mode)
    }
  }
  await walk(source, destination, '')
}

async function copyPrefix(prefix, destination) {
  await assertDirectory(prefix, 'Python prefix')
  async function walk(sourceDir, destinationDir) {
    await mkdir(destinationDir, { recursive: true })
    const entries = (await readdir(sourceDir, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const sourcePath = join(sourceDir, entry.name)
      const destinationPath = join(destinationDir, entry.name)
      if (entry.isSymbolicLink()) {
        await symlink(await readlink(sourcePath), destinationPath)
      } else if (entry.isDirectory()) {
        await walk(sourcePath, destinationPath)
      } else if (entry.isFile()) {
        await copyFile(sourcePath, destinationPath)
        await chmod(destinationPath, (await lstat(sourcePath)).mode & 0o7777)
      } else {
        fail('RLM_PYTHON_LAYOUT', `unsupported Python prefix entry: ${sourcePath}`)
      }
    }
  }
  await walk(prefix, destination)
}

async function sourceStatus(source) {
  const root = (await run('git', ['-C', source, 'rev-parse', '--show-toplevel'])).stdout.trim()
  if (resolve(root) !== source) fail('RLM_SOURCE_PATH', `not the requested worktree: ${root}`)
  const commit = (await run('git', ['-C', source, 'rev-parse', '--verify', 'HEAD'])).stdout.trim()
  if (commit !== PRIME_COMMIT) fail('RLM_SOURCE_WRONGPIN', `expected ${PRIME_COMMIT}, found ${commit}`)
  const status = (await run('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all'])).stdout.trim()
  if (status) fail('RLM_SOURCE_DIRTY', `Prime source worktree is dirty:\n${status}`)
  return commit
}

function cargoVersion(cargoText) {
  const match = /^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoText)
  if (!match) fail('RLM_SOURCE_MANIFEST', 'Cargo.toml has no [workspace.package] version')
  return match[1]
}

async function pythonVersion(python) {
  const result = await run(python, ['--version'])
  const output = `${result.stdout}\n${result.stderr}`
  const match = /Python\s+([0-9]+\.[0-9]+\.[0-9]+)/.exec(output)
  if (!match) fail('RLM_PYTHON_VERSION', `could not read Python version from ${output.trim()}`)
  return match[1]
}

async function copyLockAndLicenseAssets(prefix, source, stage, runtimeLockRequirements) {
  const capsuleRoot = dirname(prefix)
  const lockDestination = join(stage, 'locks')
  await mkdir(lockDestination, { recursive: true })
  let copiedLocks = 0
  for (const name of LOCK_FILES) {
    const candidate = join(capsuleRoot, name)
    if (!(await isFile(candidate))) continue
    await copyFile(candidate, join(lockDestination, name))
    copiedLocks += 1
  }
  const missingLocks = []
  for (const name of REQUIRED_LOCKS) {
    if (!(await isFile(join(lockDestination, name)))) missingLocks.push(name)
  }
  if (missingLocks.length) fail('RLM_CAPSULE_LOCKS_MISSING', `Python payload sibling is missing ${missingLocks.join(', ')}`)

  await assertFile(runtimeLockRequirements, 'runtime-lock/requirements.txt')
  const payloadRequirements = join(capsuleRoot, 'requirements.third-party.lock')
  const [runtimeLockBytes, payloadRequirementsBytes] = await Promise.all([
    readFile(runtimeLockRequirements),
    readFile(payloadRequirements),
  ])
  if (!runtimeLockBytes.equals(payloadRequirementsBytes)) {
    fail('RLM_CAPSULE_LOCK_MISMATCH', 'runtime-lock/requirements.txt differs from the payload requirements.third-party.lock')
  }
  await copyFile(runtimeLockRequirements, join(lockDestination, 'runtime-lock-requirements.txt'))

  await copyFile(join(source, 'Cargo.lock'), join(lockDestination, 'Cargo.lock'))
  const licenseDestination = join(stage, 'licenses')
  await mkdir(licenseDestination, { recursive: true })
  const sourceLicense = join(source, 'LICENSE')
  await copyFile(sourceLicense, join(licenseDestination, 'prime-agent-MIT.txt'))
  const payloadLicenses = join(capsuleRoot, 'licenses')
  if (await isDirectory(payloadLicenses)) await copyFilteredTree(payloadLicenses, licenseDestination)
  return {
    copiedLocks,
    capsuleRoot,
    runtimeLockRequirementsSha256: await digest(runtimeLockRequirements),
  }
}

async function collectFiles(root, predicate) {
  const output = []
  async function walk(directory, prefix) {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? join(prefix, entry.name) : entry.name
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(path, relativePath)
      } else if (entry.isFile() && predicate(relativePath)) {
        output.push({ path, relativePath })
      }
    }
  }
  await walk(root, '')
  return output
}

function isLoadedPythonSource(relativePath) {
  return ['.py', '.md'].includes(extname(relativePath).toLowerCase())
}

async function sitePackagesDir(prefix) {
  const lib = join(prefix, 'lib')
  const entries = (await readdir(lib, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^python\d+\.\d+$/.test(entry.name))
  const candidates = entries.map(entry => join(lib, entry.name, 'site-packages'))
  const existing = []
  for (const candidate of candidates) if (await isDirectory(candidate)) existing.push(candidate)
  if (existing.length !== 1) fail('RLM_PYTHON_LAYOUT', `expected one Python site-packages directory, found ${existing.length}`)
  return existing[0]
}

async function skillPackageRoots(source, prefix, sitePackages) {
  const skills = join(source, 'skills')
  const entries = (await readdir(skills, { withFileTypes: true }))
    .filter(entry => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  const roots = []
  for (const entry of entries) {
    const skillDir = join(skills, entry.name)
    const manifest = join(skillDir, 'pyproject.toml')
    if (!(await isFile(manifest))) continue
    const text = await readFile(manifest, 'utf8')
    const packages = [...text.matchAll(/packages\s*=\s*\[([^\]]*)\]/g)]
      .flatMap(match => [...match[1].matchAll(/"src\/([^"]+)"/g)].map(value => value[1]))
    for (const packageName of packages) {
      roots.push({
        sourceRoot: join(skillDir, 'src', packageName),
        loadedRoot: join(sitePackages, packageName),
        sourcePrefix: toPosix(relative(source, join(skillDir, 'src', packageName))),
        loadedPrefix: toPosix(join('python', relative(prefix, join(sitePackages, packageName)))),
      })
    }
  }
  return roots
}

async function compareLoadedTree(sourceRoot, loadedRoot, sourcePrefix, loadedPrefix) {
  await assertDirectory(sourceRoot, `Prime source package ${sourcePrefix}`)
  await assertDirectory(loadedRoot, `loaded Python package ${loadedPrefix}`)
  const sourceFiles = await collectFiles(sourceRoot, isLoadedPythonSource)
  const loadedFiles = await collectFiles(loadedRoot, isLoadedPythonSource)
  const sourceByRelative = new Map(sourceFiles.map(file => [file.relativePath, file]))
  const loadedByRelative = new Map(loadedFiles.map(file => [file.relativePath, file]))
  const mappings = []
  for (const relativePath of [...sourceByRelative.keys()].sort()) {
    const sourceFile = sourceByRelative.get(relativePath)
    const loadedFile = loadedByRelative.get(relativePath)
    if (!loadedFile) fail('RLM_SOURCE_LOADED_MISSING', `loaded Python file missing: ${join(loadedPrefix, relativePath)}`)
    const [sourceBytes, loadedBytes] = await Promise.all([readFile(sourceFile.path), readFile(loadedFile.path)])
    if (!sourceBytes.equals(loadedBytes)) {
      fail('RLM_SOURCE_LOADED_MISMATCH', `source and loaded Python bytes differ: ${join(sourcePrefix, relativePath)} -> ${join(loadedPrefix, relativePath)}`)
    }
    mappings.push({
      sourcePath: toPosix(join(sourcePrefix, relativePath)),
      loadedPath: toPosix(join(loadedPrefix, relativePath)),
      sourceSha256: await digest(sourceFile.path),
      loadedSha256: await digest(loadedFile.path),
    })
  }
  for (const relativePath of loadedByRelative.keys()) {
    if (!sourceByRelative.has(relativePath)) fail('RLM_SOURCE_LOADED_EXTRA', `loaded Python file has no fixed-source counterpart: ${join(loadedPrefix, relativePath)}`)
  }
  return mappings
}

async function compareLoadedSources(source, prefix) {
  const sitePackages = await sitePackagesDir(prefix)
  const runtimeMappings = await compareLoadedTree(
    join(source, 'prime-agent-runtime', 'src', 'rlm'),
    join(sitePackages, 'rlm'),
    'prime-agent-runtime/src/rlm',
    toPosix(join('python', relative(prefix, join(sitePackages, 'rlm')))),
  )
  const skillMappings = []
  for (const root of await skillPackageRoots(source, prefix, sitePackages)) {
    skillMappings.push(...await compareLoadedTree(root.sourceRoot, root.loadedRoot, root.sourcePrefix, root.loadedPrefix))
  }
  return {
    sitePackagesPath: toPosix(join('python', relative(prefix, sitePackages))),
    files: [...runtimeMappings, ...skillMappings].sort((left, right) => left.loadedPath.localeCompare(right.loadedPath)),
  }
}

async function normalizeMtimes(root) {
  const epoch = new Date(0)
  async function walk(path) {
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) {
      try { await lutimes(path, epoch, epoch) } catch { /* platform may not expose symlink timestamps */ }
      return
    }
    if (metadata.isDirectory()) {
      const entries = await readdir(path)
      for (const entry of entries) await walk(join(path, entry))
      await utimes(path, epoch, epoch)
      return
    }
    if (metadata.isFile()) await utimes(path, epoch, epoch)
  }
  await walk(root)
}

async function buildCriticalFiles(stage, loadedSources) {
  const critical = {}
  async function add(relativePath) {
    const path = join(stage, relativePath)
    await assertFile(path, `critical file ${relativePath}`)
    critical[relativePath] = await digest(path)
  }
  await add('prime/prime-agent')
  await add('python/bin/python3')
  for (const relativePath of [
    'prime/package.json',
    'prime/LICENSE',
    'prime/README.md',
    'prime/prime-agent-runtime/pyproject.toml',
    'locks/Cargo.lock',
  ]) await add(relativePath)
  for (const name of LOCK_FILES) {
    if (await isFile(join(stage, 'locks', name))) await add(join('locks', name))
  }
  await add('locks/runtime-lock-requirements.txt')
  const runtimeFiles = await collectFiles(join(stage, 'prime/prime-agent-runtime/src/rlm'), name =>
    ['.py', '.md'].includes(extname(name).toLowerCase()))
  for (const file of runtimeFiles) await add(join('prime/prime-agent-runtime/src/rlm', file.relativePath))
  const skillFiles = await collectFiles(join(stage, 'prime/skills'), name =>
    ['.py', '.md', '.toml', '.json'].includes(extname(name).toLowerCase()))
  for (const file of skillFiles) await add(join('prime/skills', file.relativePath))
  for (const mapping of loadedSources.files) await add(mapping.loadedPath)
  return Object.fromEntries(Object.entries(critical).sort(([left], [right]) => left.localeCompare(right)))
}

async function createArchive(stage, archive) {
  await normalizeMtimes(stage)
  await new Promise((resolvePromise, reject) => {
    const tar = spawn('/usr/bin/tar', ['-cf', '-', '-C', stage, 'prime', 'python', 'licenses', 'locks'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const gzip = spawn('/usr/bin/gzip', ['-n', '-c'], { stdio: ['pipe', 'pipe', 'pipe'] })
    const output = createWriteStream(archive, { mode: 0o644 })
    tar.stdout.pipe(gzip.stdin)
    gzip.stdout.pipe(output)
    let stderr = ''
    tar.stderr.setEncoding('utf8')
    gzip.stderr.setEncoding('utf8')
    tar.stderr.on('data', chunk => { stderr += chunk })
    gzip.stderr.on('data', chunk => { stderr += chunk })
    let tarCode
    let gzipCode
    let outputClosed = false
    let settled = false
    const finish = () => {
      if (settled || tarCode === undefined || gzipCode === undefined || !outputClosed) return
      settled = true
      if (tarCode === 0 && gzipCode === 0) resolvePromise()
      else reject(new Error(`archive pipeline failed (tar=${tarCode}, gzip=${gzipCode}): ${stderr.trim()}`))
    }
    const failPipeline = error => {
      if (settled) return
      settled = true
      tar.kill('SIGTERM')
      gzip.kill('SIGTERM')
      output.destroy()
      reject(error)
    }
    tar.on('error', failPipeline)
    gzip.on('error', failPipeline)
    output.on('error', failPipeline)
    output.on('close', () => { outputClosed = true; finish() })
    tar.on('close', code => { tarCode = code; finish() })
    gzip.on('close', code => { gzipCode = code; finish() })
  })
}

async function validateArchive(archive) {
  const listing = (await run('/usr/bin/tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 })).stdout
    .split('\n').map(line => line.trim()).filter(Boolean)
  for (const entry of listing) {
    if (entry.startsWith('/') || relativeParts(entry).includes('..')) fail('RLM_CAPSULE_ARCHIVE', `unsafe archive entry ${entry}`)
  }
  const required = ['prime/prime-agent', 'prime/prime-agent-runtime/pyproject.toml', 'prime/prime-agent-runtime/src/rlm/repl.py', 'prime/skills', 'python/bin/python3', 'locks/Cargo.lock']
  for (const entry of required) {
    if (!listing.some(candidate => candidate === entry || candidate === `${entry}/` || candidate.startsWith(`${entry}/`))) {
      fail('RLM_CAPSULE_ARCHIVE', `archive is missing ${entry}`)
    }
  }
}

async function writeAtomic(path, contents) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temporary, contents, { mode: 0o644 })
  await rename(temporary, path)
}

async function copyAtomic(source, destination) {
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`
  await copyFile(source, temporary)
  await rename(temporary, destination)
}

async function assemble(rawArgs) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') fail('RLM_CAPSULE_PLATFORM', `requires darwin/arm64, found ${process.platform}/${process.arch}`)
  const args = Object.fromEntries(Object.entries(rawArgs).map(([key, value]) => [key, resolve(value)]))
  const source = args.source
  const binary = args.binary
  const prefix = args['python-prefix']
  const output = args.output
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const capsulePath = join(root, 'incubator/rlm/runtime-lock/capsule.json')
  const runtimeLockRequirements = join(root, 'incubator/rlm/runtime-lock/requirements.txt')

  await assertDirectory(source, 'Prime source checkout')
  await assertFile(binary, 'Prime binary')
  await assertDirectory(prefix, 'Python prefix')
  const python = join(prefix, 'bin/python3')
  await assertFile(python, 'Python prefix interpreter')
  if (((await stat(binary)).mode & 0o111) === 0) fail('RLM_BINARY_EXECUTABLE', `binary is not executable: ${binary}`)
  if (((await stat(python)).mode & 0o111) === 0) fail('RLM_PYTHON_EXECUTABLE', `Python interpreter is not executable: ${python}`)
  const sourceReal = await realpath(source)
  if (resolve(output) === sourceReal || resolve(output).startsWith(`${sourceReal}${sep}`)) fail('RLM_OUTPUT_SOURCE', 'output must not be inside the Prime source checkout')

  await sourceStatus(sourceReal)
  const binarySha256 = await digest(binary)
  if (binarySha256 !== EXPECTED_BINARY_SHA256) fail('RLM_BINARY_WRONGPIN', `expected ${EXPECTED_BINARY_SHA256}, found ${binarySha256}`)
  const sourceCargo = await readFile(join(sourceReal, 'Cargo.toml'), 'utf8')
  const cargoLock = join(sourceReal, 'Cargo.lock')
  await assertFile(cargoLock, 'Prime Cargo.lock')
  const cargoLockSha256 = await digest(cargoLock)
  const pythonVersionValue = await pythonVersion(python)
  const version = cargoVersion(sourceCargo)

  await mkdir(dirname(output), { recursive: true })
  if (await isDirectory(output)) {
    const existing = await readdir(output)
    const unexpected = existing.filter(name => !['runtime.tar.gz', 'runtime-manifest.json'].includes(name))
    if (unexpected.length) fail('RLM_OUTPUT_DIR', `output contains unmanaged files: ${unexpected.join(', ')}`)
  }
  const temporaryRoot = await mkdtemp(join(dirname(output), '.rlm-capsule-'))
  const stage = join(temporaryRoot, 'stage')
  try {
    const prime = join(stage, 'prime')
    await mkdir(prime, { recursive: true })
    await cp(binary, join(prime, 'prime-agent'), { force: true, dereference: false, preserveTimestamps: true })
    await chmod(join(prime, 'prime-agent'), 0o755)
    await copyFile(join(sourceReal, 'LICENSE'), join(prime, 'LICENSE'))
    await copyFile(join(sourceReal, 'README.md'), join(prime, 'README.md'))
    await copyFilteredTree(join(sourceReal, 'prime-agent-runtime'), join(prime, 'prime-agent-runtime'))
    await copyFilteredTree(join(sourceReal, 'skills'), join(prime, 'skills'))
    for (const name of OPTIONAL_PACKAGE_ASSETS) {
      if (await isFile(join(sourceReal, name))) await copyFile(join(sourceReal, name), join(prime, name))
    }
    await writeFile(join(prime, 'package.json'), `${JSON.stringify({
      name: 'prime-agent',
      version,
      description: 'Prime Agent: the RLM coding agent (Rust build)',
      bin: { 'prime-agent': 'prime-agent' },
      piConfig: { name: 'prime-agent', configDir: '.prime/agent' },
    }, null, 2)}\n`, { mode: 0o644 })

    const loadedSources = await compareLoadedSources(sourceReal, prefix)
    await copyPrefix(prefix, join(stage, 'python'))
    const lockInfo = await copyLockAndLicenseAssets(prefix, sourceReal, stage, runtimeLockRequirements)
    const criticalFiles = await buildCriticalFiles(stage, loadedSources)
    const archive = join(temporaryRoot, 'runtime.tar.gz')
    await createArchive(stage, archive)
    await validateArchive(archive)
    const archiveSha256 = await digest(archive)
    const manifest = {
      formatVersion: FORMAT_VERSION,
      platform: 'darwin',
      arch: 'arm64',
      primeCommit: PRIME_COMMIT,
      archiveSha256,
      binarySha256,
      pythonVersion: pythonVersionValue,
      criticalFiles,
      sourceEvidence: {
        cargoLock: { path: 'locks/Cargo.lock', sha256: cargoLockSha256 },
        runtimeLockRequirements: {
          sourcePath: 'runtime-lock/requirements.txt',
          payloadPath: 'locks/requirements.third-party.lock',
          sha256: lockInfo.runtimeLockRequirementsSha256,
        },
        loadedSources,
        runtimeSourceRoot: 'prime/prime-agent-runtime/src/rlm',
        skillsSourceRoot: 'prime/skills',
        binaryExpectedSha256: EXPECTED_BINARY_SHA256,
      },
      packageLayout: {
        packageDir: 'prime',
        binary: 'prime/prime-agent',
        python: 'python/bin/python3',
        lockCount: lockInfo.copiedLocks + 2,
      },
    }
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`
    await mkdir(output, { recursive: true })
    await copyAtomic(archive, join(output, 'runtime.tar.gz'))
    await writeAtomic(join(output, 'runtime-manifest.json'), manifestText)
    await writeAtomic(capsulePath, manifestText)
    console.log(JSON.stringify({
      output,
      archive: join(output, 'runtime.tar.gz'),
      manifest: join(output, 'runtime-manifest.json'),
      capsule: capsulePath,
      archiveSha256,
      binarySha256,
      pythonVersion: pythonVersionValue,
      criticalFileCount: Object.keys(criticalFiles).length,
    }, null, 2))
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

try {
  await assemble(parseArgs(process.argv.slice(2)))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
