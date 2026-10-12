#!/usr/bin/env node
/** Real Loader/daemon composition; only external model and worker execution are deterministic. */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { gouziRequestHash, type RemoteResidentExecuteRequest } from '@deepseek-ai/dsh-client-connection'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { GouziId, GouziHostId, GouziOwnerId, GouziAuthorityEpoch, type GouziExecutionGrant } from '@deepseek-ai/dsh-orchestration'
import { OrchestrationDaemon, OrchestrationStore } from '@deepseek-ai/dsh-orchestration-local'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-orchestration-local/src/workspace-snapshot.ts'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { GOUZI_DASHBOARD_PATH, type GouziRoomSnapshotV1 } from '@deepseek-ai/dsh-ui-gouzi/src/contracts.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tool-orchestration'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) throw new Error('kennel fixture requires config and isolated DSH_HOME')
const projectPath = join(home, 'project')
await mkdir(projectPath, { recursive: true })
const workspace = await realpath(projectPath)
await writeFile(join(workspace, 'README.md'), 'fixture baseline\n')
const root = join(home, 'orchestrations')
const registry = new OrchestrationStore(root)
registry.gouzi.pairHost({ hostId: GouziHostId('local'), label: 'Keyless host', authorityEpoch: GouziAuthorityEpoch('keyless-epoch'), credentialRef: 'KENNEL_FIXTURE_TOKEN' })
registry.gouzi.create({ gouziId: GouziId('stable-dog'), ownerId: GouziOwnerId('main'), hostId: GouziHostId('local'), name: 'Original', avatarId: 'shiba', role: 'research', grantDeadlineMs: 60_000 })
registry.gouzi.setMembership(GouziId('stable-dog'), 'enabled')
registry.gouzi.setEndpoint(GouziId('stable-dog'), 'http://127.0.0.1:13301')
registry.gouzi.edit(GouziId('stable-dog'), { name: 'Renamed', model: 'gpt-5.6-sol' })
registry.close()
const originalFetch = globalThis.fetch
const methods: string[] = []
const executed: Record<string, unknown>[] = []
const errors: unknown[] = []
const requestSessions = new Map<string, Session>()
const persistedBeforeModel: boolean[] = []
const persistedBeforeExecution: boolean[] = []
const provider = {
  operatorId: 'codex', product: 'codex', displayName: 'Fixture Codex', description: 'External worker fixture',
  tags: ['analysis'], maxConcurrency: 1, injectionBoundaries: [], available: true,
  supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true,
  authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture', models: [
    { model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Worker', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true },
    { model: 'gpt-5.6-sol', displayName: 'Sol', description: 'Pinned worker', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: false, supportsAdaptiveThinking: true },
  ],
  gouziWorkspace: { gouziId: 'stable-dog', generation: 1, projectId: 'a'.repeat(64), projectScopes: [workspace] },
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('http://127.0.0.1:13301/remote-sync/')) return originalFetch(input, init)
  if (typeof init?.body !== 'string') throw new Error('remote body must be JSON text')
  const call = JSON.parse(init.body) as { rpcId: string; method: string; payload: Record<string, unknown> }
  methods.push(call.method)
  let value: unknown
  switch (call.method) {
    case 'operator.providers': value = [provider]; break
    case 'operator.execute': {
      const source = requestSessions.get('hello')!
      const rows = await readDurableRows(source)
      const submission = rows.some(row => row.type === 'kennel/dispatch-submission')
      persistedBeforeExecution.push(submission)
      if (!submission) throw new Error('execution preceded durable submission')
      executed.push(call.payload)
      value = { sessionId: 'worker-session', turnId: 'worker-turn', stateRevision: 1,
        contextReceipt: { version: 1, digest: (call.payload.contextEnvelope as { digest: string }).digest,
          receiver: 'remote-resident:codex', outcome: 'accepted', format: 'native', roleFidelity: 'native' } }; break
    }
    case 'operator.inspect':
      value = { commandId: executed.at(-1)?.commandId, sessionId: 'worker-session', turnId: 'worker-turn', state: 'settled', stateRevision: 2,
        updatedAt: '2026-10-07T00:00:00.000Z',
        result: { output: [{ type: 'text', text: '你好，我是狗窝成员。' }], stopReason: 'completed' } }; break
    case 'operator.events': value = { events: [], nextSequence: 0 }; break
    default: throw new Error(`unexpected remote method ${call.method}`)
  }
  return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
}
const resident = { providers: async () => [], execute: async () => { throw new Error('unexpected local fallback') } }
const daemon = new OrchestrationDaemon({ root, dshHome: home, residentClient: resident as unknown as ResidentDaemonClient,
  modelWorkerProviders: [], schedulerIntervalMs: 10 })
