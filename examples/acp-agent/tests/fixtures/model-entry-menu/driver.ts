#!/usr/bin/env node
/** Drive the model menu of the Loader-composed physical-operator route across refreshes and a restart. */

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

const before = await withHost(async (_ctx, api) => {
  const cold = await menu(api, false)
  const refreshed = await menu(api, true)
  fixture.codexModels = codexCatalogs.gpt7
  const upgraded = await menu(api, true)
  return { cold, refreshed, upgraded }
})

const restarted = await withHost(async (ctx, api) => {
  const reads = fixture.catalogReads
  const entries = await menu(api, false)
  if (fixture.catalogReads !== reads) throw new Error('a plain menu read qualified native products')
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
  return { entries, codexEntryRuns: fixture.profiles.at(-1), reply: text }
})

process.stdout.write(`${JSON.stringify({
  menuBeforeRefresh: before.cold,
  menuAfterRefresh: before.refreshed,
  menuAfterCodexUpgrade: before.upgraded,
  menuAfterRestart: restarted.entries,
  codexEntryRuns: restarted.codexEntryRuns,
  reply: restarted.reply,
}, null, 2)}\n`)
