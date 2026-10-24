import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtureDirectory = join(root, 'tools', 'fixture')
const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const cli = process.env.DSH_TEST_BIN ?? join(root, 'node_modules', '.bin', 'dsh')
const profileName = 'hindsight-chat-recall-plugin-test'
const commandTimeoutMs = 120_000
const captureLimit = 128 * 1024
const credentialEnvironment = /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|CLIENT_SECRET|OAUTH|BEARER)(?:$|_)/i
const providerEnvironment = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|CODEX)(?:_|$)/i

function archiveName(manifest) {
  return `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
}

function appendCapture(current, chunk) {
  const next = current + String(chunk)
  return next.length <= captureLimit ? next : next.slice(next.length - captureLimit)
}

function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  } catch {
    try { child.kill('SIGTERM') } catch { /* Process already exited. */ }
  }
  setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { /* Process already exited. */ }
  }, 2_000).unref?.()
}

async function run(scratch, sequence, command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout = appendCapture(stdout, chunk) })
  child.stderr.on('data', chunk => { stderr = appendCapture(stderr, chunk) })
  let timedOut = false
  const result = await new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      timedOut = true
      terminate(child)
    }, commandTimeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveResult({ code, signal })
    })
  })
  const logPath = join(scratch, `command-${sequence}.log`)
  await writeFile(logPath, `${command} ${args.join(' ')}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}\n`, 'utf8')
  if (result.code !== 0 || result.signal !== null || timedOut) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? `exit ${String(result.code)}`}${timedOut ? ', timeout' : ''}); inspect ${logPath}`)
  }
  return { logPath, stdout, stderr }
}

function scrubbedEnvironment({ home, dshHome, workspace, receipt }) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('DSH_') || credentialEnvironment.test(key) || providerEnvironment.test(key) || /(?:PROXY|AUTH|CREDENTIAL)/i.test(key) || /^(?:npm_config_(?:userconfig|globalconfig|registry|_auth|auth_token)|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|REGISTRY|_AUTH|AUTH_TOKEN))$/i.test(key)) {
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
    npm_config_userconfig: '/dev/null',
    npm_config_globalconfig: '/dev/null',
    DSH_TELEMETRY_DISABLED: '1',
    CHAT_RECALL_FIXTURE_WORKSPACE: workspace,
    CHAT_RECALL_FIXTURE_RECEIPT: receipt,
  }
}

