/** SSH helpers against a real, unprivileged OpenSSH server on loopback. */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  freeLoopbackPort, generateKeyPair, installKey, openTunnel, pinnedFingerprint, resolveTailscale, scanHostKey, shellQuote, SshError, sshExec,
  SYSTEM_SSH, TAILSCALE_CANDIDATES, type SshHostTarget,
} from '../src/gouzi-ssh.ts'
import { fakeTailscale } from './fixtures/fake-tailscale.ts'
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

describe.skipIf(!SSHD_AVAILABLE)('SSH through Tailscale', () => {
  let server: TestSshd
  let scratch: string
  let tailscale: ReturnType<typeof fakeTailscale>
  let binaries: typeof SYSTEM_SSH
  let target: SshHostTarget
  const route = { via: 'tailscale', socket: '/var/run/tailscale/test.sock' } as const

  beforeAll(async () => {
    server = await startTestSshd()
    scratch = mkdtempSync(join(tmpdir(), 'dsh-gouzi-tailscale-'))
    tailscale = fakeTailscale(scratch)
    binaries = { ...SYSTEM_SSH, tailscale: tailscale.path }
    const key = await scanHostKey(binaries, '127.0.0.1', server.port, route)
    writeFileSync(join(scratch, 'known_hosts'), `${key.line}\n`)
    target = { address: '127.0.0.1', port: server.port, user: server.user, keyPath: server.identity, knownHostsPath: join(scratch, 'known_hosts'), route }
  }, 60_000)

  afterAll(async () => {
    await server.stop()
    rmSync(scratch, { recursive: true, force: true })
  })

  it('reads the host key through the relay, passing the socket, and records the line later connections look up', async () => {
    const key = await scanHostKey(binaries, '127.0.0.1', server.port, route)
    expect(key).toMatchObject({ keyType: 'ssh-ed25519', fingerprint: server.fingerprint })
    expect(key.line).toContain(`[127.0.0.1]:${String(server.port)}`)
    expect(tailscale.calls().at(-1)).toEqual(['--socket=/var/run/tailscale/test.sock', 'nc', '127.0.0.1', String(server.port)])
    expect(await pinnedFingerprint(binaries, join(scratch, 'known_hosts'))).toBe(server.fingerprint)
  })

  it('runs commands and keeps a forward open through the relay', async () => {
    expect((await sshExec(binaries, target, 'echo over-tailscale')).trim()).toBe('over-tailscale')
    const before = tailscale.calls().length
    const local = await freeLoopbackPort()
    const tunnel = await openTunnel(binaries, target, local, server.port)
    try {
      expect(tailscale.calls().length).toBeGreaterThan(before)
    } finally {
      tunnel.close()
      await tunnel.closed
    }
  })

  it('leaves the socket out when none is configured, so the CLI uses its default', async () => {
    await scanHostKey(binaries, '127.0.0.1', server.port, { via: 'tailscale' })
    expect(tailscale.calls().at(-1)).toEqual(['nc', '127.0.0.1', String(server.port)])
  })

  it('treats a socket path as data: shell metacharacters in it run nothing', async () => {
    const marker = join(scratch, 'pwned')
    const hostile = { via: 'tailscale', socket: `/tmp/a b'; touch ${marker}; '` } as const
    await scanHostKey(binaries, '127.0.0.1', server.port, hostile)
    expect(tailscale.calls().at(-1)?.[0]).toBe(`--socket=${hostile.socket}`)
    expect(existsSync(marker)).toBe(false)
  })

  it('says Tailscale is not running or its socket is wrong, instead of a generic failure', async () => {
    tailscale.setDown(true)
    try {
      await expect(scanHostKey(binaries, '127.0.0.1', server.port, route)).rejects.toMatchObject({ code: 'UNREACHABLE', message: expect.stringContaining('Tailscale 没有运行') })
      await expect(sshExec(binaries, target, 'true')).rejects.toMatchObject({ code: 'UNREACHABLE', message: expect.stringContaining('Tailscale 没有运行') })
    } finally {
      tailscale.setDown(false)
    }
  })

  it('does not follow the user ssh configuration: a routed host is looked up under its own address', async () => {
    const other = await startTestSshd()
    try {
      const wrong: SshHostTarget = { ...target, port: other.port, keyPath: other.identity }
      await expect(sshExec(binaries, wrong, 'true')).rejects.toMatchObject({ code: 'HOST_KEY_CHANGED' })
    } finally {
      await other.stop()
    }
  })
})

describe('finding the Tailscale CLI', () => {
  it('uses the configured path when it exists and otherwise names every path it tried', () => {
    expect(resolveTailscale('/custom/tailscale', path => path === '/custom/tailscale')).toBe('/custom/tailscale')
    expect(() => resolveTailscale('/custom/tailscale', () => false)).toThrow(/\/custom\/tailscale/u)
    for (const candidate of TAILSCALE_CANDIDATES) expect(() => resolveTailscale('', () => false)).toThrow(candidate)
  })

  it('takes the first installed candidate, and never a path ssh would expand', () => {
    expect(resolveTailscale('', path => path === TAILSCALE_CANDIDATES[1])).toBe(TAILSCALE_CANDIDATES[1])
    expect(() => resolveTailscale('/odd/%h/tailscale', () => true)).toThrow(SshError)
  })

  it('reports a missing CLI when a routed host is scanned', async () => {
    await expect(scanHostKey({ ...SYSTEM_SSH, tailscale: '/definitely/not/here' }, '127.0.0.1', 22, { via: 'tailscale' })).rejects.toMatchObject({ code: 'COMMAND_FAILED' })
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
