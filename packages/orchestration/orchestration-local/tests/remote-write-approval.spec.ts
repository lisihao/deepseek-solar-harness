/** Scheduler approval, actual remote Git edits, patch integration, and independent verification. */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId, type LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import { GouziMemberService, type RemoteResidentExecuteRequest, type RemoteResidentTurnSnapshot } from '@deepseek-ai/dsh-client-connection'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { OrchestrationDaemon } from '../src/daemon.ts'
import { OrchestrationDaemonClient } from '../src/client.ts'
import { LocalRemoteOperatorHostService } from '../src/remote-execution-host.ts'
import { OrchestrationStore } from '../src/store.ts'
import { WorkspaceSnapshotManager } from '../src/workspace-snapshot.ts'

async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() >= deadline) throw new Error(`approval fixture did not converge: ${JSON.stringify(value)}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const affirmative = JSON.stringify({ accepted: true, reason: 'Requested bytes match.', evidence: ['Read work.txt from the latest snapshot.'] })
const scenarios = [
  { name: 'affirmative evidence delivers the verified bytes', verdict: affirmative, outcome: 'completed', mode: 'normal' },
  { name: 'negative verdict keeps the original bytes', verdict: JSON.stringify({ accepted: false, reason: 'Requested bytes do not match.', evidence: ['Read work.txt.'] }), outcome: 'failed', mode: 'normal' },
  { name: 'affirmative verdict without evidence keeps the original bytes', verdict: JSON.stringify({ accepted: true, reason: 'Looks complete.', evidence: [] }), outcome: 'failed', mode: 'normal' },
  { name: 'accepted cancellation before delivery keeps the original bytes', verdict: affirmative, outcome: 'cancelled', mode: 'before-delivery' },
  { name: 'delivery rejects cancellation and then writes real bytes', verdict: affirmative, outcome: 'completed', mode: 'during-delivery' },
  { name: 'delivery rejects cancellation and preserves an indeterminate external error', verdict: affirmative, outcome: 'indeterminate', mode: 'delivery-error' },
] as const

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('remote write approval', () => {
  it.each(scenarios)('$name', async ({ verdict, outcome, mode }) => {
    let boundaryReached = false
    const releaseBoundary = deferred()
    const originalApply: WorkspaceSnapshotManager['conditionalApply'] = Reflect.get(WorkspaceSnapshotManager.prototype, 'conditionalApply')
    const apply = vi.spyOn(WorkspaceSnapshotManager.prototype, 'conditionalApply').mockImplementation(async function (this: WorkspaceSnapshotManager, snapshotId, workspace) {
      if (mode === 'during-delivery' || mode === 'delivery-error') {
        boundaryReached = true
        await releaseBoundary.promise
        if (mode === 'delivery-error') throw Object.assign(new Error('external delivery outcome unknown'), { code: 'COMMAND_INDETERMINATE' })
      }
      return originalApply.call(this, snapshotId, workspace)
    })
    const home = await mkdtemp(join(tmpdir(), 'dsh-approved-remote-'))
    let authority = join(home, 'authority')
    await mkdir(authority)
    authority = await realpath(authority)
    await writeFile(join(authority, 'work.txt'), 'base\n')
    // The actual registered user directory deliberately has no Git metadata or initial HEAD.
    const projectId = 'a'.repeat(64)
    const remoteHome = join(home, 'remote')
    await mkdir(join(remoteHome, 'orchestrations'), { recursive: true })
    await writeFile(join(remoteHome, 'orchestrations', 'cluster.json'), JSON.stringify({ version: 1, nodeId: 'remote',
      members: [{ id: 'remote', label: 'Remote', endpoint: 'http://127.0.0.1:1', remoteExecution: { enabled: true,
        repositories: [], projects: [{ projectId, source: authority }], defaultProjectId: projectId } }] }))
    class Member extends GouziMemberService {
      hello() { return { gouziId: 'fixture', ownerId: 'owner', hostId: 'host', generation: 1, authorityEpoch: 'epoch', incarnation: 1 } as never }
      admit() { return Promise.reject(new Error('fixture Native transport does not call admission')) }
      recordAccepted() { return Promise.resolve() }
    }
    const remoteContext = new Context()
    new Member(remoteContext)
    const remote = new LocalRemoteOperatorHostService(remoteContext, { dshHome: remoteHome,
      directoryLockRoot: join(home, 'remote-locks'), timeoutMs: 10_000, artifactReadTimeoutMs: 1_000, artifactMaxBytes: 1024 * 1024, workspaceLeaseMs: 60_000 })
    const provider = (operatorId: string) => ({ operatorId, product: operatorId,
      displayName: operatorId, description: 'fixture', tags: ['coding'], maxConcurrency: 1,
      injectionBoundaries: ['pre-dispatch'], available: true, authentication: 'native-subscription',
      productVersion: 'fixture', protocolHash: 'fixture', supportsWorkspaceMutationReturn: true, supportsWorkspaceSnapshotInput: true, supportsGovernedWorkspacePolicy: true, supportsGenerationLimits: true,
      gouziWorkspace: { gouziId: 'fixture', generation: 1, projectId, projectScopes: [authority] },
      models: [{ model: 'gpt-5.6-luna', displayName: 'Fixture', description: 'fixture', supportedEfforts: ['medium'],
        defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true }],
      quotaPools: [{ poolId: operatorId, displayName: operatorId, models: ['gpt-5.6-luna'], meter: 'native-subscription',
        primary: { usedPercent: 0 }, observedAt: new Date().toISOString() }],
    })
    const turns = new Map<string, RemoteResidentTurnSnapshot>()
    let edits = 0
    let verificationReads = 0
    vi.stubGlobal('fetch', async (_url: unknown, init?: RequestInit) => {
      if (typeof init?.body !== 'string') throw new Error('expected JSON request body')
      const call = JSON.parse(init.body) as { rpcId: string; method: string; payload: RemoteResidentExecuteRequest & { turnId: string } }
      let value: unknown
      if (call.method === 'operator.providers') value = [provider('codex'), provider('claude-code')]
      else if (call.method === 'operator.execute') {
        const request = call.payload
        const workspace = await remote.materializeWorkspace(
          request.workspaceIdentity, request.commandId, request.workspaceMutationReturn, request.workspaceSnapshotInput,
        )
        if (request.operatorId === 'codex') {
          expect(request.workspaceMutationReturn).toMatchObject({ version: 1, baseSha: request.workspaceSnapshotInput?.baseSha })
          expect(workspace.path).not.toBe(authority)
          await writeFile(join(workspace.path, 'work.txt'), 'actually edited after approval\n')
          edits += 1
        } else {
          expect(request.workspaceMutationReturn).toBeUndefined()
          expect(request.workspaceSnapshotInput).toBeDefined()
          expect(await readFile(join(authority, 'work.txt'), 'utf8')).toBe('base\n')
          expect(await readFile(join(workspace.path, 'work.txt'), 'utf8')).toBe('actually edited after approval\n')
          verificationReads += 1
          if (mode === 'before-delivery') {
            boundaryReached = true
            await releaseBoundary.promise
          }
        }
        const turnId = request.commandId
        turns.set(turnId, { commandId: request.commandId, turnId, sessionId: `session-${request.operatorId}`,
          state: 'settled', stateRevision: 2, updatedAt: new Date().toISOString(),
          result: { output: [{ type: 'text', text: request.operatorId === 'codex' ? 'Implemented actual file edit.' : verdict }], stopReason: 'completed' } })
        value = { turnId, sessionId: `session-${request.operatorId}`, stateRevision: 1,
          ...request.contextEnvelope === undefined ? {} : { contextReceipt: { version: 1, digest: request.contextEnvelope.digest,
            receiver: `remote-resident:${request.operatorId}`, outcome: 'accepted', format: 'native', roleFidelity: 'native' } } }
      } else if (call.method === 'operator.inspect') {
        const turn = turns.get(call.payload.turnId)
        if (turn === undefined) throw new Error('unknown fixture turn')
        const mutation = await remote.captureWorkspaceMutation(turn.commandId)
        await remote.releaseWorkspace(turn.commandId)
        value = { ...turn, result: { ...turn.result, ...mutation === undefined ? {} : { workspaceMutation: mutation } } }
      } else if (call.method === 'operator.events') value = { events: [], nextSequence: 0 }
      else if (call.method === 'operator.interrupt') value = { interrupted: true }
      else throw new Error(`unexpected remote method ${call.method}`)
      return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
    })
    const root = join(home, 'owner')
    const registry = new OrchestrationStore(root)
    registry.gouzi.pairHost({ hostId: GouziHostId('local'), label: 'Local fixture', authorityEpoch: GouziAuthorityEpoch('epoch'), credentialRef: 'FIXTURE_ONLY' })
    registry.gouzi.create({ gouziId: GouziId('fixture'), ownerId: GouziOwnerId('owner'), hostId: GouziHostId('local'),
      name: 'Fixture', avatarId: 'shiba', role: 'development', grantDeadlineMs: 60_000 })
    registry.gouzi.setMembership(GouziId('fixture'), 'enabled')
    registry.gouzi.setEndpoint(GouziId('fixture'), 'http://127.0.0.1:13301')
    registry.close()
    const daemon = new OrchestrationDaemon({ root, dshHome: home, schedulerIntervalMs: 10,
      residentClient: { providers: async () => [] } as unknown as ResidentDaemonClient, modelWorkerProviders: [],
      remoteOperatorServers: [] })
    try {
      await daemon.start()
      const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2_000 })
      const common = { requiredForCompletion: true, capabilityRequirements: [], capabilityBudget: [],
        contextPolicy: { maxTokens: 4096, allowedSourceKinds: ['intent', 'artifact', 'capsule'] as const, unavailableSource: 'block' as const },
        effectBudget: { read: ['**'], write: ['**'], execute: [], network: [], cost: [], risk: [] },
        approvedSecretRefs: [], acceptance: [{ id: 'done', description: 'Complete and report actual work.', kind: 'operator-completed' as const }],
        retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] }, timeoutMs: 10_000 }
      const graph: LogicalTaskGraphV1 = { version: 1, title: 'Approved real edit', workspace: authority,
        workspaceIsolation: 'directory-snapshot', risk: 'high', maxParallel: 1,
        workspaceSnapshotLimits: { maxFiles: 100, maxBytes: 1024 * 1024, maxBundleBytes: 1024 * 1024, timeoutMs: 10_000 },
        qualityPolicy: { independentVerification: 'required' }, nodes: [{ ...common,
          id: 'work', title: 'Edit work.txt', task: 'Change work.txt to actually edited after approval.', role: 'implementation',
          phase: 'execution', dependsOn: [], readScopes: ['**'], writeScopes: ['**'], operator: { preferredIds: ['gouzi.fixture.codex'] },
        }, { ...common, id: 'verify', title: 'Verify actual result', task: 'Read work.txt and independently verify the requested actual content.',
          role: 'verification', phase: 'verification', dependsOn: ['work'], readScopes: ['**'], writeScopes: [],
          effectBudget: { ...common.effectBudget, write: [] },
          acceptance: [{ id: 'verified', description: 'Submit an explicit verdict with actual file evidence.', kind: 'model-verdict' }], operator: { preferredIds: ['gouzi.fixture.claude-code'] },
        }] }
      const compilation = await client.compile({ intent: { request: 'Edit work.txt and independently verify its contents.' }, graph,
        admission: { policy: 'auto', route: 'taskgraph', sourceSessionId: 'approval-fixture',
          gouziRecipient: { gouziId: GouziId('fixture'), generation: 1, operatorIds: ['gouzi.fixture.codex', 'gouzi.fixture.claude-code'] as never }, rlm: 'disabled', autonomous: 'disabled', continualHarness: 'off' } })
      const started = await client.start({ commandId: 'approve-real-write-start', compilationId: compilation.compilationId })
      expect(started.state).toBe('awaiting_approval')
      expect(edits).toBe(0)
      expect(await readFile(join(authority, 'work.txt'), 'utf8')).toBe('base\n')
      await client.decide({ commandId: 'approve-real-write', runId: started.runId, expectedRevision: started.revision,
        decision: 'approve', reason: 'fixture user approval' })
      if (mode !== 'normal') {
        const atBoundary = await waitFor(() => client.inspect(String(started.runId)), value => boundaryReached
          || ['completed', 'failed', 'cancelled', 'indeterminate'].includes(value.state))
        expect(boundaryReached, JSON.stringify(atBoundary)).toBe(true)
        expect(await readFile(join(authority, 'work.txt'), 'utf8')).toBe('base\n')
        const cancel = { commandId: 'cancel-delivery', runId: started.runId, expectedRevision: atBoundary.revision,
          action: 'cancel' as const, reason: 'fixture cancellation' }
        if (mode === 'before-delivery') {
          expect((await client.control(cancel)).state).toBe('cancelled')
        } else {
          expect(atBoundary.delivery?.state).toBe('applying')
          await expect(client.control(cancel)).rejects.toMatchObject({ code: 'RUN_STATE_CONFLICT' })
        }
        releaseBoundary.resolve()
      }
      const completed = await waitFor(() => client.inspect(String(started.runId)), value => ['completed', 'failed', 'cancelled', 'indeterminate'].includes(value.state))
      expect(completed.state, JSON.stringify(completed)).toBe(outcome)
      expect(edits).toBe(1)
      expect(verificationReads).toBe(1)
      expect(await readFile(join(authority, 'work.txt'), 'utf8')).toBe(outcome === 'completed' ? 'actually edited after approval\n' : 'base\n')
      if (outcome === 'completed') {
        expect(completed.nodes.every(node => node.state === 'passed')).toBe(true)
        expect(completed.delivery?.state).toBe('applied')
      }
      if (outcome === 'cancelled') {
        await waitFor(() => client.inspect(String(started.runId)), value => value.nodes.every(node => node.state !== 'running'))
        expect((await client.inspect(String(started.runId))).state).toBe('cancelled')
        expect(apply).not.toHaveBeenCalled()
        expect(await readFile(join(authority, 'work.txt'), 'utf8')).toBe('base\n')
      }
      if (outcome === 'indeterminate') expect(completed.delivery?.state).toBe('indeterminate')
      await expect(readFile(join(authority, '.git', 'HEAD'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      releaseBoundary.resolve()
      await daemon.close()
      apply.mockRestore()
      vi.unstubAllGlobals()
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
})
