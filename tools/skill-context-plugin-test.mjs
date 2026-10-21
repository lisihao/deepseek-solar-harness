import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEMP_ROOT = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')
const SKILL_CONTEXT_PACKAGE = join(ROOT, 'incubator', 'skill-context')
const PROBE_PACKAGE = join(ROOT, 'tools', 'fixtures', 'skill-context-probe')
const PROFILE = 'solar-skill-context-plugin-test'
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

async function runCommand(command, args, options = {}) {
  const { cwd = ROOT, env, timeoutMs = COMMAND_TIMEOUT_MS, label = `${command} ${args.join(' ')}` } = options
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout = appendCapture(stdout, chunk) })
  child.stderr?.on('data', (chunk) => { stderr = appendCapture(stderr, chunk) })
  let timedOut = false
  const result = await new Promise((resolveResult) => {
    let settled = false
    let timer
    let killTimer
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolveResult({ ...value, stdout, stderr, timedOut })
    }
    child.once('error', (error) => finish({ status: null, signal: null, error: String(error) }))
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

function commandError(label, result) {
  return new Error([
    `${label} exited with ${result.signal ?? `status ${String(result.status)}`}`,
    result.timedOut ? 'timeout reached' : undefined,
    result.error === undefined ? undefined : `spawn error: ${result.error}`,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
  ].filter(Boolean).join('\n'))
}

function scrubbedEnvironment({ home, dshHome, marker }) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DSH_') || CREDENTIAL_ENV.test(key) || SENSITIVE_PROVIDER_ENV.test(key)
      || /(?:PROXY|AUTH|CREDENTIAL)/i.test(key)
      || /^(?:npm_config_(?:userconfig|globalconfig|registry|_auth|auth_token)|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|REGISTRY|_AUTH|AUTH_TOKEN))$/i.test(key)) {
      delete environment[key]
    }
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
    SOLAR_SKILL_CONTEXT_PROBE_MARKER: marker,
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

async function readManifest(packageDir, label) {
  await requireFile(join(packageDir, 'package.json'), `${label} package manifest`)
  try {
    return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`${label} package manifest is invalid: ${String(error)}`)
  }
}

async function validateBuiltPackages() {
  const skillContext = await readManifest(SKILL_CONTEXT_PACKAGE, 'skill-context')
  const probe = await readManifest(PROBE_PACKAGE, 'skill-context probe')
  if (skillContext.name !== '@lisihao/dsh-solar-skill-context') throw new Error(`unexpected skill-context package name ${String(skillContext.name)}`)
  if (probe.name !== '@lisihao/dsh-solar-skill-context-probe') throw new Error(`unexpected probe package name ${String(probe.name)}`)
  await requireFile(join(SKILL_CONTEXT_PACKAGE, 'lib', 'index.js'), 'skill-context build output lib/index.js')
  await requireFile(join(PROBE_PACKAGE, 'lib', 'index.js'), 'skill-context probe build output lib/index.js')
}

async function readMarker(path) {
  let marker
  try {
    marker = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`skill-context probe marker is missing or invalid at ${path}: ${String(error)}`)
  }
  if (marker?.keyless !== true) throw new Error(`skill-context probe did not report keyless execution: ${JSON.stringify(marker)}`)
  if (marker?.ok !== true) throw new Error(`skill-context probe reported failure: ${JSON.stringify(marker)}`)
  const checks = marker.checks
  if (!Array.isArray(checks.searchMatches) || !checks.searchMatches.some((match) => match.name === 'solar-probe-skill')) {
    throw new Error(`skill-context probe did not find the fixture skill: ${JSON.stringify(marker)}`)
  }
  if (checks.searchBytes > 8_192 || checks.nextOffset === undefined || checks.totalMatches < 33) {
    throw new Error(`skill-context probe did not enforce bounded search output: ${JSON.stringify(marker)}`)
  }
  if (!String(checks.incompleteError).includes('SKILL_CONTEXT_SNAPSHOT_INCOMPLETE')) {
    throw new Error(`skill-context probe did not report incomplete snapshots by name: ${JSON.stringify(marker)}`)
  }
  if (checks.lifecycle?.remainingTools?.join(',') !== 'skill' || checks.lifecycle.disposedFibers < 1) {
    throw new Error(`skill-context probe did not verify lifecycle disposal: ${JSON.stringify(marker)}`)
  }
  return marker
}

async function main() {
  await validateBuiltPackages()
  const scratch = await mkdtemp(join(TEMP_ROOT, 'dsh-v4-skill-context-test-'))
  const home = join(scratch, 'home')
  const markerPath = join(scratch, 'probe', 'marker.json')
  const profileDir = join(scratch, 'profiles', PROFILE)
  const environment = scrubbedEnvironment({ home, dshHome: scratch, marker: markerPath })
  let primaryError
  let marker
  try {
    try {
      for (const packageDir of [SKILL_CONTEXT_PACKAGE, PROBE_PACKAGE]) {
        const label = `dsh plugin --profile ${PROFILE} add ${packageDir}`
        const result = await runCommand(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', packageDir], { cwd: ROOT, env: environment, label })
        if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) throw commandError(label, result)
      }
      await requireFile(join(profileDir, 'package.json'), 'scratch profile manifest')

      const bootLabel = `dsh --profile ${PROFILE}`
      const boot = await runCommand(DSH_BIN, ['--profile', PROFILE], { cwd: ROOT, env: environment, timeoutMs: BOOT_TIMEOUT_MS, label: bootLabel })
      if (boot.status !== 0 || boot.signal !== null || boot.error !== undefined || boot.timedOut) throw commandError(bootLabel, boot)
      marker = await readMarker(markerPath)
    } catch (error) {
      primaryError = error
    }
  } finally {
    if (primaryError === undefined) await rm(scratch, { recursive: true, force: true })
  }
  if (primaryError !== undefined) {
    if (primaryError instanceof Error) primaryError.message += `\nscratch preserved at ${scratch}`
    throw primaryError
  }
  process.stdout.write(JSON.stringify({ profile: PROFILE, marker, keyless: true }, null, 2) + '\n')
}

main().catch((error) => {
  process.stderr.write(`skill-context-plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
