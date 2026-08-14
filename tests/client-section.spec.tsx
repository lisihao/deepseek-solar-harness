/**
 * LunaSection component tests with react-test-renderer (no DOM needed): the
 * form loads from `settings.describe` plus the model catalog, prefills the
 * visible legacy target, picks provider/model from the catalog selects,
 * disables writes on read-only or failed loads, submits `settings.update`
 * with the draft patch, recovers from a revision conflict by re-describing,
 * and resets through `settings.mutate`.
 */
import { act, create } from 'react-test-renderer'
import type { ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { LunaSection } from '../src/client/LunaSection.tsx'
import type { LunaSectionProps } from '../src/client/LunaSection.tsx'

const NAMESPACE = {
  ns: 'luna-vision-bridge',
  schema: {},
  value: { providerName: 'Luna Vision Bridge' },
  applies: 'live' as const,
  secrets: [],
  revision: 1,
}

const CATALOG = {
  groups: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
      ],
    },
    {
      id: 'pi-ai',
      name: 'Pi AI',
      models: [{ id: 'pi-coder', name: 'Pi Coder' }],
    },
  ],
  failures: [],
}

const ok = (value: unknown) => ({ result: { ok: true, value } })
const rejected = (message: string, code = 'settings-rejected') => ({
  result: { ok: false, error: { code, message } },
})

function bench(options: {
  writable?: boolean
  describe?: Mock
  update?: Mock
  mutate?: Mock
  models?: Mock
} = {}) {
  const describe = options.describe ?? vi.fn().mockResolvedValue(
    ok({ writable: options.writable ?? true, hasDocument: true, namespaces: [NAMESPACE] }),
  )
  const update = options.update ?? vi.fn().mockResolvedValue(ok(NAMESPACE))
  const mutate = options.mutate ?? vi.fn().mockResolvedValue(ok(NAMESPACE))
  const models = options.models ?? vi.fn().mockResolvedValue(ok(CATALOG))
  return {
    describe,
    update,
    mutate,
    models,
    api: {
      settings: { describe, update, mutate, openDocument: vi.fn(), replace: vi.fn() },
      llm: { models },
    },
  }
}

async function render(api: ReturnType<typeof bench>['api']): Promise<ReactTestRenderer> {
  let root: ReactTestRenderer | undefined
  // The renderer injects the standard runtime seats (useSessions etc.) that
  // the test bench does not carry; the component only uses `api` and `close`.
  const props = { close: () => {}, api } as unknown as LunaSectionProps
  await act(async () => {
    root = create(<LunaSection {...props} />)
  })
  if (root === undefined) throw new Error('render failed')
  return root
}

const textOf = (node: unknown): string => {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  // React elements carry children in `props`, not at the top level.
  const element = node as { props?: { children?: unknown } }
  return element.props === undefined || element.props === null ? '' : textOf(element.props.children)
}

const selectByLabel = (root: ReactTestRenderer, label: string): {
  props: { value: string; disabled?: boolean; onChange: (event: { target: { value: string } }) => void }
} => {
  const select = root.root.findAll(
    node => node.type === 'select' && node.props['aria-label'] === label,
  )[0]
  if (select === undefined) throw new Error(`expected select "${label}"`)
  return { props: select.props as never }
}

function buttons(root: ReactTestRenderer): {
  save: { props: { disabled?: boolean; onClick: () => void } }
  reset: { props: { disabled?: boolean; onClick: () => void } }
} {
  const all = root.root.findAll(
    node => node.type === 'button'
      && (textOf(node.props.children) === '保存' || textOf(node.props.children) === '保存中…' || textOf(node.props.children) === '恢复默认'),
  )
  const save = all.find(node => textOf(node.props.children).startsWith('保存'))
  const reset = all.find(node => textOf(node.props.children) === '恢复默认')
  if (save === undefined || reset === undefined) throw new Error('expected save/reset buttons')
  return {
    save: { props: save.props as { disabled?: boolean; onClick: () => void } },
    reset: { props: reset.props as { disabled?: boolean; onClick: () => void } },
  }
}

function providerNameInput(root: ReactTestRenderer): {
  props: { disabled?: boolean; value: string; onChange: (event: { target: { value: string } }) => void }
} {
  const input = root.root.findAll(
    node => node.type === 'input' && node.props.id === 'luna-provider-name',
  )[0]
  if (input === undefined) throw new Error('expected provider-name input')
  return { props: input.props as never }
}

