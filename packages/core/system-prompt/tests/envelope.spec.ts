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
