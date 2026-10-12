/** An unprivileged OpenSSH server on loopback for tests: key login only, as the user running the tests. */

import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // OpenSSH 9.8 and later refuse a source address for a while after failed logins, which would turn the
  // deliberate wrong-password tests into connection failures for the tests that follow.
  // `ssh -V` prints its version on standard error.
  const version = /OpenSSH_(\d+)\.(\d+)/u.exec(spawnSync('ssh', ['-V'], { encoding: 'utf8' }).stderr)
  const penalties = version !== null && Number(version[1]) * 100 + Number(version[2]) >= 908 ? ['PerSourcePenalties no'] : []
  writeFileSync(join(directory, 'sshd_config'), [
    `Port ${String(port)}`, 'ListenAddress 127.0.0.1', `HostKey ${join(directory, 'hostkey')}`, `PidFile ${join(directory, 'sshd.pid')}`,
    `AuthorizedKeysFile ${authorizedKeys}`, 'UsePAM no', 'PasswordAuthentication no', 'PubkeyAuthentication yes', 'StrictModes no',
    'AllowTcpForwarding yes', 'LogLevel ERROR', ...penalties, '',
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

/**
 * `ssh` stand-in for password mode. The real client asks the askpass program for the password; this wrapper does
 * the same, accepts only the expected one, and then logs in with the authorized test identity, with HOME moved
 * into the scratch directory so the remote install script never touches the real `~/.ssh`.
 */
export function passwordSsh(directory: string, expected: string, server: TestSshd): string {
  // One script per expected password, so two stand-ins in one directory do not overwrite each other.
  const script = join(directory, `fake-ssh-${createHash('sha256').update(expected).digest('hex').slice(0, 8)}.sh`)
  writeFileSync(script, [
    '#!/bin/bash',
    'if [ -n "$SSH_ASKPASS" ]; then',
    '  given=$("$SSH_ASKPASS")',
    `  if [ "$given" != '${expected}' ]; then echo "Permission denied (publickey,password)." >&2; exit 255; fi`,
    'fi',
    'args=(); prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "-o" ]; then',
    '    case "$a" in PubkeyAuthentication=no|PreferredAuthentications=*|NumberOfPasswordPrompts=*)',
    '      args=("${args[@]:0:${#args[@]}-1}"); prev=""; continue;; esac',
    '  fi',
    '  args+=("$a"); prev="$a"',
    'done',
    '# Remote commands run with HOME in the scratch directory, so nothing here touches the real ~/.ssh;',
    '# a port forward (-N) has no remote command.',
    'case " $* " in *" -N "*) ;; *)',
    '  last="${args[${#args[@]}-1]}"',
    `  args[\${#args[@]}-1]="export HOME='${directory}/home'; $last";; esac`,
    `exec ssh -i '${server.identity}' -o IdentitiesOnly=yes -o BatchMode=yes "\${args[@]}"`,
    '',
  ].join('\n'))
  chmodSync(script, 0o700)
  return script
}
