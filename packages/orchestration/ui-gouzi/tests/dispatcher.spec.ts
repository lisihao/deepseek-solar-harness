/** Fixed kennel inbox admission with externally generated judgments. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import {
  GouziId, OrchestrationRunId, type KennelCollaborationCandidate, type KennelCollaborationFacts, type KennelCollaborationKind,
  type KennelCollaborationRequest, type KennelCollaborationStarted, type OrchestrationRunSnapshot,
} from '@deepseek-ai/dsh-orchestration'
import { expect, it, vi } from 'vitest'
import { KennelCollaborationRegistry } from '../src/collaboration.ts'
import { Config } from '../src/index.ts'
import { installKennelDispatch, kennelDispatchGraph, parseDispatchSelection, type KennelWorkCandidate, type KennelDispatchConfig } from '../src/dispatcher.ts'
import { encodeKennelMessage } from '../src/recipient-message.ts'
const config: KennelDispatchConfig = { ...Config({}).dispatcher!, deepseek: { ...Config({}).dispatcher!.deepseek, model: 'fixture' }, timeoutMs: 1000 }
const candidate: KennelWorkCandidate = { kind: 'work', id: '["dog",2,"/project","chat"]', gouziId: 'dog', generation: 2, name: 'Dog', role: 'research', activity: 'idle', workspace: '/project', mode: 'chat', operatorIds: ['gouzi.dog.codex'] }
class Adapter extends LlmAdapter {
  constructor(readonly generate: (options: GenerateOptions) => string) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: this.generate(options) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
async function fixture(persisted = true) {
  const ctx = new Context(); await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore)
  const registry = new KennelCollaborationRegistry(ctx)
  const session = ctx.sessions.create(SessionId('dispatch-fixture')); session.append('agent-preset/selected', { agentPreset: 'kennel' })
  const agent = { id: 'agent', session } as unknown as Agent
  const member = { hostId: 'local', gouziId: 'dog', generation: 2, membership: 'enabled', name: 'Dog', role: 'research', activity: 'idle' }
  const entry = { gouziId: 'dog', generation: 2, projectScopes: ['/project'], operators: [{ operatorId: 'gouzi.dog.codex', available: true,
    supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true, models: [] as string[] }] }
  const compile = vi.fn(async (_request: unknown) => ({ compilationId: 'compiled' })); const start = vi.fn(async (_request: unknown) => ({ runId: 'run' }))
  const list = vi.fn(async (): Promise<readonly OrchestrationRunSnapshot[]> => [])
  const inspect = vi.fn(async (_id: unknown): Promise<OrchestrationRunSnapshot> => existingRun())
  const control = vi.fn(async (_request: unknown): Promise<OrchestrationRunSnapshot> => existingRun())
  const persist = vi.fn(async (_session: typeof session) => {})
  const members: (typeof member)[] = [member]; const entries: (typeof entry)[] = [entry]
  if (persisted) ctx.on('session/flush', persist)
  ctx.provide('orchestrations', { gouzi: { list: async () => ({ members, hosts: [] }), executionOperators: async () => entries }, compile, start, list, inspect, control,
    readEvents: async () => ({ events: [], nextSequence: 0 }) } as never)
  const generate = vi.fn((_options: GenerateOptions) => JSON.stringify({ candidateId: candidate.id }))
  ctx.llm.registerAdapter(['deepseek-official'], new Adapter(generate))
  await ctx.plugin(Object.assign((child: Context) => { installKennelDispatch(child, config) }, { inject: ['sessions'] }))
  const controller = new AbortController(); const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
  const run = (messages: UserMessage[] = [message]) => ctx.waterfall('agent/pre-step', { agent, signal: controller.signal, turn: 1, step: 1 } as never, async () => ({ kind: 'enter' as const, messages }))
  return {
    ctx, registry, agent, member, entry, members, entries, compile, start, generate, controller, message, run, list, inspect, control,
    persist,
  }
}
it('fills nested dispatcher defaults for Config({})', () => {
  expect(Config({}).dispatcher).toMatchObject({ enabled: true, jevProvider: 'Jev', deepseek: { provider: 'deepseek-official', model: 'deepseek-flash' }, codex: { operatorId: 'codex' } })
})
it('accepts only a supplied identity or clarification', () => {
  expect(parseDispatchSelection('{"candidateId":"clarify"}', [candidate])).toBeNull()
  for (const text of ['null', '[]', '{"candidateId":"invented"}', '{"candidateId":"clarify","plan":[]}']) expect(() => parseDispatchSelection(text, [candidate])).toThrow()
})
it('gives chat no file or effect permissions and writes a completion-critical verifier', () => {
  const chat = kennelDispatchGraph(candidate, 'hello', config)
  expect(chat.risk).toBe('low')
  expect(chat.nodes[0]).toMatchObject({ readScopes: [], writeScopes: [],
    effectBudget: { read: [], write: [], execute: [], network: [], cost: [], risk: [] },
    operator: { preferredIds: candidate.operatorIds, fallbackIds: [] } })
  const write = kennelDispatchGraph({ ...candidate, mode: 'write' }, 'change it', config)
  expect(write).toMatchObject({ risk: 'high', workspaceIsolation: 'directory-snapshot',
    workspaceSnapshotLimits: config.workspaceSnapshotLimits, qualityPolicy: { independentVerification: 'required' } })
  expect(write.nodes[0]).toMatchObject({ generationLimits: config.taskGenerationLimits, workspaceToolLimits: config.workspaceToolLimits })
  expect(write.nodes[1]).toMatchObject({ id: 'verify', dependsOn: ['work'], requiredForCompletion: true, role: 'verification', writeScopes: [],
    acceptance: [{ id: 'verification', kind: 'model-verdict' }] })
  expect(write.nodes[1]!.task).toContain('没有实际证据时 accepted 必须为 false')
})
it('logs real input and model evidence before compiling a fixed dog, then rejects manager execution', async () => {
  const f = await fixture(); expect(await f.run()).toEqual({ kind: 'reject' })
  expect(f.generate).toHaveBeenCalledOnce()
  expect(f.compile.mock.calls[0]?.[0]).toMatchObject({ admission: { sourceMessageId: String(f.message.id), gouziRecipient: { gouziId: 'dog', generation: 2, operatorIds: candidate.operatorIds },
    rlm: 'disabled', autonomous: 'disabled' } })
  expect(f.start).toHaveBeenCalledWith({ compilationId: 'compiled', commandId: `kennel:start:agent:${String(f.message.id)}` })
  expect(f.agent.session.events.map(e => e.type)).toEqual(['agent-preset/selected', 'user/message', 'kennel/dispatch-request', 'kennel/dispatch-model', 'kennel/dispatch-model', 'kennel/dispatch-decision', 'kennel/dispatch-submission', 'kennel/dispatch-admitted'])
})
it.each(['wrong', 'stale', 'project', 'entry'])('does not replace an unavailable %s target', async (reason) => {
  const f = await fixture()
  if (reason === 'project') f.entry.projectScopes = []
  if (reason === 'entry') f.entry.operators[0]!.available = false
  const messages = reason === 'wrong' || reason === 'stale' ? [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: encodeKennelMessage('hello', { gouziId: reason === 'wrong' ? 'other' : 'dog', generation: reason === 'stale' ? 1 : 2, mode: 'standard' }) }] })] : undefined
  await expect(f.run(messages)).rejects.toMatchObject({ code: 'GOUZI_NO_EXECUTOR' })
  expect(f.generate).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})
it('rejects invented identities and freshly changed registrations', async () => {
  const f = await fixture(); f.generate.mockReturnValue('{"candidateId":"invented"}')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_INVALID_DECISION' }); expect(f.compile).not.toHaveBeenCalled()
  const g = await fixture()
  g.generate.mockImplementation(() => { g.member.generation++; return JSON.stringify({ candidateId: candidate.id }) })
  await expect(g.run()).rejects.toMatchObject({ code: 'GOUZI_STATE_CONFLICT' }); expect(g.compile).not.toHaveBeenCalled()
})
it('does not replay a repeated source message after unknown start effect', async () => {
  const f = await fixture(); f.start.mockRejectedValue(new Error('reply lost'))
  await expect(f.run()).rejects.toThrow('reply lost')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_DISPATCH_UNCONFIRMED' })
  expect(f.start).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledOnce()
})
it('honors cancellation before model and after selection', async () => {
  const f = await fixture(); f.controller.abort(new Error('cancelled'))
  await expect(f.run()).rejects.toThrow('cancelled'); expect(f.generate).not.toHaveBeenCalled()
  const g = await fixture(); g.generate.mockImplementation(() => { g.controller.abort(new Error('cancelled')); return JSON.stringify({ candidateId: candidate.id }) })
  await expect(g.run()).rejects.toThrow('cancelled'); expect(g.compile).not.toHaveBeenCalled()
})
it('leaves plugin input and non-kennel sessions to the normal loop', async () => {
  const f = await fixture(); const plugin = createUserMessage({ source: { kind: 'plugin', plugin: 'fixture' }, content: [{ type: 'text', text: 'hello' }] })
  expect(await f.run([plugin])).toEqual({ kind: 'enter', messages: [plugin] })
  f.agent.session.append('agent-preset/selected', { agentPreset: 'standard' })
  expect(await f.run()).toEqual({ kind: 'enter', messages: [f.message] })
  expect(f.generate).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it('uses a product-registered Jev catalog before DeepSeek and refuses an empty catalog', async () => {
  const f = await fixture()
  const judgment = vi.fn(() => JSON.stringify({ candidateId: candidate.id }))
  const adapter = new Adapter(judgment)
  vi.spyOn(adapter, 'listModels').mockResolvedValue([{ provider: 'Jev', id: 'configured-jev', name: 'Configured Jev' }])
  f.ctx.llm.registerAdapter(['Jev'], adapter)
  expect(await f.run()).toEqual({ kind: 'reject' })
  expect(judgment).toHaveBeenCalledOnce(); expect(f.generate).not.toHaveBeenCalled()
  expect(f.agent.session.events.find(event => event.type === 'kennel/dispatch-decision')?.data)
    .toMatchObject({ source: 'jev', provider: 'Jev', model: 'configured-jev' })
  const g = await fixture(); g.ctx.llm.registerAdapter(['Jev'], new Adapter(g.generate))
  await expect(g.run()).rejects.toMatchObject({ code: 'KENNEL_JEV_MODEL_MISSING' })
  expect(g.generate).not.toHaveBeenCalled(); expect(g.compile).not.toHaveBeenCalled()
})
it('pins a member model into the node profile and offers only runtimes whose catalog carries it', async () => {
  const f = await fixture()
  Object.assign(f.member, { model: 'gpt-5.5' })
  const [codex] = f.entry.operators
  codex!.models = ['gpt-5.5']
  f.entry.operators.push({ ...codex!, operatorId: 'gouzi.dog.claude-code', models: ['claude-opus-5-5'] })
  await f.run()
  const request = f.compile.mock.calls[0]?.[0] as {
    graph: { nodes: { operator: unknown }[] }
    admission: { gouziRecipient: { operatorIds: string[] } }
  }
  expect(request.graph.nodes[0]!.operator).toEqual({ preferredIds: ['gouzi.dog.codex'], fallbackIds: [], profile: { model: 'gpt-5.5' } })
  expect(request.admission.gouziRecipient.operatorIds).toEqual(['gouzi.dog.codex'])
  const logged = f.agent.session.events.find(event => event.type === 'kennel/dispatch-request')?.data
  expect(logged?.candidates[0]).toMatchObject({ model: 'gpt-5.5', operatorIds: ['gouzi.dog.codex'] })
  expect(kennelDispatchGraph(candidate, 'hello', config).nodes[0]!.operator).toEqual({ preferredIds: candidate.operatorIds, fallbackIds: [] })
})
it('offers no candidate for a pinned model that no available runtime carries', async () => {
  const f = await fixture()
  Object.assign(f.member, { model: 'retired-model' })
  f.entry.operators[0]!.models = ['gpt-5.5']
  await expect(f.run()).rejects.toMatchObject({ code: 'GOUZI_NO_EXECUTOR' })
  expect(f.generate).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled()
})
it('does not start a task whose member model changed after selection', async () => {
  const f = await fixture()
  Object.assign(f.member, { model: 'gpt-5.5' })
  f.entry.operators[0]!.models = ['gpt-5.5', 'gpt-5.6']
  f.compile.mockImplementation(async () => { Object.assign(f.member, { model: 'gpt-5.6' }); return { compilationId: 'compiled' } })
  await expect(f.run()).rejects.toMatchObject({ code: 'GOUZI_STATE_CONFLICT' })
  expect(f.start).not.toHaveBeenCalled()
})
it('rechecks project and execution availability after compile before start', async () => {
  const f = await fixture()
  f.compile.mockImplementation(async () => { f.entry.projectScopes = []; return { compilationId: 'compiled' } })
  await expect(f.run()).rejects.toMatchObject({ code: 'GOUZI_STATE_CONFLICT' })
  expect(f.compile).toHaveBeenCalledOnce(); expect(f.start).not.toHaveBeenCalled()
})
it('stops on explicit clarification without creating a graph', async () => {
  const f = await fixture(); f.generate.mockReturnValue('{"candidateId":"clarify"}')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

/** Minimal authoritative run snapshot supplied by the unit service fixture. */
function existingRun(
  state: OrchestrationRunSnapshot['state'] = 'running', room = 'agent', revision = 3, updatedAt = '2026-10-07T00:00:00.000Z',
): OrchestrationRunSnapshot {
  return { runId: OrchestrationRunId('existing'), state, revision, title: 'Existing task', updatedAt,
    admission: { sourceSessionId: room, gouziRecipient: { gouziId: 'dog', generation: 2, operatorIds: ['gouzi.dog.codex'] } },
  } as unknown as OrchestrationRunSnapshot
}
it.each(['inspect', 'pause', 'resume', 'cancel'] as const)('selects %s on the exact existing room task without compiling work', async (action) => {
  const f = await fixture(); const current = existingRun(action === 'resume' ? 'paused' : 'running')
  f.list.mockResolvedValue([current, { ...existingRun('running', 'other-room'), runId: OrchestrationRunId('other') }])
  f.inspect.mockResolvedValue(current); f.control.mockResolvedValue({ ...current, revision: 4 })
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const choices = JSON.parse(block.text) as { candidates: { kind: string; runId?: string; action?: string; id: string }[] }
    expect(choices.candidates.filter(choice => choice.kind === 'control').every(choice => choice.runId === 'existing')).toBe(true)
    const selected = choices.candidates.find(choice => choice.kind === 'control' && choice.action === action)!
    return JSON.stringify({ candidateId: selected.id })
  })
  expect(await f.run()).toEqual({ kind: 'reject' })
  expect(f.inspect).toHaveBeenCalledWith('existing'); expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  if (action === 'inspect') expect(f.control).not.toHaveBeenCalled()
  else expect(f.control).toHaveBeenCalledWith({ commandId: `kennel:control:agent:${String(f.message.id)}`, runId: 'existing',
    expectedRevision: 3, action, reason: 'hello' })
  expect(f.agent.session.events.at(-1)?.type).toBe('kennel/dispatch-control')
})
it('offers only inspect for indeterminate runs and excludes another recipient generation', async () => {
  const f = await fixture()
  f.list.mockResolvedValue([existingRun('indeterminate'), { ...existingRun(), runId: OrchestrationRunId('wrong-generation'),
    admission: { ...existingRun().admission!, gouziRecipient: { gouziId: GouziId('dog'), generation: 1, operatorIds: [] } } }])
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const input = JSON.parse(block.text) as { candidates: { kind: string; action?: string; runId?: string }[] }
    expect(input.candidates.filter(choice => choice.kind === 'control')).toMatchObject([{ runId: 'existing', action: 'inspect' }])
    return '{"candidateId":"clarify"}'
  })
  const addressed = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
    text: encodeKennelMessage('status', { gouziId: 'dog', generation: 2, mode: 'standard' }) }] })
  await expect(f.run([addressed])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(f.control).not.toHaveBeenCalled()
})
it('offers an addressed room the runs of a recipient set that names the addressed member and generation', async () => {
  const f = await fixture()
  const named = (id: string, members: { gouziId: string; generation: number }[]) => ({
    ...existingRun(),
    runId: OrchestrationRunId(id),
    admission: {
      ...existingRun().admission!,
      gouziRecipient: undefined,
      gouziRecipients: members.map(value => ({ gouziId: GouziId(value.gouziId), generation: value.generation, operatorIds: [] })),
    },
  })
  f.list.mockResolvedValue([named('set-with-dog', [{ gouziId: 'dog', generation: 2 }, { gouziId: 'cat', generation: 1 }]),
    named('set-wrong-generation', [{ gouziId: 'dog', generation: 1 }, { gouziId: 'cat', generation: 1 }]),
    named('set-without-dog', [{ gouziId: 'cat', generation: 1 }, { gouziId: 'bird', generation: 1 }])] as never)
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const input = JSON.parse(block.text) as { candidates: { kind: string; runId?: string }[] }
    expect([...new Set(input.candidates.filter(choice => choice.kind === 'control').map(choice => choice.runId))]).toEqual(['set-with-dog'])
    return '{"candidateId":"clarify"}'
  })
  const addressed = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text',
    text: encodeKennelMessage('status', { gouziId: 'dog', generation: 2, mode: 'standard' }) }] })
  await expect(f.run([addressed])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(f.generate).toHaveBeenCalledOnce()
})
const choicesIn = (options: GenerateOptions) => {
  const block = options.messages[0]!.content[0]!
  if (block.type !== 'text') throw new Error('fixture expects text')
  type Candidate = { kind: string; id: string; collaboration?: string; members?: { gouziId: string; model: string; operatorId: string }[] }
  return (JSON.parse(block.text) as { candidates: Candidate[] }).candidates
}
/** A kind that offers its candidate while at least two members hold /project; the candidate id names the members. */
function pairKind(extra: Partial<KennelCollaborationKind> = {}) {
  const offer = vi.fn((facts: KennelCollaborationFacts): KennelCollaborationCandidate[] => {
    const members = facts.members.filter(value => value.membership === 'enabled').slice(0, 2).map(value => ({
      gouziId: String(value.gouziId), generation: value.generation, name: value.name, role: value.role,
      operatorId: `gouzi.${String(value.gouziId)}.codex`, model: 'm',
    }))
    return members.length < 2 ? [] : [{ kind: 'collaboration', collaboration: 'pair', workspace: '/project', details: { note: 'x' },
      id: JSON.stringify(['pair', ...members.map(value => [value.gouziId, value.generation])]), members }]
  })
  const starts: KennelCollaborationRequest[] = []
  const startMock = vi.fn(async (request: KennelCollaborationRequest): Promise<KennelCollaborationStarted> => {
    starts.push(request)
    return { runId: 'pair-1', assignments: request.candidate.members.map(value => ({ gouziId: value.gouziId, role: 'peer' })) }
  })
  const kind: KennelCollaborationKind = { kind: 'pair', guidance: 'PAIR-GUIDANCE', offer, start: startMock, ...extra }
  return { kind, offer, starts, startMock }
}
async function collaborationFixture(extra: Partial<KennelCollaborationKind> = {}) {
  const f = await fixture()
  f.members.push({ ...f.member, gouziId: 'cat', name: 'cat', generation: 1 })
  f.entries.push({ ...f.entry, gouziId: 'cat', generation: 1, operators: [{ ...f.entry.operators[0]!, operatorId: 'gouzi.cat.codex' }] })
  const pair = pairKind(extra)
  const dispose = f.registry.register(pair.kind)
  const pairId = JSON.stringify(['pair', ['dog', 2], ['cat', 1]])
  return { ...f, ...pair, dispose, pairId }
}
it('offers a kind\'s candidates and its guidance only while the kind offers some', async () => {
  const bare = await fixture()
  bare.generate.mockImplementation((options) => {
    expect(choicesIn(options).some(choice => choice.kind === 'collaboration')).toBe(false)
    expect(options.system).not.toContain('collaboration')
    return '{"candidateId":"clarify"}'
  })
  await expect(bare.run()).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })

  const f = await collaborationFixture()
  f.generate.mockImplementation((options) => {
    expect(choicesIn(options).filter(choice => choice.kind === 'collaboration')).toEqual([expect.objectContaining({
      collaboration: 'pair', id: f.pairId, members: [expect.objectContaining({ gouziId: 'dog' }), expect.objectContaining({ gouziId: 'cat' })] })])
    expect(options.system).toContain('pair：PAIR-GUIDANCE')
    return '{"candidateId":"clarify"}'
  })
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })

  const silent = await collaborationFixture()
  silent.members.pop(); silent.entries.pop()
  silent.generate.mockImplementation((options) => {
    expect(choicesIn(options).some(choice => choice.kind === 'collaboration')).toBe(false)
    expect(options.system).not.toContain('PAIR-GUIDANCE')
    return '{"candidateId":"clarify"}'
  })
  await expect(silent.run()).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
})
it('tells a kind the Session, its runs newest first, and the member the user addressed', async () => {
  const f = await collaborationFixture()
  f.list.mockResolvedValue([existingRun('completed', 'agent', 1, '2026-01-01T00:00:00.000Z'), existingRun('running', 'agent', 2, '2026-02-01T00:00:00.000Z'), existingRun('running', 'other', 1)])
  f.generate.mockReturnValue('{"candidateId":"clarify"}')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  const open = f.offer.mock.calls[0]![0]
  expect(open).toMatchObject({ sessionId: 'agent', members: f.members, entries: f.entries })
  expect(open.runs.map(run => run.updatedAt)).toEqual(['2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'])
  expect(open.recipient).toBeUndefined()

  const addressed = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: encodeKennelMessage('hello', { gouziId: 'dog', generation: 2, mode: 'standard' }) }] })
  const direct = await collaborationFixture()
  direct.generate.mockReturnValue('{"candidateId":"clarify"}')
  await expect(direct.run([addressed])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(direct.offer.mock.calls[0]![0].recipient).toEqual({ gouziId: 'dog', generation: 2 })
})
it('tells a kind which members the message names, in the order it names them, from the message without its addressing prefix', async () => {
  const f = await collaborationFixture()
  f.generate.mockReturnValue('{"candidateId":"clarify"}')
  const say = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  await expect(f.run([say('ask cat and then Dog to look at it')])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(f.offer.mock.calls[0]![0].mentioned).toEqual([
    { gouziId: 'cat', generation: 1, name: 'cat' }, { gouziId: 'dog', generation: 2, name: 'Dog' },
  ])
  const quiet = await collaborationFixture()
  quiet.generate.mockReturnValue('{"candidateId":"clarify"}')
  await expect(quiet.run([say('hello there')])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(quiet.offer.mock.calls[0]![0].mentioned).toEqual([])
})
it('gives kinds the work offers, the work and collaborations already admitted with their outcomes, and the Host\'s work graph', async () => {
  const outcome = vi.fn((_record: unknown, _run: unknown, _results: unknown) => ({ subjectRunId: 'old-work', state: 'negative' as const, label: 'LABEL', details: { n: 1 } }))
  const f = await collaborationFixture({ outcome })
  const workOffer = { ...candidate }
  const { kind: _kind, ...offerOnly } = workOffer
  const peerCandidate = { kind: 'collaboration' as const, collaboration: 'pair', id: 'old-pair', workspace: '/project', members: [], details: {} }
  const { session } = f.agent
  // Earlier dispatches, appended in the order the dispatcher records them so the Session invariants hold.
  const earlier = (messageId: string, chosen: typeof workOffer | typeof peerCandidate) => {
    const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: messageId }] })
    const id = String(user.id)
    session.append('user/message', user, { surfaceOp: 'append' })
    session.append('kennel/dispatch-request', { messageId: id, message: user, candidates: [chosen] }, { ignorable: true })
    session.append('kennel/dispatch-decision', { messageId: id, source: 'deepseek', provider: 'p', candidateId: chosen.id }, { ignorable: true })
    return id
  }
  const workMessage = earlier('work', workOffer)
  session.append('kennel/dispatch-submission', { messageId: workMessage, compilationId: 'c', commandId: 'c' }, { ignorable: true })
  session.append('kennel/dispatch-admitted', { messageId: workMessage, runId: 'old-work' }, { ignorable: true })
  const pairMessage = earlier('pair', peerCandidate)
  session.append('kennel/dispatch-collaboration', { messageId: pairMessage, candidate: peerCandidate, commandId: 'c' }, { ignorable: true })
  session.append('kennel/dispatch-collaboration-admitted', { messageId: pairMessage, collaboration: 'pair', runId: 'old-pair-run', assignments: [] }, { ignorable: true })
  f.list.mockResolvedValue([{ ...existingRun('completed'), runId: OrchestrationRunId('old-pair-run') }])
  f.generate.mockReturnValue(JSON.stringify({ candidateId: f.pairId }))
  await f.run()

  const facts = f.offer.mock.calls[0]![0]
  expect(facts.work).toEqual([{ runId: 'old-work', offer: offerOnly }])
  expect(facts.earlier).toEqual([{
    collaboration: 'pair', runId: 'old-pair-run', messageId: pairMessage, candidate: peerCandidate,
    outcome: { subjectRunId: 'old-work', state: 'negative', label: 'LABEL', details: { n: 1 } },
  }])
  // Each fresh offer (the first, then the two confirmations) reads the outcomes again.
  expect(outcome).toHaveBeenCalledTimes(3)
  // The kinds see exactly the work the model is offered: one chat, read, and write offer per member and project.
  expect(facts.workOffers.map(value => [value.gouziId, value.mode])).toEqual([['dog', 'chat'], ['dog', 'read'], ['dog', 'write'], ['cat', 'chat'], ['cat', 'read'], ['cat', 'write']])
  const [request] = f.starts
  const given = facts.workOffers[2]!
  expect(request!.workGraph({ offer: given, text: 'redo it' })).toEqual(kennelDispatchGraph({ kind: 'work', ...given }, 'redo it', config))
  expect(request!.workGraph({ offer: given, text: 'redo it' })).toMatchObject({ risk: 'high', workspaceIsolation: 'directory-snapshot' })
  // A title the kind gives is the task's title; the text stays what the member receives.
  const titled = request!.workGraph({ offer: given, text: 'redo it', title: '返工：old task' })
  expect(titled).toEqual(kennelDispatchGraph({ kind: 'work', ...given }, 'redo it', config, '返工：old task'))
  expect(titled.title).toBe('返工：old task')
  expect(titled.nodes[0]).toMatchObject({ title: '返工：old task', task: 'redo it' })
})
it('starts the selected collaboration through its kind after durably recording the candidate, without compiling a task', async () => {
  const f = await collaborationFixture()
  const seen: boolean[] = []
  f.startMock.mockImplementation(async (request: KennelCollaborationRequest) => {
    seen.push(f.agent.session.events.some(event => event.type === 'kennel/dispatch-collaboration'))
    f.starts.push(request)
    return { runId: 'pair-1', assignments: request.candidate.members.map(value => ({ gouziId: value.gouziId, role: 'peer' })) }
  })
  f.generate.mockReturnValue(JSON.stringify({ candidateId: f.pairId }))
  expect(await f.run()).toEqual({ kind: 'reject' })
  expect(f.starts).toEqual([expect.objectContaining({
    commandId: `kennel:pair:agent:${String(f.message.id)}`, sessionId: 'agent', messageId: String(f.message.id), prompt: 'hello',
    limits: { contextTokens: config.contextTokens, taskTimeoutMs: config.taskTimeoutMs, titleMaxChars: config.titleMaxChars,
      generationLimits: config.taskGenerationLimits, workspaceToolLimits: config.workspaceToolLimits },
  })])
  expect(f.starts[0]?.candidate.id).toBe(f.pairId)
  expect(seen).toEqual([true])
  expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  const types = f.agent.session.events.map(event => event.type)
  expect(types.indexOf('kennel/dispatch-collaboration')).toBeLessThan(types.indexOf('kennel/dispatch-collaboration-admitted'))
  expect(f.agent.session.events.at(-1)).toMatchObject({ type: 'kennel/dispatch-collaboration-admitted', data: {
    collaboration: 'pair', runId: 'pair-1', assignments: [{ gouziId: 'dog', role: 'peer' }, { gouziId: 'cat', role: 'peer' }] } })
  // The same source message is never started twice.
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_DISPATCH_UNCONFIRMED' })
  expect(f.startMock).toHaveBeenCalledOnce()
})
it('does not start a collaboration whose candidate is no longer offered or whose kind was removed', async () => {
  const f = await collaborationFixture()
  f.generate.mockImplementation(() => { f.members[1]!.generation = 9; return JSON.stringify({ candidateId: f.pairId }) })
  await expect(f.run()).rejects.toMatchObject({ code: 'GOUZI_STATE_CONFLICT' })
  expect(f.startMock).not.toHaveBeenCalled()

  const removed = await collaborationFixture()
  removed.generate.mockImplementation(() => { removed.dispose(); return JSON.stringify({ candidateId: removed.pairId }) })
  await expect(removed.run()).rejects.toMatchObject({ code: 'KENNEL_COLLABORATION_UNAVAILABLE' })
  expect(removed.startMock).not.toHaveBeenCalled()
})
it('registers kinds once, refuses names the dispatcher owns, and removes a kind with its disposer', async () => {
  const f = await fixture()
  const first = pairKind().kind
  const dispose = f.registry.register(first)
  expect(f.registry.kinds()).toEqual([first])
  expect(() => f.registry.register(pairKind().kind)).toThrow(expect.objectContaining({ code: 'KENNEL_COLLABORATION_DUPLICATE' }))
  for (const reserved of ['work', 'control', 'clarify']) {
    expect(() => f.registry.register({ ...first, kind: reserved })).toThrow(expect.objectContaining({ code: 'KENNEL_COLLABORATION_RESERVED' }))
  }
  dispose(); dispose()
  expect(f.registry.kinds()).toEqual([])
})
it('refuses a revision change between selection and inspection', async () => {
  const f = await fixture(); f.list.mockResolvedValue([existingRun()]); f.inspect.mockResolvedValue(existingRun('running', 'agent', 4))
  f.generate.mockReturnValue(JSON.stringify({ candidateId: JSON.stringify(['run', 'existing', 3, 'pause']) }))
  await expect(f.run()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.control).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})
