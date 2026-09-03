import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OrchestrationClusterElection,
  readOrchestrationClusterConfig,
  type OrchestrationClusterElectionState,
  type OrchestrationClusterElectionStore,
  type OrchestrationClusterHeartbeatRequest,
  type OrchestrationClusterPeerTransport,
  type OrchestrationClusterVoteRequest,
} from '../src/cluster.ts'
import { OrchestrationStore } from '../src/store.ts'

class MemoryElectionStore implements OrchestrationClusterElectionStore {
  state: OrchestrationClusterElectionState = { term: 0, role: 'follower', leaseUntil: 0 }
  index = 0
  loadElectionState(): OrchestrationClusterElectionState { return this.state }
  saveElectionState(state: OrchestrationClusterElectionState): void { this.state = state }
  commitIndex(): number { return this.index }
  exportClusterReplica() {
    return {
      version: 1 as const,
      stateSchemaVersion: 4,
      commitIndex: this.index,
      capturedAt: new Date(0).toISOString(),
      tables: {},
      artifacts: [],
    }
  }
}

function config() {
  return {
    version: 1 as const,
    nodeId: 'a',
    leaseMs: 5_000,
    members: [
      { id: 'a', label: 'A', endpoint: 'http://a.example/' },
      { id: 'b', label: 'B', endpoint: 'http://b.example/' },
      { id: 'c', label: 'C', endpoint: 'http://c.example/' },
    ],
  }
}

describe('orchestration cluster config', () => {
  it('loads normalized identical membership and rejects unsafe catalogs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-orchestration-cluster-'))
    writeFileSync(join(root, 'cluster.json'), JSON.stringify({
      version: 1,
      nodeId: 'a',
      leaseMs: 4_000,
      members: [
        {
          id: 'a', label: 'A', endpoint: 'http://127.0.0.1:13080',
          remoteExecution: {
            enabled: true,
            repositories: [{
              repository: 'git@github.com:lisihao/project.git', source: '/srv/git/project',
            }],
          },
        },
        {
          id: 'b', label: 'B', endpoint: 'https://b.example/dsh',
          remoteExecution: { enabled: false, repositories: [] },
        },
      ],
    }))
    expect(readOrchestrationClusterConfig(root)).toEqual({
      version: 1,
      nodeId: 'a',
      leaseMs: 4_000,
      members: [
        {
          id: 'a', label: 'A', endpoint: 'http://127.0.0.1:13080/',
          remoteExecution: {
            enabled: true,
            repositories: [{ repository: 'github.com/lisihao/project', source: '/srv/git/project' }],
          },
        },
        {
          id: 'b', label: 'B', endpoint: 'https://b.example/dsh',
          remoteExecution: { enabled: false, repositories: [] },
        },
      ],
    })
    expect(readOrchestrationClusterConfig(mkdtempSync(join(tmpdir(), 'dsh-no-cluster-')))).toBeUndefined()
    writeFileSync(join(root, 'cluster.json'), JSON.stringify({
      version: 1,
      nodeId: 'missing',
      members: [{ id: 'a', label: 'A', endpoint: 'http://a.example' }],
    }))
    expect(() => readOrchestrationClusterConfig(root)).toThrow('absent from members')
  })

  it('accepts only absolute local or credential-free https/ssh repository sources', () => {
    const validSources = ['/srv/git/project', 'https://github.com/lisihao/project.git', 'ssh://github.com/lisihao/project.git']
    for (const source of validSources) {
      const root = mkdtempSync(join(tmpdir(), 'dsh-orchestration-source-valid-'))
      writeFileSync(join(root, 'cluster.json'), JSON.stringify({
        version: 1, nodeId: 'a', members: [{
          id: 'a', label: 'A', endpoint: 'http://a.example',
          remoteExecution: {
            enabled: true,
            repositories: [{ repository: 'github.com/lisihao/project', source }],
          },
        }],
      }))
      expect(readOrchestrationClusterConfig(root)?.members[0]?.remoteExecution?.repositories[0]?.source).toBe(source)
    }
    for (const source of [
      'relative/project', 'git@github.com:lisihao/project.git',
      'https://token@github.com/lisihao/project.git', 'ssh://git@github.com/lisihao/project.git',
      'file:///srv/git/project', 'https://github.com/lisihao/another.git',
    ]) {
      const root = mkdtempSync(join(tmpdir(), 'dsh-orchestration-source-invalid-'))
      writeFileSync(join(root, 'cluster.json'), JSON.stringify({
        version: 1, nodeId: 'a', members: [{
          id: 'a', label: 'A', endpoint: 'http://a.example',
          remoteExecution: {
            enabled: true,
            repositories: [{ repository: 'github.com/lisihao/project', source }],
          },
        }],
      }))
      expect(() => readOrchestrationClusterConfig(root)).toThrow()
    }
  })
})

