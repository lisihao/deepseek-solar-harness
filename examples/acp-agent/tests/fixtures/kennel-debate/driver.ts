#!/usr/bin/env node
/** Real Loader/daemon composition; only the members' external execution and the dispatch model are deterministic. */
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { gouziRequestHash, type RemoteResidentExecuteRequest } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
import { GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId, type GouziExecutionGrant } from '@deepseek-ai/dsh-orchestration'
import { OrchestrationDaemon, OrchestrationStore } from '@deepseek-ai/dsh-orchestration-local'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { GOUZI_DASHBOARD_PATH, type GouziRoomSnapshotV1 } from '@deepseek-ai/dsh-ui-gouzi/src/contracts.ts'
import type {} from '@deepseek-ai/dsh-debate'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) throw new Error('kennel debate fixture requires config and isolated DSH_HOME')
const projectPath = join(home, 'project')
await mkdir(projectPath, { recursive: true })
const workspace = await realpath(projectPath)
const root = join(home, 'orchestrations')
// The message names the members in the reverse of registry order, which fixes the Debate roles: proposer, falsifier, judge.
const ports: Record<string, number> = { alpha: 13321, beta: 13322, gamma: 13323 }
const registry = new OrchestrationStore(root)
registry.gouzi.pairHost({ hostId: GouziHostId('local'), label: 'Keyless host', authorityEpoch: GouziAuthorityEpoch('keyless-epoch'), credentialRef: 'KENNEL_FIXTURE_TOKEN' })
for (const [id, port] of Object.entries(ports)) {
  registry.gouzi.create({ gouziId: GouziId(id), ownerId: GouziOwnerId('main'), hostId: GouziHostId('local'), name: id, avatarId: 'shiba', role: 'research', grantDeadlineMs: 60_000 })
  registry.gouzi.setMembership(GouziId(id), 'enabled')
  registry.gouzi.setEndpoint(GouziId(id), `http://127.0.0.1:${String(port)}`)
}
registry.gouzi.edit(GouziId('gamma'), { model: 'gpt-5.6-luna' })
registry.close()