it('requires a participating flush listener before AI', async () => {
  const f = await fixture(false)
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_PERSISTENCE_UNAVAILABLE' })
  expect(f.generate).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled()
})
it.each(['request', 'model', 'submission'] as const)('stops before the external effect when %s persistence fails', async (phase) => {
  const f = await fixture()
  const type = phase === 'request' ? 'kennel/dispatch-request' : phase === 'model' ? 'kennel/dispatch-model' : 'kennel/dispatch-submission'
  f.persist.mockImplementation(async (session) => { if (session.events.at(-1)?.type === type) throw new Error('disk full') })
  await expect(f.run()).rejects.toThrow('disk full')
  if (phase !== 'submission') expect(f.generate).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled()
})
it('does not control an existing task when decision persistence fails', async () => {
  const f = await fixture(); f.list.mockResolvedValue([existingRun()])
  f.generate.mockReturnValue(JSON.stringify({ candidateId: JSON.stringify(['run', 'existing', 3, 'pause']) }))
  f.persist.mockImplementation(async (session) => { if (session.events.at(-1)?.type === 'kennel/dispatch-decision') throw new Error('disk full') })
  await expect(f.run()).rejects.toThrow('disk full')
  expect(f.inspect).not.toHaveBeenCalled(); expect(f.control).not.toHaveBeenCalled()
})
it('limits existing-run candidates to the configured number of newest room tasks', async () => {
  const f = await fixture()
  const runs = Array.from({ length: 21 }, (_value, index) => ({ ...existingRun(), runId: OrchestrationRunId(`run-${index}`),
    updatedAt: `2026-10-07T00:00:${String(index).padStart(2, '0')}.000Z` }))
  f.list.mockResolvedValue(runs)
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const input = JSON.parse(block.text) as { candidates: { kind: string; runId?: string }[] }
    const runIds = new Set(input.candidates.filter(choice => choice.kind === 'control').map(choice => choice.runId))
    expect(runIds.size).toBe(20); expect(runIds.has('run-0')).toBe(false); expect(runIds.has('run-20')).toBe(true)
    return '{"candidateId":"clarify"}'
  })
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
})
it('does not replay start when flushing its admission receipt fails', async () => {
  const f = await fixture()
  f.persist.mockImplementation(async (session) => {
    if (session.events.at(-1)?.type === 'kennel/dispatch-admitted') throw new Error('receipt write failed')
  })
  await expect(f.run()).rejects.toThrow('receipt write failed')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_DISPATCH_UNCONFIRMED' })
  expect(f.start).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledOnce()
})
it('does not replay control after an unknown external control effect', async () => {
  const f = await fixture(); f.list.mockResolvedValue([existingRun()])
  f.generate.mockReturnValue(JSON.stringify({ candidateId: JSON.stringify(['run', 'existing', 3, 'cancel']) }))
  f.control.mockRejectedValue(new Error('control reply lost'))
  await expect(f.run()).rejects.toThrow('control reply lost')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_DISPATCH_UNCONFIRMED' })
  expect(f.control).toHaveBeenCalledOnce(); expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})
