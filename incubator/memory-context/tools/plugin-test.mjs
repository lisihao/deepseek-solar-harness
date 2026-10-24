import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tools', 'fixture')
const cli = process.env.DSH_TEST_BIN ?? join(root, 'node_modules', '.bin', 'dsh')
const profileName = 'memory-context-plugin-test'
const commandTimeoutMs = 120_000
const temporaryParent = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
const credentialEnvironment = /(?:^|_)(?:API_KEY|ACCESS_KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_KEY|CLIENT_SECRET|OAUTH|BEARER)(?:$|_)/i
const providerEnvironment = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|CLAUDE|CODEX)(?:_|$)/i

function archiveName(manifest) {
  return `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
}

async function requireFile(path, label) {
  const info = await stat(path)
  assert(info.isFile(), `${label} is not a regular file: ${path}`)
}

async function manifest(directory) {
  return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
}

function environment({ home, dshHome, mode, receipt }) {
  const value = { ...process.env }
  for (const key of Object.keys(value)) {
    if (key.startsWith('DSH_') || credentialEnvironment.test(key) || providerEnvironment.test(key) || /(?:PROXY|AUTH|CREDENTIAL)/i.test(key)) delete value[key]
  }
  return {
    ...value,
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
    MEMORY_CONTEXT_FIXTURE_MODE: mode,
    MEMORY_CONTEXT_FIXTURE_RECEIPT: receipt,
  }
}

async function run(scratch, sequence, command, args, env, cwd = root) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  let timedOut = false
  const result = await new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* already exited */ }
    }, commandTimeoutMs)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timeout); resolveResult({ code, signal }) })
  })
  const log = join(scratch, `command-${sequence}.log`)
  await writeFile(log, `${command} ${args.join(' ')}\n\nstdout:\n${stdout}\n\nstderr:\n${stderr}\n`, 'utf8')
  if (result.code !== 0 || result.signal !== null || timedOut) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.signal ?? `exit ${String(result.code)}`}${timedOut ? ', timeout' : ''}); inspect ${log}`)
  }
}

async function writeProfilePatch(profile, integrated) {
  const lines = [
    '- id: session-title-llm',
    '  disabled: true',
  ]
  if (integrated) {
    lines.push(
      '- id: solar-memory-context',
      '  config:',
      '    maxFacts: 4',
      '    historyFallbackFacts: 2',
    )
  }
  lines.push('')
  await writeFile(join(profile, 'cordis.patch.yml'), lines.join('\n'), 'utf8')
}

async function assertReceipt(path, expectedMode) {
  const receipt = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(receipt.pass, true, `fixture failed: ${JSON.stringify(receipt)}`)
  assert.equal(receipt.fixtureOnly, true)
  assert.equal(receipt.loadedByOfficialCli, true)
  assert.equal(receipt.noLiveModels, true)
  assert.equal(receipt.mode, expectedMode)
  assert.equal(receipt.actualBuiltPlugin, expectedMode === 'integrated')
  for (const [check, passed] of Object.entries(receipt.checks ?? {})) assert.equal(passed, true, `fixture check failed: ${check}`)
}