const originalFetch = globalThis.fetch
const methods: string[] = []
const executed: { member: string; slotId: string; request: Record<string, unknown> }[] = []
const results = new Map<string, unknown>()
const errors: unknown[] = []
const turnBody = (slotId: string) => JSON.stringify({
  confidence: 0.9, outputPreview: `settled ${slotId}`,
  claims: [{
    version: 1, claimId: 'claim:decision', statement: 'The reversible option is preferred.', status: 'supported',
    severity: 'medium', confidence: 0.9, supportingSlotIds: [slotId], opposingSlotIds: [],
    evidenceRefs: [{ version: 1, ref: `fixture:${slotId}`, kind: 'artifact' }],
  }],
  dissent: [], unresolved: [], evidenceRefs: [{ version: 1, ref: `fixture:${slotId}`, kind: 'artifact' }],
})
const provider = (member: string) => ({
  operatorId: 'codex', product: 'codex', displayName: 'Fixture Codex', description: 'External worker fixture',
  tags: ['analysis'], maxConcurrency: 2, injectionBoundaries: [], available: true,
  supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true,
  authentication: 'native-subscription', productVersion: 'fixture', protocolHash: 'fixture',
  models: [
    { model: 'gpt-5.6-luna', displayName: 'Luna', description: 'Worker', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: false, supportsAdaptiveThinking: true },
    { model: 'gpt-5.6-sol', displayName: 'Sol', description: 'Worker', supportedEfforts: ['medium'], defaultEffort: 'medium', isDefault: true, supportsAdaptiveThinking: true },
  ],
  gouziWorkspace: { gouziId: member, generation: 1, projectId: 'a'.repeat(64), projectScopes: [workspace] },
})
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const member = Object.entries(ports).find(([, port]) => url.startsWith(`http://127.0.0.1:${String(port)}/remote-sync/`))?.[0]
  if (member === undefined) return originalFetch(input, init)
  if (typeof init?.body !== 'string') throw new Error('remote body must be JSON text')
  const call = JSON.parse(init.body) as { rpcId: string; method: string; payload: Record<string, unknown> }
  methods.push(call.method)
  let value: unknown
  switch (call.method) {
    case 'operator.providers': value = [provider(member)]; break
    case 'operator.execute': {
      const commandId = String(call.payload.commandId)
      const slotId = /:debate-r\d+-([^:]+):1$/u.exec(commandId)?.[1]
      if (slotId === undefined) throw new Error(`cannot identify the Debate slot in ${commandId}`)
      executed.push({ member, slotId, request: call.payload })
      const turnId = `turn:${commandId}`
      results.set(turnId, {
        commandId, sessionId: `session:${member}`, turnId, state: 'settled', stateRevision: 2, updatedAt: '2026-10-09T00:00:00.000Z',
        result: {
          output: [{ type: 'text', text: turnBody(slotId) }], stopReason: 'completed',
          usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, costUsd: 0.01 },
        },
      })
      value = {
        sessionId: `session:${member}`, turnId, stateRevision: 1,
        contextReceipt: {
          version: 1, digest: (call.payload.contextEnvelope as { digest: string }).digest, receiver: 'remote-resident:codex',
          outcome: 'accepted', format: 'native', roleFidelity: 'native',
        },
      }
      break
    }
    case 'operator.inspect': value = results.get((call.payload as { turnId: string }).turnId); break
    case 'operator.events': value = { events: [], nextSequence: 0 }; break
    default: throw new Error(`unexpected remote method ${call.method}`)
  }
  return Response.json({ type: 'server-response', rpcId: call.rpcId, result: { ok: true, value } })
}
const resident = { providers: async () => [], execute: async () => { throw new Error('unexpected local fallback') } }
const daemon = new OrchestrationDaemon({ root, dshHome: home, residentClient: resident as unknown as ResidentDaemonClient,
  modelWorkerProviders: [], schedulerIntervalMs: 10 })
