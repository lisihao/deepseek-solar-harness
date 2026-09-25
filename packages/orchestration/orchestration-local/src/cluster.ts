/** Majority-lease election primitives for the single-authority TaskGraph Scheduler. */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type {
  OrchestrationClusterHeartbeatRequest,
  OrchestrationClusterHeartbeatResponse,
  OrchestrationClusterInstallReceipt,
  OrchestrationClusterInstallRequest,
  OrchestrationClusterReplicaV1,
  OrchestrationClusterStatus,
  OrchestrationClusterVoteRequest,
  OrchestrationClusterVoteResponse,
} from '@deepseek-ai/dsh-orchestration'
import { canonicalRemoteRepositoryIdentity } from '@deepseek-ai/dsh-client-connection'
import { RemoteSyncHttpClient } from './remote-sync-http-client.ts'
export type {
  OrchestrationClusterHeartbeatRequest,
  OrchestrationClusterHeartbeatResponse,
  OrchestrationClusterInstallReceipt,
  OrchestrationClusterInstallRequest,
  OrchestrationClusterReplicaV1,
  OrchestrationClusterStatus,
  OrchestrationClusterVoteRequest,
  OrchestrationClusterVoteResponse,
} from '@deepseek-ai/dsh-orchestration'

/** Current on-disk cluster membership contract. */
export const ORCHESTRATION_CLUSTER_CONFIG_VERSION = 1

/** One configured Product Server participating in orchestration authority. */
export interface OrchestrationClusterMember {
  readonly id: string
  readonly label: string
  readonly endpoint: string
  /** Optional remote execution capacity and Server-local Git source allowlist. */
  readonly remoteExecution?: {
    readonly enabled: boolean
    readonly pollIntervalMs?: number
    readonly repositories: readonly {
      readonly repository: string
      /** Server-local checkout path or credential-free Git URL; never sent over Remote Sync. */
      readonly source: string
    }[]
  }
}

/** Identical membership installed on every Server in one cluster. */
export interface OrchestrationClusterConfig {
  readonly version: typeof ORCHESTRATION_CLUSTER_CONFIG_VERSION
  readonly nodeId: string
  readonly members: readonly OrchestrationClusterMember[]
  readonly leaseMs: number
}

/** Durable election coordinates. Run state remains owned by OrchestrationStore. */
export interface OrchestrationClusterElectionState {
  readonly term: number
  readonly votedFor?: string
  readonly role: 'follower' | 'candidate' | 'leader'
  readonly leaderId?: string
  readonly leaseUntil: number
}

/** Minimal durable persistence surface; SQLite is the production owner. */
export interface OrchestrationClusterElectionStore {
  loadElectionState(): OrchestrationClusterElectionState
  saveElectionState(state: OrchestrationClusterElectionState): void
  commitIndex(): number
  exportClusterReplica(): OrchestrationClusterReplicaV1
}

/** Peer transport implemented by the authenticated Remote Sync control plane. */
export interface OrchestrationClusterPeerTransport {
  requestVote(member: OrchestrationClusterMember, request: OrchestrationClusterVoteRequest): Promise<OrchestrationClusterVoteResponse>
  heartbeat(
    member: OrchestrationClusterMember,
    request: OrchestrationClusterHeartbeatRequest,
  ): Promise<OrchestrationClusterHeartbeatResponse>
  installReplica(
    member: OrchestrationClusterMember,
    request: OrchestrationClusterInstallRequest,
  ): Promise<OrchestrationClusterInstallReceipt>
}

/** Authenticated Remote Sync transport; production catalogs use local trusted tunnels. */
export class RemoteSyncClusterPeerTransport implements OrchestrationClusterPeerTransport {
  constructor(private readonly request: typeof fetch = globalThis.fetch) {}

  requestVote(
    member: OrchestrationClusterMember,
    request: OrchestrationClusterVoteRequest,
  ): Promise<OrchestrationClusterVoteResponse> {
    return new RemoteSyncHttpClient(member.endpoint, undefined, this.request).clusterRequestVote(request)
  }

