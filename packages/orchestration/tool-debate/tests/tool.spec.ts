import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import DebateService, {
  type DebateControlRequestV1,
  type DebateEventPageV1,
  type DebateEventReadRequestV1,
  type DebateRunSnapshotV1,
  type DebateRunSummaryV1,
  type DebateStartRequestV1,
} from '@deepseek-ai/dsh-debate'
import LlmRuntime, { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import * as tool from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.root.fiber.dispose()
})

function snapshot(overrides: Partial<DebateRunSnapshotV1> = {}): DebateRunSnapshotV1 {
  const evidence = { version: 1 as const, ref: 'artifact:evidence', kind: 'artifact' as const }
  const ledger = { version: 1 as const, claims: [], coverage: 1, digest: 'sha256:ledger' }
  return {
    version: 1,
    runId: 'debate-run-1',
    revision: 4,
    state: 'completed',
    mode: 'enabled',
    promptSha256: 'sha256:prompt',
    objective: 'Reach an evidence-backed decision.',
    policy: tool.DEFAULT_DEBATE_POLICY,
    roster: tool.DEFAULT_DEBATE_POLICY.roster,
    currentRound: 1,
    rounds: [{
      version: 1,
      round: 1,
      state: 'completed',
      turns: [],
      claimLedger: ledger,
      dissent: [],
      unresolved: [],
      convergence: {
        version: 1,
        status: 'converged',
        score: 0.9,
        threshold: 0.82,
        disagreement: 0.1,
        coverage: 1,
        unresolvedHighSeverity: 0,
        settledAgents: 4,
        reason: 'evidence-backed convergence',
      },
    }],
    claimLedger: ledger,
    dissent: [],
    unresolved: [],
    evidence: { version: 1, refs: [evidence], coverage: 1, missingRefs: [], lineage: ['artifact:evidence'] },
    cost: {
      version: 1,
      usageStatus: 'known',
      costStatus: 'known',
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsd: 0,
      unknownUsageTurns: 0,
      unknownCostTurns: 0,
      bySlot: [],
    },
    provenance: {
      version: 1,
      providerId: 'fixture',
      providerVersion: '1',
      requestSha256: 'sha256:request',
      policySha256: 'sha256:policy',
      sourceSessionId: 'session-debate',
      outputSha256: 'sha256:output',
    },
    synthesis: {
      version: 1,
      state: 'settled',
      artifactRef: 'artifact:synthesis',
      outputPreview: 'Decision summary',
      unresolvedClaimIds: [],
      dissentCount: 0,
    },
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:01:00.000Z',
    ...overrides,
  }
}

class ScriptedDebates extends DebateService {
  readonly run = snapshot()
  readonly starts: DebateStartRequestV1[] = []
  readonly controls: DebateControlRequestV1[] = []

  async start(request: DebateStartRequestV1): Promise<DebateRunSnapshotV1> {
    this.starts.push(request)
    return this.run
  }

  async list(): Promise<readonly DebateRunSummaryV1[]> {
    return Array.from({ length: 22 }, (_, index) => ({
      version: 1,
      runId: `run-${index}`,
      state: 'completed',
      mode: 'enabled',
      currentRound: 1,
      revision: index,
      unresolvedCount: 0,
      cost: this.run.cost,
      updatedAt: this.run.updatedAt,
    }))
  }

  async inspect(_runId: string): Promise<DebateRunSnapshotV1> { return this.run }
  async readEvents(_request: DebateEventReadRequestV1): Promise<DebateEventPageV1> {
    return { events: [], nextSequence: 0 }
  }

  async control(request: DebateControlRequestV1): Promise<DebateRunSnapshotV1> {
    this.controls.push(request)
    return this.run
  }
}

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(ScriptedDebates)
  await ctx.plugin(tool)
  const session = ctx.sessions.create(SessionId('session-debate'), { meta: { cwd: '/workspace' } })
  const agent = { id: session.id, session } as Agent
  return { ctx, agent, provider: ctx.debates as ScriptedDebates }
}

let calls = 0
function call(ctx: Context, agent: Agent | undefined, argumentsValue: unknown, callId?: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId ?? `debate-${++calls}`),
    name: 'debate',
    arguments: argumentsValue,
    ...agent === undefined ? {} : { agent },
  })
}

function resultValue(result: Awaited<ReturnType<typeof call>>): Record<string, unknown> {
  expect(result.isError).toBe(false)
  return result.isError ? {} : result.value as Record<string, unknown>
}

