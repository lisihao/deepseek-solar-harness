import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXPECTED_PROVIDER_IDS = ['claude-code', 'codex']
const SUPPORTED_PROVIDER_IDS = new Set(EXPECTED_PROVIDER_IDS)
const USAGE = 'usage: verify-packaged-resident-smoke [APP_ROOT] [--execute] [--require-provider codex|claude-code]...'

/**
 * Parse the small command-line surface of the packaged Resident smoke.
 * Keeping this strict prevents a misspelled flag from silently changing which
 * providers are exercised during a release check.
 */
export function parseResidentSmokeArguments(argumentsAfterEntry) {
  let executeTurns = false
  let appArgument
  const requiredProviders = []

  for (let index = 0; index < argumentsAfterEntry.length; index += 1) {
    const argument = argumentsAfterEntry[index]
    if (argument === '--execute') {
      if (executeTurns) throw new Error(`${USAGE}\nduplicate --execute`)
      executeTurns = true
      continue
    }
    if (argument === '--require-provider') {
      const providerId = argumentsAfterEntry[index + 1]
      if (providerId === undefined || providerId.startsWith('-')) {
        throw new Error(`${USAGE}\n--require-provider requires an operator id`)
      }
      if (!SUPPORTED_PROVIDER_IDS.has(providerId)) {
        throw new Error(`${USAGE}\nunsupported required provider: ${providerId}`)
      }
      if (requiredProviders.includes(providerId)) {
        throw new Error(`${USAGE}\nduplicate required provider: ${providerId}`)
      }
      requiredProviders.push(providerId)
      index += 1
      continue
    }
    if (argument.startsWith('-')) throw new Error(`${USAGE}\nunknown option: ${argument}`)
    if (argument.length === 0) throw new Error(`${USAGE}\napplication path must not be empty`)
    if (appArgument !== undefined) throw new Error(`${USAGE}\nonly one application path is allowed`)
    appArgument = argument
  }

  return { appArgument, executeTurns, requiredProviders }
}

const scriptPath = fileURLToPath(import.meta.url)
const defaultAppRoot = resolve(import.meta.dirname, '../dist/mac-arm64/DSH Desktop.app')
let parsedArguments
try {
  parsedArguments = parseResidentSmokeArguments(process.argv.slice(2))
} catch (error) {
  throw new Error(`verify-packaged-resident-smoke: ${error instanceof Error ? error.message : String(error)}`)
}
const { executeTurns, requiredProviders } = parsedArguments
const appRoot = resolve(parsedArguments.appArgument ?? defaultAppRoot)
const appExecutable = join(appRoot, 'Contents', 'MacOS', 'DSH Desktop')

if (process.versions.electron === undefined) {
  if (!existsSync(appExecutable)) {
    throw new Error(`verify-packaged-resident-smoke: packaged application is missing at ${appExecutable}`)
  }
  const networkEnvironment = Object.fromEntries([
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
  ].flatMap((name) => {
    const value = process.env[name]
    return value === undefined ? [] : [[name, value]]
  }))
  const environment = {
    HOME: homedir(),
    PATH: '/usr/bin:/bin',
    ELECTRON_RUN_AS_NODE: '1',
    // Preserve local proxy and CA routing without forwarding credentials.
    ...networkEnvironment,
    ...process.env.USER === undefined ? {} : { USER: process.env.USER },
    ...process.env.LOGNAME === undefined ? {} : { LOGNAME: process.env.LOGNAME },
    ...process.env.LANG === undefined ? {} : { LANG: process.env.LANG },
    ...process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR },
  }
  const forwardedArguments = [scriptPath, appRoot]
  if (executeTurns) forwardedArguments.push('--execute')
  for (const providerId of requiredProviders) forwardedArguments.push('--require-provider', providerId)
  execFileSync(appExecutable, forwardedArguments, {
    env: environment,
    stdio: 'inherit',
  })
  process.exit(0)
}

