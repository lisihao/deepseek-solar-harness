/**
 * SSH hosts end to end: a real OpenSSH server on loopback, the real remote agent behind a stand-in `DSH Desktop`
 * executable, and a real member process reached through a real port forward. Only the password prompt is replaced
 * (an unprivileged server cannot check passwords); everything after the login is the production path.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RemoteGouziHosts } from '../src/gouzi-remote.ts'
import { SYSTEM_SSH } from '../src/gouzi-ssh.ts'
import { passwordSsh, SSHD_AVAILABLE, startTestSshd, type TestSshd } from './fixtures/test-sshd.ts'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRIVER = join(PACKAGE_ROOT, 'tests', 'fixtures', 'gouzi-agent-driver.ts')
const PASSWORD = 'correct horse'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, encoding: 'utf8' })
}

async function reachable(endpoint: string): Promise<boolean> {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(3_000) })
    return true
  } catch {
    // A refused or reset connection is the answer being asked for.
    return false
  }
}

/** Each login or agent call starts a Node process through tsx, which is slow on a loaded CI runner. */
const STEP_TIMEOUT_MS = 120_000

describe.skipIf(!SSHD_AVAILABLE).sequential('Gouzi SSH hosts', { timeout: STEP_TIMEOUT_MS }, () => {
  let server: TestSshd
  let scratch: string
  let hostsRoot: string
  let remoteApp: string
  let repository: string
  let hosts: RemoteGouziHosts
  let hostId = ''

  const target = () => ({ address: '127.0.0.1', port: server.port, user: server.user })
  const setVersion = (version: string): void => { writeFileSync(join(scratch, 'version'), version) }

  beforeAll(async () => {
    server = await startTestSshd()
    scratch = mkdtempSync(join(tmpdir(), 'dsh-gouzi-remote-'))
    hostsRoot = join(scratch, 'hosts')
    remoteApp = join(scratch, 'Fake DSH Desktop.app')
    mkdirSync(join(remoteApp, 'Contents', 'MacOS'), { recursive: true })
    const executable = join(remoteApp, 'Contents', 'MacOS', 'DSH Desktop')
    writeFileSync(executable, [
      '#!/bin/sh',
      '# The first argument is the agent script path inside the real app; the stand-in runs the source driver instead.',
      'shift',
      `export DSH_HOME='${join(scratch, 'remote-home')}'`,
      `export FAKE_APP_VERSION="$(cat '${join(scratch, 'version')}')"`,
      `exec '${process.execPath}' --import '${pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href}' '${DRIVER}' "$@"`,
      '',
    ].join('\n'))
    chmodSync(executable, 0o755)
    setVersion('3.36.0')
    repository = join(scratch, 'PetGoGo')
    mkdirSync(repository, { recursive: true })
    writeFileSync(join(repository, 'README.md'), 'pet\n')
    git(repository, 'init', '--initial-branch=main')
    git(repository, 'config', 'user.name', 'DSH Test')
    git(repository, 'config', 'user.email', 'dsh-test@example.invalid')
    git(repository, 'add', '.')
    git(repository, 'commit', '-m', 'fixture')
    git(repository, 'remote', 'add', 'origin', 'https://github.com/lisihao/PetGoGo.git')
    hosts = new RemoteGouziHosts({ root: hostsRoot, binaries: { ...SYSTEM_SSH, ssh: passwordSsh(scratch, PASSWORD, server) }, remoteApp })
  }, 60_000)

  afterAll(async () => {
    hosts.dispose()
    await server.stop()
    rmSync(scratch, { recursive: true, force: true })
  })

  it('shows the key a machine presents without logging in', async () => {
    expect(await hosts.inspect(target())).toEqual({ keyType: 'ssh-ed25519', fingerprint: server.fingerprint })
  })

  it('refuses a fingerprint the user did not confirm and leaves nothing behind', async () => {
    await expect(hosts.add({ ...target(), password: PASSWORD, fingerprint: 'SHA256:not-the-key' })).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
    expect(hosts.list()).toEqual([])
    expect(existsSync(hostsRoot) ? readFileSync(join(hostsRoot, 'hosts.json'), 'utf8') : '').not.toContain('127.0.0.1')
  })

  it('refuses a wrong password and removes the half-made host directory', async () => {
    const wrong = new RemoteGouziHosts({ root: hostsRoot, binaries: { ...SYSTEM_SSH, ssh: passwordSsh(scratch, 'something else', server) }, remoteApp })
    await expect(wrong.add({ ...target(), password: PASSWORD, fingerprint: server.fingerprint })).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(wrong.list()).toEqual([])
    const leftovers = existsSync(hostsRoot) ? execFileSync('ls', [hostsRoot], { encoding: 'utf8' }).split('\n').filter(name => name.startsWith('ssh-')) : []
    expect(leftovers).toEqual([])
  })

  it('refuses a machine whose DSH Desktop is too old to run the agent', async () => {
    setVersion('3.35.0')
    await expect(hosts.add({ ...target(), password: PASSWORD, fingerprint: server.fingerprint })).rejects.toThrow(/太旧/u)
    expect(hosts.list()).toEqual([])
    setVersion('3.36.0')
  })

  it('refuses a machine without DSH Desktop', async () => {
    const missing = new RemoteGouziHosts({ root: hostsRoot, binaries: { ...SYSTEM_SSH, ssh: passwordSsh(scratch, PASSWORD, server) }, remoteApp: join(scratch, 'Nope.app') })
    await expect(missing.add({ ...target(), password: PASSWORD, fingerprint: server.fingerprint })).rejects.toThrow(/没有可用的 DSH Desktop/u)
    expect(missing.list()).toEqual([])
  })

  it('adds a machine: pins its key, installs a dedicated key with the password, and stores no password', async () => {
    const added = await hosts.add({ ...target(), password: PASSWORD, fingerprint: server.fingerprint, label: 'Mac mini' })
    hostId = added.hostId
    expect(added).toMatchObject({ kind: 'ssh', label: 'Mac mini', appVersion: '3.36.0', address: `${server.user}@127.0.0.1:${String(server.port)}` })
    const directory = join(hostsRoot, hostId)
    expect(statSync(join(directory, 'id_ed25519')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(directory, 'known_hosts'), 'utf8')).toContain(`[127.0.0.1]:${String(server.port)}`)
    expect(statSync(join(hostsRoot, 'hosts.json')).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(hostsRoot, 'hosts.json'), 'utf8')).not.toContain(PASSWORD)
    // The machines that were refused earlier took their keys back, so this is the only one left.
    const installed = readFileSync(join(scratch, 'home', '.ssh', 'authorized_keys'), 'utf8')
    expect(installed.trim()).toBe(readFileSync(join(directory, 'id_ed25519.pub'), 'utf8').trim())
  }, 60_000)

  it('inspects directories without mutation and prepares plain directories on the remote machine', async () => {
    const listing = await hosts.browse(hostId, scratch)
    expect(listing.entries).toContainEqual({ name: 'PetGoGo', path: expect.stringContaining('PetGoGo'), git: true })
    expect(listing.entries.find(entry => entry.name === 'hosts')?.git).toBe(false)
    expect(await hosts.resolveRepository(hostId, repository)).toMatchObject({ repository: 'github.com/lisihao/PetGoGo' })
    const plain = await hosts.resolveRepository(hostId, hostsRoot)
    expect(plain.source).toBe(realpathSync(hostsRoot))
    expect(existsSync(join(hostsRoot, '.git'))).toBe(false)
    expect(await hosts.prepareRepository(hostId, hostsRoot)).toEqual(plain)
    expect(existsSync(join(hostsRoot, '.git'))).toBe(true)
  }, 60_000)

  it('starts a real member on the machine, reaches it through the forward, and stops it', async () => {
    await hosts.provision({
      gouziId: 'gouzi-remote-1', ownerId: 'owner-test', hostId, generation: 1, authorityEpoch: 'epoch-test',
      projects: [await hosts.resolveRepository(hostId, repository)],
      defaultProjectId: (await hosts.resolveRepository(hostId, repository)).projectId,
    })
    const started = await hosts.start(hostId, 'gouzi-remote-1')
    expect(started.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u)
    expect(await reachable(started.endpoint)).toBe(true)

    // A new main instance finds the forward again from the stored catalog and keeps the same endpoint.
    hosts.dispose()
    expect(await reachable(started.endpoint)).toBe(false)
    const restarted = new RemoteGouziHosts({ root: hostsRoot, binaries: { ...SYSTEM_SSH, ssh: passwordSsh(scratch, PASSWORD, server) }, remoteApp })
    restarted.restore()
    const deadline = Date.now() + 15_000
    while (!(await reachable(started.endpoint)) && Date.now() < deadline) await new Promise(resolveWait => setTimeout(resolveWait, 200))
    expect(await reachable(started.endpoint)).toBe(true)

    expect(await restarted.stop(hostId, 'gouzi-remote-1', { reclaimResident: true })).toEqual({ processTreeStopped: true })
    expect(await reachable(started.endpoint)).toBe(false)
    expect(JSON.parse(readFileSync(join(hostsRoot, 'hosts.json'), 'utf8')).forwards).toEqual({})
    restarted.dispose()
  }, 300_000)

  it('removes a machine with its key, on both ends', async () => {
    await hosts.remove(hostId)
    expect(hosts.list()).toEqual([])
    expect(existsSync(join(hostsRoot, hostId))).toBe(false)
    expect(readFileSync(join(scratch, 'home', '.ssh', 'authorized_keys'), 'utf8').trim()).toBe('')
    await expect(hosts.remove(hostId)).rejects.toThrow(/unknown host/u)
  })
})
