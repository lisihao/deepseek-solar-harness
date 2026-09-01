import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {
  ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { registerTrajectoryAssistantDefinition } from '../src/client/trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from '../src/client/trajectory-compaction-definition.ts'
import type { TrajectorySnapshot } from '../src/client/trajectory-contract.ts'
import { registerTrajectoryMessageDefinitions } from '../src/client/trajectory-message-definitions.ts'
import { registerTrajectoryPhysicalOperatorDefinition } from '../src/client/trajectory-physical-operator-definition.ts'
import { registerTrajectoryRequestHeaderDefinition } from '../src/client/trajectory-request-header-definition.ts'
import { trajectoryViewDefinition } from '../src/client/trajectory-snapshot-builder.ts'
import { registerTrajectoryToolDefinition } from '../src/client/trajectory-tool-definition.ts'

const DEFINITIONS: ConversationNodeDefinition[] = []
const registrationContext = {
  conversationEvents: {
    register: (definition: ConversationNodeDefinition) => {
      DEFINITIONS.push(definition)
      return () => {}
    },
  },
} as unknown as Context

registerTrajectoryMessageDefinitions(registrationContext)
registerTrajectoryPhysicalOperatorDefinition(registrationContext)
registerTrajectoryRequestHeaderDefinition(registrationContext)
registerTrajectoryAssistantDefinition(registrationContext)
registerTrajectoryToolDefinition(registrationContext)
registerTrajectoryCompactionDefinitions(registrationContext)

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): undefined {
    return undefined
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [trajectoryViewDefinition]
  }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  extra: Record<string, unknown> = {},
): ConversationEventInput {
  return {
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data,
      ...extra,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

function assembler(events: readonly ConversationEventInput[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(
    new TestEventDefinitions(),
    new TestViewDefinitions(),
  )
  value.replaceWindow(events, false)
  value.flush()
  return value
}

function snapshot(value: ConversationNodeAssembler): TrajectorySnapshot {
  const current = value.snapshot('trajectory') as TrajectorySnapshot | undefined
  if (current === undefined) throw new Error('trajectory view was not registered')
  return current
}

function assistantMessage(id: string, text: string) {
  return {
    id,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'test', model: 'test' },
  }
}

describe('Trajectory conversation Definitions', () => {
  it('groups a Resident command by command id, dedupes reconnect sequence, and keeps only safe observations', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'command-1', operatorId: 'codex', promptMessageId: 'm', requestedByMessageId: 'm',
        turn: 2, step: 1, recovered: false,
      }),
      at(2, 'physical-operator/progress', {
        commandId: 'command-1', operatorId: 'codex', sequence: 4, type: 'turn.observation',
        time: '2026-09-01T10:00:00.000Z',
        data: { kind: 'public-output', preview: `Visible API_KEY=secret ${'x'.repeat(400)}` },
      }, { ignorable: true }),
      at(3, 'physical-operator/progress', {
        commandId: 'command-1', operatorId: 'codex', sequence: 4, type: 'turn.observation',
        time: '2026-09-01T10:00:00.000Z',
        data: { kind: 'public-output', preview: 'reconnect duplicate' },
      }, { ignorable: true }),
      at(4, 'physical-operator/progress', {
        commandId: 'command-1', operatorId: 'codex', sequence: 5, type: 'turn.observation',
        time: '2026-09-01T10:00:01.000Z',
        data: { kind: 'tool-started', toolName: 'Bash', arguments: { secret: 'never render' } },
      }, { ignorable: true }),
      at(5, 'physical-operator/dispatch-terminal', {
        commandId: 'command-1', code: 'OPERATOR_ERROR',
      }, { ignorable: true }),
    ]))

    expect(current.physicalOperatorExecutions).toHaveLength(1)
    expect(current.physicalOperatorExecutions[0]).toMatchObject({
      commandId: 'command-1', operatorId: 'codex', turn: 2, step: 1,
    })
    const entries = current.physicalOperatorExecutions[0]?.entries ?? []
    expect(entries).toHaveLength(4)
    expect(entries.find(entry => entry.type === 'observation')?.observation?.preview)
      .toContain('[REDACTED]')
    expect(entries.find(entry => entry.type === 'observation')?.observation?.preview?.length)
      .toBeLessThanOrEqual(240)
    expect(entries.find(entry => entry.type === 'observation')?.observation?.preview)
      .not.toContain('reconnect duplicate')
    expect(entries.find(entry => entry.type === 'observation' && entry.observation?.kind === 'tool-started')?.observation)
      .toEqual({ kind: 'tool-started', toolName: 'Bash' })
    expect(entries.some(entry => entry.type === 'terminal')).toBe(true)
  })

  it('projects a successful Resident turn.settled as a non-error terminal entry', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'command-success', operatorId: 'codex', promptMessageId: 'm', requestedByMessageId: 'm',
        turn: 1, step: 1, recovered: false,
      }),
      at(2, 'physical-operator/progress', {
        commandId: 'command-success', operatorId: 'codex', sequence: 1, type: 'turn.settled',
        time: '2026-09-01T10:00:01.000Z',
        data: { commandId: 'command-success', turnId: 'turn-1', stopReason: 'completed' },
      }, { ignorable: true }),
    ]))

    expect(current.physicalOperatorExecutions[0]?.entries).toContainEqual(expect.objectContaining({
      type: 'terminal', code: 'completed', outcome: 'success',
    }))
  })

  it('uses the explicit tool-dispatch event as an equivalent command start without inventing an agent-loop location', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/tool-dispatch', {
        commandId: 'tool-command-1', operatorId: 'claude-code', toolCallId: 'tool-1', mode: 'resident',
        description: 'bounded local summary',
      }),
      at(2, 'physical-operator/progress', {
        commandId: 'tool-command-1', operatorId: 'claude-code', sequence: 1, type: 'turn.progress',
        time: '2026-09-01T10:00:00.000Z', data: { phase: 'reasoning' },
      }, { ignorable: true }),
    ]))

    expect(current.physicalOperatorExecutions).toMatchObject([{
      commandId: 'tool-command-1', operatorId: 'claude-code', turn: 0, step: 0,
    }])
    expect(current.physicalOperatorExecutions[0]?.entries.map(entry => entry.type)).toEqual(['dispatch', 'progress'])
  })

  it('assembles streaming usage, preserves retry facts, and materializes interruption', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'text-delta', index: 0, text: 'first attempt' },
      }),
      at(4, 'assistant/chunk', {
        turn: 1,
        step: 1,
        chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
      }),
    ])

    expect(snapshot(value).partial?.blocks).toEqual([{ kind: 'text', text: 'first attempt' }])
    expect(snapshot(value).requests).toMatchObject([{
      purpose: 'assistant',
      status: 'running',
      usage: { inputTokens: 10, outputTokens: 3 },
    }])

    value.append(at(5, 'llm/retry', {
      retryId: 'retry-1',
      turn: 1,
      step: 1,
      provider: 'test',
      mode: 'normal',
      policyKey: 'test-normal',
      retry: 1,
      maxRetries: 2,
      delayMs: 25,
      failure: { code: 'TRANSPORT', message: 'temporary failure' },
    }))
    value.append(at(6, 'assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'second attempt' },
    }))
    value.append(at(7, 'step/end', { turn: 1, step: 1 }))
    value.flush()

    const settled = snapshot(value)
    expect(settled.partial).toBeNull()
    expect(settled.eventNodes).toMatchObject([{
      kind: 'assistant',
      seq: 6.1,
      interrupted: true,
      blocks: [{ kind: 'text', text: 'second attempt' }],
    }])
    expect(settled.requests).toMatchObject([{
      purpose: 'assistant',
      status: 'error',
      retry: 1,
      maxRetries: 2,
      retryDelayMs: 25,
      usage: { inputTokens: 10, outputTokens: 3 },
    }])
  })

  it('keeps parallel interrupted roots and nests Code Dispatch results', () => {
    const current = snapshot(assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'step/start', { turn: 1, step: 1 }),
      at(3, 'tool/call', {
        turn: 1, step: 1, callId: 'root-a', name: 'code', arguments: '{}',
      }),
      at(4, 'tool/call', {
        turn: 1, step: 1, callId: 'root-b', name: 'parallel', arguments: '{}',
      }),
      at(5, 'tool/code-dispatch-start', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
      }),
      at(6, 'tool/code-dispatch', {
        rootCallId: 'root-a',
        parentCallId: 'root-a',
        subCallId: 'child',
        name: 'read',
        arguments: { path: 'README.md' },
        content: [{ type: 'text', text: 'contents' }],
      }),
      at(7, 'step/end', { turn: 1, step: 1 }),
    ]))

    const tools = current.eventNodes.filter(node => node.kind === 'tool-result')
    expect(tools.map(node => node.callId).sort()).toEqual(['root-a', 'root-b'])
    expect(tools.find(node => node.callId === 'root-a')?.subCalls).toMatchObject([{
      kind: 'tool-result',
      callId: 'child',
      call: { name: 'read' },
    }])
  })

  it('assembles compaction lifecycle, checkpoint replacement, and orphan interruption', () => {
    const current = snapshot(assembler([
      at(1, 'compaction/start', { compactionId: 'complete', turn: null }),
      at(2, 'compaction/summary', {
        compactionId: 'complete',
        turn: null,
        summary: 'summary',
        provider: 'test',
        model: 'test',
        maxTokens: 100,
        usage: { inputTokens: 20, outputTokens: 5 },
      }),
      at(3, 'user/message', {
        id: 'checkpoint',
        role: 'user',
        content: [{ type: 'text', text: 'summary checkpoint' }],
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'complete' },
      }),
      at(4, 'compaction/end', { compactionId: 'complete', turn: null }),
      at(5, 'compaction/start', { compactionId: 'orphan', turn: null }),
      at(6, 'session/end-seed', {}),
    ]))

    expect(current.requests).toMatchObject([
      {
        purpose: 'compaction',
        startSeq: 1,
        status: 'complete',
        resultSeq: 2,
        replacementSeq: 3,
        summary: 'summary',
      },
      {
        purpose: 'compaction',
        startSeq: 5,
        status: 'error',
        completedAt: 1_700_000_000_006,
      },
    ])
  })

  it('classifies claimed inbox input as steering and consumes one inherited prompt change', () => {
    const value = assembler([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'request/header', {
        reason: 'initial',
        header: {
          config: { provider: 'test', model: 'test' },
          system: 'system prompt',
          tools: [],
        },
      }),
      at(3, 'step/start', { turn: 1, step: 1 }),
      at(4, 'assistant/message', {
        turn: 1,
        step: 1,
        message: assistantMessage('assistant-1', 'first'),
      }),
      at(5, 'step/end', { turn: 1, step: 1 }),
      at(6, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 0, inserted: [{ id: 'm1' }],
      }),
      at(7, 'agent/inbox/spliced', {
        target: 'next-step', start: 0, removedCount: 1, inserted: [],
      }),
      at(8, 'step/start', { turn: 1, step: 2 }),
    ])
    value.append(at(9, 'user/message', {
      id: 'm1',
      role: 'user',
      content: [{ type: 'text', text: 'steer here' }],
      source: { kind: 'user' },
    }))
    value.flush()

    const steering = snapshot(value)
    expect(steering.eventNodes.find(node => node.seq === 9)?.kind).toBe('steering')
    expect(steering.eventLocations.get(9)).toMatchObject({
      kind: 'step',
      turn: { turn: 1 },
      step: { step: 2 },
    })

    value.append(at(10, 'assistant/message', {
      turn: 1,
      step: 2,
      message: assistantMessage('assistant-2', 'second'),
    }))
    value.flush()
    const current = snapshot(value)

    expect(current.requests.map(request => request.purpose === 'assistant'
      ? request.prompt?.system
      : undefined)).toEqual(['system prompt', 'system prompt'])
    expect(current.requests.map(request => request.purpose === 'assistant'
      ? request.promptChange?.kind
      : undefined)).toEqual(['initial', undefined])
  })
})