describe('debate model Consumer', () => {
  it('keeps legacy Sessions disabled and persists an ignorable whole-value mode', async () => {
    const { ctx, agent } = await setup()
    expect(tool.foldDebatePreferences([])).toEqual({ mode: 'disabled' })
    expect(tool.foldDebatePreferences([{ type: 'debate/preferences', data: { mode: 'future-mode' } }]))
      .toEqual({ mode: 'disabled' })
    expect(ctx.sessionProjections.snapshot(agent.session).values.debateExecutionPreferences).toEqual({
      mode: 'disabled',
      options: ['auto', 'enabled', 'disabled'],
    })

    const changed = await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    expect(changed?.result).toEqual({ kind: 'success', text: 'debate mode enabled' })
    expect(agent.session.events.find(event => event.type === 'debate/preferences')).toMatchObject({
      data: { mode: 'enabled' },
      ignorable: true,
    })
    expect(ctx.sessionProjections.snapshot(agent.session).values.debateExecutionPreferences?.mode).toBe('enabled')

    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    expect(agent.session.events.filter(event => event.type === 'debate/preferences')).toHaveLength(1)
  })

  it('advertises a provider-neutral tool and a bounded subscription-first roster', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(candidate => candidate.name === 'debate')
    expect(schema).toBeDefined()
    expect(Object.keys(schema!.parameters.properties as object).sort()).toEqual([
      'action', 'control_action', 'expected_revision', 'objective', 'prompt', 'reason', 'run_id',
    ])
    expect(tool.DEFAULT_DEBATE_POLICY.roster.map(role => [role.role, role.operatorId, role.model])).toEqual([
      ['constructive-proposer', 'codex', 'gpt-5.6-sol'],
      ['skeptical-falsifier', 'claude-code', 'claude-fable-5'],
      ['evidence-auditor', 'codex', 'gpt-5.6-sol'],
      ['decision-judge', 'claude-code', 'claude-opus-5'],
    ])
    expect(tool.DEFAULT_DEBATE_POLICY.budget).toMatchObject({ maxRounds: 3, maxAgentsPerRound: 4 })
    expect(tool.DEFAULT_DEBATE_POLICY.preserveDissent).toBe(true)
    expect(tool.debateGuidance).toContain('does not replace the DSH TaskGraph Scheduler')
  })

  it('fails closed while disabled, then starts with stable identity, workspace, and Session lineage', async () => {
    const { ctx, agent, provider } = await setup()
    const disabled = await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.' }, 'same-call')
    expect(disabled.isError).toBe(true)
    expect(disabled.content.some(block => block.type === 'text'
      && block.text.includes('Debate is disabled'))).toBe(true)

    await ctx.commands.execute(agent, '/debate-mode enabled', new AbortController().signal)
    const started = await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.', objective: 'Choose safely.' }, 'same-call')
    expect(resultValue(started)).toMatchObject({ kind: 'start', run: { runId: 'debate-run-1', state: 'completed' } })
    expect(provider.starts).toHaveLength(1)
    expect(provider.starts[0]).toMatchObject({
      workspace: '/workspace',
      prompt: 'Choose A or B.',
      objective: 'Choose safely.',
      sourceSessionId: 'session-debate',
      execution: { version: 1, kind: 'standalone' },
      policy: { mode: 'enabled', preserveDissent: true, budget: { maxRounds: 3, maxAgentsPerRound: 4 } },
    })
    expect(provider.starts[0]?.commandId).toMatch(/^debate-tool-[a-f0-9]{32}$/u)
    expect(agent.session.events.find(event => event.type === 'debate/admission')).toMatchObject({
      data: { runId: 'debate-run-1', mode: 'enabled' },
      ignorable: true,
    })

    const commandId = provider.starts[0]?.commandId
    await call(ctx, agent, { action: 'start', prompt: 'Choose A or B.' }, 'same-call')
    expect(provider.starts[1]?.commandId).toBe(commandId)
  })

  it('lists, inspects, and revision-fences controls with bounded projections', async () => {
    const { ctx, agent, provider } = await setup()
    const listed = resultValue(await call(ctx, agent, { action: 'list' }))
    expect((listed.runs as unknown[])).toHaveLength(20)
    expect(listed.truncated).toBe(true)

    const inspected = resultValue(await call(ctx, agent, { action: 'inspect', run_id: 'debate-run-1' }))
    expect(inspected).toMatchObject({
      kind: 'inspect',
      run: { runId: 'debate-run-1', synthesis: { artifactRef: 'artifact:synthesis', outputPreview: 'Decision summary' } },
    })
    expect(JSON.stringify(inspected)).not.toContain('Constructive Proposer')

    const controlled = resultValue(await call(ctx, agent, {
      action: 'control',
      run_id: 'debate-run-1',
      expected_revision: 4,
      control_action: 'pause',
      reason: 'Review the evidence.',
    }))
    expect(controlled).toMatchObject({ kind: 'control', run: { runId: 'debate-run-1' } })
    expect(provider.controls[0]).toMatchObject({
      runId: 'debate-run-1', expectedRevision: 4, action: 'pause', reason: 'Review the evidence.',
    })
  })
})
