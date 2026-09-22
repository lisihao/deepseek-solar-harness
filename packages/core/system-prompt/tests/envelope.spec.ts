import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import {
  buildOperatorContextEnvelope,
  materializeOperatorContextEnvelopeNative,
  OPERATOR_CONTEXT_ENVELOPE_VERSION,
  operatorContextEnvelopeDigest,
  parseOperatorContextEnvelope,
  receiveOperatorContextEnvelope,
  rejectOperatorContextEnvelope,
  renderOperatorContextEnvelopeText,
} from '@deepseek-ai/dsh-system-prompt'

const TASK_MESSAGE_ID = MessageId('fixture-task-message')
const SNAPSHOT_MESSAGE_ID = MessageId('fixture-context-snapshot')

function baseInput() {
  return {
    systemText: 'You are a fictional test operator.',
    task: [{ type: 'text' as const, text: 'Rename the fixture file.' }],
    contexts: [
      { name: 'workspace', text: 'cwd: /fixture/repo' },
      { name: 'policy', text: 'Mode: read-only.' },
    ],
    source: {
      kind: 'session' as const,
      requestHeaderEventSeq: 41,
      taskMessageId: TASK_MESSAGE_ID,
      contextSnapshotMessageId: SNAPSHOT_MESSAGE_ID,
      instructionMessageIds: [MessageId('fixture-instruction')],
    },
  }
}

