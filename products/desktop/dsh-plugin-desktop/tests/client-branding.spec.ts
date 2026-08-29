import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as applyDesktop } from '../src/client/index.ts'
import { CONFIGURE_DEPLOYMENT_URL, mountSolarBrandFooter, solarBrandLabel, USE_LOCAL_SERVER_URL } from '../src/client/SolarBrand.tsx'

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
        search: '?dsh-deployment-role=server&dsh-desktop-mode=compatibility&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1',
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
    const marker = { className: '', textContent: '' }
    const buttons: Array<{
      type: string
      className: string
      dataset: Record<string, string>
      textContent: string
      title: string
      addEventListener: ReturnType<typeof vi.fn>
    }> = []
    const footer = {
      className: '',
      dataset: {} as Record<string, string>,
      setAttribute: vi.fn(),
      title: '',
      appendChild: vi.fn(),
      remove: vi.fn(),
    }
    const body = {
      dataset: {} as Record<string, string>,
      appendChild: vi.fn(),
    }
    const assign = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'footer') return footer
        if (tag !== 'button') return marker
        const button = {
          type: '', className: '', dataset: {} as Record<string, string>, textContent: '', title: '', addEventListener: vi.fn(),
        }
        buttons.push(button)
        return button
      }),
      body,
    })
    vi.stubGlobal('window', { location: { assign } })

    try {
      const dispose = mountSolarBrandFooter({
        deploymentRole: 'frontend', mode: 'compatibility', platform: 'darwin', productVersion: '2.6.0',
      })
      const label = solarBrandLabel('2.6.0')
      expect(body.appendChild).toHaveBeenCalledWith(footer)
      expect(body.dataset.dshDesktopProductFooter).toBe('true')
      expect(footer.className).toBe('dshDesktopSolarFooter')
      expect(footer.dataset.testid).toBe('solar-desktop-brand')
      expect(marker.textContent).toBe(label)
      expect(footer.title).toBe(label)
      expect(footer.setAttribute).toHaveBeenCalledWith('aria-label', label)
      expect(footer.appendChild).toHaveBeenNthCalledWith(1, marker)
      const [configure, useLocal] = buttons
      if (configure === undefined || useLocal === undefined) throw new Error('expected two Frontend deployment buttons')
      expect(footer.appendChild).toHaveBeenNthCalledWith(2, configure)
      expect(footer.appendChild).toHaveBeenNthCalledWith(3, useLocal)
      expect(configure?.textContent).toBe('部署 / 同步')
      expect(useLocal.textContent).toBe('切换到本地 Server')
      const configureClick = configure?.addEventListener.mock.calls[0]?.[1] as (() => void)
      const useLocalClick = useLocal.addEventListener.mock.calls[0]?.[1] as (() => void)
      configureClick()
      expect(assign).toHaveBeenCalledWith(CONFIGURE_DEPLOYMENT_URL)
      useLocalClick()
      expect(assign).toHaveBeenCalledWith(USE_LOCAL_SERVER_URL)

      dispose()
      expect(footer.remove).toHaveBeenCalledOnce()
      expect(body.dataset.dshDesktopProductFooter).toBeUndefined()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps remote Server configuration visible while the Desktop uses its local Server', () => {
    const marker = { className: '', textContent: '' }
    const buttons: Array<{
      type: string
      className: string
      dataset: Record<string, string>
      textContent: string
      title: string
      addEventListener: ReturnType<typeof vi.fn>
    }> = []
    const footer = {
      className: '', dataset: {} as Record<string, string>, setAttribute: vi.fn(), title: '', appendChild: vi.fn(), remove: vi.fn(),
    }
    const body = { dataset: {} as Record<string, string>, appendChild: vi.fn() }
    const assign = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'footer') return footer
        if (tag !== 'button') return marker
        const button = {
          type: '', className: '', dataset: {} as Record<string, string>, textContent: '', title: '', addEventListener: vi.fn(),
        }
        buttons.push(button)
        return button
      }),
      body,
    })
    vi.stubGlobal('window', { location: { assign } })

    try {
      const dispose = mountSolarBrandFooter({
        deploymentRole: 'server', mode: 'compatibility', platform: 'darwin', productVersion: '3.7.0',
      })
      expect(buttons).toHaveLength(1)
      const [configure] = buttons
      if (configure === undefined) throw new Error('expected local Server deployment button')
      expect(configure.textContent).toBe('连接远程 Server')
      expect(configure.dataset.testid).toBe('desktop-configure-deployment')
      const configureClick = configure.addEventListener.mock.calls[0]?.[1] as (() => void)
      configureClick()
      expect(assign).toHaveBeenCalledWith(CONFIGURE_DEPLOYMENT_URL)
      dispose()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })
})
