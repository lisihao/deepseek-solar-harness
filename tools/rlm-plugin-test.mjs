import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { checkRlmClient } from './rlm-client-check.mjs'

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)))
const TEMP_ROOT = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')
const RLM_PACKAGE = join(ROOT, 'incubator', 'rlm')
const PROBE_PACKAGE = join(ROOT, 'tools', 'fixtures', 'rlm-probe')
const RLM_NAME = '@lisihao/dsh-solar-rlm'
const PROBE_NAME = '@lisihao/dsh-solar-rlm-probe'
const PROFILE = 'solar-rlm-plugin-test'
const COMMAND_TIMEOUT_MS = 180_000
const BOOT_TIMEOUT_MS = 360_000
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
  const result = await new Promise(resolveResult => {
    let settled = false
    let timer
    let killTimer
    let timedOut = false
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
    SOLAR_RLM_PROBE_MARKER: marker,
    SOLAR_RLM_NATIVE_CHECK: process.env.SOLAR_RLM_NATIVE_CHECK === '1' ? '1' : '0',
  }
}

async function requireFile(path, label) {
  const info = await stat(path).catch(() => undefined)
  if (info?.isFile() !== true) throw new Error(`${label} is missing at ${path}`)
}

async function packageManifest(packageDir, label) {
  await requireFile(join(packageDir, 'package.json'), `${label} package manifest`)
  try {
    return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`${label} package manifest is invalid: ${String(error)}`)
  }
}

async function validateBuiltPackages() {
  const rlm = await packageManifest(RLM_PACKAGE, 'RLM')
  const probe = await packageManifest(PROBE_PACKAGE, 'RLM probe')
  if (rlm.name !== RLM_NAME) throw new Error(`unexpected RLM package name ${String(rlm.name)}`)
  if (probe.name !== PROBE_NAME) throw new Error(`unexpected probe package name ${String(probe.name)}`)
  for (const file of ['lib/index.js', 'lib/selftest.js', 'lib/client.cjs', 'lib/remote.js', 'lib/typert.js']) await requireFile(join(RLM_PACKAGE, file), `RLM build output ${file}`)
  await requireFile(join(PROBE_PACKAGE, 'lib', 'index.js'), 'RLM probe build output lib/index.js')
  await checkRlmClient(join(RLM_PACKAGE, 'lib', 'client.cjs'))
}

async function profileManifest(profileDir) {
  try {
    return JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`scratch profile manifest could not be read at ${profileDir}: ${String(error)}`)
  }
}

function bundlesOf(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('scratch profile manifest has no dsh.profile.bundles array')
  return bundles
}

async function assertInstalled(profileDir) {
  const bundles = bundlesOf(await profileManifest(profileDir))
  const missing = [RLM_NAME, PROBE_NAME].filter(name => !bundles.includes(name))
  if (missing.length > 0) throw new Error(`installed bundles are missing: ${missing.join(', ')}; got ${JSON.stringify(bundles)}`)
}

async function assertUninstalled(profileDir) {
  const bundles = bundlesOf(await profileManifest(profileDir))
  const remaining = [RLM_NAME, PROBE_NAME].filter(name => bundles.includes(name))
  if (remaining.length > 0) throw new Error(`uninstall left bundles enabled: ${JSON.stringify(remaining)}`)
}

async function readMarker(path) {
  let marker
  try {
    marker = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`RLM probe marker is missing or invalid at ${path}: ${String(error)}`)
  }
  if (marker?.ok !== true) throw new Error(`RLM probe reported failure: ${JSON.stringify(marker)}`)
  if (marker.exitRequested !== true) throw new Error(`RLM probe did not request a clean app exit: ${JSON.stringify(marker)}`)
  if (marker.exitCode !== 0) throw new Error(`RLM probe did not request exit code 0: ${JSON.stringify(marker)}`)
  if (marker.checks?.service !== true) throw new Error(`RLM probe did not register the control service: ${JSON.stringify(marker)}`)
  if (typeof marker.checks?.runtime !== 'boolean' || typeof marker.runtimeAvailable !== 'boolean') {
    throw new Error(`RLM probe did not record runtime availability: ${JSON.stringify(marker)}`)
  }
  if (marker.runtimeAvailable !== marker.checks.runtime) {
    throw new Error(`RLM probe runtime availability fields disagree: ${JSON.stringify(marker)}`)
  }
  if (!['darwin-ready', 'darwin-unavailable', 'nonproduct'].includes(marker.productStatus)) {
    throw new Error(`RLM probe product status is invalid: ${JSON.stringify(marker)}`)
  }
  if (marker.productStatus === 'darwin-ready' && marker.runtimeAvailable !== true) {
    throw new Error(`RLM probe product status contradicts runtime availability: ${JSON.stringify(marker)}`)
  }
  if (marker.productStatus === 'nonproduct' && marker.selftest?.status !== 'notrun') {
    throw new Error(`RLM probe ran a native product check on an unsupported platform: ${JSON.stringify(marker)}`)
  }
  for (const tool of ['solar_rlm_run', 'solar_rlm_inspect', 'solar_rlm_control']) {
    if (!marker.checks?.tools?.includes(tool)) throw new Error(`RLM probe did not register ${tool}: ${JSON.stringify(marker)}`)
  }
  if (!['passed', 'notrun'].includes(marker.selftest?.status)) throw new Error(`RLM probe self-test outcome is invalid: ${JSON.stringify(marker)}`)
  if (marker.selftest.status === 'passed') {
    if (marker.checks?.bridge !== 'passed') throw new Error(`RLM bridge check did not pass: ${JSON.stringify(marker)}`)
    if (marker.selftest.bridge?.status !== 'passed') throw new Error(`RLM bridge acceptance did not pass: ${JSON.stringify(marker)}`)
    if (!(marker.selftest.bridge.modelRequests > 0) || marker.selftest.bridge.paidProviderCalls !== 0) throw new Error(`RLM bridge request accounting is invalid: ${JSON.stringify(marker)}`)
  } else if (marker.selftest.bridge?.status !== 'notrun') {
    throw new Error(`RLM bridge notrun marker is invalid: ${JSON.stringify(marker)}`)
  } else if (marker.checks?.bridge !== 'notrun') {
    throw new Error(`RLM bridge check notrun marker is invalid: ${JSON.stringify(marker)}`)
  }
  return marker
}