  heartbeat(
    member: OrchestrationClusterMember,
    request: OrchestrationClusterHeartbeatRequest,
  ): Promise<OrchestrationClusterHeartbeatResponse> {
    return new RemoteSyncHttpClient(member.endpoint, undefined, this.request).clusterHeartbeat(request)
  }

  installReplica(
    member: OrchestrationClusterMember,
    request: OrchestrationClusterInstallRequest,
  ): Promise<OrchestrationClusterInstallReceipt> {
    return new RemoteSyncHttpClient(member.endpoint, undefined, this.request).clusterInstallReplica(request)
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function nonBlank(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error(`${label} must be a non-blank trimmed string`)
  }
  return value
}

/**
 * Read optional cluster membership; absence preserves standalone scheduling.
 * @param root - resident orchestration state root containing cluster.json.
 * @returns the validated fixed-member configuration, or undefined when absent.
 */
export function readOrchestrationClusterConfig(root: string): OrchestrationClusterConfig | undefined {
  const path = join(root, 'cluster.json')
  if (!existsSync(path)) return undefined
  const raw = object(JSON.parse(readFileSync(path, 'utf8')) as unknown, 'orchestration cluster config')
  if (raw.version !== ORCHESTRATION_CLUSTER_CONFIG_VERSION) {
    throw new Error(`orchestration cluster config version must be ${String(ORCHESTRATION_CLUSTER_CONFIG_VERSION)}`)
  }
  const nodeId = nonBlank(raw.nodeId, 'orchestration cluster nodeId')
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    throw new Error('orchestration cluster members must be a non-empty array')
  }
  const ids = new Set<string>()
  const members = raw.members.map((value, index): OrchestrationClusterMember => {
    const member = object(value, `orchestration cluster member ${String(index)}`)
    const id = nonBlank(member.id, `orchestration cluster member ${String(index)}.id`)
    if (ids.has(id)) throw new Error(`orchestration cluster contains duplicate member id "${id}"`)
    ids.add(id)
    const endpoint = new URL(nonBlank(member.endpoint, `orchestration cluster member ${String(index)}.endpoint`))
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
      throw new Error(`orchestration cluster member ${String(index)}.endpoint must use http or https`)
    }
    const remoteExecution = member.remoteExecution === undefined
      ? undefined
      : parseRemoteExecution(member.remoteExecution, `orchestration cluster member ${String(index)}.remoteExecution`)
    return {
      id,
      label: nonBlank(member.label, `orchestration cluster member ${String(index)}.label`),
      endpoint: endpoint.href,
      ...remoteExecution === undefined ? {} : { remoteExecution },
    }
  })
  if (!ids.has(nodeId)) throw new Error(`orchestration cluster nodeId "${nodeId}" is absent from members`)
  const leaseMs = raw.leaseMs ?? 5_000
  if (!Number.isSafeInteger(leaseMs) || Number(leaseMs) < 1_000 || Number(leaseMs) > 60_000) {
    throw new Error('orchestration cluster leaseMs must be an integer from 1000 to 60000')
  }
  return { version: ORCHESTRATION_CLUSTER_CONFIG_VERSION, nodeId, members, leaseMs: Number(leaseMs) }
}

