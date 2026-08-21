#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  process.stdout.write('0.7.4\n')
  process.exit(0)
}

const option = name => {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}
const sessionDir = option('--session-dir')
if (sessionDir === undefined) throw new Error('missing --session-dir')
mkdirSync(sessionDir, { recursive: true })
const statePath = `${sessionDir}/fake-prime-state.json`
let persisted = { sessionId: option('--resume') ?? 'prime-session-1', count: 0, text: null }
try { persisted = { ...persisted, ...JSON.parse(readFileSync(statePath, 'utf8')) } } catch {}
if (option('--resume') !== undefined) persisted.sessionId = option('--resume')

const send = value => { process.stdout.write(`${JSON.stringify(value)}\n`) }
const success = (command, data) => send({
  id: command.id,
  type: 'response',
  command: command.type,
  success: true,
  ...(data === undefined ? {} : { data }),
})

createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line)
  if (command.type === 'get_available_models') {
    success(command, { models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai-codex', reasoning: true, contextWindow: 400000 },
      { id: 'api-only', name: 'API only', provider: 'openai', reasoning: true },
    ] })
    return
  }
  if (command.type === 'get_state') {
    success(command, { sessionId: persisted.sessionId, sessionFile: statePath, isStreaming: false })
    return
  }
  if (command.type === 'prompt') {
    persisted.count += 1
    persisted.text = [
      `session=${persisted.sessionId}`,
      `count=${String(persisted.count)}`,
      `authority=${String(String(command.message).includes('DSH owns the global TaskGraph'))}`,
      `api=${String(process.env.OPENAI_API_KEY !== undefined || process.env.ANTHROPIC_API_KEY !== undefined)}`,
    ].join(';')
    writeFileSync(statePath, JSON.stringify(persisted))
    success(command)
    send({ type: 'agent_start' })
    send({ type: 'agent_end', messages: [] })
    return
  }
  if (command.type === 'get_last_assistant_text') {
    success(command, { text: persisted.text })
    return
  }
  if (command.type === 'abort') {
    success(command)
    send({ type: 'agent_end', messages: [] })
    return
  }
  send({ id: command.id, type: 'response', command: command.type, success: false, error: 'unsupported command' })
})