it('does not replay control when flushing its receipt fails', async () => {
  const f = await fixture(); f.list.mockResolvedValue([existingRun()])
  f.generate.mockReturnValue(JSON.stringify({ candidateId: JSON.stringify(['run', 'existing', 3, 'pause']) }))
  f.persist.mockImplementation(async (session) => {
    if (session.events.at(-1)?.type === 'kennel/dispatch-control') throw new Error('receipt write failed')
  })
  await expect(f.run()).rejects.toThrow('receipt write failed')
  await expect(f.run()).rejects.toMatchObject({ code: 'KENNEL_DISPATCH_UNCONFIRMED' })
  expect(f.control).toHaveBeenCalledOnce()
})

it('offers no remote write candidate and leaves a requested modification unsubmitted on clarification', async () => {
  const f = await fixture(); f.member.hostId = 'foreign-host'
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const input = JSON.parse(block.text) as { candidates: { kind: string; mode?: string }[] }
    expect(input.candidates.filter(choice => choice.kind === 'work').map(choice => choice.mode)).toEqual(['chat', 'read'])
    return '{"candidateId":"clarify"}'
  })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Modify the remote project.' }] })
  await expect(f.run([message])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})

it.each(['missing', 'false'] as const)('refuses an old execution entry with %s generation-limit support before AI', async (state) => {
  const f = await fixture()
  if (state === 'missing') Reflect.deleteProperty(f.entry.operators[0]!, 'supportsGenerationLimits')
  else f.entry.operators[0]!.supportsGenerationLimits = false
  await expect(f.run()).rejects.toMatchObject({ code: 'GOUZI_NO_EXECUTOR' })
  expect(f.generate).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})
