import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { LogicalTaskGraphV1 } from '@deepseek-ai/dsh-orchestration'
import { validateGraph } from '@deepseek-ai/dsh-orchestration-local'
import * as tool from '../src/index.ts'
import { foldOrchestrationPreferences, orchestrationGuidance, orchestrationGraphGuidance } from '../src/index.ts'

async function setupCommand(): Promise<{ readonly ctx: Context; readonly agent: Agent }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.provide('orchestrations', {} as never)
  await ctx.plugin(tool)
  const session = ctx.sessions.create(SessionId('orchestration-strategy'))
  return { ctx, agent: { id: session.id, session } as Agent }
}

describe('orchestration model guidance', () => {
  it('exposes every Resident operator and preserves explicit user selection', () => {
    expect(orchestrationGuidance).toContain('Codex')
    expect(orchestrationGuidance).toContain('Claude Code')
    expect(orchestrationGuidance).toContain('RLM')
    expect(orchestrationGuidance).toContain('Continuous Harness')
    expect(orchestrationGuidance).toContain('Autonomous Mode')
    expect(orchestrationGuidance).not.toContain('Prime Agent')
    expect(orchestrationGuidance).toContain('intelligent routing')
    expect(orchestrationGuidance).toContain('fail rather than silently switch products')
    expect(orchestrationGuidance).toContain('clean-task Context Capsule')
    expect(orchestrationGuidance).toContain('without a phase barrier')
    expect(orchestrationGuidance).toContain('Sol for planning/verification')
    expect(orchestrationGuidance).toContain('Luna for qualified coding leaves')
  })

  it('gives the model a complete read-only graph accepted by the actual graph validator', () => {
    const example = JSON.parse(orchestrationGraphGuidance.slice(orchestrationGraphGuidance.indexOf('{"version":1'))) as LogicalTaskGraphV1
    expect(validateGraph(example)).toEqual(['read-readme'])
    expect(example.nodes[0]?.effectBudget).toEqual({ read: ['README.md'], write: [], execute: [], network: [], cost: [], risk: [] })
    expect(orchestrationGraphGuidance).toContain('Gouzi ids route through this tool only')
    expect(orchestrationGraphGuidance).toContain('repair the reported graph field')
    const { title: _title, ...missingTitle } = example
    expect(() => validateGraph(missingTitle)).toThrow('graph.title must be non-blank and trimmed')
  })

  it('defaults to Auto and preserves explicit RLM or Standard choices for comparison', () => {
    expect(foldOrchestrationPreferences([])).toEqual({
      rlm: 'auto', autonomous: 'disabled', continualHarness: 'auto', optimization: 'balanced',
      plannerVerifierPreference: 'codex-sol', executionPreference: 'luna-first',
    })
    expect(foldOrchestrationPreferences([{
      type: 'orchestration/preferences',
      data: { rlm: 'enabled', continualHarness: 'session', optimization: 'quality' },
    }])).toEqual({
      rlm: 'enabled', autonomous: 'disabled', continualHarness: 'session', optimization: 'quality',
      plannerVerifierPreference: 'codex-sol', executionPreference: 'luna-first',
    })
    expect(foldOrchestrationPreferences([{
      type: 'orchestration/preferences',
      data: { rlm: 'disabled', continualHarness: 'off', optimization: 'balanced' },
    }])).toEqual({
      rlm: 'disabled', autonomous: 'disabled', continualHarness: 'off', optimization: 'balanced',
      plannerVerifierPreference: 'codex-sol', executionPreference: 'luna-first',
    })
    expect(foldOrchestrationPreferences([{
      type: 'orchestration/preferences',
      data: {
        rlm: 'disabled', continualHarness: 'global', optimization: 'balanced',
        plannerVerifierPreference: 'best-high-tier', executionPreference: 'balanced',
      },
    }])).toEqual({
      rlm: 'disabled', autonomous: 'disabled', continualHarness: 'global', optimization: 'balanced',
      plannerVerifierPreference: 'best-high-tier', executionPreference: 'balanced',
    })
  })

  it('rejects Autonomous Mode with disabled RLM before appending a preference', async () => {
    const { ctx, agent } = await setupCommand()
    const result = await ctx.commands.execute(
      agent,
      '/orchestration-strategy disabled enabled auto balanced codex-sol luna-first',
      new AbortController().signal,
    )
    expect(result?.result).toEqual({ kind: 'error', text: 'autonomous=enabled requires rlm=auto or enabled' })
    expect(agent.session.events.some(event => event.type === 'orchestration/preferences')).toBe(false)
  })

  it('preserves valid automatic RLM and Autonomous selections', async () => {
    const { ctx, agent } = await setupCommand()
    const result = await ctx.commands.execute(
      agent,
      '/orchestration-strategy auto enabled auto balanced codex-sol luna-first',
      new AbortController().signal,
    )
    expect(result?.result).toEqual({ kind: 'success', text: 'orchestration strategy auto/enabled/auto/balanced/codex-sol/luna-first' })
    expect(agent.session.events.find(event => event.type === 'orchestration/preferences')?.data).toMatchObject({
      rlm: 'auto', autonomous: 'enabled',
    })
  })
})