describe('orchestration cluster persistence', () => {
  it('persists term/vote independently from the monotonic data commit index', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-orchestration-cluster-store-'))
    const store = new OrchestrationStore(root)
    expect(store.commitIndex()).toBe(0)
    store.saveElectionState({ term: 2, votedFor: 'a', role: 'candidate', leaseUntil: 0 })
    expect(store.loadElectionState()).toEqual({ term: 2, votedFor: 'a', role: 'candidate', leaseUntil: 0 })
    expect(store.commitIndex()).toBe(0)
    store.saveCompilation({
      version: 1,
      compilationId: 'cmp-cluster',
      intent: {
        version: 1,
        objective: 'fixture',
        expectedOutcomes: [],
        constraints: [],
        nonGoals: [],
        acceptanceRequirements: [],
        sourceRefs: [],
        attachmentRefs: [],
        riskHints: [],
        ambiguities: [],
        requiresClarification: false,
        provenance: { compilerId: 'fixture', compilerVersion: '1', inputSha256: 'a', outputSha256: 'b' },
      },
      intentRef: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as never,
      graphRef: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as never,
      graph: {
        version: 1,
        title: 'fixture',
        workspace: root,
        maxParallel: 1,
        risk: 'low',
        nodes: [],
      },
      certificate: {
        version: 1,
        graphSha256: 'graph',
        certificateSha256: 'certificate',
        nodeIds: [],
        maximumRisk: 'low',
        requiresApproval: false,
        generatedAt: new Date(0).toISOString(),
      },
      requiresClarification: false,
      blockers: [],
    })
    const artifact = store.putArtifact({ replicated: true })
    store.recordArtifact('compilation_artifacts', { ref: String(artifact) })
    expect(store.commitIndex()).toBe(2)
    const replica = store.exportClusterReplica()
    const followerRoot = mkdtempSync(join(tmpdir(), 'dsh-orchestration-cluster-follower-'))
    const follower = new OrchestrationStore(followerRoot)
    expect(follower.installClusterReplica(replica)).toBe('applied')
    expect(follower.commitIndex()).toBe(2)
    expect(follower.getCompilation('cmp-cluster')).toMatchObject({ compilationId: 'cmp-cluster' })
    expect(follower.readArtifact(artifact)).toEqual({ replicated: true })
    expect(follower.installClusterReplica(replica)).toBe('unchanged')
    follower.close()
    store.close()
    const reopened = new OrchestrationStore(root)
    expect(reopened.loadElectionState()).toEqual({ term: 2, votedFor: 'a', role: 'candidate', leaseUntil: 0 })
    expect(reopened.commitIndex()).toBe(2)
    reopened.close()
  }, 30_000)
})

