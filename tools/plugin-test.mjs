import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const TEMP_ROOT = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const DSH_BIN = join(ROOT, 'node_modules', '.bin', 'dsh')
const RESIDENT_PACKAGE = join(ROOT, 'incubator', 'native-resident')
const COLLABORATION_PACKAGE = join(ROOT, 'incubator', 'native-collaboration')
const PROBE_PACKAGE = join(ROOT, 'tools', 'fixtures', 'plugin-probe')
const PROFILE = 'solar-native-plugin-test'
const COMMAND_TIMEOUT_MS = 120_000
const BOOT_TIMEOUT_MS = 90_000
const CLEANUP_TIMEOUT_MS = 10_000
const CAPTURE_LIMIT = 128 * 1024

const CREDENTIAL_ENV = /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|CLIENT_SECRET|OAUTH|BEARER)(?:$|_)/i
const SENSITIVE_PROVIDER_ENV = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|CODEX)(?:_|$)/i

function now() {
  return Date.now()
}

function commandError(label, result) {
  const details = [
    `${label} exited with ${result.signal ?? `status ${String(result.status)}`}`,
    result.timedOut ? 'timeout reached' : undefined,
    result.error === undefined ? undefined : `spawn error: ${result.error}`,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
  ].filter(Boolean).join('\n')
  return new Error(details)
}

function appendCapture(current, chunk) {
  const next = current + String(chunk)
  return next.length <= CAPTURE_LIMIT ? next : next.slice(next.length - CAPTURE_LIMIT)
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = ROOT,
    env,
    timeoutMs = COMMAND_TIMEOUT_MS,
    label = `${command} ${args.join(' ')}`,
  } = options
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

