// A trusted Host authority is only a DNS-rebinding fence, not authentication.
// Anonymous non-loopback Web access therefore remains disconnected even when
// the requested authority is declared by the Server.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  launchWebScaffold, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: trusted Host is not remote authentication', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      remoteAuthority: 'remote.localhost',
      welcomeNoticePending: true,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps anonymous non-loopback clients disconnected and rejects their API', async () => {
    await page.getByText('连接已断开，正在重连…').waitFor({ timeout: 15_000 })
    const status = await page.evaluate(async () => (await fetch('/api/session.list')).status)
    expect(status).toBe(403)
    expect(tripwire.warnings.some(message => message.includes('connection lost'))).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