function parseRemoteExecution(
  value: unknown,
  label: string,
): NonNullable<OrchestrationClusterMember['remoteExecution']> {
  const config = object(value, label)
  if (typeof config.enabled !== 'boolean') throw new Error(`${label}.enabled must be boolean`)
  if (!Array.isArray(config.repositories)) throw new Error(`${label}.repositories must be an array`)
  if (config.enabled && config.repositories.length === 0) {
    throw new Error(`${label}.repositories must not be empty when remote execution is enabled`)
  }
  const identities = new Set<string>()
  const repositories = config.repositories.map((entry, index) => {
    const repository = object(entry, `${label}.repositories[${String(index)}]`)
    const identity = canonicalRemoteRepositoryIdentity(nonBlank(
      repository.repository,
      `${label}.repositories[${String(index)}].repository`,
    ))
    if (identities.has(identity)) throw new Error(`${label} contains duplicate repository "${identity}"`)
    identities.add(identity)
    const source = nonBlank(repository.source, `${label}.repositories[${String(index)}].source`)
    if (!isAbsolute(source)) {
      if (!source.includes('://')) {
        throw new Error(`${label}.repositories[${String(index)}].source must be an absolute local path or credential-free https/ssh URL`)
      }
      const url = new URL(source)
      if (url.protocol !== 'https:' && url.protocol !== 'ssh:') {
        throw new Error(`${label}.repositories[${String(index)}].source must use https or ssh`)
      }
      if (url.username.length > 0 || url.password.length > 0) {
        throw new Error(`${label}.repositories[${String(index)}].source must not contain credentials`)
      }
      if (canonicalRemoteRepositoryIdentity(source) !== identity) {
        throw new Error(`${label}.repositories[${String(index)}].source must identify repository "${identity}"`)
      }
    }
    return { repository: identity, source }
  })
  const pollIntervalMs = config.pollIntervalMs
  if (pollIntervalMs !== undefined && (!Number.isSafeInteger(pollIntervalMs) || Number(pollIntervalMs) < 10)) {
    throw new Error(`${label}.pollIntervalMs must be at least 10`)
  }
  return {
    enabled: config.enabled,
    ...pollIntervalMs === undefined ? {} : { pollIntervalMs: Number(pollIntervalMs) },
    repositories,
  }
}

/** Majority election state machine. It never schedules or replicates Run state itself. */
export class OrchestrationClusterElection {
  private state: OrchestrationClusterElectionState
  private epoch = 0
  private campaignInFlight: Promise<OrchestrationClusterStatus> | undefined
  private renewalInFlight: Promise<OrchestrationClusterStatus> | undefined
  private renewalTerm: number | undefined
  private readonly memberIds: ReadonlySet<string>
  private readonly peers: readonly OrchestrationClusterMember[]

  constructor(
    readonly config: OrchestrationClusterConfig,
    private readonly store: OrchestrationClusterElectionStore,
    private readonly transport: OrchestrationClusterPeerTransport,
    private readonly clock: () => number = Date.now,
  ) {
    this.memberIds = new Set(config.members.map(member => member.id))
    this.peers = config.members.filter(member => member.id !== config.nodeId)
    this.state = store.loadElectionState()
  }

  /**
   * Read the current term, role, quorum, and local scheduling authority.
   * @returns the bounded cluster authority projection.
   */
  status(): OrchestrationClusterStatus {
    return {
      ...this.state,
      nodeId: this.config.nodeId,
      memberIds: this.config.members.map(member => member.id),
      commitIndex: this.store.commitIndex(),
      quorum: this.quorum,
      canSchedule: this.canSchedule(),
    }
  }

  /**
   * Test whether this node holds a non-expired majority-backed lease.
   * @returns true only while this node may schedule mutations.
   */
  canSchedule(): boolean {
    return this.state.role === 'leader'
      && this.state.leaderId === this.config.nodeId
      && this.state.leaseUntil > this.clock()
  }

