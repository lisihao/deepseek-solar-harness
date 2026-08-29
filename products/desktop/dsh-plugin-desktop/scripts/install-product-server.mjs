#!/usr/bin/env node
/** Build and atomically activate one fixed GitHub Product Server release on macOS. */

import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stopProductServerDaemons } from './product-server-processes.mjs'

const DEFAULT_REPOSITORY = 'https://github.com/lisihao/deepseek-solar-harness.git'
const REQUIRED_CAPABILITIES = [
  'operator.read', 'operator.execute', 'operator.interrupt',
  'operator.workspace.materialize', 'operator.artifact.read',
]

export function parseInstallerArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (typeof key !== 'string' || !key.startsWith('--') || value === undefined) {
      throw new Error('usage: install-product-server --ref DSH-desktop-vX.Y.Z --commit <40-hex> [--repo URL] [--host HOST] [--port PORT] [--root PATH]')
    }
    values.set(key, value)
  }
  const ref = values.get('--ref')
  const commit = values.get('--commit')
  if (typeof ref !== 'string' || !/^DSH-desktop-v\d+\.\d+\.\d+$/.test(ref)) {
    throw new Error('install-product-server: --ref must be a stable DSH-desktop-vX.Y.Z tag')
  }
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('install-product-server: --commit must be the exact 40-character lowercase Git commit')
  }
  const port = Number(values.get('--port') ?? '13080')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('install-product-server: --port must be an integer from 1 to 65535')
  }
  return {
    ref,
    commit,
    repository: values.get('--repo') ?? DEFAULT_REPOSITORY,
    host: values.get('--host') ?? '127.0.0.1',
    port,
    root: resolve(values.get('--root') ?? join(homedir(), 'Library', 'Application Support', 'DSH Product Server')),
  }
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function renderProductServerLaunchAgent(options) {
  const argumentsList = [
    options.nodePath,
    join(options.currentPath, 'products', 'desktop', 'dsh-plugin-desktop', 'lib', 'product-server-bin.js'),
    '--host', options.host,
    '--port', String(options.port),
  ]
  const array = argumentsList.map(value => `      <string>${xml(value)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${array}
  </array>
  <key>WorkingDirectory</key><string>${xml(join(options.currentPath, 'products', 'desktop', 'dsh-plugin-desktop'))}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DSH_HOME</key><string>${xml(options.dshHome)}</string>
    <key>DSH_BUILD_COMMIT</key><string>${xml(options.commit)}</string>
    <key>HOME</key><string>${xml(homedir())}</string>
    <key>PATH</key><string>${xml(options.path)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(options.stderrPath)}</string>
</dict>
</plist>
`
}

export function validateProductServerDescription(description, providers) {
  if (typeof description !== 'object' || description === null || !Array.isArray(description.capabilities)) {
    throw new Error('install-product-server: invalid Remote Sync description')
  }
  for (const capability of REQUIRED_CAPABILITIES) {
    if (!description.capabilities.includes(capability)) {
      throw new Error(`install-product-server: Product Server is missing ${capability}`)
    }
  }
  if (description.protocol?.major !== 1 || description.protocol?.minor !== 4) {
    throw new Error('install-product-server: Remote Sync protocol must be 1.4')
  }
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error('install-product-server: Product Server has no resident providers')
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${basename(command)} exited ${String(code ?? signal)}`))
    })
  })
}

function output(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise(stdout.trim())
      else reject(new Error(`${basename(command)} exited ${String(code ?? signal)}: ${stderr.trim()}`))
    })
  })
}

async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function replaceSymlink(path, target) {
  const temporary = `${path}.next-${String(process.pid)}`
  await rm(temporary, { force: true })
  await symlink(target, temporary)
  await rename(temporary, path)
}

async function atomicWrite(path, content) {
  const temporary = `${path}.next-${String(process.pid)}`
  await writeFile(temporary, content, { mode: 0o600 })
  await rename(temporary, path)
}

async function rpc(baseUrl, method) {
  const rpcId = `installer-${method}`
  const response = await fetch(`${baseUrl}/remote-sync/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: {} }),
  })
  if (!response.ok) throw new Error(`install-product-server: ${method} returned HTTP ${String(response.status)}`)
  const envelope = await response.json()
  if (envelope?.rpcId !== rpcId || envelope?.result?.ok !== true) {
    throw new Error(`install-product-server: ${method} returned an invalid response`)
  }
  return envelope.result.value
}

