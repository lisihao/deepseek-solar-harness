import type { PhysicalOperatorResult } from '@deepseek-ai/dsh-physical-operator'
import { describe, expect, it } from 'vitest'
import { rlmContinuationResult } from '../src/rlm-continuation.ts'

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
})
