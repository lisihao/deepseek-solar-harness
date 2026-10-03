/** An unprivileged OpenSSH server on loopback for tests: key login only, as the user running the tests. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'

/** Whether this machine can run the fixture; the system server is the macOS one. */
export const SSHD_AVAILABLE = process.platform === 'darwin' && existsSync('/usr/sbin/sshd')

/** A running test server and the identity that may log in to it. */
export interface TestSshd {
  readonly port: number
  readonly user: string
  readonly directory: string
  /** Private key that is authorized on the server. */
  readonly identity: string
  /** `SHA256:` fingerprint of the server host key. */
  readonly fingerprint: string
  readonly authorizedKeys: string
  stop(): Promise<void>
}

function loopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => { resolvePort((address as { port: number }).port) })
    })
  })
}

/**
 * Start the server.
 * @returns the running server.
 */
export async function startTestSshd(): Promise<TestSshd> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-sshd-'))
  const keygen = (file: string) => execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file])
  keygen(join(directory, 'hostkey'))
  keygen(join(directory, 'identity'))
  const authorizedKeys = join(directory, 'authorized_keys')
  writeFileSync(authorizedKeys, readFileSync(join(directory, 'identity.pub')), { mode: 0o600 })
  const port = await loopbackPort()
  writeFileSync(join(directory, 'sshd_config'), [
    `Port ${String(port)}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'hostkey')}`, `PidFile ${join(directory, 'sshd.pid')}`,
    `AuthorizedKeysFile ${authorizedKeys}`, 'UsePAM no', 'PasswordAuthentication no', 'PubkeyAuthentication yes', 'StrictModes no',
    'AllowTcpForwarding yes', 'LogLevel ERROR', '',
  ].join('\n'))
  const child: ChildProcess = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', join(directory, 'sshd_config')], { stdio: 'ignore' })
  const deadline = Date.now() + 10_000
  for (;;) {
    const up = await new Promise<boolean>((resolveUp) => {
      const socket = connect({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolveUp(true) })
      socket.once('error', () => { resolveUp(false) })
    })
    if (up) break
    if (Date.now() > deadline) throw new Error('test sshd did not start')
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  const fingerprint = /(SHA256:\S+)/u.exec(execFileSync('ssh-keygen', ['-lf', join(directory, 'hostkey.pub')], { encoding: 'utf8' }))![1]!
  return {
    port, user: userInfo().username, directory, identity: join(directory, 'identity'), fingerprint, authorizedKeys,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((resolveStop) => { child.once('exit', () => { resolveStop() }); setTimeout(resolveStop, 3_000) })
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
