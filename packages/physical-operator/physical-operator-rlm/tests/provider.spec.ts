import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import PhysicalOperatorRuntime, { PhysicalOperatorExecutionId, PhysicalOperatorId, type PhysicalOperatorStartRequest } from '@deepseek-ai/dsh-physical-operator'
import type OrchestrationService from '@deepseek-ai/dsh-orchestration'
import { StandaloneRlmStartRejected, type StandaloneRlmCommandSnapshot, type StandaloneRlmControl, type StandaloneRlmStartRequest } from '@deepseek-ai/dsh-orchestration'
import * as physicalTool from '@deepseek-ai/dsh-tool-physical-operator'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as provider from '../src/index.ts'
import { apply as applyHost, type Config as HostConfig } from '../src/standalone-host.ts'
import * as standaloneHost from '../src/standalone-host.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })

const policy: provider.StandaloneRlmRootPolicy = {
  version: 'fixture-v1',
  driver: { kind: 'model-worker', operatorId: PhysicalOperatorId('deepseek-api'), model: 'deepseek-v4-flash' },
  readScopes: [], contextMaxTokens: 4096,
  rlm: { mode: 'enabled', maxDepth: 2, maxChildren: 3, maxTurns: 4 },
  retryPolicy: { maxAttempts: 3, backoffMs: 0, retryableCodes: ['UNKNOWN'] },
}

async function setup(deferProvider = false) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PhysicalOperatorRuntime)
  const snapshots = new Map<string, StandaloneRlmCommandSnapshot>()
  const sent: StandaloneRlmStartRequest[] = []
  let cancels = 0
  let beforeSendWait: Promise<void> = Promise.resolve()
  let autoComplete = true
  const control: StandaloneRlmControl = {
    requestFingerprint: request => createHash('sha256').update(JSON.stringify(request)).digest('hex'),
    operatorIds: () => Promise.resolve([PhysicalOperatorId('standalone')]),
    start: async (request, guard) => {
      await beforeSendWait
      guard()
      sent.push(request)
      const previous = snapshots.get(request.input.executionId)
      if (previous !== undefined) {
        if (previous.requestSha256 !== control.requestFingerprint(request)) throw new StandaloneRlmStartRejected('different immutable input', 'COMMAND_CONFLICT')
        return previous
      }
      const snapshot: StandaloneRlmCommandSnapshot = {
        executionId: request.input.executionId, state: autoComplete ? 'settled' : 'accepted', phase: 'started',
        requestSha256: control.requestFingerprint(request), settlement: autoComplete ? 'settled' : 'unknown',
        ...autoComplete ? { result: { output: [{ type: 'text', text: 'full retained answer' }], stopReason: 'completed' } } : {},
      }
      snapshots.set(request.input.executionId, snapshot)
      return snapshot
    },
    inspect: (id) => {
      const snapshot = snapshots.get(id)
      return snapshot === undefined ? Promise.reject(new Error('command not yet received')) : Promise.resolve(snapshot)
    },
    cancel: (id, digest) => {
      if (snapshots.get(id)?.requestSha256 !== digest) return Promise.reject(new StandaloneRlmStartRejected('different cancellation input', 'COMMAND_CONFLICT'))
      cancels++
      return control.inspect(id)
    },
  }
  // This fake control owner isolates Host binding; it is not daemon acceptance.
  ctx.provide('orchestrations', { standaloneRlm: control } as OrchestrationService)
  const mountProvider = () => ctx.plugin(provider, { id: 'standalone', displayName: 'RLM', description: 'Bounded analysis', maxConcurrency: 1, pollIntervalMs: 1 })
  if (!deferProvider) await mountProvider()
  await ctx.plugin(physicalTool)
  const handle = await ctx.agents.create({
    sessionId: SessionId('standalone-root'), meta: { cwd: '/tmp' },
    agentOptions: { provider: 'unused', model: 'unused' },
  })
  cleanups.push(() => ctx.root.fiber.dispose())
  const parent = handle.agent
  const request = (): PhysicalOperatorStartRequest => ({
    executionId: PhysicalOperatorExecutionId('tool-bound-input'),
    parent, prompt: [{ type: 'text', text: 'original input' }], signal: new AbortController().signal,
  })
  return {
    ctx, parent, handle, request, sent, snapshots, control, mountProvider,
    cancels: () => cancels,
    waitBeforeSend: (wait: Promise<void>) => { beforeSendWait = wait },
    hold: () => { autoComplete = false },
    register: () => provider.registerStandaloneRoot(ctx, 'standalone', parent, policy),
    prepare: (input: PhysicalOperatorStartRequest) =>{  ctx.physicalOperators.getOperator('standalone')!.prepareToolCall!(input, 'fixture-call') },
  }
}

