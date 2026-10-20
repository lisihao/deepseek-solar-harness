import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEMP_ROOT = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')
const CHATGPT_WEB_PACKAGE = join(ROOT, 'incubator', 'chatgpt-web')
const PROBE_PACKAGE = join(ROOT, 'tools', 'fixtures', 'chatgpt-web-probe')
const PROFILE = 'solar-chatgpt-web-plugin-test'
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
  const plugin = await packageManifest(CHATGPT_WEB_PACKAGE, 'chatgpt-web')
  const probe = await packageManifest(PROBE_PACKAGE, 'chatgpt-web probe')
  if (plugin.name !== '@lisihao/dsh-solar-chatgpt-web') throw new Error(`unexpected chatgpt-web package name ${String(plugin.name)}`)
  if (probe.name !== '@lisihao/dsh-solar-chatgpt-web-probe') throw new Error(`unexpected probe package name ${String(probe.name)}`)
  await requireFile(join(CHATGPT_WEB_PACKAGE, 'lib', 'index.js'), 'chatgpt-web build output lib/index.js')
  await requireFile(join(PROBE_PACKAGE, 'lib', 'index.js'), 'chatgpt-web probe build output lib/index.js')
}

async function readProfileManifest(profileDir) {
  try { return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) } catch (error) { throw new Error(`scratch profile manifest could not be read at ${profileDir}: ${String(error)}`) }
}

async function assertInstalledBundles(profileDir) {
  const manifest = await readProfileManifest(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('scratch profile package.json has no dsh.profile.bundles array')
  const expected = ['@lisihao/dsh-solar-chatgpt-web', '@lisihao/dsh-solar-chatgpt-web-probe']
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
  try { marker = JSON.parse(await readFile(path, 'utf8')) } catch (error) { throw new Error(`chatgpt-web probe marker is missing or invalid at ${path}: ${String(error)}`) }
  if (marker?.ok !== true) throw new Error(`chatgpt-web probe reported failure: ${JSON.stringify(marker)}`)
  for (const name of ['tool', 'provider', 'providerContract', 'mainModelProvider', 'mainModelCatalog', 'mainModelDisposed', 'status', 'emptyRuns', 'emptyActiveIds', 'noExecutorInvocation', 'noBrowserTask', 'registrationsDisposed', 'noPersistentArtifacts']) {
    if (marker.checks?.[name] !== true) throw new Error(`chatgpt-web probe did not pass ${name}: ${JSON.stringify(marker)}`)
  }
  return marker
}

async function main() {
  await validateBuiltPackages()
  const scratch = await mkdtemp(join(TEMP_ROOT, 'dsh-v4-chatgpt-web-plugin-test-'))
  const dshHome = scratch
  const environment = scrubbedEnvironment({ home: join(scratch, 'home'), dshHome, marker: join(scratch, 'probe', 'marker.json') })
  const profileDir = join(dshHome, 'profiles', PROFILE)
  let primaryError
  let marker
  try {
    try {
      for (const packageDir of [CHATGPT_WEB_PACKAGE, PROBE_PACKAGE]) {
        const label = `dsh plugin --profile ${PROFILE} add ${packageDir}`
        const result = await runCommand(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', packageDir], { cwd: ROOT, env: environment, label })
        if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) throw commandError(label, result)
      }
      await assertInstalledBundles(profileDir)
      const bootLabel = `dsh --profile ${PROFILE}`
      const boot = await runCommand(DSH_BIN, ['--profile', PROFILE], { cwd: ROOT, env: environment, timeoutMs: BOOT_TIMEOUT_MS, label: bootLabel })
      if (boot.status !== 0 || boot.signal !== null || boot.error !== undefined || boot.timedOut) {
        const markerHint = await readFile(environment.SOLAR_PLUGIN_PROBE_MARKER, 'utf8').catch(() => '(no probe marker)')
        throw new Error(`${commandError(bootLabel, boot).message}\nprobe marker: ${markerHint}`)
      }
      marker = await readProbeMarker(environment.SOLAR_PLUGIN_PROBE_MARKER)
      const artifacts = await runtimeArtifacts(join(dshHome, 'solar', 'chatgpt-web'))
      if (artifacts.length > 0) throw new Error(`ChatGPT Web runtime artifacts survived the CLI process: ${JSON.stringify(artifacts)}`)
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
  process.stdout.write(JSON.stringify({ profile: PROFILE, marker }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`chatgpt-web-plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
