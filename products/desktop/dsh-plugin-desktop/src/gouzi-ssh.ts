/**
 * SSH access to a remote machine through the system OpenSSH client: host key pinning, one-time password login that
 * installs a dedicated key, command execution, and local port forwards.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Why an SSH operation failed, in the terms the user can act on. */
export type SshFailureCode = 'UNREACHABLE' | 'AUTH_FAILED' | 'HOST_KEY_CHANGED' | 'COMMAND_FAILED' | 'TIMEOUT'

/** An SSH operation failed. */
export class SshError extends Error {
  constructor(readonly code: SshFailureCode, message: string) {
    super(message)
    this.name = 'SshError'
  }
}

/** Binaries to run; a test substitutes recording stand-ins. */
export interface SshBinaries {
  readonly ssh: string
  readonly sshKeygen: string
  readonly sshKeyscan: string
  /** Tailscale CLI, relayed through for a host reached over Tailscale; empty looks for it in {@link TAILSCALE_CANDIDATES}. */
  readonly tailscale: string
}

/** The default OpenSSH client binaries. */
export const SYSTEM_SSH: SshBinaries = { ssh: 'ssh', sshKeygen: 'ssh-keygen', sshKeyscan: 'ssh-keyscan', tailscale: '' }

/** Where the Tailscale CLI is installed on macOS: Homebrew (Apple silicon, Intel), then the Tailscale app. */
export const TAILSCALE_CANDIDATES: readonly string[] = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
]

/** How a host is reached other than directly: relayed by the Tailscale CLI's `nc`. */
export interface SshRoute {
  readonly via: 'tailscale'
  /** Absolute path of the tailscaled socket; absent uses the CLI's default. */
  readonly socket?: string
}

/** A pinned remote machine and the dedicated key used to log in to it. */
export interface SshHostTarget {
  readonly address: string
  readonly port: number
  readonly user: string
  /** Private key file of the dedicated key pair. */
  readonly keyPath: string
  /** File holding the confirmed host key line. */
  readonly knownHostsPath: string
  /** Absent means a direct connection. */
  readonly route?: SshRoute
}

/** The host key a machine presented. */
export interface ScannedHostKey {
  readonly keyType: string
  readonly fingerprint: string
  /** The `known_hosts` line to pin. */
  readonly line: string
}

const KEY_PREFERENCE = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa']
const EXEC_TIMEOUT_MS = 60_000
/** A first connection over a Tailscale relay can take several seconds before the SSH banner arrives. */
const DIRECT_CONNECT_TIMEOUT_S = 10
const ROUTED_CONNECT_TIMEOUT_S = 25
const TUNNEL_READY_TIMEOUT_MS = 15_000

interface Finished {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
  readonly timedOut: boolean
}

/** Single-quote `value` for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly stdin?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs: number },
): Promise<Finished> {
  return new Promise((resolveRun, rejectRun) => {
    const child = execFile(command, [...args], {
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        rejectRun(new SshError('COMMAND_FAILED', `${command} is not installed on this machine`))
        return
      }
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null
      resolveRun({
        stdout,
        stderr,
        code: failure === null ? 0 : typeof failure.code === 'number' ? failure.code : null,
        timedOut: failure?.killed === true,
      })
    })
    // A command that exits without reading its input closes the pipe under the write. That EPIPE says only that the
    // input was not needed; the exit code and standard error already describe what the command did.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(options.stdin ?? '')
  })
}

function classify(stderr: string, fallback: string): SshError {
  const text = stderr.trim()
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/iu.test(text)) {
    return new SshError('HOST_KEY_CHANGED', '这台机器的主机密钥和你确认过的不一致，已拒绝连接')
  }
  if (/Permission denied|Authentication failed/iu.test(text)) return new SshError('AUTH_FAILED', '用户名或密码不对')
  if (/failed to connect to local tailscaled|Failed to connect to local Tailscale|tailscaled\.sock/iu.test(text)) {
    return new SshError('UNREACHABLE', 'Tailscale 没有运行，或者设置里的 socket 路径不对')
  }
  if (/Connection refused|timed out|No route to host|Could not resolve|Network is unreachable|Connection closed/iu.test(text)) {
    return new SshError('UNREACHABLE', `连不上这台机器：${text.split('\n').at(-1) ?? text}`)
  }
  return new SshError('COMMAND_FAILED', text.length > 0 ? text : fallback)
}

/**
 * Find the Tailscale CLI.
 * @param configured - the configured path, or empty to look in {@link TAILSCALE_CANDIDATES}.
 * @param exists - file test, replaced by tests.
 * @returns the path to run.
 * @throws SshError - when no CLI is found, naming every path that was tried.
 */
