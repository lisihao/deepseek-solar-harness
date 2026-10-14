// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopResidentSession } from '../src/contracts.ts'
import { ClosedLaneNotice, recoverResidentSession } from '../src/client/ClosedLaneNotice.tsx'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import { ResidentOperatorsPanel } from '../src/client/ResidentOperatorsPanel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** A rejection whose reason is not an Error, as some transports produce. */
// oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the point is a reason that is not an Error
const rejectWith = (reason: unknown): Promise<never> => new Promise((_resolve, reject) => { reject(reason) })

const TIME = '2026-10-14T10:00:00.000Z'

function closedLane(patch: Partial<DesktopResidentSession> = {}): DesktopResidentSession {
  return {
    sessionId: 'session-1', operatorId: 'codex', workspace: '/workspace', workspaceDisplay: '/workspace', laneId: 'lane-1',
    lifecycle: 'idle', health: 'degraded', healthReason: 'native_outcome_unconfirmed', stateRevision: 7,
    latestTurn: { commandId: 'command-9', turnId: 'turn-9', state: 'indeterminate', taskLabel: 'Fix parser', updatedAt: TIME },
    updatedAt: TIME, ...patch,
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function notice(request: BrowserRequest, options: { localOwner?: boolean; onChanged?: () => void } = {}) {
  return render(<ClosedLaneNotice
    session={closedLane()} localOwner={options.localOwner ?? true} generatedAt={TIME} timeZone="UTC"
    request={request} onChanged={options.onChanged ?? vi.fn()}
  />)
}

describe('closed lane notice', () => {
  it('says what is not known and what the choices do not do, without any internal id', () => {
    notice(vi.fn())
    expect(screen.getByText('这条 lane 已暂停接收新任务')).toBeTruthy()
    expect(screen.getByText(/Fix parser/)).toBeTruthy()
    expect(screen.getByText(/无法确认/)).toBeTruthy()
    expect(screen.getByText(/不会停止 Codex 里可能还在运行的任务，也不会撤销它已经改动的文件/)).toBeTruthy()
    for (const hidden of ['command-9', 'turn-9', 'lane-1', 'session-1', 'native_outcome_unconfirmed']) {
      expect(screen.queryByText(new RegExp(hidden, 'u'))).toBeNull()
    }
  })

  it.each([
    ['我已确认它结束了，恢复这条 lane', 'resolve', /继续使用原来的 Codex 对话/u, '确认恢复'],
    ['重置这条 lane', 'reset', /开启新的 Codex 对话/u, '确认重置'],
  ])('asks for confirmation before %s, then sends the choice and the revision seen', async (button, action, consequence, confirm) => {
    const request = vi.fn(async () => json({ session: closedLane({ health: 'ok' }) })) as unknown as BrowserRequest
    const onChanged = vi.fn()
    notice(request, { onChanged })
    fireEvent.click(screen.getByRole('button', { name: button }))
    expect(request).not.toHaveBeenCalled()
    expect(screen.getByText(consequence)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: confirm }))
    await waitFor(() => { expect(onChanged).toHaveBeenCalledOnce() })
    const [url, init] = vi.mocked(request).mock.calls[0] as unknown as [URL, RequestInit]
    expect(url.pathname).toBe('/api/resident-operators/session-recovery')
    expect(Object.fromEntries(url.searchParams)).toEqual({ session_id: 'session-1', action, revision: '7' })
    expect(init.method).toBe('POST')
  })

  it('names a task without a recorded turn generically and shows no time', () => {
    const { latestTurn: _turn, ...withoutTurn } = closedLane()
    render(<ClosedLaneNotice
      session={withoutTurn} localOwner generatedAt={TIME} timeZone="UTC"
      request={vi.fn()} onChanged={vi.fn()}
    />)
    expect(screen.getByText(/上一条任务「历史任务」在 Codex 里/)).toBeTruthy()
  })

  it('shows a refusal that is not an Error as text', async () => {
    const request = vi.fn(() => rejectWith('connection lost'))
    notice(request)
    fireEvent.click(screen.getByRole('button', { name: '重置这条 lane' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }))
    expect((await screen.findByRole('alert')).textContent).toBe('connection lost')
  })

  it('goes back without a request when the owner cancels', () => {
    const request = vi.fn() as unknown as BrowserRequest
    notice(request)
    fireEvent.click(screen.getByRole('button', { name: '重置这条 lane' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(request).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '重置这条 lane' })).toBeTruthy()
  })

  it('shows the Host\'s readable refusal and asks for a fresh reading', async () => {
    const request = vi.fn(async () => json({ error: 'STATE_CHANGED', message: '这条 lane 的状态已变化，请刷新后再看。' }, 409)) as unknown as BrowserRequest
    const onChanged = vi.fn()
    notice(request, { onChanged })
    fireEvent.click(screen.getByRole('button', { name: '我已确认它结束了，恢复这条 lane' }))
    fireEvent.click(screen.getByRole('button', { name: '确认恢复' }))
    expect((await screen.findByRole('alert')).textContent).toBe('这条 lane 的状态已变化，请刷新后再看。')
    expect(onChanged).toHaveBeenCalledOnce()
  })

  it('uses a generic message when the Host answers something that is not JSON', async () => {
    const request = vi.fn(async () => new Response('gateway down', { status: 502 })) as unknown as BrowserRequest
    await expect(recoverResidentSession(closedLane(), 'reset', request)).rejects.toThrow('没有成功处理这条 lane，请刷新后重试。')
  })

  it('offers guidance instead of buttons on a remote frontend', () => {
    notice(vi.fn(), { localOwner: false })
    expect(screen.getByText('请在运行 DSH 的这台电脑上处理。')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})

describe('Resident panel with a closed lane', () => {
  function panelRequest(sessions: DesktopResidentSession[]): BrowserRequest {
    return vi.fn(async (input: URL | RequestInfo) => (input instanceof URL ? input.pathname : '').endsWith('/cli')
      ? json({ runtimes: [] })
      : json({
        generatedAt: TIME, providers: [], sessions, events: [], activities: [], hiddenDiagnosticSessions: 0, activeWorkers: 0,
      }))
  }

  it('marks the header, and shows the notice only under the closed lane', async () => {
    window.history.replaceState({}, '', '/')
    const healthy = closedLane({ sessionId: 'session-2', laneId: 'lane-2', health: 'ok', stateRevision: 3 })
    delete (healthy as { healthReason?: string }).healthReason
    render(<ResidentOperatorsPanel request={panelRequest([closedLane(), healthy])} />)
    fireEvent.click(screen.getByRole('button', { name: /物理算子/ }))
    expect(await screen.findByText('这条 lane 已暂停接收新任务')).toBeTruthy()
    expect(screen.getAllByText('这条 lane 已暂停接收新任务')).toHaveLength(1)
    // The row of the closed lane says so instead of calling it idle.
    expect(screen.getAllByText('已暂停')).toHaveLength(1)
    expect(screen.getAllByText('空闲')).toHaveLength(1)
    await waitFor(() => {
      const header = screen.getByRole('button', { name: /物理算子：/ })
      expect(header.getAttribute('data-status')).toBe('warn')
      expect(header.getAttribute('aria-label')).toContain('1 条 lane 已暂停')
    })
  })

  it.each([
    ['an Error', () => Promise.reject(new Error('daemon unreachable'))],
    ['text', () => rejectWith('daemon unreachable')],
  ])('reads the panel again after a release, and shows it when that read fails with %s', async (_kind, fail) => {
    window.history.replaceState({}, '', '/')
    let reads = 0
    const request = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const path = input instanceof URL ? input.pathname : ''
      if (path.endsWith('/cli')) return json({ runtimes: [] })
      if (init?.method === 'POST') return json({ session: closedLane({ health: 'ok' }) })
      reads += 1
      if (reads > 1) return fail()
      return json({
        generatedAt: TIME, providers: [], sessions: [closedLane()], events: [], activities: [],
        hiddenDiagnosticSessions: 0, activeWorkers: 0,
      })
    })
    render(<ResidentOperatorsPanel request={request} />)
    fireEvent.click(screen.getByRole('button', { name: /物理算子/ }))
    fireEvent.click(await screen.findByRole('button', { name: '重置这条 lane' }))
    fireEvent.click(screen.getByRole('button', { name: '确认重置' }))
    expect(await screen.findByText(/daemon unreachable/)).toBeTruthy()
    expect(reads).toBeGreaterThan(1)
  })

  it('selects a lane when its row is clicked', async () => {
    window.history.replaceState({}, '', '/')
    const second = closedLane({ sessionId: 'session-2', laneId: 'lane-2', health: 'ok', stateRevision: 3 })
    delete (second as { healthReason?: string }).healthReason
    render(<ResidentOperatorsPanel request={panelRequest([closedLane(), second])} />)
    fireEvent.click(screen.getByRole('button', { name: /物理算子/ }))
    const rows = await screen.findAllByRole('button', { name: /Codex · Fix parser/ })
    fireEvent.click(rows[1]!)
    await waitFor(() => { expect(rows[1]!.getAttribute('data-selected')).toBe('true') })
  })

  it('keeps a remote frontend from releasing the lane', async () => {
    window.history.replaceState({}, '', '/?dsh-deployment-role=frontend')
    render(<ResidentOperatorsPanel request={panelRequest([closedLane()])} />)
    fireEvent.click(screen.getByRole('button', { name: /物理算子/ }))
    expect(await screen.findByText('请在运行 DSH 的这台电脑上处理。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重置这条 lane' })).toBeNull()
  })
})
