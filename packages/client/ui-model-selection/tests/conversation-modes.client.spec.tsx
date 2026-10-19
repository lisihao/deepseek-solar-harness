// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IApiClient, ModelSelection, RpcResponse, SessionId, SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import { ConversationModes } from '../src/client/ConversationModes.tsx'
import { ModelDirectory } from '../src/client/directory.ts'

afterEach(cleanup)
const ordinary: ModelSelection = { provider: 'deepseek', model: 'ordinary-model', reasoningEffort: 'high' }
const web: ModelSelection = { provider: 'dsh-physical-operator', model: 'chatgpt-web' }
const response = <T,>(value: T): RpcResponse<T> => ({ rpcId: RpcId('modes'), result: { ok: true, value } })

async function fixture(initial = ordinary, priorOrdinary?: ModelSelection, loadInitially = true) {
  let current = initial
  const select = vi.fn<IApiClient['sessions']['selectModel']>(async (request) => {
    current = { provider: request.provider, model: request.model,
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort } }
    return response({ selected: current })
  })
  const models = vi.fn<IApiClient['sessions']['models']>(async () => response<SessionModels>({ current,
    ...priorOrdinary === undefined ? {} : { ordinary: priorOrdinary },
    routable: true, failures: [], groups: [{ id: 'dsh-physical-operator', name: 'Physical operator', models: [
      { id: 'chatgpt-web:account-choice', name: 'Web actual account choice' },
    ] }] }))
  const directory = new ModelDirectory({ models, selectModel: select }, 'session' as SessionId, () => true)
  if (loadInitially) await directory.load()
  const session = { removed: false, running: false }
  const props = { available: true, session, input: { phase: 'plain' }, load: () => {},
    useDirectory: <T,>(selector: (s: ReturnType<typeof directory.store.getSnapshot>) => T) =>
      selector(useSyncExternalStore(fn => directory.store.subscribe(fn), () => directory.store.getSnapshot())),
    selectMode: (mode: 'ordinary' | 'chatgpt') => directory.selectConversationMode(mode),
  } as unknown as Parameters<typeof ConversationModes>[0]
  return { directory, select, models, props, session, hostSelection: () => current,
    acceptThenFail: () => select.mockImplementationOnce(async (request) => {
      current = { provider: request.provider, model: request.model,
        ...request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort } }
      throw new Error('reply lost after Host accepted selection')
    }),
  }
}

