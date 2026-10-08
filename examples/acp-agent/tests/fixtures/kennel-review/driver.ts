#!/usr/bin/env node
/** Real Loader/daemon composition; only the members' external execution and the dispatch model are deterministic. */
import { mkdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  admissionGouziRecipients, GouziAuthorityEpoch, GouziHostId, GouziId, GouziOwnerId,
  type GouziExecutionGrant, type OrchestrationAdmissionTraceV1,
} from '@deepseek-ai/dsh-orchestration'
import { OrchestrationDaemon, OrchestrationStore } from '@deepseek-ai/dsh-orchestration-local'
import type { ResidentDaemonClient } from '@deepseek-ai/dsh-resident-operator-local'
import { GOUZI_DASHBOARD_PATH, type GouziRoomSnapshotV1 } from '@deepseek-ai/dsh-ui-gouzi/src/contracts.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'

const configPath = process.argv[2]
const home = process.env.DSH_HOME
if (configPath === undefined || home === undefined) throw new Error('kennel review fixture requires config and isolated DSH_HOME')
const projectPath = join(home, 'project')
await mkdir(projectPath, { recursive: true })
const workspace = await realpath(projectPath)
const root = join(home, 'orchestrations')
// Registry order is creation order: alpha does the work, then beta and gamma review it.
const ports: Record<string, number> = { alpha: 13331, beta: 13332, gamma: 13333 }
const registry = new OrchestrationStore(root)
registry.gouzi.pairHost({ hostId: GouziHostId('local'), label: 'Keyless host', authorityEpoch: GouziAuthorityEpoch('keyless-epoch'), credentialRef: 'KENNEL_FIXTURE_TOKEN' })
for (const [id, port] of Object.entries(ports)) {
  registry.gouzi.create({ gouziId: GouziId(id), ownerId: GouziOwnerId('main'), hostId: GouziHostId('local'), name: id, avatarId: 'shiba', role: 'research', grantDeadlineMs: 60_000 })
  registry.gouzi.setMembership(GouziId(id), 'enabled')
  registry.gouzi.setEndpoint(GouziId(id), `http://127.0.0.1:${String(port)}`)
}
registry.gouzi.edit(GouziId('gamma'), { model: 'gpt-5.6-luna' })
registry.close()

