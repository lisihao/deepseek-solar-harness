/** Fixed kennel inbox admission with externally generated judgments. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { GouziId, OrchestrationRunId, type OrchestrationRunSnapshot } from '@deepseek-ai/dsh-orchestration'
import { expect, it, vi } from 'vitest'
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
  const session = ctx.sessions.create(SessionId('dispatch-fixture')); session.append('agent-preset/selected', { agentPreset: 'kennel' })
  const agent = { id: 'agent', session } as unknown as Agent
  const member = { hostId: 'local', gouziId: 'dog', generation: 2, membership: 'enabled', name: 'Dog', role: 'research', activity: 'idle' }
  const entry = { gouziId: 'dog', generation: 2, projectScopes: ['/project'], operators: [{ operatorId: 'gouzi.dog.codex', available: true,
    supportsGenerationLimits: true, supportsGovernedWorkspacePolicy: true }] }
  const compile = vi.fn(async (_request: unknown) => ({ compilationId: 'compiled' })); const start = vi.fn(async (_request: unknown) => ({ runId: 'run' }))
  const list = vi.fn(async (): Promise<readonly OrchestrationRunSnapshot[]> => [])
  const inspect = vi.fn(async (_id: unknown): Promise<OrchestrationRunSnapshot> => existingRun())
  const control = vi.fn(async (_request: unknown): Promise<OrchestrationRunSnapshot> => existingRun())
  const persist = vi.fn(async (_session: typeof session) => {})
  if (persisted) ctx.on('session/flush', persist)
  ctx.provide('orchestrations', { gouzi: { list: async () => ({ members: [member], hosts: [] }), executionOperators: async () => [entry] }, compile, start, list, inspect, control } as never)
  const generate = vi.fn((_options: GenerateOptions) => JSON.stringify({ candidateId: candidate.id }))
  ctx.llm.registerAdapter(['deepseek-official'], new Adapter(generate))
  await ctx.plugin(Object.assign((child: Context) => { installKennelDispatch(child, config) }, { inject: ['sessions'] }))
  const controller = new AbortController(); const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
  const run = (messages: UserMessage[] = [message]) => ctx.waterfall('agent/pre-step', { agent, signal: controller.signal, turn: 1, step: 1 } as never, async () => ({ kind: 'enter' as const, messages }))
  return { ctx, agent, member, entry, compile, start, generate, controller, message, run, list, inspect, control, persist }
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
function existingRun(state: OrchestrationRunSnapshot['state'] = 'running', room = 'agent', revision = 3): OrchestrationRunSnapshot {
  return { runId: OrchestrationRunId('existing'), state, revision, title: 'Existing task', updatedAt: '2026-10-07T00:00:00.000Z',
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