async function main() {
  const plugin = await manifest(root)
  const fixtureManifest = await manifest(fixture)
  assert.equal(plugin.name, '@lisihao/dsh-solar-memory-context')
  assert.equal(fixtureManifest.name, 'dsh-memory-context-fixture')
  await Promise.all([
    requireFile(join(root, 'lib', 'index.js'), 'built plugin entrypoint'),
    requireFile(join(root, 'lib', 'graph-memory.js'), 'built projection helper'),
    requireFile(cli, 'published DSH CLI'),
  ])

  const scratch = await mkdtemp(join(temporaryParent, 'dsh-memory-context-plugin-'))
  const artifacts = join(scratch, 'artifacts')
  const home = join(scratch, 'home')
  const dshHome = join(scratch, 'dsh')
  const profile = join(dshHome, 'profiles', profileName)
  const baselineReceipt = join(scratch, 'baseline.json')
  const graphFirstReceipt = join(scratch, 'graph-first.json')
  const solarFirstReceipt = join(scratch, 'solar-first.json')
  await Promise.all([mkdir(artifacts), mkdir(home)])
  const packEnvironment = environment({ home, dshHome, mode: 'baseline', receipt: baselineReceipt })
  let sequence = 0
  // Both local manifests have no prepack/prepare lifecycle hook. pnpm pack has
  // no --ignore-scripts option, so this command only archives already-built files.
  await run(scratch, ++sequence, 'pnpm', ['pack', '--pack-destination', artifacts], packEnvironment)
  await run(scratch, ++sequence, 'pnpm', ['pack', '--pack-destination', artifacts], packEnvironment, fixture)
  const pluginArchive = join(artifacts, archiveName(plugin))
  const fixtureArchive = join(artifacts, archiveName(fixtureManifest))
  await Promise.all([requireFile(pluginArchive, 'packed plugin'), requireFile(fixtureArchive, 'packed fixture')])
  await run(scratch, ++sequence, cli, [
    'plugin', '--profile', profileName, 'add', '--config.auto-install-peers=false', fixtureArchive,
    '@deepseek-ai/cordis@4.0.5', '@deepseek-ai/dsh-agent@0.2.1-rc.2', '@deepseek-ai/dsh-llm@0.2.1-rc.2', '@deepseek-ai/dsh-tools@0.2.1-rc.2',
  ], packEnvironment)
  await writeProfilePatch(profile, false)
  await run(scratch, ++sequence, cli, ['--profile', profileName], environment({ home, dshHome, mode: 'baseline', receipt: baselineReceipt }))
  await assertReceipt(baselineReceipt, 'baseline')
  await run(scratch, ++sequence, cli, ['plugin', '--profile', profileName, 'add', '--config.auto-install-peers=false', pluginArchive], packEnvironment)
  await writeProfilePatch(profile, true)
  await run(scratch, ++sequence, cli, ['--profile', profileName], environment({ home, dshHome, mode: 'integrated', receipt: graphFirstReceipt }))
  await assertReceipt(graphFirstReceipt, 'integrated')

  // Reverse installation order on a distinct disposable profile. The fixture's
  // Graph Memory producer is now activated after this adapter's bundle, proving
  // attachment does not rely on profile order.
  const solarFirstProfileName = `${profileName}-solar-first`
  const solarFirstProfile = join(dshHome, 'profiles', solarFirstProfileName)
  await run(scratch, ++sequence, cli, [
    'plugin', '--profile', solarFirstProfileName, 'add', '--config.auto-install-peers=false', pluginArchive,
    '@deepseek-ai/cordis@4.0.5', '@deepseek-ai/dsh-agent@0.2.1-rc.2', '@deepseek-ai/dsh-llm@0.2.1-rc.2', '@deepseek-ai/dsh-session@0.2.1-rc.2', '@deepseek-ai/schemastery@3.18.5',
  ], packEnvironment)
  await run(scratch, ++sequence, cli, [
    'plugin', '--profile', solarFirstProfileName, 'add', '--config.auto-install-peers=false', fixtureArchive,
    '@deepseek-ai/dsh-tools@0.2.1-rc.2',
  ], packEnvironment)
  await writeProfilePatch(solarFirstProfile, true)
  await run(scratch, ++sequence, cli, ['--profile', solarFirstProfileName], environment({ home, dshHome, mode: 'integrated', receipt: solarFirstReceipt }))
  await assertReceipt(solarFirstReceipt, 'integrated')
  process.stdout.write(`memory-context scratch profile checks passed; receipts: ${baselineReceipt}, ${graphFirstReceipt}, ${solarFirstReceipt}\n`)
}

await main()
