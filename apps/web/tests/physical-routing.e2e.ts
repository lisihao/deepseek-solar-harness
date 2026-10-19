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
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterAll, beforeAll, describe, expect, it, onTestFailed, vi } from 'vitest'
import { createChatScrollFixture } from './chat-scroll-fixture.ts'
import { createNativeReplyFixture } from './native-reply-fixture.ts'
import { launchWebScaffold, seedSession, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const ROUTE_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-options.json', import.meta.url))
const CLI_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-cli-runtimes.json', import.meta.url))
const RESIDENT_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-resident-panel.json', import.meta.url))
const CLOSED_LANE_SNAPSHOT = fileURLToPath(new URL('./snapshots/physical-routing-closed-lane.json', import.meta.url))

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

    - id: tool-orchestration
      name: '@deepseek-ai/dsh-tool-orchestration'
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

  async function setMechanism(dialog: Locator, value: 'standard', expectedLabel: string): Promise<void> {
    const mechanism = dialog.getByRole('combobox', { name: '执行机制' })
    await mechanism.waitFor({ timeout: 10_000 })
    await mechanism.selectOption(value)
    await expect.poll(async () => await mechanism.inputValue(), { timeout: 15_000 }).toBe(value)
    await expect.poll(async () => await page.getByRole('button', { name: expectedLabel }).count(), { timeout: 15_000 })
      .toBe(1)
  }

  async function showPage(dialog: Locator, name: '基础' | '高级调度'): Promise<void> {
    await dialog.getByRole('button', { name, exact: true }).click()
  }

  async function expectSelectedRoute(dialog: Locator, name: RegExp): Promise<void> {
    await expect.poll(
      () => dialog.getByRole('button', { name }).getAttribute('data-selected'),
      { timeout: 10_000 },
    ).toBe('true')
  }

  it('switches exclusive composer modes through the real Host and restores them after reload without a model call', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-modes'))
    const directoryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.models')
    await page.reload({ waitUntil: 'load' })
    const directoryWire = await directoryResponse
    const initial = await directoryWire.json() as { result: { ok: boolean; value: { current: Record<string, unknown> } } }
    const original = initial.result.value.current
    const sessionId = (directoryWire.request().postDataJSON() as { payload: { sessionId: string } }).payload.sessionId
    const readSelection = async () => page.evaluate(async (id) => {
      const response = await fetch('/api/session.models', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'composer-mode-read', method: 'session.models', payload: { sessionId: id } }) })
      const wire = await response.json() as { result: { ok: boolean; value: { current: Record<string, unknown> } } }
      if (!wire.result.ok) throw new Error('mode directory read failed')
      return wire.result.value.current
    }, sessionId)
    const ordinary = page.getByRole('radio', { name: '普通对话', exact: true })
    const web = page.getByRole('radio', { name: 'ChatGPT', exact: true })
    const insight = page.getByRole('radio', { name: '洞察', exact: true })
    await ordinary.waitFor()
    await expect.poll(() => ordinary.isChecked()).toBe(true)
    expect(await insight.isDisabled()).toBe(true)
    expect(await page.getByText('暂不可用', { exact: true }).isVisible()).toBe(true)
    const switched = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.selectModel')
    await web.click()
    expect((await switched).request().postDataJSON()).toMatchObject({ payload: {
      provider: 'dsh-physical-operator', model: 'chatgpt-web', persistDefault: false } })
    await expect.poll(readSelection).toMatchObject({ provider: 'dsh-physical-operator', model: 'chatgpt-web' })
    await expect.poll(() => web.isChecked()).toBe(true)
    expect(await ordinary.isChecked()).toBe(false)
    await saveFailureShot(page, 'composer-modes-web-verified')
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => web.isChecked()).toBe(true)
    await ordinary.click()
    await expect.poll(readSelection).toEqual(original)
    await expect.poll(() => ordinary.isChecked()).toBe(true)
    expect(await insight.isDisabled()).toBe(true)
    await saveFailureShot(page, 'composer-modes-ordinary-verified')
    const session = scaffold.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error('mode Session missing after selection')
    const modelRequests = session.events.filter(event => event.type === 'request/header').length
    const transcript = JSON.stringify({ options: ['普通对话', 'ChatGPT', '洞察'], insight: 'disabled:暂不可用',
      web: 'dsh-physical-operator/chatgpt-web', sessionOnly: true, reload: 'chatgpt', restore: 'exact-original', modelCalls: modelRequests }, null, 2) + '\n'
    const snapshot = fileURLToPath(new URL('./snapshots/composer-modes.json', import.meta.url))
    if (scaffold.mode === 'refresh') await writeFile(snapshot, transcript)
    expect(modelRequests).toBe(0)
    expect(transcript).toBe(await readFile(snapshot, 'utf8'))
  })

  it('recovers an initial mode-directory failure through an explicit read without selecting or submitting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-mode-load'))
    let failDirectory = true
    let reads = 0
    const started = Promise.withResolvers<undefined>(), held = Promise.withResolvers<undefined>()
    const sideEffects: string[] = []
    const observe = (request: import('playwright').Request) => {
      const path = new URL(request.url()).pathname
      if (path === '/api/session.selectModel' || path === '/api/session.prompt') sideEffects.push(path)
    }
    const pattern = '**/api/session.models'
    page.on('request', observe)
    await page.route(pattern, async (route) => {
      reads += 1
      if (failDirectory) {
        const request = route.request().postDataJSON() as { rpcId: string }
        await route.fulfill({ json: { type: 'server-response', rpcId: request.rpcId,
          result: { ok: false, error: { code: 'internal', message: 'Directory temporarily unavailable', details: {} } } } })
      } else {
        started.resolve(undefined)
        await held.promise
        await route.continue()
      }
    })
    try {
      await page.reload({ waitUntil: 'load' })
      const warning = page.getByRole('alert').filter({ hasText: '对话模式读取失败' })
      await warning.waitFor()
      const failure = await warning.textContent()
      expect(failure).toBe('对话模式读取失败：internal: Directory temporarily unavailable')
      await saveFailureShot(page, 'composer-mode-load-failed')
      const ordinary = page.getByRole('radio', { name: '普通对话', exact: true })
      const web = page.getByRole('radio', { name: 'ChatGPT', exact: true })
      const insight = page.getByRole('radio', { name: '洞察', exact: true })
      expect(await ordinary.isDisabled()).toBe(true)
      expect(await web.isDisabled()).toBe(true)
      expect(await ordinary.isChecked()).toBe(false)
      expect(await web.isChecked()).toBe(false)
      const before = reads
      failDirectory = false
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.models')
      await page.getByRole('button', { name: '重新读取对话模式', exact: true }).click()
      await started.promise
      expect(await page.getByRole('button', { name: '重新读取对话模式', exact: true }).isDisabled()).toBe(true)
      expect(await page.getByRole('status').filter({ hasText: '正在读取对话模式' }).isVisible()).toBe(true)
      expect(reads).toBe(before + 1)
      held.resolve(undefined)
      const wire = await (await refreshed).json() as { result: { ok: boolean } }
      expect(wire.result.ok).toBe(true)
      await expect.poll(() => warning.count()).toBe(0)
      await expect.poll(() => ordinary.isChecked()).toBe(true)
      expect(await insight.isDisabled()).toBe(true)
      expect(sideEffects).toEqual([])
      await saveFailureShot(page, 'composer-mode-load-recovered')
      const transcript = JSON.stringify({ failure, pending: '正在读取对话模式…', recovered: '普通对话',
        insight: 'disabled:暂不可用', retryReads: reads - before, selectionsOrPrompts: sideEffects }, null, 2) + '\n'
      const snapshot = fileURLToPath(new URL('./snapshots/composer-mode-load-recovery.json', import.meta.url))
      if (scaffold.mode === 'refresh') await writeFile(snapshot, transcript)
      expect(transcript).toBe(await readFile(snapshot, 'utf8'))
    } finally {
      held.resolve(undefined)
      await page.unroute(pattern)
      page.off('request', observe)
    }
  })

  it('keeps a failed mode confirmation blocked after page rebuild until explicit successful reselection', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-composer-durability'))
    const directoryResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.models')
    await page.reload({ waitUntil: 'load' })
    const directoryWire = await directoryResponse
    const sessionId = (directoryWire.request().postDataJSON() as { payload: { sessionId: string } }).payload.sessionId
    const web = page.getByRole('radio', { name: 'ChatGPT', exact: true })
    const ordinary = page.getByRole('radio', { name: '普通对话', exact: true })
    await expect.poll(() => ordinary.isChecked()).toBe(true)
    const flush = vi.spyOn(scaffold.ctx.sessions, 'flush').mockRejectedValueOnce(new Error('fake mode durability failure'))
    try {
      const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.selectModel')
      await web.click()
      expect(await (await failed).json()).toMatchObject({ result: { ok: false,
        error: { message: 'fake mode durability failure' } } })
      const agent = scaffold.ctx.agents.get(SessionId(sessionId))
      if (agent === undefined) throw new Error('mode Agent missing during failure recovery')
      const followup = vi.spyOn(agent, 'followup').mockImplementation(() => {})
      const steer = vi.spyOn(agent, 'steer').mockImplementation(() => {})
      let releaseDirectory!: () => void
      let directoryStarted!: () => void
      const held = new Promise<void>((resolve) => { releaseDirectory = resolve })
      const started = new Promise<void>((resolve) => { directoryStarted = resolve })
      const sendPrompt = (mode: 'queue' | 'steer') => page.evaluate(async ({ id, mode }) => {
        const response = await fetch('/api/session.prompt', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'held-directory-' + mode, method: 'session.prompt',
            payload: { sessionId: id, mode, content: [{ type: 'text', text: 'Synthetic admission probe' }] } }) })
        return response.json() as Promise<{ result: { ok: boolean; error?: { code: string } } }>
      }, { id: sessionId, mode })
      const directoryRoute = '**/api/session.models'
      await page.route(directoryRoute, async (route) => { directoryStarted(); await held; await route.continue() })
      const restoredDirectory = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.models')
      try {
        await page.reload({ waitUntil: 'load' })
        await started
        for (const mode of ['queue', 'steer'] as const) {
          expect(await sendPrompt(mode)).toMatchObject({ result: { ok: false,
            error: { code: 'agent-busy', details: { reason: 'MODEL_SELECTION_UNCONFIRMED' } } } })
        }
        expect(followup).not.toHaveBeenCalled()
        expect(steer).not.toHaveBeenCalled()
      } finally {
        releaseDirectory()
        await restoredDirectory
        await page.unroute(directoryRoute)
        followup.mockRestore()
        steer.mockRestore()
      }
      expect(await (await restoredDirectory).json()).toMatchObject({ result: { ok: true,
        value: { selectionConfirmationRequired: true } } })
      await expect.poll(() => web.isChecked()).toBe(true)
      const warning = page.getByRole('alert').filter({ hasText: '上次对话模式未成功保存' })
      await warning.waitFor()
      const input = page.locator('textarea').first()
      await expect.poll(() => input.isDisabled()).toBe(true)
      const send = page.getByRole('button', { name: 'Send message', exact: true })
      await expect.poll(() => send.isDisabled()).toBe(true)
      const confirmed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session.selectModel')
      await web.click()
      expect(await (await confirmed).json()).toMatchObject({ result: { ok: true } })
      await expect.poll(() => warning.count()).toBe(0)
      await expect.poll(() => input.isEnabled()).toBe(true)
      await input.fill('Synthetic text is allowed only after confirmation')
      await expect.poll(() => send.isEnabled()).toBe(true)
      await input.fill('')
      await ordinary.click()
      await expect.poll(() => ordinary.isChecked()).toBe(true)
      const session = scaffold.ctx.sessions.get(SessionId(sessionId))
      if (session === undefined) throw new Error('mode Session missing after failure recovery')
      expect(session.events.filter(event => event.type === 'request/header')).toHaveLength(0)
    } finally {
      flush.mockRestore()
    }
  })

  it('keeps a selected primary in charge while exposing bounded downstream and Web coordination controls', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-physical-routing'))
    // Neither the closed Resident action nor the closed collaboration control
    // may qualify native providers or start a native-product operation. The
    // model directory reads its persisted catalog on mount; qualification is
    // reserved for the explicit refresh action below.
    expect(qualificationRequests).toEqual([])
    const codexQualification = join(
      scaffold.harnessHome,
      'physical-routing-qualification-count',
    )
    await expect.poll(() => numberInFile(codexQualification), { timeout: 10_000 }).toBe(0)
    const menuQualifications = await numberInFile(codexQualification)

    const dialog = await collaborationPanel()
    expect(qualificationRequests).toEqual([])
    expect(await numberInFile(codexQualification)).toBe(menuQualifications)
    const basicRoutes = await dialog.getByRole('button', { name: /智能协作|仅主模型|优先 Codex|优先 Claude Code|ChatGPT 网页订阅/ })
      .evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.querySelector('strong')?.textContent ?? ''))
    await showPage(dialog, '高级调度')
    await dialog.getByRole('button', { name: /优先 Claude Code/ }).click()
    await expect.poll(() => qualificationRequests.length, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect.poll(() => dialog.getByText(/AUTH_MODE_MISMATCH/).isVisible(), { timeout: 10_000 }).toBe(true)

    await dialog.getByRole('button', { name: /优先 Codex/ }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible(), { timeout: 10_000 }).toBe(true)
    await showPage(dialog, '基础')
    await setMechanism(dialog, 'standard', '协作 · Codex')
    await showPage(dialog, '高级调度')
    await expectSelectedRoute(dialog, /优先 Codex/)

    for (const route of [
      { option: /优先 Claude Code/, label: '协作 · Claude Code' },
      { option: /ChatGPT 网页订阅/, label: '协作 · ChatGPT 网页版' },
    ]) {
      await dialog.getByRole('button', { name: route.option }).click()
      await expectSelectedRoute(dialog, route.option)
      await showPage(dialog, '基础')
      await setMechanism(dialog, 'standard', route.label)
      await showPage(dialog, '高级调度')
      await expectSelectedRoute(dialog, route.option)
    }
    await dialog.getByRole('button', { name: /优先 Codex/ }).click()
    await expectSelectedRoute(dialog, /优先 Codex/)
    await showPage(dialog, '基础')

    await dialog.getByRole('button', { name: '关闭协作方式' }).click()
    await page.getByRole('button', { name: /^Select model/ }).click()
    const modelMenu = page.getByRole('menu', { name: 'Model and reasoning effort' })
    const refreshModels = modelMenu.getByRole('menuitem', { name: 'Refresh models and operators' })
    await refreshModels.click()
    await expect.poll(() => refreshModels.isEnabled(), { timeout: 15_000 }).toBe(true)
    await expect.poll(() => numberInFile(codexQualification), { timeout: 15_000 }).toBeGreaterThan(menuQualifications)
    await modelMenu.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: /Codex/ }).first().click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    const selectedPanel = await collaborationPanel()
    await showPage(selectedPanel, '高级调度')
    const claudeOption = selectedPanel.getByRole('button', { name: /优先 Claude Code/ })
    const webOption = selectedPanel.getByRole('button', { name: /ChatGPT 网页订阅/ })
    await expect.poll(() => claudeOption.isDisabled()).toBe(false)
    await expect.poll(() => webOption.isDisabled()).toBe(false)
    await webOption.click()
    await expectSelectedRoute(selectedPanel, /ChatGPT 网页订阅/)
    await expect.poll(() => page.getByRole('button', { name: '协作 · Codex' }).isVisible()).toBe(true)
    const native = {
      basicRoutes,
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      mainModel: await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label'),
      claudeAdvisorDisabled: await claudeOption.isDisabled(),
      webAdvisorDisabled: await webOption.isDisabled(),
      webAdvisorSelected: await webOption.getAttribute('data-selected'),
      primaryProfileCount: await selectedPanel.getByRole('combobox', { name: '执行模型', exact: true }).count(),
    }
    await selectedPanel.getByRole('button', { name: '关闭协作方式' }).click()
    await page.getByRole('button', { name: /^Select model/ }).click()
    await page.getByRole('menuitem', { name: /^Model/ }).click()
    await page.getByRole('menuitemradio', { name: /ChatGPT Web/ }).click()
    await expect.poll(() => page.getByRole('button', { name: '协作 · ChatGPT 网页版' }).isVisible()).toBe(true)

    const webPanel = await collaborationPanel()
    await webPanel.getByRole('combobox', { name: 'ChatGPT Web 模型' }).waitFor({ timeout: 10_000 })
    const webClaudeOption = webPanel.getByRole('button', { name: /优先 Claude Code/ })
    await expect.poll(() => webPanel.getByText('当前主模型：ChatGPT 网页版（独立问答）').isVisible()).toBe(true)
    expect(await webClaudeOption.isVisible()).toBe(false)
    expect(await webPanel.getByRole('button', { name: '刷新模型与算子' }).isEnabled()).toBe(true)
    expect(await webPanel.getByRole('combobox', { name: 'ChatGPT Web 模型' }).isEnabled()).toBe(true)
    expect(await webPanel.getByRole('combobox', { name: 'ChatGPT Web 推理强度' }).isEnabled()).toBe(true)
    expect(await webPanel.getByRole('combobox', { name: 'Claude 思考强度' }).count()).toBe(0)
    await webPanel.getByRole('button', { name: '高级调度' }).click()
    await expect.poll(() => webPanel.getByRole('combobox', { name: '模型分配目标' }).isDisabled()).toBe(true)
    const directTaskGraphDisabled = await webPanel.getByRole('combobox', { name: '模型分配目标' }).isDisabled()
    await webPanel.getByRole('button', { name: '基础' }).click()

    const primaryBeforeRefresh = await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label')
    await webPanel.getByRole('button', { name: '刷新模型与算子' }).click()
    await expect.poll(() => webPanel.getByText(/模型目录已刷新/).isVisible(), { timeout: 15_000 })
      .toBe(true)
    const webModel = webPanel.getByRole('combobox', { name: 'ChatGPT Web 模型' })
    const webEffort = webPanel.getByRole('combobox', { name: 'ChatGPT Web 推理强度' })
    await expect.poll(() => webModel.isEnabled()).toBe(true)
    await expect.poll(() => webEffort.isEnabled()).toBe(true)
    expect(await page.getByRole('button', { name: /^Select model/ }).getAttribute('aria-label')).toBe(primaryBeforeRefresh)
    const webDirect = {
      chip: await page.getByRole('button', { name: /^协作 ·/ }).textContent(),
      mainModel: primaryBeforeRefresh,
      routingVisible: await webClaudeOption.isVisible(),
      staleSetupNotice: await webPanel.getByText(/Custom MCP|工具协作/).count(),
      taskGraphDisabled: directTaskGraphDisabled,
      claudeEffortCount: await webPanel.getByRole('combobox', { name: 'Claude 思考强度' }).count(),
      webModels: await webModel.locator('option').allTextContents(),
      webEfforts: await webEffort.locator('option').allTextContents(),
    }

    const transcript = `${JSON.stringify({ native, webDirect }, null, 2)}\n`
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

  it('names the native model and effort that served a reply under the closing reply', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-physical-served-by'))
    const fixture = createNativeReplyFixture({
      operatorId: 'codex',
      profile: { model: 'gpt-5.6-sol', effort: 'low' },
      title: 'Native served-by check',
      userMarker: 'SERVEDBY_NATIVE_USER',
      reply: 'SERVEDBY_NATIVE_REPLY done.',
    })
    await seedSession(scaffold, fixture, 'physical-routing-served-by')
    await page.reload({ waitUntil: 'load' })
    const searchButton = page.getByRole('button', { name: 'Search sessions' })
    await searchButton.waitFor({ timeout: 30_000 })
    if (await searchButton.getAttribute('aria-expanded') !== 'true') await searchButton.click()
    await page.getByRole('textbox', { name: 'Search sessions...', exact: true }).fill('SERVEDBY_NATIVE_USER')
    const result = page.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').first()
    await result.waitFor({ timeout: 30_000 })
    await result.click()
    await page.getByText('SERVEDBY_NATIVE_REPLY done.').waitFor({ timeout: 30_000 })
    // The log names the operator only; the dispatch's profile gives the model and effort the caption shows.
    await page.getByText('Codex · gpt-5.6-sol · low', { exact: true }).waitFor({ timeout: 15_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('labels a normally ended Resident turn as unverified in the assembled panel', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-physical-resident-unverified'))
    const action = page.getByRole('button', { name: /^物理算子：/ })
    await action.waitFor({ timeout: 15_000 })
    await action.click()
    const panel = page.getByRole('dialog', { name: 'Resident 物理算子' })
    await panel.waitFor({ timeout: 15_000 })

    const sessionRow = panel.locator('.dshDesktopResidentSession').filter({ hasText: 'Codex · Create and test a file' })
    await sessionRow.waitFor({ timeout: 15_000 })
    await expect.poll(() => sessionRow.getAttribute('data-selected'), { timeout: 15_000 }).toBe('true')
    await sessionRow.getByText('执行结束（未验收）', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })

    const activityRow = panel.locator('.dshDesktopResidentEvents > ol > li > button').filter({ hasText: 'Create and test a file' })
    await activityRow.waitFor({ timeout: 15_000 })
    const output = panel.getByText('Cannot write files; tests were not run.', { exact: true })
    await output.waitFor({ state: 'visible', timeout: 15_000 })
    const unverified = panel.getByText('执行结束（未验收）', { exact: true })
    await expect.poll(() => unverified.count(), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(await panel.getByText('任务已完成', { exact: true }).count()).toBe(0)
    expect(await panel.getByText('已完成', { exact: true }).count()).toBe(0)

    const transcript = `${JSON.stringify({
      session: {
        task: await sessionRow.locator('strong').textContent(),
        phase: await sessionRow.getByText('执行结束（未验收）', { exact: true }).textContent(),
      },
      activity: {
        task: await activityRow.locator('strong').textContent(),
        status: await activityRow.locator('span').textContent(),
      },
      output: await output.textContent(),
      unverifiedCount: await unverified.count(),
      falseCompletedCount: await panel.getByText('任务已完成', { exact: true }).count()
        + await panel.getByText('已完成', { exact: true }).count(),
    }, null, 2)}\n`
    if (scaffold.mode === 'refresh') await writeFile(RESIDENT_SNAPSHOT, transcript)
    expect(transcript).toBe(await readFile(RESIDENT_SNAPSHOT, 'utf8'))

    await panel.getByRole('button', { name: '关闭物理算子面板' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('lets the owner release a lane closed by an unconfirmed native turn through the assembled Host route', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-physical-closed-lane'))
    const home = process.env.DSH_HOME
    if (home === undefined) throw new Error('the scaffold must isolate DSH_HOME')
    const stateFile = join(home, 'physical-routing-closed-lane.json')
    await writeFile(stateFile, `${JSON.stringify({ revision: 7, released: false, calls: [] })}\n`)

    const action = page.getByRole('button', { name: /^物理算子：/ })
    await action.click()
    const panel = page.getByRole('dialog', { name: 'Resident 物理算子' })
    const notice = panel.locator('.dshDesktopResidentRecovery')
    await notice.waitFor({ timeout: 15_000 })
    // The fixture's Claude Code provider is unavailable, so the header is already in the warning state; the label names the lane.
    await expect.poll(() => action.getAttribute('aria-label'), { timeout: 15_000 }).toContain('1 条 lane 已暂停')
    const closedLabel = await action.getAttribute('aria-label')
    // The time follows the browser's zone, so the transcript keeps its shape and not its digits.
    const shownTime = /（(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[^）]*)）/u
    const noticeText = (await notice.innerText()).split('\n').filter(line => line.trim().length > 0)
    expect(noticeText.some(line => shownTime.test(line))).toBe(true)
    const stableNotice = noticeText.map(line => line.replace(shownTime, '（<本机时间>）'))
    const rawShown = await notice.innerHTML()
    expect(rawShown).not.toMatch(/resident-closed-lane|native_outcome_unconfirmed|web-e2e-closed/u)

    // The choice needs a confirmation, and cancelling sends nothing.
    await notice.getByRole('button', { name: '重置这条 lane' }).click()
    await notice.getByText('下一条任务会开启新的 Codex 对话并重新选择模型，原来的对话内容不会再被接续。').waitFor()
    await notice.getByRole('button', { name: '取消' }).click()
    expect((JSON.parse(await readFile(stateFile, 'utf8')) as { calls: unknown[] }).calls).toEqual([])

    // At phone width the notice and its buttons stay inside the panel.
    await page.setViewportSize({ width: 375, height: 812 })
    const narrow = await notice.boundingBox()
    const narrowPanel = await panel.boundingBox()
    await page.setViewportSize({ width: 1280, height: 800 })
    expect(narrow !== null && narrowPanel !== null).toBe(true)
    expect(narrow!.x).toBeGreaterThanOrEqual(narrowPanel!.x)
    expect(narrow!.x + narrow!.width).toBeLessThanOrEqual(narrowPanel!.x + narrowPanel!.width + 1)

    await notice.getByRole('button', { name: '我已确认它结束了，恢复这条 lane' }).click()
    await notice.getByText('这条 lane 会继续使用原来的 Codex 对话。如果那条任务其实还在运行，下一条任务可能与它互相冲突。').waitFor()
    await notice.getByRole('button', { name: '确认恢复' }).click()
    await notice.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(() => action.getAttribute('aria-label'), { timeout: 15_000 }).not.toContain('lane 已暂停')

    const calls = (JSON.parse(await readFile(stateFile, 'utf8')) as { calls: unknown[] }).calls
    const transcript = `${JSON.stringify({
      closedHeader: closedLabel,
      notice: stableNotice,
      calls,
      releasedHeaderLabel: await action.getAttribute('aria-label'),
      noticeAfterRelease: await panel.locator('.dshDesktopResidentRecovery').count(),
    }, null, 2)}\n`
    if (scaffold.mode === 'refresh') await writeFile(CLOSED_LANE_SNAPSHOT, transcript)
    expect(transcript).toBe(await readFile(CLOSED_LANE_SNAPSHOT, 'utf8'))

    await panel.getByRole('button', { name: '关闭物理算子面板' }).click()
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)
})