describe('composer exclusive conversation modes', () => {
  it('shows an initial directory failure and lets the user retry without selecting or submitting', async () => {
    const f = await fixture(web, ordinary, false)
    f.models.mockRejectedValueOnce(new Error('Host directory unavailable'))
    const load = vi.fn(() => { void f.directory.load().catch(() => {}) })
    render(<ConversationModes {...f.props} load={load} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Host directory unavailable')
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: '重新读取对话模式' })
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).disabled).toBe(true)
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof f.models>>>()
    f.models.mockReturnValueOnce(pending.promise)
    fireEvent.click(retry)
    expect(retry.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe('正在读取对话模式…')
    fireEvent.click(retry)
    expect(f.models).toHaveBeenCalledTimes(2)
    await act(async () => { pending.resolve(response({ current: web, ordinary, routable: true, groups: [], failures: [] })) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: '重新读取对话模式' })).toBeNull()
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '洞察' }).disabled).toBe(true)
    expect(f.select).not.toHaveBeenCalled()
  })
  it('accepts the existing Host adapter default only when no effort was requested', async () => {
    const f = await fixture()
    f.select.mockResolvedValueOnce(response({ selected: { ...web, reasoningEffort: 'website-default' } }))
    await f.directory.selectConversationMode('chatgpt')
    expect(f.directory.store.getSnapshot().current).toEqual({ ...web, reasoningEffort: 'website-default' })
    expect(f.directory.store.getSnapshot().conversationModeError).toBeUndefined()
    f.select.mockResolvedValueOnce(response({ selected: { ...ordinary, reasoningEffort: 'unexpected-effort' } }))
    await expect(f.directory.selectConversationMode('ordinary')).rejects.toThrow('尚未由当前会话确认')
    expect(f.directory.store.getSnapshot().conversationModeError).toContain('尚未由当前会话确认')
  })
  it('keeps a required mode confirmation after the directory is read again', async () => {
    const f = await fixture(web, ordinary, false)
    f.directory.store.update((s) => { s.conversationModeError = 'Explicit mode confirmation required' })
    f.models.mockRejectedValueOnce(new Error('Host directory unavailable'))
    const load = () => { void f.directory.load().catch(() => {}) }
    render(<ConversationModes {...f.props} load={load} />)
    await screen.findByText(/对话模式读取失败/)
    fireEvent.click(screen.getByRole('button', { name: '重新读取对话模式' }))
    await waitFor(() => { expect(screen.queryByText(/对话模式读取失败/)).toBeNull() })
    expect(screen.getByRole('alert').textContent).toBe('Explicit mode confirmation required')
    expect(f.select).not.toHaveBeenCalled()
  })
  it('keeps the known ordinary mode usable when only its advisory directory refresh fails', async () => {
    const f = await fixture()
    f.models.mockRejectedValueOnce(new Error('Advisory directory unavailable'))
    await expect(f.directory.load()).rejects.toThrow('Advisory directory unavailable')
    render(<ConversationModes {...f.props} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '普通对话' }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).disabled).toBe(false)
    expect(screen.queryByText(/对话模式读取失败/)).toBeNull()
    expect(f.select).not.toHaveBeenCalled()
  })
  it.each([['ordinary', ordinary, 'ChatGPT', '普通对话'], ['chatgpt', web, '普通对话', 'ChatGPT']] as const)(
    'reconfirms the checked %s route after the remote route changed but its reply was lost', async (_mode, initial, target, recover) => {
      const f = await fixture(initial, ordinary)
      f.acceptThenFail()
      render(<ConversationModes {...f.props} />)
      fireEvent.click(screen.getByRole('radio', { name: target }))
      expect((await screen.findByRole('alert')).textContent).toContain('reply lost')
      expect(f.hostSelection()).not.toEqual(initial)
      expect(f.directory.store.getSnapshot().current).toEqual(initial)
      fireEvent.click(screen.getByRole('radio', { name: recover }))
      await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
      expect(f.hostSelection()).toEqual(initial)
      expect(f.select).toHaveBeenCalledTimes(2)
    },
  )
  it('restores the Host-retained ordinary selection after a fresh browser directory loads a Web session', async () => {
    const f = await fixture(web, ordinary)
    render(<ConversationModes {...f.props} />)
    fireEvent.click(screen.getByRole('radio', { name: '普通对话' }))
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('radio', { name: '普通对话' }).checked).toBe(true) })
    expect(f.select).toHaveBeenCalledWith({ sessionId: 'session', ...ordinary, persistDefault: false })
  })
  it('uses the existing bare Web route with a real colon-only catalog, then restores the exact ordinary model and effort', async () => {
    const f = await fixture()
    render(<ConversationModes {...f.props} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '普通对话' }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '洞察' }).disabled).toBe(true)
    expect(screen.getByText('暂不可用')).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }))
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).checked).toBe(true) })
    expect(f.select).toHaveBeenLastCalledWith({ sessionId: 'session', ...web, persistDefault: false })
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '普通对话' }).checked).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: '普通对话' }))
    await waitFor(() => { expect(screen.getByRole<HTMLInputElement>('radio', { name: '普通对话' }).checked).toBe(true) })
    expect(f.select).toHaveBeenLastCalledWith({ sessionId: 'session', ...ordinary, persistDefault: false })
  })
  it('keeps the actual old route checked while pending, refuses duplicates, and retains failures for the send block', async () => {
    const f = await fixture(), pending = Promise.withResolvers<Awaited<ReturnType<typeof f.select>>>()
    f.select.mockReturnValueOnce(pending.promise)
    render(<ConversationModes {...f.props} />)
    fireEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }))
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '普通对话' }).checked).toBe(true)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).disabled).toBe(true)
    expect(f.directory.store.getSnapshot().conversationModePending).toBe(true)
    await expect(f.directory.selectConversationMode('ordinary')).rejects.toThrow('正在切换')
    await act(async () => { pending.reject(new Error('fake Web unavailable')) })
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'fake Web unavailable')
    expect(f.directory.store.getSnapshot().current).toEqual(ordinary)
    expect(f.directory.store.getSnapshot().conversationModeError).toBe('fake Web unavailable')
    fireEvent.click(screen.getByRole('radio', { name: '普通对话' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    expect(f.directory.store.getSnapshot().conversationModeError).toBeUndefined()
    expect(f.select).toHaveBeenCalledTimes(2)
  })
  it('restores the Host-reported Web mode on remount and never invents an ordinary model after a fresh page', async () => {
    const f = await fixture(web), view = render(<ConversationModes {...f.props} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).checked).toBe(true)
    view.unmount()
    render(<ConversationModes {...f.props} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).checked).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: '普通对话' }))
    expect((await screen.findByRole('alert')).textContent).toContain('模型菜单中明确选择')
    expect(f.select).not.toHaveBeenCalled()
  })
  it('does not switch during a running turn or route an unfinished insight mode', async () => {
    const f = await fixture(); f.session.running = true
    const view = render(<ConversationModes {...f.props} />)
    fireEvent.click(screen.getByRole('radio', { name: 'ChatGPT' }))
    fireEvent.click(screen.getByRole('radio', { name: '洞察' }))
    expect(f.select).not.toHaveBeenCalled()
    f.session.running = false
    view.rerender(<ConversationModes {...f.props} />)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: 'ChatGPT' }).disabled).toBe(false)
    expect(screen.getByRole<HTMLInputElement>('radio', { name: '洞察' }).disabled).toBe(true)
  })
})