function scrubbedEnvironment({ home, dshHome, marker }) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DSH_') || CREDENTIAL_ENV.test(key) || SENSITIVE_PROVIDER_ENV.test(key) || /(?:PROXY|AUTH|CREDENTIAL)/i.test(key) || /^(?:npm_config_(?:userconfig|globalconfig|registry|_auth|auth_token)|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|REGISTRY|_AUTH|AUTH_TOKEN))$/i.test(key)) {
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
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} package manifest is invalid: ${String(error)}`)
  }
}

async function optionalPackageManifest(packageDir, label) {
  try {
    await stat(join(packageDir, 'package.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`${label} package manifest could not be inspected: ${String(error)}`)
  }
  return packageManifest(packageDir, label)
}

async function validateBuiltPackages() {
  const resident = await packageManifest(RESIDENT_PACKAGE, 'native-resident')
  const collaboration = await optionalPackageManifest(COLLABORATION_PACKAGE, 'native-collaboration')
  const probe = await packageManifest(PROBE_PACKAGE, 'plugin-probe')
  if (resident.name !== '@lisihao/dsh-solar-native-resident') throw new Error(`unexpected native-resident package name ${String(resident.name)}`)
  if (collaboration !== undefined && collaboration.name !== '@lisihao/dsh-solar-native-collaboration') throw new Error(`unexpected native-collaboration package name ${String(collaboration.name)}`)
  if (probe.name !== '@lisihao/dsh-solar-plugin-probe') throw new Error(`unexpected probe package name ${String(probe.name)}`)
  for (const file of ['lib/index.js', 'lib/contracts.js', 'lib/client.js', 'lib/daemon.js']) {
    await requireFile(join(RESIDENT_PACKAGE, file), `native-resident build output ${file}`)
  }
  if (collaboration !== undefined) await requireFile(join(COLLABORATION_PACKAGE, 'lib', 'index.js'), 'native-collaboration build output lib/index.js')
  await requireFile(join(PROBE_PACKAGE, 'lib', 'index.js'), 'plugin-probe build output lib/index.js')
  return { collaboration: collaboration !== undefined }
}

async function readProfileManifest(profileDir) {
  const path = join(profileDir, 'package.json')
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`scratch profile manifest could not be read at ${path}: ${String(error)}`)
  }
}

async function assertInstalledBundles(profileDir, expectCollaboration) {
  const manifest = await readProfileManifest(profileDir)
  const bundles = manifest?.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error('scratch profile package.json has no dsh.profile.bundles array')
  const expected = [
    '@lisihao/dsh-solar-native-resident',
    '@lisihao/dsh-solar-plugin-probe',
  ]
  if (expectCollaboration) expected.splice(1, 0, '@lisihao/dsh-solar-native-collaboration')
  const missing = expected.filter((name) => !bundles.includes(name))
  if (missing.length > 0) throw new Error(`installed bundles are not all enabled: missing ${missing.join(', ')}; got ${JSON.stringify(bundles)}`)
}

async function listResidentFiles(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true, recursive: true })
    return entries.map((entry) => join(entry.parentPath ?? root, entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function livePidFiles(root) {
  const files = await listResidentFiles(root)
  const pidPaths = files.filter((path) => path.endsWith('.pid') || path.endsWith('/pid'))
  const live = []
  for (const path of pidPaths) {
    let raw
    try { raw = (await readFile(path, 'utf8')).trim() } catch { continue }
    const pid = Number(raw)
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0)
      live.push({ path, pid })
    } catch (error) {
      if (error?.code === 'EPERM') live.push({ path, pid })
    }
  }
  return live
}

async function callResidentShutdown(root, clientPath) {
  let files = await listResidentFiles(root)
  const likelyDaemon = files.some((path) => path.endsWith('.sock') || path.endsWith('.socket') || path.endsWith('.pid'))
  if (!likelyDaemon) return { attempted: false, live: [] }
  let shutdownError
  try {
    const module = await import(pathToFileURL(clientPath).href)
    const Client = module.ResidentClient
    if (typeof Client !== 'function') throw new Error('built ResidentClient export is unavailable')
    const client = new Client(root, { requestTimeoutMs: CLEANUP_TIMEOUT_MS })
    const shutdown = typeof client.shutdown === 'function'
      ? client.shutdown.bind(client)
      : typeof client.call === 'function'
        ? () => client.call('shutdown', {})
        : undefined
    if (shutdown === undefined) throw new Error('ResidentClient has neither shutdown() nor call()')
    await bounded(shutdown(), CLEANUP_TIMEOUT_MS, 'ResidentClient shutdown')
  } catch (error) {
    shutdownError = error
  }
  const deadline = now() + CLEANUP_TIMEOUT_MS
  let live = await livePidFiles(root)
  let remainingFiles = await listResidentFiles(root)
  while ((live.length > 0 || remainingFiles.some((path) => path.endsWith('.sock') || path.endsWith('.socket'))) && now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
    live = await livePidFiles(root)
    remainingFiles = await listResidentFiles(root)
  }
  files = await listResidentFiles(root)
  const remainingSockets = files.filter((path) => path.endsWith('.sock') || path.endsWith('.socket'))
  if (live.length > 0 || remainingSockets.length > 0) {
    throw new Error(`Resident daemon remained alive after shutdown${shutdownError === undefined ? '' : ` (${String(shutdownError)})`}: ${JSON.stringify({ live, sockets: remainingSockets })}`)
  }
  if (shutdownError !== undefined) throw new Error(`Resident daemon shutdown failed: ${String(shutdownError)}`)
  return { attempted: true, live: [], files }
}

async function bounded(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function readProbeMarker(path) {
  let marker
  try {
    marker = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`plugin probe marker is missing or invalid at ${path}: ${String(error)}`)
  }
  if (marker?.ok !== true) throw new Error(`plugin probe reported failure: ${JSON.stringify(marker)}`)
  const checks = marker.checks
  for (const name of ['service', 'listed', 'queued', 'paused', 'cancelled']) {
    if (checks?.[name] !== true) throw new Error(`plugin probe did not pass ${name}: ${JSON.stringify(marker)}`)
  }
  const expectedTools = marker.expectedCollaboration
    ? ['solar_delegate', 'solar_resident', 'solar_coordinate']
    : ['solar_resident']
  if (marker.expectedCollaboration && checks.uiStatus !== true) throw new Error('plugin probe did not pass UI status')
  for (const tool of expectedTools) {
    if (!checks?.tools?.includes(tool)) throw new Error(`plugin probe did not register ${tool}: ${JSON.stringify(marker)}`)
  }
  return marker
}

async function main() {
  const built = await validateBuiltPackages()
  const scratch = await mkdtemp(join(TEMP_ROOT, 'dsh-v4-plugin-test-'))
  const home = join(scratch, 'home')
  const dshHome = scratch
  const markerPath = join(scratch, 'probe', 'marker.json')
  const profileDir = join(dshHome, 'profiles', PROFILE)
  const residentRoot = join(dshHome, 'solar', 'native-resident')
  const environment = scrubbedEnvironment({ home, dshHome, marker: markerPath })
  environment.SOLAR_PROBE_EXPECT_COLLABORATION = built.collaboration ? '1' : '0'
  let cleanupError
  let primaryError
  let marker
  let daemonCleanup
  try {
    try {
      const packages = [
        RESIDENT_PACKAGE,
        ...(built.collaboration ? [COLLABORATION_PACKAGE] : []),
        PROBE_PACKAGE,
      ]
      for (const packageDir of packages) {
        const label = `dsh plugin --profile ${PROFILE} add ${packageDir}`
        const result = await runCommand(DSH_BIN, ['plugin', '--profile', PROFILE, 'add', packageDir], {
          cwd: ROOT,
          env: environment,
          label,
        })
        if (result.status !== 0 || result.signal !== null || result.error !== undefined || result.timedOut) {
          throw commandError(label, result)
        }
      }
      await assertInstalledBundles(profileDir, built.collaboration)

      const bootLabel = `dsh --profile ${PROFILE}`
      const boot = await runCommand(DSH_BIN, ['--profile', PROFILE], {
        cwd: ROOT,
        env: environment,
        timeoutMs: BOOT_TIMEOUT_MS,
        label: bootLabel,
      })
      if (boot.status !== 0 || boot.signal !== null || boot.error !== undefined || boot.timedOut) {
        const markerHint = await readFile(markerPath, 'utf8').catch(() => '(no probe marker)')
        const daemonLogHint = await readFile(join(residentRoot, 'daemon.log'), 'utf8').catch(() => '(no daemon log)')
        throw new Error(`${commandError(bootLabel, boot).message}\nprobe marker: ${markerHint}\ndaemon log: ${daemonLogHint}`)
      }
      marker = await readProbeMarker(markerPath)
    } catch (error) {
      primaryError = error
    }
  } finally {
    try {
      daemonCleanup = await callResidentShutdown(residentRoot, join(RESIDENT_PACKAGE, 'lib', 'client.js'))
    } catch (error) {
      cleanupError = error
    }
    if (cleanupError === undefined && primaryError === undefined) await rm(scratch, { recursive: true, force: true })
  }
  if (cleanupError === undefined && primaryError === undefined) {
    process.stdout.write(JSON.stringify({
      profile: PROFILE,
      marker,
      daemonCleanup,
    }, null, 2) + '\n')
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      const scratchMessage = `scratch preserved at ${scratch}`
      if (primaryError instanceof Error) primaryError.message += `\ncleanup also failed: ${cleanupMessage}; ${scratchMessage}`
      else primaryError = new Error(`${String(primaryError)}\ncleanup also failed: ${cleanupMessage}`)
    } else if (primaryError instanceof Error) {
      primaryError.message += `\nscratch preserved at ${scratch}`
    } else {
      primaryError = new Error(`${String(primaryError)}\nscratch preserved at ${scratch}`)
    }
    throw primaryError
  }
  if (cleanupError !== undefined) {
    const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
    throw new Error(`${message}; scratch preserved at ${scratch}`)
  }
}

main().catch((error) => {
  process.stderr.write(`plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
