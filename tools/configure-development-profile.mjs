#!/usr/bin/env node

import { open, readFile, rename, rm, stat } from 'node:fs/promises'
import { execFile as execFileCallback } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export const BENCH_PACKAGE = '@lisihao/dsh-solar-bench'
export const PATCH_FILENAME = 'cordis.patch.yml'
export const DEFAULT_APP_NAME = 'DeepSeek Harness.app'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(message) {
  throw new Error(message)
}

function assertAbsolutePath(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    fail(`${label} must be an absolute path`)
  }
  return normalize(value)
}

export function launcherPathForApp(appPath) {
  return join(assertAbsolutePath(appPath, '--app'), 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh')
}

export function hostModulesPathForApp(appPath) {
  return join(assertAbsolutePath(appPath, '--app'), 'Contents', 'Resources', 'app', 'dsh', 'node_modules')
}

/** Physical directory and logical ASAR path used by the two supported App bundles. */
export function hostModulesPathCandidatesForApp(appPath) {
  const app = assertAbsolutePath(appPath, '--app')
  const resources = join(app, 'Contents', 'Resources')
  return [
    join(resources, 'app', 'dsh', 'node_modules'),
    join(resources, 'app.asar', 'dsh', 'node_modules'),
  ]
}

function assertId(id, location) {
  if (typeof id !== 'string' || id.trim() === '') {
    fail(`${location} has a malformed id`)
  }
}

function validateInsertEntries(insertEntries, location) {
  if (!Array.isArray(insertEntries)) fail(`${location}.insert must be an array`)
  for (const [index, entry] of insertEntries.entries()) {
    if (!isRecord(entry)) fail(`${location}.insert[${index}] must be an object`)
    if (!Object.prototype.hasOwnProperty.call(entry, 'id')) {
      fail(`${location}.insert[${index}] is missing id`)
    }
    assertId(entry.id, `${location}.insert[${index}]`)
  }
}

/**
 * Validate the small Cordis profile patch shape used by this helper.
 * Unknown fields are intentionally left untouched; only ids and the operation
 * container are checked so a profile can retain unrelated plugin settings.
 */
export function validatePatchEntries(entries) {
  if (!Array.isArray(entries)) fail('cordis.patch.yml must contain a top-level array')

  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry)) fail(`cordis.patch.yml entry ${index} must be an object`)

    const hasId = Object.prototype.hasOwnProperty.call(entry, 'id')
    const hasInsert = Object.prototype.hasOwnProperty.call(entry, 'insert')
    if (hasId) assertId(entry.id, `cordis.patch.yml entry ${index}`)
    if (hasInsert) validateInsertEntries(entry.insert, `cordis.patch.yml entry ${index}`)
    if (!hasId && !hasInsert) {
      fail(`cordis.patch.yml entry ${index} must have id or insert`)
    }
  }

  const benchEntries = entries.filter((entry) => entry.id === 'solar-bench')
  if (benchEntries.length > 1) fail('cordis.patch.yml contains multiple solar-bench entries')
  return entries
}

function sameLauncher(config, launcher) {
  return isRecord(config) && Array.isArray(config.launcher) && config.launcher.length === 1 && config.launcher[0] === launcher
}

/**
 * Return a new plain patch array with the destination launcher merged into the
 * top-level solar-bench override. The input is never mutated.
 */
export function mergeBenchLauncher(entries, launcher) {
  validatePatchEntries(entries)
  assertAbsolutePath(launcher, 'launcher')
  const next = structuredClone(entries)
  const index = next.findIndex((entry) => entry.id === 'solar-bench')
  if (index === -1) {
    next.push({ id: 'solar-bench', config: { launcher: [launcher] } })
    return { entries: next, changed: true, added: true }
  }

  const entry = next[index]
  if (entry.config !== undefined && !isRecord(entry.config)) {
    fail('solar-bench.config must be an object')
  }
  if (sameLauncher(entry.config, launcher)) {
    return { entries: next, changed: false, added: false }
  }
  entry.config = { ...(entry.config ?? {}), launcher: [launcher] }
  return { entries: next, changed: true, added: false }
}

function yamlDocumentEntries(document) {
  const json = document.toJSON()
  validatePatchEntries(json)
  return json
}

function findTopLevelBenchNode(document) {
  const contents = document.contents
  if (!contents || !Array.isArray(contents.items)) return null
  return contents.items.find((item) => item && typeof item.get === 'function' && item.get('id') === 'solar-bench') ?? null
}

function setBenchNodeLauncher(document, launcher) {
  const node = findTopLevelBenchNode(document)
  if (!node) {
    document.contents.add({ id: 'solar-bench', config: { launcher: [launcher] } })
    return
  }

  const configNode = node.get('config', true)
  if (configNode === undefined || configNode === null) {
    node.set('config', { launcher: [launcher] })
    return
  }
  if (!configNode || typeof configNode.set !== 'function' || Array.isArray(configNode)) {
    fail('solar-bench.config must be an object')
  }
  configNode.set('launcher', [launcher])
}