export function resolveTailscale(configured: string, exists: (path: string) => boolean = existsSync): string {
  const tried = configured === '' ? TAILSCALE_CANDIDATES : [configured]
  const found = tried.find(path => !path.includes('%') && exists(path))
  if (found === undefined) {
    throw new SshError('COMMAND_FAILED', `没有找到 Tailscale 命令行工具（试过：${tried.join('、')}）。请安装 Tailscale，或在 DSH 配置的 ssh.tailscale 里写明它的位置`)
  }
  return found
}

/**
 * The relay command ssh runs to open the connection. It is interpreted by a shell and ssh expands `%` tokens in
 * it, so the address and port are written in directly (never as `%h`/`%p`) and every part is quoted.
 */
function proxyCommand(binaries: SshBinaries, address: string, port: number, route: SshRoute): string {
  const socket = route.socket === undefined ? '' : ` --socket=${shellQuote(route.socket)}`
  return `${shellQuote(resolveTailscale(binaries.tailscale))}${socket} nc ${shellQuote(address)} ${String(port)}`
}

/**
 * Options that decide how the connection is made. A routed connection ignores the user's own ssh configuration, so
 * an alias there (for example a `HostKeyAlias` for the same address) cannot change which pinned key is looked up.
 */
function routeOptions(binaries: SshBinaries, address: string, port: number, route: SshRoute | undefined): string[] {
  if (route === undefined) return []
  return ['-F', '/dev/null', '-o', `ProxyCommand=${proxyCommand(binaries, address, port, route)}`]
}

