// Keyless assembled Web coverage for the persistent model catalog. The overlay
// registers four deterministic discovery sources behind the real modelCatalogs
// SQLite service, while Chromium exercises the shipped HTTP API and menu.
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT = fileURLToPath(new URL('./snapshots/model-catalog.json', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/model-catalog-fixtures.mjs', import.meta.url))

const SOURCE_NAMES = ['deepseek-deepseek-official', 'native-codex', 'native-claude-code', 'web-chatgpt-web'] as const

function yamlString(value: string): string {
  return JSON.stringify(value)
}

async function writeOverlay(root: string): Promise<string> {
  const path = join(root, 'model-catalog.overlay.yml')
  await writeFile(path, `- insert:
    - id: model-catalog-fixtures
      name: ${yamlString(FIXTURE)}
`)
  return path
}

async function readCount(harnessHome: string, sourceName: string): Promise<number> {
  return Number.parseInt(await readFile(join(harnessHome, 'model-catalog-fixture-calls', sourceName), 'utf8').catch(() => '0'), 10) || 0
}

function readCatalog(harnessHome: string): {
  sources: Array<{ id: string; menuVisible: number; state: string; error: string | null }>
  models: Array<{ source_id: string; upstream_model_id: string; availability: string; dispatch_provider: string; dispatch_model: string }>
} {
  const db = new DatabaseSync(join(harnessHome, 'model-catalog/models.sqlite'))
  try {
    return {
      sources: db.prepare(`
        SELECT id, menu_visible AS menuVisible, state, error
        FROM model_catalog_sources
        ORDER BY id
      `).all() as Array<{ id: string; menuVisible: number; state: string; error: string | null }>,
      models: db.prepare(`
        SELECT source_id, upstream_model_id, availability, dispatch_provider, dispatch_model
        FROM model_catalog_models
        ORDER BY source_id, upstream_model_id
      `).all() as Array<{ source_id: string; upstream_model_id: string; availability: string; dispatch_provider: string; dispatch_model: string }>,
    }
  } finally {
    db.close()
  }
}

async function openModelPane(page: Page, expectModels = true): Promise<void> {
  const trigger = page.getByRole('button', { name: /^Select model/ })
  await trigger.waitFor({ timeout: 15_000 })
  const menu = page.getByRole('menu', { name: 'Model and reasoning effort' })
  if (await menu.count() === 0) await trigger.click()
  await menu.getByRole('menuitem', { name: /^Model/ }).click()
  if (expectModels) {
    await expect.poll(() => page.getByRole('menuitemradio').count(), { timeout: 15_000 }).toBeGreaterThan(0)
  }
}

async function modelMenu(page: Page): Promise<{ groups: string[]; models: string[] }> {
  const menu = page.getByRole('menu', { name: 'Model and reasoning effort' })
  return {
    groups: await menu.getByRole('group').evaluateAll(nodes => nodes.map((node) => {
      const heading = node.getAttribute('aria-labelledby')
      return (heading === null ? node.textContent : document.getElementById(heading)?.textContent)?.trim() ?? ''
    })),
    models: (await menu.getByRole('menuitemradio').allTextContents())
      .map(text => text.replace(/Available$/u, '').trim()),
  }
}

async function refreshFromRoot(page: Page, counts: () => Promise<number[]>, expectedCalls: number): Promise<void> {
  const trigger = page.getByRole('button', { name: /^Select model/ })
  await trigger.click()
  await trigger.click()
  const menu = page.getByRole('menu', { name: 'Model and reasoning effort' })
  const refresh = menu.getByRole('menuitem', { name: 'Refresh models and operators' })
  await refresh.click()
  await expect.poll(() => refresh.isEnabled(), { timeout: 20_000 }).toBe(true)
  await expect.poll(counts, { timeout: 20_000 }).toEqual([expectedCalls, expectedCalls, expectedCalls, expectedCalls])
}

describe('web e2e: persistent model catalog refresh and menu projection', () => {
  let browser: Browser
  let page: Page
  let scaffold: WebScaffold
  let fixtureRoot: string
  let harnessHome: string
  let overlay: string

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-model-catalog-e2e-'))
    harnessHome = join(fixtureRoot, 'harness-home')
    overlay = await writeOverlay(fixtureRoot)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, harnessHome })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'model-catalog')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(fixtureRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'model catalog e2e cleanup failed')
  })

  it('refreshes each source once, projects only available menu entries, and reopens durably', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-model-catalog'))
    const counts = () => Promise.all(SOURCE_NAMES.map(source => readCount(harnessHome, source)))

    // The mount-time directory read is ordinary and must not invoke discovery.
    await openModelPane(page, false)
    expect(await counts()).toEqual([0, 0, 0, 0])

    await refreshFromRoot(page, counts, 1)
    await openModelPane(page)
    const firstMenu = await modelMenu(page)
    const firstDatabase = readCatalog(harnessHome)
    const firstCalls = await counts()
    expect(firstMenu.models).toEqual([
      'Fixture Codex Astra',
      'Fixture Codex Sol',
      'Fixture ChatGPT Pro',
      'Fixture ChatGPT Thinking',
      'Fixture DeepSeek Pro',
      'Fixture DeepSeek Flash',
    ])
    expect(firstMenu.models.some(model => model.includes('Claude'))).toBe(false)
    expect(firstDatabase.models).toHaveLength(14)
    expect(firstDatabase.models.length).toBeGreaterThan(firstMenu.models.length)
    expect(firstDatabase.sources).toEqual([
      { id: 'deepseek:deepseek-official', menuVisible: 1, state: 'ready', error: null },
      { id: 'native:claude-code', menuVisible: 0, state: 'ready', error: null },
      { id: 'native:codex', menuVisible: 1, state: 'ready', error: null },
      { id: 'web:chatgpt-web', menuVisible: 1, state: 'ready', error: null },
    ])
    expect(firstDatabase.models.filter(model => model.availability === 'available')).toHaveLength(14)

    await refreshFromRoot(page, counts, 2)
    await openModelPane(page)
    const secondMenu = await modelMenu(page)
    const secondDatabase = readCatalog(harnessHome)
    const secondCalls = await counts()
    expect(secondMenu.models).toEqual([
      'Fixture Codex Astra',
      'Fixture Codex Sol',
      'Fixture DeepSeek Next',
      'Fixture DeepSeek Flash',
    ])
    expect(secondMenu.models).not.toContain('Fixture DeepSeek Pro')
    expect(secondMenu.models).not.toContain('Fixture ChatGPT Pro')
    expect(secondDatabase.models.find(model => model.upstream_model_id === 'deepseek-v4-pro')?.availability)
      .toBe('unavailable')
    expect(secondDatabase.sources.find(source => source.id === 'web:chatgpt-web')).toMatchObject({
      state: 'error',
      error: 'fixture ChatGPT Web discovery failed',
    })

    const transcript = `${JSON.stringify({
      first: {
        calls: firstCalls,
        menu: firstMenu,
        database: {
          sourceStates: firstDatabase.sources,
          inventoryCount: firstDatabase.models.length,
          availableCount: firstDatabase.models.filter(model => model.availability === 'available').length,
          dispatch: firstDatabase.models.slice(0, 3).map(model => [model.upstream_model_id, model.dispatch_provider, model.dispatch_model]),
        },
      },
      second: {
        calls: secondCalls,
        menu: secondMenu,
        database: {
          sourceStates: secondDatabase.sources,
          inventoryCount: secondDatabase.models.length,
          unavailable: secondDatabase.models.filter(model => model.availability !== 'available')
            .map(model => [model.source_id, model.upstream_model_id, model.availability]),
        },
      },
    }, null, 2)}\n`
    if (scaffold.mode === 'refresh') await writeFile(SNAPSHOT, transcript)
    expect(transcript).toBe(await readFile(SNAPSHOT, 'utf8'))

    await page.keyboard.press('Escape')
    await scaffold.close()
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, harnessHome })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'model-catalog-reopen')
    await openModelPane(page)
    const reopenedMenu = await modelMenu(page)
    expect(await counts()).toEqual([2, 2, 2, 2])
    expect(reopenedMenu.models).toEqual(secondMenu.models)
    expect(readCatalog(harnessHome).sources.find(source => source.id === 'web:chatgpt-web')?.state).toBe('error')
  }, 120_000)
})
