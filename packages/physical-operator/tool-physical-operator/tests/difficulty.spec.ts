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
    ['那要增加一个功能，就是检测是否有新的 codex、claude cli，然后推荐用户是否更新', 'hard'],
    ['做一个修改：增加最新档位的codex入口，如果以后升级了点击刷新就能替换', 'hard'],
    ['两个任务：1）选择A；2）之前让codex开发的功能：在 DSH 上增加一个按钮，点击后更新模型列表', 'hard'],
    ['这块有几个问题：1、列表不刷新 2、名字不显示版本 3、其他算子都显示失败', 'hard'],
    ['add a new feature that notifies users when a CLI update is available', 'hard'],
    ['增加一个按钮', 'normal'],
    ['添加单元测试', 'normal'],
    ['先做1，再看2', 'normal'],
    ['formatPrice 的返回值不对，修复并补测试', 'normal'],
    ['实现一个 retryRequest 函数，添加单元测试', 'normal'],
    ['rename the variable getUserName to fetchName', 'easy'],
    ['看一下 `format` 和 `retry_count` 这两个变量', 'normal'],
    ['改一下 settings-draft.ts 里的一行注释', 'easy'],
    ['设计成本感知：简单任务选便宜够用的，需要改分配器的打分规则', 'normal'],
    ['为什么版本号偶尔显示空白？帮我排查一下', 'normal'],
    ['日志里报错了，帮我看下', 'normal'],
    ['把日志级别的一行注释改一下', 'easy'],
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

  it('does not read a retry word inside a code identifier as a retry', () => {
    expect(isRetryRequest('实现一个 retryRequest 函数')).toBe(false)
    expect(isRetryRequest('这个 `retry` 是什么')).toBe(false)
    expect(isRetryRequest('还是不行，retry again')).toBe(true)
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
