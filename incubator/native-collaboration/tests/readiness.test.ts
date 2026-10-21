import { describe, expect, it } from 'vitest'
import type { Executor, GraphSnapshot, GraphStatus, NodeSnapshot } from '@lisihao/dsh-solar-native-resident/contracts'
import { failureHint, latestNativeCheck, readinessRows, type ReadinessStatus } from '../src/client-helpers.js'

const markers: Record<Executor, string> = { codex: 'SOLAR_CODEX_OK', 'claude-code': 'SOLAR_CLAUDE_OK' }

function check(executor: Executor, status: GraphStatus, at: number, node: Partial<NodeSnapshot> = {}): GraphSnapshot {
  return {
    formatVersion: 1,
    graph: {
      formatVersion: 1,
      id: `native-check-${executor}-${at}`,
      label: 'check',
      cwd: '/tmp/check',
      maxParallel: 1,
      nodes: [{ id: 'check', executor, prompt: 'check' }],
    },
    status,
    revision: 1,
    createdAt: at,
    updatedAt: at + 5,
    nodes: [{ id: 'check', status: status === 'completed' ? 'succeeded' : 'failed', attempt: 1, ...node }],
  }
}

const ready: ReadinessStatus = {
  resident: { available: true, message: 'ok' },
  tools: ['solar_resident', 'solar_delegate', 'solar_coordinate', 'solar_wait'].map(name => ({ name, available: true })),
}

const time = (value: number): string => `t${value}`

function row(rows: ReturnType<typeof readinessRows>, key: string) {
  return rows.find(item => item.key === key)
}

describe('readiness rows', () => {
  it('reports a running scheduler, ready tools and untested executors', () => {
    const rows = readinessRows(ready, [], time)
    expect(rows.map(item => [item.key, item.tone, item.text])).toEqual([
      ['resident', 'ok', '运行中'],
      ['tools', 'ok', '已就绪'],
      ['codex', 'unknown', '尚未测试'],
      ['claude-code', 'unknown', '尚未测试'],
    ])
  })

  it('names a stopped scheduler and each missing tool', () => {
    const rows = readinessRows({
      resident: { available: false, message: 'down' },
      tools: [{ name: 'solar_coordinate', available: false }, { name: 'solar_wait', available: false }, { name: 'solar_resident', available: true }],
    }, [], time)
    expect(row(rows, 'resident')?.tone).toBe('error')
    expect(row(rows, 'tools')).toMatchObject({ tone: 'error', text: '缺少：任务拆分提交、结果等待' })
  })

  it('judges an executor by its most recent check only', () => {
    const passedEarlier = check('codex', 'completed', 100, { output: markers.codex })
    const failedLater = check('codex', 'failed', 200, { error: { code: 'COMMAND_FAILED', message: 'Codex native turn failed: boom' } })
    expect(latestNativeCheck('codex', [failedLater, passedEarlier])).toBe(failedLater)
    expect(row(readinessRows(ready, [failedLater, passedEarlier], time), 'codex')).toMatchObject({ tone: 'error', text: '上次测试失败（t205）：boom' })
    const passedLatest = check('codex', 'completed', 300, { output: markers.codex })
    expect(row(readinessRows(ready, [failedLater, passedLatest, passedEarlier], time), 'codex')).toMatchObject({ tone: 'ok', text: '上次测试通过（t305）' })
  })

  it('does not count a completed check without the exact marker as passed', () => {
    const wrongOutput = check('codex', 'completed', 100, { output: 'something else' })
    expect(row(readinessRows(ready, [wrongOutput], time), 'codex')).toMatchObject({ tone: 'error', text: '上次测试失败（t105）：连接测试失败：未收到预期标记' })
  })

  it('keeps executors apart and shows a running check as in progress', () => {
    const claudeRunning = check('claude-code', 'running', 100)
    const rows = readinessRows(ready, [claudeRunning], time)
    expect(row(rows, 'claude-code')).toMatchObject({ tone: 'unknown', text: '测试进行中' })
    expect(row(rows, 'codex')?.text).toBe('尚未测试')
  })

  it('attaches the matching hint to a failed check', () => {
    const refused = check('claude-code', 'failed', 100, {
      error: { code: 'COMMAND_FAILED', message: 'Claude native turn failed: API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)' },
    })
    const result = row(readinessRows(ready, [refused], time), 'claude-code')
    expect(result?.text).toBe('上次测试失败（t105）：API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)')
    expect(result?.hint).toContain('https_proxy')
  })
})

describe('failure hints', () => {
  it.each([
    ['API Error: Connection refused', 'https_proxy'],
    ['connect ECONNREFUSED 127.0.0.1:443', 'https_proxy'],
    ["You've hit your weekly limit · resets Oct 21 at 1pm", '额度'],
    ['401 Unauthorized', '登录'],
  ])('maps %s to a hint mentioning %s', (message, expected) => {
    expect(failureHint(message)).toContain(expected)
  })

  it('leaves an unknown failure without a hint', () => {
    expect(failureHint('model produced no output')).toBeUndefined()
    expect(failureHint('could not generate a separate answer')).toBeUndefined()
  })
})