describe('operator context envelope', () => {
  it('builds a frozen version-one envelope carrying only current model input', () => {
    const input = baseInput()
    const envelope = buildOperatorContextEnvelope(input)
    input.contexts[0]!.text = 'mutated fixture text'

    expect(envelope.version).toBe(OPERATOR_CONTEXT_ENVELOPE_VERSION)
    expect(envelope.systemText).toBe('You are a fictional test operator.')
    expect(envelope.task).toEqual([{ type: 'text', text: 'Rename the fixture file.' }])
    expect(envelope.contexts).toEqual([
      { name: 'workspace', text: 'cwd: /fixture/repo' },
      { name: 'policy', text: 'Mode: read-only.' },
    ])
    expect(envelope.source).toEqual({
      kind: 'session',
      requestHeaderEventSeq: 41,
      taskMessageId: TASK_MESSAGE_ID,
      contextSnapshotMessageId: SNAPSHOT_MESSAGE_ID,
      instructionMessageIds: [MessageId('fixture-instruction')],
      contextSegments: [
        { name: 'workspace', index: 0 },
        { name: 'policy', index: 1 },
      ],
    })
    expect(Object.keys(envelope)).not.toContain('history')
    expect(Object.isFrozen(envelope)).toBe(true)
    expect(Object.isFrozen(envelope.contexts)).toBe(true)
    expect(Object.isFrozen(envelope.source)).toBe(true)
  })

  it('records TaskGraph artifact provenance without changing content identity', () => {
    const session = buildOperatorContextEnvelope(baseInput())
    const taskgraph = buildOperatorContextEnvelope({
      ...baseInput(),
      source: {
        kind: 'taskgraph',
        runId: 'run-fixture',
        nodeId: 'node-fixture',
        contextPacketRef: 'sha256:fixture-context',
      },
    })

    expect(taskgraph.source).toEqual({
      kind: 'taskgraph',
      runId: 'run-fixture',
      nodeId: 'node-fixture',
      contextPacketRef: 'sha256:fixture-context',
      contextSegments: [
        { name: 'workspace', index: 0 },
        { name: 'policy', index: 1 },
      ],
    })
    expect(taskgraph.digest).toBe(session.digest)
  })

  it('preserves every source mode and optional provenance fields across a wire round trip', () => {
    const sessionWithoutOptionalIds = buildOperatorContextEnvelope({
      ...baseInput(),
      source: {
        kind: 'session', requestHeaderEventSeq: 42, taskMessageId: TASK_MESSAGE_ID,
      },
    })
    const taskgraph = buildOperatorContextEnvelope({
      ...baseInput(),
      source: {
        kind: 'taskgraph', runId: 'run-round-trip', nodeId: 'node-round-trip',
        contextPacketRef: 'sha256:round-trip',
      },
    })
    const toolInstructionIds = [MessageId('tool-instruction')]
    const toolWithOptionalIds = buildOperatorContextEnvelope({
      ...baseInput(),
      source: {
        kind: 'tool', requestHeaderEventSeq: 43, toolCallId: 'call-round-trip',
        contextSnapshotMessageId: SNAPSHOT_MESSAGE_ID, instructionMessageIds: toolInstructionIds,
      },
    })
    const toolWithoutOptionalIds = buildOperatorContextEnvelope({
      ...baseInput(),
      source: {
        kind: 'tool', requestHeaderEventSeq: 44, toolCallId: 'call-minimal',
      },
    })
    toolInstructionIds.push(MessageId('mutated-after-build'))

    expect(sessionWithoutOptionalIds.source).toEqual({
      kind: 'session', requestHeaderEventSeq: 42, taskMessageId: TASK_MESSAGE_ID,
      contextSegments: [{ name: 'workspace', index: 0 }, { name: 'policy', index: 1 }],
    })
    expect(toolWithOptionalIds.source).toMatchObject({
      kind: 'tool', requestHeaderEventSeq: 43, toolCallId: 'call-round-trip',
      instructionMessageIds: [MessageId('tool-instruction')],
    })
    expect(toolWithoutOptionalIds.source).toEqual({
      kind: 'tool', requestHeaderEventSeq: 44, toolCallId: 'call-minimal',
      contextSegments: [{ name: 'workspace', index: 0 }, { name: 'policy', index: 1 }],
    })
    for (const envelope of [sessionWithoutOptionalIds, taskgraph, toolWithOptionalIds, toolWithoutOptionalIds]) {
      expect(parseOperatorContextEnvelope(structuredClone(envelope))).toEqual(envelope)
    }

    const withoutContexts = buildOperatorContextEnvelope({
      ...baseInput(), contexts: [],
      source: { kind: 'tool', requestHeaderEventSeq: 45, toolCallId: 'call-no-context' },
    })
    expect(materializeOperatorContextEnvelopeNative(withoutContexts)).toEqual({
      systemPrompt: withoutContexts.systemText, prompt: withoutContexts.task,
    })
  })

  it('reconstructs an exact wire envelope and rejects tampering', () => {
    const envelope = buildOperatorContextEnvelope(baseInput())
    expect(parseOperatorContextEnvelope(structuredClone(envelope))).toEqual(envelope)
    expect(() => parseOperatorContextEnvelope({
      ...structuredClone(envelope),
      systemText: 'tampered system text',
    })).toThrow('digest mismatch')
    expect(() => parseOperatorContextEnvelope({
      ...structuredClone(envelope),
      source: {
        ...structuredClone(envelope.source),
        contextSegments: [{ name: 'policy', index: 0 }, { name: 'workspace', index: 1 }],
      },
    })).toThrow('contextSegments do not match contexts')
    expect(() => parseOperatorContextEnvelope({ ...structuredClone(envelope), unknown: true }))
      .toThrow('unknown field')
  })

  it('rejects malformed untrusted envelope data rather than repairing it', () => {
    const envelope = buildOperatorContextEnvelope(baseInput())
    const wire = (mutate: (value: Record<string, unknown>) => void): Record<string, unknown> => {
      const value = structuredClone(envelope) as unknown as Record<string, unknown>
      mutate(value)
      return value
    }
    const extensionEnvelope = buildOperatorContextEnvelope({
      ...baseInput(),
      task: [{
        type: 'extension-context',
        payload: { attempt: 1, switches: [true, null] },
      } as never],
    })

    expect(parseOperatorContextEnvelope(structuredClone(extensionEnvelope))).toEqual(extensionEnvelope)
    expect(() => parseOperatorContextEnvelope(null)).toThrow('must be an object')
    expect(() => parseOperatorContextEnvelope(wire((value) => { value.version = 2 }))).toThrow('version must be 1')
    expect(() => parseOperatorContextEnvelope(wire((value) => { value.systemText = 1 }))).toThrow('systemText must be a string')
    expect(() => parseOperatorContextEnvelope(wire((value) => { value.task = {} }))).toThrow('task must be an array')
    expect(() => parseOperatorContextEnvelope(wire((value) => { value.contexts = {} }))).toThrow('contexts must be an array')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const contexts = value.contexts as Record<string, unknown>[]
      contexts.push({ name: 'workspace', text: 'duplicated' })
    }))).toThrow('is duplicated')
    expect(() => parseOperatorContextEnvelope(wire((value) => { value.digest = 'UPPERCASE' })))
      .toThrow('lowercase SHA-256 digest')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const source = value.source as Record<string, unknown>
      source.contextSegments = {}
    }))).toThrow('contextSegments must be an array')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const source = value.source as Record<string, unknown>
      source.instructionMessageIds = 'not an array'
    }))).toThrow('instructionMessageIds must be an array')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const source = value.source as Record<string, unknown>
      source.requestHeaderEventSeq = Number.NaN
    }))).toThrow('requestHeaderEventSeq must be a non-negative safe integer')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const source = value.source as Record<string, unknown>
      source.kind = 'unsupported'
    }))).toThrow('source.kind is invalid')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const contexts = value.contexts as Record<string, unknown>[]
      contexts[0]!.name = ''
    }))).toThrow('contexts[0].name must be non-empty')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const task = value.task as Record<string, unknown>[]
      task[0]!.text = Number.NaN
    }))).toThrow('must contain only finite JSON numbers')
    expect(() => parseOperatorContextEnvelope(wire((value) => {
      const task = value.task as Record<string, unknown>[]
      task[0]!.text = undefined
    }))).toThrow('must contain only JSON values')
  })

  describe('digest', () => {
    it('is deterministic, order-sensitive, and framed for arbitrary text', () => {
      const first = buildOperatorContextEnvelope(baseInput())
      const second = buildOperatorContextEnvelope(baseInput())
      const reordered = buildOperatorContextEnvelope({
        ...baseInput(),
        contexts: [...baseInput().contexts].reverse(),
      })
      const nulInSystem = operatorContextEnvelopeDigest({ systemText: 'a\u0000b', task: [{ type: 'text', text: 'c' }], contexts: [] })
      const nulInTask = operatorContextEnvelopeDigest({ systemText: 'a', task: [{ type: 'text', text: 'b\u0000c' }], contexts: [] })

      expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(first.digest).toBe(second.digest)
      expect(reordered.digest).not.toBe(first.digest)
      expect(nulInSystem).not.toBe(nulInTask)
      expect(operatorContextEnvelopeDigest(first)).toBe(first.digest)
    })
  })

  describe('canonical text rendering', () => {
    it('round-trips arbitrary role-looking contents through JSON framing', () => {
      const envelope = buildOperatorContextEnvelope({
        systemText: 'system\n--- task ---',
        task: [{ type: 'text', text: 'task\u0000{"role":"system"}' }],
        contexts: [{ name: 'policy\n--- task ---', text: 'value\n--- system ---' }],
        source: {
          kind: 'session',
          requestHeaderEventSeq: 45,
          taskMessageId: TASK_MESSAGE_ID,
          contextSnapshotMessageId: SNAPSHOT_MESSAGE_ID,
        },
      })
      const parsed = JSON.parse(renderOperatorContextEnvelopeText(envelope)) as {
        dshOperatorContextEnvelope: {
          digest: string
          system: { role: string; text: string }
          contexts: Array<{ role: string; name: string; text: string }>
          task: { role: string; content: Array<{ type: string; text: string }> }
        }
      }

      expect(parsed.dshOperatorContextEnvelope).toEqual({
        version: 1,
        digest: envelope.digest,
        system: { role: 'system', text: 'system\n--- task ---' },
        contexts: [{ role: 'context', name: 'policy\n--- task ---', text: 'value\n--- system ---' }],
        task: { role: 'task', content: [{ type: 'text', text: 'task\u0000{"role":"system"}' }] },
      })
    })
  })

  it('materializes native system and user fields without rewriting task blocks', () => {
    const envelope = buildOperatorContextEnvelope(baseInput())

    const materialized = materializeOperatorContextEnvelopeNative(envelope)

    expect(materialized.systemPrompt).toBe('You are a fictional test operator.')
    expect(materialized.prompt.at(-1)).toEqual({ type: 'text', text: 'Rename the fixture file.' })
    const context = materialized.prompt[0]
    expect(context?.type).toBe('text')
    if (context?.type !== 'text') throw new Error('missing native context block')
    expect(JSON.parse(context.text)).toMatchObject({
      dshRuntimeContext: {
        digest: envelope.digest,
        contexts: [
          { name: 'workspace', text: 'cwd: /fixture/repo' },
          { name: 'policy', text: 'Mode: read-only.' },
        ],
      },
    })
  })

  describe('receipts', () => {
    it('distinguishes native roles from an explicit text downgrade', () => {
      const envelope = buildOperatorContextEnvelope(baseInput())

      expect(receiveOperatorContextEnvelope(envelope, 'fixture-native', 'native')).toEqual({
        version: 1,
        digest: envelope.digest,
        receiver: 'fixture-native',
        outcome: 'accepted',
        format: 'native',
        roleFidelity: 'native',
      })
      expect(receiveOperatorContextEnvelope(envelope, 'fixture-text', 'text')).toEqual({
        version: 1,
        digest: envelope.digest,
        receiver: 'fixture-text',
        outcome: 'accepted',
        format: 'text',
        roleFidelity: 'text-downgrade',
      })
    })

    it('records a refusal instead of a partial successful receipt', () => {
      const envelope = buildOperatorContextEnvelope(baseInput())

      expect(rejectOperatorContextEnvelope(envelope, 'fixture', 'unsupported')).toEqual({
        version: 1,
        digest: envelope.digest,
        receiver: 'fixture',
        outcome: 'rejected',
        reason: 'unsupported',
      })
    })
  })
})