async function manifest(directory, label) {
  const path = join(directory, 'package.json')
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} manifest is unavailable or invalid at ${path}: ${String(error)}`)
  }
}

async function requireFile(path, label) {
  try {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('not a regular file')
  } catch (error) {
    throw new Error(`${label} is missing at ${path}: ${String(error)}`)
  }
}

async function writeProfilePatch(profile, includeChatRecall) {
  const lines = [
    '- id: session-title-llm',
    '  disabled: true',
  ]
  if (includeChatRecall) {
    lines.push(
      '- id: solar-hindsight-chat-recall',
      '  config:',
      '    timeoutMs: 100',
      '    resultLimit: 2',
      '    maxContextCharacters: 12000',
    )
  }
  lines.push('')
  await writeFile(join(profile, 'cordis.patch.yml'), lines.join('\n'), 'utf8')
}

async function assertReceipt(path, mode) {
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(receipt.pass, true, `fixture reported failure: ${JSON.stringify(receipt)}`)
  assert.equal(receipt.fixtureOnly, true)
  assert.equal(receipt.loadedByOfficialCli, true)
  assert.equal(receipt.noLiveModels, true)
  assert.equal(receipt.mode, mode)
  assert.equal(receipt.actualBuiltPlugin, mode === 'integrated')
  for (const [name, passed] of Object.entries(receipt.checks ?? {})) {
    assert.equal(passed, true, `fixture check failed: ${name}`)
  }
  return receipt
}

async function main() {
  const plugin = await manifest(root, 'chat-recall plugin')
  const fixture = await manifest(fixtureDirectory, 'chat-recall fixture')
  assert.equal(plugin.name, '@lisihao/dsh-solar-hindsight-chat-recall')
  assert.equal(fixture.name, 'dsh-hindsight-chat-recall-fixture')
  await requireFile(join(root, 'lib', 'index.js'), 'built plugin entrypoint')
  await requireFile(join(root, 'lib', 'recall.js'), 'built plugin recall module')

  const scratch = await mkdtemp(join(temporaryRoot, 'dsh-hindsight-chat-recall-plugin-'))
  const artifacts = join(scratch, 'artifacts')
  const home = join(scratch, 'home')
  const dshHome = join(scratch, 'dsh')
  const workspace = join(scratch, 'workspace')
  const baselineBeforeReceiptPath = join(scratch, 'baseline-before-receipt.json')
  const integratedReceiptPath = join(scratch, 'integrated-receipt.json')
  const baselineAfterReceiptPath = join(scratch, 'baseline-after-removal-receipt.json')
  const profile = join(dshHome, 'profiles', profileName)
  await Promise.all([mkdir(artifacts), mkdir(home), mkdir(workspace)])
  const env = scrubbedEnvironment({ home, dshHome, workspace, receipt: baselineBeforeReceiptPath })
  const bootEnvironment = (mode, receipt) => ({
    ...env,
    CHAT_RECALL_FIXTURE_MODE: mode,
    CHAT_RECALL_FIXTURE_RECEIPT: receipt,
  })
  const logs = []
  let sequence = 0
  try {
    logs.push(await run(scratch, ++sequence, 'pnpm', ['pack', '--pack-destination', artifacts], fixtureDirectory, env))
    logs.push(await run(scratch, ++sequence, 'pnpm', ['pack', '--pack-destination', artifacts], root, env))
    const fixtureArchive = join(artifacts, archiveName(fixture))
    const pluginArchive = join(artifacts, archiveName(plugin))
    await Promise.all([
      requireFile(fixtureArchive, 'packed fixture archive'),
      requireFile(pluginArchive, 'packed plugin archive'),
    ])
    logs.push(await run(scratch, ++sequence, cli, [
      'plugin', '--profile', profileName, 'add', '--config.auto-install-peers=false',
      fixtureArchive,
      '@deepseek-ai/cordis@4.0.5',
      '@deepseek-ai/dsh-agent@0.2.1-rc.2',
      '@deepseek-ai/dsh-llm@0.2.1-rc.2',
      '@deepseek-ai/schemastery@3.18.5',
    ], root, env))
    const profileManifest = await manifest(profile, 'scratch profile')
    const bundles = profileManifest?.dsh?.profile?.bundles
    assert(Array.isArray(bundles), 'scratch profile has no bundle list')
    assert(bundles.includes(fixture.name), `scratch profile did not enable ${fixture.name}`)
    assert(!bundles.includes(plugin.name), 'the pre-install baseline unexpectedly enabled chat recall')
    await writeProfilePatch(profile, false)
    logs.push(await run(scratch, ++sequence, cli, ['--profile', profileName], root, bootEnvironment('baseline', baselineBeforeReceiptPath)))
    const baselineBefore = await assertReceipt(baselineBeforeReceiptPath, 'baseline')

    logs.push(await run(scratch, ++sequence, cli, [
      'plugin', '--profile', profileName, 'add', '--config.auto-install-peers=false', pluginArchive,
    ], root, env))
    const installedManifest = await manifest(profile, 'scratch profile after chat-recall installation')
    const installedBundles = installedManifest?.dsh?.profile?.bundles
    assert(Array.isArray(installedBundles) && installedBundles.includes(plugin.name), `scratch profile did not enable ${plugin.name}`)
    await writeProfilePatch(profile, true)
    logs.push(await run(scratch, ++sequence, cli, ['--profile', profileName], root, bootEnvironment('integrated', integratedReceiptPath)))
    const integrated = await assertReceipt(integratedReceiptPath, 'integrated')

    logs.push(await run(scratch, ++sequence, cli, ['plugin', '--profile', profileName, 'remove', plugin.name], root, env))
    const removedManifest = await manifest(profile, 'scratch profile after chat-recall removal')
    const removedBundles = removedManifest?.dsh?.profile?.bundles
    assert(Array.isArray(removedBundles) && !removedBundles.includes(plugin.name), 'chat recall remained enabled after removal')
    await writeProfilePatch(profile, false)
    logs.push(await run(scratch, ++sequence, cli, ['--profile', profileName], root, bootEnvironment('baseline', baselineAfterReceiptPath)))
    const baselineAfter = await assertReceipt(baselineAfterReceiptPath, 'baseline')
    process.stdout.write(`${JSON.stringify({
      pass: true,
      scratch,
      receipts: {
        baselineBefore: baselineBeforeReceiptPath,
        integrated: integratedReceiptPath,
        baselineAfterRemoval: baselineAfterReceiptPath,
      },
      commandLogs: logs.map(log => log.logPath),
      checks: {
        baselineBefore: baselineBefore.checks,
        integrated: integrated.checks,
        baselineAfterRemoval: baselineAfter.checks,
      },
    }, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\nscratch retained at ${scratch}`)
  }
}

main().catch(error => {
  process.stderr.write(`hindsight-chat-recall plugin-test: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