async function verifyRunning(baseUrl, expectedCommit) {
  const deadline = Date.now() + 30_000
  let lastError = 'not ready'
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/`)
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      await response.arrayBuffer()
      const description = await rpc(baseUrl, 'describe')
      const providers = await rpc(baseUrl, 'operator.providers')
      validateProductServerDescription(description, providers)
      return { http: response.status, protocol: description.protocol, capabilities: description.capabilities, providers: providers.length }
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
    }
  }
  throw new Error(`install-product-server: runtime verification timed out: ${lastError}`)
}

async function launchctl(domain, command, ...args) {
  await run('/bin/launchctl', [command, ...args], { stdio: 'ignore' })
}

async function bootout(domain, label) {
  try {
    await launchctl(domain, 'bootout', `${domain}/${label}`)
  } catch {
    // An absent service is the expected first-install state.
  }
}

async function activateService({ domain, label, plistPath }) {
  await bootout(domain, label)
  await launchctl(domain, 'bootstrap', domain, plistPath)
  await launchctl(domain, 'kickstart', '-k', `${domain}/${label}`)
}

export async function installProductServer(options) {
  if (process.platform !== 'darwin') throw new Error('install-product-server: macOS is required')
  const releases = join(options.root, 'releases')
  const current = join(options.root, 'current')
  const rollback = join(options.root, 'rollback')
  const state = join(options.root, 'state')
  const logs = join(options.root, 'logs')
  const release = join(releases, options.commit)
  const label = 'ai.deepseek.dsh.product-server'
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  const domain = `gui/${String(process.getuid())}`
  await mkdir(releases, { recursive: true, mode: 0o700 })
  await mkdir(state, { recursive: true, mode: 0o700 })
  await mkdir(logs, { recursive: true, mode: 0o700 })
  await mkdir(dirname(plistPath), { recursive: true })

  if (!await exists(release)) {
    const staging = await mkdtemp(join(options.root, '.stage-'))
    try {
      await run('git', ['clone', '--filter=blob:none', '--single-branch', '--branch', options.ref, options.repository, staging])
      const actual = await output('git', ['rev-parse', 'HEAD'], { cwd: staging })
      if (actual !== options.commit) {
        throw new Error(`install-product-server: tag ${options.ref} resolved to ${actual}, expected ${options.commit}`)
      }
      const desktop = join(staging, 'products', 'desktop')
      await run('corepack', ['yarn', 'install', '--immutable'], { cwd: desktop })
      await run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'build'], { cwd: desktop })
      await run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:product-server'], { cwd: desktop })
      await writeFile(join(staging, '.dsh-product-server-release'), `${options.commit}\n`, { mode: 0o600 })
      await rename(staging, release)
    } catch (cause) {
      await rm(staging, { recursive: true, force: true })
      throw cause
    }
  } else {
    const marker = (await readFile(join(release, '.dsh-product-server-release'), 'utf8')).trim()
    if (marker !== options.commit) throw new Error('install-product-server: existing release marker does not match commit')
    await run('corepack', ['yarn', 'workspace', 'dsh-plugin-desktop', 'verify:product-server'], {
      cwd: join(release, 'products', 'desktop'),
    })
  }

  const previousTarget = await readlink(current).catch(cause => cause?.code === 'ENOENT' ? undefined : Promise.reject(cause))
  const previousPlist = await readFile(plistPath, 'utf8').catch(cause => cause?.code === 'ENOENT' ? undefined : Promise.reject(cause))
  const plist = renderProductServerLaunchAgent({
    label,
    nodePath: process.execPath,
    currentPath: current,
    dshHome: join(state, 'dsh-home'),
    commit: options.commit,
    host: options.host,
    port: options.port,
    path: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    stdoutPath: join(logs, 'stdout.log'),
    stderrPath: join(logs, 'stderr.log'),
  })
  try {
    await bootout(domain, label)
    await stopProductServerDaemons(join(state, 'dsh-home'))
    if (previousTarget !== undefined) await replaceSymlink(rollback, previousTarget)
    await replaceSymlink(current, release)
    await atomicWrite(plistPath, plist)
    await activateService({ domain, label, plistPath })
    const evidence = await verifyRunning(`http://${options.host}:${String(options.port)}`, options.commit)
    return { ...evidence, ref: options.ref, commit: options.commit, release, rollback: previousTarget ?? null }
  } catch (cause) {
    await bootout(domain, label)
    await stopProductServerDaemons(join(state, 'dsh-home'))
    if (previousTarget !== undefined) await replaceSymlink(current, previousTarget)
    else await rm(current, { force: true })
    if (previousPlist !== undefined) {
      await atomicWrite(plistPath, previousPlist)
      await activateService({ domain, label, plistPath })
      if (previousTarget !== undefined) {
        const previousCommit = (await readFile(join(previousTarget, '.dsh-product-server-release'), 'utf8')).trim()
        await verifyRunning(`http://${options.host}:${String(options.port)}`, previousCommit)
      }
    } else {
      await rm(plistPath, { force: true })
    }
    throw cause
  }
}

const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  installProductServer(parseInstallerArguments(process.argv.slice(2)))
    .then(evidence => { process.stdout.write(`${JSON.stringify({ status: 'ok', ...evidence })}\n`) })
    .catch(cause => {
      process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`)
      process.exitCode = 1
    })
}
