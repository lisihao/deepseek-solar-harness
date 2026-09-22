#!/usr/bin/env node
/** Drive the real API model switch through the Loader-composed AgentLoop and router. */

import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-tool-physical-operator'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { calls } from './external-providers.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('model-route-switch Loader fixture requires its YAML config')

const INITIAL_CLAUDE = { provider: 'dsh-physical-operator', model: 'claude-code' }
const SELECTED_CHATGPT = { provider: 'dsh-physical-operator', model: 'chatgpt-web' }
const ctx = await boot('model-route-switch-loader-composition', resolveConfigPath(configPath, undefined))
try {
  const sessionId = SessionId('model-route-switch')
  const agent = ctx.agentLoop.create(sessionId, INITIAL_CLAUDE, { cwd: process.cwd() })
  // Preserve the existing collaboration preference while changing only the
  // user-selected primary model through the same API handler as the UI.
  agent.session.append('physical-operator/policy', { policy: 'claude-code' }, { ignorable: true })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => INITIAL_CLAUDE,
    saveDefaultModelSelection: () => Promise.resolve(),
    cwd: process.cwd(),
  })
  const switched = await api.sessions.selectModel({
    rpcId: RpcId('model-route-switch-select'),
    payload: { sessionId, ...SELECTED_CHATGPT },
  })
  if (!switched.result.ok) throw new Error(`model selection failed: ${JSON.stringify(switched.result.error)}`)
  if (JSON.stringify(switched.result.value.selected) !== JSON.stringify(SELECTED_CHATGPT)) {
    throw new Error(`unexpected selected route: ${JSON.stringify(switched.result.value.selected)}`)
  }

  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: '你是那个模型' }],
    source: { kind: 'user' },
  }))
  await idle

  const policy = agent.session.events.findLast(event => event.type === 'physical-operator/policy')
  const dispatch = agent.session.events.findLast(event => event.type === 'physical-operator/dispatch')
  const reply = agent.session.events.findLast(event => event.type === 'assistant/message')
  if (policy?.type !== 'physical-operator/policy' || policy.data.policy !== 'claude-code') {
    throw new Error('the saved Claude collaboration preference changed during the model switch')
  }
  if (calls.claudeQualifications !== 0 || calls.claudeStarts !== 0) {
    throw new Error(`Claude was admitted after the ChatGPT selection: ${JSON.stringify(calls)}`)
  }
  if (calls.chatgptBrowserPrograms !== 1) {
    const headers = agent.session.events
      .filter(event => event.type === 'request/header')
      .map(event => event.type === 'request/header' ? event.data.header.config : undefined)
    throw new Error(`ChatGPT Web did not receive exactly one request: ${JSON.stringify({ calls, headers, dispatch, reply })}`)
  }
  if (dispatch?.type !== 'physical-operator/dispatch'
    || dispatch.data.operatorId !== 'chatgpt-web' || dispatch.data.executionMode !== 'ephemeral') {
    throw new Error(`unexpected physical dispatch: ${JSON.stringify(dispatch)}`)
  }
  if (reply?.type !== 'assistant/message') throw new Error('ChatGPT Web produced no assistant message')
  const replyText = reply.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (replyText !== '我是 ChatGPT Web') throw new Error(`unexpected ChatGPT reply: ${replyText}`)
  if (reply.data.message.source.kind !== 'model'
    || reply.data.message.source.provider !== 'dsh-physical-operator'
    || reply.data.message.source.model !== 'chatgpt-web') {
    throw new Error(`unexpected ChatGPT provenance: ${JSON.stringify(reply.data.message.source)}`)
  }

  process.stdout.write(`${JSON.stringify({
    selected: switched.result.value.selected,
    savedCollaborationPreference: policy.data.policy,
    calls,
    reply: replyText,
    provenance: reply.data.message.source,
    dispatch: {
      operatorId: dispatch.data.operatorId,
      executionMode: dispatch.data.executionMode,
    },
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
