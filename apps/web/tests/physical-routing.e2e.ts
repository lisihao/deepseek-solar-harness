// Keyless assembled Web coverage for physical-operator discovery and the
// unified collaboration mechanism selector. The scaffold boots the shipped
// Web composition and this test-only overlay supplies deterministic Resident
// drivers; no native product, login, model, or paid API is touched.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const ROUTE_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-options.json', import.meta.url))

const FIXTURES = fileURLToPath(new URL('./fixtures/physical-routing-fixtures.mjs', import.meta.url))

function yamlString(value: string): string {
  return JSON.stringify(value)
}

async function writeOverlay(root: string): Promise<string> {
  const path = join(root, 'physical-routing.overlay.yml')
  await writeFile(path, `- insert:
    - id: physical-operators
      name: '@deepseek-ai/dsh-physical-operator'

    - id: resident-operators
      name: ${yamlString(FIXTURES)}

    - id: physical-operator-dual-mode
      name: '@deepseek-ai/dsh-physical-operator-resident'
      config:
        operators:
          - id: codex
            residentProvider: codex
            displayName: Codex
            description: Keyless test Codex operator.
            tags: [test, coding]
            maxConcurrency: 4
          - id: claude-code
            residentProvider: claude-code
            displayName: Claude Code
            description: Keyless test Claude Code operator.
            tags: [test, review]
            maxConcurrency: 4

    - id: tool-physical-operator
      name: '@deepseek-ai/dsh-tool-physical-operator'

    - id: ui-physical-operator
      name: '@deepseek-ai/dsh-ui-physical-operator'

    - id: tool-orchestration
      name: '@deepseek-ai/dsh-tool-orchestration'

    - id: debate-orchestration
      name: '@deepseek-ai/dsh-debate-orchestration'
      config:
        dshHome: !!js process.env.DSH_HOME

    - id: tool-debate
      name: '@deepseek-ai/dsh-tool-debate'
`)
  return path
}

async function numberInFile(path: string): Promise<number> {
  return Number.parseInt(await readFile(path, 'utf8').catch(() => '0'), 10) || 0
}

describe('web e2e: physical operator qualification and routing', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let fixtureRoot: string
  const qualificationRequests: string[] = []

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-physical-routing-e2e-'))
    const overlay = await writeOverlay(fixtureRoot)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/api/resident-operators') qualificationRequests.push(request.method())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd, 'physical-routing')
  }, 120_000)

  afterAll(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    await rm(fixtureRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'physical routing e2e cleanup failed')
  })

  async function collaborationPanel(): Promise<Locator> {
    const trigger = page.getByRole('button', { name: /^协作 ·/ })
    await trigger.waitFor({ timeout: 15_000 })
    if (await page.getByRole('dialog', { name: '协作方式' }).count() === 0) await trigger.click()
    const dialog = page.getByRole('dialog', { name: '协作方式' })
    await dialog.waitFor({ timeout: 10_000 })
    return dialog
  }

  async function setMechanism(dialog: Locator, value: 'debate' | 'standard', expectedLabel: string): Promise<void> {
    const mechanism = dialog.getByRole('combobox', { name: '执行机制' })
    await mechanism.waitFor({ timeout: 10_000 })
    await mechanism.selectOption(value)
    await expect.poll(async () => await mechanism.inputValue(), { timeout: 15_000 }).toBe(value)
    await expect.poll(async () => await page.getByRole('button', { name: expectedLabel }).count(), { timeout: 15_000 })
      .toBe(1)
  }

  async function expectSelectedRoute(dialog: Locator, name: RegExp): Promise<void> {
    await expect.poll(
      () => dialog.getByRole('button', { name }).getAttribute('data-selected'),
      { timeout: 10_000 },
    ).toBe('true')
  }

  it('qualifies only after a panel opens, preserves the selected route across Debate, and surfaces auth mismatch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-physical-routing'))
    // Neither the closed Resident action nor the closed collaboration control
    // may qualify native providers or start a native-product operation.
    expect(qualificationRequests).toEqual([])
    const codexQualification = join(
      scaffold.harnessHome,
      'physical-routing-qualification-count',
    )
    expect(await numberInFile(codexQualification)).toBe(0)

    const dialog = await collaborationPanel()
    expect(qualificationRequests).toEqual([])
    await dialog.getByRole('button', { name: /优先 Claude Code/ }).click()
    await expect.poll(() => qualificationRequests.length, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => numberInFile(codexQualification), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => dialog.getByText(/AUTH_MODE_MISMATCH/).isVisible(), { timeout: 10_000 }).toBe(true)

    await dialog.getByRole('button', { name: /优先 Codex/ }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible(), { timeout: 10_000 }).toBe(true)
    await setMechanism(dialog, 'debate', '协作 · Debate（多 Agent 辩论）')
    await setMechanism(dialog, 'standard', '协作 · Codex')
    await expectSelectedRoute(dialog, /优先 Codex/)

    for (const route of [
      { option: /优先 Claude Code/, label: '协作 · Claude Code' },
      { option: /ChatGPT 网页订阅/, label: '协作 · ChatGPT 网页版' },
    ]) {
      await dialog.getByRole('button', { name: route.option }).click()
      await expectSelectedRoute(dialog, route.option)
      await setMechanism(dialog, 'debate', '协作 · Debate（多 Agent 辩论）')
      await setMechanism(dialog, 'standard', route.label)
      await expectSelectedRoute(dialog, route.option)
    }

    await dialog.getByRole('button', { name: '关闭协作方式' }).click()
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    const selectedPanel = await collaborationPanel()
    const claudeOption = selectedPanel.getByRole('button', { name: /优先 Claude Code/ })
    await expect.poll(() => claudeOption.isDisabled()).toBe(true)
    await expect.poll(() => selectedPanel.getByRole('combobox', { name: '执行模型' }).isEnabled()).toBe(true)
    const direct = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      mainModel: await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label'),
      conflictingPolicyDisabled: await claudeOption.isDisabled(),
      executionModels: await selectedPanel.getByRole('combobox', { name: '执行模型' }).locator('option').allTextContents(),
    }
    await setMechanism(selectedPanel, 'debate', '协作 · Debate（多 Agent 辩论）')
    const debate = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      conflictingPolicyDisabled: await claudeOption.isDisabled(),
      nativeProfileCount: await selectedPanel.getByRole('combobox', { name: '执行模型' }).count(),
    }
    await selectedPanel.getByRole('button', { name: '退出 Debate（恢复会话路由）' }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    const restored = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      conflictingPolicyDisabled: await claudeOption.isDisabled(),
    }
    const transcript = `${JSON.stringify({ direct, debate, restored }, null, 2)}\n`
    if (scaffold.mode === 'refresh') await writeFile(ROUTE_SNAPSHOT, transcript)
    expect(transcript).toBe(await readFile(ROUTE_SNAPSHOT, 'utf8'))
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