describe('trusted standalone RLM provider', () => {
  it.each(['known-refusal', 'lost-refusal-reply'])('rejects conflicting complete input instead of returning an old result: %s', async (reply) => {
    const f = await setup()
    f.register()
    const original = f.request()
    f.prepare(original)
    const a = await f.ctx.physicalOperators.start('standalone', original)
    await a.result
    await a.dispose()
    if (reply === 'lost-refusal-reply') {
      const start = f.control.start.bind(f.control)
      f.control.start = async (...args) => {
        try { return await start(...args) } catch { throw new Error('transport response lost') }
      }
    }
    const b = { ...f.request(), prompt: [{ type: 'text' as const, text: 'different task B' }] }
    f.prepare(b)
    const run = await f.ctx.physicalOperators.start('standalone', b)
    await expect(run.result).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    await run.dispose()
    expect(f.cancels()).toBe(0)
    expect(f.snapshots.get(String(original.executionId))?.result).toEqual(await a.result)
    expect(f.ctx.physicalOperators.status('standalone').active).toBe(0)
  })

  it('never cancels an old running command when the new input conflicts', async () => {
    const f = await setup()
    f.register()
    const aInput = f.request()
    f.prepare(aInput)
    const a = await f.ctx.physicalOperators.start('standalone', aInput)
    await a.result
    await a.dispose()
    const old = f.snapshots.get(String(aInput.executionId))!
    const running = { ...old, state: 'accepted' as const, settlement: 'running' as const }
    delete running.result
    f.snapshots.set(String(aInput.executionId), running)
    const signal = new AbortController()
    const b = { ...f.request(), signal: signal.signal, prompt: [{ type: 'text' as const, text: 'different task B' }] }
    f.prepare(b)
    const run = await f.ctx.physicalOperators.start('standalone', b)
    const rejected = expect(run.result).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' })
    await expect.poll(() => f.sent.length).toBe(2)
    signal.abort(new Error('cancel B'))
    await rejected
    await run.dispose()
    expect(f.cancels()).toBe(0)
    expect(f.snapshots.get(String(aInput.executionId))).toMatchObject({ state: 'accepted', settlement: 'running', requestSha256: old.requestSha256 })
  })

  it('rejects registered child Agents even though they have live registry identities', async () => {
    const f = await setup()
    const child = await f.parent.ctx.agents.create({
      sessionId: SessionId('standalone-child'), meta: { cwd: '/tmp' }, agentOptions: { provider: 'unused', model: 'unused' },
    })
    expect(f.ctx.agents.get(child.agent.id)).toBe(child.agent)
    expect(f.ctx.agents.roots()).not.toContain(child.agent)
    expect(() => provider.registerStandaloneRoot(f.ctx, 'standalone', child.agent, policy)).toThrow('top-level')
  })

  it('rejects a replaced prompt after preparation before sending any command', async () => {
    const f = await setup()
    f.register()
    const input = f.request()
    f.prepare(input)
    ;(input.prompt[0] as { text: string }).text = 'replaced input'
    await expect(f.ctx.physicalOperators.start('standalone', input)).rejects.toThrow('no matching prepared')
    expect(f.sent).toEqual([])
  })

  it('revalidates revocation after asynchronous readiness immediately before the wire send', async () => {
    const f = await setup()
    const revoke = f.register()
    const gate = Promise.withResolvers<undefined>()
    f.waitBeforeSend(gate.promise)
    const input = f.request()
    f.prepare(input)
    const run = await f.ctx.physicalOperators.start('standalone', input)
    const rejected = expect(run.result).rejects.toThrow('revoked')
    await revoke()
    gate.resolve(undefined)
    await rejected
    expect(f.sent).toEqual([])
    await run.dispose()
    expect(f.ctx.physicalOperators.status('standalone').active).toBe(0)
  })

  it('holds result, disposal and outer capacity through unknown until the same command has late settlement evidence', async () => {
    const f = await setup()
    f.register()
    f.hold()
    const input = f.request()
    f.prepare(input)
    const run = await f.ctx.physicalOperators.start('standalone', input)
    let resultSettled = false
    void run.result.then(() => { resultSettled = true })
    await expect.poll(() => f.sent.length).toBe(1)
    let disposed = false
    const disposal = run.dispose().then(() => { disposed = true })
    await expect.poll(f.cancels).toBe(1)
    expect(resultSettled).toBe(false)
    expect(disposed).toBe(false)
    expect(f.ctx.physicalOperators.status('standalone')).toMatchObject({ active: 1, state: 'busy' })
    const page = await run.readEvents!(0, 100)
    expect(page.events.some(event => event.data.settlement === 'unknown')).toBe(true)
    const original = f.snapshots.get(String(input.executionId))!
    f.snapshots.set(String(input.executionId), {
      ...original, state: 'settled', settlement: 'settled',
      result: { output: [{ type: 'text', text: 'late proven output' }], stopReason: 'completed' },
    })
    await expect(run.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'late proven output' }] })
    await disposal
    expect(f.sent).toHaveLength(1)
    expect(f.cancels()).toBe(1)
    expect(f.ctx.physicalOperators.status('standalone').active).toBe(0)
  })

  it('rejects explicit unsupported generation and Resident fields before command acceptance', async () => {
    const f = await setup()
    f.register()
    for (const fields of [
      { mode: 'resident' as const }, { generationLimits: { maxTokens: 10, maxOutputBytes: 1024 } },
      { systemPrompt: 'unhonored system' }, { residentLaneId: 'unhonored-lane' },
    ]) expect(() =>{  f.prepare({ ...f.request(), ...fields }) }).toThrow('first slice')
    expect(f.sent).toEqual([])
  })
  it('does not infer authorization from a live root or an id-equivalent synthetic parent', async () => {
    const f = await setup()
    expect(f.ctx.agents.roots()).toContain(f.parent)
    expect(() =>{  f.prepare(f.request()) }).toThrow('no explicit Host registration')
    expect(() => provider.registerStandaloneRoot(f.ctx, 'standalone', { ...f.parent }, policy)).toThrow('exact live')
    await expect(f.ctx.physicalOperators.start('standalone', f.request())).rejects.toThrow('no matching prepared')
    expect(f.sent).toEqual([])
  })

  it('runs the real physical_operator tool from an explicitly registered real AgentHandle', async () => {
    const f = await setup()
    f.register()
    f.parent.session.append('request/header', {
      header: { config: { provider: 'unused', model: 'unused' }, system: 'frozen caller system' }, reason: 'initial',
    })
    const result = await f.ctx.tools.execute({
      name: 'physical_operator', callId: CallId('real-tool-call'), agent: f.parent, signal: new AbortController().signal,
      arguments: { action: 'run', operator_id: 'standalone', description: 'bounded task', prompt: 'original input' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected actual tool success')
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.input.prompt).toEqual([{ type: 'text', text: 'original input' }])
    expect(f.sent[0]!.input.contextEnvelope?.systemText).toBe('frozen caller system')
    expect(f.sent[0]!.compile.graph.nodes[0]!.rlm).toEqual(policy.rlm)
    expect(result.value).toMatchObject({ kind: 'run', output: [{ type: 'text', text: 'full retained answer' }] })
    expect(f.ctx.physicalOperators.status('standalone').active).toBe(0)
  })
})