describe('OrchestrationClusterElection', () => {
  it('wins and renews only with a majority-backed bounded lease', async () => {
    let clock = 1_000
    const store = new MemoryElectionStore()
    store.index = 3
    const votes: OrchestrationClusterVoteRequest[] = []
    const heartbeats: OrchestrationClusterHeartbeatRequest[] = []
    const installs: string[] = []
    const transport: OrchestrationClusterPeerTransport = {
      requestVote: async (member, request) => {
        votes.push(request)
        return { term: request.term, voterId: member.id, granted: member.id === 'b', commitIndex: 0 }
      },
      heartbeat: async (member, request) => {
        heartbeats.push(request)
        return { term: request.term, followerId: member.id, accepted: member.id === 'b', commitIndex: 0 }
      },
      installReplica: async (member, request) => {
        installs.push(member.id)
        return { nodeId: member.id, commitIndex: request.replica.commitIndex, state: 'applied' }
      },
    }
    const election = new OrchestrationClusterElection(config(), store, transport, () => clock)
    expect((await election.campaign()).canSchedule).toBe(true)
    expect(votes).toHaveLength(2)
    expect(heartbeats).toHaveLength(2)
    expect(installs).toEqual(['b'])
    expect(election.status()).toMatchObject({ term: 1, role: 'leader', leaderId: 'a', leaseUntil: 6_000 })
    clock = 6_000
    expect(election.canSchedule()).toBe(false)
    expect((await election.renew()).canSchedule).toBe(true)
    expect(election.status().leaseUntil).toBe(11_000)
  })

  it('steps down without quorum and cannot dispatch on a stale lease', async () => {
    const store = new MemoryElectionStore()
    const transport: OrchestrationClusterPeerTransport = {
      requestVote: async () => { throw new Error('offline') },
      heartbeat: async () => { throw new Error('offline') },
      installReplica: async () => { throw new Error('offline') },
    }
    const election = new OrchestrationClusterElection(config(), store, transport, () => 1_000)
    expect(await election.campaign()).toMatchObject({ term: 1, role: 'follower', canSchedule: false })
  })

  it('persists one vote per term and rejects stale candidates', () => {
    const store = new MemoryElectionStore()
    store.index = 7
    const election = new OrchestrationClusterElection(config(), store, {
      requestVote: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      installReplica: async () => { throw new Error('unused') },
    }, () => 1_000)
    expect(election.requestVote({ term: 2, candidateId: 'b', commitIndex: 7 })).toMatchObject({ granted: true, term: 2 })
    expect(election.requestVote({ term: 2, candidateId: 'c', commitIndex: 7 })).toMatchObject({ granted: false, term: 2 })
    expect(election.requestVote({ term: 1, candidateId: 'b', commitIndex: 7 })).toMatchObject({ granted: false, term: 2 })
    expect(election.requestVote({ term: 3, candidateId: 'c', commitIndex: 6 })).toMatchObject({ granted: false, term: 3 })
  })

  it('accepts only current configured leaders with bounded future leases', () => {
    let clock = 10_000
    const store = new MemoryElectionStore()
    const election = new OrchestrationClusterElection(config(), store, {
      requestVote: async () => { throw new Error('unused') },
      heartbeat: async () => { throw new Error('unused') },
      installReplica: async () => { throw new Error('unused') },
    }, () => clock)
    expect(election.heartbeat({ term: 2, leaderId: 'b', commitIndex: 0, leaseUntil: 14_000 })).toMatchObject({ accepted: true, term: 2 })
    expect(election.status()).toMatchObject({ role: 'follower', leaderId: 'b', leaseUntil: 14_000 })
    expect(election.heartbeat({ term: 1, leaderId: 'b', commitIndex: 0, leaseUntil: 14_000 })).toMatchObject({ accepted: false, term: 2 })
    expect(election.heartbeat({ term: 2, leaderId: 'b', commitIndex: 0, leaseUntil: 20_000 })).toMatchObject({ accepted: false, term: 2 })
    clock = 14_000
    expect(election.status().canSchedule).toBe(false)
    expect(() => election.heartbeat({ term: 2, leaderId: 'unknown', commitIndex: 0, leaseUntil: 15_000 })).toThrow('not a configured member')
  })

  it('fences an old campaign superseded by a higher-term heartbeat while votes are pending', async () => {
    const store = new MemoryElectionStore()
    const votes = Promise.withResolvers<{
      term: number
      voterId: string
      granted: boolean
      commitIndex: number
    }>()
    let requestCount = 0
    const election = new OrchestrationClusterElection(config(), store, {
      requestVote: async () => { requestCount += 1; return votes.promise },
      heartbeat: async () => { throw new Error('stale campaign must not renew') },
      installReplica: async () => { throw new Error('unused') },
    }, () => 1_000)
    const first = election.campaign()
    const second = election.campaign()
    await Promise.resolve()
    expect(requestCount).toBe(2)
    expect(election.heartbeat({ term: 2, leaderId: 'b', commitIndex: 0, leaseUntil: 5_000 }))
      .toMatchObject({ accepted: true, term: 2 })
    votes.resolve({ term: 1, voterId: 'b', granted: true, commitIndex: 0 })
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ term: 2, role: 'follower', leaderId: 'b', canSchedule: false }),
      expect.objectContaining({ term: 2, role: 'follower', leaderId: 'b', canSchedule: false }),
    ])
    expect(requestCount).toBe(2)
  })

  it('fences an old lease renewal superseded while heartbeat responses are pending', async () => {
    const store = new MemoryElectionStore()
    store.state = { term: 1, role: 'leader', leaderId: 'a', leaseUntil: 2_000 }
    const response = Promise.withResolvers<{
      term: number
      followerId: string
      accepted: boolean
      commitIndex: number
    }>()
    const election = new OrchestrationClusterElection(config(), store, {
      requestVote: async () => { throw new Error('unused') },
      heartbeat: async () => response.promise,
      installReplica: async () => { throw new Error('unused') },
    }, () => 1_000)
    const renewal = election.renew()
    await Promise.resolve()
    election.heartbeat({ term: 2, leaderId: 'b', commitIndex: 0, leaseUntil: 5_000 })
    response.resolve({ term: 1, followerId: 'b', accepted: true, commitIndex: 0 })
    await expect(renewal).resolves.toMatchObject({ term: 2, role: 'follower', leaderId: 'b', canSchedule: false })
  })
})