await daemon.start()
const ctx = await boot('kennel-ai-dispatch-keyless', resolveConfigPath(configPath, undefined))
ctx.on('agent/error', ({ error }) => { errors.push(error) })
type DurableRow = { type: string; data?: { record?: { phase: string } } }
async function readDurableRows(session: Session): Promise<DurableRow[]> {
  const location = ctx.sessionPersistence.locate(session.header)
  if (location?.kind !== 'jsonl') throw new Error('fixture requires physical JSONL session log')
  return (await readFile(location.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as DurableRow)
}
let modelCalls = 0
class Judgment extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    modelCalls++
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('missing judgment request')
    const input = JSON.parse(block.text) as { request: string; candidates: { kind: string; id: string; mode?: string; action?: string }[] }
    const rows = await readDurableRows(requestSessions.get(input.request)!)
    const durable = rows.at(-1)?.type === 'kennel/dispatch-model' && rows.at(-1)?.data?.record?.phase === 'request'
    persistedBeforeModel.push(durable)
    if (!durable) throw new Error('AI request preceded durable model-visible provenance')
    const chat = input.request === 'inspect task' || input.request === 'cancel task'
      ? input.candidates.find(candidate => candidate.kind === 'control'
        && candidate.action === (input.request === 'inspect task' ? 'inspect' : 'cancel'))
      : input.candidates.find(candidate => candidate.kind === 'work'
        && candidate.mode === (input.request === 'change fixture' ? 'write' : 'chat'))
    if (!chat) throw new Error('no chat candidate')
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidateId: chat.id }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['deepseek-official'], new Judgment())
const waitFor = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 10000
  while (!await check()) {
    if (errors.length) throw errors[0]
    if (Date.now() > deadline) throw new Error('fixture timeout: ' + JSON.stringify({ runs: await ctx.orchestrations.list(), methods, executed }))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  const handle = await ctx.agents.create({ sessionId: SessionId('kennel-ai-a'), meta: { cwd: workspace } })
  const agent = handle.agent
  agent.session.append('agent-preset/selected', { agentPreset: 'kennel' })
  requestSessions.set('hello', agent.session)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }))
  await waitFor(async () => agent.session.events.some(event => event.type === 'kennel/dispatch-admitted'))
  await waitFor(async () => (await ctx.orchestrations.list())[0]?.state === 'completed')
  const run = (await ctx.orchestrations.list())[0]!
  const submission = agent.session.events.find(event => event.type === 'kennel/dispatch-submission')!
  if (submission.type !== 'kennel/dispatch-submission') throw new Error('missing submission')
  const retained = new OrchestrationStore(root)
  const compiled = retained.getCompilation(submission.data.compilationId)
  retained.close()
  await waitFor(async () => agent.status === 'idle')
  requestSessions.set('inspect task', agent.session)
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'inspect task' }] }))
  await waitFor(async () => agent.session.events.some(event => event.type === 'kennel/dispatch-control'))
  const inspected = agent.session.events.find(event => event.type === 'kennel/dispatch-control')!
  if (inspected.type !== 'kennel/dispatch-control') throw new Error('missing durable control receipt')
  const writeHandle = await ctx.agents.create({ sessionId: SessionId('kennel-ai-write'), meta: { cwd: workspace } })
  writeHandle.agent.session.append('agent-preset/selected', { agentPreset: 'kennel' })
  requestSessions.set('change fixture', writeHandle.agent.session)
  writeHandle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'change fixture' }] }))
  await waitFor(async () => writeHandle.agent.session.events.some(event => event.type === 'kennel/dispatch-admitted'))
  const writeRun = (await ctx.orchestrations.list()).find(run => run.admission?.sourceSessionId === 'kennel-ai-write')!
  const writeSubmission = writeHandle.agent.session.events.find(event => event.type === 'kennel/dispatch-submission')!
  if (writeSubmission.type !== 'kennel/dispatch-submission') throw new Error('missing write submission')
  const writeStore = new OrchestrationStore(root)
  const writeCompiled = writeStore.getCompilation(writeSubmission.data.compilationId)
  if (writeCompiled.workspaceSnapshotRef === undefined) throw new Error('write compilation lacks private snapshot')
  const privateSnapshot = writeStore.readArtifact(writeCompiled.workspaceSnapshotRef) as WorkspaceSnapshot
  writeStore.close()
  const sourceBody = await readFile(join(workspace, 'README.md'), 'utf8')
  const snapshotBody = await readFile(join(privateSnapshot.workspace, 'README.md'), 'utf8')
  await waitFor(async () => writeHandle.agent.status === 'idle')
  requestSessions.set('cancel task', writeHandle.agent.session)
  writeHandle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'cancel task' }] }))
  await waitFor(async () => writeHandle.agent.session.events.some(event => event.type === 'kennel/dispatch-control'))
  const cancelled = (await ctx.orchestrations.list()).find(task => task.runId === writeRun.runId)!
  await ctx.sessions.flush(agent.session)
  await ctx.sessions.flush(writeHandle.agent.session)
  const durableRows = await readDurableRows(agent.session)
  const writeRows = await readDurableRows(writeHandle.agent.session)
  const response = await originalFetch(`http://127.0.0.1:${ctx.webServer.port}${GOUZI_DASHBOARD_PATH}?session_id=${String(agent.id)}`)
  const room = await response.json() as GouziRoomSnapshotV1
  process.stdout.write(`${JSON.stringify({
    modelCalls, persistedBeforeModel, persistedBeforeExecution,
    inspect: { exactOriginalRun: inspected.data.result.runId === run.runId, action: inspected.data.candidate.action,
      state: inspected.data.result.state },
    cancel: { exactWriteRun: cancelled.runId === writeRun.runId, state: cancelled.state,
      durableReceipt: writeRows.some(row => row.type === 'kennel/dispatch-control') },
    totalRunCount: (await ctx.orchestrations.list()).length,
    durableDispatchEvents: durableRows.filter(row => row.type.startsWith('kennel/dispatch-')).map(row => row.type),
    durableUserMessage: durableRows.some(row => row.type === 'user/message'),
    externalMethods: [...new Set(methods)].sort(),
    userText: agent.session.events.filter(event => event.type === 'user/message').map(event => event.data.content),
    dispatchEvents: agent.session.events.filter(event => event.type.startsWith('kennel/dispatch-'))
      .map(event => event.type),
    compiled: { risk: compiled.graph.risk, nodes: compiled.graph.nodes.map(node => ({
      id: node.id, readScopes: node.readScopes, writeScopes: node.writeScopes,
      effectBudget: node.effectBudget, operator: node.operator })) },
    admission: { sourceSessionId: run.admission?.sourceSessionId,
      sourceMessageMatches: run.admission?.sourceMessageId === submission.data.messageId,
      gouziRecipient: run.admission?.gouziRecipient,
      rlm: run.admission?.rlm, autonomous: run.admission?.autonomous },
    room: { status: response.status, tasks: room.tasks.map(task => ({ state: task.state,
      nodes: task.nodes.map(node => ({ state: node.state, gouziId: node.gouziId,
        result: node.result && {
          outputPreview: node.result.outputPreview, accepted: node.result.accepted,
          operatorId: node.result.operatorId, retainedEvidence: node.evidenceRefs.includes(node.result.evidenceRef) } })) })) },
    write: { state: writeRun.state, workspaceIsolation: writeCompiled.graph.workspaceIsolation,
      sourceMessageMatches: writeRun.admission?.sourceMessageId === writeSubmission.data.messageId,
      privateSnapshotRetained: privateSnapshot.source === workspace && privateSnapshot.workspace.startsWith(join(root, 'workspace-snapshots')),
      snapshotCopiesSource: snapshotBody === sourceBody, sourceBodyUnchanged: sourceBody === 'fixture baseline\n',
      risk: writeRun.certificate?.maximumRisk, requiresApproval: writeRun.certificate?.requiresApproval,
      verifier: { requiredForCompletion: writeCompiled.graph.nodes.find(node => node.id === 'verify')?.requiredForCompletion,
        acceptance: writeCompiled.graph.nodes.find(node => node.id === 'verify')?.acceptance },
      nodes: writeRun.nodes.map(node => ({ id: node.id, role: node.role, state: node.state, dependsOn: node.dependsOn })),
      hasWorkerResult: writeRun.nodes.some(node => node.evidenceRefs.length > 0) },
    executionCount: executed.length,
    executedModels: executed.map(request => (request.profile as { model?: string } | undefined)?.model ?? null),
    hasSealedGrant: executed.every((request) => {
      const { gouziGrant, protocol: _protocol, ...sealed } = request
      const grant = gouziGrant as GouziExecutionGrant
      return grant.planHash === gouziRequestHash(sealed as unknown as RemoteResidentExecuteRequest)
        && grant.gouziId === 'stable-dog' && grant.generation === 1
        && [...grant.scopes.read, ...grant.scopes.write, ...grant.scopes.effects].length === 0
    }),
    managerAssistantMessages: agent.session.events.filter(event => event.type === 'assistant/message').length,
  }, null, 2)}\n`)
  await writeHandle.dispose()
  await handle.dispose()
} finally {
  await ctx.fiber.dispose(); await daemon.close(); globalThis.fetch = originalFetch
}
