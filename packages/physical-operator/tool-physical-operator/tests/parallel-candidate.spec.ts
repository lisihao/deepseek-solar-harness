import { describe, expect, it } from 'vitest'
import { isMemoryRequest, isParallelCandidate } from '../src/index.ts'

describe('isParallelCandidate', () => {
  it.each([
    '请并行安排多个子任务，分别研究三个独立模块，最后综合验证结论。',
    '请并行研究三个独立方案，再综合输出最终建议。',
    '把这批文件的迁移并行处理',
    '拆成几个并行任务去做',
    'run the independent branches in parallel',
  ])('routes a request for parallel work to the TaskGraph: %s', (text) => {
    expect(isParallelCandidate(text)).toBe(true)
  })

  it.each([
    '后面文字是你的记忆：关注 Speculative Decoding、单请求序列内并行生成，以及企业级 Code Agent。',
    '研究并行解码和并行计算架构的差异',
    '总结这篇论文，请保留关于数据并行与模型并行的部分',
  ])('keeps a task that only mentions parallelism as a topic on the main model: %s', (text) => {
    expect(isParallelCandidate(text)).toBe(false)
  })
})

describe('isMemoryRequest', () => {
  it.each([
    '后面文字是GPT上的记忆，你分析后，写到记忆中，要精准：你主要围绕 AI 产业开展研究',
    '把这段保存到 Mnemon 里',
    '请记住：我偏好中文回复',
    'remember this: I prefer concise answers',
    '更新记忆，增加我最近的研究方向',
  ])('recognizes a request to write to memory: %s', (text) => {
    expect(isMemoryRequest(text)).toBe(true)
  })

  it.each([
    '修复这个 bug 并补测试',
    '总结这篇研究报告的架构部分',
    `${'分析下面这段代码的性能问题。'.repeat(12)}写到记忆中的内容不算指令`,
  ])('ignores a request whose opening is not a memory instruction: %s', (text) => {
    expect(isMemoryRequest(text)).toBe(false)
  })
})
