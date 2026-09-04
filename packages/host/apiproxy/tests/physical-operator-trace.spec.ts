import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { PhysicalOperatorValueShape } from '../src/api/events.ts'

import { projectPublicSessionEvent } from '../src/physical-operator-trace.ts'

function event(type: string, data: unknown): SessionEvent {
  return { type, seq: 1, time: 1, data } as unknown as SessionEvent
}

function physical(kind: string, data: unknown): SessionEvent {
  return event(`physical-operator/${kind}`, data)
}

function project(kind: string, data: unknown) {
  const result = projectPublicSessionEvent(physical(kind, data))
  expect(result.event.data).toEqual({})
  return result.physicalOperatorTrace
}

describe('projectPublicSessionEvent', () => {
  it('leaves non-physical events unchanged', () => {
    const source = event('assistant/message', { secret: 'kept' })
    const result = projectPublicSessionEvent(source)

    expect(result).toEqual({ event: source })
    expect(result.event).toBe(source)
    expect(result.physicalOperatorTrace).toBeUndefined()
  })

  it('redacts malformed and unknown physical events', () => {
    for (const data of [null, [], 'text', 42, true, undefined]) {
      expect(project('future-event', data)).toBeUndefined()
    }

    expect(project('future-event', {})).toBeUndefined()
    expect(project('future-event', { commandId: 'future-command' })).toBeUndefined()
    expect(project('future-event', { commandId: '' })).toBeUndefined()
    expect(project('future-event', { commandId: 123 })).toBeUndefined()
  })

  it('projects dispatch and lifecycle events with safe identities', () => {
    expect(project('dispatch', {
      commandId: 'dispatch-codex',
      operatorId: 'codex',
      turn: 2,
      step: 3,
    })).toMatchObject({
      version: 1,
      kind: 'dispatch',
      operator: 'codex',
      turn: 2,
      step: 3,
    })

    expect(project('dispatch', {
      commandId: 'dispatch-claude',
      operatorId: 'claude-code',
      turn: 0,
      step: 0,
    })).toMatchObject({ kind: 'dispatch', operator: 'claude-code', turn: 0, step: 0 })

    expect(project('dispatch', {
      commandId: 'dispatch-default',
      operatorId: 'other-provider',
      turn: -1,
      step: 1.5,
    })).toMatchObject({ kind: 'dispatch', operator: 'physical-operator', turn: 0, step: 0 })

    expect(project('tool-dispatch', {
      commandId: 'tool-dispatch-command',
      operatorId: 'codex',
      turn: 9,
      step: 8,
    })).toMatchObject({ kind: 'dispatch', operator: 'codex', turn: 0, step: 0 })

    expect(project('dispatch', { operatorId: 'codex' })).toBeUndefined()
    expect(project('dispatch-terminal', { commandId: 'terminal-command' })).toMatchObject({
      version: 1,
      kind: 'terminal',
      outcome: 'error',
    })
    expect(project('trace-degraded', { commandId: 'degraded-command' })).toMatchObject({
      version: 1,
      kind: 'degraded',
    })
    expect(project('dispatch-terminal', {})).toBeUndefined()
    expect(project('trace-degraded', { commandId: '' })).toBeUndefined()
  })

  it('projects progress phases and normalizes source sequence values', () => {
    const phases = [
      ['connecting', 'connecting'],
      ['session_ready', 'session-ready'],
      ['reasoning', 'reasoning'],
      ['tool_activity', 'tool-activity'],
      ['finalizing', 'finalizing'],
      ['unknown', 'working'],
      [undefined, 'working'],
    ] as const

    for (const [nativePhase, expectedPhase] of phases) {
      expect(project('progress', {
        commandId: `progress-${String(nativePhase)}`,
        sequence: 7,
        type: 'turn.progress',
        data: { phase: nativePhase },
      })).toMatchObject({ kind: 'progress', sourceSequence: 7, phase: expectedPhase })
    }

    for (const sequence of [-1, 1.5, Number.NaN, '7', undefined]) {
      expect(project('progress', {
        commandId: `invalid-sequence-${String(sequence)}`,
        sequence,
        type: 'turn.progress',
        data: { phase: 'reasoning' },
      })).toMatchObject({ kind: 'progress', sourceSequence: 0 })
    }

    expect(project('progress', {
      commandId: 'settled-success',
      sequence: 9,
      type: 'turn.settled',
      data: { stopReason: 'completed' },
    })).toMatchObject({ kind: 'terminal', sourceSequence: 9, outcome: 'success' })
    expect(project('progress', {
      commandId: 'settled-error',
      sequence: 10,
      type: 'turn.settled',
      data: { stopReason: 'interrupted' },
    })).toMatchObject({ kind: 'terminal', sourceSequence: 10, outcome: 'error' })
    expect(project('progress', {
      commandId: 'settled-invalid',
      sequence: -1,
      type: 'turn.settled',
      data: null,
    })).toMatchObject({ kind: 'terminal', sourceSequence: 0, outcome: 'error' })
  })

  it('projects observation kinds and usage only when values are valid', () => {
    expect(project('progress', {
      commandId: 'observation-output',
      sequence: 1,
      type: 'turn.observation',
      data: { kind: 'public-output', preview: 'visible public output' },
    })).toMatchObject({ kind: 'public-output', sourceSequence: 1, preview: 'visible public output' })

    expect(project('progress', {
      commandId: 'observation-tool-start',
      sequence: 2,
      type: 'turn.observation',
      data: { kind: 'tool-started', toolName: 'Bash' },
    })).toMatchObject({ kind: 'native-tool', status: 'running', sourceSequence: 2, toolName: 'Bash' })
    expect(project('progress', {
      commandId: 'observation-tool-done',
      sequence: 3,
      type: 'turn.observation',
      data: { kind: 'tool-completed', toolName: 'Bash' },
    })).toMatchObject({ kind: 'native-tool', status: 'completed', sourceSequence: 3, toolName: 'Bash' })
    expect(project('progress', {
      commandId: 'observation-approval',
      sequence: 4,
      type: 'turn.observation',
      data: { kind: 'approval-required', approvalKind: 'Bash', preview: 'safe approval summary' },
    })).toMatchObject({ kind: 'approval-required', sourceSequence: 4, approvalKind: 'Bash', preview: 'safe approval summary' })

    expect(project('progress', {
      commandId: 'observation-usage-all',
      sequence: 5,
      type: 'turn.observation',
      data: {
        kind: 'usage-updated',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 40,
          costUsd: 1.25,
        },
      },
    })).toMatchObject({
      kind: 'usage',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      costUsd: 1.25,
      cacheWriteInputTokens: 40,
    })
    const partialUsage = project('progress', {
      commandId: 'observation-usage-partial',
      sequence: 6,
      type: 'turn.observation',
      data: {
        kind: 'usage-updated',
        usage: {
          inputTokens: 1,
          outputTokens: -1,
          cacheReadInputTokens: Number.POSITIVE_INFINITY,
          cacheWriteInputTokens: '40',
        },
      },
    })
    expect(partialUsage).toMatchObject({ version: 1, kind: 'usage', sourceSequence: 6, inputTokens: 1 })
    expect(partialUsage?.commandId).toMatch(/^trace-[0-9a-f]{24}$/)
    expect(partialUsage).not.toHaveProperty('outputTokens')
    expect(partialUsage).not.toHaveProperty('cacheReadInputTokens')
    expect(partialUsage).not.toHaveProperty('cacheWriteInputTokens')
    expect(project('progress', {
      commandId: 'observation-usage-output-only',
      sequence: 6,
      type: 'turn.observation',
      data: {
        kind: 'usage-updated',
        usage: { outputTokens: 2 },
      },
    })).toMatchObject({ kind: 'usage', outputTokens: 2 })

    for (const [index, usage] of [undefined, null, [], {}, 'not-an-object'].entries()) {
      expect(project('progress', {
        commandId: `observation-usage-invalid-${index}`,
        sequence: 7,
        type: 'turn.observation',
        data: { kind: 'usage-updated', usage },
      })).toBeUndefined()
    }
    expect(project('progress', {
      commandId: 'observation-unknown-kind',
      sequence: 8,
      type: 'turn.observation',
      data: { kind: 'future-observation' },
    })).toBeUndefined()
    expect(project('progress', {
      commandId: 'observation-invalid-native',
      sequence: 9,
      type: 'turn.observation',
      data: [],
    })).toBeUndefined()
    expect(project('progress', {
      commandId: 'progress-unknown-type',
      sequence: 10,
      type: 'future-progress-type',
      data: { phase: 'reasoning' },
    })).toBeUndefined()
    expect(project('progress', {
      commandId: 'progress-no-native',
      sequence: 11,
      type: 'turn.progress',
    })).toMatchObject({ kind: 'progress', phase: 'working', sourceSequence: 11 })
  })

  it('keeps public details bounded and scrubs credential-shaped text', () => {
    const trace = project('progress', {
      commandId: 'observation-scrubbed',
      sequence: 12,
      type: 'turn.observation',
      data: {
        kind: 'public-output',
        preview: 'safe output API_KEY=hidden sk-abcdef123456 ' + 'x'.repeat(2_000),
      },
    })
    expect(trace).toMatchObject({ kind: 'public-output' })
    expect(trace && 'preview' in trace ? trace.preview : undefined).toContain('safe output')
    expect(trace && 'preview' in trace ? trace.preview : undefined).not.toContain('hidden')
    expect(trace && 'preview' in trace ? trace.preview?.length : 0).toBeLessThanOrEqual(1_600)

    const keyTrace = project('progress', {
      commandId: 'observation-key',
      sequence: 13,
      type: 'turn.observation',
      data: {
        kind: 'public-output',
        preview: '-----BEGIN OPENSSH PRIVATE KEY-----\\nsecret\\n-----END OPENSSH PRIVATE KEY-----',
      },
    })
    expect(keyTrace && 'preview' in keyTrace ? keyTrace.preview : undefined).not.toContain('secret')
  })

  it('projects tool calls, including standalone calls and all value shapes', () => {
    const values: readonly [unknown, PhysicalOperatorValueShape][] = [
      [null, { kind: 'null' }],
      ['text', { kind: 'string', characters: 4 }],
      [1, { kind: 'number' }],
      [true, { kind: 'boolean' }],
      [['item'], { kind: 'array', items: 1 }],
      [{ field: 'value' }, { kind: 'object', fields: 1 }],
      [undefined, { kind: 'unavailable' }],
    ]

    for (const [index, [argumentsValue, argumentsShape]] of values.entries()) {
      expect(project('tool-call', {
        commandId: `tool-command-${index}`,
        toolCallId: `tool-call-${index}`,
        arguments: argumentsValue,
      })).toMatchObject({
        kind: 'tool',
        standalone: true,
        status: 'running',
        argumentsShape,
      })
    }

    expect(project('tool-call', {
      executionCommandId: 'execution-command',
      commandId: 'fallback-command',
      toolCallId: 'tool-call-with-execution',
      arguments: { safe: true },
    })).toMatchObject({ kind: 'tool', standalone: false, status: 'running' })
    expect(project('tool-call', {
      executionCommandId: null,
      commandId: 'null-execution-fallback',
      toolCallId: 'null-execution-tool',
      arguments: {},
    })).toMatchObject({ kind: 'tool', standalone: true })
    expect(project('tool-call', {
      executionCommandId: '',
      commandId: 'unused-command',
      toolCallId: 'empty-execution-tool',
    })).toMatchObject({ kind: 'tool', standalone: true })
    expect(project('tool-call', {
      commandId: 'invalid-tool-id-command',
      toolCallId: 123,
    })).toBeUndefined()
    expect(project('tool-call', {
      executionCommandId: 123,
      commandId: 'valid-fallback-not-used',
      toolCallId: 'tool-id',
    })).toMatchObject({ kind: 'tool', standalone: true })

    expect(project('tool-indeterminate', {
      commandId: 'indeterminate-command',
      toolCallId: 'indeterminate-tool',
    })).toMatchObject({ kind: 'tool', status: 'indeterminate' })
    expect(project('tool-indeterminate', {
      commandId: 'missing-tool-command',
    })).toMatchObject({ kind: 'tool', status: 'indeterminate', standalone: true })
    expect(project('tool-indeterminate', {})).toBeUndefined()
  })

  it('projects tool results with sanitized result shapes and error states', () => {
    expect(project('tool-result', {
      commandId: 'result-error-flag',
      toolCallId: 'result-error-flag-tool',
      result: { isError: true, value: 'error details' },
    })).toMatchObject({ kind: 'tool', status: 'error', resultShape: { kind: 'string', characters: 13 } })
    expect(project('tool-result', {
      commandId: 'result-error-field',
      toolCallId: 'result-error-field-tool',
      result: { error: 'error details', value: { safe: true } },
    })).toMatchObject({ kind: 'tool', status: 'error', resultShape: { kind: 'object', fields: 1 } })
    expect(project('tool-result', {
      commandId: 'result-value',
      toolCallId: 'result-value-tool',
      result: { value: { answer: 42 } },
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'object', fields: 1 } })
    expect(project('tool-result', {
      commandId: 'result-content',
      toolCallId: 'result-content-tool',
      result: { content: ['answer'] },
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'array', items: 1 } })
    expect(project('tool-result', {
      commandId: 'result-empty-object',
      toolCallId: 'result-empty-object-tool',
      result: {},
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'unavailable' } })

    expect(project('tool-result', {
      commandId: 'result-null',
      toolCallId: 'result-null-tool',
      result: null,
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'null' } })
    expect(project('tool-result', {
      commandId: 'result-array',
      toolCallId: 'result-array-tool',
      result: ['answer'],
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'array', items: 1 } })
    expect(project('tool-result', {
      commandId: 'result-string',
      toolCallId: 'result-string-tool',
      result: 'answer',
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'string', characters: 6 } })
    expect(project('tool-result', {
      commandId: 'result-number',
      toolCallId: 'result-number-tool',
      result: 42,
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'number' } })
    expect(project('tool-result', {
      commandId: 'result-boolean',
      toolCallId: 'result-boolean-tool',
      result: false,
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'boolean' } })
    expect(project('tool-result', {
      commandId: 'result-undefined',
      toolCallId: 'result-undefined-tool',
    })).toMatchObject({ kind: 'tool', status: 'completed', resultShape: { kind: 'unavailable' } })
    expect(project('tool-result', {
      commandId: 'result-invalid-ids',
      toolCallId: 123,
      result: 'hidden',
    })).toBeUndefined()
  })
  it('projects only bounded scrubbed text from durable tool result fields', () => {
    const contentTrace = project('tool-result', {
      commandId: 'safe-content-command',
      toolCallId: 'safe-content-tool',
      tool: 'RawToolNameMustNotRender',
      publicToolName: 'Bash',
      publicResultPreview: 'visible API_KEY=hidden\n-----BEGIN PRIVATE KEY-----\nprivate material\n-----END PRIVATE KEY-----\n' + 'x'.repeat(2_000),
      result: {
        isError: false,
        content: [{
          type: 'text',
          text: 'raw result content must not render',
        }, { type: 'image', data: 'raw image payload must not render' }],
        value: { structured: 'structured result must not render', stderr: 'raw stderr must not render' },
      },
    })
    if (contentTrace?.kind !== 'tool') throw new Error('expected a tool trace')
    expect(contentTrace).toMatchObject({
      status: 'completed',
      toolName: 'Bash',
      resultShape: { kind: 'object', fields: 2 },
    })
    expect(contentTrace.resultPreview).toContain('visible')
    for (const secret of ['hidden', 'private material', 'structured result', 'raw stderr', 'raw image payload']) {
      expect(contentTrace.resultPreview).not.toContain(secret)
    }
    expect(contentTrace.resultPreview?.length).toBeLessThanOrEqual(1_600)

    const stringValueTrace = project('tool-result', {
      commandId: 'safe-string-command',
      toolCallId: 'safe-string-tool',
      publicResultPreview: 'visible value token=hidden',
      result: { value: 'raw result value must not render' },
    })
    expect(stringValueTrace).toMatchObject({
      kind: 'tool',
      status: 'completed',
      resultPreview: 'visible value [REDACTED]',
    })

    const errorTrace = project('tool-result', {
      commandId: 'safe-error-command',
      toolCallId: 'safe-error-tool',
      publicErrorPreview: 'denied token=hidden',
      result: { isError: true, error: { message: 'raw error message must not render' } },
    })
    expect(errorTrace).toMatchObject({
      kind: 'tool',
      status: 'error',
      errorPreview: 'denied [REDACTED]',
    })

    const shapeOnlyTrace = project('tool-result', {
      commandId: 'shape-only-command',
      toolCallId: 'shape-only-tool',
      result: {
        content: [{ type: 'image', data: 'image bytes must not render' }],
        value: { stderr: 'terminal transcript must not render' },
      },
    })
    expect(shapeOnlyTrace).toMatchObject({
      kind: 'tool',
      status: 'completed',
      resultShape: { kind: 'object', fields: 1 },
    })
    expect(shapeOnlyTrace && 'resultPreview' in shapeOnlyTrace ? shapeOnlyTrace.resultPreview : undefined).toBeUndefined()
    expect(JSON.stringify(shapeOnlyTrace)).not.toContain('terminal transcript')
    expect(JSON.stringify(shapeOnlyTrace)).not.toContain('image bytes')
  })

})
