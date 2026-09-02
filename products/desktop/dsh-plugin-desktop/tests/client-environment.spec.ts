import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { provideDesktopLayout } from '../src/client/layout-service.ts'
import { parseDesktopClientEnvironment } from '../src/client/environment.ts'
import {
  computeDesktopColumns, DesktopLayoutState, MACOS_SIDEBAR_COLLAPSED, SIDEBAR_COLLAPSED,
} from '../src/client/layout-state.ts'
import { installAdvancedStyles, installSolarBrandStyles } from '../src/client/styles.ts'
import {
  MACOS_DRAG_REGION_HEIGHT,
  MACOS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
} from '../src/window-chrome.ts'

describe('desktop client environment', () => {
  it('accepts the Electron-owned kebab query markers', () => {
    expect(parseDesktopClientEnvironment('?dsh-deployment-role=server&dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1'))
      .toEqual({ deploymentRole: 'server', mode: 'advanced', platform: 'darwin', productVersion: '2.0.1' })
  })

  it.each([
    ['', 'dsh-deployment-role'],
    ['?dsh-deployment-role=worker&dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1', 'dsh-deployment-role'],
    ['?dsh-deployment-role=server&dsh-desktop-mode=glass&dsh-desktop-platform=darwin&dsh-desktop-version=2.0.1', 'dsh-desktop-mode'],
    ['?dsh-deployment-role=server&dsh-desktop-mode=advanced&dsh-desktop-version=2.0.1', 'dsh-desktop-platform'],
    ['?dsh-deployment-role=server&dsh-desktop-mode=advanced&dsh-desktop-platform=android&dsh-desktop-version=2.0.1', 'dsh-desktop-platform'],
    ['?dsh-deployment-role=server&dsh-desktop-mode=advanced&dsh-desktop-platform=darwin', 'dsh-desktop-version'],
    ['?dsh-deployment-role=server&dsh-desktop-mode=advanced&dsh-desktop-platform=darwin&dsh-desktop-version=v2.0.1', 'dsh-desktop-version'],
  ])('fails loud for malformed marker %s', (search, field) => {
    expect(() => parseDesktopClientEnvironment(search)).toThrow(field)
  })
})