describe('LunaSection', () => {
  it('renders the prefilled legacy target and the catalog pickers', async () => {
    const benchApi = bench()
    const root = await render(benchApi.api)

    expect(benchApi.describe).toHaveBeenCalledOnce()
    expect(benchApi.models).toHaveBeenCalledOnce()
    // The zero-configuration target is visible, not hidden behind defaults.
    expect(selectByLabel(root, '第 1 行 provider').props.value).toBe('deepseek-official')
    expect(selectByLabel(root, '第 1 行 model').props.value).toBe('deepseek-v4-flash')
    expect(providerNameInput(root).props.value).toBe('Luna Vision Bridge')
    expect(buttons(root).save.props.disabled).not.toBe(true)
  })

  it('picks a different provider and model from the catalog and saves them', async () => {
    const benchApi = bench()
    const root = await render(benchApi.api)

    await act(async () => {
      selectByLabel(root, '第 1 行 provider').props.onChange({ target: { value: 'pi-ai' } })
    })
    // Switching the provider resets the model so a stale choice cannot leak.
    expect(selectByLabel(root, '第 1 行 model').props.value).toBe('')
    await act(async () => {
      selectByLabel(root, '第 1 行 model').props.onChange({ target: { value: 'pi-coder' } })
    })
    await act(async () => {
      buttons(root).save.props.onClick()
    })

    expect(benchApi.update).toHaveBeenCalledOnce()
    expect(benchApi.update.mock.calls[0]?.[0]).toMatchObject({
      ns: 'luna-vision-bridge',
      expectedRevision: 1,
      patch: {
        providerName: 'Luna Vision Bridge',
        targets: [{ provider: 'pi-ai', model: 'pi-coder' }],
      },
    })
  })

  it('filters the model options by the selected provider', async () => {
    const benchApi = bench()
    const root = await render(benchApi.api)

    const optionTexts = (label: string): string[] => {
      const select = root.root.findAll(
        node => node.type === 'select' && node.props['aria-label'] === label,
      )[0]
      if (select === undefined) return []
      return select.findAll(node => node.type === 'option').map(option => textOf(option.props.children))
    }
    expect(optionTexts('第 1 行 model')).toEqual(['选择模型…', 'DeepSeek V4 Flash', 'DeepSeek V4 Pro'])
    await act(async () => {
      selectByLabel(root, '第 1 行 provider').props.onChange({ target: { value: 'pi-ai' } })
    })
    expect(optionTexts('第 1 行 model')).toEqual(['选择模型…', 'Pi Coder'])
  })

  it('degrades the pickers to manual inputs when the model catalog is unavailable', async () => {
    const benchApi = bench({
      models: vi.fn().mockResolvedValue({ result: { ok: false, error: { code: 'catalog-down', message: 'catalog down' } } }),
    })
    const root = await render(benchApi.api)

    const provider = root.root.findAll(node => node.props['aria-label'] === '第 1 行 provider')[0]
    expect(provider?.type).toBe('input')
    await act(async () => {
      (provider?.props as { onChange: (event: { target: { value: string } }) => void }).onChange({ target: { value: 'custom-provider' } })
    })
    // With a provider chosen but no catalog, the model field degrades too.
    const model = root.root.findAll(node => node.props['aria-label'] === '第 1 行 model')[0]
    expect(model?.type).toBe('input')
    expect((model?.props as { value: string }).value).toBe('')
  })

  it('shows a describe business failure and disables every write control', async () => {
    const benchApi = bench({ describe: vi.fn().mockResolvedValue(rejected('settings exploded')) })
    const root = await render(benchApi.api)

    expect(root.root.findAll(node => node.type === 'p').some(node => textOf(node.props.children).includes('settings exploded'))).toBe(true)
    expect(buttons(root).save.props.disabled).toBe(true)
    expect(providerNameInput(root).props.disabled).toBe(true)
  })

  it('disables writes when the namespace is missing', async () => {
    const benchApi = bench({ describe: vi.fn().mockResolvedValue(ok({ writable: true, hasDocument: true, namespaces: [] })) })
    const root = await render(benchApi.api)

    expect(root.root.findAll(node => node.type === 'p').some(node => textOf(node.props.children).includes('尚未注册'))).toBe(true)
    expect(buttons(root).save.props.disabled).toBe(true)
  })

  it('disables writes when the settings provider is read-only', async () => {
    const benchApi = bench({ writable: false })
    const root = await render(benchApi.api)

    expect(root.root.findAll(node => node.type === 'p').some(node => textOf(node.props.children).includes('只读'))).toBe(true)
    expect(buttons(root).save.props.disabled).toBe(true)
    expect(buttons(root).reset.props.disabled).toBe(true)
    expect(providerNameInput(root).props.disabled).toBe(true)
  })

  it('recovers from a settings conflict by re-describing while keeping the draft', async () => {
    const benchApi = bench({
      update: vi.fn().mockResolvedValue(rejected('stale revision', 'settings-conflict')),
    })
    const root = await render(benchApi.api)

    await act(async () => {
      providerNameInput(root).props.onChange({ target: { value: 'Kept Draft' } })
    })
    await act(async () => {
      buttons(root).save.props.onClick()
    })

    expect(benchApi.describe).toHaveBeenCalledTimes(2)
    expect(providerNameInput(root).props.value).toBe('Kept Draft')
    expect(root.root.findAll(node => node.type === 'p').some(node => textOf(node.props.children).includes('已被其他窗口修改'))).toBe(true)
  })

  it('resets through settings.mutate unset ops', async () => {
    const benchApi = bench()
    const root = await render(benchApi.api)

    await act(async () => {
      buttons(root).reset.props.onClick()
    })

    expect(benchApi.mutate).toHaveBeenCalledOnce()
    expect(benchApi.mutate.mock.calls[0]?.[0]).toMatchObject({
      ns: 'luna-vision-bridge',
      expectedRevision: 1,
      ops: [
        { op: 'unset', path: ['providerName'] },
        { op: 'unset', path: ['targets'] },
      ],
    })
  })
})
