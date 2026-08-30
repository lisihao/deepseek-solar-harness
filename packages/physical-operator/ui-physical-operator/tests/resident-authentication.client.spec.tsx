// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserRequest } from '../src/client/ResidentOperatorsPanel.tsx'
import { ResidentOperatorsPanel } from '../src/client/ResidentOperatorsPanel.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Resident owner authentication UI', () => {
  it('shows a callback-listener failure and opens no replacement login until another click', async () => {
    window.history.replaceState({}, '', '/')
    let loginAttempts = 0
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        loginAttempts += 1
        return new Response(JSON.stringify({
          error: 'RESIDENT_AUTHENTICATION_FAILED',
          reason: 'callback_listener_missing',
          message: 'Claude Code subscription login failed: callback listener refused the connection',
        }), { status: 503, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        generatedAt: '2026-08-30T03:00:00.000Z',
        providers: [{
          operatorId: 'claude-code',
          product: 'claude-code',
          displayName: 'Claude Code',
          description: 'Persistent Claude Code',
          tags: ['subscription'],
          maxConcurrency: 4,
          injectionBoundaries: ['pre-dispatch', 'next-turn'],
          available: false,
          unavailableReason: 'subscription login required',
          authentication: 'unqualified',
          supportsExplicitAuthentication: true,
          productVersion: 'test',
          models: [],
        }],
        sessions: [],
        events: [],
        activities: [],
        hiddenDiagnosticSessions: 0,
        activeWorkers: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as BrowserRequest

    render(<ResidentOperatorsPanel request={request} />)
    fireEvent.click(await screen.findByRole('button', { name: /物理算子/ }))
    fireEvent.click(await screen.findByRole('button', { name: '登录 Claude Code' }))

    expect(await screen.findByText(/登录回调监听器已经结束或不可达/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试登录 Claude Code' })).toBeTruthy()
    expect(loginAttempts).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(loginAttempts).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: '重试登录 Claude Code' }))
    await waitFor(() => { expect(loginAttempts).toBe(2) })
  })
})
