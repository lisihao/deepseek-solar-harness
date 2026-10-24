import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEMP_ROOT = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')
const SUBSCRIPTION_HUB_PACKAGE = join(ROOT, 'incubator', 'subscription-hub')
const PROBE_PACKAGE = join(ROOT, 'tools', 'fixtures', 'subscription-hub-probe')
const MARKET_ROOT = join(ROOT, 'distribution', 'plugins')
const MARKET_CATALOG = join(MARKET_ROOT, 'catalog.json')
const MAINTENANCE_PACKAGE_IDS = ['codex-subscription', 'grok-subscription']
const MAINTENANCE_PACKAGE_NAMES = {
  'codex-subscription': 'dsh-codex-subscription',
  'grok-subscription': 'dsh-grok-subscription',
}
const PROFILE = 'solar-subscription-hub-plugin-test'
const COMMAND_TIMEOUT_MS = 120_000
const BOOT_TIMEOUT_MS = 90_000
const CAPTURE_LIMIT = 128 * 1024

const CREDENTIAL_ENV = /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|CLIENT_SECRET|OAUTH|BEARER)(?:$|_)/i
const SENSITIVE_PROVIDER_ENV = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|CODEX)(?:_|$)/i

function appendCapture(current, chunk) {
  const next = current + String(chunk)
  return next.length <= CAPTURE_LIMIT ? next : next.slice(next.length - CAPTURE_LIMIT)
}

function terminateProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* process already exited */ }
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { /* process already exited */ }
  }, 2_000).unref?.()
}

function commandError(label, result) {
  return new Error([
    `${label} exited with ${result.signal ?? `status ${String(result.status)}`}`,
    result.timedOut ? 'timeout reached' : undefined,
    result.error === undefined ? undefined : `spawn error: ${result.error}`,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
  ].filter(Boolean).join('\n'))
}

async function runCommand(command, args, options = {}) {
  const { cwd = ROOT, env, timeoutMs = COMMAND_TIMEOUT_MS, label = `${command} ${args.join(' ')}` } = options
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', chunk => { stdout = appendCapture(stdout, chunk) })
  child.stderr?.on('data', chunk => { stderr = appendCapture(stderr, chunk) })
  let timedOut = false
  const result = await new Promise(resolveResult => {
    let settled = false
    let timer
    let killTimer
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolveResult({ ...value, stdout, stderr, timedOut })
    }
    child.once('error', error => finish({ status: null, signal: null, error: String(error) }))
    child.once('close', (status, signal) => finish({ status, signal, error: undefined }))
    timer = setTimeout(() => {
      timedOut = true
      terminateProcess(child)
      killTimer = setTimeout(() => finish({ status: null, signal: 'SIGKILL', error: 'process did not exit after timeout termination' }), 3_000)
      killTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
  })
  result.label = label
  return result
}

function scrubbedEnvironment({ home, dshHome, marker }) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DSH_') || CREDENTIAL_ENV.test(key) || SENSITIVE_PROVIDER_ENV.test(key) || /(?:PROXY|AUTH|CREDENTIAL)/i.test(key) || /^(?:npm_config_(?:userconfig|globalconfig|registry|_auth|auth_token)|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|REGISTRY|_AUTH|AUTH_TOKEN))$/i.test(key)) delete environment[key]
  }
  return {
    ...environment,
    HOME: home,
    USERPROFILE: home,
    DSH_HOME: dshHome,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    DSH_PERMISSION_MODE: 'workspace-write',
    SOLAR_PLUGIN_PROBE_MARKER: marker,
    SOLAR_PLUGIN_PROBE_PROFILE: PROFILE,
  }
}

async function requireFile(path, label) {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error(`${path} is not a regular file`)
  } catch (error) {
    throw new Error(`${label} is missing at ${path}: ${String(error)}`)
  }
}

async function packageManifest(packageDir, label) {
  const path = join(packageDir, 'package.json')
  await requireFile(path, `${label} package manifest`)
  try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error(`${label} package manifest is invalid: ${String(error)}`) }
}

async function validateBuiltPackages() {
  const hub = await packageManifest(SUBSCRIPTION_HUB_PACKAGE, 'subscription-hub')
  const probe = await packageManifest(PROBE_PACKAGE, 'subscription-hub probe')
  if (hub.name !== '@lisihao/dsh-solar-subscription-hub') throw new Error(`unexpected subscription-hub package name ${String(hub.name)}`)
  if (probe.name !== '@lisihao/dsh-solar-subscription-hub-probe') throw new Error(`unexpected subscription-hub probe package name ${String(probe.name)}`)
  await requireFile(join(SUBSCRIPTION_HUB_PACKAGE, 'lib', 'index.js'), 'subscription-hub build output lib/index.js')
  await requireFile(join(SUBSCRIPTION_HUB_PACKAGE, 'lib', 'client.cjs'), 'subscription-hub build output lib/client.cjs')
  await requireFile(join(PROBE_PACKAGE, 'lib', 'index.js'), 'subscription-hub probe build output lib/index.js')
  const catalog = JSON.parse(await readFile(MARKET_CATALOG, 'utf8'))
  const maintenance = []
  for (const id of MAINTENANCE_PACKAGE_IDS) {
    const entry = Array.isArray(catalog?.packages) ? catalog.packages.find(candidate => candidate?.id === id) : undefined
    if (entry === undefined) throw new Error(`catalog entry ${id} is missing from ${MARKET_CATALOG}`)
    const artifact = entry.artifact
    if (entry.name !== MAINTENANCE_PACKAGE_NAMES[id] || typeof artifact?.file !== 'string' || typeof artifact.sha256 !== 'string' || !Number.isSafeInteger(artifact.size)) {
      throw new Error(`catalog entry ${id} has no strict single-file artifact metadata`)
    }
    const artifactPath = resolve(MARKET_ROOT, artifact.file)
    if (!artifactPath.startsWith(`${MARKET_ROOT}${sep}`)) throw new Error(`catalog artifact ${id} escapes ${MARKET_ROOT}: ${artifact.file}`)
    const info = await stat(artifactPath).catch(error => { throw new Error(`catalog artifact ${id} is missing at ${artifactPath}: ${String(error)}`) })
    if (!info.isFile()) throw new Error(`catalog artifact ${id} is not a regular file: ${artifactPath}`)
    if (info.size !== artifact.size) throw new Error(`catalog artifact ${id} byte count mismatch: catalog=${artifact.size}, actual=${info.size}`)
    const digest = createHash('sha256').update(await readFile(artifactPath)).digest('hex')
    if (digest !== artifact.sha256) throw new Error(`catalog artifact ${id} SHA-256 mismatch: catalog=${artifact.sha256}, actual=${digest}`)
    maintenance.push({ id, name: entry.name, path: artifactPath, sha256: digest, size: info.size })
  }
  return { maintenance }
}

