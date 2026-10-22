import { describe, expect, it } from 'vitest'
import type { Executor, GraphSnapshot, GraphStatus, NodeSnapshot, NodeStatus } from '@lisihao/dsh-solar-native-resident/contracts'
import {
  activeGraphs,
  collaborationAvailability,
  executorReadiness,
  explainFailure,
  type AvailabilityStatus,
} from '../src/client-helpers.js'

const markers: Record<Executor, string> = { codex: 'SOLAR_CODEX_OK', 'claude-code': 'SOLAR_CLAUDE_OK' }

function check(executor: Executor, status: GraphStatus, at: number, node: Partial<NodeSnapshot> = {}): GraphSnapshot {
  return {
    formatVersion: 1,
    graph: { formatVersion: 1, id: `native-check-${executor}-${at}`, label: 'check', cwd: '/tmp/check', maxParallel: 1, nodes: [{ id: 'check', executor, prompt: 'check' }] },
    status,
    revision: 1,
    createdAt: at,
    updatedAt: at + 5,
    nodes: [{ id: 'check', status: status === 'completed' ? 'succeeded' : 'failed', attempt: 1, ...node }],
  }
}

function collaboration(at: number, status: GraphStatus, nodes: readonly { id: string; executor: Executor; status: NodeStatus; error?: string }[]): GraphSnapshot {
  return {
    formatVersion: 1,
    graph: { formatVersion: 1, id: `collab-${at}`, label: 'collab', cwd: '/tmp/work', maxParallel: 2, nodes: nodes.map(node => ({ id: node.id, executor: node.executor, prompt: 'work' })) },
    status,
    revision: 1,
    createdAt: at,
    updatedAt: at + 5,
    nodes: nodes.map(node => node.error === undefined
      ? { id: node.id, status: node.status, attempt: 1 }
      : { id: node.id, status: node.status, attempt: 1, error: { code: 'COMMAND_FAILED', message: node.error } }),
  }
}

const time = (value: number): string => `t${value}`
const tools = (available: boolean) => ['solar_resident', 'solar_delegate', 'solar_coordinate', 'solar_wait'].map(name => ({ name, available }))
const of = (rows: ReturnType<typeof executorReadiness>, executor: Executor) => rows.find(row => row.executor === executor)

describe('collaboration availability', () => {
  it('is usable when the scheduler runs and the three collaboration tools are loaded', () => {
    expect(collaborationAvailability({ resident: { available: true, message: '' }, tools: tools(true) })).toEqual({ usable: true })
  })

  it('names the fix when the scheduler is down', () => {
    const result = collaborationAvailability({ resident: { available: false, message: '' }, tools: tools(true) })
    expect(result.usable).toBe(false)
    expect(result.action).toContain('重新打开')
  })

  it('blocks when a collaboration tool is missing but not when only single delegation is missing', () => {
    const missingWait: AvailabilityStatus = { resident: { available: true, message: '' }, tools: tools(true).map(tool => tool.name === 'solar_wait' ? { ...tool, available: false } : tool) }
    expect(collaborationAvailability(missingWait).usable).toBe(false)
    const missingDelegate: AvailabilityStatus = { resident: { available: true, message: '' }, tools: tools(true).map(tool => tool.name === 'solar_delegate' ? { ...tool, available: false } : tool) }
    expect(collaborationAvailability(missingDelegate).usable).toBe(true)
  })
})

describe('executor readiness', () => {
  it('reports both executors as not yet verified without evidence', () => {
    expect(executorReadiness([], time).map(row => [row.executor, row.state, row.text])).toEqual([
      ['codex', 'untested', '还没验证过'],
      ['claude-code', 'untested', '还没验证过'],
    ])
  })

  it('takes the newest evidence, whether a check or a real collaboration', () => {
    const passedCheck = check('codex', 'completed', 100, { output: markers.codex })
    const realRun = collaboration(300, 'completed', [{ id: 'a', executor: 'codex', status: 'succeeded' }])
    expect(of(executorReadiness([realRun, passedCheck], time), 'codex')).toMatchObject({ state: 'ready', text: '可用 · t305 协同成功' })
    const failedLaterCheck = check('codex', 'failed', 500, { error: { code: 'COMMAND_FAILED', message: 'Codex native turn failed: boom' } })
    expect(of(executorReadiness([realRun, failedLaterCheck, passedCheck], time), 'codex')).toMatchObject({ state: 'failed', text: 't505 失败：boom' })
  })

  it('does not count a check without the exact marker as passed', () => {
    const wrong = check('codex', 'completed', 100, { output: 'something else' })
    expect(of(executorReadiness([wrong], time), 'codex')?.state).toBe('failed')
  })

  it('reads a collaboration node only for its own executor and reports its failure', () => {
    const mixed = collaboration(200, 'failed', [
      { id: 'a', executor: 'codex', status: 'succeeded' },
      { id: 'b', executor: 'claude-code', status: 'failed', error: 'Claude native turn failed: You have hit your weekly limit' },
    ])
    const rows = executorReadiness([mixed], time)
    expect(of(rows, 'codex')).toMatchObject({ state: 'ready', text: '可用 · t205 协同成功' })
    expect(of(rows, 'claude-code')).toMatchObject({ state: 'failed', text: 't205 失败：订阅额度已用完', action: '等额度重置后重新测试。' })
  })

  it('shows a running check as testing', () => {
    expect(of(executorReadiness([check('claude-code', 'running', 100)], time), 'claude-code')).toMatchObject({ state: 'testing', text: '测试中' })
  })

  it('keeps the raw failure only behind a known cause and shows an unknown cause directly', () => {
    const refused = 'Claude native turn failed: API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)'
    const known = of(executorReadiness([check('claude-code', 'failed', 100, { error: { code: 'COMMAND_FAILED', message: refused } })], time), 'claude-code')
    expect(known).toMatchObject({ text: 't105 失败：网络连不上', detail: refused })
    expect(known?.action).toContain('https_proxy')
    const unknown = of(executorReadiness([check('codex', 'failed', 100, { error: { code: 'COMMAND_FAILED', message: 'Codex native turn failed: model returned nothing' } })], time), 'codex')
    expect(unknown).toMatchObject({ text: 't105 失败：model returned nothing' })
    expect(unknown?.action).toBeUndefined()
    expect(unknown?.detail).toBeUndefined()
  })
})

describe('failure explanations', () => {
  it.each([
    ['API Error: Connection refused', '网络连不上'],
    ['connect ECONNREFUSED 127.0.0.1:443', '网络连不上'],
    ["You've hit your weekly limit · resets Oct 21 at 1pm", '订阅额度已用完'],
    ['401 Unauthorized', '登录已失效'],
  ])('explains %s as %s', (message, summary) => {
    const explanation = explainFailure(message)
    expect(explanation.summary).toBe(summary)
    expect(explanation.action).toBeDefined()
  })

  it('keeps an unknown failure as its own text without an action', () => {
    expect(explainFailure('could not generate a separate answer')).toEqual({ summary: 'could not generate a separate answer' })
    expect(explainFailure('')).toEqual({ summary: '执行失败' })
  })
})

describe('active graphs', () => {
  it('lists only graphs that are not settled', () => {
    const done = collaboration(1, 'completed', [{ id: 'a', executor: 'codex', status: 'succeeded' }])
    const live = collaboration(2, 'running', [{ id: 'a', executor: 'codex', status: 'running' }])
    expect(activeGraphs([done, live])).toEqual([live])
  })
})
