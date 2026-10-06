#!/usr/bin/env node
/** Real Loader/daemon composition; only the external Resident catalog is deterministic. */
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { GouziId, GouziHostId, GouziOwnerId, GouziAuthorityEpoch, type LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import { OrchestrationDaemon, OrchestrationStore, OrchestrationDaemonClient } from '@deepseek-ai/dsh-orchestration-local'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { encodeKennelMessage, decodeKennelMessage } from '@deepseek-ai/dsh-ui-gouzi/src/recipient-message.ts'
import { GOUZI_DASHBOARD_PATH, type GouziRoomSnapshotV1 } from '@deepseek-ai/dsh-ui-gouzi/src/contracts.ts'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-tool-orchestration'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) throw new Error('kennel fixture requires config and isolated DSH_HOME')
const root = join(home, 'orchestrations')
const registry = new OrchestrationStore(root)
registry.gouzi.pairHost({ hostId: GouziHostId('keyless-host'), label: 'Keyless host', authorityEpoch: GouziAuthorityEpoch('keyless-epoch'), credentialRef: 'KENNEL_FIXTURE_TOKEN' })
registry.gouzi.create({ gouziId: GouziId('stable-dog'), ownerId: GouziOwnerId('main'), hostId: GouziHostId('keyless-host'), name: 'Original', avatarId: 'shiba', role: 'research', grantDeadlineMs: 60_000 })
registry.gouzi.setMembership(GouziId('stable-dog'), 'enabled')
registry.gouzi.setEndpoint(GouziId('stable-dog'), 'http://127.0.0.1:13301')
registry.gouzi.edit(GouziId('stable-dog'), { name: 'Renamed' })
registry.close()
const originalFetch = globalThis.fetch
const remoteMethods: string[] = []
let available = true
const provider = {
  operatorId: 'claude-code', product: 'claude-code', displayName: 'Keyless Claude', description: 'Keyless external catalog',
  tags: ['analysis'], maxConcurrency: 1, injectionBoundaries: [], available: true,
  authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture',
  models: [{ model: 'claude-sonnet-4-6', displayName: 'Sonnet', description: 'Fixture', supportedEfforts: [], isDefault: true, supportsAdaptiveThinking: true }],
}
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('http://127.0.0.1:13301/remote-sync/')) return originalFetch(input, init)
  if (typeof init?.body !== 'string') throw new Error('fixture remote call requires a JSON string body')
  const parsed: unknown = JSON.parse(init.body)
  const call = parsed as { rpcId: string; method: string }
  remoteMethods.push(call.method)
  if (call.method !== 'operator.providers') throw new Error(`unexpected external dispatch ${call.method}`)
  return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value: available ? [provider] : [] } })
}
const resident = { providers: async () => [], execute: async () => { throw new Error('unexpected local fallback') } }
const daemon = new OrchestrationDaemon({
  root, dshHome: home, residentClient: resident as unknown as ResidentDaemonClient,
  modelWorkerProviders: [], schedulerIntervalMs: 60_000,
})
await daemon.start()
const ctx = await boot('kennel-room-keyless', resolveConfigPath(configPath, undefined))
try {
  const handle = await ctx.agents.create({ sessionId: SessionId('kennel-room-a'), meta: { cwd: home } })
  const agent = handle.agent
  const user = (text: string, turn: number) => {
    agent.session.append('turn/start', { turn })
    agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  }
  user('Ask the manager an ordinary question.', 1)
  const ordinary = await ctx.get('orchestrationRecipients')!.resolve(agent.session.events)
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  agent.session.append('orchestration/preferences', { rlm: 'enabled', autonomous: 'enabled', continualHarness: 'off', optimization: 'balanced', plannerVerifierPreference: 'best-high-tier', executionPreference: 'balanced' }, { ignorable: true })
  const member = (await ctx.orchestrations.gouzi!.list()).members[0]!
  const marker = encodeKennelMessage('Read the bounded fixture.', { gouziId: String(member.gouziId), generation: member.generation, mode: 'standard' })
  user(marker, 2)
  const injectedInputs = ['Current time: fixture-only context.', encodeKennelMessage('Injected alternate target.', { gouziId: 'another-dog', generation: 9, mode: 'standard' })]
  for (const text of injectedInputs) agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'kennel-fixture-context' } }), { surfaceOp: 'append' })
  const recipient = await ctx.get('orchestrationRecipients')!.resolve(agent.session.events)
  const graph: LogicalTaskGraphV1 = {
    version: 1, title: 'Bounded kennel read', workspace: home, maxParallel: 1, risk: 'medium',
    nodes: [{
      id: 'read', title: 'Read fixture', task: 'Read the bounded fixture without changes.',
      role: 'analysis', dependsOn: [], requiredForCompletion: true,
      capabilityRequirements: [], capabilityBudget: [], contextPolicy: { maxTokens: 4096, allowedSourceKinds: ['intent', 'artifact', 'capsule'], unavailableSource: 'block' },
      effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
      readScopes: [], writeScopes: [], approvedSecretRefs: [],
      acceptance: [{ id: 'done', description: 'Operator completes', kind: 'operator-completed' }], retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableCodes: [] },
      operator: { preferredIds: ['wrong-executor'], fallbackIds: ['codex'] },
    }],
  }
  const callId = 'kennel-fixed-start'
  const started = await ctx.tools.execute({ name: 'orchestration', arguments: { action: 'start', objective: 'Read the bounded fixture.', graph_json: JSON.stringify(graph) }, agent, callId: CallId(callId), signal: new AbortController().signal })
  if (started.isError) throw new Error(JSON.stringify(started))
  const run = (await ctx.orchestrations.list())[0]!
  const compilationId = (started.value as { compilationId: string }).compilationId
  const retained = new OrchestrationStore(root)
  const compiled = retained.getCompilation(compilationId)
  retained.close()
  const direct = await ctx.tools.execute({ name: 'physical_operator', arguments: { action: 'run', operator_id: 'codex', description: 'Forbidden relay', prompt: 'Do not dispatch directly.' }, agent, callId: CallId('direct-relay'), signal: new AbortController().signal })
  const client = new OrchestrationDaemonClient({ root, dshHome: home, autoStart: false, connectTimeoutMs: 2000 })
  // Discard the known first reply at the caller boundary, then reconcile its original command receipt.
  const reconciled = await client.start({ compilationId, commandId: `orchestration:start:${String(agent.id)}:${callId}` })
  const roomUrl = `http://127.0.0.1:${ctx.webServer.port}${GOUZI_DASHBOARD_PATH}`
  const roomReply = await originalFetch(`${roomUrl}?session_id=${String(agent.id)}`)
  const room = await roomReply.json() as GouziRoomSnapshotV1
  const other = await originalFetch(`${roomUrl}?session_id=kennel-room-b`)
  const otherRoom = await other.json() as GouziRoomSnapshotV1
  const crossRoom = await originalFetch(`${roomUrl}?session_id=kennel-room-b&run_id=${String(run.runId)}&evidence_ref=unretained`)
  available = false
  const offline = await ctx.tools.execute({ name: 'orchestration', arguments: { action: 'start', objective: 'Do not replace this dog.', graph_json: JSON.stringify(graph) }, agent, callId: CallId('offline'), signal: new AbortController().signal })
  const listed = await ctx.tools.execute({ name: 'orchestration', arguments: { action: 'inspect', run_id: String(run.runId) }, agent, callId: CallId('inspect-original'), signal: new AbortController().signal })
  const admission = agent.session.events.find(event => event.type === 'orchestration/admission')
  process.stdout.write(`${JSON.stringify({
    ordinaryRecipient: ordinary ?? null,
    durableUserMessage: decodeKennelMessage(marker), recipient,
    ignoredPluginInputs: injectedInputs.map(text => decodeKennelMessage(text)),
    start: {
      state: run.state, sourceSessionId: run.admission?.sourceSessionId, gouziRecipient: run.admission?.gouziRecipient,
      rlm: run.admission?.rlm, autonomous: run.admission?.autonomous, maxParallel: run.maxParallel,
    },
    compiledOperators: compiled.graph.nodes.map(node => node.operator),
    admission: admission?.data,
    directRelay: { isError: direct.isError, message: direct.isError ? direct.error.message : null },
    room: {
      status: roomReply.status, sessionId: room.sessionId, tasks: room.tasks.map(task => ({
        state: task.state, nodes: task.nodes.map(node => ({
          nodeId: node.nodeId, state: node.state, hasResult: node.result !== undefined, hasAttributedDog: node.gouziId !== undefined,
        })),
      })),
    },
    otherRoomTasks: otherRoom.tasks.length, crossRoomStatus: crossRoom.status,
    noEntry: { isError: offline.isError, message: offline.isError ? offline.error.message : null },
    originalRunQueryableWhileOffline: !listed.isError,
    reconciledOriginalReceipt: reconciled.runId === run.runId,
    runCountAfterReconciliationAndRefusal: (await ctx.orchestrations.list()).length,
    externalDispatches: remoteMethods.filter(method => method !== 'operator.providers'),
  }, (_key: string, value: unknown) => _key === 'runId' ? '<run-id>' : value, 2)}\n`)
  await handle.dispose()
} finally {
  await ctx.fiber.dispose()
  await daemon.close()
  globalThis.fetch = originalFetch
}
