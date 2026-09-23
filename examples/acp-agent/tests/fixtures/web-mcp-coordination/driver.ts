#!/usr/bin/env node
/** Drive selected Web turns through loopback MCP, checkpoints, a native tool dispatch, and a fresh-lane handoff. */

import { createServer } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-physical-operator'
import type {} from '@deepseek-ai/dsh-task-template-context'
import { completeWebTurn, waitForExactTurn } from './browser.ts'
import { NATIVE_OPERATOR_ID, NATIVE_OPERATOR_REPLY } from './native-operator.ts'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('web-mcp-coordination Loader fixture requires its YAML config')

const SELECTED_CHATGPT = { provider: 'dsh-physical-operator', model: 'chatgpt-web' }
const COORDINATOR_TOKEN = 'a'.repeat(43)
const REQUEST_ID = 'wfr_fixture'
const MCP_REQUEST_ID = `${REQUEST_ID}/hop-1`
const CHECKPOINT_REPLY = 'Web MCP checkpoint completed.'
const HANDOFF_SUMMARY = 'Preserve this current Web handoff summary in the fresh lane.'
const HANDOFF_STEERING = 'Apply this direct user steering in the fresh Web lane.'

interface JsonRpcResponse {
  readonly result?: unknown
  readonly error?: { readonly code?: unknown }
}

interface CheckpointResult {
  readonly action: 'checkpoint'
  readonly pendingSteering: number
  readonly pendingFollowups: number
  readonly shouldYield: boolean
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value
}

function textResult(value: unknown): unknown {
  const content = asArray(asRecord(value, 'MCP result').content, 'MCP result content')
  const block = asRecord(content[0], 'MCP result text block')
  if (block.type !== 'text' || typeof block.text !== 'string') throw new Error('MCP result must contain text')
  return JSON.parse(block.text)
}

function checkpointFrom(envelope: Record<string, unknown>, label: string): CheckpointResult {
  const checkpoint = asRecord(envelope.value, `${label} web_session checkpoint`)
  if (envelope.isError !== false
    || checkpoint.action !== 'checkpoint'
    || typeof checkpoint.pendingSteering !== 'number'
    || typeof checkpoint.pendingFollowups !== 'number'
    || typeof checkpoint.shouldYield !== 'boolean') {
    throw new Error(`unexpected ${label} web_session checkpoint: ${JSON.stringify(envelope)}`)
  }
  return {
    action: 'checkpoint',
    pendingSteering: checkpoint.pendingSteering,
    pendingFollowups: checkpoint.pendingFollowups,
    shouldYield: checkpoint.shouldYield,
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('web-mcp fixture could not reserve an IPv4 port')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error === undefined) resolve(); else reject(error) })
  })
  return address.port
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  const failure = Promise.withResolvers<never>()
  const timeout = setTimeout(() => { failure.reject(new Error(`${label} did not settle`)) }, 1_500)
  try {
    return await Promise.race([operation, failure.promise])
  } finally {
    clearTimeout(timeout)
  }
}

async function mcpRequest(
  endpoint: string,
  id: number,
  method: string,
  params: unknown,
  requestId?: string,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...requestId === undefined ? {} : { 'x-request-id': requestId },
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  const payload = await response.json() as unknown
  if (!response.ok) throw new Error(`MCP request failed with HTTP ${String(response.status)}`)
  const rpc = asRecord(payload, 'MCP response') as JsonRpcResponse
  if (rpc.error !== undefined) throw new Error(`MCP request failed with JSON-RPC ${String(rpc.error.code)}`)
  if (!('result' in rpc)) throw new Error('MCP response has no result')
  return rpc.result
}

const dshHome = process.env.DSH_HOME
if (dshHome === undefined) throw new Error('web-mcp-coordination fixture requires DSH_HOME')
const stateRoot = join(dshHome, 'web-mcp-state')
await mkdir(stateRoot, { recursive: true })
await writeFile(join(stateRoot, 'coordination.json'), `${JSON.stringify({
  version: 1,
  mode: 'coordinator',
  token: COORDINATOR_TOKEN,
})}\n`, { mode: 0o600 })
const port = await unusedLoopbackPort()
process.env.DSH_WEB_MCP_PORT = String(port)

