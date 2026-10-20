import { describe, expect, it } from 'vitest'
import {
  HandoffError,
  parseDraft,
  renderHandoff,
  type HandoffDraft,
} from '../src/core.js'

describe('model handoff core', () => {
  it('requires contextual choices for a fresh model draft and preserves exact option text', () => {
    const questions = [
      { id: 'next', question: '下一步选哪一项？', options: ['先列离线测试，暂不写代码', '先复核已有约束'] },
      { id: 'scope', question: '测试范围？', options: ['预算更正与边界条件', '预算更正、边界条件与异常恢复'] },
    ]
    const result = parseDraft(JSON.stringify({ summary: '预算1800元，3000元作废。', questions }), true)
    expect(result.questions).toEqual(questions)
    expect(() => parseDraft(JSON.stringify({ summary: '旧摘要', questions: questions.map(({ id, question }) => ({ id, question })) }), true)).toThrowError(HandoffError)
    expect(renderHandoff(result, [{ id: 'next', answer: questions[0]!.options[0]! }, { id: 'scope', answer: '桥梁🧭-042' }], { provider: 'p', model: 'm' })).toContain('回答1：先列离线测试，暂不写代码')
  })

  it.each([
    [], ['唯一选项'], ['a', 'b', 'c', 'd'], ['a', 'a'], ['a', ' a '], ['a', '   '], ['a', '暂无补充'], ['a', 7], ['a', '字'.repeat(181)],
  ].map(options => ({ options })))('rejects unusable candidate answers %j', ({ options }) => {
    expect(() => parseDraft(JSON.stringify({ summary: '摘要', questions: [
      { id: 'a', question: '下一步？', options },
      { id: 'b', question: '范围？', options: ['只检查已知范围', '先确认未决事项'] },
    ] }), true)).toThrowError(HandoffError)
  })

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
