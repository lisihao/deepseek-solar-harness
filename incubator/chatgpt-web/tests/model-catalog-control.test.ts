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

async function rejectedMessage(value: Promise<unknown>): Promise<string> {
  try {
    await value
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('Expected catalog refresh to reject.')
}

function expectDiagnostic(message: string, stageCode: string, stageLabel: string, browserCode: string, hidden: string): void {
  expect(message).toContain(stageCode)
  expect(message).toContain(`模型目录${stageLabel}失败`)
  expect(message).toContain(`错误码 ${browserCode}`)
  expect(message).not.toContain(hidden)
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
    const message = await rejectedMessage(control.refresh({ modelLabel: 'Gone model' }))
    expectDiagnostic(message, 'WEB_CATALOG_READ_FAILED', '读取', 'WEB_MODEL_SELECTION_UNAVAILABLE', 'not offered')
    expect(await control.read()).toEqual(snapshot)
    expect(browser.finish).toHaveBeenCalledTimes(2)
  })

  it('reports a create-stage code without leaking an adapter message, including generic failures', async () => {
    const first = setup()
    first.browser.create.mockRejectedValueOnce(new WebBrowserError('EGO_TIMEOUT', 'private stderr or page text', false))
    const firstMessage = await rejectedMessage(first.control.refresh({}))
    expectDiagnostic(firstMessage, 'WEB_CATALOG_CREATE_FAILED', '创建目标', 'EGO_TIMEOUT', 'private stderr or page text')
    expect(first.browser.catalog).not.toHaveBeenCalled()
    expect(first.browser.finish).not.toHaveBeenCalled()

    const generic = setup()
    generic.browser.create.mockRejectedValueOnce(new Error('arbitrary internal failure'))
    const genericMessage = await rejectedMessage(generic.control.refresh({}))
    expectDiagnostic(genericMessage, 'WEB_CATALOG_CREATE_FAILED', '创建目标', 'WEB_CATALOG_CREATE_FAILED', 'arbitrary internal failure')

    for (const [unsafeCode, hidden] of [
      [`EGO_${'A'.repeat(97)}`, 'private overlong frame code'],
      ['external_frame_error', 'private external frame code'],
    ] as const) {
      const unsafe = setup()
      unsafe.browser.create.mockRejectedValueOnce(new WebBrowserError(unsafeCode, hidden, false))
      const unsafeMessage = await rejectedMessage(unsafe.control.refresh({}))
      expectDiagnostic(unsafeMessage, 'WEB_CATALOG_CREATE_FAILED', '创建目标', 'WEB_CATALOG_CREATE_FAILED', hidden)
      expect(unsafeMessage).not.toContain(unsafeCode)
    }
  })

  it('keeps a catalog failure and a cleanup failure in one sanitized diagnostic', async () => {
    const { browser, control } = setup()
    browser.catalog.mockRejectedValueOnce(new WebBrowserError('WEB_MODEL_UNKNOWN', 'private page state', false))
    browser.finish.mockRejectedValueOnce(new WebBrowserError('EGO_TIMEOUT', 'private cleanup stderr', false))

    const message = await rejectedMessage(control.refresh({}))

    expectDiagnostic(message, 'WEB_CATALOG_READ_FAILED', '读取', 'WEB_MODEL_UNKNOWN', 'private page state')
    expectDiagnostic(message, 'WEB_CATALOG_CLEANUP_FAILED', '清理目标', 'EGO_TIMEOUT', 'private cleanup stderr')
    expect(browser.finish).toHaveBeenCalledTimes(1)
  })

  it('reports finish-stage failures without reopening or retrying the target', async () => {
    const { browser, control } = setup()
    browser.finish.mockRejectedValueOnce(new WebBrowserError('EGO_OUTPUT_TOO_LARGE', 'private process output', false))

    const message = await rejectedMessage(control.refresh({}))

    expectDiagnostic(message, 'WEB_CATALOG_FINISH_FAILED', '完成并清理', 'EGO_OUTPUT_TOO_LARGE', 'private process output')
    expect(browser.create).toHaveBeenCalledTimes(1)
    expect(browser.catalog).toHaveBeenCalledTimes(1)
    expect(browser.finish).toHaveBeenCalledTimes(1)
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
  it.each([
    ['create', 'WEB_CATALOG_CREATE_FAILED', '创建目标'],
    ['catalog', 'WEB_CATALOG_READ_FAILED', '读取'],
  ] as const)('does not retry or close unknown %s effects', async (operation, stageCode, stageLabel) => {
    const { browser, control } = setup()
    browser[operation].mockRejectedValueOnce(new WebBrowserError('WEB_PROCESS_UNKNOWN', 'unknown private effect', true))
    const message = await rejectedMessage(control.refresh({}))
    expectDiagnostic(message, stageCode, stageLabel, 'WEB_PROCESS_UNKNOWN', 'unknown private effect')
    await expect(control.refresh({})).rejects.toThrow('WEB_CATALOG_OBSERVATION_UNKNOWN')
    expect(browser.create).toHaveBeenCalledTimes(1)
    expect(browser.finish).not.toHaveBeenCalled()
    expect(await control.read()).toBeUndefined()
  })
  it('retains the original page if restoring a temporary selection could not be confirmed', async () => {
    const { browser, control } = setup()
    browser.catalog.mockRejectedValueOnce(new WebBrowserError('WEB_SELECTION_RESTORE_FAILED', 'restore unknown', false))
    const message = await rejectedMessage(control.refresh({}))
    expectDiagnostic(message, 'WEB_CATALOG_READ_FAILED', '读取', 'WEB_SELECTION_RESTORE_FAILED', 'restore unknown')
    await expect(control.refresh({})).rejects.toThrow('WEB_CATALOG_SELECTION_UNKNOWN')
    expect(browser.catalog).toHaveBeenCalledTimes(1)
    expect(browser.finish).not.toHaveBeenCalled()
  })
})
