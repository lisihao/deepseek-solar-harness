import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogControl } from '../src/model-catalog-control.js'
import type { WebModelCatalog } from '../src/model-catalog.js'
import { WebBrowserError } from '../src/browser-contract.js'

const resource = { spaceId: 17, pageLabel: 'p1' }
const snapshot: WebModelCatalog = {
  formatVersion: 1, observedAt: '2026-10-20T08:00:00.000Z',
  browser: { kind: 'ego-lite', ...resource },
  models: [{ label: 'Future Omega', available: true, selected: true }],
  effortModelLabel: 'Future Omega',
  efforts: [{ label: 'Pro plus', id: 'future-unlimited', index: 7, available: true, selected: true }],
  selected: { modelLabel: 'Future Omega', effortLabel: 'Pro plus', effortId: 'future-unlimited' },
}
function setup() {
  const browser = { create: vi.fn(async () => resource), catalog: vi.fn(async () => snapshot), finish: vi.fn(async () => {}) }
  const busy = vi.fn(async () => false)
  return { browser, busy, control: new ModelCatalogControl(new Context(), browser, busy) }
}

describe('target browser model catalogue', () => {
  it('reads no browser on mount/read and returns a cloned fresh dynamic snapshot only after refresh', async () => {
    const { browser, control } = setup()
    expect(await control.read()).toBeUndefined()
    expect(await control.read()).toBeUndefined()
    expect(browser.create).not.toHaveBeenCalled()
    const result = await control.refresh({ modelLabel: 'Future Omega' })
    expect(result).toEqual(snapshot)
    expect(browser.catalog).toHaveBeenCalledWith(resource, { modelLabel: 'Future Omega' }, expect.any(AbortSignal))
    expect(browser.finish).toHaveBeenCalledWith(resource)
    ;(result.models as unknown as { label: string }[])[0]!.label = 'Chrome selection is unrelated'
    expect((await control.read())?.models[0]?.label).toBe('Future Omega')
    expect(browser.catalog).toHaveBeenCalledTimes(1)
  })
  it('coalesces identical refreshes and refuses a different in-flight selection', async () => {
    const { browser, control } = setup()
    let resolve!: (value: WebModelCatalog) => void
    browser.catalog.mockReturnValueOnce(new Promise(value => { resolve = value }))
    const first = control.refresh({ modelLabel: 'Future Omega' })
    const duplicate = control.refresh({ modelLabel: 'Future Omega' })
    await expect(control.refresh({ modelLabel: 'Other model' })).rejects.toThrow('WEB_CATALOG_BUSY')
    await vi.waitFor(() => expect(browser.catalog).toHaveBeenCalledTimes(1))
    resolve(snapshot)
    expect(await first).toEqual(await duplicate)
    expect(browser.create).toHaveBeenCalledTimes(1)
    expect(browser.finish).toHaveBeenCalledTimes(1)
  })
  it('keeps last successful snapshot when a settled new inspection fails', async () => {
    const { browser, control } = setup()
    await control.refresh({})
    browser.catalog.mockRejectedValueOnce(new WebBrowserError('WEB_MODEL_SELECTION_UNAVAILABLE', 'not offered', false))
    await expect(control.refresh({ modelLabel: 'Gone model' })).rejects.toThrow('not offered')
    expect(await control.read()).toEqual(snapshot)
    expect(browser.finish).toHaveBeenCalledTimes(2)
  })
  it('rejects non-owner and malformed input before browser effects', async () => {
    const { browser, control } = setup()
    const remote = Object.create(control) as ModelCatalogControl
    Object.defineProperty(remote, 'ctx', { value: { invocation: { peer: { principal: { kind: 'guest' } } } } })
    await expect(remote.read()).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(remote.refresh({})).rejects.toThrow('LOCAL_OWNER_REQUIRED')
    await expect(control.refresh({ modelLabel: 'Future', prompt: 'must not be accepted' } as never)).rejects.toThrow()
    expect(browser.create).not.toHaveBeenCalled()
  })
  it('refuses discovery while a known original Web task is unresolved', async () => {
    const { browser, busy, control } = setup()
    busy.mockResolvedValue(true)
    await expect(control.refresh({})).rejects.toThrow('WEB_CATALOG_BUSY')
    expect(browser.create).not.toHaveBeenCalled()
  })
  it.each(['create', 'catalog'] as const)('does not retry or close unknown %s effects', async operation => {
    const { browser, control } = setup()
    browser[operation].mockRejectedValueOnce(new WebBrowserError('WEB_PROCESS_UNKNOWN', 'unknown', true))
    await expect(control.refresh({})).rejects.toThrow('unknown')
    await expect(control.refresh({})).rejects.toThrow('WEB_CATALOG_OBSERVATION_UNKNOWN')
    expect(browser.create).toHaveBeenCalledTimes(1)
    expect(browser.finish).not.toHaveBeenCalled()
    expect(await control.read()).toBeUndefined()
  })
  it('retains the original page if restoring a temporary selection could not be confirmed', async () => {
    const { browser, control } = setup()
    browser.catalog.mockRejectedValueOnce(new WebBrowserError('WEB_SELECTION_RESTORE_FAILED', 'restore unknown', false))
    await expect(control.refresh({})).rejects.toThrow('restore unknown')
    await expect(control.refresh({})).rejects.toThrow('WEB_CATALOG_SELECTION_UNKNOWN')
    expect(browser.catalog).toHaveBeenCalledTimes(1)
    expect(browser.finish).not.toHaveBeenCalled()
  })
})