describe('advanced desktop layout', () => {
  it('installs only the Desktop-owned product footer styles', () => {
    let css = ''
    const style = {
      dataset: {},
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove: vi.fn(),
    }
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild: vi.fn() },
    })

    try {
      installSolarBrandStyles()
      expect(css).toMatch(/body\[data-dsh-desktop-product-footer="true"\] #root \{ height: calc\(100% - 24px\); \}/)
      expect(css).toMatch(/\.dshDesktopSolarFooter \{[^}]*position: fixed;[^}]*bottom: 0;[^}]*height: 24px;[^}]*white-space: nowrap;/)
      expect(css).not.toContain('.dshDesktopSolarBrand')
      expect(css).not.toContain('.dshDesktopOperatorStrategyPanel')
      expect(css).not.toContain('.dshDesktopResidentPanel')
      expect(css).not.toContain('.dshDesktopOrchestrationPanel')
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('owns native caption geometry without targeting feature headers', () => {
    expect(MACOS_TITLEBAR_HEIGHT).toBe(20)
    expect(MACOS_DRAG_REGION_HEIGHT).toBe(32)
    expect(MACOS_DRAG_REGION_HEIGHT).toBeGreaterThan(MACOS_TITLEBAR_HEIGHT)
    let css = ''
    const remove = vi.fn()
    const style = {
      dataset: {},
      get textContent() { return css },
      set textContent(value: string) { css = value },
      remove,
    }
    const appendChild = vi.fn()
    vi.stubGlobal('document', {
      createElement: () => style,
      head: { appendChild },
    })

    try {
      const dispose = installAdvancedStyles()
      // `dsh-better-sidebar` reserves its fixed right workbench by applying
      // `margin-right: var(--dsh-sidebar-width)` to #root.  A forced
      // `width: 100%` on the same element makes that margin overflow the
      // viewport instead of shrinking the app shell, so the workbench covers
      // third-party settings controls. Keep the document full-size, but leave
      // the mount point's width automatic.
      expect(css).toMatch(/html, body \{[^}]*width:\s*100%;[^}]*height:\s*100%;[^}]*\}/)
      expect(css).toMatch(/#root \{[^}]*width:\s*auto;[^}]*height:\s*100%;[^}]*\}/)
      expect(css).not.toMatch(/html, body, #root \{[^}]*width:\s*100%/)
      expect(css).toMatch(/\.dshDesktopSidebarSurface\s*\{[^}]*--dsw-specific-sidebar-fill:\s*transparent;/)
      expect(css).toMatch(/data-desktop-platform="darwin"\]\[data-sidebar-collapsed\][^{]*\.dshDesktopUpstreamSidebar \{[^}]*width:\s*56px;[^}]*margin:\s*0 auto;/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopUpstreamSidebar \\{[^}]*padding-top: ${MACOS_TITLEBAR_HEIGHT}px;[^}]*-webkit-app-region: no-drag;`))
      expect(css).toContain(`grid-template-rows: ${MACOS_TITLEBAR_HEIGHT}px minmax(0, 1fr)`)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*grid-row: 1 \/ -1;[^}]*-webkit-app-region: no-drag;/)
      expect(css).toMatch(/\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopConversationSurface,\s*\.dshDesktopFrame\[data-desktop-platform="darwin"\] \.dshDesktopDetailsSurface \{ grid-row: 2; \}/)
      expect(css).toMatch(new RegExp(`data-desktop-platform="darwin"\\] \\.dshDesktopSidebarSurface::before \\{[^}]*left: ${MACOS_TRAFFIC_LIGHT_SAFE_WIDTH}px;[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface::before \{[^}]*z-index:/)
      expect(css).toMatch(/\.dshDesktopMacCaptionRow \{[^}]*position: relative;[^}]*grid-column: 2 \/ -1;[^}]*grid-row: 1;/)
      expect(css).toMatch(new RegExp(`\\.dshDesktopMacCaptionRow::before \\{[^}]*height: ${MACOS_DRAG_REGION_HEIGHT}px;[^}]*-webkit-app-region: drag;`))
      expect(css).not.toMatch(/\.dshDesktopMacCaptionRow::before \{[^}]*z-index:/)
      expect(css).not.toMatch(/data-desktop-platform="darwin"\] \.dshDesktopSidebarSurface \{[^}]*-webkit-app-region:\s*drag;/)
      expect(css).not.toContain('[data-phase')
      expect(css).toMatch(/html:has\(\[aria-modal="true"\]\) \.dshDesktopMacCaptionRow::before,[\s\S]*html:has\(\[aria-modal="true"\]\) \.dshDesktopSidebarSurface::before \{ -webkit-app-region: no-drag !important; \}/)
      expect(appendChild).toHaveBeenCalledWith(style)
      dispose()
      expect(remove).toHaveBeenCalledOnce()
    }
    finally {
      vi.unstubAllGlobals()
    }
  })

  it('releases the Cordis layout service with its owning effect', () => {
    let disposed = false
    const ctx = {
      reflect: {
        provide: (name: string, value: unknown) => {
          expect(name).toBe('layout')
          expect(value).toBeInstanceOf(DesktopLayoutState)
          return () => { disposed = true }
        },
      },
    } as unknown as ClientContext

    const dispose = provideDesktopLayout(ctx, new DesktopLayoutState())
    expect(disposed).toBe(false)
    dispose()
    expect(disposed).toBe(true)
  })

  it('uses the compatibility rail and the wider macOS desktop rail', () => {
    expect(computeDesktopColumns(1440, 0, 0)).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1384, details: 0 })
    expect(computeDesktopColumns(1440, 0, 0, MACOS_SIDEBAR_COLLAPSED))
      .toEqual({ sidebar: MACOS_SIDEBAR_COLLAPSED, center: 1350, details: 0 })
    expect(SIDEBAR_COLLAPSED).toBe(56)
    expect(MACOS_SIDEBAR_COLLAPSED).toBe(90)
  })

  it('publishes mirrored panel transitions', () => {
    const layout = new DesktopLayoutState()
    const snapshots: object[] = []
    layout.subscribe(() => { snapshots.push(layout.getSnapshot()) })
    layout.toggleSidebar()
    layout.openDetails()
    layout.closeDetails()
    expect(snapshots).toEqual([
      { sidebar: 0, details: 0, narrow: false, narrowExpanded: false },
      { sidebar: 0, details: 360, narrow: false, narrowExpanded: false },
      { sidebar: 0, details: 0, narrow: false, narrowExpanded: false },
    ])
  })

  it('lets the rail re-expand without losing its wide preference on narrow windows', () => {
    const layout = new DesktopLayoutState()
    layout.setNarrow(true)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: false })
    layout.toggleSidebar()
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: true, narrowExpanded: true })
    layout.setNarrow(false)
    expect(layout.getSnapshot()).toMatchObject({ sidebar: 280, narrow: false, narrowExpanded: false })
  })
})
