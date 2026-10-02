import { describe, expect, it } from 'vitest'
import { classifyDifficulty, escalate, isRetryRequest, judgeDifficulty } from '../src/difficulty.ts'

const STACK = 'Error: boom\n    at a (/x/a.ts:1:1)\n    at b (/x/b.ts:2:2)\n    at c (/x/c.ts:3:3)'

describe('classifyDifficulty', () => {
  it.each([
    ['把变量 foo 重命名为 bar', 'easy'],
    ['给这个函数加一行注释', 'easy'],
    ['fix a typo in the README', 'easy'],
    ['explain what this regex does', 'easy'],
    ['修复登录页面点击按钮没反应的问题', 'normal'],
    ['implement a debounce helper and add tests', 'normal'],
    ['重构整个支付模块并迁移到新接口', 'hard'],
    ['review the architecture of the scheduler', 'hard'],
    ['look into this deadlock in the queue', 'hard'],
    ['找出这次性能回退的原因', 'hard'],
    ['排查服务里的并发问题', 'hard'],
    ['合并并发布3.19.0', 'normal'],
    ['合并发布151，另外两个也修', 'normal'],
    [STACK, 'hard'],
    ['x'.repeat(1_300), 'hard'],
    ['a\n```\n1\n```\nb\n```\n2\n```\nc\n```\n3\n```', 'hard'],
    ['Traceback (most recent call last):\n  File "x.py"', 'hard'],
  ] as const)('judges %j as %s', (text, expected) => {
    expect(classifyDifficulty(text)).toBe(expected)
  })

  it('does not call a long request easy just because it contains a simple word', () => {
    expect(classifyDifficulty(`解释一下${'这个函数的行为并说明它的边界。'.repeat(20)}`)).toBe('normal')
  })

  it('counts two stack frames as noise, not a trace', () => {
    expect(classifyDifficulty('Error: boom\n    at a (/x/a.ts:1:1)\n    at b (/x/b.ts:2:2)')).toBe('normal')
  })

  it('is deterministic', () => {
    expect(classifyDifficulty('重构整个支付模块')).toBe(classifyDifficulty('重构整个支付模块'))
  })
})

describe('isRetryRequest', () => {
  it.each(['重试', '不对，再来一次', '还是不行', 'try again', 'it still fails', "that didn't work"])('recognizes %s', (text) => {
    expect(isRetryRequest(text)).toBe(true)
  })

  it.each(['把变量改名', 'add a loop to the client', '谢谢'])('does not treat %s as a retry', (text) => {
    expect(isRetryRequest(text)).toBe(false)
  })
})

describe('escalate', () => {
  it('raises one step at a time and stops at hard', () => {
    expect(escalate('easy', 1)).toBe('normal')
    expect(escalate('easy', 2)).toBe('hard')
    expect(escalate('normal', 5)).toBe('hard')
    expect(escalate('hard', 1)).toBe('hard')
  })

  it('never lowers a difficulty', () => {
    expect(escalate('normal', 0)).toBe('normal')
    expect(escalate('hard', -3)).toBe('hard')
  })
})

describe('judgeDifficulty', () => {
  const none = { earlierRequests: [], lastDispatchFailed: false }

  it('uses the message itself when nothing came before', () => {
    expect(judgeDifficulty('把变量改名', none)).toEqual({ level: 'easy', raised: 0 })
  })

  it('takes a retry message at the difficulty of the request it repeats, one step higher', () => {
    expect(judgeDifficulty('重试', { earlierRequests: ['把变量改名'], lastDispatchFailed: false })).toEqual({ level: 'normal', raised: 1 })
  })

  it('skips earlier retries to find the request being repeated', () => {
    expect(judgeDifficulty('还是不行', { earlierRequests: ['不对', '把变量改名'], lastDispatchFailed: false }))
      .toEqual({ level: 'normal', raised: 1 })
  })

  it('judges a retry by its own text when there is no earlier request', () => {
    expect(judgeDifficulty('try again', none)).toEqual({ level: 'hard', raised: 1 })
  })

  it('raises one step after a failed delegation, and two for a retry after one', () => {
    expect(judgeDifficulty('把变量改名', { earlierRequests: [], lastDispatchFailed: true })).toEqual({ level: 'normal', raised: 1 })
    expect(judgeDifficulty('重试', { earlierRequests: ['把变量改名'], lastDispatchFailed: true })).toEqual({ level: 'hard', raised: 2 })
  })
})