async function readProfileManifest(profileDir) {
  try { return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) } catch (error) { throw new Error(`scratch profile manifest could not be read at ${profileDir}: ${String(error)}`) }
}

async function assertInstalledBundles(profileDir, maintenance) {
  const manifest = await readProfileManifest(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('scratch profile package.json has no dsh.profile.bundles array')
  const expected = ['@lisihao/dsh-solar-subscription-hub', ...maintenance.map(entry => entry.name), '@lisihao/dsh-solar-subscription-hub-probe']
  const missing = expected.filter(name => !bundles.includes(name))
  if (missing.length > 0) throw new Error(`installed bundles are not all enabled: missing ${missing.join(', ')}; got ${JSON.stringify(bundles)}`)
}

async function runtimeArtifacts(root) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true, recursive: true }) } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  return entries.map(entry => join(entry.parentPath ?? root, entry.name)).filter(path => path.endsWith('.pid') || path.endsWith('.sock') || path.endsWith('.socket'))
}

async function readProbeMarker(path) {
  let marker
  try { marker = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error(`subscription-hub probe marker is missing or invalid at ${path}: ${String(error)}`) }
  if (marker?.ok !== true) throw new Error(`subscription-hub probe reported failure: ${JSON.stringify(marker)}`)
  const expected = [
    'hostFiber',
    'thirdPartyHosts',
    'loaderCaptured',
    'clientExports',
    'loadOrder',
    'sectionDeclared',
    'hubEntry',
    'pageEntries',
    'renderTabs',
    'renderFirstPage',
    'styleInstalled',
    'styleDisposed',
    'ledgerDisposed',
    'localeDisposed',
    'unrelatedPreserved',
  ]
  for (const name of expected) {
    if (marker.checks?.[name] !== true) throw new Error(`subscription-hub probe did not pass ${name}: ${JSON.stringify(marker)}`)
  }
  return marker
}

async function main() {
  const built = await validateBuiltPackages()
  const scratch = await mkdtemp(join(TEMP_ROOT, 'dsh-v4-subscription-hub-plugin-test-'))
  const dshHome = scratch
  const environment = scrubbedEnvironment({ home: join(scratch, 'home'), dshHome, marker: join(scratch, 'probe', 'marker.json') })
  const profileDir = join(dshHome, 'profiles', PROFILE)
  let primaryError
  let marker
  try {
    try {
      for (const packageDir of [SUBSCRIPTION_HUB_PACKAGE, ...built.maintenance.map(entry => entry.path), PROBE_PACKAGE]) {
        const label = `dsh plugin --profile ${PROFILE} add ${packageDir}`
        const result = await runCommand(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', packageDir], { cwd: ROOT, env: environment, label })
        if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) throw commandError(label, result)
      }
      await assertInstalledBundles(profileDir, built.maintenance)
      const bootLabel = `dsh --profile ${PROFILE}`
      const boot = await runCommand(DSH_BIN, ['--profile', PROFILE], { cwd: ROOT, env: environment, timeoutMs: BOOT_TIMEOUT_MS, label: bootLabel })
      if (boot.status !== 0 || boot.signal !== null || boot.error !== undefined || boot.timedOut) {
        const markerHint = await readFile(environment.SOLAR_PLUGIN_PROBE_MARKER, 'utf8').catch(() => '(no probe marker)')
        throw new Error(`${commandError(bootLabel, boot).message}\nprobe marker: ${markerHint}`)
      }
      marker = await readProbeMarker(environment.SOLAR_PLUGIN_PROBE_MARKER)
      const artifacts = await runtimeArtifacts(join(dshHome, 'solar', 'subscription-hub'))
      if (artifacts.length > 0) throw new Error(`subscription-hub runtime artifacts survived the CLI process: ${JSON.stringify(artifacts)}`)
    } catch (error) { primaryError = error }
  } finally {
    if (primaryError === undefined) await rm(scratch, { recursive: true, force: true })
  }
  if (primaryError !== undefined) {
    const message = `scratch preserved at ${scratch}`
    if (primaryError instanceof Error) primaryError.message += `\n${message}`
    else primaryError = new Error(`${String(primaryError)}\n${message}`)
    throw primaryError
  }
  process.stdout.write(JSON.stringify({ profile: PROFILE, maintenance: built.maintenance, marker }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`subscription-hub-plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