const hostConfig: HostConfig = {
  operatorId: 'standalone', rootSessionId: 'explicit-host-root', rootProvider: 'unused', rootModel: 'unused', rootCwd: '/tmp',
  policy: {
    version: 'host-fixture-v1', driver: { kind: 'model-worker', operatorId: 'deepseek-api', model: 'deepseek-v4-flash' },
    readScopes: [], contextMaxTokens: 4096,
    rlm: { mode: 'enabled', maxDepth: 2, maxChildren: 3, maxTurns: 4 },
    retryPolicy: { maxAttempts: 3, backoffMs: 0, retryableCodes: ['UNKNOWN'] },
  },
}

describe('explicit standalone root Host lifecycle', () => {
  it('waits for actual Provider registration and invalidates the old instance binding on unload', async () => {
    const f = await setup(true)
    const host = f.ctx.plugin(standaloneHost, hostConfig)
    await host
    expect(f.ctx.agents.roots()).toEqual([f.parent])
    const registration = f.mountProvider()
    await registration
    await expect.poll(() => f.ctx.agents.roots().length).toBe(2)
    const root = f.ctx.agents.roots().find(agent => agent !== f.parent)!
    const binding = f.ctx.standaloneRlmHost
    binding.registerRoot(f.ctx, f.parent, policy)
    const operator = f.ctx.physicalOperators.getOperator('standalone')!
    await registration.dispose()
    await expect.poll(() => f.ctx.agents.get(root.id)).toBeUndefined()
    expect(f.ctx.agents.get(f.parent.id)).toBe(f.parent)
    expect(() => binding.registerRoot(f.ctx, f.parent, policy)).toThrow('withdrawn')
    expect(() =>{  operator.prepareToolCall!(f.request(), 'fixture-call') }).toThrow('no explicit Host registration')
  })

  it('grants only the exact root it creates and revokes that root on teardown', async () => {
    const f = await setup()
    const dispose = await applyHost(f.ctx, hostConfig)
    const root = f.ctx.agents.roots().find(agent => agent !== f.parent)!
    expect(root).toBeDefined()
    expect(() =>{  f.prepare(f.request()) }).toThrow('no explicit Host registration')
    const request = { ...f.request(), parent: root }
    f.prepare(request)
    const run = await f.ctx.physicalOperators.start('standalone', request)
    await expect(run.result).resolves.toMatchObject({ output: [{ type: 'text', text: 'full retained answer' }] })
    await run.dispose()
    await dispose()
    expect(f.ctx.agents.get(root.id)).toBeUndefined()
    expect(f.ctx.agents.get(f.parent.id)).toBe(f.parent)
  })

  it('preserves registration and cleanup failures together', async () => {
    const f = await setup()
    const registrationError = new Error('registration rejected')
    const cleanupError = new Error('root cleanup rejected')
    const create = vi.spyOn(f.ctx.agents, 'create').mockResolvedValue(f.handle)
    const register = vi.spyOn(provider, 'registerStandaloneRoot').mockImplementation(() => { throw registrationError })
    const dispose = vi.spyOn(f.handle, 'dispose').mockRejectedValue(cleanupError)
    try {
      await expect(applyHost(f.ctx, hostConfig)).rejects.toMatchObject({ errors: [registrationError, cleanupError] })
      expect(dispose).toHaveBeenCalledTimes(1)
    } finally {
      dispose.mockRestore(); register.mockRestore(); create.mockRestore()
    }
  })

  it('attempts root cleanup after revocation rejects and preserves both errors', async () => {
    const f = await setup()
    const order: string[] = []
    const revokeError = new Error('revocation rejected')
    const cleanupError = new Error('root cleanup rejected')
    const create = vi.spyOn(f.ctx.agents, 'create').mockResolvedValue(f.handle)
    const register = vi.spyOn(provider, 'registerStandaloneRoot').mockReturnValue(async () => { order.push('revoke'); throw revokeError })
    const dispose = vi.spyOn(f.handle, 'dispose').mockImplementation(async () => { order.push('dispose'); throw cleanupError })
    try {
      const teardown = await applyHost(f.ctx, hostConfig)
      await expect(teardown()).rejects.toMatchObject({ errors: [revokeError, cleanupError] })
      expect(order).toEqual(['revoke', 'dispose'])
    } finally {
      dispose.mockRestore(); register.mockRestore(); create.mockRestore()
    }
  })
})