  /**
   * Persist one term-fenced vote exactly once per term.
   * @param request - candidate term and replication watermark.
   * @returns this member's term-fenced vote response.
   */
  requestVote(request: OrchestrationClusterVoteRequest): OrchestrationClusterVoteResponse {
    this.expectMember(request.candidateId)
    if (!Number.isSafeInteger(request.term) || request.term < 1) throw new Error('cluster vote term must be positive')
    if (!Number.isSafeInteger(request.commitIndex) || request.commitIndex < 0) throw new Error('cluster vote commitIndex must be non-negative')
    if (request.term < this.state.term) return this.voteResponse(false)
    if (request.term > this.state.term) this.persist({
      term: request.term,
      role: 'follower',
      leaseUntil: 0,
    })
    const upToDate = request.commitIndex >= this.store.commitIndex()
    const available = this.state.votedFor === undefined || this.state.votedFor === request.candidateId
    if (!upToDate || !available) return this.voteResponse(false)
    this.persist({ term: this.state.term, votedFor: request.candidateId, role: 'follower', leaseUntil: 0 })
    return this.voteResponse(true)
  }

  /**
   * Accept a leader only for the current/newer term and never extend beyond one configured lease.
   * @param request - elected leader term, lease, and replication watermark.
   * @returns this follower's lease acknowledgement.
   */
  heartbeat(request: OrchestrationClusterHeartbeatRequest): OrchestrationClusterHeartbeatResponse {
    this.expectMember(request.leaderId)
    if (!Number.isSafeInteger(request.term) || request.term < 1) throw new Error('cluster heartbeat term must be positive')
    if (!Number.isSafeInteger(request.commitIndex) || request.commitIndex < 0) throw new Error('cluster heartbeat commitIndex must be non-negative')
    const now = this.clock()
    if (request.term < this.state.term || request.leaseUntil <= now
      || request.leaseUntil > now + this.config.leaseMs) return this.heartbeatResponse(false)
    const retainVote = request.term === this.state.term ? this.state.votedFor : undefined
    this.persist({
      term: request.term,
      ...retainVote === undefined ? {} : { votedFor: retainVote },
      role: 'follower',
      leaderId: request.leaderId,
      leaseUntil: request.leaseUntil,
    })
    return this.heartbeatResponse(true)
  }

  /**
   * Campaign once; a majority is mandatory and unavailable peers count as no votes.
   * @returns cluster status after the election and initial lease attempt.
   */
  async campaign(): Promise<OrchestrationClusterStatus> {
    if (this.campaignInFlight !== undefined) return this.campaignInFlight
    const campaign = this.runCampaign().finally(() => {
      if (this.campaignInFlight === campaign) this.campaignInFlight = undefined
    })
    this.campaignInFlight = campaign
    return campaign
  }

  private async runCampaign(): Promise<OrchestrationClusterStatus> {
    if (this.state.leaseUntil > this.clock() && this.state.leaderId !== undefined) return this.status()
    const term = this.state.term + 1
    this.persist({ term, votedFor: this.config.nodeId, role: 'candidate', leaseUntil: 0 })
    const epoch = this.epoch
    const request = { term, candidateId: this.config.nodeId, commitIndex: this.store.commitIndex() }
    const responses = await Promise.allSettled(this.peers.map(peer => this.transport.requestVote(peer, request)))
    if (!this.matchesCampaign(epoch, term)) return this.status()
    let votes = 1
    for (const [index, result] of responses.entries()) {
      if (result.status !== 'fulfilled') continue
      const peer = this.peers[index]
      if (peer === undefined) continue
      const response = result.value
      this.expectMember(response.voterId)
      if (response.voterId !== peer.id) continue
      if (response.term > term) {
        this.persist({ term: response.term, role: 'follower', leaseUntil: 0 })
        return this.status()
      }
      if (response.term === term && response.granted) votes += 1
    }
    if (votes < this.quorum) {
      return this.loseQuorum()
    }
    this.persist({ ...this.state, role: 'leader', leaderId: this.config.nodeId, leaseUntil: 0 })
    return this.renew()
  }

  /**
   * Renew leadership only when a majority acknowledges the same term.
   * @returns cluster status after replication and lease renewal.
   */
  async renew(): Promise<OrchestrationClusterStatus> {
    if (this.renewalInFlight !== undefined) {
      const pendingTerm = this.renewalTerm
      const status = await this.renewalInFlight
      return pendingTerm === this.state.term ? status : this.renew()
    }
    this.renewalTerm = this.state.term
    const renewal = this.runRenewal().finally(() => {
      if (this.renewalInFlight === renewal) {
        this.renewalInFlight = undefined
        this.renewalTerm = undefined
      }
    })
    this.renewalInFlight = renewal
    return renewal
  }

