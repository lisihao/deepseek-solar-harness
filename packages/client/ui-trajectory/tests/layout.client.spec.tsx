// @vitest-environment jsdom
/**
 * Trajectory turn chrome and layout fold: expand blocks, usage on Message,
 * tool own-duration, group wall-span descriptions, in-flight rows.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type {
  ConversationLocation, ConversationSnapshot, RequestView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { TrajectoryGroupHeader } from '../src/client/TrajectoryGroupHeader.tsx'
import { TrajectoryTurn } from '../src/client/TrajectoryTurn.tsx'
import { TrajectoryTurnHeader } from '../src/client/TrajectoryTurnHeader.tsx'
import {
  appendTrajectoryPartialLayout, deriveTrajectoryLayout,
} from '../src/client/layout.ts'

afterEach(cleanup)

describe('TrajectoryTurnHeader', () => {
  it('renders Turn N and the four metric column labels', () => {
    render(<TrajectoryTurnHeader turn={1} />)
    expect(screen.getByText('Turn 1')).toBeTruthy()
    expect(screen.getByText('Input')).toBeTruthy()
    expect(screen.getByText('Output')).toBeTruthy()
    expect(screen.getByText('Think')).toBeTruthy()
    expect(screen.getByText('Time')).toBeTruthy()
  })
})

describe('TrajectoryGroupHeader', () => {
  it('renders title and optional description', () => {
    render(<TrajectoryGroupHeader title="Step 1" description="2.2s skill" />)
    expect(screen.getByText('Step 1')).toBeTruthy()
    expect(screen.getByText('2.2s skill')).toBeTruthy()
  })

  it('omits the description node when absent', () => {
    const { container } = render(<TrajectoryGroupHeader title="Message" />)
    expect(screen.getByText('Message')).toBeTruthy()
    expect(container.querySelectorAll('span')).toHaveLength(1)
  })
})

describe('TrajectoryTurn', () => {
  it('wraps a sticky header and body children', () => {
    render(
      <TrajectoryTurn turn={3}>
        <TrajectoryGroupHeader title="Message" description="49s" />
      </TrajectoryTurn>,
    )
    expect(screen.getByText('Turn 3')).toBeTruthy()
    expect(screen.getByText('Message')).toBeTruthy()
    expect(screen.getByText('49s')).toBeTruthy()
  })
})

describe('deriveTrajectoryLayout', () => {
  it('expands assistant blocks, hangs usage on Message, and folds call+result into Tool', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hello' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 6_000, turn: 1, step: 1,
        blocks: [
          { kind: 'reasoning', text: 'thinking…' },
          { kind: 'text', text: 'I will run bash' },
          { kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{"command":"ls"}' },
        ],
        usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 5 },
      },
      {
        kind: 'tool-result', seq: 3, time: 7_500, callId: 'c1',
        call: { name: 'bash', argsRaw: '{"command":"ls"}' }, callTime: 6_200,
        content: [{ type: 'text', text: 'a.txt' }], isError: false, callView: null, resultView: null,
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    expect(turns).toHaveLength(1)
    expect(turns[0]?.turn).toBe(1)
    const kinds = turns[0]?.groups.flatMap(g => g.cells.map(c => c.kind))
    expect(kinds).toEqual(['user', 'message', 'tool'])
    const message = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'message')
    expect(message).toMatchObject({
      input: 10, output: 20, think: 5, timeSeconds: 5,
    })
    const tool = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'tool')
    expect(tool).toMatchObject({
      text: 'bash',
      previewMarkdown: '{"command":"ls"}',
    })
    expect(tool?.timeSeconds).toBe(1.3)
  })

  it('adds runningCalls not already present and leaves their time blank', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [{
        callId: 'r1', name: 'bash', argsRaw: '{"command":"pwd"}',
        turn: 1, step: 2, time: 9_000, callView: null, subCalls: [],
      }],
    })
    expect(turns[0]?.groups.map(g => g.title)).toEqual(['Step 2'])
    expect(turns[0]?.groups[0]?.cells[0]).toMatchObject({
      kind: 'tool',
      text: 'bash',
      previewMarkdown: '{"command":"pwd"}',
      timeSeconds: null,
    })
  })

  it('adds one bounded physical-operator group without exposing a full final transcript', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      physicalOperatorExecutions: [{
        commandId: 'command-123456789', operatorId: 'codex', turn: 1, step: 1,
        dispatchSeq: 10, dispatchTime: 10_000,
        entries: [
          { seq: 10, time: 10_000, type: 'dispatch' },
          { seq: 11, time: 10_100, type: 'progress', phase: 'reasoning' },
          {
            seq: 12, time: 10_200, type: 'observation',
            observation: { kind: 'public-output' },
          },
          {
            seq: 13, time: 10_300, type: 'observation',
            observation: { kind: 'tool-started' },
          },
        ],
      }],
    })
    const group = turns[0]?.groups.find(value => value.title.startsWith('Operator · Codex'))
    expect(group?.cells).toMatchObject([
      { kind: 'operator', text: 'Codex 已派发' },
      { kind: 'operator', text: '阶段 · 推理与执行' },
      { kind: 'operator', text: '公开输出已更新' },
      { kind: 'operator', text: '原生工具开始' },
    ])
    expect(group?.cells[2]?.outputDetail).toBeUndefined()
  })

  it('lays out public Debate rounds, fallback routing, convergence, and synthesis as readable records', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      debateExecutions: [{
        runId: 'debate-run-123456789', topic: '当前用户议题', turn: 1, step: 1,
        dispatchSeq: 10, dispatchTime: 10_000,
        entries: [
          { seq: 10, time: 10_000, sourceSequence: 1, state: 'planned', claims: [], evidenceRefs: [] },
          {
            seq: 11, time: 10_100, sourceSequence: 2, state: 'settled', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
            },
            publicOutputPreview: '先建立恢复基线。', publicOutputRef: 'artifact:proposer-r1',
            claims: [{ statement: '先补齐恢复基线。', status: 'supported', severity: 'high' }],
            evidenceRefs: ['artifact:baseline'], usage: { inputTokens: 120, outputTokens: 48 },
          },
          {
            seq: 12, time: 10_200, sourceSequence: 3, state: 'failed', round: 1,
            role: {
              title: '怀疑式证伪者', kind: 'participant', requestedOperatorId: 'claude-code', requestedModel: 'claude-fable-5',
              actualOperatorId: 'codex', actualModel: 'gpt-5.6-sol', fallbackReasonCode: 'MODEL_UNAVAILABLE',
            },
            claims: [], evidenceRefs: [],
          },
          {
            seq: 13, time: 10_300, sourceSequence: 4, state: 'budget-limited', round: 2,
            claims: [], evidenceRefs: [],
            convergence: { status: 'budget_limited', score: 0.44, threshold: 0.82, reason: '输入预算已用完。' },
          },
          {
            seq: 14, time: 10_400, sourceSequence: 5, state: 'synthesis-settled', claims: [], evidenceRefs: [],
            synthesis: {
              state: 'settled', outputPreview: '主持人结论：先测量再重构。', artifactRef: 'artifact:synthesis',
              unresolvedCount: 1, dissentCount: 1,
            },
          },
        ],
      }],
    })

    const group = turns[0]?.groups.find(value => value.title === 'Debate · 当前用户议题')
    expect(group?.cells).toMatchObject([
      { kind: 'debate', text: '已创建' },
      { kind: 'debate', text: '第 1 轮 · 建设性提案者 · 已提交观点', previewMarkdown: '先建立恢复基线。', input: 120, output: 48 },
      { kind: 'debate', text: '第 1 轮 · 怀疑式证伪者 · 执行失败', isError: true },
      { kind: 'debate', text: '第 2 轮 · 预算已到上限' },
      { kind: 'debate', text: '主持人总结完成', previewMarkdown: '主持人结论：先测量再重构。' },
    ])
    const settled = group?.cells[1]
    expect(settled?.outputDetail).toContain('### 本楼主张')
    expect(settled?.outputDetail).toContain('- 先补齐恢复基线。（supported · high）')
    expect(settled?.outputDetail).toContain('**模型路由**：Codex / gpt-5.6-sol')
    expect(group?.cells[2]?.outputDetail).toContain('Claude Code / claude-fable-5 → Codex / gpt-5.6-sol')
    expect(group?.cells[3]?.outputDetail).toContain('### 收敛判断')
    expect(group?.cells[4]?.outputDetail).toContain('### 主持人总结')
    expect(group?.cells[1]?.recordId).toBe(['debate', 'debate-run-123456789', '2'].join('\u0000'))
  })

  it('expands each native Debate progress fact into one readable record with origin timing', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      debateExecutions: [{
        runId: 'debate-progress-123456789', topic: '进度议题', turn: 1, step: 1,
        dispatchSeq: 10, dispatchTime: 10_000,
        entries: [
          { seq: 10, time: 10_000, sourceSequence: 1, state: 'planned', claims: [], evidenceRefs: [] },
          {
            seq: 11, time: 10_100, sourceSequence: 2, state: 'progress', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
              actualOperatorId: 'codex', actualModel: 'gpt-5.6-sol',
            },
            claims: [], evidenceRefs: [],
            progress: { kind: 'phase', sourceTime: '2026-09-03T09:00:00.000Z', phase: 'reasoning' },
          },
          {
            seq: 12, time: 10_200, sourceSequence: 3, state: 'progress', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
            },
            claims: [], evidenceRefs: [],
            progress: { kind: 'public-output', sourceTime: '2026-09-03T09:00:01.000Z', publicOutputPreview: '已完成基线。' },
          },
          {
            seq: 13, time: 10_300, sourceSequence: 4, state: 'progress', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
            },
            claims: [], evidenceRefs: [],
            progress: { kind: 'tool-started', sourceTime: '2026-09-03T09:00:02.000Z', toolName: 'Bash' },
          },
          {
            seq: 14, time: 10_400, sourceSequence: 5, state: 'progress', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
            },
            claims: [], evidenceRefs: [],
            progress: { kind: 'tool-completed', sourceTime: '2026-09-03T09:00:03.000Z', toolName: 'Bash' },
          },
          {
            seq: 15, time: 10_500, sourceSequence: 6, state: 'progress', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
            },
            claims: [], evidenceRefs: [],
            progress: { kind: 'approval-required', sourceTime: '2026-09-03T09:00:04.000Z', approvalKind: 'workspace-write', approvalPreview: '需要批准工作区写入。' },
          },
          {
            seq: 16, time: 10_600, sourceSequence: 7, state: 'progress', round: 1,
            role: {
              title: '建设性提案者', kind: 'participant', requestedOperatorId: 'codex', requestedModel: 'gpt-5.6-sol',
            },
            claims: [], evidenceRefs: [],
            progress: { kind: 'usage-updated', sourceTime: '2026-09-03T09:00:05.000Z', usage: { inputTokens: 120, outputTokens: 48 } },
          },
        ],
      }],
    })

    const group = turns[0]?.groups.find(value => value.title === 'Debate · 进度议题')
    // A native progress event replaces the generic lifecycle row rather than
    // producing a duplicate “状态已更新” row.
    expect(group?.cells).toHaveLength(7)
    expect(group?.cells.map(cell => cell.text)).toEqual([
      '已创建',
      '第 1 轮 · 建设性提案者 · 阶段 · 推理与执行',
      '第 1 轮 · 建设性提案者 · 公开输出更新',
      '第 1 轮 · 建设性提案者 · 工具开始 · Bash',
      '第 1 轮 · 建设性提案者 · 工具完成 · Bash',
      '第 1 轮 · 建设性提案者 · 需要批准 · workspace-write',
      '第 1 轮 · 建设性提案者 · 用量更新 · 输入 120 · 输出 48',
    ])
    expect(group?.cells[1]?.startedAt).toBe(Date.parse('2026-09-03T09:00:00.000Z'))
    expect(group?.cells[2]?.previewMarkdown).toBe('已完成基线。')
    expect(group?.cells[2]?.outputDetail).toContain('### 公开输出')
    expect(group?.cells[3]?.outputDetail).toContain('- Bash')
    expect(group?.cells[5]).toMatchObject({ isError: true, previewMarkdown: '需要批准工作区写入。' })
    expect(group?.cells[5]?.outputDetail).toContain('### 权限请求')
    expect(group?.cells[6]).toMatchObject({ input: 120, output: 48 })
    expect(group?.cells[6]?.outputDetail).toContain('### 用量')
    expect(group?.cells[6]?.recordId).toBe(['debate', 'debate-progress-123456789', '7', 'progress'].join('\u0000'))
  })

  it('renders a paired physical tool call with bounded input/result details and stable identity', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [],
      partial: null,
      runningCalls: [],
      physicalOperatorExecutions: [{
        commandId: 'command-tools', operatorId: 'codex', turn: 1, step: 1,
        dispatchSeq: 10, dispatchTime: 10_000,
        entries: [{
          seq: 11, time: 10_100, type: 'tool',
          tool: {
            toolCallId: 'tool-call-1', status: 'error',
            argumentsShape: { kind: 'object', fields: 1 },
            resultShape: { kind: 'object', fields: 1 },
            callSeq: 11, resultSeq: 12,
          },
        }],
      }],
    })
    const cell = turns[0]?.groups[0]?.cells[0]
    expect(cell).toMatchObject({
      kind: 'operator', text: 'DSH 工具失败', callId: 'tool-call-1', isError: true,
      inputDetail: '对象 · 1 个字段',
      outputDetail: '结果结构\n对象 · 1 个字段\n\n工具报告失败',
      previewMarkdown: '对象 · 1 个字段',
      resultPreviewMarkdown: '对象 · 1 个字段',
    })
    expect(cell?.recordId).toBe(['physical-operator', 'command-tools', 'tool', 'tool-call-1'].join('\u0000'))
  })

  it('renders an indeterminate recovered physical tool as a terminal error state', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null, runningCalls: [],
      physicalOperatorExecutions: [{
        commandId: 'command-indeterminate', operatorId: 'codex', turn: 1, step: 1,
        dispatchSeq: 10, dispatchTime: 10_000,
        entries: [{
          seq: 11, time: 10_100, type: 'tool',
          tool: {
            toolCallId: 'tool-call-1', status: 'indeterminate', callSeq: 10, resultSeq: 11,
          },
        }],
      }],
    })
    expect(turns[0]?.groups[0]?.cells[0]).toMatchObject({
      kind: 'operator', text: 'DSH 工具状态不确定', isError: true,
      outputDetail: '工具结果尚无法证明',
    })
  })

  it('orders a physical command by source sequence and keeps a settled success out of error state', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'start' }], source: null },
      {
        kind: 'assistant', seq: 5, time: 5_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'done' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({
      nodes,
      partial: null,
      runningCalls: [],
      physicalOperatorExecutions: [{
        commandId: 'command-2', operatorId: 'codex', turn: 1, step: 1,
        dispatchSeq: 3, dispatchTime: 3_000,
        entries: [
          { seq: 3, time: 3_000, type: 'dispatch' },
          { seq: 4, time: 4_000, type: 'terminal', code: 'completed', outcome: 'success' },
        ],
      }],
    })
    const groups = turns[0]?.groups ?? []
    expect(groups.map(group => group.title)).toEqual([
      'Message', 'Operator · Codex · command-2', 'Step 1',
    ])
    const terminal = groups[1]?.cells[1]
    expect(terminal?.text).toBe('执行完成 · completed')
    expect(terminal?.isError).toBeUndefined()
    expect(groups.flatMap(group => group.cells).map(cell => cell.index)).toEqual([1, 2, 3, 4])
  })

  it('folds an explicit tool-dispatch without an agent-loop location into the first visible turn', () => {
    const turns = deriveTrajectoryLayout({
      nodes: [], partial: null, runningCalls: [],
      physicalOperatorExecutions: [{
        commandId: 'tool-command', operatorId: 'claude-code', turn: 0, step: 0,
        dispatchSeq: 10, dispatchTime: 10_000,
        entries: [{ seq: 10, time: 10_000, type: 'dispatch' }],
      }],
    })

    expect(turns).toMatchObject([{
      turn: 1,
      groups: [{ title: 'Operator · Claude Code · tool-command' }],
    }])
  })

  it('appends a streaming partial without rebuilding unaffected finalized turns', () => {
    const nodes = [{
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
      blocks: [{ kind: 'text', text: 'finalized' }],
    }] as unknown as ConversationSnapshot['nodes']
    const partial = {
      turn: 2,
      step: 1,
      blocks: [{ kind: 'reasoning' as const, text: 'streaming' }],
    }
    const request = {
      purpose: 'assistant', startSeq: 3, turn: 2, step: 1,
      startedAt: 3_000, completedAt: null, status: 'running',
    } as unknown as RequestView
    const base = deriveTrajectoryLayout({
      nodes,
      partial: { ...partial, blocks: [] },
      requests: [request],
      runningCalls: [],
    })
    expect(base).toHaveLength(1)

    const streamed = appendTrajectoryPartialLayout(base, partial, 1)

    expect(streamed[0]).toBe(base[0])
    expect(streamed).toHaveLength(2)
    expect(streamed[1]?.groups[0]?.cells).toMatchObject([{
      index: 2,
      kind: 'message',
      text: '',
      previewMarkdown: 'streaming',
      timeSeconds: null,
    }])
    expect(streamed[1]?.groups[0]?.cells[0]?.requestOnly).toBeUndefined()
  })

  it('replaces a running-call placeholder with the matching streamed tool call', () => {
    const partial = {
      turn: 1,
      step: 1,
      blocks: [{
        kind: 'tool-call' as const,
        callId: 'c1',
        name: 'bash',
        argsRaw: '{"command":"pwd"}',
      }],
    }
    const base = deriveTrajectoryLayout({
      nodes: [],
      partial: { ...partial, blocks: [] },
      runningCalls: [{
        callId: 'c1', name: 'bash', argsRaw: '{"command":"pwd"}',
        turn: 1, step: 1, time: 9_000, callView: null, subCalls: [],
      }],
    })

    const streamed = appendTrajectoryPartialLayout(base, partial, 1)
    const cells = streamed[0]?.groups[0]?.cells ?? []

    expect(cells.map(cell => cell.kind)).toEqual(['message', 'tool'])
    expect(cells.filter(cell => cell.callId === 'c1')).toHaveLength(1)
  })

  it('omits duration when node times are missing instead of rendering NaN', () => {
    const nodes = [
      { kind: 'user', seq: 1, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, turn: 1, step: 1,
        blocks: [
          { kind: 'reasoning', text: '…' },
          { kind: 'text', text: 'ok' },
        ],
        usage: { inputTokens: 1, outputTokens: 2, reasoningTokens: 3 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    const cells = turns[0]?.groups.flatMap(g => g.cells) ?? []
    expect(cells.find(c => c.kind === 'message')?.timeSeconds).toBeNull()
    expect(turns[0]?.groups.find(g => g.title === 'Step 1')?.description).toBeUndefined()
  })

  it('builds a wall-span step description with a tool histogram', () => {
    const nodes = [
      {
        kind: 'assistant', seq: 1, time: 1_000, turn: 1, step: 1,
        blocks: [
          { kind: 'tool-call', callId: 'a', name: 'bash', argsRaw: '{}' },
          { kind: 'tool-call', callId: 'b', name: 'bash', argsRaw: '{}' },
        ],
      },
      {
        kind: 'tool-result', seq: 2, time: 2_500, callId: 'a',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 1_100,
        content: [], isError: false, callView: null, resultView: null,
      },
      {
        kind: 'tool-result', seq: 3, time: 4_000, callId: 'b',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 2_600,
        content: [], isError: false, callView: null, resultView: null,
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    expect(turns[0]?.groups[0]?.description).toBe('3,000 ms bash×2')
  })

  it('assigns each user message to its enclosing turn instead of pooling into Turn 1', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'first' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 0,
        blocks: [{ kind: 'text', text: 'ok1' }],
      },
      { kind: 'user', seq: 3, time: 3_000, content: [{ type: 'text', text: 'second' }], source: null },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 0,
        blocks: [{ kind: 'text', text: 'ok2' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    expect(turns.map(t => t.turn)).toEqual([1, 2])
    expect(turns[0]?.groups.flatMap(g => g.cells.map(c => c.previewMarkdown))).toEqual([
      'first',
      'ok1',
    ])
    expect(turns[1]?.groups.flatMap(g => g.cells.map(c => c.previewMarkdown))).toEqual([
      'second',
      'ok2',
    ])
  })

  it('places steering in its resolved step instead of the turn-opening Message group', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'start' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'first step' }],
      },
      {
        kind: 'steering', messageId: 'steer-1', seq: 3, time: 3_000,
        content: [{ type: 'text', text: 'change direction' }], source: null,
      },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 1, step: 2,
        blocks: [{ kind: 'text', text: 'second step' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const data = { get: () => undefined }
    const step = { turn: 1, step: 2, start: undefined, end: undefined, status: 'open' as const, data }
    const turn = {
      turn: 1, start: undefined, end: undefined, status: 'open' as const, steps: [step], data,
    }
    const eventLocations = new Map<number, ConversationLocation>([[
      3,
      { kind: 'step', turn, step },
    ]])

    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: null,
      runningCalls: [],
    })

    expect(turns).toHaveLength(1)
    expect(turns[0]?.groups.map(group => group.title)).toEqual([
      'Message', 'Step 1', 'Step 2',
    ])
    expect(turns[0]?.groups[2]?.cells).toMatchObject([
      { kind: 'user', previewMarkdown: 'change direction', sourceSeq: 3 },
      { kind: 'message', previewMarkdown: 'second step', sourceSeq: 4 },
    ])
  })

  it('keeps a running request boundary after steering input', () => {
    const nodes = [{
      kind: 'steering', messageId: 'steer-1', seq: 3, time: 3_000,
      content: [{ type: 'text', text: 'change direction' }], source: null,
    }] as unknown as ConversationSnapshot['nodes']
    const data = { get: () => undefined }
    const step = { turn: 1, step: 2, start: undefined, end: undefined, status: 'open' as const, data }
    const turn = {
      turn: 1, start: undefined, end: undefined, status: 'open' as const, steps: [step], data,
    }
    const eventLocations = new Map<number, ConversationLocation>([[
      3,
      { kind: 'step', turn, step },
    ]])

    const turns = deriveTrajectoryLayout({
      nodes,
      eventLocations,
      partial: null,
      runningCalls: [],
      requests: [{
        purpose: 'assistant',
        startSeq: 2,
        turn: 1,
        step: 2,
        startedAt: 2_000,
        completedAt: null,
        status: 'running',
      }],
    })

    expect(turns[0]?.groups[0]?.cells).toMatchObject([
      { kind: 'user', previewMarkdown: 'change direction', sourceSeq: 3 },
      { kind: 'message', requestOnly: true, sourceSeq: 2 },
    ])
  })

  it('uses the following assistant step while a historical window lacks steering Location', () => {
    const nodes = [
      {
        kind: 'steering', messageId: 'steer-1', seq: 3, time: 3_000,
        content: [{ type: 'text', text: 'change direction' }], source: null,
      },
      {
        kind: 'assistant', seq: 4, time: 4_000, turn: 2, step: 3,
        blocks: [{ kind: 'text', text: 'continued' }],
      },
    ] as unknown as ConversationSnapshot['nodes']

    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })

    expect(turns[0]).toMatchObject({
      turn: 2,
      groups: [{
        title: 'Step 3',
        cells: [
          { kind: 'user', previewMarkdown: 'change direction' },
          { kind: 'message', previewMarkdown: 'continued' },
        ],
      }],
    })
  })

  it('places standalone compaction chronologically in its own between-turn section', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'first' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'before compaction' }],
      },
      { kind: 'user', seq: 5, time: 5_000, content: [{ type: 'text', text: 'second' }], source: null },
      {
        kind: 'assistant', seq: 6, time: 6_000, turn: 2, step: 1,
        blocks: [{ kind: 'text', text: 'after compaction' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const compaction: RequestView = {
      purpose: 'compaction',
      startSeq: 3,
      turn: null,
      step: 0,
      startedAt: 3_000,
      completedAt: 4_000,
      status: 'complete',
      summary: [{ type: 'text', text: 'standalone summary' }],
    }

    const turns = deriveTrajectoryLayout({
      nodes,
      partial: null,
      runningCalls: [],
      requests: [compaction],
    })

    expect(turns.map(turn => turn.turn)).toEqual([1, null, 2])
    expect(turns[1]?.groups).toMatchObject([{
      title: 'Compaction 3',
      cells: [{
        kind: 'compacted',
        sourceSeq: 3,
        text: '',
        previewMarkdown: 'standalone summary',
      }],
    }])
  })

  it('keeps usage and a meaningful summary when assistant has no text block', () => {
    const nodes = [
      {
        kind: 'assistant', seq: 1, time: 5_000, turn: 1, step: 0,
        blocks: [{ kind: 'reasoning', text: '…' }],
        usage: { inputTokens: 11, outputTokens: 22, reasoningTokens: 3 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    const message = turns[0]?.groups.flatMap(g => g.cells).find(c => c.kind === 'message')
    expect(message).toMatchObject({
      text: '', previewMarkdown: '…', input: 11, output: 22, think: 3,
    })
  })

  it('bounds a long Markdown-like thinking preview while retaining its full detail', () => {
    const thinking = `# Investigation\n\n**NAVIGATION_OK file_path** ${'- repeated detail '.repeat(1_000)}`
    const nodes = [{
      kind: 'assistant', seq: 1, time: 5_000, turn: 1, step: 0,
      blocks: [{ kind: 'reasoning', text: thinking }],
    }] as unknown as ConversationSnapshot['nodes']

    const turns = deriveTrajectoryLayout({
      nodes, partial: null, runningCalls: [],
    })
    const message = turns[0]?.groups.flatMap(group => group.cells)
      .find(cell => cell.kind === 'message')

    expect(message?.text).toBe('')
    expect(message?.previewMarkdown).toBe(thinking)
    expect(message?.thinkingDetail).toBe(thinking)
  })

  it('advances the duration cursor over context and compaction nodes', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1,
        blocks: [{ kind: 'tool-call', callId: 'c1', name: 'bash', argsRaw: '{}' }],
      },
      {
        kind: 'tool-result', seq: 3, time: 3_000, callId: 'c1',
        call: { name: 'bash', argsRaw: '{}' }, callTime: 2_100,
        content: [], isError: false, callView: null, resultView: null,
      },
      {
        kind: 'context', seq: 4, time: 9_000,
        content: [{ type: 'text', text: 'extra' }], source: null,
      },
      // A landed compaction renders no cell, but is still a real log position,
      // so it moves the cursor after the visible context row.
      {
        kind: 'compaction', seq: 5, time: 9_500, summary: 'checkpoint facts',
        summaryEventSeq: 4, shadowedItemCount: 2, shadowedTokenCount: 100,
      },
      {
        kind: 'assistant', seq: 6, time: 10_000, turn: 1, step: 0,
        blocks: [{ kind: 'text', text: 'done' }],
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({ nodes, partial: null, runningCalls: [] })
    const cells = turns[0]?.groups.flatMap(g => g.cells) ?? []
    const message = cells.find(c => c.kind === 'message' && c.previewMarkdown === 'done')
    // From the compaction marker at 9.5s, not from context at 9s or the earlier surfaces.
    expect(message?.timeSeconds).toBe(0.5)
    // Context remains inspectable in trajectory; the Chat marker is not duplicated.
    expect(cells.map(cell => cell.kind)).toEqual(['user', 'message', 'tool', 'context', 'message'])
  })

  it('uses the recorded step start for assistant duration when timing exists', () => {
    const nodes = [
      { kind: 'user', seq: 1, time: 1_000, content: [{ type: 'text', text: 'hi' }], source: null },
      {
        kind: 'assistant', seq: 2, time: 4_000, turn: 1, step: 1,
        blocks: [{ kind: 'text', text: 'done' }],
        timing: { stepStartTime: 3_000, firstTokenTime: 3_500, completedTime: 4_000 },
      },
    ] as unknown as ConversationSnapshot['nodes']
    const turns = deriveTrajectoryLayout({
      nodes, partial: null, runningCalls: [],
    })
    const message = turns[0]?.groups.flatMap(group => group.cells)
      .find(cell => cell.kind === 'message')
    expect(message).toMatchObject({ startedAt: 3_000, timeSeconds: 1 })
  })
})

describe('run_code sub-dispatch cells', () => {
  const runCodeNodes = [
    {
      kind: 'assistant', seq: 2, time: 6_000, turn: 1, step: 1,
      blocks: [
        { kind: 'tool-call', callId: 'p1', name: 'run_code', argsRaw: '{"code":"…","description":"批量读取"}' },
      ],
    },
    {
      kind: 'tool-result', seq: 3, time: 9_000, callId: 'p1',
      call: { name: 'run_code', argsRaw: '{"code":"…","description":"批量读取"}' }, callTime: 6_200,
      content: [{ type: 'text', text: 'done' }], isError: false, callView: null, resultView: null,
      subCalls: [],
    },
  ] as unknown as ConversationSnapshot['nodes']

  const settledSub = (n: number, name: string, start: number, end: number) => ({
    kind: 'tool-result' as const, seq: 100 + n, time: end,
    callId: `p1:code:${n}`,
    call: { name, argsRaw: '{"x":1}' }, callTime: start,
    content: [{ type: 'text' as const, text: 'ok' }], isError: false, callView: null, resultView: null,
    subCalls: [],
  })

  const withSubCalls = (subCalls: readonly ReturnType<typeof settledSub>[] | readonly object[]) =>
    runCodeNodes.map(node => node.kind === 'tool-result' ? { ...node, subCalls } : node) as ConversationSnapshot['nodes']

  it('nests settled sub-cells after their parent Tool cell with real durations', () => {
    const subCalls = [
      settledSub(1, 'bash', 6_300, 7_300),
      settledSub(2, 'read', 7_300, 7_800),
    ]
    const turns = deriveTrajectoryLayout({ nodes: withSubCalls(subCalls), partial: null, runningCalls: [] })
    const cells = turns[0]!.groups.flatMap(g => g.cells)
    expect(cells.map(c => c.kind)).toEqual(['message', 'tool', 'subtool', 'subtool'])
    expect(cells[0]?.text).toBe('Tool call only')
    // Sequential indexes across the interleave; durations from the pair times.
    expect(cells.map(c => c.index)).toEqual([1, 2, 3, 4])
    expect(cells[2]).toMatchObject({
      text: 'bash', previewMarkdown: '{"x":1}', timeSeconds: 1,
    })
    expect(cells[3]).toMatchObject({ timeSeconds: 0.5 })
  })

  it('a running (unsettled) sub-call renders a subtool cell with blank time', () => {
    const running = {
      callId: 'p1:code:1', name: 'grep', argsRaw: '{"pattern":"x"}',
      turn: 0, step: 0, time: 6_400, callView: null, subCalls: [],
    }
    const turns = deriveTrajectoryLayout({ nodes: withSubCalls([running]), partial: null, runningCalls: [] })
    const sub = turns[0]!.groups.flatMap(g => g.cells).find(c => c.kind === 'subtool')
    expect(sub).toMatchObject({
      text: 'grep', previewMarkdown: '{"pattern":"x"}', timeSeconds: null,
    })
  })

  it('recursively flattens nested child calls immediately after their parent', () => {
    const leaf = {
      ...settledSub(2, 'read', 7_300, 7_800),
      callId: 'p1:code:1:code:1',
    }
    const child = {
      ...settledSub(1, 'run_code', 6_300, 8_000),
      subCalls: [leaf],
    }
    const turns = deriveTrajectoryLayout({ nodes: withSubCalls([child]), partial: null, runningCalls: [] })
    const cells = turns[0]!.groups.flatMap(group => group.cells)
    expect(cells.map(cell => cell.kind)).toEqual(['message', 'tool', 'subtool', 'subtool'])
    expect(cells.slice(2).map(cell => cell.callId)).toEqual([
      'p1:code:1',
      'p1:code:1:code:1',
    ])
    expect(cells.map(cell => cell.index)).toEqual([1, 2, 3, 4])
  })
})