function loadYamlForProfile(profileDir) {
  const packageJsonPath = join(profileDir, 'package.json')
  const requireFromProfile = createRequire(packageJsonPath)
  let yaml
  try {
    yaml = requireFromProfile('yaml')
  } catch (error) {
    fail(`profile yaml dependency could not be loaded from ${packageJsonPath}: ${error.message}`)
  }
  if (!yaml || typeof yaml.parseDocument !== 'function') {
    fail('profile yaml module does not provide parseDocument')
  }
  return { yaml, requireFromProfile, packageJsonPath }
}

function packageJsonCandidatePaths(profileDir) {
  return [
    join(profileDir, 'node_modules', '@lisihao', 'dsh-solar-bench', 'package.json'),
    join(profileDir, 'node_modules', '.pnpm', '@lisihao+dsh-solar-bench', 'node_modules', '@lisihao', 'dsh-solar-bench', 'package.json'),
  ]
}

async function assertBenchInstalled(profileDir, requireFromProfile) {
  const packageSubpath = `${BENCH_PACKAGE}/package.json`
  const inspectPackage = async (packageJsonPath) => {
    let packageJson
    try {
      packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
    } catch (error) {
      fail(`installed package ${BENCH_PACKAGE} has an unreadable package.json at ${packageJsonPath}: ${error.message}`)
    }
    if (packageJson?.name !== BENCH_PACKAGE) {
      fail(`installed package path ${packageJsonPath} does not declare name ${BENCH_PACKAGE}`)
    }
    return packageJsonPath
  }
  try {
    const resolved = requireFromProfile.resolve(packageSubpath)
    const metadata = await stat(resolved)
    if (metadata.isFile()) return inspectPackage(resolved)
  } catch {
    // Fall through to the direct profile paths. Some pnpm layouts do not
    // expose package.json through the package exports map.
  }
  for (const candidate of packageJsonCandidatePaths(profileDir)) {
    try {
      const metadata = await stat(candidate)
      if (metadata.isFile()) return inspectPackage(candidate)
    } catch {
      // Continue checking the next supported profile layout.
    }
  }
  fail(`installed package ${BENCH_PACKAGE} was not found in ${profileDir}`)
}

async function assertFile(path, label) {
  let metadata
  try {
    metadata = await stat(path)
  } catch {
    fail(`${label} does not exist: ${path}`)
  }
  if (!metadata.isFile()) fail(`${label} is not a file: ${path}`)
}

async function assertDirectory(path, label) {
  let metadata
  try {
    metadata = await stat(path)
  } catch {
    fail(`${label} does not exist: ${path}`)
  }
  if (!metadata.isDirectory()) fail(`${label} is not a directory: ${path}`)
}

async function resolveHostModulesPath(appPath) {
  const [unpacked, asarLogical] = hostModulesPathCandidatesForApp(appPath)
  try {
    const metadata = await stat(unpacked)
    if (metadata.isDirectory()) return unpacked
  } catch {
    // Try the ASAR bundle below. An ASAR child is not a normal shell directory.
  }
  try {
    const metadata = await stat(asarLogical)
    if (metadata.isDirectory()) return asarLogical
  } catch {
    // A regular app.asar file is the archive root for this logical path.
  }
  const asarRoot = join(dirname(dirname(dirname(asarLogical))), 'app.asar')
  try {
    const metadata = await stat(asarRoot)
    if (metadata.isFile()) return asarLogical
  } catch {
    // Report both supported layouts in the final error.
  }
  fail(`bundled host modules do not exist at ${unpacked} or ${asarLogical}`)
}

function candidateAppPaths(appPath, homeDir = homedir()) {
  return [...new Set([
    normalize(appPath),
    join('/Applications', DEFAULT_APP_NAME),
    join(homeDir, 'Applications', DEFAULT_APP_NAME),
  ])]
}

function parsePsRecords(psOutput) {
  const records = []
  for (const line of String(psOutput ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (match) records.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] })
  }
  return records
}

/**
 * Return processes whose executable path is inside one of the application
 * bundles. This pure check accepts captured `ps -axo pid=,ppid=,comm=` output
 * so tests can exercise the guard without launching or stopping an app.
 */
export function findLiveApplicationProcesses(psOutput, appPath, { homeDir = homedir(), ignoredPids = [process.pid] } = {}) {
  const records = parsePsRecords(psOutput)
  const ignored = new Set(ignoredPids)
  const candidates = candidateAppPaths(assertAbsolutePath(appPath, '--app'), homeDir)
  const matches = []
  for (const record of records) {
    if (ignored.has(record.pid)) continue
    const candidate = candidates.find((path) => record.comm === path || record.comm.startsWith(`${path}${sep}`))
    if (candidate) matches.push({ pid: record.pid, path: candidate })
  }
  return matches
}

