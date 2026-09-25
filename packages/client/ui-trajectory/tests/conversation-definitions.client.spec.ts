import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type {
  ConversationEventInput, ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { registerTrajectoryAssistantDefinition } from '../src/client/trajectory-assistant-definition.ts'
import { registerTrajectoryCompactionDefinitions } from '../src/client/trajectory-compaction-definition.ts'
import { registerTrajectoryDebateDefinition } from '../src/client/trajectory-debate-definition.ts'
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
registerTrajectoryDebateDefinition(registrationContext)
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
  physicalOperatorTrace?: ConversationEventInput['physicalOperatorTrace'],
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
    ...(physicalOperatorTrace === undefined ? {} : { physicalOperatorTrace }),
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
  it('replays the keyless Debate transcript fixture with structured topic, floors, and terminal outcome', async () => {
    const fixture = JSON.parse(await readFile(
      new URL('./fixtures/debate-transcript.keyless.json', import.meta.url), 'utf8',
    )) as {
      readonly topic: string
      readonly events: readonly {
        readonly seq: number
        readonly type: string
        readonly data: unknown
        readonly ignorable?: boolean
      }[]
      readonly expectedTranscriptShape: {
        readonly rosterTable: string
        readonly terminalLabels: readonly string[]
        readonly forbiddenMarkup: readonly string[]
      }
    }
    const projected = snapshot(assembler(fixture.events.map(event => at(
      event.seq,
      event.type,
      event.data,
      event.ignorable === undefined ? {} : { ignorable: event.ignorable },
    ))))
    const debate = projected.debateExecutions[0]
    expect(debate).toMatchObject({ runId: 'fixture-debate-run', topic: fixture.topic, turn: 4, step: 1 })
    expect(debate?.entries.map(entry => entry.sourceSequence)).toEqual([1, 2, 3, 4, 5, 6])
    expect(debate?.entries[1]).toMatchObject({
      round: 1,
      role: { title: '建设性提案者', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol' },
      publicOutputPreview: '先用可恢复性基线约束扩展。',
      claims: [{ statement: '可靠性门禁先于新能力。' }],
    })
    expect(debate?.entries[4]?.convergence).toMatchObject({
      status: 'budget_limited', score: 0.76, threshold: 0.82,
      reason: '本轮达到配置预算；主持人总结已完成。',
    })
    expect(debate?.entries[5]?.synthesis).toMatchObject({
      state: 'settled', outputPreview: '主持人总结：可靠性优先，完成一次对照后再扩展。',
      unresolvedCount: 1, dissentCount: 1,
    })

    // The production Consumer owns this Markdown transcript shape. Keep the
    // fixture contract beside the keyless event replay so future changes do
    // not silently regress the user-facing table/terminal vocabulary.
    const roster = fixture.expectedTranscriptShape.rosterTable
    expect(roster.split('\n')).toHaveLength(3)
    expect(roster).toMatch(/\| 角色 \| 职责 \| 执行算子 \| 模型 \| 当前状态 \|\n\| --- \| --- \| --- \| --- \| --- \|\n\| /u)
    for (const label of fixture.expectedTranscriptShape.terminalLabels) {
      expect([
        debate?.entries[4]?.convergence?.reason,
        debate?.entries[5]?.synthesis?.outputPreview,
      ]).toContain(label)
    }
    const publicSnapshot = JSON.stringify(debate)
    for (const marker of fixture.expectedTranscriptShape.forbiddenMarkup) {
      expect(publicSnapshot).not.toContain(marker)
    }
  })

  it('projects a complete public multi-round Debate trace in source order and ignores reconnect duplicates', () => {
    const trace = (sourceSequence: number, state: string, extra: Record<string, unknown> = {}) => at(
      20 + sourceSequence,
      'debate/trace',
      {
        version: 1,
        runId: 'debate-run-1',
        sourceSequence,
        state,
        topic: { version: 1, title: '当前用户议题', source: 'user' },
        sessionTurn: 3,
        sessionStep: 1,
        ...extra,
      },
      { ignorable: true },
    )
    const current = snapshot(assembler([
      trace(1, 'planned'),
      trace(2, 'settled', {
        round: 1,
        role: {
          title: '建设性提案者', kind: 'participant',
          requested: { operatorId: 'codex', model: 'gpt-5.6-sol' },
          actual: { operatorId: 'codex', model: 'gpt-5.6-sol' },
        },
        publicOutput: { preview: '先建立可靠性基线。', ref: 'artifact:proposer-r1' },
        claims: [{ statement: '先补齐恢复基线。', status: 'supported', severity: 'high' }],
        evidenceRefs: [{ version: 1, ref: 'artifact:baseline', kind: 'artifact' }],
        usage: { inputTokens: 120, outputTokens: 48 },
      }),
      trace(3, 'failed', {
        round: 1,
        role: {
          title: '怀疑式证伪者', kind: 'participant',
          requested: { operatorId: 'claude-code', model: 'claude-fable-5' },
          actual: { operatorId: 'codex', model: 'gpt-5.6-sol' },
          fallbackReasonCode: 'MODEL_UNAVAILABLE',
        },
      }),
      trace(4, 'settled', {
        round: 1,
        role: {
          title: '证据审计员', kind: 'participant',
          requested: { operatorId: 'codex', model: 'gpt-5.6-sol' },
        },
        publicOutput: { preview: '当前没有可验证的故障样本。' },
      }),
      trace(5, 'settled', {
        round: 1,
        role: {
          title: '决策裁判（主持人）', kind: 'judge',
          requested: { operatorId: 'claude-code', model: 'claude-opus-5' },
          actual: { operatorId: 'codex', model: 'gpt-5.6-sol' },
        },
      }),
      trace(6, 'settled', {
        round: 2,
        role: {
          title: '建设性提案者', kind: 'participant',
          requested: { operatorId: 'codex', model: 'gpt-5.6-sol' },
        },
      }),
      trace(7, 'budget-limited', {
        round: 2,
        convergence: { status: 'budget_limited', score: 0.44, threshold: 0.82, reason: '输入预算已用完。' },
      }),
      trace(8, 'synthesis-settled', {
        synthesis: {
          state: 'settled', outputPreview: '主持人结论：先测量再重构。', artifactRef: 'artifact:synthesis',
          unresolvedCount: 1, dissentCount: 1,
        },
      }),
      at(40, 'debate/trace', {
        version: 1,
        runId: 'debate-run-1',
        sourceSequence: 2,
        state: 'settled',
        publicOutput: { preview: '重连重复事件不得覆盖原观点。' },
      }, { ignorable: true }),
    ]))

    expect(current.debateExecutions).toHaveLength(1)
    const debate = current.debateExecutions[0]
    expect(debate).toMatchObject({
      runId: 'debate-run-1', topic: '当前用户议题', turn: 3, step: 1,
    })
    expect(debate?.entries.map(entry => entry.sourceSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(debate?.entries[1]).toMatchObject({
      publicOutputPreview: '先建立可靠性基线。',
      role: { title: '建设性提案者', actualOperatorId: 'codex' },
      claims: [{ statement: '先补齐恢复基线。' }],
    })
    expect(debate?.entries[2]).toMatchObject({
      state: 'failed',
      role: { title: '怀疑式证伪者', actualModel: 'gpt-5.6-sol', fallbackReasonCode: 'MODEL_UNAVAILABLE' },
    })
    expect(debate?.entries[6]?.convergence).toMatchObject({ status: 'budget_limited', score: 0.44 })
    expect(debate?.entries[7]?.synthesis).toMatchObject({
      outputPreview: '主持人结论：先测量再重构。', unresolvedCount: 1, dissentCount: 1,
    })
    expect(JSON.stringify(debate)).not.toContain('重连重复事件不得覆盖原观点。')
  })

  it('projects each safe native Debate progress event and merges a reconnect detail without exposing private data', () => {
    const trace = (sourceSequence: number, progress: Record<string, unknown> | undefined) => at(
      50 + sourceSequence,
      'debate/trace',
      {
        version: 1,
        runId: 'debate-progress-run',
        sourceSequence,
        state: sourceSequence === 1 ? 'planned' : 'progress',
        topic: { version: 1, title: '进度展示议题', source: 'user' },
        sessionTurn: 4,
        sessionStep: 2,
        ...(sourceSequence === 1 ? {} : {
          round: 1,
          role: {
            title: '建设性提案者', kind: 'participant',
            requested: { operatorId: 'codex', model: 'gpt-5.6-sol' },
            actual: { operatorId: 'codex', model: 'gpt-5.6-sol' },
          },
        }),
        ...(progress === undefined ? {} : { progress }),
      },
      { ignorable: true },
    )
    const current = snapshot(assembler([
      trace(1, undefined),
      trace(2, { kind: 'phase', sourceTime: '2026-09-03T09:00:00.000Z', phase: 'reasoning' }),
      trace(3, { kind: 'public-output', sourceTime: '2026-09-03T09:00:01.000Z', publicOutputPreview: '公开进展：已完成基线。' }),
      trace(4, { kind: 'tool-started', sourceTime: '2026-09-03T09:00:02.000Z', toolName: 'Bash' }),
      trace(5, { kind: 'tool-completed', sourceTime: '2026-09-03T09:00:03.000Z', toolName: 'Bash' }),
      trace(6, { kind: 'approval-required', sourceTime: '2026-09-03T09:00:04.000Z', approvalKind: 'workspace-write', approvalPreview: '需要用户批准工作区写入。' }),
      trace(7, { kind: 'usage-updated', sourceTime: '2026-09-03T09:00:05.000Z', usage: { inputTokens: 12, outputTokens: 5 } }),
      // A reconnect may first replay an event without progress and then make
      // the safe native detail available at the same durable source sequence.
      trace(8, undefined),
      at(60, 'debate/trace', {
        version: 1,
        runId: 'debate-progress-run',
        sourceSequence: 8,
        state: 'progress',
        round: 1,
        role: {
          title: '建设性提案者', kind: 'participant',
          requested: { operatorId: 'codex', model: 'gpt-5.6-sol' },
        },
        progress: { kind: 'public-output', sourceTime: '2026-09-03T09:00:06.000Z', publicOutputPreview: '重连后公开进展。' },
      }, { ignorable: true }),
      // Unknown progress kinds are ignored by the public projection.
      trace(9, { kind: 'private-reasoning', sourceTime: '2026-09-03T09:00:07.000Z', publicOutputPreview: '不应出现' }),
    ]))

    const debate = current.debateExecutions[0]
    expect(debate?.entries.map(entry => entry.sourceSequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(debate?.entries[1]?.progress).toEqual({
      kind: 'phase', sourceTime: '2026-09-03T09:00:00.000Z', phase: 'reasoning',
    })
    expect(debate?.entries[2]?.progress?.publicOutputPreview).toBe('公开进展：已完成基线。')
    expect(debate?.entries[3]?.progress?.toolName).toBe('Bash')
    expect(debate?.entries[5]?.progress).toMatchObject({
      kind: 'approval-required', approvalKind: 'workspace-write',
    })
    expect(debate?.entries[6]?.progress?.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
    expect(debate?.entries[7]?.progress?.publicOutputPreview).toBe('重连后公开进展。')
    const exposed = JSON.stringify(debate)
    expect(exposed).not.toMatch(/private-reasoning|不应出现|prompt|arguments|stderr|sessionId/iu)
  })

  it('ignores Physical Operator authority payloads when no Host trace is present', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'private-command', operatorId: 'codex', promptMessageId: 'private-prompt',
        requestedByMessageId: 'private-request', turn: 1, step: 1, recovered: false,
      }),
      at(2, 'physical-operator/tool-call', {
        commandId: 'private-tool', executionCommandId: 'private-command', tool: 'SecretTool',
        arguments: { prompt: 'must never render', token: 'ORCHID-4711' },
      }, { ignorable: true }),
    ]))

    expect(current.physicalOperatorExecutions).toEqual([])
    expect(JSON.stringify(current)).not.toMatch(/private-command|private-prompt|SecretTool|ORCHID-4711/u)
  })

  it('groups a Resident command by command id, dedupes reconnect sequence, and keeps only safe observations', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'command-1', operatorId: 'codex', promptMessageId: 'm', requestedByMessageId: 'm',
        turn: 2, step: 1, recovered: false,
      }, {}, { version: 1, kind: 'dispatch', commandId: 'public-command-1', operator: 'codex', turn: 2, step: 1 }),
      at(2, 'physical-operator/progress', {
        commandId: 'command-1', operatorId: 'codex', sequence: 4, type: 'turn.observation',
        time: '2026-09-01T10:00:00.000Z',
        data: {
          kind: 'public-output',
          preview: [
            'Visible API_KEY=secret',
            "password='correct horse battery staple'",
            "curl -H 'Authorization: Bearer sk-live-secret'",
            'echo ghp_abcdefghijklmnopqrstuvwxyz',
            'reasoning: private chain of thought',
            '-----BEGIN OPENSSH PRIVATE KEY-----',
            'private-key-body',
            '-----END OPENSSH PRIVATE KEY-----',
            'second line',
            'x'.repeat(400),
          ].join('\n'),
        },
      }, { ignorable: true }, { version: 1, kind: 'public-output', commandId: 'public-command-1', sourceSequence: 4, preview: 'Visible public output' }),
      at(3, 'physical-operator/progress', {
        commandId: 'command-1', operatorId: 'codex', sequence: 4, type: 'turn.observation',
        time: '2026-09-01T10:00:00.000Z',
        data: { kind: 'public-output', preview: 'reconnect duplicate' },
      }, { ignorable: true }, { version: 1, kind: 'public-output', commandId: 'public-command-1', sourceSequence: 4 }),
      at(4, 'physical-operator/progress', {
        commandId: 'command-1', operatorId: 'codex', sequence: 5, type: 'turn.observation',
        time: '2026-09-01T10:00:01.000Z',
        data: { kind: 'tool-started', toolName: 'Bash', arguments: { secret: 'never render' } },
      }, { ignorable: true }, {
        version: 1, kind: 'native-tool', commandId: 'public-command-1', sourceSequence: 5, status: 'running', toolName: 'Bash',
      }),
      at(5, 'physical-operator/dispatch-terminal', {
        commandId: 'command-1', code: 'OPERATOR_ERROR',
      }, { ignorable: true }, { version: 1, kind: 'terminal', commandId: 'public-command-1', outcome: 'error' }),
    ]))

    expect(current.physicalOperatorExecutions).toHaveLength(1)
    expect(current.physicalOperatorExecutions[0]).toMatchObject({
      commandId: 'public-command-1', operatorId: 'codex', turn: 2, step: 1,
    })
    const entries = current.physicalOperatorExecutions[0]?.entries ?? []
    expect(entries).toHaveLength(4)
    expect(entries.find(entry => entry.type === 'observation')?.observation).toEqual({ kind: 'public-output', publicOutputPreview: 'Visible public output' })
    const exposed = JSON.stringify(current.physicalOperatorExecutions)
    expect(exposed).not.toMatch(/secret|correct horse|sk-live|ghp_|chain of thought|private-key-body|second line/iu)
    expect(entries.find(entry => entry.type === 'observation' && entry.observation?.kind === 'tool-started')?.observation)
      .toEqual({ kind: 'tool-started', toolName: 'Bash' })
    expect(entries.some(entry => entry.type === 'terminal')).toBe(true)
  })

  it('projects a successful Resident turn.settled as a non-error terminal entry', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'command-success', operatorId: 'codex', promptMessageId: 'm', requestedByMessageId: 'm',
        turn: 1, step: 1, recovered: false,
      }, {}, { version: 1, kind: 'dispatch', commandId: 'public-success', operator: 'codex', turn: 1, step: 1 }),
      at(2, 'physical-operator/progress', {
        commandId: 'command-success', operatorId: 'codex', sequence: 1, type: 'turn.settled',
        time: '2026-09-01T10:00:01.000Z',
        data: { commandId: 'command-success', turnId: 'turn-1', stopReason: 'completed' },
      }, { ignorable: true }, {
        version: 1, kind: 'terminal', commandId: 'public-success', sourceSequence: 1, outcome: 'success',
      }),
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
      }, {}, {
        version: 1, kind: 'dispatch', commandId: 'public-tool-command', operator: 'claude-code', turn: 0, step: 0,
      }),
      at(2, 'physical-operator/progress', {
        commandId: 'tool-command-1', operatorId: 'claude-code', sequence: 1, type: 'turn.progress',
        time: '2026-09-01T10:00:00.000Z', data: { phase: 'reasoning' },
      }, { ignorable: true }, {
        version: 1, kind: 'progress', commandId: 'public-tool-command', sourceSequence: 1, phase: 'reasoning',
      }),
    ]))

    expect(current.physicalOperatorExecutions).toMatchObject([{
      commandId: 'public-tool-command', operatorId: 'claude-code', turn: 0, step: 0,
    }])
    expect(current.physicalOperatorExecutions[0]?.entries.map(entry => entry.type)).toEqual(['dispatch', 'progress'])
  })

  it('pairs durable physical tool events and exposes only Host-projected shapes after replay', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'command-tools', operatorId: 'codex', promptMessageId: 'm', requestedByMessageId: 'm',
        turn: 1, step: 1, recovered: false,
      }, {}, { version: 1, kind: 'dispatch', commandId: 'public-tools', operator: 'codex', turn: 1, step: 1 }),
      at(2, 'physical-operator/tool-call', {
        commandId: 'command-tools:tool:1', toolCallId: 'tool-call-1', executionCommandId: 'command-tools',
        tool: 'Bash', arguments: {
          command: "curl -H 'Authorization: Bearer sk-live-secret'",
          input: 'complete original request must not render',
          password: 'correct horse battery staple',
          privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-body\n-----END OPENSSH PRIVATE KEY-----',
          prompt: 'hidden prompt must not render',
          reasoning: 'hidden chain of thought must not render',
          token: 'ghp_abcdefghijklmnopqrstuvwxyz',
          limit: 5,
        },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-tools', toolCallId: 'public-tool-1', standalone: false,
        status: 'running', toolName: 'Bash', argumentsShape: { kind: 'object', fields: 7 },
      }),
      at(3, 'physical-operator/tool-result', {
        commandId: 'command-tools:tool:1', toolCallId: 'tool-call-1', executionCommandId: 'command-tools',
        tool: 'Bash', result: {
          isError: false,
          value: {
            text: 'line one\nline two', api_key: 'do-not-render',
            transcript: 'full transcript must not render', code: 'sk-live-secret', count: 2,
          },
        },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-tools', toolCallId: 'public-tool-1', standalone: false,
        status: 'completed', toolName: 'Bash', resultShape: { kind: 'object', fields: 3 }, resultPreview: '已读取 2 个文件。',
      }),
      // A reconnect/reload can expose the same durable tool call and result at
      // new session sequence positions. The stable toolCallId keeps one row.
      at(4, 'physical-operator/tool-call', {
        commandId: 'command-tools:tool:1', toolCallId: 'tool-call-1', executionCommandId: 'command-tools',
        tool: 'Bash', arguments: { command: 'duplicate' },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-tools', toolCallId: 'public-tool-1', standalone: false,
        status: 'running', argumentsShape: { kind: 'object', fields: 1 },
      }),
      at(5, 'physical-operator/tool-result', {
        commandId: 'command-tools:tool:1', toolCallId: 'tool-call-1', executionCommandId: 'command-tools',
        tool: 'Bash', result: { isError: false, value: { text: 'duplicate' } },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-tools', toolCallId: 'public-tool-1', standalone: false,
        status: 'completed', resultShape: { kind: 'object', fields: 1 },
      }),
    ]))
    const execution = current.physicalOperatorExecutions[0]
    const tool = execution?.entries.find(entry => entry.type === 'tool')
    expect(execution?.commandId).toBe('public-tools')
    expect(execution?.entries.filter(entry => entry.type === 'tool')).toHaveLength(1)
    expect(tool).toMatchObject({
      type: 'tool', seq: 2,
      tool: {
        toolCallId: 'public-tool-1', status: 'completed', callSeq: 2, resultSeq: 3,
        toolName: 'Bash', argumentsShape: { kind: 'object', fields: 7 }, resultShape: { kind: 'object', fields: 3 }, resultPreview: '已读取 2 个文件。',
      },
    })
    if (tool?.type !== 'tool' || tool.tool === undefined) throw new Error('expected paired physical tool trace')
    const exposed = JSON.stringify(tool.tool)
    for (const secret of [
      'Authorization', 'sk-live', 'original request', 'correct horse', 'private-key-body',
      'hidden prompt', 'chain of thought', 'ghp_', 'line one', 'line two', 'full transcript',
      'do-not-render',
    ]) expect(exposed).not.toContain(secret)
    expect(exposed).not.toContain('api_key')
  })

  it('projects a recovered call without a result as indeterminate and accepts later proof of settlement', () => {
    const value = assembler([
      at(1, 'physical-operator/dispatch', {
        commandId: 'command-indeterminate', operatorId: 'codex', promptMessageId: 'm', requestedByMessageId: 'm',
        turn: 1, step: 1, recovered: false,
      }, {}, {
        version: 1, kind: 'dispatch', commandId: 'public-indeterminate', operator: 'codex', turn: 1, step: 1,
      }),
      at(2, 'physical-operator/tool-call', {
        commandId: 'command-indeterminate:codex-tool:1', toolCallId: 'tool-call-indeterminate',
        executionCommandId: 'command-indeterminate', tool: 'Bash', arguments: { command: 'side effect' },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-indeterminate', toolCallId: 'public-indeterminate-tool',
        standalone: false, status: 'running', argumentsShape: { kind: 'object', fields: 1 },
      }),
      at(3, 'physical-operator/tool-indeterminate', {
        commandId: 'command-indeterminate:codex-tool:1', toolCallId: 'tool-call-indeterminate',
        executionCommandId: 'command-indeterminate', tool: 'Bash', code: 'COMMAND_INDETERMINATE',
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-indeterminate', toolCallId: 'public-indeterminate-tool',
        standalone: false, status: 'indeterminate',
      }),
    ])
    const indeterminateEntry = snapshot(value).physicalOperatorExecutions[0]?.entries
      .find(entry => entry.type === 'tool')
    expect(indeterminateEntry?.type).toBe('tool')
    expect(indeterminateEntry?.tool).toMatchObject({
      toolCallId: 'public-indeterminate-tool', status: 'indeterminate',
    })

    value.append(at(4, 'physical-operator/tool-result', {
      commandId: 'command-indeterminate:codex-tool:1', toolCallId: 'tool-call-indeterminate',
      executionCommandId: 'command-indeterminate', tool: 'Bash', result: { isError: false, value: { count: 1 } },
    }, { ignorable: true }, {
      version: 1, kind: 'tool', commandId: 'public-indeterminate', toolCallId: 'public-indeterminate-tool',
      standalone: false, status: 'completed', resultShape: { kind: 'object', fields: 1 },
    }))
    value.flush()
    const settledEntry = snapshot(value).physicalOperatorExecutions[0]?.entries
      .find(entry => entry.type === 'tool')
    expect(settledEntry?.type).toBe('tool')
    expect(settledEntry?.tool).toMatchObject({ status: 'completed', resultSeq: 4 })
  })

  it('keeps legacy tool events visible when no parent execution id was persisted', () => {
    const current = snapshot(assembler([
      at(1, 'physical-operator/tool-call', {
        commandId: 'legacy-tool-1', tool: 'Read', arguments: { path: '/tmp/a' },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-legacy', toolCallId: 'public-legacy', standalone: true,
        status: 'running', argumentsShape: { kind: 'object', fields: 1 },
      }),
      at(2, 'physical-operator/tool-result', {
        commandId: 'legacy-tool-1', tool: 'Read', result: { isError: true, error: 'permission denied' },
      }, { ignorable: true }, {
        version: 1, kind: 'tool', commandId: 'public-legacy', toolCallId: 'public-legacy', standalone: true,
        status: 'error', resultShape: { kind: 'unavailable' },
      }),
    ]))
    expect(current.physicalOperatorExecutions).toMatchObject([{
      commandId: 'public-legacy', operatorId: 'physical-operator',
      entries: [{ type: 'dispatch' }, { type: 'tool', tool: { status: 'error', toolCallId: 'public-legacy' } }],
    }])
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