async function main() {
  await validateBuiltPackages()
  const scratch = await mkdtemp(join(TEMP_ROOT, 'dsh-v4-rlm-plugin-test-'))
  const home = join(scratch, 'h')
  const dshHome = scratch
  const markerPath = join(scratch, 'probe', 'marker.json')
  const profileDir = join(dshHome, 'profiles', PROFILE)
  const environment = scrubbedEnvironment({ home, dshHome, marker: markerPath })
  environment.SOLAR_RLM_PROBE_WORKSPACE = join(scratch, 'w')
  await mkdir(environment.SOLAR_RLM_PROBE_WORKSPACE, { recursive: true, mode: 0o700 })
  let primaryError
  let cleanupError
  let marker
  let uninstall
  try {
    try {
      for (const packageDir of [RLM_PACKAGE, PROBE_PACKAGE]) {
        const label = `dsh plugin --profile ${PROFILE} add ${packageDir}`
        const result = await runCommand(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', packageDir], { env: environment, label })
        if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) throw commandError(label, result)
      }
      await assertInstalled(profileDir)
      const bootLabel = `dsh --profile ${PROFILE}`
      const boot = await runCommand(DSH_BIN, ['--profile', PROFILE], { env: environment, timeoutMs: BOOT_TIMEOUT_MS, label: bootLabel })
      if (boot.status !== 0 || boot.signal !== null || boot.error !== undefined || boot.timedOut) {
        const markerHint = await readFile(markerPath, 'utf8').catch(() => '(no RLM probe marker)')
        throw new Error(`${commandError(bootLabel, boot).message}\nprobe marker: ${markerHint}`)
      }
      marker = await readMarker(markerPath)

      const removeResults = []
      for (const packageName of [PROBE_NAME, RLM_NAME]) {
        const label = `dsh plugin --profile ${PROFILE} remove ${packageName}`
        const result = await runCommand(DSH_BIN, ['plugin', '--profile', PROFILE, 'remove', packageName], { env: environment, label })
        if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) throw commandError(label, result)
        removeResults.push({ packageName, status: result.status })
      }
      await assertUninstalled(profileDir)
      uninstall = { ok: true, removed: removeResults }
    } catch (error) {
      primaryError = error
    }
  } finally {
    if (primaryError === undefined) await rm(scratch, { recursive: true, force: true }).catch(error => { cleanupError = error })
  }
  if (primaryError !== undefined) {
    const suffix = cleanupError === undefined ? '' : `; cleanup failed: ${String(cleanupError)}`
    if (primaryError instanceof Error) primaryError.message += `${suffix}; scratch preserved at ${scratch}`
    else primaryError = new Error(`${String(primaryError)}${suffix}; scratch preserved at ${scratch}`)
    throw primaryError
  }
  if (cleanupError !== undefined) throw new Error(`scratch cleanup failed: ${String(cleanupError)}; scratch preserved at ${scratch}`)
  const acceptance = marker.productStatus === 'darwin-ready' && marker.selftest?.status === 'passed'
    ? 'native-bridge'
    : 'registration-only'
  process.stdout.write(JSON.stringify({ profile: PROFILE, acceptance, productStatus: marker.productStatus, marker, uninstall }, null, 2) + '\n')
}

main().catch(error => {
  process.stderr.write(`rlm-plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
