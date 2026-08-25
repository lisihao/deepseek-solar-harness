import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyDesktop } from '../src/client/index.ts'
import { mountSolarBrandFooter, solarBrandLabel } from '../src/client/SolarBrand.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Menu: () => null,
  IconChevronDownOutline14: () => null,
}))

describe('Solar desktop branding', () => {
  it('keeps the Desktop product contribution limited to its native footer', () => {
    const registrations: Array<{
      options: { name?: string; id?: string; inject?: (sessionId: string) => unknown }
      component: (props: { wide: boolean }) => unknown
    }> = []
    const slots = {
      inject: vi.fn((_name: string, install: () => unknown) => install()),
      register: vi.fn((options, component) => {
        registrations.push({ options, component })
        return () => {}
      }),
    }
    const effect = vi.fn()
    vi.stubGlobal('window', {
      location: {
        search: '?dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1',
      },
    })

    try {
      const ctx = {
        slots,
        effect,
      } as unknown as ClientContext
      applyDesktop(ctx)
    }
    finally {
      vi.unstubAllGlobals()
    }

    const entry = registrations.find(({ options }) => options.id === 'solar-desktop-brand')
    expect(entry).toBeUndefined()
    expect(registrations).toEqual([])
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'desktop: Solar product footer')
  })

  it('mounts one complete version label in a window-bottom footer', () => {
    const footer = {
      className: '',
      dataset: {} as Record<string, string>,
      setAttribute: vi.fn(),
      title: '',
      textContent: '',
      remove: vi.fn(),
    }
    const body = {
      dataset: {} as Record<string, string>,
      appendChild: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: vi.fn(() => footer),
      body,
    })

    try {
      const dispose = mountSolarBrandFooter('2.6.0')
      const label = solarBrandLabel('2.6.0')
      expect(body.appendChild).toHaveBeenCalledWith(footer)
      expect(body.dataset.dshDesktopProductFooter).toBe('true')
      expect(footer.className).toBe('dshDesktopSolarFooter')
      expect(footer.dataset.testid).toBe('solar-desktop-brand')
      expect(footer.textContent).toBe(label)
      expect(footer.title).toBe(label)
      expect(footer.setAttribute).toHaveBeenCalledWith('aria-label', label)

      dispose()
      expect(footer.remove).toHaveBeenCalledOnce()
      expect(body.dataset.dshDesktopProductFooter).toBeUndefined()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