  private async runRenewal(): Promise<OrchestrationClusterStatus> {
    if (this.state.role !== 'leader' || this.state.leaderId !== this.config.nodeId) return this.status()
    const term = this.state.term
    const epoch = this.epoch
    const leaseUntil = this.clock() + this.config.leaseMs
    const request = {
      term,
      leaderId: this.config.nodeId,
      commitIndex: this.store.commitIndex(),
      leaseUntil,
    }
    const responses = await Promise.allSettled(this.peers.map(peer => this.transport.heartbeat(peer, request)))
    if (!this.matchesLeadership(epoch, term)) return this.status()
    let acknowledgements = 1
    for (const [index, result] of responses.entries()) {
      if (result.status !== 'fulfilled') continue
      const peer = this.peers[index]
      if (peer === undefined) continue
      const response = result.value
      this.expectMember(response.followerId)
      if (response.followerId !== peer.id) continue
      if (response.term > term) {
        this.persist({ term: response.term, role: 'follower', leaseUntil: 0 })
        return this.status()
      }
      if (response.term !== term || !response.accepted) continue
      if (response.commitIndex > request.commitIndex) {
        this.persist({ term, role: 'follower', leaseUntil: 0 })
        return this.status()
      }
      if (response.commitIndex === request.commitIndex) {
        acknowledgements += 1
        continue
      }
      try {
        if (!this.matchesLeadership(epoch, term)) return this.status()
        const installed = await this.transport.installReplica(peer, {
          term: request.term,
          leaderId: request.leaderId,
          replica: this.store.exportClusterReplica(),
        })
        if (!this.matchesLeadership(epoch, term)) return this.status()
        if (installed.commitIndex >= request.commitIndex) acknowledgements += 1
      } catch {
        // A follower that cannot durably install the current state is not quorum evidence.
      }
    }
    if (acknowledgements < this.quorum) {
      return this.loseQuorum()
    }
    if (!this.matchesLeadership(epoch, term)) return this.status()
    this.persist({ ...this.state, leaseUntil })
    return this.status()
  }

  private get quorum(): number { return Math.floor(this.config.members.length / 2) + 1 }

  private expectMember(nodeId: string): void {
    if (!this.memberIds.has(nodeId)) throw new Error(`cluster node "${nodeId}" is not a configured member`)
  }

  private persist(state: OrchestrationClusterElectionState): void {
    this.store.saveElectionState(state)
    this.state = state
    this.epoch += 1
  }

  private matchesCampaign(epoch: number, term: number): boolean {
    return this.epoch === epoch && this.state.term === term
      && this.state.role === 'candidate' && this.state.votedFor === this.config.nodeId
  }

  private matchesLeadership(epoch: number, term: number): boolean {
    return this.epoch === epoch && this.state.term === term
      && this.state.role === 'leader' && this.state.leaderId === this.config.nodeId
  }

  private voteResponse(granted: boolean): OrchestrationClusterVoteResponse {
    return { term: this.state.term, voterId: this.config.nodeId, granted, commitIndex: this.store.commitIndex() }
  }

  private loseQuorum(): OrchestrationClusterStatus {
    this.persist({
      term: this.state.term,
      ...this.state.votedFor === undefined ? {} : { votedFor: this.state.votedFor },
      role: 'follower',
      leaseUntil: 0,
    })
    return this.status()
  }

  private heartbeatResponse(accepted: boolean): OrchestrationClusterHeartbeatResponse {
    return { term: this.state.term, followerId: this.config.nodeId, accepted, commitIndex: this.store.commitIndex() }
  }
}