it.each(['missing', 'false'] as const)('offers no governed read/write candidate with %s governed-workspace support', async (state) => {
  const f = await fixture()
  if (state === 'missing') Reflect.deleteProperty(f.entry.operators[0]!, 'supportsGovernedWorkspacePolicy')
  else f.entry.operators[0]!.supportsGovernedWorkspacePolicy = false
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const input = JSON.parse(block.text) as { candidates: { kind: string; mode?: string }[] }
    expect(input.candidates.filter(choice => choice.kind === 'work').map(choice => choice.mode)).toEqual(['chat'])
    return '{"candidateId":"clarify"}'
  })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the project files.' }] })
  await expect(f.run([message])).rejects.toMatchObject({ code: 'KENNEL_CLARIFICATION_REQUIRED' })
  expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
})
it.each([
  ['selection', 'supportsGenerationLimits'], ['selection', 'supportsGovernedWorkspacePolicy'],
  ['compile', 'supportsGenerationLimits'], ['compile', 'supportsGovernedWorkspacePolicy'],
] as const)('rejects a capability change after %s in %s before start', async (phase, capability) => {
  const f = await fixture()
  const selection = JSON.stringify({ candidateId: JSON.stringify(['dog', 2, '/project', 'read']) })
  f.generate.mockImplementation(() => {
    if (phase === 'selection') f.entry.operators[0]![capability] = false
    return selection
  })
  if (phase === 'compile') f.compile.mockImplementation(async () => {
    f.entry.operators[0]![capability] = false
    return { compilationId: 'compiled' }
  })
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Read the project files.' }] })
  await expect(f.run([message])).rejects.toMatchObject({ code: 'GOUZI_STATE_CONFLICT' })
  if (phase === 'selection') expect(f.compile).not.toHaveBeenCalled()
  else expect(f.compile).toHaveBeenCalledOnce()
  expect(f.start).not.toHaveBeenCalled()
})

