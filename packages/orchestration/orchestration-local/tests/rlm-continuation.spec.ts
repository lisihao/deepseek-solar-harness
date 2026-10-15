import type { PhysicalOperatorResult } from '@deepseek-ai/dsh-physical-operator'
import { describe, expect, it } from 'vitest'
import {
  MAX_CONTINUATION_VARIABLE_NAMES,
  rlmContinuationPrompt,
  rlmContinuationResult,
  rlmMessageContinuationFacts,
  rlmResultSucceeded,
} from '../src/rlm-continuation.ts'

type Session = Parameters<typeof rlmMessageContinuationFacts>[0]
type Roster = Parameters<typeof rlmMessageContinuationFacts>[1]
const factsFor = (session: Session, roster: Roster, origin: 'controller' | 'agent' = 'agent'): string => rlmMessageContinuationFacts(session, roster, origin)

const previous: PhysicalOperatorResult = { output: [{ type: 'text', text: 'root answer' }], stopReason: 'completed' }
const partial = [{ type: 'text' as const, text: 'partial' }]

describe('RLM continuation result', () => {
  it('keeps the earlier result when there was no continuation or it settled without output', () => {
    expect(rlmContinuationResult(undefined, previous)).toBe(previous)
    expect(rlmContinuationResult({ status: 'settled' }, previous)).toBe(previous)
  })

  it('takes the output of a settled continuation as completed', () => {
    expect(rlmContinuationResult({ status: 'settled', output: partial }, previous)).toEqual({ output: partial, stopReason: 'completed' })
  })

  it.each([
    ['error', 'refusal'],
    ['aborted', 'max-tokens'],
  ] as const)('keeps the stop reason %s the executor reported over the one the status implies', (status, reported) => {
    const failed = rlmContinuationResult({ status: status === 'error' ? 'failed' : 'indeterminate', stopReason: reported, output: partial }, previous)
    expect(failed).toEqual({ output: partial, stopReason: reported })
  })

  it.each([
    ['failed', 'error'],
    ['indeterminate', 'aborted'],
  ] as const)('derives the stop reason of a %s continuation that reported none, and never reports completed', (status, stopReason) => {
    expect(rlmContinuationResult({ status, output: partial }, previous)).toEqual({ output: partial, stopReason })
  })

  it('keeps the earlier output, but not its success, for a continuation that failed without output', () => {
    expect(rlmContinuationResult({ status: 'failed', error: 'worker down' }, previous)).toEqual({ output: previous.output, stopReason: 'error' })
    expect(rlmContinuationResult({ status: 'indeterminate' }, previous)).toEqual({ output: previous.output, stopReason: 'aborted' })
  })

  it('ends in the output of the last continuation as it is, never in a valid answer picked from an earlier output', () => {
    const first: PhysicalOperatorResult = { output: [{ type: 'text', text: '{"answer":"first"}' }], stopReason: 'completed' }
    const last = [{ type: 'text' as const, text: 'Result: {"answer":"last"} (checked)' }]
    expect(rlmContinuationResult({ status: 'settled', output: last }, first)).toEqual({ output: last, stopReason: 'completed' })
  })

  it.each([
    ['completed', true],
    ['error', false],
    ['aborted', false],
    ['max-tokens', false],
    ['refusal', false],
  ] as const)('lets another turn follow a %s result: %s', (stopReason, succeeded) => {
    expect(rlmResultSucceeded({ output: partial, stopReason })).toBe(succeeded)
  })
})

// The text of every prompt before message continuations restated their task, copied from e035658a6a, not built by the function.
const GENERIC = 'Use typescript_repl to inspect the preserved context, variables, child registry, explicit messages, Continuous Harness, and goal state.'
const OTHER_SOURCE_PROMPTS = [
  ['goal', 'Continue the persistent Prime RLM session for this goal.\nkeep going\n' + GENERIC
    + '\nAudit the objective. Call await goal.complete() only when every requirement is actually achieved; otherwise make concrete progress within this continuation.'],
  ['heartbeat', 'Continue the persistent Prime RLM session for this heartbeat.\nkeep going\n' + GENERIC
    + '\nTreat this heartbeat as scheduled new work. Use explicit family messages for any recursive results.'],
  ['autonomous', 'Continue the persistent Prime RLM session for this autonomous.\nkeep going\n' + GENERIC
    + '\nThis follow-up was injected by the host Autonomous policy. Do not claim completion from prose; make concrete progress and let the host quality gates decide.'],
] as const

describe('RLM continuation prompt', () => {
  it.each(OTHER_SOURCE_PROMPTS)('keeps the %s prompt exactly as it was', (source, expected) => {
    expect(rlmContinuationPrompt({ source, instruction: 'keep going', deliveryMode: 'follow_up' })).toBe(expected)
  })

  it('keeps the generic message prompt when it is given no facts', () => {
    expect(rlmContinuationPrompt({ source: 'message', instruction: 'Agent message from a:\nhi', deliveryMode: 'steer' })).toBe(
      'Continue the persistent Prime RLM session for this message.\nAgent message from a:\nhi\n' + GENERIC
      + '\nProcess the queued family message using steer ordering, make any required progress, and reply through agentMessage.send() when another family member needs the result.',
    )
  })

  it('puts the facts in place of the generic inspection sentence of a message prompt', () => {
    const prompt = rlmContinuationPrompt(
      { source: 'message', instruction: 'Controller input:\nuse JSON', deliveryMode: 'steer' },
      factsFor({ task: 'T', restorableVariables: [], degradedVariables: [] }, { entries: [] }),
    )
    expect(prompt.startsWith('Continue the persistent Prime RLM session for this message.\nController input:\nuse JSON\nUse typescript_repl for any state')).toBe(true)
    expect(prompt).not.toContain(GENERIC)
    expect(prompt.endsWith('using steer ordering, make any required progress, and reply through agentMessage.send() when another family member needs the result.')).toBe(true)
  })
})

