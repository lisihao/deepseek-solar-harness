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
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const ROUTE_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-options.json', import.meta.url))
const CLI_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-cli-runtimes.json', import.meta.url))

const FIXTURES = fileURLToPath(new URL('./fixtures/physical-routing-fixtures.mjs', import.meta.url))

const CHATGPT_WEB_OPERATOR = fileURLToPath(new URL('../../../packages/physical-operator/physical-operator-chatgpt-web/lib/index.js', import.meta.url))

function yamlString(value: string): string {
  return JSON.stringify(value)
}

async function writeOverlay(root: string): Promise<string> {
  const browserFixture = join(root, 'physical-routing-browser-fixture.mjs')
  await writeFile(browserFixture, `const catalog = {
  status: 'ok',
  models: [{ id: 'fixture-web-route', label: 'Fixture Web Route' }],
  efforts: [{ id: 'fixture-web:standard', label: 'Fixture Web Reasoning' }],
  selectedModel: 'fixture-web-route',
  selectedEffort: 'fixture-web:standard',
  observedAt: '2026-09-23T00:00:00.000Z',
}

export function apply(ctx) {
  ctx.provide('browser', {
    capabilities() {
      return ['authenticated-profile-reuse', 'named-workspace', 'page-evaluate']
    },
    async runProgram(program) {
      if (!program.source.includes('chatgpt-web-model-catalog')) {
        throw new Error('physical-routing fixture permits only ChatGPT Web catalog discovery')
      }
      return {
        version: 1,
        workspace: { id: 'physical-routing-browser', name: 'physical-routing-browser', lifecycle: 'active', control: 'agent' },
        output: { kind: 'json', value: catalog },
      }
    },
  })
}
`)
  const path = join(root, 'physical-routing.overlay.yml')
  await writeFile(path, `- insert:
    - id: physical-operators
      name: '@deepseek-ai/dsh-physical-operator'

    - id: physical-routing-browser
      name: ${yamlString(browserFixture)}

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

    - id: physical-operator-chatgpt-web
      name: ${yamlString(CHATGPT_WEB_OPERATOR)}
      config:
        stateRoot: ${yamlString(join(root, 'chatgpt-web'))}
        coordinatorEnabled: true
        connectorName: Fixture ChatGPT Web
        coordinatorPort: 0

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

  it('keeps a selected primary in charge while exposing bounded downstream and Web coordination controls', async () => {
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
    await dialog.getByRole('button', { name: /优先 Codex/ }).click()
    await expectSelectedRoute(dialog, /优先 Codex/)

    await dialog.getByRole('button', { name: '关闭协作方式' }).click()
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: 'Codex', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    const selectedPanel = await collaborationPanel()
    const claudeOption = selectedPanel.getByRole('button', { name: /优先 Claude Code/ })
    const webOption = selectedPanel.getByRole('button', { name: /ChatGPT 网页订阅/ })
    await expect.poll(() => claudeOption.isDisabled()).toBe(false)
    await expect.poll(() => webOption.isDisabled()).toBe(false)
    await webOption.click()
    await expectSelectedRoute(selectedPanel, /ChatGPT 网页订阅/)
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    await expect.poll(() => selectedPanel.getByRole('combobox', { name: '执行模型' }).isEnabled()).toBe(true)
    const native = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      mainModel: await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label'),
      claudeAdvisorDisabled: await claudeOption.isDisabled(),
      webAdvisorDisabled: await webOption.isDisabled(),
      webAdvisorSelected: await webOption.getAttribute('data-selected'),
      executionModels: await selectedPanel.getByRole('combobox', { name: '执行模型' }).locator('option').allTextContents(),
    }
    await setMechanism(selectedPanel, 'debate', '协作 · Debate（多 Agent 辩论）')
    const debate = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      claudeAdvisorDisabled: await claudeOption.isDisabled(),
      nativeProfileCount: await selectedPanel.getByRole('combobox', { name: '执行模型' }).count(),
    }
    await selectedPanel.getByRole('button', { name: '退出 Debate（恢复会话路由）' }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    const restored = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      claudeAdvisorDisabled: await claudeOption.isDisabled(),
    }
    await selectedPanel.getByRole('button', { name: '关闭协作方式' }).click()
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: /ChatGPT Web/ }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · ChatGPT 网页版' }).isVisible()).toBe(true)

    const webPanel = await collaborationPanel()
    await webPanel.getByText('连接器：Fixture ChatGPT Web').waitFor({ timeout: 10_000 })
    const webMode = webPanel.getByRole('group', { name: 'ChatGPT 网页版协作模式' })
    const webClaudeOption = webPanel.getByRole('button', { name: /优先 Claude Code/ })
    await expect.poll(() => webMode.getByRole('button', { name: '独立问答' }).getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => webClaudeOption.isDisabled()).toBe(true)
    expect(await webPanel.getByRole('button', { name: '刷新模型与算子' }).isEnabled()).toBe(true)
    expect(await webPanel.getByRole('combobox', { name: 'ChatGPT Web 模型' }).isDisabled()).toBe(true)
    expect(await webPanel.getByRole('combobox', { name: 'ChatGPT Web 推理强度' }).isDisabled()).toBe(true)
    expect(await webPanel.getByRole('combobox', { name: 'Claude 思考强度' }).count()).toBe(0)
    await webPanel.getByRole('button', { name: '高级调度' }).click()
    await expect.poll(() => webPanel.getByRole('combobox', { name: '模型分配目标' }).isDisabled()).toBe(true)
    const directTaskGraphDisabled = await webPanel.getByRole('combobox', { name: '模型分配目标' }).isDisabled()
    await webPanel.getByRole('button', { name: '基础' }).click()

    const primaryBeforeRefresh = await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label')
    await webPanel.getByRole('button', { name: '刷新模型与算子' }).click()
    await expect.poll(() => webPanel.getByText(/模型目录已刷新；原生算子目录已刷新；ChatGPT Web 目录已刷新/).isVisible(), { timeout: 15_000 })
      .toBe(true)
    const webModel = webPanel.getByRole('combobox', { name: 'ChatGPT Web 模型' })
    const webEffort = webPanel.getByRole('combobox', { name: 'ChatGPT Web 推理强度' })
    await expect.poll(() => webModel.isEnabled()).toBe(true)
    await expect.poll(() => webEffort.isEnabled()).toBe(true)
    expect(await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label')).toBe(primaryBeforeRefresh)
    const webDirect = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      mainModel: primaryBeforeRefresh,
      routingDisabled: await webClaudeOption.isDisabled(),
      taskGraphDisabled: directTaskGraphDisabled,
      claudeEffortCount: await webPanel.getByRole('combobox', { name: 'Claude 思考强度' }).count(),
      webModels: await webModel.locator('option').allTextContents(),
      webEfforts: await webEffort.locator('option').allTextContents(),
    }

    await webMode.getByRole('button', { name: '工具协作' }).click()
    await expect.poll(() => webMode.getByRole('button', { name: '工具协作' }).getAttribute('aria-pressed'), { timeout: 15_000 }).toBe('true')
    await expect.poll(() => webClaudeOption.isDisabled()).toBe(false)
    const coordinatorRoutingDisabled = await webClaudeOption.isDisabled()
    await webPanel.getByRole('button', { name: '高级调度' }).click()
    await expect.poll(() => webPanel.getByRole('combobox', { name: '模型分配目标' }).isEnabled()).toBe(true)
    const webCoordinator = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      routingDisabled: coordinatorRoutingDisabled,
      taskGraphDisabled: await webPanel.getByRole('combobox', { name: '模型分配目标' }).isDisabled(),
      toolsNotice: await webPanel.getByText(/工具协作模式允许通过 Custom MCP 使用 DSH 工具和 TaskGraph/).isVisible(),
    }
    const transcript = `${JSON.stringify({ native, debate, restored, webDirect, webCoordinator }, null, 2)}\n`
    if (scaffold.mode === 'refresh') await writeFile(ROUTE_SNAPSHOT, transcript)
    expect(transcript).toBe(await readFile(ROUTE_SNAPSHOT, 'utf8'))
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('recommends newer native CLIs and reports verified activation or a refused candidate', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-physical-cli-runtimes'))
    // The Resident action sits in a non-blank Session's header; open a seeded one.
    const seed = createChatScrollFixture({ markerPrefix: 'CLIRUNTIME', title: 'Native CLI runtime check', turns: 1 })
    await seedSession(scaffold, seed.log, 'physical-routing-cli')
    await page.reload({ waitUntil: 'load' })
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    await searchButton.waitFor({ timeout: 30_000 })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill(seed.markers.user(1))
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').first()
    await result.waitFor({ timeout: 30_000 })
    await result.click()
    await page.getByRole('button', { name: /^物理算子：/ }).click()
    const panel = page.getByRole('dialog', { name: 'Resident 物理算子' })
    const versions = panel.getByLabel('原生 CLI 版本')
    await versions.getByText('当前 2.1.239 · 最新 2.1.281').waitFor({ timeout: 15_000 })
    const rows = async (): Promise<string[]> => (await versions.locator('.dshDesktopResidentProvider').allTextContents())
    const recommended = await rows()
    await versions.getByRole('button', { name: '验证并更新到 2.1.281' }).click()
    const activated = await panel.getByRole('status').filter({ hasText: 'Claude Code 已切换' }).textContent({ timeout: 15_000 })
    await versions.getByText('Claude Code · DSH 托管').waitFor({ timeout: 15_000 })
    await versions.getByRole('button', { name: '验证并更新到 0.156.1' }).click()
    const refused = await panel.getByRole('status').filter({ hasText: '未通过 DSH 兼容验证' }).textContent({ timeout: 15_000 })
    const transcript = `${JSON.stringify({ recommended, activated, afterActivation: await rows(), refused }, null, 2)}\n`
    if (scaffold.mode === 'refresh') await writeFile(CLI_SNAPSHOT, transcript)
    expect(transcript).toBe(await readFile(CLI_SNAPSHOT, 'utf8'))
    await panel.getByRole('button', { name: '关闭物理算子面板' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