const WORK_RESULT = 'The parser lives in src/parse.ts and handles empty input.'
const originalFetch = globalThis.fetch
const methods: string[] = []
const executed: { member: string; nodeId: string; request: Record<string, unknown> }[] = []
const results = new Map<string, unknown>()
const errors: unknown[] = []
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
      const nodeId = /:(work|review-\d+):\d+$/u.exec(commandId)?.[1]
      if (nodeId === undefined) throw new Error(`cannot identify the node in ${commandId}`)
      executed.push({ member, nodeId, request: call.payload })
      const turnId = `turn:${commandId}`
      const text = nodeId === 'work' ? WORK_RESULT : `结论：通过\n- ${member} 核对了 src/parse.ts，空输入有处理。`
      results.set(turnId, {
        commandId, sessionId: `session:${member}`, turnId, state: 'settled', stateRevision: 2, updatedAt: '2026-10-09T00:00:00.000Z',
        result: { output: [{ type: 'text', text }], stopReason: 'completed', usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, costUsd: 0.01 } },
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
const ctx = await boot('kennel-review-keyless', resolveConfigPath(configPath, undefined))
ctx.on('agent/error', ({ error }) => { errors.push(error) })

interface Choice {
  kind: string
  collaboration?: string
  id: string
  gouziId?: string
  mode?: string
  members?: { gouziId: string; operatorId: string; model: string }[]
  details?: { target?: { title: string; authors: string[] } }
}
const offeredReviews: { target: unknown; reviewers: string[] }[] = []
let modelCalls = 0
class Judgment extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    modelCalls++
    const block = options.messages[0]?.content[0]
    if (block?.type !== 'text') throw new Error('missing judgment request')
    const input = JSON.parse(block.text) as { candidates: Choice[] }
    const review = input.candidates.find(candidate => candidate.collaboration === 'review')
    // The first message has no finished task to review, so the AI hands the work to alpha.
    const chosen = review ?? input.candidates.find(candidate => candidate.kind === 'work' && candidate.gouziId === 'alpha' && candidate.mode === 'read')
    if (review !== undefined) {
      offeredReviews.push(...input.candidates.filter(candidate => candidate.collaboration === 'review').map(candidate => ({
        target: { title: candidate.details?.target?.title, authors: candidate.details?.target?.authors },
        reviewers: (candidate.members ?? []).map(value => value.gouziId),
      })))
    }
    if (!chosen) throw new Error('no candidate to choose')
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ candidateId: chosen.id }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
ctx.llm.registerAdapter(['deepseek-official'], new Judgment())
const waitFor = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + 20000
  while (!await check()) {
    if (errors.length) throw errors[0]
    if (Date.now() > deadline) throw new Error('fixture timeout: ' + JSON.stringify({ runs: await ctx.orchestrations.list(), methods, executed: executed.map(value => value.nodeId) }))
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
try {
  const handle = await ctx.agents.create({ sessionId: SessionId('kennel-review-a'), meta: { cwd: workspace } })
  const agent = handle.agent
  agent.session.append('agent-preset/selected', { agentPreset: 'kennel' })
  const say = (text: string): void => {
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }
  const finished = async () => (await ctx.orchestrations.list()).every(run => run.state === 'completed') && agent.status === 'idle'
  say('Summarize the parser for me.')
  await waitFor(async () => agent.session.events.some(event => event.type === 'kennel/dispatch-admitted'))
  await waitFor(async () => (await ctx.orchestrations.list()).some(run => run.state === 'completed') && finished())
  say('Ask the other dogs to review that result.')
  await waitFor(async () => agent.session.events.some(event => event.type === 'kennel/dispatch-collaboration-admitted'))
  await waitFor(async () => (await ctx.orchestrations.list()).length === 2 && finished())
  const runs = (await ctx.orchestrations.list()).sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const requested = agent.session.events.find(event => event.type === 'kennel/dispatch-collaboration')
  const admitted = agent.session.events.find(event => event.type === 'kennel/dispatch-collaboration-admitted')
  if (requested?.type !== 'kennel/dispatch-collaboration' || admitted?.type !== 'kennel/dispatch-collaboration-admitted') throw new Error('missing collaboration dispatch events')
  const response = await originalFetch(`http://127.0.0.1:${ctx.webServer.port}${GOUZI_DASHBOARD_PATH}?session_id=${String(agent.id)}`)
  const room = await response.json() as GouziRoomSnapshotV1
  const reviewTasks = executed.filter(value => value.nodeId.startsWith('review-'))
  process.stdout.write(`${JSON.stringify({
    modelCalls,
    dispatchEvents: agent.session.events.filter(event => event.type.startsWith('kennel/dispatch-')).map(event => event.type),
    offeredReviews,
    started: {
      collaboration: admitted.data.collaboration,
      reviewers: requested.data.candidate.members.map(({ gouziId, operatorId, model }) => ({ gouziId, operatorId, model })),
      assignments: admitted.data.assignments },
    orchestrationRuns: runs.map(run => ({
      state: run.state, nodes: run.nodes.map(node => `${node.id}:${node.state}`),
      recipients: admissionRecipients(run.admission),
    })),
    executed: executed
      .map(value => ({
        member: value.member,
        nodeId: value.nodeId,
        model: (value.request.profile as { model?: string } | undefined)?.model ?? null,
      }))
      .sort((left, right) => left.nodeId.localeCompare(right.nodeId) || left.member.localeCompare(right.member)),
    // A reviewer may read the workspace but its sealed grant carries no write or effect scope.
    reviewGrants: reviewTasks.map((value) => {
      const { scopes } = value.request.gouziGrant as GouziExecutionGrant
      return { read: scopes.read, write: scopes.write, effects: scopes.effects }
    }),
    reviewersReadTheResult: reviewTasks.length === 2 && reviewTasks.every(value => JSON.stringify(value.request).includes(WORK_RESULT)),
    externalMethods: [...new Set(methods)].sort(),
    room: { status: response.status, tasks: room.tasks.map(task => ({ state: task.state,
      nodes: task.nodes.map(node => ({
        gouziId: node.gouziId, state: node.state, accepted: node.result?.accepted, preview: node.result?.outputPreview,
      })) })) },
    managerAssistantMessages: agent.session.events.filter(event => event.type === 'assistant/message').length,
  }, null, 2)}\n`)
  await handle.dispose()
} finally {
  await ctx.fiber.dispose(); await daemon.close(); globalThis.fetch = originalFetch
}

function admissionRecipients(admission: Pick<OrchestrationAdmissionTraceV1, 'gouziRecipient' | 'gouziRecipients'> | undefined): string[] {
  return admissionGouziRecipients(admission).map(value => String(value.gouziId))
}
