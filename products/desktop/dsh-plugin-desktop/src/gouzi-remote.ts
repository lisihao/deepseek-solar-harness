/**
 * Gouzi hosts reached over SSH. A host is a machine with DSH Desktop installed; members run there as detached
 * processes managed through the remote agent, and the main instance reaches each one through a local port forward.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  GouziFolderListing,
  GouziHostInspection,
  GouziHostProjection,
  GouziProcessInfo,
  GouziProjectSource,
  GouziProvisionInput,
  GouziSshTarget,
} from '@deepseek-ai/dsh-ui-gouzi'
import { GOUZI_AGENT_PROTOCOL, GOUZI_AGENT_RESULT_PREFIX, type GouziAgentProbe, type GouziAgentResult } from './gouzi-agent.ts'
import {
  freeLoopbackPort,
  generateKeyPair,
  installKey,
  loopbackPortFree,
  openTunnel,
  revokeKey,
  scanHostKey,
  shellQuote,
  SshError,
  sshExec,
  type SshBinaries,
  type SshHostTarget,
  type SshTunnel,
} from './gouzi-ssh.ts'

/** Where DSH Desktop is installed on a macOS host. */
export const DEFAULT_REMOTE_APP = '/Applications/DSH Desktop.app'

/** Oldest DSH Desktop that ships the remote agent. */
export const REMOTE_AGENT_MINIMUM_VERSION = '3.36.0'

/** Pause before the first reconnect of a dropped forward, and the longest pause between attempts. */
const RECONNECT_FIRST_MS = 2_000
const RECONNECT_LONGEST_MS = 30_000
const CATALOG_FILE = 'hosts.json'

/** One SSH host as stored. */
interface StoredHost {
  readonly hostId: string
  readonly label: string
  readonly address: string
  readonly port: number
  readonly user: string
  readonly appVersion: string
  readonly addedAt: string
}

/** One member forward as stored, so it can be restored when the main instance restarts. */
interface StoredForward {
  readonly hostId: string
  readonly localPort: number
  readonly remotePort: number
}

interface Catalog {
  readonly version: 1
  readonly hosts: readonly StoredHost[]
  readonly forwards: Readonly<Record<string, StoredForward>>
}

/** Settings of the SSH hosts. */
export interface RemoteGouziOptions {
  /** Directory holding the catalog, the dedicated keys, and the pinned host keys. */
  readonly root: string
  readonly binaries: SshBinaries
  /** DSH Desktop location on the remote machine. */
  readonly remoteApp?: string
  /** Pause before the first reconnect, in milliseconds. */
  readonly reconnectMs?: number
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(part => Number.parseInt(part, 10))
  const b = right.split('.').map(part => Number.parseInt(part, 10))
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => { setTimeout(resolveSleep, milliseconds) })
}

/** The set of SSH hosts and the forwards to their members. */
export class RemoteGouziHosts {
  private catalog: Catalog
  private readonly tunnels = new Map<string, { tunnel?: SshTunnel; stopped: boolean }>()

  constructor(private readonly options: RemoteGouziOptions) {
    this.catalog = this.read()
  }

  private get app(): string {
    return this.options.remoteApp ?? DEFAULT_REMOTE_APP
  }

