/** Hardening for the `<webview>` panes that Remote Modules open for `direct` instances. */

import { shell } from 'electron'
import type { WebContents, WebPreferences } from 'electron'

/**
 * Partition prefix every embedded pane must use. `persist:` keeps the site's cookies across restarts,
 * and one partition per module keeps one module's login away from the DSH window and from other modules.
 */
export const EMBEDDED_WEBVIEW_PARTITION_PREFIX = 'persist:dsh-remote-'

/** Attach parameters the renderer requested for a `<webview>`. */
export interface EmbeddedWebviewParams {
  src: string
  partition?: string
}

function isCredentialFreeWebUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

/**
 * Decide whether a requested `<webview>` may attach and force its preferences to an unprivileged guest.
 * @param params - `src` and `partition` the renderer set on the element.
 * @param webPreferences - guest preferences Electron is about to use; mutated when the request is allowed.
 * @returns `true` when the guest may attach. The guest then has no preload and no Node.js, runs sandboxed
 *   with web security on, and uses a module-owned persistent partition.
 */
export function authorizeEmbeddedWebview(params: EmbeddedWebviewParams, webPreferences: WebPreferences): boolean {
  if (!isCredentialFreeWebUrl(params.src)) return false
  const partition = params.partition
  if (partition === undefined || !partition.startsWith(EMBEDDED_WEBVIEW_PARTITION_PREFIX)
    || partition.length === EMBEDDED_WEBVIEW_PARTITION_PREFIX.length) return false
  delete webPreferences.preload
  delete (webPreferences as { preloadURL?: string }).preloadURL
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  return true
}

/**
 * Decide what a guest page's `window.open` does. Sign-in flows such as Google or Apple open a popup that
 * reports back to its opener, so web popups open as unprivileged windows in the guest's partition;
 * mail links go to the system handler; everything else is denied.
 * @param url - destination requested by the guest page.
 * @returns `allow` with hardened window options, `external` for the system handler, or `deny`.
 */
export function guestPopupDecision(url: string): 'allow' | 'external' | 'deny' {
  try {
    const target = new URL(url)
    if (isCredentialFreeWebUrl(url)) return 'allow'
    if (target.protocol === 'mailto:') return 'external'
  } catch {
    // An unparseable destination is denied like any other unsupported scheme.
    return 'deny'
  }
  return 'deny'
}

/**
 * Install the attach guard on the DSH window.
 * @param contents - the DSH window's web contents that hosts `<webview>` elements.
 */
export function installEmbeddedWebviewGuard(contents: WebContents): void {
  contents.on('will-attach-webview', (event, webPreferences, params) => {
    // Electron types the attach parameters as a string record; an absent `src` becomes '' and is refused.
    const partition = params['partition']
    if (!authorizeEmbeddedWebview(
      { src: params['src'] ?? '', ...(partition === undefined ? {} : { partition }) },
      webPreferences,
    )) event.preventDefault()
  })
  contents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      const decision = guestPopupDecision(url)
      if (decision === 'external') {
        void shell.openExternal(url).catch((cause: unknown) => {
          process.stderr.write(`dsh-plugin-desktop: failed to open external link: ${cause instanceof Error ? cause.message : String(cause)}\n`)
        })
      }
      return decision === 'allow'
        ? {
          action: 'allow',
          overrideBrowserWindowOptions: {
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
          },
        }
        : { action: 'deny' }
    })
  })
}
