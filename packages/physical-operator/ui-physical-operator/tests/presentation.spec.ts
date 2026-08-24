import { describe, expect, it } from 'vitest'
import type { DesktopResidentEvent } from '../src/contracts.ts'
import {
  buildResidentActivities,
  formatResidentTimestamp,
  isDiagnosticResidentWorkspace,
} from '../src/presentation.ts'

describe('Resident Operator user-facing presentation', () => {
  it('renders an unambiguous browser-local timestamp with relative age', () => {
    expect(formatResidentTimestamp(
      '2026-08-16T23:18:28.617Z',
      '2026-08-17T01:05:03.000Z',
      'America/Toronto',
    )).toEqual({
      absolute: '今天 19:18:28 GMT-4',
      relative: '1 小时 46 分钟前',
    })
  })

  it('collapses one turn event burst into one meaningful task activity', () => {
    const events: DesktopResidentEvent[] = [
      event(1, 'turn.accepted', '2026-08-16T23:09:21.417Z', {
        commandId: 'command-1', turnId: 'turn-1', taskLabel: '分析美国排华法案',
      }),
      event(2, 'turn.running', '2026-08-16T23:09:21.418Z', { commandId: 'command-1', turnId: 'turn-1' }),
      event(3, 'turn.progress', '2026-08-16T23:09:21.546Z', {
        commandId: 'command-1', turnId: 'turn-1', phase: 'reasoning',
      }),
      event(4, 'turn.settled', '2026-08-16T23:18:28.617Z', {
        commandId: 'command-1', turnId: 'turn-1', stopReason: 'completed',
      }),
    ]

    expect(buildResidentActivities(events)).toEqual([{
      commandId: 'command-1',
      turnId: 'turn-1',
      taskLabel: '分析美国排华法案',
      status: 'completed',
      startedAt: '2026-08-16T23:09:21.417Z',
      updatedAt: '2026-08-16T23:18:28.617Z',
    }])
  })

  it('labels legacy turns honestly and identifies only known diagnostic workspaces', () => {
    expect(buildResidentActivities([
      event(1, 'turn.accepted', '2026-08-16T10:00:00.000Z', { commandId: 'legacy', turnId: 'turn-old' }),
      event(2, 'turn.indeterminate', '2026-08-16T10:01:00.000Z', { commandId: 'legacy', turnId: 'turn-old' }),
    ])[0]).toMatchObject({ taskLabel: '历史任务（升级前未记录摘要）', status: 'indeterminate' })
    expect(isDiagnosticResidentWorkspace('/Users/me/.dsh/artifacts/resident-dev-canary/workspace')).toBe(true)
    expect(isDiagnosticResidentWorkspace('/tmp/dsh-resident-acceptance/workspace')).toBe(true)
    expect(isDiagnosticResidentWorkspace('/Users/me/Projects/AI4Research')).toBe(false)
  })
})

function event(
  sequence: number,
  type: string,
  time: string,
  data: Record<string, unknown>,
): DesktopResidentEvent {
  return { sequence, type, time, data }
}
