/** Desktop-owned background handoff for complete, balanced Session replicas. */

import { mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  parseRemoteSessionReplicaDocument,
  parseRemoteSessionReplicaApplyResult,
  parseRemoteSessionReplicaList,
  type RemoteSessionReplicaDocument,
  type RemoteSessionReplicaApplyResult,
  type RemoteSessionReplicaSummary,
} from '@deepseek-ai/dsh-client-connection'
import { RpcId, serverResponseSchema, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'

export type DesktopSessionSyncDirection = 'pull' | 'push' | 'bidirectional'

export interface DesktopSessionSyncConfigureRequest {
  readonly enabled: boolean
  readonly intervalMinutes: number
  readonly direction: DesktopSessionSyncDirection
}

export interface DesktopSessionSyncResult {
  readonly direction: 'pull' | 'push' | 'import'
  readonly status: 'ok' | 'warn' | 'error'
  readonly sessionId?: string
  readonly message: string
}

export interface DesktopSessionSyncSnapshot extends DesktopSessionSyncConfigureRequest {
  readonly version: 1
  readonly running: boolean
  readonly lastRunAt?: string
  readonly results: readonly DesktopSessionSyncResult[]
}

export interface DesktopRemoteReplicaClient {
  replicaList(signal?: AbortSignal): Promise<RemoteSessionReplicaSummary[]>
  replicaRead(sessionId: string, signal?: AbortSignal): Promise<RemoteSessionReplicaDocument>
  replicaApply(
    replica: Pick<RemoteSessionReplicaDocument, 'meta' | 'events'>,
    signal?: AbortSignal,
  ): Promise<RemoteSessionReplicaApplyResult>
}
type DesktopLocalReplicaStore = Pick<SessionPersistence, 'listSnapshots' | 'load' | 'replicate'>

export interface DesktopSessionSyncRemote {
  readonly serverId: string
  readonly client: DesktopRemoteReplicaClient
}

export interface DesktopSessionSyncBindings {
  remote(): Promise<DesktopSessionSyncRemote | undefined>
  local(): DesktopLocalReplicaStore | undefined
  onError?(cause: unknown): void
}

/** Electron-main transport for the authenticated Session replica RPC subset. */
export class DesktopRemoteSessionClient implements DesktopRemoteReplicaClient {
  private readonly base: URL

  constructor(
    endpoint: string | URL,
    private readonly accessToken: string | undefined,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    this.base = new URL(endpoint)
  }

  async replicaList(signal?: AbortSignal): Promise<RemoteSessionReplicaSummary[]> {
    return parseRemoteSessionReplicaList(await this.call('replica.list', {}, signal))
  }

  async replicaRead(sessionId: string, signal?: AbortSignal): Promise<RemoteSessionReplicaDocument> {
    return parseRemoteSessionReplicaDocument(await this.call('replica.read', { sessionId }, signal))
  }

  async replicaApply(
    replica: Pick<RemoteSessionReplicaDocument, 'meta' | 'events'>,
    signal?: AbortSignal,
  ): Promise<RemoteSessionReplicaApplyResult> {
    return parseRemoteSessionReplicaApplyResult(await this.call('replica.apply', replica, signal))
  }

  private async call(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const rpcId = RpcId(crypto.randomUUID())
    const request: ClientRequest = { type: 'client-request', rpcId, method, payload }
    const response = await this.request(new URL(`/remote-sync/${method}`, this.base), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.accessToken === undefined ? {} : { authorization: `Bearer ${this.accessToken}` },
      },
      body: JSON.stringify(request),
      ...signal === undefined ? {} : { signal },
    })
    if (!response.ok) throw new Error(`remote Session sync ${method} failed: HTTP ${String(response.status)}`)
    const envelope = serverResponseSchema.parse(await response.json())
    if (envelope.rpcId !== rpcId) throw new Error(`remote Session sync ${method} rpcId mismatch`)
    if (!envelope.result.ok) throw new Error(`remote Session sync ${method}: ${envelope.result.error.message}`)
    return envelope.result.value
  }
}

interface DesktopSessionSyncState extends DesktopSessionSyncConfigureRequest {
  readonly version: 1
  readonly pullRevisions: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly pushRevisions: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly lastRunAt?: string
  readonly results: readonly DesktopSessionSyncResult[]
}

