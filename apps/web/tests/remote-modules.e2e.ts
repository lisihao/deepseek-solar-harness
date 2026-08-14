// Real-composition browser coverage for configurable embedded Web page instances.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./remote-modules.overlay.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/remote-modules', import.meta.url))
const SIDEBAR_EXPECTED = join(SNAPSHOT_DIR, 'sidebar.expected.md')
const MODE = webSnapshotMode()

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => { resolve() })
    server.closeAllConnections()
  })
}

describe('web e2e: configurable remote Web pages', () => {
  let genesis: Server
  let thunder: Server
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const originalGenesis = process.env.DSH_E2E_GENESISPOD_PAGE
  const originalThunder = process.env.DSH_E2E_THUNDEROMLX_PAGE

  beforeAll(async () => {
    genesis = createServer((req, res) => {
      if (req.url === '/genesis-app.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' })
        res.end("document.querySelector('[data-runtime]').textContent = 'Genesis runtime active'")
        return
      }
      if (req.url !== '/') { res.writeHead(404); res.end(); return }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self'; script-src 'self'; frame-ancestors 'self'",
      })
      res.end('<!doctype html><title>GenesisPod Application</title><main><h1>GenesisPod Full Application</h1><p data-runtime>booting</p><script src="/genesis-app.js"></script></main>')
    })
    thunder = createServer((req, res) => {
      if (req.url !== '/docs') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>ThunderOMLX Documentation</title><main><h1>ThunderOMLX Service UI</h1><button>Load model</button></main>')
    })
    process.env.DSH_E2E_GENESISPOD_PAGE = await listen(genesis)
    process.env.DSH_E2E_THUNDEROMLX_PAGE = `${await listen(thunder)}/docs`
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await closeServer(genesis).catch((error: unknown) => failures.push(error))
    await closeServer(thunder).catch((error: unknown) => failures.push(error))
    if (originalGenesis === undefined) Reflect.deleteProperty(process.env, 'DSH_E2E_GENESISPOD_PAGE')
    else process.env.DSH_E2E_GENESISPOD_PAGE = originalGenesis
    if (originalThunder === undefined) Reflect.deleteProperty(process.env, 'DSH_E2E_THUNDEROMLX_PAGE')
    else process.env.DSH_E2E_THUNDEROMLX_PAGE = originalThunder
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'remote Web pages e2e cleanup failed')
  })

  it('stacks configured instances and renders each target application inside its iframe', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-remote-webpages'))
    const genesisButton = page.getByRole('button', { name: 'GenesisPod', exact: true })
    const thunderButton = page.getByRole('button', { name: 'ThunderOMLX', exact: true })
    await Promise.all([genesisButton.waitFor(), thunderButton.waitFor()])
    const stack = page.getByTestId('remote-webpages-sidebar-stack')
    expect(await stack.evaluate(node => getComputedStyle(node).flexDirection)).toBe('column')
    const genesisBox = await genesisButton.boundingBox()
    const thunderBox = await thunderButton.boundingBox()
    expect(genesisBox).not.toBeNull()
    expect(thunderBox).not.toBeNull()
    expect(Math.abs(genesisBox!.x - thunderBox!.x)).toBeLessThan(1)
    expect(thunderBox!.y).toBeGreaterThanOrEqual(genesisBox!.y + genesisBox!.height - 1)
    await compareOrRefreshGolden(
      SIDEBAR_EXPECTED,
      await captureStableAria(page, '[class*="footArea"]', scaffold.workspaceCwd),
      MODE,
    )

    await genesisButton.click()
    const genesisDialog = page.getByRole('dialog', { name: 'GenesisPod' })
    await genesisDialog.waitFor()
    const genesisFrame = page.frameLocator('[data-testid="remote-webpage-frame-genesispod"]')
    await genesisFrame.getByRole('heading', { name: 'GenesisPod Full Application' }).waitFor({ timeout: 10_000 })
    await genesisFrame.getByText('Genesis runtime active').waitFor()
    expect(await genesisDialog.locator('iframe').count()).toBe(1)
    expect(await genesisDialog.getByText('服务状态').count()).toBe(0)
    await genesisDialog.getByRole('button', { name: '关闭 GenesisPod' }).click()

    await thunderButton.click()
    const thunderDialog = page.getByRole('dialog', { name: 'ThunderOMLX' })
    await thunderDialog.waitFor()
    const thunderFrame = page.frameLocator('[data-testid="remote-webpage-frame-thunder-omlx"]')
    await thunderFrame.getByRole('heading', { name: 'ThunderOMLX Service UI' }).waitFor({ timeout: 10_000 })
    await thunderFrame.getByRole('button', { name: 'Load model' }).waitFor()
    expect(await thunderDialog.locator('iframe').count()).toBe(1)
    await thunderDialog.getByRole('button', { name: '关闭 ThunderOMLX' }).click()

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settingsDialog = page.getByRole('dialog', { name: 'Settings' })
    await settingsDialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await settingsDialog.getByRole('tab', { name: 'Remote Modules', exact: true }).click()
    const displayNames = settingsDialog.getByLabel('Display name', { exact: true })
    await displayNames.first().waitFor()
    expect(await displayNames.count()).toBe(2)
    expect(await displayNames.nth(0).inputValue()).toBe('GenesisPod')
    expect(await displayNames.nth(1).inputValue()).toBe('ThunderOMLX')
    expect(await settingsDialog.getByText('Target Web page', { exact: true }).count()).toBe(2)
    expect(await settingsDialog.getByText('Local relay port', { exact: true }).count()).toBe(2)
    expect(await settingsDialog.getByText('Sidebar order', { exact: true }).count()).toBe(2)
    await settingsDialog.getByRole('button', { name: 'Add module' }).click()
    await displayNames.nth(2).waitFor()
    expect(await displayNames.nth(2).inputValue()).toBe('Web page 3')
    await settingsDialog.getByRole('button', { name: 'Discard changes' }).click()
    expect(await displayNames.count()).toBe(2)

    const roster = await page.request.get(`${scaffold.baseUrl}/remote-webpages/v1/instances`)
    expect(roster.status()).toBe(200)
    expect((await roster.json() as { instances: unknown[] }).instances).toHaveLength(2)
    expect({ pageErrors: tripwire.pageErrors, warnings: tripwire.warnings }).toEqual({
      pageErrors: [], warnings: [],
    })
  })
})