export function assertApplicationsStopped(psOutput, appPath, options = {}) {
  const matches = findLiveApplicationProcesses(psOutput, appPath, options)
  if (matches.length > 0) {
    const summary = [...new Map(matches.map((match) => [match.pid, match.path]))]
      .map(([pid, path]) => `${path} (pid ${pid})`).join(', ')
    fail(`active DeepSeek Harness process detected: ${summary}`)
  }
  return true
}

async function readProcessList() {
  const result = await execFile('ps', ['-axo', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  return result.stdout
}

function timestampForFilename() {
  return new Date().toISOString().replaceAll(/[-:.TZ]/g, '')
}

async function createPrivateBackup(patchPath, source) {
  const backupPath = `${patchPath}.bak.${timestampForFilename()}.${process.pid}.${Math.random().toString(16).slice(2)}`
  const handle = await open(backupPath, 'wx', 0o600)
  try {
    await handle.writeFile(source, 'utf8')
    await handle.chmod(0o600)
  } finally {
    await handle.close()
  }
  return backupPath
}

async function atomicWrite(path, content, mode) {
  const temporary = join(dirname(path), `.${path.split(sep).pop()}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`)
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content, 'utf8')
      await handle.chmod(mode & 0o777)
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function parsePatchDocument(yaml, source, patchPath) {
  let document
  try {
    document = yaml.parseDocument(source, { prettyErrors: true })
  } catch (error) {
    fail(`could not parse ${patchPath}: ${error.message}`)
  }
  if (document.errors?.length) {
    fail(`could not parse ${patchPath}: ${document.errors[0].message}`)
  }
  try {
    yamlDocumentEntries(document)
  } catch (error) {
    fail(`invalid ${patchPath}: ${error.message}`)
  }
  return document
}

/**
 * Inspect or update one disposable/real profile. No credential file is read;
 * only package.json, cordis.patch.yml, and app path metadata are inspected.
 */
export async function configureDevelopmentProfile({
  profileDir,
  appPath,
  apply = false,
  processListText,
  homeDir = homedir(),
} = {}) {
  const profile = assertAbsolutePath(profileDir, '--profile')
  const app = assertAbsolutePath(appPath, '--app')
  if (!app.endsWith('.app')) fail('--app must name an absolute .app path')
  await assertDirectory(profile, '--profile directory')
  await assertDirectory(app, '--app bundle')

  const patchPath = join(profile, PATCH_FILENAME)
  const { yaml, requireFromProfile } = loadYamlForProfile(profile)
  await assertBenchInstalled(profile, requireFromProfile)
  const launcher = launcherPathForApp(app)
  const hostmodules = await resolveHostModulesPath(app)
  await assertFile(launcher, 'bundled dsh launcher')

  let source
  let patchStat
  try {
    ;[source, patchStat] = await Promise.all([readFile(patchPath, 'utf8'), stat(patchPath)])
  } catch (error) {
    fail(`profile patch could not be read at ${patchPath}: ${error.message}`)
  }
  const document = parsePatchDocument(yaml, source, patchPath)
  const entries = document.toJSON()
  const merged = mergeBenchLauncher(entries, launcher)
  let backup = null

  if (apply) {
    const psOutput = processListText ?? await readProcessList()
    assertApplicationsStopped(psOutput, app, { homeDir })
    if (merged.changed) {
      setBenchNodeLauncher(document, launcher)
      const output = document.toString()
      backup = await createPrivateBackup(patchPath, source)
      try {
        await atomicWrite(patchPath, output, patchStat.mode)
      } catch (error) {
        fail(`could not atomically write ${patchPath}: ${error.message}`)
      }
    }
  }

  return { changed: merged.changed, launcher, hostmodules, backup }
}

function parseArgs(argv) {
  let profileDir
  let appPath
  let apply = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') {
      apply = true
    } else if (arg === '--profile') {
      profileDir = argv[++index]
    } else if (arg === '--app') {
      appPath = argv[++index]
    } else if (arg === '--help' || arg === '-h') {
      return { help: true }
    } else {
      fail(`unknown argument: ${arg}`)
    }
  }
  if (!profileDir) fail('--profile <absolute profile dir> is required')
  if (!appPath) fail('--app <absolute .app path> is required')
  return { profileDir, appPath, apply }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write('Usage: node tools/configure-development-profile.mjs --profile <absolute profile dir> --app <absolute .app path> [--apply]\n')
    return
  }
  const result = await configureDevelopmentProfile(args)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const thisFile = fileURLToPath(import.meta.url)
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : ''
if (resolve(thisFile) === invokedFile) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
