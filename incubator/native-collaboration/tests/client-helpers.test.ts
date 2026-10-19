import { describe, expect, it } from 'vitest'
import type { GraphSnapshot, GraphStatus } from '@lisihao/dsh-solar-native-resident/contracts'
import {
  availableGraphActions,
  availableGraphActionsForSnapshot,
  canStartNativeCheck,
  canStartGraphControl,
  createControlInput,
  isTerminalGraphStatus,
  nativeCheckGraphId,
  nativeCheckVerdict,
  upsertGraphSnapshot,
} from '../src/client-helpers.js'

function snapshot(status: GraphStatus, revision: number): GraphSnapshot {
  return {
    formatVersion: 1,
    graph: {
      formatVersion: 1,
      id: 'graph-a',
      label: '连接检查',
      cwd: '/tmp/check',
      maxParallel: 1,
      nodes: [],
    },
    status,
    revision,
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
  }
}

function nativeCheck(status: GraphStatus, output: string | undefined): GraphSnapshot {
  return {
    ...snapshot(status, 3),
    graph: {
      formatVersion: 1,
      id: 'native-check-6fd8f7f2-8c28-4d60-b7a3-c19e5b6310ae',
      label: 'Codex 原生连接测试',
      cwd: '/tmp/check',
      maxParallel: 1,
      nodes: [{ id: 'check', executor: 'codex', prompt: 'check' }],
    },
    nodes: [{ id: 'check', status: 'succeeded', attempt: 1, ...(output === undefined ? {} : { output }) }],
  }
}

describe('native collaboration client helpers', () => {
  it('does not let a stale read replace a newer graph response', () => {
    const current = snapshot('running', 8)
    const stale = snapshot('queued', 7)

    expect(upsertGraphSnapshot([current], stale)).toEqual([current])
  })

  it('uses the displayed revision and suppresses repeated graph mutations', () => {
    const current = snapshot('running', 8)

    expect(createControlInput(current, 'pause', 'command-1')).toEqual({
      graphId: 'graph-a',
      commandId: 'command-1',
      expectedRevision: 8,
      action: 'pause',
    })
    expect(canStartGraphControl(current, 'pause', new Set(['graph-a']), new Set())).toBe(false)
    expect(canStartGraphControl(current, 'pause', new Set(), new Set(['graph-a']))).toBe(false)
    expect(canStartGraphControl(current, 'pause', new Set(), new Set())).toBe(true)
  })

  it('offers no controls after cancelling or a terminal result and preserves a test reference', () => {
    expect(availableGraphActions('cancelling')).toEqual([])
    expect(availableGraphActions('completed')).toEqual([])
    expect(availableGraphActions('indeterminate')).toEqual([])
    expect(nativeCheckGraphId('6fd8f7f2-8c28-4d60-b7a3-c19e5b6310ae'))
      .toBe('native-check-6fd8f7f2-8c28-4d60-b7a3-c19e5b6310ae')
  })

  it('keeps an indeterminate graph observable and exposes only cancellation for remaining work', () => {
    const unsettled: GraphSnapshot = {
      ...snapshot('indeterminate', 9),
      nodes: [
        { id: 'unknown', status: 'indeterminate', attempt: 1 },
        { id: 'still-running', status: 'running', attempt: 1 },
        { id: 'waiting', status: 'pending', attempt: 0 },
      ],
    }
    const settled: GraphSnapshot = {
      ...unsettled,
      nodes: [{ id: 'unknown', status: 'indeterminate', attempt: 1 }],
    }

    expect(availableGraphActionsForSnapshot(unsettled)).toEqual(['cancel'])
    expect(createControlInput(unsettled, 'cancel', 'command-2')).toMatchObject({ expectedRevision: 9, action: 'cancel' })
    expect(isTerminalGraphStatus(unsettled)).toBe(false)
    expect(isTerminalGraphStatus(settled)).toBe(true)
  })

  it('keeps an acknowledged or indeterminate native check from starting another check', () => {
    expect(canStartNativeCheck('codex', [nativeCheck('queued', undefined)], new Set(), [])).toBe(false)
    expect(canStartNativeCheck('codex', [nativeCheck('indeterminate', 'SOLAR_CODEX_OK')], new Set(), [])).toBe(false)
    expect(canStartNativeCheck('codex', [], new Set(), [{ executor: 'codex' }])).toBe(false)
    expect(canStartNativeCheck('codex', [nativeCheck('completed', 'SOLAR_CODEX_OK')], new Set(), [])).toBe(true)
  })

  it('requires the exact successful marker before calling a completed native check a pass', () => {
    expect(nativeCheckVerdict(nativeCheck('completed', 'SOLAR_CODEX_OK'))).toMatchObject({ kind: 'passed', label: '连接测试通过' })
    expect(nativeCheckVerdict(nativeCheck('completed', 'SOLAR_CODEX_OK extra'))).toMatchObject({ kind: 'failed' })
    expect(nativeCheckVerdict(nativeCheck('indeterminate', 'SOLAR_CODEX_OK'))).toMatchObject({ kind: 'unconfirmed' })
    expect(nativeCheckVerdict(snapshot('completed', 3))).toBeUndefined()
  })
})