const ctx = await boot('web-mcp-coordination-loader-composition', resolveConfigPath(configPath, undefined))
try {
  const sessionId = SessionId('web-mcp-coordination')
  const agent = ctx.agentLoop.create(sessionId, SELECTED_CHATGPT, { cwd: process.cwd() })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => SELECTED_CHATGPT,
    saveDefaultModelSelection: () => Promise.resolve(),
    cwd: process.cwd(),
  })
  const selected = await api.sessions.selectModel({
    rpcId: RpcId('web-mcp-coordination-select'),
    payload: { sessionId, ...SELECTED_CHATGPT },
  })
  if (!selected.result.ok || JSON.stringify(selected.result.value.selected) !== JSON.stringify(SELECTED_CHATGPT)) {
    throw new Error('the real session model selection did not choose ChatGPT Web')
  }

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Run the exact owner MCP checkpoint and then finish.' }],
    source: { kind: 'user' },
  }))
  const idle = agent.whenIdle()
  await bounded(waitForExactTurn(), 'the exact native ChatGPT turn')

  const endpoint = `http://127.0.0.1:${String(port)}/mcp/dsh/${COORDINATOR_TOKEN}`
  const staticListing = await mcpRequest(endpoint, 1, 'tools/list', {})
  const staticTools = asArray(asRecord(staticListing, 'static MCP listing').tools, 'static MCP tools')
    .map(tool => asRecord(tool, 'static MCP tool').name)
  if (JSON.stringify(staticTools.sort()) !== JSON.stringify(['dsh_execute', 'dsh_tools'])) {
    throw new Error(`unexpected static MCP tools: ${JSON.stringify(staticTools)}`)
  }

  const ownerTools = asArray(textResult(await mcpRequest(endpoint, 2, 'tools/call', {
    name: 'dsh_tools', arguments: {},
  }, MCP_REQUEST_ID)), 'owner tool listing')
  if (!ownerTools.some(tool => asRecord(tool, 'owner tool').name === 'web_session')) {
    throw new Error('the exact owner did not expose web_session')
  }

  const firstCheckpointEnvelope = asRecord(textResult(await mcpRequest(endpoint, 3, 'tools/call', {
    name: 'dsh_execute',
    arguments: { name: 'web_session', arguments: { action: 'checkpoint' } },
  }, MCP_REQUEST_ID)), 'first web_session result envelope')
  const firstCheckpoint = checkpointFrom(firstCheckpointEnvelope, 'first')

  const nativeEnvelope = asRecord(textResult(await mcpRequest(endpoint, 4, 'tools/call', {
    name: 'dsh_execute',
    arguments: {
      name: 'physical_operator',
      arguments: {
        action: 'run',
        operator_id: NATIVE_OPERATOR_ID,
        description: 'run fixture task',
        prompt: 'Return the fixture-native result.',
        mode: 'ephemeral',
      },
    },
  }, MCP_REQUEST_ID)), 'native physical_operator result envelope')
  const nativeResult = asRecord(nativeEnvelope.value, 'native physical_operator result')
  const nativeOutput = asArray(nativeResult.output, 'native physical_operator output')
  const nativeBlock = asRecord(nativeOutput[0], 'native physical_operator output block')
  const nativeText = nativeBlock.text
  if (nativeEnvelope.isError !== false
    || nativeResult.kind !== 'run'
    || nativeResult.operatorId !== NATIVE_OPERATOR_ID
    || nativeBlock.type !== 'text'
    || nativeText !== NATIVE_OPERATOR_REPLY) {
    throw new Error(`unexpected native physical_operator result: ${JSON.stringify(nativeEnvelope)}`)
  }

  const finalCheckpointEnvelope = asRecord(textResult(await mcpRequest(endpoint, 5, 'tools/call', {
    name: 'dsh_execute',
    arguments: { name: 'web_session', arguments: { action: 'checkpoint' } },
  }, MCP_REQUEST_ID)), 'final web_session result envelope')
  const finalCheckpoint = checkpointFrom(finalCheckpointEnvelope, 'final')

  const handoffEnvelope = asRecord(textResult(await mcpRequest(endpoint, 6, 'tools/call', {
    name: 'dsh_execute',
    arguments: { name: 'web_session', arguments: { action: 'handoff', summary: HANDOFF_SUMMARY } },
  }, MCP_REQUEST_ID)), 'web_session handoff result envelope')
  const handoff = asRecord(handoffEnvelope.value, 'web_session handoff')
  if (handoffEnvelope.isError !== false || handoff.action !== 'handoff' || typeof handoff.messageId !== 'string') {
    throw new Error(`unexpected web_session handoff: ${JSON.stringify(handoffEnvelope)}`)
  }
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: HANDOFF_STEERING }],
    source: { kind: 'user' },
  }))
  completeWebTurn()
  await bounded(idle, 'the selected resident turn')

  const dispatch = agent.session.events.findLast(event => event.type === 'physical-operator/dispatch')
  const accepted = agent.session.events.filter(event => event.type === 'chatgpt-web/accepted')
  const acceptedRequestIds = accepted[0]?.type === 'chatgpt-web/accepted'
    ? accepted[0].data.requestIds
    : undefined
  const completed = agent.session.events.filter(event => event.type === 'chatgpt-web/completed')
  const checkpointCalls = agent.session.events.filter(event => (
    event.type === 'physical-operator/tool-call'
      && event.data.tool === 'web_session'
      && event.data.arguments['action'] === 'checkpoint'
  ))
  const handoffCalls = agent.session.events.filter(event => (
    event.type === 'physical-operator/tool-call'
      && event.data.tool === 'web_session'
      && event.data.arguments['action'] === 'handoff'
  ))
  const webSessionResults = agent.session.events.filter(event => event.type === 'physical-operator/tool-result' && event.data.tool === 'web_session')
  const nativeCalls = agent.session.events.filter(event => event.type === 'physical-operator/tool-call' && event.data.tool === 'physical_operator')
  const nativeResults = agent.session.events.filter(event => event.type === 'physical-operator/tool-result' && event.data.tool === 'physical_operator')
  const handoffMessage = agent.session.events.find(event => (
    event.type === 'user/message' && String(event.data.id) === handoff.messageId
  ))
  const freshEnvelope = agent.session.events.findLast(event => (
    event.type === 'physical-operator/context-envelope'
      && event.data.operatorId === 'chatgpt-web'
      && event.data.envelope.contexts.some(context => context.name === `chatgpt-web-handoff:${handoff.messageId}`)
  ))
  const nativeDispatch = agent.session.events.findLast(event => event.type === 'physical-operator/tool-dispatch'
    && event.data.operatorId === NATIVE_OPERATOR_ID)
  const reply = agent.session.events.findLast(event => event.type === 'assistant/message')
  if (dispatch?.type !== 'physical-operator/dispatch'
    || dispatch.data.operatorId !== 'chatgpt-web'
    || dispatch.data.executionMode !== 'resident') {
    throw new Error(`unexpected physical dispatch: ${JSON.stringify(dispatch)}`)
  }
  if (acceptedRequestIds === undefined || accepted.length !== 2 || accepted.some(event => (
    event.type !== 'chatgpt-web/accepted' || JSON.stringify(event.data.requestIds) !== JSON.stringify([REQUEST_ID])
  ))) {
    throw new Error(`unexpected ChatGPT accepted receipt: ${JSON.stringify(accepted)}`)
  }
  if (completed.length !== 2 || completed.some(event => (
    event.type !== 'chatgpt-web/completed'
      || event.data.response !== CHECKPOINT_REPLY
      || JSON.stringify(event.data.requestIds) !== JSON.stringify([REQUEST_ID])
  ))) {
    throw new Error(`unexpected ChatGPT completed receipt: ${JSON.stringify(completed)}`)
  }
  if (checkpointCalls.length !== 2 || handoffCalls.length !== 1 || webSessionResults.length !== 3
    || nativeCalls.length !== 1 || nativeResults.length !== 1
    || nativeDispatch?.type !== 'physical-operator/tool-dispatch'
    || nativeDispatch.data.mode !== 'ephemeral') {
    throw new Error(`unexpected durable MCP tool trace: ${JSON.stringify({ checkpointCalls, handoffCalls, webSessionResults, nativeCalls, nativeResults, nativeDispatch })}`)
  }
  if (handoffMessage?.type !== 'user/message' || freshEnvelope?.type !== 'physical-operator/context-envelope'
    || JSON.stringify(freshEnvelope.data.envelope.task) !== JSON.stringify([{ type: 'text', text: HANDOFF_STEERING }])
    || !freshEnvelope.data.envelope.contexts.some(context => (
      context.name === `chatgpt-web-handoff:${handoff.messageId}` && context.text.includes(HANDOFF_SUMMARY)
    ))) {
    throw new Error(`fresh Web lane lost the admitted handoff or direct steering: ${JSON.stringify({ handoffMessage, freshEnvelope })}`)
  }
  if (reply?.type !== 'assistant/message') throw new Error('the resident turn produced no assistant reply')
  const replyText = reply.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  if (replyText !== CHECKPOINT_REPLY) throw new Error(`unexpected assistant reply: ${replyText}`)

  process.stdout.write(`${JSON.stringify({
    selected: selected.result.value.selected,
    mcp: {
      staticTools: [...staticTools].sort(),
      ownerTool: 'web_session',
      checkpoints: [firstCheckpoint, finalCheckpoint].map(checkpoint => ({
        action: checkpoint.action,
        pendingSteering: checkpoint.pendingSteering,
        pendingFollowups: checkpoint.pendingFollowups,
        shouldYield: checkpoint.shouldYield,
      })),
      native: {
        operatorId: nativeResult.operatorId,
        output: nativeText,
      },
    },
    dispatch: {
      operatorId: dispatch.data.operatorId,
      executionMode: dispatch.data.executionMode,
    },
    session: {
      acceptedRequestIds,
      acceptedWebTurns: accepted.length,
      checkpointCalls: checkpointCalls.length,
      handoffCalls: handoffCalls.length,
      freshHandoffSummary: freshEnvelope.data.envelope.contexts.some(context => context.text.includes(HANDOFF_SUMMARY)),
      freshSteering: freshEnvelope.data.envelope.task[0]?.type === 'text'
        ? freshEnvelope.data.envelope.task[0].text
        : undefined,
      nativeTool: 'physical_operator',
      nativeDispatch: nativeDispatch.data.operatorId,
      reply: replyText,
    },
  }, null, 2)}\n`)
} finally {
  await ctx.fiber.dispose()
}
