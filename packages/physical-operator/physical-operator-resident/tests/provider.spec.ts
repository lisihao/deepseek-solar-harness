import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import PhysicalOperatorRuntime from '@deepseek-ai/dsh-physical-operator'
import ResidentOperatorService, {
  ResidentOperatorCommandId,
  ResidentOperatorSessionId,
  ResidentOperatorTurnId,
  type ResidentExecuteRequest,
} from '@deepseek-ai/dsh-resident-operator'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, {
  type ResolvedSubagentStartRequest,
  type SubagentProvider,
  type SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import * as provider from '../src/index.ts'

function parent(): Agent {
  return {
    id: SessionId('parent'),
    session: { header: { cwd: '/workspace' } },
  } as unknown as Agent
}

class OneShotProvider implements SubagentProvider {
  readonly name = 'codex'
  readonly authentication = { mode: 'native-subscription' as const }
  readonly capabilities = { outputSchema: false, depthLimit: false, toolFilter: false, persona: false }
  readonly inheritsParentContext = false
  starts = 0

  start(_request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    this.starts += 1
    return Promise.resolve({
      id: SessionId('child'),
      localAgent: undefined,
      result: Promise.resolve({ output: [{ type: 'text', text: 'ephemeral' }], stopReason: 'completed' }),
      dispose: () => Promise.resolve(),
    })
  }
}

class ResidentStub extends ResidentOperatorService {
  requests: ResidentExecuteRequest[] = []
  providers() { return Promise.resolve([]) }
  execute(request: ResidentExecuteRequest) {
    this.requests.push(request)
    return Promise.resolve({
      turnId: ResidentOperatorTurnId('turn'),
      sessionId: ResidentOperatorSessionId('resident-session'),
      stateRevision: 7,
      result: Promise.resolve({ output: [{ type: 'text' as const, text: 'resident' }], stopReason: 'completed' as const }),
      dispose: () => Promise.resolve(),
    })
  }
  list() { return Promise.resolve([]) }
  inspect(): Promise<never> { return Promise.reject(new Error('unused')) }
  inspectTurn(): Promise<never> { return Promise.reject(new Error('unused')) }
  readEvents() { return Promise.resolve({ events: [], nextSequence: 0 }) }
  interrupt() { return Promise.resolve() }
  reset(): Promise<never> { return Promise.reject(new Error('unused')) }
  resolveIndeterminate() { return Promise.resolve() }
}

describe('physical-operator-resident', () => {
  it('registers a resident-only product and fails loud when ephemeral mode is requested', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(PhysicalOperatorRuntime)
    new ResidentStub(ctx)
    await ctx.plugin(provider, {
      operators: [{
        id: 'prime-agent', residentProvider: 'prime-agent',
        displayName: 'Prime Agent', description: 'Runs bounded RLM recursion through the user subscription.',
      }],
    })

    expect(ctx.physicalOperators.status('prime-agent')).toMatchObject({
      state: 'available',
      executionModes: ['resident'],
    })
    await expect(ctx.physicalOperators.start('prime-agent', {
      prompt: [{ type: 'text', text: 'default mode remains ephemeral' }],
      parent: parent(), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'OPERATOR_MODE_UNSUPPORTED' })
    const resident = await ctx.physicalOperators.start('prime-agent', {
      mode: 'resident', prompt: [{ type: 'text', text: 'explore recursively' }],
      parent: parent(), signal: new AbortController().signal,
    })
    await expect(resident.result).resolves.toMatchObject({ stopReason: 'completed' })
    expect((ctx.residentOperators as ResidentStub).requests[0]).toMatchObject({ operatorId: 'prime-agent' })
  })

  it('keeps ephemeral as default and routes only explicit resident calls to the durable seam', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(PhysicalOperatorRuntime)
    new ResidentStub(ctx)
    const oneShot = new OneShotProvider()
    ctx.subagents.registerProvider(oneShot)
    await ctx.plugin(provider, {
      operators: [{
        id: 'codex', ephemeralProvider: 'codex', residentProvider: 'codex',
        displayName: 'Codex', description: 'Runs Codex through the user subscription.',
      }],
    })

    expect(ctx.physicalOperators.status('codex').executionModes).toEqual(['ephemeral', 'resident'])
    const ephemeral = await ctx.physicalOperators.start('codex', {
      prompt: [{ type: 'text', text: 'one shot' }], parent: parent(), signal: new AbortController().signal,
    })
    expect(await ephemeral.result).toMatchObject({ output: [{ text: 'ephemeral' }] })
    expect(oneShot.starts).toBe(1)

    const resident = await ctx.physicalOperators.start('codex', {
      mode: 'resident', label: 'Continue the proof', prompt: [{ type: 'text', text: 'continue' }],
      parent: parent(), signal: new AbortController().signal,
    })
    expect(await resident.result).toEqual({
      output: [{ type: 'text', text: 'resident' }],
      stopReason: 'completed',
      continuity: { sessionId: 'resident-session', stateRevision: 7 },
    })
    expect((ctx.residentOperators as ResidentStub).requests[0]).toMatchObject({
      commandId: ResidentOperatorCommandId(String(resident.id)),
      operatorId: 'codex',
      workspace: '/workspace',
      laneId: 'parent',
      taskLabel: 'Continue the proof',
    })
    expect(oneShot.starts).toBe(1)
  })

  it('keeps resident available when only the ephemeral subagent lacks subscription attestation', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(PhysicalOperatorRuntime)
    new ResidentStub(ctx)
    const unqualified = new OneShotProvider()
    Object.defineProperty(unqualified, 'authentication', { value: undefined })
    ctx.subagents.registerProvider(unqualified)
    await ctx.plugin(provider, {
      operators: [{
        id: 'codex', ephemeralProvider: 'codex', residentProvider: 'codex',
        displayName: 'Codex', description: 'Runs Codex through the user subscription.',
      }],
    })

    expect(ctx.physicalOperators.status('codex')).toMatchObject({ state: 'available' })
    await expect(ctx.physicalOperators.start('codex', {
      mode: 'ephemeral', prompt: [{ type: 'text', text: 'one shot' }],
      parent: parent(), signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'OPERATOR_UNAVAILABLE' })

    const resident = await ctx.physicalOperators.start('codex', {
      mode: 'resident', prompt: [{ type: 'text', text: 'continue' }],
      parent: parent(), signal: new AbortController().signal,
    })
    await expect(resident.result).resolves.toMatchObject({ stopReason: 'completed' })
  })
})