it('offers only inspect during the persistent file-delivery applying stage', async () => {
  const f = await fixture(); const current = { ...existingRun(), delivery: { state: 'applying' as const } }
  f.list.mockResolvedValue([current]); f.inspect.mockResolvedValue(current)
  f.generate.mockImplementation((options) => {
    const block = options.messages[0]!.content[0]!
    if (block.type !== 'text') throw new Error('fixture expects text')
    const input = JSON.parse(block.text) as { candidates: { kind: string; action?: string; id: string }[] }
    const choices = input.candidates.filter(choice => choice.kind === 'control')
    expect(choices.map(choice => choice.action)).toEqual(['inspect'])
    return JSON.stringify({ candidateId: choices[0]!.id })
  })
  expect(await f.run()).toEqual({ kind: 'reject' })
  expect(f.control).not.toHaveBeenCalled(); expect(f.compile).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled()
  expect(f.agent.session.events.at(-1)?.type).toBe('kennel/dispatch-control')
})

it('preserves explicitly configured DeepSeek routes independently of the built-in default', () => {
  expect(Config({ dispatcher: { ...config, deepseek: { provider: 'explicit-gateway', model: 'explicit-model' } } }).dispatcher?.deepseek)
    .toEqual({ provider: 'explicit-gateway', model: 'explicit-model' })
})