const unpackedRoot = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
const runtimeModule = pathToFileURL(join(unpackedRoot, 'lib', 'native-product-runtime.js')).href
const desktopRuntimeModule = pathToFileURL(join(unpackedRoot, 'lib', 'desktop-runtime-environment.js')).href
const residentContractModule = pathToFileURL(join(
  unpackedRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-resident-operator',
  'lib',
  'index.js',
)).href
const residentModule = pathToFileURL(join(
  unpackedRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-resident-operator-local',
  'lib',
  'index.js',
)).href
const { installNativeProductRuntime } = await import(runtimeModule)
const { installDesktopPnpmRuntime } = await import(desktopRuntimeModule)
const { RESIDENT_PROTOCOL_VERSION, RESIDENT_STATE_SCHEMA_VERSION } = await import(residentContractModule)
const { ResidentDaemonClient, waitForDaemonSocketRelease } = await import(residentModule)
if (RESIDENT_PROTOCOL_VERSION !== 13) {
  throw new Error(`verify-packaged-resident-smoke: expected Resident protocol v13, got v${String(RESIDENT_PROTOCOL_VERSION)}`)
}
if (RESIDENT_STATE_SCHEMA_VERSION !== 5) {
  throw new Error(`verify-packaged-resident-smoke: expected Resident state schema v5, got v${String(RESIDENT_STATE_SCHEMA_VERSION)}`)
}
const temporaryRoot = mkdtempSync('/tmp/dsh-r-')
const stateRoot = join(temporaryRoot, 'Library', 'Application Support', 'DSH Product Server Canary', 'state', 'dsh-home', 'resident-operators')
const socketPath = join(stateRoot, 'control.sock')
if (Buffer.byteLength(socketPath) <= 103) {
  throw new Error('verify-packaged-resident-smoke: fixture does not exercise a long Unix socket path')
}
const pnpmRuntime = installDesktopPnpmRuntime({
  platform: process.platform,
  appExecutable: process.execPath,
  pnpmBinPath: join(unpackedRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  electronVersion: process.versions.electron,
  stateDir: join(temporaryRoot, 'runtime-commands'),
  environment: process.env,
})
const installation = installNativeProductRuntime({
  platform: process.platform,
  homeDir: homedir(),
  stateDir: join(temporaryRoot, 'runtime-products'),
  nodeBinDir: pnpmRuntime.nodeBinDir,
  environment: process.env,
})
let client
let shutdownRequested = false

function isQualified(provider) {
  return provider?.available === true && provider.authentication === 'native-subscription'
}

function assertProviderStatus(provider, operatorId) {
  if (provider === undefined) {
    throw new Error(`verify-packaged-resident-smoke: provider status missing for ${operatorId}`)
  }
  if (typeof provider.available !== 'boolean') {
    throw new Error(`verify-packaged-resident-smoke: ${operatorId} provider status has no boolean availability`)
  }
  if (provider.authentication !== 'native-subscription' && provider.authentication !== 'unqualified') {
    throw new Error(`verify-packaged-resident-smoke: ${operatorId} provider status has an unknown authentication mode`)
  }
}

function serializeProvider(provider) {
  return {
    operatorId: provider.operatorId,
    product: provider.product,
    displayName: provider.displayName,
    available: provider.available,
    authentication: provider.authentication,
    unavailableReason: provider.unavailableReason,
    quotaUnavailableReason: provider.quotaUnavailableReason,
    productVersion: provider.productVersion,
    protocolHash: provider.protocolHash,
    maxConcurrency: provider.maxConcurrency,
    injectionBoundaries: provider.injectionBoundaries,
    models: provider.models.map(model => ({
      model: model.model,
      resolvedModel: model.resolvedModel,
      displayName: model.displayName,
      supportedEfforts: model.supportedEfforts,
      defaultEffort: model.defaultEffort,
      isDefault: model.isDefault,
    })),
    quotaPools: provider.quotaPools,
  }
}

try {
  const commands = {}
  for (const command of ['claude', 'codex']) {
    const path = installation.commands[command]
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error(`verify-packaged-resident-smoke: native ${command} command was not resolved`)
    }
    commands[command] = path
  }
  client = new ResidentDaemonClient({
    root: stateRoot,
    autoStart: true,
    connectTimeoutMs: 15_000,
    pollIntervalMs: 50,
    driverModules: [],
  })
  const providers = await client.providers()
  const providerById = new Map(providers.map(provider => [provider.operatorId, provider]))
  for (const operatorId of EXPECTED_PROVIDER_IDS) assertProviderStatus(providerById.get(operatorId), operatorId)

  for (const operatorId of requiredProviders) {
    const provider = providerById.get(operatorId)
    if (!isQualified(provider)) {
      throw new Error(
        `verify-packaged-resident-smoke: ${operatorId} is not available with native-subscription authentication: ${provider?.unavailableReason ?? 'qualification failed'}`,
      )
    }
  }

  const eligibleProviderIds = requiredProviders.length > 0
    ? [...requiredProviders]
    : EXPECTED_PROVIDER_IDS.filter(operatorId => isQualified(providerById.get(operatorId)))
  if (executeTurns && eligibleProviderIds.length === 0) {
    throw new Error('verify-packaged-resident-smoke: --execute requires at least one available native-subscription provider')
  }
  const skippedProviders = EXPECTED_PROVIDER_IDS
    .filter(operatorId => !eligibleProviderIds.includes(operatorId))
    .map(operatorId => {
      const provider = providerById.get(operatorId)
      return {
        operatorId,
        reason: provider?.unavailableReason ?? 'not qualified for native-subscription execution',
      }
    })
  const executions = []
  if (executeTurns) {
    const workspace = join(temporaryRoot, 'workspace')
    mkdirSync(workspace)
    for (const operatorId of eligibleProviderIds) {
      const nonce = `PACKAGED-${operatorId.toUpperCase()}-${randomUUID().slice(0, 8)}`
      const turn = await client.execute({
        commandId: `packaged-${operatorId}-${randomUUID()}`,
        operatorId,
        workspace,
        prompt: [{ type: 'text', text: `Reply with exactly ${nonce}. Do not call tools.` }],
        signal: new AbortController().signal,
      })
      const result = await turn.result
      const text = result.output
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      if (!text.includes(nonce)) {
        throw new Error(`verify-packaged-resident-smoke: ${operatorId} did not return its nonce`)
      }
      executions.push({ operatorId, sessionId: turn.sessionId, stopReason: result.stopReason, nonce })
    }
  }

  const pid = Number(readFileSync(join(stateRoot, 'daemon.pid'), 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('verify-packaged-resident-smoke: resident daemon published an invalid pid')
  }
  const processCommand = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim()
  if (!processCommand.includes(appExecutable) || !processCommand.includes('startup.js')) {
    throw new Error(`verify-packaged-resident-smoke: unexpected resident daemon process ${processCommand}`)
  }

  await client.shutdown()
  shutdownRequested = true
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    } catch (cause) {
      if (cause.code === 'ESRCH') break
      throw cause
    }
  }
  try {
    process.kill(pid, 0)
    throw new Error(`verify-packaged-resident-smoke: resident daemon ${pid} did not exit`)
  } catch (cause) {
    if (cause.code !== 'ESRCH') throw cause
  }
  if (!await waitForDaemonSocketRelease(socketPath, 10_000)) {
    throw new Error(`verify-packaged-resident-smoke: resident daemon socket ${socketPath} was not released`)
  }

  process.stdout.write(`${JSON.stringify({
    electron: process.versions.electron,
    executable: process.execPath,
    protocolVersion: RESIDENT_PROTOCOL_VERSION,
    stateSchemaVersion: RESIDENT_STATE_SCHEMA_VERSION,
    commands,
    requiredProviders,
    execute: executeTurns,
    providers: providers.map(serializeProvider),
    providerSelection: {
      eligible: eligibleProviderIds,
      skipped: skippedProviders,
    },
    executions,
    daemonProcess: processCommand,
    cleanup: { daemonExited: true, socketReleased: true },
  }, undefined, 2)}\n`)
} finally {
  if (client !== undefined && !shutdownRequested) {
    await client.shutdown()
  }
  installation.dispose()
  pnpmRuntime.dispose()
  rmSync(temporaryRoot, { recursive: true, force: true })
}
