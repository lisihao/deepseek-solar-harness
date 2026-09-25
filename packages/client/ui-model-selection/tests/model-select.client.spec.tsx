// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import type { ModelRefreshReport } from '../src/client/service.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('ModelSelect reasoning effort', () => {
  it('renders adapter metadata and submits the effort as part of the session selection', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set(state({ current: selection }))
      return true
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', {
      name: '选择模型，当前 DeepSeek-V4-Flash，推理等级 High',
    })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Off', 'High', 'MaxLargest budget'])

    fireEvent.click(screen.getByRole('menuitemradio', { name: /Max/ }))
    await waitFor(() => {
      expect(select).toHaveBeenCalledWith({
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
      })
      expect(trigger.getAttribute('aria-label')).toBe('选择模型，当前 DeepSeek-V4-Flash，推理等级 Max')
    })
  })

  it('offers provider default only when the adapter does not configure a model default', () => {
    const directory = createSnapshotStore(state({
      groups: [{
        id: 'provider',
        name: 'Provider',
        models: [{
          id: 'model',
          name: 'Model',
          reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
        }],
      }],
      current: { provider: 'provider', model: 'model' },
    }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn()}
      select={vi.fn().mockResolvedValue(true)}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', {
      name: '选择模型，当前 Model，推理等级 Default',
    }))
    fireEvent.click(screen.getByRole('menuitem', { name: /推理等级/ }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent))
      .toEqual(['Default', 'Standard'])
  })

  it('prompts for a selection when the current model is no longer advertised', () => {
    const directory = createSnapshotStore(state({
      current: { provider: 'deepseek-official', model: 'removed-model' },
    }))
    const select = vi.fn().mockResolvedValue(true)
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn()}
      select={select}
      t={t}
    />)

    const trigger = screen.getByRole('button', { name: '选择模型' })
    expect(trigger.textContent).toContain('选择模型')
    fireEvent.click(trigger)
    expect(screen.queryByRole('menuitem', { name: /推理等级/ })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    expect(screen.queryByText('removed-model')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash' })).toBeTruthy()
  })

  it('announces a rejected selection as a transient toast and keeps the in-menu strip for loads', async () => {
    const groups = [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
      ],
    }]
    const directory = createSnapshotStore<ModelDirectoryState>(state({ groups }))
    const select = vi.fn(async () => {
      directory.set(state({ groups, status: 'error', error: 'model-unavailable: session already contains images' }))
      return false
    })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={vi.fn()}
      select={select}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型|当前/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^模型/ }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: /DeepSeek-V4-Pro/ }))
    const toast = await screen.findByRole('alert')
    expect(toast.textContent).toContain('模型操作失败：model-unavailable: session already contains images')
    // The selection failure does not render the in-menu load strip (no Retry).
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
  })

  it('renders no Agent-bound control for an addressed subagent session', () => {
    const load = vi.fn()
    render(<ModelSelect
      locked={false}
      available={false}
      directory={createSnapshotStore(state())}
      refresh={vi.fn()}
      load={load}
      select={vi.fn().mockResolvedValue(false)}
      t={t}
    />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(load).not.toHaveBeenCalled()
  })
})

describe('ModelSelect catalog refresh', () => {
  it('refreshes from the root menu and reports new models and per-catalog failures', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    let finish: ((report: ModelRefreshReport) => void) | undefined
    const refresh = vi.fn(() => new Promise<ModelRefreshReport>((resolve) => { finish = resolve }))
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={refresh}
      select={vi.fn()}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    const item = screen.getByRole<HTMLButtonElement>('menuitem', { name: '刷新模型与算子' })
    fireEvent.click(item)
    expect(refresh).toHaveBeenCalledOnce()
    expect(screen.getByText('正在从服务商和算子拉取最新列表…')).toBeTruthy()
    expect(item.disabled).toBe(true)
    fireEvent.click(item)
    expect(refresh).toHaveBeenCalledOnce()

    finish?.({
      added: ['DeepSeek-V4.1-Flash'],
      lines: [
        { name: 'ChatGPT Web', ok: false, message: 'HTTP 503' },
        { name: '原生算子', ok: true, message: 'Codex 6 个模型' },
        { name: 'Quiet', ok: true },
      ],
    })
    await waitFor(() => { expect(screen.getByText('新增 1 个：DeepSeek-V4.1-Flash')).toBeTruthy() })
    expect(screen.getByText('ChatGPT Web 刷新失败：HTTP 503')).toBeTruthy()
    expect(screen.getByText('原生算子：Codex 6 个模型')).toBeTruthy()
    expect(screen.queryByText(/Quiet/)).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: '刷新模型与算子' }).disabled).toBe(false)
  })

  it('reports an unchanged list and a failed directory refresh', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    const refresh = vi.fn<() => Promise<ModelRefreshReport>>()
      .mockResolvedValueOnce({ added: [], lines: [] })
      .mockResolvedValueOnce({ added: [], directoryError: 'offline', lines: [] })
    render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={refresh}
      select={vi.fn()}
      t={t}
    />)

    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新模型与算子' }))
    await waitFor(() => { expect(screen.getByText('模型列表已是最新')).toBeTruthy() })
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新模型与算子' }))
    await waitFor(() => { expect(screen.getByText('模型目录刷新失败：offline')).toBeTruthy() })
  })

  it('drops a refresh report that settles after unmount', async () => {
    const directory = createSnapshotStore<ModelDirectoryState>(state())
    let finish: ((report: ModelRefreshReport) => void) | undefined
    const view = render(<ModelSelect
      locked={false}
      available
      directory={directory}
      load={vi.fn()}
      refresh={() => new Promise<ModelRefreshReport>((resolve) => { finish = resolve })}
      select={vi.fn()}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: /选择模型/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: '刷新模型与算子' }))
    view.unmount()
    finish?.({ added: [], lines: [] })
    await Promise.resolve()
    expect(screen.queryByText('模型列表已是最新')).toBeNull()
  })
})
