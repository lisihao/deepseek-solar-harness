#!/usr/bin/env node
/** Drive the model menu of the Loader-composed physical-operator route across background reads, a refresh, and a restart. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type { Context } from '@deepseek-ai/cordis'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-tool-physical-operator'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { codexCatalogs, fixture } from './operators.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('model-entry-menu Loader fixture requires its YAML config')

const CODEX_ENTRY = { provider: 'dsh-physical-operator', model: 'codex' }
const sessionId = SessionId('model-entry-menu')

async function withHost<T>(run: (ctx: Context, api: ReturnType<typeof createApiProxy>) => Promise<T>): Promise<T> {
  const ctx = await boot('model-entry-menu-loader-composition', resolveConfigPath(configPath!, undefined))
  try {
    ctx.agentLoop.create(sessionId, CODEX_ENTRY, { cwd: process.cwd() })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => CODEX_ENTRY,
      saveDefaultModelSelection: () => Promise.resolve(),
      cwd: process.cwd(),
    })
    return await run(ctx, api)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function menu(api: ReturnType<typeof createApiProxy>, refresh: boolean): Promise<string[]> {
  const response = await api.sessions.models({ rpcId: RpcId(`model-entry-menu-${String(refresh)}`), payload: { sessionId, refresh } })
  if (!response.result.ok) throw new Error(`model directory failed: ${JSON.stringify(response.result.error)}`)
  if (response.result.value.failures.length > 0) throw new Error(`provider failures: ${JSON.stringify(response.result.value.failures)}`)
  return response.result.value.groups.flatMap(group => group.models.map(model => `${group.name} / ${model.name}`))
}

/** Read the menu until a background catalog read changes it. */
async function menuAfterBackgroundRead(api: ReturnType<typeof createApiProxy>, previous: readonly string[]): Promise<string[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const entries = await menu(api, false)
    if (JSON.stringify(entries) !== JSON.stringify(previous)) return entries
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('no background catalog read changed the model menu')
}

/** Send one request from a DeepSeek main model under Smart Collaboration and report the routed collaborator. */
async function delegate(ctx: Context, id: string, text: string) {
  const agent = ctx.agentLoop.create(SessionId(id), { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, { cwd: process.cwd() })
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
  const decision = agent.session.events.findLast(event => event.type === 'physical-operator/routing-decision')
  if (decision?.type !== 'physical-operator/routing-decision') throw new Error(`no routing decision for ${id}`)
  return { operatorId: decision.data.operatorId, profile: fixture.profiles.at(-1), reason: decision.data.reason }
}

const before = await withHost(async (_ctx, api) => {
  const cold = await menu(api, false)
  const background = await menuAfterBackgroundRead(api, cold)
  fixture.codexModels = codexCatalogs.gpt7
  const staleUntilReread = await menu(api, false)
  const upgraded = await menuAfterBackgroundRead(api, staleUntilReread)
  fixture.codexModels = codexCatalogs.gpt6
  const refreshed = await menu(api, true)
  fixture.codexModels = codexCatalogs.gpt7
  await menu(api, true)
  return { cold, background, staleUntilReread, upgraded, refreshed }
})

const restarted = await withHost(async (ctx, api) => {
  const entries = await menu(api, false)
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('the session agent is missing')
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }))
  await idle
  const reply = agent.session.events.findLast(event => event.type === 'assistant/message')
  const text = reply?.type === 'assistant/message'
    ? reply.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : undefined
  const codexEntryRuns = fixture.profiles.at(-1)
  const smartAuto = {
    implementation: await delegate(ctx, 'smart-auto-implementation', '给我修复这个 TypeScript 构建 bug 并补齐测试'),
    analysis: await delegate(ctx, 'smart-auto-analysis', '请深度分析这个系统的架构并给出评审意见'),
  }
  return { entries, codexEntryRuns, reply: text, smartAuto }
})

process.stdout.write(`${JSON.stringify({
  menuOnFirstRead: before.cold,
  menuAfterBackgroundRead: before.background,
  menuRightAfterCodexUpgrade: before.staleUntilReread,
  menuAfterCodexUpgradeReread: before.upgraded,
  menuAfterExplicitRefresh: before.refreshed,
  menuAfterRestart: restarted.entries,
  codexEntryRuns: restarted.codexEntryRuns,
  reply: restarted.reply,
  smartAuto: restarted.smartAuto,
}, null, 2)}\n`)
