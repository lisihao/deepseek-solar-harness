import { describe, expect, it } from 'vitest'
import { projectTaskRecords, renderTaskTranscript, textLength } from '../src/history.js'

type RecordInput = Record<string, unknown>

function textRecord(
  seq: number,
  role: string,
  text: string,
  source: RecordInput,
  extra: RecordInput = {},
): RecordInput {
  return {
    seq,
    type: `${role}/message`,
    role,
    content: [{ type: 'text', text }],
    source,
    ...extra,
  }
}

describe('task history projection', () => {
  it('removes system and injected context while preserving a literal task', () => {
    const catalog = '技能目录：'.repeat(120_000)
    const records: RecordInput[] = [
      textRecord(1, 'system', '系统提示不属于任务。', { kind: 'system-prompt' }),
      textRecord(2, 'user', catalog, { kind: 'skill-catalog', form: 'catalog', entries: [catalog] }),
      textRecord(3, 'user', '运行环境：macOS', { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'runtime', text: 'x'.repeat(100) }] }),
      textRecord(4, 'user', '召回内容', { kind: 'session-reference', form: 'recall', references: [{ sessionId: 's', label: 'old' }] }),
      textRecord(5, 'user', '请检查 Lighthouse 的灯塔状态；“虚构”是任务中的原文。', { kind: 'user' }),
      textRecord(6, 'assistant', '已确认 Lighthouse 的虚构检查目标。', { kind: 'model', provider: 'fixture', model: 'fixture', replayState: { giant: 'x'.repeat(100_000) } }),
    ]

    const projected = projectTaskRecords(records)
    expect(projected.map(record => record.seq)).toEqual([5, 6])
    expect(projected[0]).toEqual({
      seq: 5,
      type: 'user/message',
      role: 'user',
      content: [{ type: 'text', text: '请检查 Lighthouse 的灯塔状态；“虚构”是任务中的原文。' }],
      source: { kind: 'user' },
    })
    expect(projected[1]?.source).toEqual({ kind: 'model', provider: 'fixture', model: 'fixture' })
    expect(JSON.stringify(projected)).not.toContain('技能目录')
    expect(JSON.stringify(projected)).not.toContain('replayState')
    expect(JSON.stringify(projected).length).toBeLessThan(20_000)
  })

  it('retains checkpoint and producer notice/relay as attributed context', () => {
    const records: RecordInput[] = [
      textRecord(1, 'user', '压缩后的任务摘要', { kind: 'compact-checkpoint', compactionId: 'compact-7', sourceCommandId: 'private' }),
      textRecord(2, 'user', '子代理报告：灯塔已点亮。', { kind: 'subagent-settled', form: 'notice', summary: '灯塔已点亮。', senderSessionId: 'private' }),
      textRecord(3, 'user', '转发的任务上下文。', { kind: 'agent-message', form: 'relay', senderSessionId: 'private' }),
      textRecord(4, 'user', '记忆插件背景', { kind: 'plugin:hindsight' }),
    ]

    const projected = projectTaskRecords(records)
    expect(projected.map(record => record.seq)).toEqual([1, 2, 3])
    expect(projected[0]?.source).toEqual({ kind: 'compact-checkpoint', compactionId: 'compact-7' })
    expect(projected[1]?.source).toEqual({ kind: 'subagent-settled', form: 'notice' })
    expect(projected[2]?.source).toEqual({ kind: 'agent-message', form: 'relay' })

    const transcript = renderTaskTranscript(records)
    expect(transcript).toContain('历史交接摘要：压缩后的任务摘要')
    expect(transcript).not.toContain('用户：压缩后的任务摘要')
    expect(transcript).toContain('上下文（notice）：子代理报告：灯塔已点亮。')
    expect(transcript).toContain('上下文（relay）：转发的任务上下文。')
    expect(transcript).not.toContain('plugin:hindsight')
  })

  it('preserves tool pairing order, call ids, errors, and developer tool headers', () => {
    const call = {
      seq: 10,
      type: 'assistant/message',
      role: 'assistant',
      content: [
        { type: 'text', text: '开始检查。' },
        { type: 'tool-call', id: 'call-1', name: 'read_lighthouse', arguments: '{"name":"Lighthouse"}' },
      ],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }
    const result = textRecord(11, 'tool', '工具失败：目标不存在。', { kind: 'tool', callId: 'call-1' }, {
      toolCallId: 'call-1',
      isError: true,
    })
    const developer = textRecord(12, 'developer', '', { kind: 'tool-registry' }, {
      content: [{ type: 'tool-addition', toolName: 'read_lighthouse' }],
      toolHeader: {
        header: {
          config: { provider: 'fixture', model: 'fixture' },
          tools: [{ name: 'read_lighthouse', description: '读取灯塔', parameters: { type: 'object' } }],
        },
        reason: 'tool-addition',
      },
    })
    const irrelevantHeader = textRecord(13, 'developer', '普通开发者记录', { kind: 'tool-registry' }, {
      toolHeader: { header: { tools: [{ name: 'stale' }] } },
    })

    const projected = projectTaskRecords([call, result, developer, irrelevantHeader])
    expect(projected).toHaveLength(4)
    expect(projected.map(record => record.seq)).toEqual([10, 11, 12, 13])
    expect(projected[1]).toMatchObject({ toolCallId: 'call-1', isError: true, source: { kind: 'tool', callId: 'call-1' } })
    expect(projected[2]?.toolHeader).toEqual(developer.toolHeader)
    expect(projected[3]).not.toHaveProperty('toolHeader')

    const transcript = renderTaskTranscript([call, result, developer])
    expect(transcript).toContain('模型：开始检查。')
    expect(transcript).toContain('{"type":"tool-call","id":"call-1","name":"read_lighthouse","arguments":"{\\"name\\":\\"Lighthouse\\"}"}')
    expect(transcript).toContain('工具：工具失败：目标不存在。')
    expect(transcript).toContain('开发者：{"type":"tool-addition","toolName":"read_lighthouse"}')
    expect(transcript).not.toContain('seq')
  })

  it('counts Unicode code points', () => {
    expect(textLength('Lighthouse🌟🧭')).toBe(12)
    expect(textLength('𠮷')).toBe(1)
    expect(textLength('')).toBe(0)
  })
})
