import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultAppRoot = resolve(import.meta.dirname, '../dist/mac-arm64/DSH Desktop.app')
const argumentsAfterEntry = process.argv.slice(2)
const executeTurns = argumentsAfterEntry.includes('--execute')
const appArgument = argumentsAfterEntry.find(argument => argument !== '--execute')
const appRoot = resolve(appArgument ?? defaultAppRoot)
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
  execFileSync(appExecutable, [scriptPath, appRoot, ...executeTurns ? ['--execute'] : []], {
    env: environment,
    stdio: 'inherit',
  })
  process.exit(0)
}

const unpackedRoot = join(appRoot, 'Contents', 'Resources', 'app.asar.unpacked')
const runtimeModule = pathToFileURL(join(unpackedRoot, 'lib', 'native-product-runtime.js')).href
const residentModule = pathToFileURL(join(
  unpackedRoot,
  'node_modules',
  '@deepseek-ai',
  'dsh-resident-operator-local',
  'lib',
  'index.js',
)).href
const { installNativeProductRuntime } = await import(runtimeModule)
const { ResidentDaemonClient } = await import(residentModule)
const temporaryRoot = mkdtempSync('/tmp/dsh-r-')
const stateRoot = join(temporaryRoot, 'Library', 'Application Support', 'DSH Product Server Canary', 'state', 'dsh-home', 'resident-operators')
if (Buffer.byteLength(join(stateRoot, 'control.sock')) <= 103) {
  throw new Error('verify-packaged-resident-smoke: fixture does not exercise a long Unix socket path')
}
const installation = installNativeProductRuntime({
  platform: process.platform,
  homeDir: homedir(),
  stateDir: join(temporaryRoot, 'runtime-products'),
  environment: process.env,
})
let client
let shutdownRequested = false

try {
  for (const command of ['claude', 'codex']) {
    if (installation.commands[command] === undefined) {
      throw new Error(`verify-packaged-resident-smoke: native ${command} command was not resolved`)
    }
  }
  client = new ResidentDaemonClient({
    root: stateRoot,
    autoStart: true,
    connectTimeoutMs: 15_000,
    pollIntervalMs: 50,
    driverModules: [],
  })
  const providers = await client.providers()
  for (const operatorId of ['claude-code', 'codex']) {
    const provider = providers.find(candidate => candidate.operatorId === operatorId)
    if (provider?.available !== true || provider.authentication !== 'native-subscription') {
      throw new Error(
        `verify-packaged-resident-smoke: ${operatorId} failed native-subscription qualification: ${provider?.unavailableReason ?? 'missing provider'}`,
      )
    }
  }
  const executions = []
  if (executeTurns) {
    const workspace = join(temporaryRoot, 'workspace')
    mkdirSync(workspace)
    for (const operatorId of ['claude-code', 'codex']) {
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

  process.stdout.write(`${JSON.stringify({
    electron: process.versions.electron,
    executable: process.execPath,
    commands: installation.commands,
    providers: providers.map(provider => ({
      operatorId: provider.operatorId,
      available: provider.available,
      authentication: provider.authentication,
      productVersion: provider.productVersion,
    })),
    executions,
    daemonProcess: processCommand,
  }, undefined, 2)}\n`)
} finally {
  if (client !== undefined && !shutdownRequested) {
    await client.shutdown()
  }
  installation.dispose()
  rmSync(temporaryRoot, { recursive: true, force: true })
}