  private read(): Catalog {
    try {
      return JSON.parse(readFileSync(join(this.options.root, CATALOG_FILE), 'utf8')) as Catalog
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, hosts: [], forwards: {} }
      throw error
    }
  }

  private save(next: Catalog): void {
    mkdirSync(this.options.root, { recursive: true, mode: 0o700 })
    const file = join(this.options.root, CATALOG_FILE)
    writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    this.catalog = next
  }

  private host(hostId: string): StoredHost {
    const host = this.catalog.hosts.find(value => value.hostId === hostId)
    if (host === undefined) throw new Error(`unknown host ${hostId}`)
    return host
  }

  private target(host: StoredHost): SshHostTarget {
    const directory = join(this.options.root, host.hostId)
    return {
      address: host.address,
      port: host.port,
      user: host.user,
      keyPath: join(directory, 'id_ed25519'),
      knownHostsPath: join(directory, 'known_hosts'),
    }
  }

  /**
   * Run one agent operation on a host.
   * @param host - target host.
   * @param operation - operation and flags, already quoted for a shell.
   * @param stdin - request body.
   * @returns the operation's result value.
   * @throws Error - with the agent's own explanation when it reports a failure.
   */
  private async agent(host: StoredHost, operation: string, stdin = ''): Promise<unknown> {
    const script = `${this.app}/Contents/Resources/app.asar.unpacked/lib/gouzi-agent-bin.js`
    const command = `ELECTRON_RUN_AS_NODE=1 ${shellQuote(`${this.app}/Contents/MacOS/DSH Desktop`)} ${shellQuote(script)} ${operation}`
    const output = await sshExec(this.options.binaries, this.target(host), `/bin/sh -c ${shellQuote(command)}`, { stdin })
    const line = output.split('\n').find(value => value.startsWith(GOUZI_AGENT_RESULT_PREFIX))
    if (line === undefined) throw new Error(`${host.label} 上的 DSH Desktop 没有给出结果：${output.trim().slice(0, 200)}`)
    const result = JSON.parse(line.slice(GOUZI_AGENT_RESULT_PREFIX.length)) as GouziAgentResult
    if (!result.ok) throw Object.assign(new Error(result.message), result.code === undefined ? {} : { code: result.code })
    return result.value
  }

  /** @returns the stored SSH hosts. */
  list(): GouziHostProjection[] {
    return this.catalog.hosts.map(host => ({
      hostId: host.hostId,
      label: host.label,
      kind: 'ssh',
      address: `${host.user}@${host.address}:${String(host.port)}`,
      appVersion: host.appVersion,
    }))
  }

  /**
   * Read the key a machine presents.
   * @param target - machine and login.
   * @returns key type and fingerprint.
   */
  async inspect(target: GouziSshTarget): Promise<GouziHostInspection> {
    const key = await scanHostKey(this.options.binaries, target.address, target.port)
    return { keyType: key.keyType, fingerprint: key.fingerprint }
  }

  /**
   * Trust a machine, install a dedicated key with the password, and check the remote DSH Desktop.
   * @param input - machine, login, password, and the fingerprint the user confirmed.
   * @returns the stored host.
   */
  async add(input: GouziSshTarget & { readonly password: string; readonly fingerprint: string; readonly label?: string }): Promise<GouziHostProjection> {
    const key = await scanHostKey(this.options.binaries, input.address, input.port)
    if (key.fingerprint !== input.fingerprint) {
      throw new SshError('HOST_KEY_CHANGED', '这台机器的主机密钥和你确认过的不一致，已拒绝连接')
    }
    const hostId = `ssh-${randomUUID().slice(0, 8)}`
    const directory = join(this.options.root, hostId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const pinned: StoredHost = {
      hostId,
      label: input.label ?? input.address,
      address: input.address,
      port: input.port,
      user: input.user,
      appVersion: '',
      addedAt: new Date().toISOString(),
    }
    const target = this.target(pinned)
    let installed: string | undefined
    try {
      writeFileSync(target.knownHostsPath, `${key.line}\n`, { mode: 0o600 })
      const publicKey = await generateKeyPair(this.options.binaries, target.keyPath)
      await installKey(this.options.binaries, target, input.password, publicKey)
      installed = publicKey
      const probe = await this.probe(pinned)
      const stored: StoredHost = { ...pinned, appVersion: probe.appVersion }
      this.save({ ...this.catalog, hosts: [...this.catalog.hosts, stored] })
      return this.list().find(value => value.hostId === hostId)!
    } catch (error) {
      // The key was installed but the machine is not usable; take it back out before the private half is deleted.
      if (installed !== undefined) await revokeKey(this.options.binaries, target, installed).catch(() => undefined)
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
  }

  private async probe(host: StoredHost): Promise<GouziAgentProbe> {
    let value: unknown
    try {
      value = await this.agent(host, 'probe')
    } catch (error) {
      // A failed command means the app or the agent is not there; any other failure is about the connection.
      if (error instanceof SshError && error.code !== 'COMMAND_FAILED') throw error
      throw new Error(
        `${host.label} 上没有可用的 DSH Desktop（需要 ${REMOTE_AGENT_MINIMUM_VERSION} 或更新，安装在 ${this.app}）`,
        { cause: error },
      )
    }
    const probe = value as GouziAgentProbe
    if (probe.protocol !== GOUZI_AGENT_PROTOCOL) {
      throw new Error(`${host.label} 上的 DSH Desktop ${probe.appVersion} 使用了不同版本的狗子协议，请把两边升级到同一个版本`)
    }
    if (compareVersions(probe.appVersion, REMOTE_AGENT_MINIMUM_VERSION) < 0) {
      throw new Error(`${host.label} 上的 DSH Desktop ${probe.appVersion} 太旧，需要 ${REMOTE_AGENT_MINIMUM_VERSION} 或更新`)
    }
    return probe
  }

  /**
   * Forget a host. Its dedicated key is removed from the remote machine when the machine answers; when it does not,
   * the key stays authorized there but is useless, because the private half is deleted here.
   * @param hostId - host id.
   */
  async remove(hostId: string): Promise<void> {
    const host = this.host(hostId)
    for (const [gouziId, forward] of Object.entries(this.catalog.forwards)) if (forward.hostId === hostId) this.closeForward(gouziId)
    const target = this.target(host)
    const publicKey = readFileSync(`${target.keyPath}.pub`, 'utf8').trim()
    await revokeKey(this.options.binaries, target, publicKey).catch(() => undefined)
    rmSync(join(this.options.root, hostId), { recursive: true, force: true })
    this.save({ ...this.catalog, hosts: this.catalog.hosts.filter(value => value.hostId !== hostId) })
  }

  /**
   * List directories on a host.
   * @param hostId - host id.
   * @param path - absolute directory, or the login home when absent.
   * @returns the directory and its subdirectories.
   */
  async browse(hostId: string, path?: string): Promise<GouziFolderListing> {
    return await this.agent(this.host(hostId), `browse${path === undefined ? '' : ` --path ${shellQuote(path)}`}`) as GouziFolderListing
  }

  /**
   * Inspect a selected directory on a host without initializing Git.
   * @param hostId - host id.
   * @param path - absolute path on that host.
   * @returns the stable project identity, selected realpath, and optional origin identity.
   */
  async resolveRepository(hostId: string, path: string) {
    return await this.agent(this.host(hostId), `resolve --path ${shellQuote(path)}`) as GouziProjectSource
  }

  /**
   * Initialize Git in a selected ordinary directory after adoption is confirmed.
   * @param hostId - host id.
   * @param path - selected directory on that host.
   * @returns the prepared project identity and selected source directory.
   */
  async prepareRepository(hostId: string, path: string): Promise<GouziProjectSource> {
    return await this.agent(this.host(hostId), `prepare --path ${shellQuote(path)}`) as GouziProjectSource
  }

  /**
   * Create a member's home on a host.
   * @param input - identity and allowlist.
   */
  async provision(input: GouziProvisionInput): Promise<void> {
    await this.agent(this.host(input.hostId), 'provision', JSON.stringify(input))
  }

  /**
   * Start a member on a host and forward a local port to it.
   * @param hostId - host id.
   * @param gouziId - member identity.
   * @returns the local endpoint and the remote process facts.
   */
  async start(hostId: string, gouziId: string): Promise<GouziProcessInfo> {
    const host = this.host(hostId)
    const started = await this.agent(host, `start --id ${shellQuote(gouziId)}`) as { port: number; pid: number; incarnation: number }
    const previous = this.catalog.forwards[gouziId]
    this.closeForward(gouziId, { keepRecord: true })
    // The stored port is kept so the endpoint on the main instance stays valid, unless something else took it.
    const localPort = previous !== undefined && await loopbackPortFree(previous.localPort) ? previous.localPort : await freeLoopbackPort()
    this.save({ ...this.catalog, forwards: { ...this.catalog.forwards, [gouziId]: { hostId, localPort, remotePort: started.port } } })
    try {
      await this.openForward(gouziId)
    } catch (error) {
      this.closeForward(gouziId)
      throw error
    }
    return { endpoint: `http://127.0.0.1:${String(localPort)}/`, pid: started.pid, incarnation: started.incarnation }
  }

  /**
   * Stop a member on a host and drop its forward.
   * @param hostId - host id.
   * @param gouziId - member identity.
   * @param options - `reclaimResident` also stops the Resident daemon of the member.
   * @returns whether no process of the member remains.
   */
  async stop(hostId: string, gouziId: string, options: { readonly reclaimResident?: boolean } = {}) {
    const host = this.host(hostId)
    const stopped = await this.agent(host, `stop --id ${shellQuote(gouziId)}${options.reclaimResident === true ? ' --reclaim' : ''}`) as {
      processTreeStopped: boolean
    }
    this.closeForward(gouziId)
    return stopped
  }

  /** Reopen the forward of every stored member, for the start of a main instance. */
  restore(): void {
    for (const gouziId of Object.keys(this.catalog.forwards)) {
      void this.openForward(gouziId).catch(() => undefined)
    }
  }

  /** Close every forward without forgetting it, for the shutdown of a main instance. */
  dispose(): void {
    for (const gouziId of [...this.tunnels.keys()]) this.closeForward(gouziId, { keepRecord: true })
  }

  /**
   * Open a member's forward and keep it open: when it drops, reopen it with the same local port, so the endpoint
   * stored on the main instance stays valid.
   * @param gouziId - member identity.
   */
  private async openForward(gouziId: string): Promise<void> {
    const forward = this.catalog.forwards[gouziId]
    if (forward === undefined) return
    const host = this.host(forward.hostId)
    const target = this.target(host)
    const state: { tunnel?: SshTunnel; stopped: boolean } = { stopped: false }
    this.tunnels.set(gouziId, state)
    state.tunnel = await openTunnel(this.options.binaries, target, forward.localPort, forward.remotePort)
    void (async () => {
      let pause = this.options.reconnectMs ?? RECONNECT_FIRST_MS
      for (;;) {
        await state.tunnel?.closed
        while (!state.stopped) {
          await sleep(pause)
          if (state.stopped) return
          try {
            state.tunnel = await openTunnel(this.options.binaries, target, forward.localPort, forward.remotePort)
            pause = this.options.reconnectMs ?? RECONNECT_FIRST_MS
            break
          } catch {
            // The machine may be asleep or offline; the next attempt follows after a longer pause.
            pause = Math.min(pause * 2, RECONNECT_LONGEST_MS)
          }
        }
        if (state.stopped) return
      }
    })()
  }

  private closeForward(gouziId: string, options: { readonly keepRecord?: boolean } = {}): void {
    const state = this.tunnels.get(gouziId)
    if (state !== undefined) {
      state.stopped = true
      state.tunnel?.close()
      this.tunnels.delete(gouziId)
    }
    if (options.keepRecord !== true && this.catalog.forwards[gouziId] !== undefined) {
      this.save({ ...this.catalog, forwards: Object.fromEntries(Object.entries(this.catalog.forwards).filter(([id]) => id !== gouziId)) })
    }
  }
}