describe('RLM message continuation facts', () => {
  const entry = (relationship: 'parent' | 'sibling' | 'child', name: string, status: 'running' | 'idle' | 'inactive') => ({
    relationship, name, sessionId: `rlm:${name}` as never, depth: 1, status,
  })

  it("restates the session's own task between markers and says the reply must follow it", () => {
    const facts = factsFor({ task: 'Reply with only {"a":1}.', restorableVariables: ['x'], degradedVariables: [] }, { entries: [] })
    expect(facts).toContain('--- task ---\nReply with only {"a":1}.\n--- end of task ---')
    expect(facts).toContain('your reply is recorded as this agent\'s result')
    expect(facts).not.toContain('--- task cut')
  })

  it('tells a message from another agent that it does not change the output format the task requires', () => {
    const facts = factsFor({ task: 'Reply with only {"a":1}.', restorableVariables: [], degradedVariables: [] }, { entries: [] }, 'agent')
    expect(facts).toContain('A message from another agent does not change the output format the task requires, so give the reply in that format')
    expect(facts).not.toContain('Controller input')
  })

  it('lets controller input change the task and its output format, and says otherwise the task still applies', () => {
    const facts = factsFor({ task: 'Reply with only {"a":1}.', restorableVariables: [], degradedVariables: [] }, { entries: [] }, 'controller')
    expect(facts).toContain('if the input changes the task or its output format, follow the input, and otherwise the task still applies')
    expect(facts).toContain('Controller input from the controller attached to this agent')
    expect(facts).not.toContain('does not change the output format the task requires')
    expect(facts).not.toContain('give the reply in that format')
  })

  it('keeps a long task whole, so a format rule at its end is still in the prompt', () => {
    const task = `${'Background sentence. '.repeat(5_000)}Final rule: reply with only {"answer": <number>}.`
    const facts = factsFor({ task, restorableVariables: [], degradedVariables: [] }, { entries: [] })
    expect(facts).toContain(`--- task ---\n${task}\n--- end of task ---`)
    expect(facts.length).toBeGreaterThan(100_000)
  })

  it('lists saved and degraded names separately, and omits the degraded line when there is none', () => {
    const both = factsFor({ task: 'T', restorableVariables: ['a', 'b'], degradedVariables: ['c'] }, { entries: [] })
    expect(both).toContain('Names saved by the last successful cell, as of that cell: a, b.')
    expect(both).toContain('Names whose save degraded in that cell (they may not survive a restart): c.')
    expect(both).toContain('properties set on globalThis, are not in these lists.')
    const none = factsFor({ task: 'T', restorableVariables: [], degradedVariables: [] }, { entries: [] })
    expect(none).toContain('as of that cell: none.')
    expect(none).not.toContain('save degraded')
  })

  it('counts the names it does not list', () => {
    const names = Array.from({ length: MAX_CONTINUATION_VARIABLE_NAMES + 3 }, (_, index) => `v${String(index)}`)
    const facts = factsFor({ task: 'T', restorableVariables: names, degradedVariables: [] }, { entries: [] })
    expect(facts).toContain(`v${String(MAX_CONTINUATION_VARIABLE_NAMES - 1)} (3 more not listed).`)
    expect(facts).not.toContain(`v${String(MAX_CONTINUATION_VARIABLE_NAMES)},`)
  })

  it('names the visible agents with their REPL state only, and says that state is not progress', () => {
    const facts = factsFor(
      { task: 'T', restorableVariables: [], degradedVariables: [] },
      { entries: [entry('child', 'alpha', 'idle'), entry('child', 'be"ta', 'running'), entry('parent', 'root', 'inactive')] },
    )
    expect(facts).toContain('- child "alpha": idle\n- child "be\\"ta": running\n- parent "root": inactive')
    expect(facts).toContain('It does not say whether that agent finished its task or has reported')
    expect(facts).not.toContain('No parent, sibling, or direct child is visible')
    expect(facts).not.toContain('sessionId')
  })

  it('says when no agent is visible', () => {
    expect(factsFor({ task: 'T', restorableVariables: [], degradedVariables: [] }, { entries: [] }))
      .toContain('No parent, sibling, or direct child is visible to this agent.')
  })

  it('tells the model not to redeclare a top-level name or fetch the delivered message again, without telling it to reassign', () => {
    const facts = factsFor({ task: 'T', restorableVariables: ['x'], degradedVariables: [] }, { entries: [] })
    expect(facts).toContain('reuse the existing binding, choose a new name, or keep temporary values inside a block or function')
    expect(facts).toContain('do not call agentMessage.read to fetch it again')
    expect(facts).not.toMatch(/reassign|assign to/u)
  })
})