const DEFAULT_STATE: DesktopSessionSyncState = {
  version: 1,
  enabled: false,
  intervalMinutes: 10,
  direction: 'pull',
  pullRevisions: {},
  pushRevisions: {},
  results: [],
}

/** Periodic, revision-aware Session handoff without a second active writer. */
export class DesktopSessionSyncController {
  private readonly statePath: string
  private readonly inboxPath: string
  private state: DesktopSessionSyncState = DEFAULT_STATE
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<DesktopSessionSyncSnapshot> | undefined
  private stopped = false

  constructor(userDataPath: string, private readonly bindings: DesktopSessionSyncBindings) {
    const root = join(userDataPath, 'session-sync')
    this.statePath = join(root, 'state.json')
    this.inboxPath = join(root, 'inbox')
  }

  async start(): Promise<void> {
    this.state = await this.load()
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  snapshot(): DesktopSessionSyncSnapshot {
    return {
      version: 1,
      enabled: this.state.enabled,
      intervalMinutes: this.state.intervalMinutes,
      direction: this.state.direction,
      running: this.running !== undefined,
      ...this.state.lastRunAt === undefined ? {} : { lastRunAt: this.state.lastRunAt },
      results: this.state.results,
    }
  }

  async configure(value: DesktopSessionSyncConfigureRequest): Promise<DesktopSessionSyncSnapshot> {
    const config = parseConfigureRequest(value)
    this.state = { ...this.state, ...config }
    await this.persist()
    this.schedule()
    return this.snapshot()
  }

  runNow(): Promise<DesktopSessionSyncSnapshot> {
    if (this.running !== undefined) return this.running
    const operation = this.run().finally(() => {
      if (this.running === operation) this.running = undefined
      this.schedule()
    })
    this.running = operation
    return operation
  }

  /** Import replicas staged while Desktop was a thin Frontend. */
  async importInbox(): Promise<DesktopSessionSyncResult[]> {
    const local = this.bindings.local()
    if (local === undefined) return []
    let names: string[]
    try {
      names = await readdir(this.inboxPath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw cause
    }
    const results: DesktopSessionSyncResult[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const path = join(this.inboxPath, name)
      try {
        const replica = parseRemoteSessionReplicaDocument(JSON.parse(await readFile(path, 'utf8')))
        const applied = await local.replicate(replica)
        await unlink(path)
        results.push({
          direction: 'import',
          status: 'ok',
          sessionId: String(replica.meta.id),
          message: `本地 ${applied.state}，新增 ${String(applied.appendedEventCount)} 个事件`,
        })
      } catch (cause) {
        results.push({
          direction: 'import',
          status: 'error',
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    return results
  }

  private async run(): Promise<DesktopSessionSyncSnapshot> {
    const results = await this.importInbox()
    try {
      const remote = await this.bindings.remote()
      if (remote === undefined) {
        results.push({ direction: 'pull', status: 'warn', message: '尚未选择可同步的远端 Server' })
      } else {
        if (this.state.direction !== 'push') results.push(...await this.pull(remote))
        if (this.state.direction !== 'pull') results.push(...await this.push(remote))
      }
    } catch (cause) {
      results.push({
        direction: this.state.direction === 'push' ? 'push' : 'pull',
        status: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
    this.state = {
      ...this.state,
      lastRunAt: new Date().toISOString(),
      results: results.slice(-100),
    }
    await this.persist()
    return this.snapshot()
  }

  private async pull(remote: DesktopSessionSyncRemote): Promise<DesktopSessionSyncResult[]> {
    const results: DesktopSessionSyncResult[] = []
    const revisions = { ...(this.state.pullRevisions[remote.serverId] ?? {}) }
    const local = this.bindings.local()
    for (const summary of await remote.client.replicaList()) {
      const sessionId = String(summary.header.id)
      if (revisions[sessionId] === summary.revision) continue
      try {
        const replica = await remote.client.replicaRead(sessionId)
        if (local === undefined) {
          await this.stage(remote.serverId, replica)
          results.push({ direction: 'pull', status: 'ok', sessionId, message: '已暂存，切到本机 Server 后导入' })
        } else {
          const applied = await local.replicate(replica)
          results.push({
            direction: 'pull', status: 'ok', sessionId,
            message: `本地 ${applied.state}，新增 ${String(applied.appendedEventCount)} 个事件`,
          })
        }
        revisions[sessionId] = summary.revision
      } catch (cause) {
        results.push({
          direction: 'pull', status: 'warn', sessionId,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    this.state = {
      ...this.state,
      pullRevisions: { ...this.state.pullRevisions, [remote.serverId]: revisions },
    }
    return results
  }

  private async push(remote: DesktopSessionSyncRemote): Promise<DesktopSessionSyncResult[]> {
    const local = this.bindings.local()
    if (local === undefined) {
      return [{
        direction: 'push', status: 'warn',
        message: 'Frontend 不启动本机持久库；切到本机 Server 后才能向远端推送',
      }]
    }
    const results: DesktopSessionSyncResult[] = []
    const revisions = { ...(this.state.pushRevisions[remote.serverId] ?? {}) }
    for (const snapshot of await local.listSnapshots()) {
      const sessionId = String(snapshot.header.id)
      const revision = String(snapshot.revision)
      if (revisions[sessionId] === revision) continue
      try {
        const replica = await local.load(snapshot.header.id)
        const applied = await remote.client.replicaApply(replica)
        revisions[sessionId] = revision
        results.push({
          direction: 'push', status: 'ok', sessionId,
          message: `远端 ${applied.state}，新增 ${String(applied.appendedEventCount)} 个事件`,
        })
      } catch (cause) {
        results.push({
          direction: 'push', status: 'warn', sessionId,
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    this.state = {
      ...this.state,
      pushRevisions: { ...this.state.pushRevisions, [remote.serverId]: revisions },
    }
    return results
  }

  private async stage(serverId: string, replica: RemoteSessionReplicaDocument): Promise<void> {
    await mkdir(this.inboxPath, { recursive: true, mode: 0o700 })
    const key = Buffer.from(`${serverId}\0${String(replica.meta.id)}`).toString('base64url')
    await writeFileAtomic(join(this.inboxPath, `${key}.json`), `${JSON.stringify(replica)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    if (this.stopped || !this.state.enabled || this.running !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.runNow().catch((cause: unknown) => { this.bindings.onError?.(cause) })
    }, this.state.intervalMinutes * 60_000)
  }

  private async load(): Promise<DesktopSessionSyncState> {
    try {
      return parseState(JSON.parse(await readFile(this.statePath, 'utf8')))
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return DEFAULT_STATE
      throw cause
    }
  }

  private persist(): Promise<void> {
    return writeFileAtomic(this.statePath, `${JSON.stringify(this.state, undefined, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}

function parseConfigureRequest(value: DesktopSessionSyncConfigureRequest): DesktopSessionSyncConfigureRequest {
  if (typeof value.enabled !== 'boolean') throw new Error('Session sync enabled must be boolean')
  if (!Number.isInteger(value.intervalMinutes) || value.intervalMinutes < 1 || value.intervalMinutes > 1440) {
    throw new Error('Session sync interval must be an integer from 1 to 1440 minutes')
  }
  if (value.direction !== 'pull' && value.direction !== 'push' && value.direction !== 'bidirectional') {
    throw new Error('Session sync direction is invalid')
  }
  return value
}

function parseState(value: unknown): DesktopSessionSyncState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Session sync state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1) throw new Error('Session sync state version is unsupported')
  const config = parseConfigureRequest(record as unknown as DesktopSessionSyncConfigureRequest)
  return {
    version: 1,
    ...config,
    pullRevisions: parseRevisionGroups(record.pullRevisions),
    pushRevisions: parseRevisionGroups(record.pushRevisions),
    ...(typeof record.lastRunAt === 'string' ? { lastRunAt: record.lastRunAt } : {}),
    results: Array.isArray(record.results) ? record.results as DesktopSessionSyncResult[] : [],
  }
}

function parseRevisionGroups(value: unknown): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const groups: Record<string, Record<string, string>> = {}
  for (const [serverId, revisions] of Object.entries(value)) {
    if (typeof revisions !== 'object' || revisions === null || Array.isArray(revisions)) continue
    groups[serverId] = Object.fromEntries(
      Object.entries(revisions).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  }
  return groups
}
