// Real built plugins and HTTP; fixtures supply only external catalog/execution reads.
import { lstat, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-approval'
import type { GouziControl, OrchestrationService } from '@deepseek-ai/dsh-orchestration'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'
const PRESETS = fileURLToPath(new URL('./snapshots/kennel-room/presets', import.meta.url))
const SHIPPED_PRESETS = fileURLToPath(new URL('../../cli/config/agent-presets', import.meta.url))
const members = ['g1', 'g2'].map((gouziId, i) => ({
  gouziId, name: '同名', avatarId: 'shiba', role: 'development', hostId: 'h' + String(i),
  membership: 'enabled', connection: 'online', activity: 'resting', createdAt: '2026-10-01T00:00:00Z', generation: 1,
}))
const execution = members.map(m => ({ gouziId: m.gouziId, generation: 1,
  operators: [{ operatorId: m.gouziId + '.actual', available: true, models: [] }],
}))
describe('web e2e: composed kennel room', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let failRead = false
  let reads = 0
  let fixtureLink: string | undefined
  let roomSession = ''
  let resultCount = 0
  let resultTime = '2026-10-06T03:00:00.000Z'
  const roomReadTimes: number[] = []
  const tasks = () => Array.from({ length: resultCount }, (_, i) => ({
    runId: 'run-' + String(i), title: '验收任务 ' + String(i), state: 'completed', revision: 4, graphRevision: 1,
    admission: { sourceSessionId: roomSession, policy: 'auto', route: 'taskgraph' },
    nodes: [{ id: 'node', title: '实际节点 ' + String(i), role: 'worker', dependsOn: [], state: 'passed',
      attempt: 2, capabilityGeneration: 3, operatorId: 'g1.actual', executionPlanRef: 'plan-' + String(i),
      evidenceRefs: ['evidence-' + String(i)], blockers: [], updatedAt: '2026-10-06T03:00:00Z' }],
    blockers: [], createdAt: '2026-10-06T02:00:00Z', updatedAt: '2026-10-06T03:00:00Z',
  }))
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ agentPresets: { roots: [{ path: SHIPPED_PRESETS, trust: 'system' }, { path: PRESETS, trust: 'system' }], default: 'standard' } })
    const control = { list: async () => {
      reads++
      if (failRead) throw new Error('catalog temporarily offline')
      return { members, hosts: [{ hostId: 'h0', label: '机器0' }, { hostId: 'h1', label: '机器1' }] }
    }, executionOperators: async () => execution } as unknown as GouziControl
    scaffold.ctx.provide('orchestrations', {
      gouzi: control, list: async () => { roomReadTimes.push(performance.now()); return tasks() },
      readEvents: async ({ runId, afterSequence }: { runId: string; afterSequence: number }) => ({
        events: afterSequence === 0 ? [{ sequence: 5, runId, nodeId: 'node', attempt: 2, generation: 3,
          type: 'node.evidence.accepted', time: resultTime,
          data: { operatorId: 'g1.actual', evidenceRef: 'evidence-' + runId.slice(4), outputPreview: '实际输出 ' + runId } }] : [],
        nextSequence: 5,
      }),
      readArtifact: async (ref: string) => ref.startsWith('plan-')
        ? { version: 1, runId: 'run-' + ref.slice(5), nodeId: 'node', attempt: 2, capabilityGeneration: 3, operatorPlan: { operatorId: 'g1.actual' } }
        : { output: '真实证据 ' + ref },
    } as unknown as OrchestrationService)
    const moduleLink = join(scaffold.harnessHome, 'profiles/node_modules/@deepseek-ai/dsh-ui-gouzi')
    try { await lstat(moduleLink) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await symlink(fileURLToPath(new URL('../../../packages/orchestration/ui-gouzi', import.meta.url)), moduleLink)
      fixtureLink = moduleLink
    }
    await scaffold.ctx.loader.create({ name: '@deepseek-ai/dsh-ui-gouzi', config: { roomPollIntervalMs: 250 } })
    await scaffold.ctx.loader.await()
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '狗窝', exact: true }).click()
    await page.getByRole('heading', { name: '狗窝', exact: true }).waitFor()
    await page.getByRole('button', { name: '点名 · 标准任务', exact: true }).nth(1).waitFor({ timeout: 10_000 })
    const roomRequest = await page.waitForRequest(request => request.url().includes('/api/gouzi?session_id='))
    roomSession = new URL(roomRequest.url()).searchParams.get('session_id') ?? ''
    expect(roomSession.length).toBeGreaterThan(0)
  }, 120_000)
  afterAll(async () => {
    await browser?.close()
    if (fixtureLink !== undefined) {
      expect((await lstat(fixtureLink)).isSymbolicLink()).toBe(true)
      await unlink(fixtureLink)
    }
    await scaffold?.close()
  })
  it('keeps desktop columns and a reachable narrow layout with one composer', async () => {
    expect(reads).toBeGreaterThan(0)
    for (const width of [1680, 760]) {
      await page.setViewportSize({ width, height: 1000 })
      const right = await page.getByRole('complementary', { name: '房间成员与任务' }).boundingBox()
      const center = await page.getByRole('log').boundingBox()
      const left = await page.getByRole('button', { name: '狗窝', exact: true }).boundingBox()
      expect(right).not.toBeNull(); expect(center).not.toBeNull(); expect(left).not.toBeNull()
      expect(center!.height).toBeGreaterThan(0)
      if (width > 760) {
        expect(left!.x).toBeLessThan(center!.x)
        expect(right!.x).toBeGreaterThanOrEqual(center!.x + center!.width - 1)
      } else {
        expect(right!.y).toBeGreaterThanOrEqual(center!.y + center!.height - 1)
        expect(right!.y + right!.height).toBeLessThanOrEqual(1001)
        const composer = await page.getByRole('textbox', { name: '消息', exact: true }).boundingBox()
        expect(composer).not.toBeNull()
        expect(composer!.y).toBeGreaterThanOrEqual(0)
        expect(composer!.y + composer!.height).toBeLessThanOrEqual(1001)
      }
      expect(right!.x + right!.width).toBeLessThanOrEqual(width + 1)
      expect(await page.locator('textarea:visible').count()).toBe(1)
      for (const dark of [false, true]) {
        await page.evaluate((value) => { document.body.toggleAttribute('data-ds-dark-theme', value) }, dark)
        await page.screenshot({ path: '/private/tmp/dsh-chatroom-' + String(width) + '-' + (dark ? 'dark' : 'light') + '.png' })
      }
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
  })
  it('uses the Host-confirmed 250ms interval on real room HTTP reads', async () => {
    const start = roomReadTimes.length
    await expect.poll(() => roomReadTimes.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(start + 4)
    const stable = roomReadTimes.slice(-3)
    const intervals = stable.slice(1).map((time, index) => time - stable[index]!)
    // The interval starts after the previous response settles; allow local
    // HTTP latency and event-loop delay while rejecting the old 2000ms default.
    for (const interval of intervals) {
      expect(interval).toBeGreaterThanOrEqual(200)
      expect(interval).toBeLessThan(1000)
    }
    await writeFile('/private/tmp/dsh-chatroom-polling.json', JSON.stringify({ configuredMs: 250, intervalsMs: intervals }, null, 2) + '\n')
  })
  it('filters independently from recipient while preserving the draft', async () => {
    await page.getByRole('button', { name: '点名 · 标准任务', exact: true }).first().click()
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('保留这条草稿')
    await page.getByRole('button', { name: '筛选 同名 · 机器1 · 开发', exact: true }).click()
    expect(await page.getByText('发送对象：同名 · 机器0 · 开发 · 标准任务', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue()).toBe('保留这条草稿')
    expect(await page.getByRole('button', { name: '点名 · 标准任务', exact: true }).count()).toBe(2)
    await page.getByRole('button', { name: '全部', exact: true }).click()
  })
  it('answers a real question carrier and restores the room draft and recipient', async () => {
    const agent = scaffold.ctx.agents.get(SessionId(roomSession))
    expect(agent).toBeDefined()
    const answered = scaffold.ctx.userQuestions.ask({ agent: agent!, questions: [{
      id: 'color', question: 'Which color do you prefer?', options: [{ label: 'Blue' }, { label: 'Green' }],
    }] })
    const panel = page.locator('[data-question-key]')
    await panel.waitFor()
    expect(await page.locator('textarea:visible').count()).toBeLessThanOrEqual(1)
    expect(await page.getByRole('textbox', { name: '消息', exact: true }).count()).toBe(0)
    await panel.getByRole('radio', { name: 'Blue', exact: true }).click()
    await panel.getByRole('button', { name: 'Submit', exact: true }).click()
    expect(await answered).toMatchObject({ answers: [{ id: 'color', selected: ['Blue'] }] })
    await expect.poll(() => page.getByRole('textbox', { name: '消息', exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue()).toBe('保留这条草稿')
    expect(await page.getByText('发送对象：同名 · 机器0 · 开发 · 标准任务', { exact: true }).count()).toBe(1)
    expect(await page.locator('textarea:visible').count()).toBe(1)
  })
  it('answers a real approval carrier and restores the room composer', async () => {
    const agent = scaffold.ctx.agents.get(SessionId(roomSession))!
    // The real service requires turn-enclosed audit events. This is a local
    // fixture-owned open turn, without a model request or executing a tool.
    agent.session.append('turn/start', { turn: 1 })
    const answered = scaffold.ctx.approval.request({ agent, toolName: 'bash', reason: 'Browser acceptance approval' })
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor()
    expect(await page.getByRole('textbox', { name: '消息', exact: true }).count()).toBe(0)
    expect(await page.locator('textarea:visible').count()).toBe(0)
    await panel.getByRole('button', { name: 'Allow once', exact: true }).click()
    expect(await answered).toBe('allowed-once')
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect.poll(() => page.getByRole('textbox', { name: '消息', exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue()).toBe('保留这条草稿')
    expect(await page.locator('textarea:visible').count()).toBe(1)
  })
  it('orders human and manager messages with the sealed dog result by event time', async () => {
    const session = scaffold.ctx.agents.get(SessionId(roomSession))!.session
    session.append('turn/start', { turn: 2 })
    const user = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '请核对本房间任务的执行证据。' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const log = page.getByRole('log')
    await log.getByText('请核对本房间任务的执行证据。', { exact: true }).waitFor()
    // This timestamp is the external fixture's actual sealed event time,
    // captured after the human log event and before the manager log event.
    resultTime = new Date().toISOString()
    resultCount = 1
    await expect.poll(() => log.getByText('实际输出 run-0', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    session.append('step/start', { turn: 2, step: 1 })
    const manager = session.append('assistant/message', { turn: 2, step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: '已读取封存结果；请查看证据。' }],
        source: { provider: 'fixture', model: 'fixture-manager' } }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 2, step: 1 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await log.getByText('已读取封存结果；请查看证据。', { exact: true }).waitFor()
    expect(user.time).toBeLessThan(Date.parse(resultTime))
    expect(Date.parse(resultTime)).toBeLessThan(manager.time)
    const rows = await log.locator('article').allTextContents()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('我')
    expect(rows[0]).toContain('请核对本房间任务的执行证据。')
    expect(rows[1]).toContain('同名 · 机器0 · 开发 · 任务结果')
    expect(rows[1]).toContain('实际输出 run-0')
    expect(rows[2]).toContain('总管')
    expect(rows[2]).toContain('已读取封存结果；请查看证据。')
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    await page.screenshot({ path: '/private/tmp/dsh-chatroom-populated.png' })
  })
  it('reads exact-attempt output and retained evidence without stealing historical scroll', async () => {
    resultCount = 24
    await expect.poll(() => page.getByText('实际输出 run-23', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    const log = page.getByRole('log')
    const scrolls = await log.evaluate(el => el.scrollHeight > el.clientHeight)
    expect(scrolls).toBe(true)
    await log.evaluate((el) => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')) })
    const before = await log.evaluate(el => el.scrollTop)
    resultCount = 25
    await expect.poll(() => page.getByText('实际输出 run-24', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await log.evaluate(el => el.scrollTop)).toBe(before)
    await page.getByRole('button', { name: '查看证据', exact: true }).first().click()
    await page.getByText(/真实证据 evidence-/).first().waitFor()
    await page.getByRole('button', { name: '展开执行记录', exact: true }).first().click()
    expect(await page.getByText('尝试 2 · generation 3', { exact: true }).count()).toBeGreaterThan(0)
    await page.getByRole('button', { name: '回到最新', exact: true }).click()
    expect(await log.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(2)
  })
  it('blocks changed generation and offline data, retaining the target and draft', async () => {
    const send = page.getByRole('button', { name: '发送', exact: true })
    execution[0]!.generation = 2
    await expect.poll(() => send.isDisabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.getByText('执行实例已变化，请重新点名；原目标已保留。', { exact: true }).count()).toBe(1)
    execution[0]!.generation = 1
    await expect.poll(() => send.isEnabled(), { timeout: 10_000 }).toBe(true)
    execution[0]!.operators[0]!.available = false
    await expect.poll(() => send.isDisabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.getByText('原发送对象没有可用执行入口；目标已保留。', { exact: true }).count()).toBe(1)
    execution[0]!.operators[0]!.available = true
    await expect.poll(() => send.isEnabled(), { timeout: 10_000 }).toBe(true)
    failRead = true
    await expect.poll(() => send.isDisabled(), { timeout: 10_000 }).toBe(true)
    expect(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue()).toBe('保留这条草稿')
    expect(await page.getByText('发送对象：同名 · 机器0 · 开发 · 标准任务', { exact: true }).count()).toBe(1)
    failRead = false
    await expect.poll(() => send.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