await daemon.start()
const ctx = await boot('kennel-debate-keyless', resolveConfigPath(configPath, undefined))
ctx.on('agent/error', ({ error }) => { errors.push(error) })
let modelCalls = 0
const offered: { kind: string; collaboration?: string; members?: { gouziId: string; operatorId: string; model: string }[] }[] = []
class Judgment extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    modelCalls++
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('missing judgment request')
    const input = JSON.parse(block.text) as {
      candidates: { kind: string; collaboration?: string; id: string; members?: { gouziId: string; operatorId: string; model: string }[] }[]
    }
    const isDebate = (candidate: { kind: string; collaboration?: string }) => candidate.kind === 'collaboration' && candidate.collaboration === 'debate'
    offered.push(...input.candidates.filter(isDebate))
    const debate = input.candidates.find(isDebate)
    if (!debate) throw new Error('no Debate candidate')
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidateId: debate.id }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['deepseek-official'], new Judgment())
const waitFor = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 20000
  while (!await check()) {
    if (errors.length) throw errors[0]
    if (Date.now() > deadline) throw new Error('fixture timeout: ' + JSON.stringify({ runs: await ctx.orchestrations.list(), methods, executed: executed.map(value => value.slotId) }))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  const handle = await ctx.agents.create({ sessionId: SessionId('kennel-debate-a'), meta: { cwd: workspace } })
  const agent = handle.agent
  agent.session.append('agent-preset/selected', { agentPreset: 'kennel' })
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Debate: gamma, alpha and beta, should we keep the reversible option?' }] }))
  await waitFor(async () => agent.session.events.some(event => event.type === 'kennel/dispatch-collaboration-admitted'))
  const terminal = new Set(['completed', 'max_rounds', 'budget_limited', 'failed', 'stopped', 'indeterminate'])
  await waitFor(async () => {
    const [summary] = await ctx.debates.list()
    return summary !== undefined && terminal.has(summary.state)
  })
  await waitFor(async () => agent.status === 'idle')
  const [summary] = await ctx.debates.list()
  const debate = await ctx.debates.inspect(summary!.runId)
  const runs = await ctx.orchestrations.list()
  const requested = agent.session.events.find(event => event.type === 'kennel/dispatch-collaboration')
  const admitted = agent.session.events.find(event => event.type === 'kennel/dispatch-collaboration-admitted')
  if (requested?.type !== 'kennel/dispatch-collaboration' || admitted?.type !== 'kennel/dispatch-collaboration-admitted') throw new Error('missing Debate dispatch events')
  const response = await originalFetch(`http://127.0.0.1:${ctx.webServer.port}${GOUZI_DASHBOARD_PATH}?session_id=${String(agent.id)}`)
  const room = await response.json() as GouziRoomSnapshotV1
  process.stdout.write(`${JSON.stringify({
    modelCalls,
    dispatchEvents: agent.session.events.filter(event => event.type.startsWith('kennel/dispatch-')).map(event => event.type),
    offered: offered.map(candidate => candidate.members),
    started: {
      members: requested.data.candidate.members.map(({ gouziId, operatorId, model }) => ({ gouziId, operatorId, model })),
      assignments: admitted.data.assignments },
    debate: { state: debate.state, mode: debate.mode, rounds: debate.rounds.length,
      roster: debate.roster.map(role => [role.role, role.kind, role.operatorId, role.model]),
      settledTurns: debate.rounds.flatMap(round => round.turns).filter(turn => turn.state === 'settled').length,
      sourceSessionBound: runs.every(run => run.admission?.sourceSessionId === 'kennel-debate-a') },
    orchestrationRuns: runs.map(run => ({
      state: run.state,
      recipients: (run.admission?.gouziRecipients ?? []).map(recipient => ({
        gouziId: recipient.gouziId, generation: recipient.generation, operatorIds: recipient.operatorIds,
      })),
      singular: run.admission?.gouziRecipient ?? null,
      rlm: run.admission?.rlm,
      autonomous: run.admission?.autonomous,
    })),
    executed: executed
      .map(value => ({
        member: value.member,
        slotId: value.slotId,
        model: (value.request.profile as { model?: string } | undefined)?.model ?? null,
      }))
      .sort((left, right) => left.slotId.localeCompare(right.slotId) || left.member.localeCompare(right.member)),
    externalMethods: [...new Set(methods)].sort(),
    hasSealedGrant: executed.every(({ member, request }) => {
      const { gouziGrant, protocol: _protocol, ...sealed } = request
      const grant = gouziGrant as GouziExecutionGrant
      return grant.planHash === gouziRequestHash(sealed as unknown as RemoteResidentExecuteRequest)
        && grant.gouziId === member && grant.generation === 1
        && [...grant.scopes.read, ...grant.scopes.write, ...grant.scopes.effects].length === 0
    }),
    // What the room lists for each collaboration: names for people, the task it is about, and who did what.
    roomCollaborations: (room.collaborations ?? []).map(collaboration => ({
      label: collaboration.label, state: collaboration.state, subject: collaboration.subject?.title, outcome: collaboration.outcome?.label,
      members: collaboration.members.map(member => [member.gouziId, member.roleLabel, member.conclusion]),
    })),
    room: { status: response.status, tasks: room.tasks.map(task => ({ state: task.state,
      nodes: task.nodes.map(node => ({ gouziId: node.gouziId, state: node.state, accepted: node.result?.accepted })) })) },
    managerAssistantMessages: agent.session.events.filter(event => event.type === 'assistant/message').length,
  }, null, 2)}\n`)
  await handle.dispose()
} finally {
  await ctx.fiber.dispose(); await daemon.close(); globalThis.fetch = originalFetch
}