/** Options shared by every connection to a pinned host. */
function pinnedOptions(binaries: SshBinaries, target: SshHostTarget): string[] {
  return [
    '-p', String(target.port),
    ...routeOptions(binaries, target.address, target.port, target.route),
    '-o', `UserKnownHostsFile=${target.knownHostsPath}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `ConnectTimeout=${String(target.route === undefined ? DIRECT_CONNECT_TIMEOUT_S : ROUTED_CONNECT_TIMEOUT_S)}`,
    '-o', 'LogLevel=ERROR',
  ]
}

function keyOptions(binaries: SshBinaries, target: SshHostTarget): string[] {
  return ['-i', target.keyPath, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', ...pinnedOptions(binaries, target)]
}

/**
 * Read the host key a machine presents, without logging in.
 * @param binaries - OpenSSH binaries.
 * @param address - host name or IP address.
 * @param port - SSH port.
 * @returns the preferred key with its fingerprint.
 * @throws SshError - when the machine is unreachable or presents no key.
 */
export async function scanHostKey(binaries: SshBinaries, address: string, port: number, route?: SshRoute): Promise<ScannedHostKey> {
  const { lines, stderr } = route === undefined ? await keyscanLines(binaries, address, port) : await relayedScanLines(binaries, address, port, route)
  const keys = lines.map(line => ({ line, type: line.split(' ')[1] ?? '' }))
  const chosen = KEY_PREFERENCE.map(type => keys.find(key => key.type === type)).find(key => key !== undefined)
  if (chosen === undefined) {
    const failure = stderr.trim().length > 0 ? classify(stderr, '') : undefined
    if (failure !== undefined && failure.code === 'UNREACHABLE') throw failure
    throw new SshError('UNREACHABLE', `连不上 ${address}:${String(port)}${route === undefined ? '' : '（经 Tailscale）'}，或者它没有开启 SSH（远程登录）`)
  }
  return { keyType: chosen.type, fingerprint: await fingerprintOf(binaries, chosen.line), line: chosen.line }
}

async function keyscanLines(binaries: SshBinaries, address: string, port: number): Promise<{ lines: string[]; stderr: string }> {
  const scan = await run(binaries.sshKeyscan, ['-T', '10', '-p', String(port), '--', address], { timeoutMs: 20_000 })
  return { lines: scan.stdout.split('\n').filter(line => line.length > 0 && !line.startsWith('#')), stderr: scan.stderr }
}

/**
 * `ssh-keyscan` cannot use a relay, so the key is read by letting ssh itself reach the key exchange and record the
 * key it was shown in a scratch file; the login then fails, which is expected. The recorded line is named the way
 * later connections with the same address, port, and options look it up.
 */
async function relayedScanLines(binaries: SshBinaries, address: string, port: number, route: SshRoute): Promise<{ lines: string[]; stderr: string }> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-gouzi-scan-'))
  const file = join(directory, 'known_hosts')
  try {
    const scan = await run(binaries.ssh, [
      '-p', String(port),
      ...routeOptions(binaries, address, port, route),
      '-o', `UserKnownHostsFile=${file}`,
      '-o', 'GlobalKnownHostsFile=/dev/null',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'HashKnownHosts=no',
      '-o', 'BatchMode=yes',
      '-o', 'PreferredAuthentications=none',
      '-o', `ConnectTimeout=${String(ROUTED_CONNECT_TIMEOUT_S)}`,
      '-o', 'LogLevel=ERROR',
      `dsh-gouzi-scan@${address}`,
      'true',
    ], { timeoutMs: 40_000 })
    // The file exists only when ssh got as far as the key exchange.
    const recorded = existsSync(file) ? readFileSync(file, 'utf8') : ''
    return { lines: recorded.split('\n').filter(line => line.length > 0 && !line.startsWith('#')), stderr: scan.stderr }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function fingerprintOf(binaries: SshBinaries, line: string): Promise<string> {
  const printed = await run(binaries.sshKeygen, ['-lf', '-'], { stdin: `${line}\n`, timeoutMs: 10_000 })
  const fingerprint = /\b(SHA256:[A-Za-z0-9+/]+={0,2})/u.exec(printed.stdout)?.[1]
  if (fingerprint === undefined) throw new SshError('COMMAND_FAILED', 'could not compute the host key fingerprint')
  return fingerprint
}

/**
 * The fingerprint of the key pinned for a host.
 * @param binaries - OpenSSH binaries.
 * @param knownHostsPath - file holding the pinned line.
 * @returns the `SHA256:` fingerprint.
 * @throws SshError - when the file holds no key.
 */
export async function pinnedFingerprint(binaries: SshBinaries, knownHostsPath: string): Promise<string> {
  const line = readFileSync(knownHostsPath, 'utf8').split('\n').find(value => value.length > 0 && !value.startsWith('#'))
  if (line === undefined) throw new SshError('COMMAND_FAILED', 'no host key is pinned for this host')
  return fingerprintOf(binaries, line)
}

/**
 * Create a passphrase-less key pair for one host.
 * @param binaries - OpenSSH binaries.
 * @param keyPath - where the private key goes; the public key is written next to it with a `.pub` suffix.
 * @returns the public key line.
 */
export async function generateKeyPair(binaries: SshBinaries, keyPath: string): Promise<string> {
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 })
  const made = await run(binaries.sshKeygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'dsh-gouzi', '-f', keyPath], { timeoutMs: 20_000 })
  if (made.code !== 0) throw new SshError('COMMAND_FAILED', made.stderr.trim() || 'ssh-keygen failed')
  chmodSync(keyPath, 0o600)
  const read = await run(binaries.sshKeygen, ['-y', '-f', keyPath], { timeoutMs: 10_000 })
  return read.stdout.trim()
}

/**
 * Log in once with a password and append `publicKey` to the remote `authorized_keys`. The password reaches the
 * client through a temporary askpass script that reads it from the child's environment; it is never written to a
 * file, a command line, or a log.
 * @param binaries - OpenSSH binaries.
 * @param target - machine whose host key is already pinned.
 * @param password - login password, used for this call only.
 * @param publicKey - public key line to authorize.
 * @throws SshError - when the login fails or the remote shell refuses the install.
 */
export async function installKey(binaries: SshBinaries, target: SshHostTarget, password: string, publicKey: string): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-gouzi-askpass-'))
  const askpass = join(directory, 'askpass.sh')
  try {
    writeFileSync(askpass, '#!/bin/sh\nprintf %s "$DSH_GOUZI_SSH_PASSWORD"\n', { mode: 0o700 })
    const script = [
      'umask 077',
      'mkdir -p "$HOME/.ssh"',
      'chmod 700 "$HOME/.ssh"',
      'touch "$HOME/.ssh/authorized_keys"',
      'chmod 600 "$HOME/.ssh/authorized_keys"',
      'IFS= read -r key',
      'grep -qxF -- "$key" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$key" >> "$HOME/.ssh/authorized_keys"',
    ].join(' && ')
    const finished = await run(binaries.ssh, [
      ...pinnedOptions(binaries, target),
      '-o', 'PubkeyAuthentication=no',
      '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'NumberOfPasswordPrompts=1',
      `${target.user}@${target.address}`,
      script,
    ], {
      stdin: `${publicKey}\n`,
      timeoutMs: EXEC_TIMEOUT_MS,
      env: {
        ...process.env,
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: process.env.DISPLAY ?? 'dsh-gouzi:0',
        DSH_GOUZI_SSH_PASSWORD: password,
      },
    })
    if (finished.timedOut) throw new SshError('TIMEOUT', '登录超时')
    if (finished.code !== 0) throw classify(finished.stderr, 'could not install the key')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * Remove `publicKey` from the remote `authorized_keys`, logging in with the key itself.
 * @param binaries - OpenSSH binaries.
 * @param target - pinned host.
 * @param publicKey - public key line to remove.
 * @throws SshError - when the login or the command fails.
 */
export async function revokeKey(binaries: SshBinaries, target: SshHostTarget, publicKey: string): Promise<void> {
  const script = [
    'IFS= read -r key',
    'file="$HOME/.ssh/authorized_keys"',
    '[ -f "$file" ] || exit 0',
    'grep -vxF -- "$key" "$file" > "$file.dsh-gouzi" || true',
    'chmod 600 "$file.dsh-gouzi"',
    'mv "$file.dsh-gouzi" "$file"',
  ].join('; ')
  await sshExec(binaries, target, script, { stdin: `${publicKey}\n` })
}

/**
 * Run a command on the remote machine with the dedicated key.
 * @param binaries - OpenSSH binaries.
 * @param target - pinned host.
 * @param command - remote shell command line.
 * @param options - optional standard input and time limit.
 * @returns the command's standard output.
 * @throws SshError - when the connection or the command fails.
 */
export async function sshExec(
  binaries: SshBinaries,
  target: SshHostTarget,
  command: string,
  options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<string> {
  const finished = await run(binaries.ssh, [...keyOptions(binaries, target), `${target.user}@${target.address}`, command], {
    stdin: options.stdin ?? '',
    timeoutMs: options.timeoutMs ?? EXEC_TIMEOUT_MS,
  })
  if (finished.timedOut) throw new SshError('TIMEOUT', '远程命令超时')
  if (finished.code !== 0) throw classify(finished.stderr, `remote command exited with ${String(finished.code)}`)
  return finished.stdout
}

/**
 * Pick a free loopback port.
 * @returns a port nothing listens on at the moment of the call.
 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address === null || typeof address === 'string') rejectPort(new Error('no loopback port'))
        else resolvePort(address.port)
      })
    })
  })
}

/** Whether nothing holds `port` on loopback right now. */
export function loopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const server = createServer()
    server.once('error', () => { resolveFree(false) })
    server.listen(port, '127.0.0.1', () => { server.close(() => { resolveFree(true) }) })
  })
}

function accepts(port: number): Promise<boolean> {
  return new Promise((resolveAccept) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.once('connect', () => { socket.destroy(); resolveAccept(true) })
    socket.once('error', () => { resolveAccept(false) })
  })
}

/** A running local port forward. */
export interface SshTunnel {
  readonly localPort: number
  /** Settles when the forward ends, for any reason. */
  readonly closed: Promise<void>
  close(): void
}

/**
 * Forward a loopback port on this machine to a loopback port on the remote machine.
 * @param binaries - OpenSSH binaries.
 * @param target - pinned host.
 * @param localPort - port to listen on here.
 * @param remotePort - port the member listens on there.
 * @returns the tunnel once the local port accepts connections.
 * @throws SshError - when the forward does not come up.
 */
export async function openTunnel(binaries: SshBinaries, target: SshHostTarget, localPort: number, remotePort: number): Promise<SshTunnel> {
  // Without this check a listener that is already there would pass for the forward coming up.
  if (!await loopbackPortFree(localPort)) throw new SshError('COMMAND_FAILED', `本地端口 ${String(localPort)} 已被占用`)
  const child: ChildProcess = spawn(binaries.ssh, [
    ...keyOptions(binaries, target),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${String(localPort)}:127.0.0.1:${String(remotePort)}`,
    `${target.user}@${target.address}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const closed = new Promise<void>((resolveClosed) => { child.once('exit', () => { resolveClosed() }) })
  const deadline = Date.now() + TUNNEL_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw classify(stderr, 'the tunnel exited before it was ready')
    if (await accepts(localPort)) {
      return { localPort, closed, close: () => { child.kill('SIGTERM') } }
    }
    await new Promise<void>((resolveWait) => { setTimeout(resolveWait, 100) })
  }
  child.kill('SIGTERM')
  throw new SshError('TIMEOUT', '隧道没有在预期时间内建立')
}
