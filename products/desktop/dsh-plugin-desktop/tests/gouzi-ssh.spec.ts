/** SSH helpers against a real, unprivileged OpenSSH server on loopback. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  freeLoopbackPort, generateKeyPair, installKey, openTunnel, scanHostKey, shellQuote, SshError, sshExec, SYSTEM_SSH,
  type SshHostTarget,
} from '../src/gouzi-ssh.ts'
import { passwordSsh, SSHD_AVAILABLE, startTestSshd, type TestSshd } from './fixtures/test-sshd.ts'

describe.skipIf(!SSHD_AVAILABLE)('SSH helpers', () => {
  let server: TestSshd
  let scratch: string
  let target: SshHostTarget

  beforeAll(async () => {
    server = await startTestSshd()
    scratch = mkdtempSync(join(tmpdir(), 'dsh-gouzi-ssh-'))
    const key = await scanHostKey(SYSTEM_SSH, '127.0.0.1', server.port)
    writeFileSync(join(scratch, 'known_hosts'), `${key.line}\n`)
    target = { address: '127.0.0.1', port: server.port, user: server.user, keyPath: server.identity, knownHostsPath: join(scratch, 'known_hosts') }
  }, 60_000)

  afterAll(async () => {
    await server.stop()
    rmSync(scratch, { recursive: true, force: true })
  })

  it('reads the host key and fingerprint without logging in', async () => {
    const key = await scanHostKey(SYSTEM_SSH, '127.0.0.1', server.port)
    expect(key).toMatchObject({ keyType: 'ssh-ed25519', fingerprint: server.fingerprint })
    expect(key.line).toContain(`[127.0.0.1]:${String(server.port)}`)
  })

  it('reports an unreachable machine in words the user can act on', async () => {
    const closed = await freeLoopbackPort()
    await expect(scanHostKey(SYSTEM_SSH, '127.0.0.1', closed)).rejects.toMatchObject({ code: 'UNREACHABLE' })
  })

  it('creates a private key readable only by its owner and returns the public line', async () => {
    const keyPath = join(scratch, 'keys', 'id_ed25519')
    const publicKey = await generateKeyPair(SYSTEM_SSH, keyPath)
    expect(publicKey).toMatch(/^ssh-ed25519 /u)
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
  })

  it('runs a command with the dedicated key and passes standard input', async () => {
    expect((await sshExec(SYSTEM_SSH, target, 'echo hello-from-remote')).trim()).toBe('hello-from-remote')
    expect(await sshExec(SYSTEM_SSH, target, 'cat', { stdin: 'round trip' })).toBe('round trip')
    await expect(sshExec(SYSTEM_SSH, target, 'exit 3')).rejects.toBeInstanceOf(SshError)
  })

  it('refuses a machine whose host key differs from the pinned one', async () => {
    const other = await startTestSshd()
    try {
      const wrong: SshHostTarget = { ...target, port: other.port, keyPath: other.identity }
      await expect(sshExec(SYSTEM_SSH, wrong, 'true')).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
    } finally {
      await other.stop()
    }
  }, 60_000)

  it('installs a dedicated key once with the password, and a second run does not duplicate it', async () => {
    const ssh = passwordSsh(scratch, 'correct horse', server)
    const binaries = { ...SYSTEM_SSH, ssh }
    const publicKey = await generateKeyPair(SYSTEM_SSH, join(scratch, 'installed', 'id_ed25519'))
    await installKey(binaries, target, 'correct horse', publicKey)
    await installKey(binaries, target, 'correct horse', publicKey)
    const authorized = join(scratch, 'home', '.ssh', 'authorized_keys')
    const lines = readFileSync(authorized, 'utf8').split('\n').filter(line => line.length > 0)
    expect(lines).toEqual([publicKey])
    expect(statSync(authorized).mode & 0o777).toBe(0o600)
    expect(statSync(join(scratch, 'home', '.ssh')).mode & 0o777).toBe(0o700)
  })

  it('reports a wrong password as such, and never leaves the askpass script behind', async () => {
    const ssh = passwordSsh(scratch, 'correct horse', server)
    const publicKey = readFileSync(`${server.identity}.pub`, 'utf8').trim()
    await expect(installKey({ ...SYSTEM_SSH, ssh }, target, 'wrong', publicKey)).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    expect(existsSync(join(scratch, 'home', '.ssh', 'authorized_keys')) ? readFileSync(join(scratch, 'home', '.ssh', 'authorized_keys'), 'utf8') : '')
      .not.toContain('wrong')
  })

  it('forwards a loopback port to the remote machine and closes it on request', async () => {
    const upstream = createServer(socket => { socket.end('pong') })
    await new Promise<void>(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen))
    const remotePort = (upstream.address() as { port: number }).port
    const localPort = await freeLoopbackPort()
    const tunnel = await openTunnel(SYSTEM_SSH, target, localPort, remotePort)
    try {
      const received = await new Promise<string>((resolveRead, rejectRead) => {
        const socket = connect({ host: '127.0.0.1', port: localPort })
        let data = ''
        socket.on('data', chunk => { data += chunk.toString() })
        socket.once('close', () => { resolveRead(data) })
        socket.once('error', rejectRead)
      })
      expect(received).toBe('pong')
    } finally {
      tunnel.close()
      await tunnel.closed
      upstream.close()
    }
  })

  it('fails a forward that cannot start instead of reporting it open', async () => {
    const taken = createServer()
    await new Promise<void>(resolveListen => taken.listen(0, '127.0.0.1', resolveListen))
    const takenPort = (taken.address() as { port: number }).port
    try {
      await expect(openTunnel(SYSTEM_SSH, target, takenPort, 9)).rejects.toBeInstanceOf(SshError)
    } finally {
      taken.close()
    }
  })
})

describe('shellQuote', () => {
  it('survives quotes and spaces', () => {
    expect(shellQuote("/Applications/DSH Desktop.app")).toBe("'/Applications/DSH Desktop.app'")
    expect(shellQuote("it's")).toBe("'it'\\''s'")
  })
})

describe('a command that exits without reading its input', () => {
  const target: SshHostTarget = { address: '127.0.0.1', port: 22, user: 'nobody', keyPath: '/nonexistent', knownHostsPath: '/nonexistent' }

  it('settles normally instead of raising an unhandled EPIPE from the closed input pipe', async () => {
    const unhandled: unknown[] = []
    const record = (error: unknown): void => { unhandled.push(error) }
    process.on('uncaughtException', record)
    try {
      // `true` ignores its standard input and exits at once; two megabytes cannot fit in the pipe before it does.
      const output = await sshExec({ ...SYSTEM_SSH, ssh: 'true' }, target, 'ignored', { stdin: 'x'.repeat(2_000_000) })
      expect(output).toBe('')
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
      expect(unhandled).toEqual([])
    } finally {
      process.off('uncaughtException', record)
    }
  })
})
