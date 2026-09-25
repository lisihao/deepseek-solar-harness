// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopResidentCliRuntime } from '../src/contracts.ts'
import { CliRuntimesSection } from '../src/client/CliRuntimes.tsx'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

const OUTDATED: DesktopResidentCliRuntime[] = [
  { product: 'claude-code', currentVersion: '2.1.239', latestVersion: '2.1.281', updateAvailable: true, managed: false },
  { product: 'codex', currentVersion: '0.149.1', latestVersion: '0.156.1', updateAvailable: true, managed: false },
]

describe('native CLI runtime section', () => {
  it('recommends newer CLIs, activates a verified update, and refreshes provider status', async () => {
    let runtimes = OUTDATED
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect((input as URL).searchParams.get('product')).toBe('claude-code')
        runtimes = [{ ...OUTDATED[0]!, currentVersion: '2.1.281', updateAvailable: false, managed: true }, OUTDATED[1]!]
        return json({ product: 'claude-code', version: '2.1.281', status: 'activated' })
      }
      return json({ runtimes })
    }) as BrowserRequest
    const onUpdated = vi.fn()
    render(<CliRuntimesSection request={request} localOwner onUpdated={onUpdated} />)

    expect(await screen.findByText('当前 2.1.239 · 最新 2.1.281')).toBeTruthy()
    expect(screen.getByText(/会中断正在运行的 Codex 任务/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '验证并更新到 2.1.281' }))
    expect(await screen.findByText('Claude Code 已切换到 2.1.281，下一次任务起生效，无需重启 DSH。')).toBeTruthy()
    expect(onUpdated).toHaveBeenCalledOnce()
    expect(await screen.findByText('Claude Code · DSH 托管')).toBeTruthy()
  })

  it('keeps the running CLI when the candidate fails DSH qualification', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
      ? json({ product: 'codex', version: '0.156.1', status: 'incompatible', reason: 'lacks turn/interrupt' })
      : json({ runtimes: OUTDATED })) as BrowserRequest
    const onUpdated = vi.fn()
    render(<CliRuntimesSection request={request} localOwner onUpdated={onUpdated} />)
    fireEvent.click(await screen.findByRole('button', { name: '验证并更新到 0.156.1' }))
    expect(await screen.findByText('Codex 0.156.1 未通过 DSH 兼容验证，继续使用 0.149.1，需等待 DSH 适配：lacks turn/interrupt')).toBeTruthy()
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('shows Host failures, missing installs, and remote-only guidance', async () => {
    let fail = true
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response('plain failure', { status: 503 })
      if (fail) return json({ error: 'RESIDENT_CLI_UNAVAILABLE', message: 'registry offline' }, 503)
      return json({ runtimes: [
        { product: 'claude-code', updateAvailable: false, managed: false, error: 'claude was not found' },
        { product: 'codex', currentVersion: '0.149.1', latestVersion: '0.156.1', updateAvailable: true, managed: false },
      ] })
    }) as BrowserRequest
    const view = render(<CliRuntimesSection request={request} localOwner onUpdated={vi.fn()} />)
    expect(await screen.findByText('原生 CLI 操作失败（503）：registry offline')).toBeTruthy()
    fail = false
    fireEvent.click(screen.getByRole('button', { name: '检查更新' }))
    expect(await screen.findByText('当前 未安装 · 最新 未知')).toBeTruthy()
    expect(screen.getByText('claude was not found')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '验证并更新到 0.156.1' }))
    expect(await screen.findByText('原生 CLI 操作失败（503）：plain failure')).toBeTruthy()

    view.unmount()
    render(<CliRuntimesSection request={request} localOwner={false} onUpdated={vi.fn()} />)
    expect(await screen.findByText('请在服务器本机更新')).toBeTruthy()
    await waitFor(() => { expect(screen.queryByRole('button', { name: /验证并更新/ })).toBeNull() })
  })
})
