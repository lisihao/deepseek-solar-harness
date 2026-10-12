import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents, WebPreferences } from 'electron'

const electron = vi.hoisted(() => {
  const guestSession = {
    getUserAgent: vi.fn(() => 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 DSHDesktop/3.33.0 Chrome/150.0.0.0 Electron/43.4.0 Safari/537.36'),
    setUserAgent: vi.fn(),
  }
  return {
    openExternal: vi.fn(() => Promise.resolve()),
    guestSession,
    fromPartition: vi.fn(() => guestSession),
  }
})
vi.mock('electron', () => ({
  shell: { openExternal: electron.openExternal },
  session: { fromPartition: electron.fromPartition },
}))

const {
  EMBEDDED_WEBVIEW_PARTITION_PREFIX, authorizeEmbeddedWebview, browserUserAgent, guestPopupDecision,
  installEmbeddedWebviewGuard,
} = await import('../src/embedded-webview.ts')

beforeEach(() => {
  electron.openExternal.mockClear()
  electron.fromPartition.mockClear()
  electron.guestSession.setUserAgent.mockClear()
})

describe('browserUserAgent', () => {
  it('drops the Electron and product tokens and keeps the Chromium ones', () => {
    expect(browserUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) DSHDesktop/3.33.0 Chrome/150.0.7871.224 Electron/43.4.0 Safari/537.36'))
      .toBe('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36')
    expect(browserUserAgent('Mozilla/5.0 Chrome/150 Safari/537.36')).toBe('Mozilla/5.0 Chrome/150 Safari/537.36')
  })
})

describe('authorizeEmbeddedWebview', () => {
  const partition = `${EMBEDDED_WEBVIEW_PARTITION_PREFIX}x`

  it('forces an unprivileged guest for a web page in a module partition', () => {
    const preferences: WebPreferences = {
      preload: '/evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false,
      allowRunningInsecureContent: true, nodeIntegrationInSubFrames: true,
    }
    ;(preferences as { preloadURL?: string }).preloadURL = 'file:///evil.js'
    expect(authorizeEmbeddedWebview({ src: 'https://x.com/', partition }, preferences)).toBe(true)
    expect(preferences).toEqual({
      nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false,
    })
  })

  it.each([
    ['a non-web scheme', { src: 'file:///etc/passwd', partition }],
    ['a script URL', { src: 'javascript:alert(1)', partition }],
    ['an unparseable URL', { src: 'not a url', partition }],
    ['embedded credentials', { src: 'https://user:pw@x.com/', partition }],
    ['no partition', { src: 'https://x.com/' }],
    ['a partition outside the module prefix', { src: 'https://x.com/', partition: 'persist:other' }],
    ['a prefix without a module name', { src: 'https://x.com/', partition: EMBEDDED_WEBVIEW_PARTITION_PREFIX }],
    ['a non-persistent partition', { src: 'https://x.com/', partition: 'dsh-remote-x' }],
  ])('refuses %s without touching the preferences', (_name, params) => {
    const preferences: WebPreferences = { preload: '/kept.js' }
    expect(authorizeEmbeddedWebview(params, preferences)).toBe(false)
    expect(preferences).toEqual({ preload: '/kept.js' })
  })
})

describe('guestPopupDecision', () => {
  it('allows web popups, hands mail links to the system, and denies the rest', () => {
    expect(guestPopupDecision('https://accounts.google.com/gsi/')).toBe('allow')
    expect(guestPopupDecision('http://example.com/')).toBe('allow')
    expect(guestPopupDecision('mailto:a@example.com')).toBe('external')
    expect(guestPopupDecision('file:///etc/passwd')).toBe('deny')
    expect(guestPopupDecision('https://user:pw@example.com/')).toBe('deny')
    expect(guestPopupDecision('not a url')).toBe('deny')
  })
})

describe('installEmbeddedWebviewGuard', () => {
  function install() {
    const handlers = new Map<string, (...args: never[]) => void>()
    const contents = { on: vi.fn((event: string, handler: (...args: never[]) => void) => { handlers.set(event, handler) }) }
    installEmbeddedWebviewGuard(contents as unknown as WebContents)
    return handlers
  }

  it('cancels an attach the policy refuses and lets a valid one through', () => {
    const attach = install().get('will-attach-webview') as unknown as (
      event: { preventDefault: () => void }, prefs: WebPreferences, params: { src: string; partition?: string }
    ) => void
    const refused = { preventDefault: vi.fn() }
    attach(refused, {}, { src: 'file:///x' })
    expect(refused.preventDefault).toHaveBeenCalledOnce()
    const refusedNoPartition = { preventDefault: vi.fn() }
    attach(refusedNoPartition, {}, { src: 'https://x.com/' })
    const refusedNoSrc = { preventDefault: vi.fn() }
    attach(refusedNoSrc, {}, {} as { src: string })
    expect(refusedNoSrc.preventDefault).toHaveBeenCalledOnce()
    expect(refusedNoPartition.preventDefault).toHaveBeenCalledOnce()
    expect(electron.fromPartition).not.toHaveBeenCalled()
    const allowed = { preventDefault: vi.fn() }
    attach(allowed, {}, { src: 'https://x.com/', partition: `${EMBEDDED_WEBVIEW_PARTITION_PREFIX}x` })
    expect(allowed.preventDefault).not.toHaveBeenCalled()
    expect(electron.fromPartition).toHaveBeenCalledWith(`${EMBEDDED_WEBVIEW_PARTITION_PREFIX}x`)
    expect(electron.guestSession.setUserAgent).toHaveBeenCalledWith(
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36',
    )
  })

  it('applies the popup policy to the attached guest', async () => {
    const didAttach = install().get('did-attach-webview') as unknown as (
      event: unknown, guest: { setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => void }
    ) => void
    let handler: ((details: { url: string }) => unknown) | undefined
    didAttach({}, { setWindowOpenHandler: (value) => { handler = value } })
    expect(handler?.({ url: 'https://accounts.google.com/' })).toEqual({
      action: 'allow',
      overrideBrowserWindowOptions: {
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      },
    })
    expect(handler?.({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(electron.openExternal).not.toHaveBeenCalled()
    expect(handler?.({ url: 'mailto:a@example.com' })).toEqual({ action: 'deny' })
    expect(electron.openExternal).toHaveBeenCalledWith('mailto:a@example.com')
    electron.openExternal.mockRejectedValueOnce(new Error('no handler'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    handler?.({ url: 'mailto:b@example.com' })
    await vi.waitFor(() => { expect(stderr).toHaveBeenCalledWith(expect.stringContaining('failed to open external link: no handler')) })
    stderr.mockRestore()
  })
})
