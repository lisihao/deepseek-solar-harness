#!/usr/bin/env node
/** Drive one task through the real app-boot, Loader, and AgentLoop path. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('task-template Loader driver requires a config path')

const ctx = await boot('task-template-loader-composition', resolveConfigPath(configPath, undefined))
try {
  const agent = ctx.agentLoop.create(SessionId('task-template-loader-fixture'), {
    provider: 'mock',
    model: 'mock',
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Run the fixture playbook end to end.' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  const decisions = agent.session.events.filter(event => event.type === 'task-template/decided')
  const injected = agent.session.events.filter(
    event => event.type === 'user/message' && event.data.source.kind === 'task-template',
  )
  const reply = agent.session.events.findLast(event => event.type === 'assistant/message')
  const replyText = reply?.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  process.stdout.write(`${JSON.stringify({
    decisions: decisions.length,
    injectedMessages: injected.length,
    reply: replyText,
  })}\n`)
} finally {
  await ctx.fiber.dispose()
}
