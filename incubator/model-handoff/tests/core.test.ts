import { describe, expect, it } from 'vitest'
import {
  HandoffError,
  parseDraft,
  renderHandoff,
  type HandoffDraft,
} from '../src/core.js'

describe('model handoff core', () => {
  it('preserves code fences inside a valid JSON summary', () => {
    const summary = '必要原代码：\n```ts\nconst count = 0\n```'
    expect(parseDraft(JSON.stringify({ summary, questions: [{ id: 'a', question: '下一步？' }, { id: 'b', question: '限制？' }] })).summary).toBe(summary)
  })
  it('parses a valid two-question draft without changing its text', () => {
    const draftText = JSON.stringify({
      summary: '请把这段摘要原样保留。',
      questions: [
        { id: 'scope', question: '要覆盖哪些边界？' },
        { id: 'risk', question: '有哪些已知风险？' },
      ],
    })

    expect(parseDraft(draftText)).toEqual({
      summary: '请把这段摘要原样保留。',
      questions: [
        { id: 'scope', question: '要覆盖哪些边界？' },
        { id: 'risk', question: '有哪些已知风险？' },
      ],
    })
  })

  it('parses the maximum three questions and accepts boundary lengths', () => {
    const summary = '概'.repeat(50_000)
    const id = 'i'.repeat(64)
    const question = '问'.repeat(1_000)
    const draft = parseDraft(JSON.stringify({
      summary,
      questions: [
        { id, question },
        { id: 'second', question: '第二个问题' },
        { id: 'third', question: '第三个问题' },
      ],
    }))

    expect(draft.summary).toBe(summary)
    expect(draft.questions).toHaveLength(3)
    expect(draft.questions[0]).toEqual({ id, question })
  })

  it.each([
    ['not-json', 'invalid-json'],
    ['```json\n{"summary":"x","questions":[]}\n```', 'code-fence'],
    ['[]', 'invalid-shape'],
    ['{"summary":"x"}', 'invalid-shape'],
    ['{"summary":"x","questions":[],"extra":true}', 'unexpected-field'],
    ['{"summary":1,"questions":[]}', 'invalid-string'],
    ['{"summary":"   ","questions":[]}', 'empty-string'],
    ['{"summary":"x","questions":[{"id":"a","question":"q"}]}', 'question-count'],
    ['{"summary":"x","questions":[{"id":"a","question":"q"},{"id":"a","question":"q2"}]}', 'duplicate-id'],
    [JSON.stringify({ summary: 'x', questions: [{ id: 'a', question: 'q', extra: true }, { id: 'b', question: 'q2' }] }), 'unexpected-field'],
    [JSON.stringify({ summary: 'x'.repeat(50_001), questions: [{ id: 'a', question: 'q' }, { id: 'b', question: 'q2' }] }), 'length-exceeded'],
    [JSON.stringify({ summary: 'x', questions: [{ id: 'a'.repeat(65), question: 'q' }, { id: 'b', question: 'q2' }] }), 'length-exceeded'],
    [JSON.stringify({ summary: 'x', questions: [{ id: 'a', question: 'q'.repeat(1_001) }, { id: 'b', question: 'q2' }] }), 'length-exceeded'],
  ] as const)('rejects invalid draft %j', (text, code) => {
    try {
      parseDraft(text)
      throw new Error('expected parseDraft to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(HandoffError)
      expect((error as HandoffError).code).toBe(code)
    }
  })

  it('renders exact Unicode answers in question order, regardless of answer order', () => {
    const draft: HandoffDraft = {
      summary: '摘要含有换行\n以及 emoji 🧭。',
      questions: [
        { id: 'first', question: '第一个问题？' },
        { id: 'second', question: '第二个问题？' },
      ],
    }
    const rendered = renderHandoff(
      draft,
      [
        { id: 'second', answer: '暂无补充' },
        { id: 'first', answer: '精确答案：保留空格 以及 🌟' },
      ],
      { provider: 'codex', model: '目标模型-中文' },
    )

    expect(rendered).toBe([
      '模型交接',
      '目标提供方：codex',
      '目标模型：目标模型-中文',
      '摘要：',
      '摘要含有换行\n以及 emoji 🧭。',
      '问题1：第一个问题？',
      '回答1：精确答案：保留空格 以及 🌟',
      '问题2：第二个问题？',
      '回答2：暂无补充',
    ].join('\n'))
  })

  it('requires exactly one nonblank answer for every question', () => {
    const draft: HandoffDraft = {
      summary: '摘要',
      questions: [
        { id: 'a', question: '问题 A' },
        { id: 'b', question: '问题 B' },
      ],
    }
    const target = { provider: 'codex', model: 'model' }

    expect(() => renderHandoff(draft, [{ id: 'a', answer: '答案' }], target)).toThrowError(HandoffError)
    expect(() => renderHandoff(draft, [
      { id: 'a', answer: '答案' },
      { id: 'a', answer: '重复' },
    ], target)).toThrowError(HandoffError)
    expect(() => renderHandoff(draft, [
      { id: 'a', answer: '答案' },
      { id: 'other', answer: '额外' },
    ], target)).toThrowError(HandoffError)
    expect(() => renderHandoff(draft, [
      { id: 'a', answer: '答案' },
      { id: 'b', answer: '   ' },
    ], target)).toThrowError(HandoffError)
    expect(() => renderHandoff(draft, [
      { id: 'a', answer: 'a'.repeat(10_001) },
      { id: 'b', answer: '答案' },
    ], target)).toThrowError(HandoffError)
  })

  it('preserves an answer at the 10000-character boundary', () => {
    const answer = '答'.repeat(10_000)
    const result = renderHandoff(
      { summary: '摘要', questions: [{ id: 'a', question: '问题一' }, { id: 'b', question: '问题二' }] },
      [{ id: 'a', answer }, { id: 'b', answer: '暂无补充' }],
      { provider: 'codex', model: 'model' },
    )
    expect(result).toContain(`回答1：${answer}`)
  })
})
